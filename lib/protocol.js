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
const HMAC_TAIL_LEN = 20; // SHA1-HMAC = 20 Bytes
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
        const req = https.request(
            {
                host: BACKEND,
                method: 'POST',
                path,
                agent: sharedAgent,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(data),
                    'User-Agent': USER_AGENT,
                },
            },
            res => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const txt = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode !== 200) {
                        return reject(new Error(`${path} -> HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
                    }
                    try {
                        resolve(JSON.parse(txt));
                    } catch {
                        reject(new Error(`${path} -> invalid JSON: ${txt.slice(0, 200)}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

/**
 * Vollstaendiger Auth-Flow gegen das Solvesall-Backend.
 * Liefert wsUrl, wsToken, sharedSecret und Geraete-Metadaten.
 *
 * @param {string} username MACH account e-mail
 * @param {string} password MACH account password
 * @param {string} machId ID of the box (12 hex characters)
 * @param log adapter logger
 * @returns {Promise<{wsUrl: string, wsToken: string, sharedSecret: Buffer, deviceName: string, sharedAgent: import('https').Agent, driversResponse: object, configResponse: object}>} connection data for the WebSocket
 */
async function authFlow(username, password, machId, log) {
    const auth = { username, password };

    // Zweimal authenticate, wie die App
    await postJSON('/v0/api/mobile/authenticate', { auth });
    await postJSON('/v0/api/mobile/authenticate', { auth });

    const sync = await postJSON('/v0/api/mobile/syncData', {
        auth,
        payload: { current: [], deleted: [] },
    });
    const devs = sync.devices || {};
    const candidates = [...(devs.add || []), ...(devs.update || [])];
    const dev = candidates.find(d => d && d.machId === machId);
    if (!dev) {
        throw new Error(`machId ${machId} not found in syncData (neither in devices.add nor in devices.update)`);
    }
    const sharedSecret = Buffer.from(dev.sharedSecret, 'base64');

    if (log) {
        // Welche Felder hat das device-Object? Hilft fuer Mapping-Diagnose
        // (kein Wert-Dump - nur Feldnamen damit nichts Sensitives leakt).
        log.debug(`auth/syncData device fields: [${Object.keys(dev).join(', ')}]`);
    }

    // Diese Calls scheinen die Backend-Session "vollstaendig" zu machen.
    let signed, drivers, config, releaseType;
    try {
        signed = await postJSON('/v0/api/mobile/getSignedCredentials', { auth, payload: { machId } });
    } catch {
        // ignore
    }
    // get-drivers-json: App ruft das immer auf zwischen getSignedCredentials und getConfig
    try {
        drivers = await postJSON('/v0/api/mach-basic-lte/get-drivers-json', { version: 152, auth });
    } catch {
        // ignore
    }
    try {
        config = await postJSON('/v0/api/mach-basic/getConfig', { auth, mach: { machId } });
    } catch {
        // ignore
    }
    try {
        releaseType = await postJSON('/v0/api/mach-basic/getReleaseType', { auth, mach: { machId } });
    } catch {
        // ignore
    }

    const lte = await postJSON('/v0/lte1/mobile/auth', { auth, machId });
    if (!lte || !lte.url || !lte.token) {
        throw new Error('lte1/auth response missing url or token');
    }

    if (log) {
        log.debug(`auth/lte1 response fields: [${Object.keys(lte).join(', ')}]`);
        if (signed) {
            log.debug(`auth/getSignedCredentials fields: [${Object.keys(signed).join(', ')}]`);
            if (signed.payload != null) {
                log.debug(
                    `auth/getSignedCredentials.payload type=${typeof signed.payload} len=${String(signed.payload).length}`,
                );
            }
        }
        if (config) {
            log.debug(`auth/mach-basic/getConfig fields: [${Object.keys(config).join(', ')}]`);
            if (config.system) {
                log.debug(`  config.system fields: [${Object.keys(config.system).join(', ')}]`);
            }
        }
        if (releaseType) {
            log.debug(`auth/mach-basic/getReleaseType fields: [${Object.keys(releaseType).join(', ')}]`);
        }
        const tk = String(lte.token || '');
        log.debug(`auth/lte1 token len=${tk.length}`);
    }

    return {
        wsUrl: lte.url,
        wsToken: lte.token,
        sharedSecret,
        deviceName: dev.name || '',
        sharedAgent, // damit der WS denselben Agent nutzen kann
        configResponse: config,
        driversResponse: drivers,
    };
}

// --- AES-Decrypt + Frame-Decode --------------------------------------------

/**
 * Outer-Wrapper aufschneiden, AES-128-CBC-Decrypt mit IV in den ersten 16
 * Bytes des Payloads. Liefert plaintext (mit HMAC-Tail) oder null bei
 * struktur-/dechiffrier-Fehler.
 *
 * @param rawBuf raw binary WebSocket message
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function decryptFrame(rawBuf, sharedSecret) {
    if (rawBuf.length < 9) {
        return null;
    }
    if (rawBuf[0] !== 0x00 || rawBuf[1] !== 0x01) {
        return null;
    }
    if (rawBuf[rawBuf.length - 2] !== 0xfe || rawBuf[rawBuf.length - 1] !== 0xff) {
        return null;
    }
    // 7-Byte-Prefix: [00 01 01 01][len:2BE][seq:1]
    // Danach: [IV:16][CT:N*16][extra:1]
    const payload = rawBuf.slice(7, rawBuf.length - 2);
    if (payload.length < 32) {
        return null;
    }
    const iv = payload.slice(0, 16);
    let ct = payload.slice(16);
    ct = ct.slice(0, Math.floor(ct.length / 16) * 16);
    if (!ct.length) {
        return null;
    }
    try {
        const dec = crypto.createDecipheriv('aes-128-cbc', sharedSecret, iv);
        dec.setAutoPadding(true);
        return Buffer.concat([dec.update(ct), dec.final()]);
    } catch {
        return null;
    }
}

/**
 * Encode a generic C->S frame fuer beliebigen opcode.
 *
 * Plaintext-Format:
 *   [00] [body-len:1] [seq:1] [opcode:1] [body:N] [HMAC-SHA1:20]
 * mit body-len = 4 + N (also 4 Header-Bytes incl. der len-Byte selbst).
 *
 * @param seq message ID of the command
 * @param opcode command opcode
 * @param body command body
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function encodeOpcodeFrame(seq, opcode, body, sharedSecret) {
    if (!Buffer.isBuffer(sharedSecret) || sharedSecret.length !== 16) {
        throw new Error('sharedSecret must be 16-byte Buffer');
    }
    if (!Buffer.isBuffer(body)) {
        body = Buffer.from(body);
    }
    const bodyLen = 4 + body.length;
    if (bodyLen > 0xff) {
        throw new Error(`body too long: bodyLen ${bodyLen} > 255`);
    }
    const headerAndBody = Buffer.concat([Buffer.from([0x00, bodyLen, seq & 0xff, opcode & 0xff]), body]);
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
        Buffer.from([0x00, 0x01, 0x01, 0x01, (lenField >> 8) & 0xff, lenField & 0xff, seq & 0xff]),
        iv,
        ct,
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
        for (let b = 0; b < 8; b++) {
            c = c & 0x80 ? (c << 1) ^ 0xd9 : c << 1;
        }
        t[i] = c & 0xff;
    }
    return t;
})();

/**
 * CRC-8 over the given bytes (as used by the app for command bodies).
 *
 * @param {Buffer} bytes data
 * @returns {number} checksum byte
 */
function crc8(bytes) {
    let r = 0;
    for (const b of bytes) {
        r = CRC8_TABLE[(r ^ b) & 0xff];
    }
    return r;
}

/**
 * L1-CRC eines Frames: CRC-8 ueber [len:2 BE][msgId][verschluesselte L2].
 *
 * @param lenField length field of the L1 frame
 * @param msgId message ID
 * @param l2Encrypted encrypted L2 part
 */
function l1Crc(lenField, msgId, l2Encrypted) {
    return crc8(Buffer.concat([Buffer.from([(lenField >> 8) & 0xff, lenField & 0xff, msgId & 0xff]), l2Encrypted]));
}

/**
 * Selbsttest der L1-Pruefsumme. Der Frame ist kuenstlich (zufaelliger IV und
 * Ciphertext); sein Pruefbyte 0xa3 wurde mit dieser Funktion berechnet,
 * nachdem sie gegen einen echten Frame geprueft war.
 * Faellt der Test, hat sich die CRC-Berechnung veraendert.
 */
function l1CrcSelfTest() {
    const f = Buffer.from(
        '000101010036' +
            '0d' +
            'f1122a4c4ec03feda455e86cf16f67bf' +
            'dc2bbd5fe0237ea19609a02382f8a1d70917144fc060db645dedb8c3cfa8f8b2' +
            'a3feff',
        'hex',
    );
    const lenField = f.readUInt16BE(4);
    return l1Crc(lenField, f[6], f.subarray(7, f.length - 3)) === f[f.length - 3];
}

// Rueckgabecodes der Box (L1 und L2).
const L1_STATUS = [
    'OK',
    'INCORRECT_MESSAGE_LENGTH',
    'INVALID_APP_COMMAND',
    'INCORRECT_CRC',
    'MISSING_ENCODED_L2_MESSAGE',
    'ERROR_DECODING_L2_MESSAGE',
    'MISSING_SHARED_SECRET',
    'HMAC_SIGNATURE_MISMATCH',
    'MEMORY_ALLOCATION_ERROR',
];
const L2_STATUS = [
    'OK',
    'INCORRECT_MESSAGE_LENGTH',
    'INVALID_APP_COMMAND',
    'PAYLOAD_NOT_MATCHING_SPECIFIED_APP_COMMAND',
    'INCORRECT_CRC',
    'ERROR_DECODING_MESSAGE_USING_STORED_SECRET',
    'MEMORY_ERROR',
    'NOT_IMPLEMENTED',
];
const statusName = (list, code) => list[code] || `0x${code.toString(16)}`;

/**
 * L0-Teilstueck: [00][teil][von][L1-Bytes...][FF]. Grosse Nachrichten (z. B.
 * die Antwort auf GET_ALL_DEVICE_VALUES) kommen in mehreren Teilen; bis 1.1.0
 * verwarf der Adapter alles ausser [00 01 01 ...]. Liefert {teil, von, daten}
 * oder null.
 *
 * @param buf binary message
 */
function parseL0Chunk(buf) {
    if (buf.length < 5 || buf[0] !== 0x00 || buf[buf.length - 1] !== 0xff) {
        return null;
    }
    return { teil: buf[1], von: buf[2], daten: buf.subarray(3, buf.length - 1) };
}

/**
 * Antwort auf ein Kommando (L2-Klartext nach decryptFrame):
 * [len:2][msgId][opcode][status][payload...][CRC][HMAC:20].
 * Push-Meldungen haben msgId 0xFF und opcode 0x0B; ihre Werteliste liest
 * derselbe Aufbau.
 *
 * @param plaintext decrypted L2 message
 */
function decodeResponse(plaintext) {
    if (plaintext.length < 6 + HMAC_TAIL_LEN) {
        return null;
    }
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
 * Firmware-Versionen) mit mehr als 8 Byte und leere Eintraege. Liefert
 * null, wenn die Liste
 * mitten in einem Eintrag abbricht.
 *
 * @param payload payload bytes
 */
function parseValueList(payload) {
    const eintraege = [];
    let i = 0;
    while (payload.length - i >= 5) {
        const len = payload[i + 4];
        if (i + 5 + len > payload.length) {
            return null;
        }
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
 * C->S Kommando wie die App es baut: payload plus CRC-8 als
 * letztes Body-Byte. Opcodes siehe PROTOCOL.md
 * 0x07 SET_DEVICE_VALUE_FOR_VALUEID, 0x09 SYSTEM_RESET, ...
 *
 * @param seq message ID of the command
 * @param opcode command opcode
 * @param payload payload bytes
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function encodeCommandFrame(seq, opcode, payload, sharedSecret) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
    const len = payload.length + 5;
    const crc = crc8(Buffer.concat([Buffer.from([(len >> 8) & 0xff, len & 0xff, seq & 0xff, opcode & 0xff]), payload]));
    return encodeOpcodeFrame(seq, opcode, Buffer.concat([payload, Buffer.from([crc])]), sharedSecret);
}

/**
 * Neustart der Box (App: systemRequest "reboot" -> SYSTEM_RESET, leerer Body).
 *
 * @param seq message ID of the command
 * @param sharedSecret shared secret of the box (16 bytes)
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
 *
 * @param antwort decoded response
 * @param tiefe current search depth
 */
function findeTreiberTabelle(antwort, tiefe = 0) {
    if (antwort == null || tiefe > 4) {
        return null;
    }
    if (typeof antwort === 'string') {
        try {
            return findeTreiberTabelle(JSON.parse(antwort), tiefe + 1);
        } catch {
            return null;
        }
    }
    if (typeof antwort !== 'object') {
        return null;
    }
    if (antwort.valueIds && antwort.typesConfigs && antwort.config) {
        return antwort;
    }
    for (const v of Object.values(antwort)) {
        const t = findeTreiberTabelle(v, tiefe + 1);
        if (t) {
            return t;
        }
    }
    return null;
}

/**
 * Value table of the box from get-drivers-json and getConfig.
 *
 * @param {object} driversResponse answer of get-drivers-json
 * @param {object} configResponse answer of getConfig
 * @returns {Map<number, object>|null} valueId -> entry, null without table
 */
function buildValueCatalog(driversResponse, configResponse) {
    const t = findeTreiberTabelle(driversResponse);
    if (!t) {
        return null;
    }
    // Treiber der Box zuerst (getConfig.devices[].driver), dann alle uebrigen.
    const boxTreiber = Array.isArray(configResponse && configResponse.devices)
        ? configResponse.devices.map(d => d && d.driver).filter(Boolean)
        : [];
    const reihenfolge = [...new Set([...boxTreiber, ...Object.keys(t.config)])];
    const typVon = {};
    for (const treiber of reihenfolge) {
        const werte = t.config[treiber];
        if (!werte || typeof werte !== 'object') {
            continue;
        }
        for (const [name, typKey] of Object.entries(werte)) {
            if (!(name in typVon) && typeof typKey === 'string') {
                typVon[name] = typKey;
            }
        }
    }
    const katalog = new Map();
    for (const [name, nummer] of Object.entries(t.valueIds)) {
        const typKey = typVon[name];
        const tc = (typKey && t.typesConfigs[typKey]) || {};
        const typ = !typKey
            ? null
            : typKey.includes('INTEGER')
              ? 'integer'
              : typKey.includes('FLOAT')
                ? 'float'
                : typKey.includes('STRING')
                  ? 'string'
                  : typKey.includes('CATEGORICAL')
                    ? 'categorical'
                    : null;
        katalog.set(Number(nummer), {
            id: Number(nummer),
            name,
            typ,
            typKey: typKey || null,
            dividend: tc.dividend,
            unit: tc.unit,
            categories: Array.isArray(tc.categories) ? tc.categories.map(c => (c && c.id) || c) : null,
            offState: tc.offState === true,
            bytes: Number(tc.bytes) || null,
            range: Array.isArray(tc.range) && tc.range.length === 2 ? tc.range.map(Number) : null,
            step: Number(tc.step) || null,
            writable: tc.writable === true,
            // hasState false: Aktion ohne Zustand ("start", "press", "save/restore")
            hasState: tc.hasState !== false,
        });
    }
    return katalog;
}

/**
 * Vorzeichenbehaftete Big-Endian-Zahl beliebiger Laenge.
 *
 * @param bytes data bytes
 */
function signedBE(bytes) {
    if (!bytes.length) {
        return 0;
    }
    let v = 0n;
    for (const b of bytes) {
        v = (v << 8n) | BigInt(b);
    }
    const bits = BigInt(bytes.length * 8);
    if (v & (1n << (bits - 1n))) {
        v -= 1n << bits;
    }
    return Number(v);
}

/**
 * Wert eines Eintrags nach seiner Typbeschreibung umrechnen.
 * Liefert {value, type} fuer ioBroker oder null, wenn nicht deutbar.
 *
 * @param eintrag value table entry
 * @param valBytes raw value bytes
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

/**
 * Ganze Zahl als vorzeichenbehaftetes Big Endian mit fester Laenge.
 *
 * @param n number
 * @param bytes data bytes
 */
function intBE(n, bytes) {
    const bits = BigInt(bytes * 8);
    let v = BigInt(n);
    const min = -(1n << (bits - 1n));
    const max = (1n << bits) - 1n; // unsigned zulassen (App schneidet ebenfalls ab)
    if (v < min || v > max) {
        throw new Error(`${n} does not fit into ${bytes} bytes`);
    }
    if (v < 0n) {
        v += 1n << bits;
    }
    const buf = Buffer.alloc(bytes);
    for (let i = bytes - 1; i >= 0; i--) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf;
}

/**
 * Wert fuer SET_DEVICE_VALUE_FOR_VALUEID kodieren - wie die App
 * (constructSetValueRequest):
 *   categorical: 1 Byte = Position in der Liste (Name oder Index erlaubt)
 *   integer:     Big Endian, `bytes` lang (Standard 2); "aus" bei offState = 1 Byte 0
 *   float:       Wert x dividend, Big Endian, `bytes` lang (Standard 2)
 *   string:      [Laenge:1][UTF-8]
 * Bereich (range) und Schritt (step) werden geprueft; Fehler werfen.
 *
 * @param eintrag value table entry
 * @param wert value
 */
function encodeCatalogValue(eintrag, wert) {
    const imBereich = v => {
        if (!eintrag.range) {
            return;
        }
        const [lo, hi] = eintrag.range;
        if (v < lo || v > hi) {
            throw new Error(`${v} outside ${lo}..${hi}`);
        }
    };
    switch (eintrag.typ) {
        case 'categorical': {
            const liste = eintrag.categories || [];
            const idx = typeof wert === 'number' ? wert : liste.indexOf(String(wert));
            if (!Number.isInteger(idx) || idx < 0 || idx >= liste.length) {
                throw new Error(`"${wert}" is not a valid choice (${liste.join(', ')})`);
            }
            return Buffer.from([idx]);
        }
        case 'integer': {
            if (eintrag.offState && (wert === 0 || wert === null)) {
                return Buffer.from([0]);
            }
            const n = Number(wert);
            if (!Number.isInteger(n)) {
                throw new Error(`${wert} is not an integer`);
            }
            imBereich(n);
            return intBE(n, eintrag.bytes || 2);
        }
        case 'float': {
            const v = Number(wert);
            if (!Number.isFinite(v)) {
                throw new Error(`${wert} is not a number`);
            }
            imBereich(v);
            const d = Number(eintrag.dividend) || 1;
            if (eintrag.step && Math.abs(v / eintrag.step - Math.round(v / eintrag.step)) > 1e-9) {
                throw new Error(`${v} does not match the step ${eintrag.step}`);
            }
            const roh = Math.round(v * d);
            return intBE(roh, eintrag.bytes || 2);
        }
        case 'string': {
            const b = Buffer.from(String(wert == null ? '' : wert), 'utf8');
            if (b.length > 255) {
                throw new Error('text longer than 255 bytes');
            }
            return Buffer.concat([Buffer.from([b.length]), b]);
        }
        default:
            throw new Error(`type ${eintrag.typ} is not writable`);
    }
}

/**
 * SET_DEVICE_VALUE_FOR_VALUEID (0x07): [valueId:2][Wert].
 *
 * @param seq message ID of the command
 * @param valueId ID of the value in the value table
 * @param wertBytes encoded value
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function encodeSetValueFrame(seq, valueId, wertBytes, sharedSecret) {
    return encodeCommandFrame(seq, 0x07, Buffer.concat([intBE(valueId, 2), wertBytes]), sharedSecret);
}

/**
 * GET_DEVICE_VALUE_FOR_VALUEID (0x06): [valueId:2]; Antwort ist eine Werteliste.
 *
 * @param seq message ID of the command
 * @param valueId ID of the value in the value table
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function encodeGetValueFrame(seq, valueId, sharedSecret) {
    return encodeCommandFrame(seq, 0x06, intBE(valueId, 2), sharedSecret);
}

/**
 * Alle aktuellen Werte anfordern (App: device "getValuesAll" -> opcode 0x05, leerer Payload).
 *
 * @param seq message ID of the command
 * @param sharedSecret shared secret of the box (16 bytes)
 */
function encodeGetAllValuesFrame(seq, sharedSecret) {
    return encodeCommandFrame(seq, 0x05, Buffer.alloc(0), sharedSecret);
}

/**
 * Rohwert ohne Wertetabelle als vorzeichenlose Big-Endian-Zahl.
 *
 * @param bytes data bytes
 */
function bytesAsNumber(bytes) {
    if (bytes.length === 1) {
        return bytes[0];
    }
    if (bytes.length === 2) {
        return bytes.readUInt16BE(0);
    }
    if (bytes.length === 4) {
        return bytes.readUInt32BE(0);
    }
    if (bytes.length === 8) {
        return Number(bytes.readBigUInt64BE(0));
    }
    let v = 0n;
    for (const b of bytes) {
        v = (v << 8n) | BigInt(b);
    }
    return Number(v);
}

module.exports = {
    BACKEND,
    USER_AGENT,
    HMAC_TAIL_LEN,
    authFlow,
    decryptFrame,
    encodeOpcodeFrame,
    encodeCommandFrame,
    encodeSystemResetFrame,
    encodeGetAllValuesFrame,
    encodeCatalogValue,
    encodeSetValueFrame,
    encodeGetValueFrame,
    intBE,
    l1Crc,
    l1CrcSelfTest,
    L1_STATUS,
    L2_STATUS,
    statusName,
    parseL0Chunk,
    decodeResponse,
    parseValueList,
    buildValueCatalog,
    decodeCatalogValue,
    signedBE,
    crc8,
    bytesAsNumber,
};
