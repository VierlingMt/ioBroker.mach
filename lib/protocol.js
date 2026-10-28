'use strict';
// ============================================================================
// MACH 2.0 Wire-Protokoll – Auth + Decrypt + Decode (Lese-Pfad)
//                         + Encode (Schreib-Pfad, ab v0.2.0)
//
// Gemeinsame Primitive fuer den ioBroker-Adapter und Test-Tools.
// ============================================================================

const https = require('node:https');
const crypto = require('node:crypto');

const BACKEND = 'mach-backend.solvesall.com';
const HMAC_TAIL_LEN = 20;     // SHA1-HMAC = 20 Bytes
const USER_AGENT = 'okhttp/5.0.0-alpha.5';

// --- HTTP -------------------------------------------------------------------

// Single shared keep-alive Agent: HTTP-Auth-Calls und WS-Upgrade laufen damit
// (potenziell) ueber denselben TCP-Socket - wie es die App via ihrem
// gemeinsamen OkHttp-Client tut. Dadurch sieht die Box den Adapter ggf.
// als "etablierten Client" statt jedem Call als fremden Fresh-Connect.
const sharedAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 4,
});

function postJSON(path, bodyObj) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(bodyObj);
        const req = https.request({
            host: BACKEND,
            method: 'POST',
            path,
            agent: sharedAgent,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': USER_AGENT,
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const txt = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode !== 200) {
                    return reject(new Error(`${path} -> HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
                }
                try { resolve(JSON.parse(txt)); }
                catch (_e) { reject(new Error(`${path} -> invalid JSON: ${txt.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

/**
 * Vollstaendiger Auth-Flow gegen das Solvesall-Backend.
 * Liefert wsUrl, wsToken, sharedSecret und Geraete-Metadaten.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} machId
 * @returns {Promise<{wsUrl: string, wsToken: string, sharedSecret: Buffer, deviceName: string}>}
 */
async function authFlow(username, password, machId, log) {
    const auth = { username, password };

    // Zweimal authenticate, wie die App
    await postJSON('/v0/api/mobile/authenticate', { auth });
    await postJSON('/v0/api/mobile/authenticate', { auth });

    const sync = await postJSON('/v0/api/mobile/syncData', {
        auth, payload: { current: [], deleted: [] },
    });
    const devs = sync.devices || {};
    const candidates = [...(devs.add || []), ...(devs.update || [])];
    const dev = candidates.find(d => d && d.machId === machId);
    if (!dev) {
        throw new Error(`machId ${machId} not in syncData (devices.add + devices.update beide ohne Treffer)`);
    }
    const sharedSecret = Buffer.from(dev.sharedSecret, 'base64');

    if (log) {
        // Welche Felder hat das device-Object? Hilft fuer Mapping-Diagnose
        // (kein Wert-Dump - nur Feldnamen damit nichts Sensitives leakt).
        log.debug(`auth/syncData device fields: [${Object.keys(dev).join(', ')}]`);
    }

    // Diese Calls scheinen die Backend-Session "vollstaendig" zu machen.
    let signed, drivers, config, releaseType;
    try { signed      = await postJSON('/v0/api/mobile/getSignedCredentials', { auth, payload: { machId } }); } catch (_) {}
    // get-drivers-json: App ruft das immer auf zwischen getSignedCredentials und getConfig
    try { drivers     = await postJSON('/v0/api/mach-basic-lte/get-drivers-json', { version: 152, auth }); } catch (_) {}
    try { config      = await postJSON('/v0/api/mach-basic/getConfig',        { auth, mach:    { machId } }); } catch (_) {}
    try { releaseType = await postJSON('/v0/api/mach-basic/getReleaseType',   { auth, mach:    { machId } }); } catch (_) {}

    const lte = await postJSON('/v0/lte1/mobile/auth', { auth, machId });
    if (!lte || !lte.url || !lte.token) {
        throw new Error('lte1/auth response missing url or token');
    }

    if (log) {
        log.debug(`auth/lte1 response fields: [${Object.keys(lte).join(', ')}]`);
        if (signed) {
            log.debug(`auth/getSignedCredentials fields: [${Object.keys(signed).join(', ')}]`);
            if (signed.payload != null) {
                log.debug(`auth/getSignedCredentials.payload type=${typeof signed.payload} len=${String(signed.payload).length}`);
            }
        }
        if (config) {
            log.debug(`auth/mach-basic/getConfig fields: [${Object.keys(config).join(', ')}]`);
            if (config.system) log.debug(`  config.system fields: [${Object.keys(config.system).join(', ')}]`);
        }
        if (releaseType) log.debug(`auth/mach-basic/getReleaseType fields: [${Object.keys(releaseType).join(', ')}]`);
        const tk = String(lte.token || '');
        log.debug(`auth/lte1 token len=${tk.length}`);
    }

    return {
        wsUrl: lte.url,
        wsToken: lte.token,
        sharedSecret,
        deviceName: dev.name || '',
        sharedAgent,   // damit der WS denselben Agent nutzen kann
        // alle weiteren Felder mitgeben falls aufrufer was Spezifisches braucht
        deviceMeta: dev,
        lteResponse: lte,
        signedResponse: signed,
        configResponse: config,
        driversResponse: drivers,
    };
}

// --- AES-Decrypt + Frame-Decode --------------------------------------------

/**
 * Outer-Wrapper aufschneiden, AES-128-CBC-Decrypt mit IV in den ersten 16
 * Bytes des Payloads. Liefert plaintext (mit HMAC-Tail) oder null bei
 * struktur-/dechiffrier-Fehler.
 */
function decryptFrame(rawBuf, sharedSecret) {
    if (rawBuf.length < 9) return null;
    if (rawBuf[0] !== 0x00 || rawBuf[1] !== 0x01) return null;
    if (rawBuf[rawBuf.length - 2] !== 0xFE || rawBuf[rawBuf.length - 1] !== 0xFF) return null;
    // 7-Byte-Prefix: [00 01 01 01][len:2BE][seq:1]
    // Danach: [IV:16][CT:N*16][extra:1]
    const payload = rawBuf.slice(7, rawBuf.length - 2);
    if (payload.length < 32) return null;
    const iv = payload.slice(0, 16);
    let ct = payload.slice(16);
    ct = ct.slice(0, Math.floor(ct.length / 16) * 16);
    if (!ct.length) return null;
    try {
        const dec = crypto.createDecipheriv('aes-128-cbc', sharedSecret, iv);
        dec.setAutoPadding(true);
        return Buffer.concat([dec.update(ct), dec.final()]);
    } catch (_e) {
        return null;
    }
}

/**
 * Multi-TLV-Liste parsen: [id1:2][id2:2][type:1][value:type bytes].
 * tail-Bytes (4-6 Bytes) am Ende werden toleriert.
 */
function tryParseTLVList(bytes, allowTailLengths = [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    let i = 0;
    const tlvs = [];
    while (i < bytes.length) {
        if (i + 5 > bytes.length) break;
        const id1 = bytes.readUInt16BE(i);
        const id2 = bytes.readUInt16BE(i + 2);
        const type = bytes[i + 4];
        if (type < 1 || type > 8) return null;
        if (i + 5 + type > bytes.length) return null;
        const val = bytes.slice(i + 5, i + 5 + type);
        tlvs.push({
            idHex: id1.toString(16).padStart(4, '0') + id2.toString(16).padStart(4, '0'),
            type,
            valBytes: val,
        });
        i += 5 + type;
    }
    const remaining = bytes.length - i;
    if (allowTailLengths.includes(remaining)) {
        return { tlvs, tailBytes: bytes.slice(i) };
    }
    return null;
}

/**
 * S->C Plaintext (nach decryptFrame) dekodieren. Liefert ein Format-A/B/C
 * Objekt mit outerIdHex, format, je nach Form: counter+tlvs, outerVal+tlvs,
 * oder rawBytes/rawHex. Liefert null bei ungueltigem Header.
 */
function decodeFrame(plaintext) {
    if (plaintext.length < (6 + HMAC_TAIL_LEN + 4)) return null;
    if (plaintext[2] !== 0xFF || plaintext[3] !== 0x0B) return null;
    const body = plaintext.slice(6, plaintext.length - HMAC_TAIL_LEN);
    if (body.length < 5) return null;
    const outerId = body.slice(0, 4);
    const outerIdHex = outerId.toString('hex');
    const innerData = body.slice(4);

    // Format A: 69ee + Counter + Multi-TLVs (legacy, Sonderfall fuer GPS-Frames
    // wo der counter zufaellig mit 69 ee beginnt). Mit outerLen=4 weiter unten
    // wuerde das auch parsen, deshalb fallen wir bei MISS einfach durch.
    if (innerData.length >= 4 && innerData[0] === 0x69 && innerData[1] === 0xee) {
        const counter = innerData.readUInt16BE(2);
        const tlvData = innerData.slice(4);
        const parsed = tryParseTLVList(tlvData);
        if (parsed && parsed.tlvs.length > 0) {
            return { format: 'A_69ee', outerIdHex, counter, tlvs: parsed.tlvs, tail: parsed.tailBytes.toString('hex') };
        }
        // kein "return raw" mehr -> falle weiter durch zu Format-B mit outerLen-Heuristik
    }

    // Format B: outer-val + Inner-TLVs + tail.
    // outerLen kann 1, 2 oder 4 Bytes sein:
    //   1 = Switch-Status (z.B. 0080:0901 PowerStatus)
    //   2 = z.B. Battery 1500:4402 (signed16 Strom-Wert)
    //   4 = Counter / 32-bit Zaehler (z.B. 9d004604 LTE, 9880:3304 GPS - der Counter
    //       liegt vor den TLVs und ist 4 Bytes lang. Ohne diesen Branch fallen
    //       LTE/GPS-Frames faelschlich durch zu Format-C).

    for (const outerLen of [1, 2, 4]) {
        if (outerLen >= innerData.length) continue;
        const outerVal = innerData.slice(0, outerLen);
        const rest = innerData.slice(outerLen);
        const parsed = tryParseTLVList(rest);
        if (parsed && parsed.tlvs.length > 0) {
            return {
                format: `B_outer${outerLen}_inner`,
                outerIdHex,
                outerVal: outerVal.toString('hex'),
                outerValBytes: outerVal,        // Buffer fuer applyDecodedFrame
                tlvs: parsed.tlvs,
                tail: parsed.tailBytes.toString('hex'),
            };
        }
    }

    // Format C: nur Nutzlast + Tail
    return { format: 'C_raw', outerIdHex, rawBytes: innerData, rawHex: innerData.toString('hex') };
}

/**
 * Encode a generic C->S frame fuer beliebigen opcode.
 *
 * Plaintext-Format:
 *   [00] [body-len:1] [seq:1] [opcode:1] [body:N] [HMAC-SHA1:20]
 * mit body-len = 4 + N (also 4 Header-Bytes incl. der len-Byte selbst).
 */
function encodeOpcodeFrame(seq, opcode, body, sharedSecret) {
    if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== 16) {
        throw new Error('sharedSecret must be 16-byte Buffer');
    }
    if (!Buffer.isBuffer(body)) body = Buffer.from(body);
    const bodyLen = 4 + body.length;
    if (bodyLen > 0xff) throw new Error(`body too long: bodyLen ${bodyLen} > 255`);
    const headerAndBody = Buffer.concat([
        Buffer.from([0x00, bodyLen, seq & 0xff, opcode & 0xff]),
        body,
    ]);
    const mac = crypto.createHmac('sha1', sharedSecret).update(headerAndBody).digest();
    const plaintext = Buffer.concat([headerAndBody, mac]);
    const padLen = 16 - (plaintext.length % 16);
    const plain = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', sharedSecret, iv);
    cipher.setAutoPadding(false);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const totalLen = 4 + 2 + 1 + 16 + ct.length + 1 + 2;
    const lenField = totalLen - 4;
    // L1-Pruefbyte: CRC-8 ueber [len:2][seq][IV][CT] (wie die App). Bis 1.1.0
    // stand hier fest 0x00 - die Box antwortete auf JEDES Kommando mit
    // L1-Status 3 = INCORRECT_CRC (bisher als "NACK" gelesen). Weil der IV
    // zufaellig ist, aendert sich das Byte bei jedem Frame; ein "byte-
    // exakter" Nachbau eines App-Frames konnte es deshalb nie treffen.
    const extra = l1Crc(lenField, seq, Buffer.concat([iv, ct]));
    return Buffer.concat([
        Buffer.from([0x00, 0x01, 0x01, 0x01,
                     (lenField >> 8) & 0xff, lenField & 0xff,
                     seq & 0xff]),
        iv, ct,
        Buffer.from([extra, 0xfe, 0xff]),
    ]);
}

// CRC-8 des Klartext-Frames, Polynom 0xD9, Startwert 0.
// Gerechnet ueber [len:2 BE][seq][opcode][payload], steht als letztes
// Body-Byte vor dem HMAC. Die 1-Byte-"Nonces" der Handshake-Frames sind
// genau diese Pruefsumme.
const CRC8_TABLE = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0xd9) : (c << 1);
        t[i] = c & 0xff;
    }
    return t;
})();

function crc8(bytes) {
    let r = 0;
    for (const b of bytes) r = CRC8_TABLE[(r ^ b) & 0xff];
    return r;
}

/** L1-CRC eines Frames: CRC-8 ueber [len:2 BE][msgId][verschluesselte L2]. */
function l1Crc(lenField, msgId, l2Encrypted) {
    return crc8(Buffer.concat([
        Buffer.from([(lenField >> 8) & 0xff, lenField & 0xff, msgId & 0xff]),
        l2Encrypted,
    ]));
}

/**
 * Selbsttest der L1-Pruefsumme. Der Frame ist kuenstlich (zufaelliger IV und
 * Ciphertext); sein Pruefbyte 0xa3 wurde mit dieser Funktion berechnet,
 * nachdem sie gegen einen echten Frame geprueft war.
 * Faellt der Test, hat sich die CRC-Berechnung veraendert.
 */
function l1CrcSelfTest() {
    const f = Buffer.from(
        '000101010036' + '0d' +
        'f1122a4c4ec03feda455e86cf16f67bf' +
        'dc2bbd5fe0237ea19609a02382f8a1d70917144fc060db645dedb8c3cfa8f8b2' +
        'a3feff', 'hex');
    const lenField = f.readUInt16BE(4);
    return l1Crc(lenField, f[6], f.subarray(7, f.length - 3)) === f[f.length - 3];
}

// Rueckgabecodes der Box (L1 und L2).
const L1_STATUS = ['OK', 'INCORRECT_MESSAGE_LENGTH', 'INVALID_APP_COMMAND', 'INCORRECT_CRC',
    'MISSING_ENCODED_L2_MESSAGE', 'ERROR_DECODING_L2_MESSAGE', 'MISSING_SHARED_SECRET',
    'HMAC_SIGNATURE_MISMATCH', 'MEMORY_ALLOCATION_ERROR'];
const L2_STATUS = ['OK', 'INCORRECT_MESSAGE_LENGTH', 'INVALID_APP_COMMAND',
    'PAYLOAD_NOT_MATCHING_SPECIFIED_APP_COMMAND', 'INCORRECT_CRC',
    'ERROR_DECODING_MESSAGE_USING_STORED_SECRET', 'MEMORY_ERROR', 'NOT_IMPLEMENTED'];
const statusName = (list, code) => list[code] || `0x${code.toString(16)}`;

/**
 * L0-Teilstueck: [00][teil][von][L1-Bytes...][FF]. Grosse Nachrichten (z. B.
 * die Antwort auf GET_ALL_DEVICE_VALUES) kommen in mehreren Teilen; bis 1.1.0
 * verwarf der Adapter alles ausser [00 01 01 ...]. Liefert {teil, von, daten}
 * oder null.
 */
function parseL0Chunk(buf) {
    if (buf.length < 5 || buf[0] !== 0x00 || buf[buf.length - 1] !== 0xFF) return null;
    return { teil: buf[1], von: buf[2], daten: buf.subarray(3, buf.length - 1) };
}

/**
 * Antwort auf ein Kommando (L2-Klartext nach decryptFrame):
 * [len:2][msgId][opcode][status][payload...][CRC][HMAC:20].
 * Push-Meldungen haben msgId 0xFF und opcode 0x0B und laufen ueber decodeFrame.
 */
function decodeResponse(plaintext) {
    if (plaintext.length < 6 + HMAC_TAIL_LEN) return null;
    return {
        msgId: plaintext[2],
        opcode: plaintext[3],
        status: plaintext[4],
        payload: plaintext.subarray(5, plaintext.length - HMAC_TAIL_LEN - 1),
    };
}

/**
 * GET_ALL_DEVICE_VALUES-Payload: [valueId:2][type:2][len:1][wert] je Eintrag
 * Anders als in Push-Meldungen kommen hier auch Texte (z. B.
 * Firmware-Versionen) mit mehr als 8 Byte und leere Eintraege - deshalb
 * nicht tryParseTLVList (nur Laenge 1..8). Liefert null, wenn die Liste
 * mitten in einem Eintrag abbricht.
 */
function parseValueList(payload) {
    const eintraege = [];
    let i = 0;
    while (payload.length - i >= 5) {
        const len = payload[i + 4];
        if (i + 5 + len > payload.length) return null;
        eintraege.push({
            idHex: payload.subarray(i, i + 4).toString('hex'),
            type: len,
            valBytes: payload.subarray(i + 5, i + 5 + len),
        });
        i += 5 + len;
    }
    return eintraege;
}

/**
 * Ein Eintrag der Werteliste als "Push-Frame", wie ihn decodeFrame liefern
 * wuerde: Push-Frames tragen denselben Eintrag, der Adapter liest ihn ab dem
 * Low-Byte der valueId (00 1a 80 08 01 -> outerId 1a800801).
 */
function valueEntryAsFrame(tlv) {
    const idLo = tlv.idHex.slice(2, 4);
    const typ = tlv.idHex.slice(4, 8);
    const len = tlv.type.toString(16).padStart(2, '0');
    return { format: 'C_raw', outerIdHex: `${idLo}${typ}${len}`, rawBytes: tlv.valBytes, rawHex: tlv.valBytes.toString('hex') };
}

/**
 * C->S Kommando wie die App es baut: payload plus CRC-8 als
 * letztes Body-Byte. Opcodes siehe PROTOCOL.md
 * 0x07 SET_DEVICE_VALUE_FOR_VALUEID, 0x09 SYSTEM_RESET, ...
 */
function encodeCommandFrame(seq, opcode, payload, sharedSecret) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
    const len = payload.length + 5;
    const crc = crc8(Buffer.concat([
        Buffer.from([(len >> 8) & 0xff, len & 0xff, seq & 0xff, opcode & 0xff]),
        payload,
    ]));
    return encodeOpcodeFrame(seq, opcode, Buffer.concat([payload, Buffer.from([crc])]), sharedSecret);
}

/**
 * Neustart der Box (App: systemRequest "reboot" -> SYSTEM_RESET, leerer Body).
 */
function encodeSystemResetFrame(seq, sharedSecret) {
    return encodeCommandFrame(seq, 0x09, Buffer.alloc(0), sharedSecret);
}

/**
 * Wertetabelle wie die App sie aus get-drivers-json + getConfig baut
 * valueIds (Name -> Nummer), config (Treiber ->
 * Name -> Typschluessel), typesConfigs (Typschluessel -> bytes, dividend,
 * categories, offState). Der Typ steckt im Schluesselnamen (…INTEGER…,
 * …FLOAT…, …STRING…, …CATEGORICAL…). Liefert Map<Nummer, Eintrag> oder
 * null, wenn die Antwort die Felder nicht enthaelt.
 */
function findeTreiberTabelle(antwort, tiefe = 0) {
    if (antwort == null || tiefe > 4) return null;
    if (typeof antwort === 'string') {
        try { return findeTreiberTabelle(JSON.parse(antwort), tiefe + 1); } catch (_) { return null; }
    }
    if (typeof antwort !== 'object') return null;
    if (antwort.valueIds && antwort.typesConfigs && antwort.config) return antwort;
    for (const v of Object.values(antwort)) {
        const t = findeTreiberTabelle(v, tiefe + 1);
        if (t) return t;
    }
    return null;
}

function buildValueCatalog(driversResponse, configResponse) {
    const t = findeTreiberTabelle(driversResponse);
    if (!t) return null;
    // Treiber der Box zuerst (getConfig.devices[].driver), dann alle uebrigen.
    const boxTreiber = Array.isArray(configResponse && configResponse.devices)
        ? configResponse.devices.map(d => d && d.driver).filter(Boolean) : [];
    const reihenfolge = [...new Set([...boxTreiber, ...Object.keys(t.config)])];
    const typVon = {};
    for (const treiber of reihenfolge) {
        const werte = t.config[treiber];
        if (!werte || typeof werte !== 'object') continue;
        for (const [name, typKey] of Object.entries(werte)) {
            if (!(name in typVon) && typeof typKey === 'string') typVon[name] = typKey;
        }
    }
    const katalog = new Map();
    for (const [name, nummer] of Object.entries(t.valueIds)) {
        const typKey = typVon[name];
        const tc = (typKey && t.typesConfigs[typKey]) || {};
        const typ = !typKey ? null
            : typKey.includes('INTEGER') ? 'integer'
                : typKey.includes('FLOAT') ? 'float'
                    : typKey.includes('STRING') ? 'string'
                        : typKey.includes('CATEGORICAL') ? 'categorical' : null;
        katalog.set(Number(nummer), {
            name, typ, typKey: typKey || null,
            dividend: tc.dividend, unit: tc.unit,
            categories: Array.isArray(tc.categories) ? tc.categories.map(c => (c && c.id) || c) : null,
            offState: tc.offState === true,
        });
    }
    return katalog;
}

/** Vorzeichenbehaftete Big-Endian-Zahl beliebiger Laenge. */
function signedBE(bytes) {
    if (!bytes.length) return 0;
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    const bits = BigInt(bytes.length * 8);
    if (v & (1n << (bits - 1n))) v -= (1n << bits);
    return Number(v);
}

/**
 * Wert eines Eintrags nach seiner Typbeschreibung umrechnen.
 * Liefert {value, type} fuer ioBroker oder null, wenn nicht deutbar.
 */
function decodeCatalogValue(eintrag, valBytes) {
    switch (eintrag.typ) {
        case 'string':
            return { value: valBytes.toString('utf8').replace(/\0+$/, ''), type: 'string' };
        case 'float': {
            const d = Number(eintrag.dividend) || 1;
            return { value: signedBE(valBytes) / d, type: 'number' };
        }
        case 'categorical': {
            const i = valBytes.length ? valBytes[0] : -1;
            const c = eintrag.categories && eintrag.categories[i];
            return c != null ? { value: String(c), type: 'string' } : { value: i, type: 'number' };
        }
        case 'integer': {
            const n = signedBE(valBytes);
            return { value: eintrag.offState && n === 0 ? null : n, type: 'number' };
        }
        default:
            return null;
    }
}

/** Alle aktuellen Werte anfordern (App: device "getValuesAll" -> opcode 0x05, leerer Payload). */
function encodeGetAllValuesFrame(seq, sharedSecret) {
    return encodeCommandFrame(seq, 0x05, Buffer.alloc(0), sharedSecret);
}

/**
 * Encode a C->S WRITE frame (opcode 0x07).
 * Body = [00] [wireByte] [value] [CRC-8]   (4 Bytes -> body-len 0x08)
 * Bis 1.0.1 stand hier fest 0x00 statt der Pruefsumme - die Box hat die
 * Writes mit NACK (0x03) abgelehnt.
 */
function encodeWriteFrame(seq, wireByte, value, sharedSecret) {
    return encodeCommandFrame(seq, 0x07, Buffer.from([0x00, wireByte & 0xff, value & 0xff]), sharedSecret);
}

function bytesAsNumber(bytes) {
    if (bytes.length === 1) return bytes[0];
    if (bytes.length === 2) return bytes.readUInt16BE(0);
    if (bytes.length === 4) return bytes.readUInt32BE(0);
    if (bytes.length === 8) return Number(bytes.readBigUInt64BE(0));
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return Number(v);
}

module.exports = {
    BACKEND,
    USER_AGENT,
    HMAC_TAIL_LEN,
    authFlow,
    decryptFrame,
    decodeFrame,
    encodeOpcodeFrame,
    encodeWriteFrame,
    encodeCommandFrame,
    encodeSystemResetFrame,
    encodeGetAllValuesFrame,
    l1Crc,
    l1CrcSelfTest,
    L1_STATUS,
    L2_STATUS,
    statusName,
    parseL0Chunk,
    decodeResponse,
    parseValueList,
    valueEntryAsFrame,
    buildValueCatalog,
    decodeCatalogValue,
    signedBE,
    crc8,
    tryParseTLVList,
    bytesAsNumber,
};
