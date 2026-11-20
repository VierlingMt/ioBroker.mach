'use strict';

const utils = require('@iobroker/adapter-core');
const WebSocket = require('ws');

const protocol = require('./lib/protocol');
const werte = require('./lib/werte');

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 15_000;
// Schutz gegen Schleifen (z. B. Skript-Fehler): hoechstens ein Neustart je Zeitraum.
const REBOOT_MIN_ABSTAND_MS = 10 * 60 * 1000;
// Die Box pusht nur Aenderungen; ein verpasster Wechsel bliebe sonst stehen
// (Kuehlschrank stand so 2 Monate auf "an"). Darum regelmaessig den
// Gesamtstand holen - die App tut das beim Oeffnen ebenso.
const GET_ALL_INTERVAL_MS = 15 * 60 * 1000;
// Nach einer Push-Meldung kurz danach den Gesamtstand holen, damit values.*
// nicht bis zum naechsten Intervall hinterherhaengt - hoechstens 1x/min.
const GET_ALL_NACH_PUSH_MS = 5_000;
const GET_ALL_MIN_ABSTAND_MS = 60_000;
// Schreiben: Abstand zwischen zwei Befehlen, Nachfrage nach dem OK der Box
// und Frist, bis die Box den neuen Wert gemeldet haben muss.
const SCHREIB_ABSTAND_MS = 300;
const NACHFRAGE_NACH_MS = 700;
const BESTAETIGUNG_FRIST_MS = 20_000;
// Werte, die nicht in ioBroker-States gehoeren: wer ioBroker lesen darf,
// soll damit nicht per Bluetooth an die Box kommen oder SIM/Modem
// identifizieren koennen.
/**
 * Rolle passend zum State: switch.* und level.* stehen in ioBroker fuer
 * schaltbare States. Nur lesbare Werte (z. B. Licht, Kuehlschrank - Schreiben
 * ist dort noch nicht freigegeben) bekommen deshalb eine Anzeige-Rolle,
 * "indicator" nur fuer Wahr/Falsch.
 *
 * @param role proposed role
 * @param type state type
 * @param writable whether the state is writable
 */
function passendeRolle(role, type, writable) {
    if (!writable) {
        if (role.startsWith('switch')) {
            return type === 'boolean' ? 'indicator' : 'value';
        }
        if (role === 'level.temperature') {
            return 'value.temperature';
        }
        if (role.startsWith('level')) {
            return 'value';
        }
    }
    if (role.startsWith('indicator') && type !== 'boolean') {
        return 'value';
    }
    return role;
}

const ORDNER_NAMEN = {
    values: 'Values of the box (named like in the app)',
    tlv: 'Raw values not in the value table',
};
// Zweige aus Versionen vor 2.0.0: named.* (von Hand dekodierte Frames mit
// deutschen IDs) und frames.* (rohe Push-Frames). values.* deckt alles ab.
const ALTE_ZWEIGE = ['named', 'frames'];

const VERTRAULICH = new Set([
    'SYSTEM_BLE_PIN',
    'SYSTEM_BLE_PIN_DEFAULT',
    'LTE_EMBEDDED_SIM_ICCID',
    'LTE_INSERTED_SIM_ICCID',
    'LTE_SIM_ID_VALUE',
    'LTE_MODEM_IMEI',
]);
// Ablage der Server-Wertetabelle zur Analyse (ioBroker-Dateispeicher).
const ABLAGE_ADAPTER = '0_userdata.0';

class Mach extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'mach',
        });

        /** @type {WebSocket|null} */
        this.ws = null;
        this.msgStats = { binaryTotal: 0, textTotal: 0, decryptFail: 0, push: 0 };
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.stopping = false;
        this.sharedSecret = null;
        this.lastValues = new Map();
        this.ensuredObjects = new Set();
        this.seqCounter = 1; // C->S Schreib-Counter, resettet bei Reconnect
        this.pendingWrites = new Map(); // seq -> {id, oldValue, name, ts} fuer NACK-Rollback
        this.letzterReboot = 0;
        this.getAllTimer = null;
        this.getAllNachPushTimer = null;
        this.letzterGetAll = 0;
        this.valueCatalog = null; // Map<valueId, {name, typ, ...}> aus get-drivers-json
        this.katalogNachName = new Map(); // Name -> Eintrag der Wertetabelle
        this.schreibCfg = werte.schreibKonfig({});
        this.schreibQueue = [];
        this.schreibLaeuft = false;
        this.ausstehend = new Map(); // Name -> {ziel, ids, timer} bis die Box den Wert meldet
        this.knoepfe = new Map(); // values.<NAME>_<AKTION> -> {e, index}
        this.werteDefiniert = new Map(); // values.<NAME> -> JSON der zuletzt gesetzten Definition
        this.l0Teile = []; // Teilstuecke einer mehrteiligen L0-Nachricht

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });

        await this.entferneAlteZweige();

        // Ordner auch fuer States aus aelteren Versionen anlegen, die keine
        // Werte mehr bekommen - sonst fehlen sie dauerhaft.
        try {
            const objekte = await this.getAdapterObjectsAsync();
            for (const [id, obj] of Object.entries(objekte)) {
                if (obj && obj.type === 'state') {
                    await this._ensureParents(id.slice(this.namespace.length + 1));
                }
            }
        } catch (e) {
            this.log.warn(`Could not create folders for existing states: ${e.message}`);
        }

        const { username, password, machId } = this.config;
        if (!username || !password || !machId) {
            this.log.error(
                'Configuration incomplete: please enter username, password and machId in the adapter settings.',
            );
            return;
        }

        this.schreibCfg = werte.schreibKonfig(this.config);
        const { stufe, freigabenText, sperrenText } = this.schreibCfg;
        this.log.info(
            `Write access: ${stufe}${freigabenText ? `, additionally writable: ${freigabenText}` : ''}${sperrenText ? `, never writable: ${sperrenText}` : ''}`,
        );

        this.subscribeStates('*');
        // machId und Benutzer nur gekuerzt: Logs landen oft in Foren.
        this.log.info(
            `mach adapter ready – machId=${String(machId).slice(0, 4)}…, user=${String(username).replace(/^(.).*@/, '$1…@')}`,
        );
        await this.setObjectNotExistsAsync('control', {
            type: 'channel',
            common: { name: 'Control' },
            native: {},
        });
        await this.setObjectNotExistsAsync('control.reboot', {
            type: 'state',
            common: {
                name: 'Restart the MACH box (like in the app)',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            native: {},
        });
        // Aeltere Versionen haben deutsche Namen angelegt.
        await this.extendObjectAsync('control', { common: { name: 'Control' } }).catch(() => {});
        await this.extendObjectAsync('control.reboot', {
            common: { name: 'Restart the MACH box (like in the app)' },
        }).catch(() => {});
        this.connect();
    }

    /**
     * named.* und frames.* aus Versionen vor 2.0.0 entfernen. States mit
     * eigenen Einstellungen (common.custom, z. B. History oder InfluxDB)
     * bleiben stehen - deren Einstellungen waeren sonst verloren.
     */
    async entferneAlteZweige() {
        let objekte;
        try {
            objekte = await this.getAdapterObjectsAsync();
        } catch (e) {
            this.log.warn(`Could not read objects for clean-up: ${e.message}`);
            return;
        }
        const praefixe = ALTE_ZWEIGE.map(z => `${this.namespace}.${z}`);
        const imAltenZweig = id => praefixe.some(p => id === p || id.startsWith(`${p}.`));
        const ids = Object.keys(objekte).filter(imAltenZweig);
        if (!ids.length) {
            return;
        }
        const behalten = new Set();
        let geloescht = 0;
        // Tiefste zuerst, damit Ordner erst nach ihrem Inhalt drankommen.
        for (const id of ids.sort((a, b) => b.split('.').length - a.split('.').length)) {
            const obj = objekte[id];
            const custom = obj && obj.common && obj.common.custom;
            const kinderBleiben = [...behalten].some(k => k.startsWith(`${id}.`));
            if ((custom && Object.keys(custom).length) || kinderBleiben) {
                behalten.add(id);
                if (custom && Object.keys(custom).length) {
                    this.log.warn(
                        `${id.slice(this.namespace.length + 1)} is no longer used since 2.0.0 but kept because it has custom settings (e.g. history). Delete it manually when no longer needed.`,
                    );
                }
                continue;
            }
            try {
                await this.delObjectAsync(id.slice(this.namespace.length + 1));
                geloescht++;
            } catch (e) {
                this.log.debug(`Could not delete ${id}: ${e.message}`);
            }
        }
        if (geloescht) {
            this.log.info(`Removed ${geloescht} objects of the old named.* / frames.* trees (replaced by values.*).`);
        }
    }

    /**
     * Ordner ueber einem State anlegen: ioBroker verlangt fuer jeden
     * Pfadabschnitt ein eigenes Objekt (values, tlv.<id> ...).
     *
     * @param idRel state ID relative to the instance
     */
    async _ensureParents(idRel) {
        const teile = idRel.split('.');
        for (let i = 1; i < teile.length; i++) {
            const id = teile.slice(0, i).join('.');
            if (this.ensuredObjects.has(id)) {
                continue;
            }
            await this.setObjectNotExistsAsync(id, {
                type: i === 1 ? 'folder' : 'channel',
                common: { name: ORDNER_NAMEN[id] || id },
                native: {},
            });
            this.ensuredObjects.add(id);
        }
    }

    async _ensureObject(idRel, meta, isWritable = false) {
        if (this.ensuredObjects.has(idRel)) {
            return;
        }
        await this._ensureParents(idRel);
        const role = passendeRolle(meta.role || 'value', meta.type || 'number', isWritable);
        await this.setObjectNotExistsAsync(idRel, {
            type: 'state',
            common: {
                name: meta.name || idRel,
                type: meta.type || 'number',
                role,
                unit: meta.unit,
                read: true,
                write: isWritable,
            },
            native: {},
        });
        // Bestehende Installationen: Rolle aus aelteren Versionen nachziehen,
        // ohne das Objekt neu anzulegen.
        const obj = await this.getObjectAsync(idRel);
        if (obj && obj.common && obj.common.role !== role) {
            await this.extendObjectAsync(idRel, { common: { role } });
        }
        // Default-Wert nur setzen falls State noch keinen Wert hat. Damit
        // ueberschreiben wir keine echten Werte aus persistierter Datenbank.
        try {
            const existing = await this.getStateAsync(idRel);
            if (!existing || existing.val === undefined || existing.val === null) {
                let defaultVal = null;
                if (meta.type === 'boolean') {
                    defaultVal = false;
                } else if (meta.type === 'string') {
                    defaultVal = '';
                }
                // q=0x40 = "default value" (kein echter Wert)
                await this.setStateAsync(idRel, { val: defaultVal, ack: true, q: 0x40 });
            }
        } catch {
            /* ignore */
        }
        this.ensuredObjects.add(idRel);
    }

    async connect() {
        if (this.stopping) {
            return;
        }
        const { username, password, machId } = this.config;
        try {
            this.log.debug('Starting HTTP auth flow ...');
            const auth = await protocol.authFlow(username, password, machId, this.log);
            this.sharedSecret = auth.sharedSecret;
            this.runHmacSelfTest();
            await this.ladeWerteTabelle(auth);
            this.log.info(`Auth OK, device="${auth.deviceName}", sharedSecret-len=${auth.sharedSecret.length}B`);
            this.openWebSocket(auth.wsUrl, auth.wsToken, machId, auth.sharedAgent);
        } catch (e) {
            this.log.error(`Authentication failed: ${e.message}`);
            this.scheduleReconnect();
        }
    }

    openWebSocket(wsUrl, wsToken, machId, sharedAgent) {
        if (this.stopping) {
            return;
        }
        this.log.info(`WS connecting to: ${wsUrl} (agent-shared=${!!sharedAgent})`);

        // Header wie die App: nur token + id, kein User-Agent.
        // sharedAgent: derselbe https.Agent wie die HTTP-Auth-Calls, damit
        // der WS-Upgrade ggf. den TCP-Socket der vorigen Calls weiterverwendet
        // (App nutzt EIN OkHttp-Client - gleicher Connection-Pool).
        const ws = new WebSocket(wsUrl, {
            headers: {
                token: wsToken,
                id: machId,
            },
            perMessageDeflate: true,
            agent: sharedAgent,
        });
        this.ws = ws;

        ws.on('open', () => {
            if (this.stopping) {
                try {
                    ws.terminate();
                } catch {
                    // ignore
                }
                return;
            }
            this.log.info('WebSocket open');
            this.seqCounter = 1; // bei jedem (Re-)connect zuruecksetzen
            this.subscribed = false;
            this.setStateAsync('info.connection', { val: true, ack: true }).catch(() => {});
            try {
                ws.send('GET_SYSTEM_CONNECTED');
            } catch {
                // ignore
            }

            // Handshake wie die App beim Kaltstart (nur lesende Opcodes, siehe
            // sendHandshake), danach Gesamtstand holen und regelmaessig wieder.
            this.sendHandshake()
                .then(() => {
                    this.requestAllValues('connect');
                    if (this.getAllTimer) {
                        this.clearInterval(this.getAllTimer);
                    }
                    this.getAllTimer = this.setInterval(() => this.requestAllValues('interval'), GET_ALL_INTERVAL_MS);
                })
                .catch(e => {
                    this.log.error(`Handshake error: ${e.message}`);
                });
            this.heartbeatTimer = this.setInterval(() => {
                if (this.stopping) {
                    return;
                }
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send('GET_SYSTEM_CONNECTED');
                    } catch {
                        // ignore
                    }
                }
            }, HEARTBEAT_INTERVAL_MS);
        });

        // Diagnose-Zaehler
        this.msgStats = {
            binaryTotal: 0,
            textTotal: 0,
            decryptFail: 0,
            push: 0,
        };

        ws.on('message', async (data, isBinary) => {
            if (this.stopping) {
                return;
            }
            if (!isBinary) {
                this.msgStats.textTotal++;
                return;
            }
            this.msgStats.binaryTotal++;
            try {
                let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
                // Mehrteilige L0-Nachricht (z. B. GET_ALL-Antwort): Teile sammeln
                // und als einteilige Nachricht weiterreichen.
                const teil = protocol.parseL0Chunk(buf);
                if (teil && teil.von > 1) {
                    if (teil.teil === 1) {
                        this.l0Teile = [];
                    }
                    this.l0Teile.push(teil.daten);
                    if (teil.teil < teil.von) {
                        return;
                    }
                    if (this.l0Teile.length !== teil.von) {
                        this.log.warn(`L0: received ${this.l0Teile.length} of ${teil.von} parts - message dropped.`);
                        this.l0Teile = [];
                        return;
                    }
                    buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x01]), ...this.l0Teile, Buffer.from([0xff])]);
                    this.l0Teile = [];
                }
                if (this.msgStats.binaryTotal === 1) {
                    this.log.info(
                        `first binary message received: ${buf.length}B, prefix=${buf.slice(0, 8).toString('hex')}`,
                    );
                }
                // L1-Kurzantwort (11 Byte): 00 01 01 [01 len:2 msgId status crc FE] FF.
                // Status: 0 = OK, 3 = INCORRECT_CRC usw. Kommt
                // nur bei Fehlern auf L1-Ebene; Erfolg liefert eine L2-Antwort.
                if (buf.length < 32 && buf.length >= 9 && buf[0] === 0x00 && buf[1] === 0x01) {
                    const seqEcho = buf[6] !== undefined ? buf[6] : -1;
                    const statusByte = buf[7] !== undefined ? buf[7] : -1;
                    const name = protocol.statusName(protocol.L1_STATUS, statusByte);
                    this.log.info(
                        `Box L1 response: msgId=0x${seqEcho.toString(16).padStart(2, '0')} status=${name} hex=${buf.toString('hex')}`,
                    );
                    await this.beendeAusstehend(seqEcho, statusByte === 0, `L1 ${name}`);
                    return;
                }
                const plain = protocol.decryptFrame(buf, this.sharedSecret);
                if (!plain) {
                    this.msgStats.decryptFail++;
                    if (this.msgStats.decryptFail <= 3) {
                        this.log.warn(
                            `decrypt FAIL #${this.msgStats.decryptFail} for ${buf.length}B frame, prefix=${buf.slice(0, 8).toString('hex')}`,
                        );
                    }
                    return;
                }
                // Antwort auf ein eigenes Kommando (msgId = unsere seq); Push-
                // Meldungen tragen msgId 0xFF.
                if (plain[2] !== 0xff) {
                    await this.verarbeiteAntwort(protocol.decodeResponse(plain));
                    return;
                }
                // Push-Meldung der Box. info.lastFrameAt fuer Staleness-Tracking.
                this.msgStats.push++;
                this.setStateAsync('info.lastFrameAt', { val: Date.now(), ack: true }).catch(() => {});
                await this.applyPushWerte(plain);
                this.getAllNachPush();
            } catch (e) {
                if (!this.stopping) {
                    this.log.warn(`WS msg error: ${e.message}`);
                }
            }
        });

        // Diagnose-Zusammenfassung, nur auf debug-Level.
        this.statsTimer = this.setInterval(() => {
            if (this.stopping) {
                return;
            }
            const s = this.msgStats;
            this.log.debug(
                `stats: binary=${s.binaryTotal} text=${s.textTotal} decryptFail=${s.decryptFail} push=${s.push}`,
            );
        }, 5 * 60_000);

        ws.on('close', code => {
            if (this.stopping) {
                return;
            }
            this.log.warn(`WebSocket close ${code}`);
            this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
            this.cleanupWebSocket();
            this.scheduleReconnect();
        });

        ws.on('error', err => {
            if (!this.stopping) {
                this.log.error(`WebSocket error: ${err.message}`);
            }
        });
    }

    /**
     * Wert ohne Eintrag in der Wertetabelle roh ablegen:
     * tlv.<id>_t<typ>.raw (Zahl) und .hex. So bleibt sichtbar, was die Box
     * sendet, auch wenn der Wert (noch) keinen Namen hat.
     *
     * @param tlv value list entry
     */
    async legeRohAb(tlv) {
        const tlvId = `tlv.${tlv.idHex}_t${tlv.type.toString(16).padStart(2, '0')}`;
        await this._upsert(`${tlvId}.raw`, protocol.bytesAsNumber(tlv.valBytes), {
            type: 'number',
            role: 'value',
            name: `Raw value ${tlv.idHex}`,
        });
        await this._upsert(`${tlvId}.hex`, tlv.valBytes.toString('hex'), {
            type: 'string',
            role: 'text',
            name: `Raw value ${tlv.idHex} (hex)`,
        });
    }

    async _upsert(idRel, value, meta) {
        if (!this.ensuredObjects.has(idRel)) {
            await this._ensureObject(idRel, meta, false);
            this.log.debug(`new state: ${idRel} = ${value}`);
        }
        await this.setStateAsync(idRel, { val: value, ack: true });
    }

    /**
     * Selbsttest der Pruefsummen. Ein HMAC-Test braeuchte Werte einer
     * bestimmten Box (ihr Schluessel) und ist deshalb nicht hier.
     */
    runHmacSelfTest() {
        if (!protocol.l1CrcSelfTest()) {
            this.log.warn('L1 CRC self test failed - the box would reject every command with INCORRECT_CRC.');
        }
    }

    /** Naechste Nachrichten-ID: 0x00 und 0xFF (Push) auslassen. */
    nextSeq() {
        let seq = this.seqCounter & 0xff;
        if (seq === 0x00 || seq === 0xff) {
            seq = 0x01;
        }
        this.seqCounter = seq + 1;
        return seq;
    }

    /**
     * Wertetabelle der App aus get-drivers-json + getConfig. Ohne sie gibt
     * es keine values.*-States; unbekannte Eintraege landen dann roh unter
     * tlv.*. Die Rohantworten gehen zur Analyse in den Dateispeicher.
     *
     * @param auth auth parameters
     */
    async ladeWerteTabelle(auth) {
        try {
            this.valueCatalog = protocol.buildValueCatalog(auth.driversResponse, auth.configResponse);
        } catch (e) {
            this.valueCatalog = null;
            this.log.warn(`Value table not readable: ${e.message}`);
        }
        this.katalogNachName = new Map();
        if (this.valueCatalog) {
            for (const e of this.valueCatalog.values()) {
                this.katalogNachName.set(e.name, e);
            }
            this.log.info(`Value table: ${this.valueCatalog.size} values known (get-drivers-json)`);
        } else {
            const felder =
                auth.driversResponse && typeof auth.driversResponse === 'object'
                    ? Object.keys(auth.driversResponse).join(', ')
                    : typeof auth.driversResponse;
            this.log.warn(`Value table missing in get-drivers-json (fields: ${felder}) - only raw values under tlv.*`);
        }
        for (const [datei, inhalt] of [
            ['drivers.json', auth.driversResponse],
            ['config.json', auth.configResponse],
        ]) {
            if (inhalt == null) {
                continue;
            }
            try {
                await this.writeFileAsync(ABLAGE_ADAPTER, `mach/${datei}`, JSON.stringify(inhalt, null, 1));
            } catch (e) {
                this.log.debug(`Could not store ${datei}: ${e.message}`);
            }
        }
    }

    /** Nach einer Push-Meldung den Gesamtstand nachziehen (entprellt). */
    getAllNachPush() {
        if (this.getAllNachPushTimer) {
            return;
        }
        const warte = Math.max(GET_ALL_NACH_PUSH_MS, this.letzterGetAll + GET_ALL_MIN_ABSTAND_MS - Date.now());
        this.getAllNachPushTimer = this.setTimeout(() => {
            this.getAllNachPushTimer = null;
            this.requestAllValues('after push');
        }, warte);
    }

    /**
     * Gesamtstand anfordern (GET_ALL_DEVICE_VALUES, opcode 0x05).
     *
     * @param anlass reason for the log
     */
    requestAllValues(anlass) {
        if (this.stopping || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) {
            return;
        }
        this.letzterGetAll = Date.now();
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeGetAllValuesFrame(seq, this.sharedSecret));
            this.pendingWrites.set(seq, { id: null, oldValue: null, name: 'GET_ALL', ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 15_000);
            this.log.debug(`GET_ALL_DEVICE_VALUES sent (${anlass}, seq=0x${seq.toString(16).padStart(2, '0')})`);
        } catch (e) {
            this.log.warn(`GET_ALL_DEVICE_VALUES not sent: ${e.message}`);
        }
    }

    /**
     * L2-Antwort auf ein eigenes Kommando auswerten.
     *
     * @param antwort decoded response
     */
    async verarbeiteAntwort(antwort) {
        if (!antwort) {
            return;
        }
        const ok = antwort.status === 0;
        const name = protocol.statusName(protocol.L2_STATUS, antwort.status);
        if (antwort.opcode === 0x05 && ok) {
            await this.applyAllValues(antwort.payload);
        } else if (antwort.opcode === 0x06 && ok) {
            const liste = protocol.parseValueList(antwort.payload);
            if (liste) {
                await this.applyValueEntries(liste);
            }
        } else {
            this.log.debug(
                `Box L2 response: msgId=0x${antwort.msgId.toString(16)} opcode=0x${antwort.opcode.toString(16)} status=${name}`,
            );
        }
        await this.beendeAusstehend(antwort.msgId, ok, `L2 ${name}`);
    }

    /**
     * Ausstehendes Kommando abschliessen; bei Fehler einen Schreibwert zuruecknehmen.
     *
     * @param seq message ID of the command
     * @param ok whether the box accepted
     * @param grund reason for the log
     */
    async beendeAusstehend(seq, ok, grund) {
        const pending = this.pendingWrites.get(seq);
        if (!pending) {
            return;
        }
        this.pendingWrites.delete(seq);
        if (pending.art === 'GET') {
            return;
        }
        if (pending.art === 'SET') {
            if (ok) {
                this.log.info(`${pending.name}: box OK (seq=0x${seq.toString(16).padStart(2, '0')})`);
                // Gleich nachfragen, statt auf Push oder Gesamtstand zu warten.
                if (pending.e) {
                    this.setTimeout(() => this.frageWert(pending.e), NACHFRAGE_NACH_MS);
                }
            } else {
                this.log.warn(`${pending.name}: box rejected (${grund})`);
                await this.zuruecknehmen(pending.name, `box rejected (${grund})`);
            }
            return;
        }
        if (ok) {
            this.log.info(`${pending.name}: box OK (seq=0x${seq.toString(16).padStart(2, '0')})`);
            return;
        }
        this.log.warn(`${pending.name}: box rejected (${grund})`);
        if (pending.id && pending.name !== 'REBOOT') {
            try {
                await this.setStateAsync(pending.id, { val: pending.oldValue, ack: true });
            } catch {
                // ignore
            }
        }
    }

    /**
     * Gesamtstand der Box (Antwort auf GET_ALL_DEVICE_VALUES). Jeder Eintrag
     * ist derselbe [valueId][type][len][wert] wie in einer Push-Meldung.
     *
     * @param payload payload bytes
     */
    async applyAllValues(payload) {
        const eintraege = protocol.parseValueList(payload);
        if (!eintraege) {
            this.log.warn(
                `GET_ALL response not readable (${payload.length} B): ${payload.subarray(0, 32).toString('hex')}...`,
            );
            return;
        }
        const { benannt, roh } = await this.applyValueEntries(eintraege);
        await this.setStateAsync('info.lastAllValuesAt', { val: Date.now(), ack: true }).catch(() => {});
        this.log.info(`Full state from the box: ${eintraege.length} values (${benannt} named, ${roh} raw)`);
    }

    /**
     * Eintraege einer Werteliste (Gesamtstand, Einzelabfrage oder Push)
     * uebernehmen: bekannte Werte nach values.<NAME>, unbekannte roh nach
     * tlv.*.
     *
     * @param eintraege value list entries
     */
    async applyValueEntries(eintraege) {
        let benannt = 0,
            roh = 0;
        for (const tlv of eintraege) {
            if (tlv.valBytes.length === 0) {
                continue;
            }
            // Jeder Wert genau einmal: bekannt -> values.<NAME>, sonst roh tlv.*.
            const eintrag = this.valueCatalog && this.valueCatalog.get(parseInt(tlv.idHex.slice(0, 4), 16));
            if (eintrag && VERTRAULICH.has(eintrag.name)) {
                continue;
            }
            const wert = eintrag
                ? werte.zustandsWert(eintrag, protocol.decodeCatalogValue(eintrag, tlv.valBytes))
                : undefined;
            if (wert !== undefined) {
                benannt++;
                await this.setzeWert(eintrag, wert);
            } else if (!eintrag) {
                roh++;
                await this.legeRohAb(tlv);
            }
        }
        return { benannt, roh };
    }

    /**
     * values.<NAME> anlegen/anpassen und Wert der Box setzen (ack).
     *
     * @param e value table entry
     * @param wert value
     */
    async setzeWert(e, wert) {
        const id = `values.${e.name}`;
        await this.definiereWert(e);
        // Waehrend ein Befehl aussteht: ein abweichender Wert ist oft nur die
        // alte Meldung, die kurz nach dem Befehl noch eintrifft. Dann nicht
        // zurueckspringen, sondern bis zur Frist warten und nachfragen.
        if (this.wartetAufBox(e, wert)) {
            return;
        }
        this.bestaetige(e, wert);
        const key = `val:${e.name}`;
        if (this.lastValues.has(key) && this.lastValues.get(key) === wert) {
            return;
        }
        this.lastValues.set(key, wert);
        await this.setStateAsync(id, { val: wert, ack: true });
    }

    /**
     * Objekt values.<NAME> passend zur Wertetabelle (Typ, Rolle, Auswahl,
     * Grenzen, schreibbar). Bestehende Objekte aus aelteren Versionen werden
     * angepasst statt neu angelegt; Aktionen bekommen Knoepfe.
     *
     * @param e value table entry
     */
    async definiereWert(e) {
        const id = `values.${e.name}`;
        const schreibbar = werte.istSchreibbar(e, this.schreibCfg);
        const common = werte.objektDefinition(e, schreibbar);
        const sig = JSON.stringify(common);
        if (this.werteDefiniert.get(id) === sig) {
            return;
        }
        await this._ensureParents(id);
        await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        const obj = await this.getObjectAsync(id);
        const alt = obj && obj.common ? obj.common : {};
        const felder = ['type', 'role', 'write', 'unit', 'min', 'max', 'step'];
        const anders =
            felder.some(f => alt[f] !== common[f]) ||
            JSON.stringify(alt.states || null) !== JSON.stringify(common.states || null);
        if (anders) {
            const neu = { ...common };
            for (const f of [...felder, 'states']) {
                if (!(f in neu) && f in alt) {
                    neu[f] = null;
                }
            }
            await this.extendObjectAsync(id, { common: neu });
            if (alt.type && alt.type !== common.type) {
                this.lastValues.delete(`val:${e.name}`);
            }
        }
        this.werteDefiniert.set(id, sig);
        this.ensuredObjects.add(id);

        if (schreibbar && werte.istAktion(e)) {
            for (const k of werte.aktionsKnoepfe(e)) {
                const kid = `values.${e.name}_${k.suffix}`;
                await this.setObjectNotExistsAsync(kid, { type: 'state', common: k.common, native: {} });
                this.knoepfe.set(kid, { e, index: k.index });
            }
        }
    }

    /**
     * Sequenz von Handshake-Opcodes wie die App sie beim fresh-Reconnect
     * sendet:
     *   opcode 0x05 (LOGIN/SESSION-INIT)
     *   opcode 0x0c (LOGIN-ACK)
     *   opcode 0x35 (MODEL-QUERY)
     *   opcode 0x3c (URL-SYNC)
     *   opcode 0x02 (SYSTEM-INFO-QUERY)
     *   opcode 0x08 (SET_DETECTED_DEVICES - wird bewusst NICHT gesendet)
     * Body ist immer 1 Byte (CRC-8 des Frames).
     * Pro Frame ~300 ms Pause damit die Box jedes ACK-en kann.
     */
    async sendHandshake() {
        // Voll-Handshake mit App-exakten seq-Spruengen.
        // Die App startet bei
        // seq=0x02 (NICHT 0x01) und springt von 0x02 auf 0x05 nach LOGIN.
        // seq=0x01, 0x03, 0x04 werden niemals genutzt - vermutlich reserviert.
        const steps = [
            { op: 0x05, body: Buffer.from([0xec]), label: 'LOGIN', seq: 0x02 },
            { op: 0x0c, body: Buffer.from([0x81]), label: 'LOGIN-ACK', seq: 0x05 },
            { op: 0x35, body: Buffer.from([0x72]), label: 'MODEL-QUERY', seq: 0x06 },
            { op: 0x3c, body: Buffer.from([0xb6]), label: 'URL-SYNC', seq: 0x07 },
            { op: 0x02, body: Buffer.from([0xaa]), label: 'SYS-INFO', seq: 0x08 },
            // 0x08 ist SET_DETECTED_DEVICES, kein Abo: es
            // schreibt die Geraeteliste der Box. Eine falsche Liste wuerde
            // die der Box ueberschreiben. Deshalb nie senden.
        ];
        // Schreib-Counter beginnt nach Handshake bei 0x0a (wie App).
        this.seqCounter = 0x0a;
        for (const step of steps) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.log.warn(`Handshake aborted: WebSocket not open (at ${step.label})`);
                return;
            }
            try {
                const frame = protocol.encodeOpcodeFrame(step.seq, step.op, step.body, this.sharedSecret);
                this.ws.send(frame);
                this.log.debug(
                    `Handshake ${step.label} sent (seq=0x${step.seq.toString(16).padStart(2, '0')} op=0x${step.op.toString(16).padStart(2, '0')} ${frame.length}B)`,
                );
            } catch (e) {
                this.log.error(`Handshake ${step.label} failed: ${e.message}`);
                return;
            }
            await this.delay(350);
        }
        this.subscribed = true;
        this.log.info('Handshake complete, writing enabled.');
    }

    /**
     * onStateChange wird vom ioBroker-Core aufgerufen wenn ein State sich
     * aendert. Fuer eigene Writes ist `state.ack === false` charakteristisch
     * (User-/Skript-Befehl). Wir filtern hier alles andere weg.
     *
     * @param id state ID
     * @param state new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        } // eigener Echo nach erfolgreichem write -> ignorieren
        if (this.stopping) {
            return;
        }
        if (id.endsWith('.control.reboot')) {
            if (state.val) {
                await this.sendeReboot(id);
            }
            return;
        }
        const rel = id.slice(this.namespace.length + 1);

        // Knopf einer Aktion (z. B. values.LIGHT_SYSTEM_MEMORY_1_SAVE)
        const knopf = this.knoepfe.get(rel);
        if (knopf) {
            await this.setStateAsync(rel, { val: false, ack: true }).catch(() => {});
            if (!state.val) {
                return;
            }
            if (!werte.istSchreibbar(knopf.e, this.schreibCfg)) {
                this.log.warn(`${rel}: writing ${knopf.e.name} is not allowed.`);
                return;
            }
            this.planeSchreiben(knopf.e, knopf.index, [], `${knopf.e.name}=${knopf.e.categories[knopf.index]}`, false);
            return;
        }

        if (!rel.startsWith('values.')) {
            return;
        }
        const e = this.katalogNachName.get(rel.slice('values.'.length)) || null;
        if (!e || !werte.istSchreibbar(e, this.schreibCfg) || werte.istAktion(e)) {
            this.log.warn(`${rel}: writing is not allowed (setting "Write access" or own lists).`);
            await this.zurueckAufLetztenWert(rel, e);
            return;
        }
        this.planeSchreiben(e, werte.boxWert(e, state.val), [rel], `${e.name}=${state.val}`, true);
    }

    /**
     * Befehl pruefen und in die Warteschlange stellen. ids: States, die bis
     * zur Bestaetigung der Box auf ack=false stehen.
     *
     * @param e value table entry
     * @param roh raw value for the box
     * @param ids states waiting for the box
     * @param text description for the log
     * @param bestaetigen whether to wait for the box to confirm
     */
    planeSchreiben(e, roh, ids, text, bestaetigen) {
        let bytes;
        try {
            bytes = protocol.encodeCatalogValue(e, roh);
        } catch (err) {
            this.log.warn(`${text}: rejected - ${err.message}`);
            for (const id of ids) {
                this.zurueckAufLetztenWert(id, e);
            }
            return;
        }
        const ziel = e.typ === 'string' ? String(roh) : werte.zustandsWert(e, protocol.decodeCatalogValue(e, bytes));
        this.schreibQueue.push({ e, bytes, ids, text, bestaetigen, ziel });
        if (!this.schreibLaeuft) {
            this.arbeiteSchreibQueue().catch(err => this.log.warn(`Writing: ${err.message}`));
        }
    }

    async arbeiteSchreibQueue() {
        this.schreibLaeuft = true;
        try {
            while (this.schreibQueue.length && !this.stopping) {
                await this.sendeSchreiben(this.schreibQueue.shift());
                await this.delay(SCHREIB_ABSTAND_MS);
            }
        } finally {
            this.schreibLaeuft = false;
        }
    }

    async sendeSchreiben(a) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret || !this.subscribed) {
            this.log.warn(`${a.text}: no ready connection to the box - not sent.`);
            for (const id of a.ids) {
                await this.zurueckAufLetztenWert(id, a.e);
            }
            return;
        }
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeSetValueFrame(seq, a.e.id, a.bytes, this.sharedSecret));
        } catch (err) {
            this.log.error(`${a.text}: sending failed - ${err.message}`);
            for (const id of a.ids) {
                await this.zurueckAufLetztenWert(id, a.e);
            }
            return;
        }
        this.pendingWrites.set(seq, { art: 'SET', name: a.e.name, e: a.e, ts: Date.now() });
        this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
        if (a.bestaetigen) {
            const vorher = this.ausstehend.get(a.e.name);
            if (vorher) {
                this.clearTimeout(vorher.timer);
            }
            this.lastValues.delete(`val:${a.e.name}`);
            const ids = [...new Set([...(vorher ? vorher.ids : []), ...a.ids])];
            const timer = this.setTimeout(() => {
                this.zuruecknehmen(a.e.name, `no confirmation after ${BESTAETIGUNG_FRIST_MS / 1000} s`);
            }, BESTAETIGUNG_FRIST_MS);
            this.ausstehend.set(a.e.name, { ziel: a.ziel, ids, timer });
        }
        this.log.info(
            `WRITE -> ${a.text} (valueId ${a.e.id}, seq=0x${seq.toString(16).padStart(2, '0')}, data ${a.bytes.toString('hex')})`,
        );
    }

    /**
     * Einzelnen Wert bei der Box abfragen (GET_DEVICE_VALUE_FOR_VALUEID).
     *
     * @param e value table entry
     */
    frageWert(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) {
            return;
        }
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeGetValueFrame(seq, e.id, this.sharedSecret));
            this.pendingWrites.set(seq, { art: 'GET', name: `GET ${e.name}`, ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
        } catch (err) {
            this.log.debug(`Query ${e.name}: ${err.message}`);
        }
    }

    /**
     * true, wenn ein Befehl aussteht und die Box (noch) etwas anderes meldet.
     *
     * @param e value table entry
     * @param wert value
     */
    wartetAufBox(e, wert) {
        const offen = this.ausstehend.get(e.name);
        if (!offen || offen.ziel === undefined || offen.ziel === wert) {
            return false;
        }
        offen.letzterBoxWert = wert;
        this.lastValues.set(`val:${e.name}`, wert);
        if (!offen.nachgefragt) {
            offen.nachgefragt = true;
            this.setTimeout(() => this.frageWert(e), 3_000);
        }
        return true;
    }

    /**
     * Die Box hat einen Wert gemeldet: ausstehendes Schreiben abschliessen.
     *
     * @param e value table entry
     * @param wert value
     */
    bestaetige(e, wert) {
        const offen = this.ausstehend.get(e.name);
        if (!offen) {
            return;
        }
        this.clearTimeout(offen.timer);
        this.ausstehend.delete(e.name);
        this.log.info(`${e.name}: box confirmed ${wert}`);
        // Weitere betroffene States auf den Wert der Box.
        for (const id of offen.ids) {
            if (id === `values.${e.name}`) {
                continue;
            }
            this.setStateAsync(id, { val: wert, ack: true }).catch(() => {});
        }
    }

    /**
     * Schreiben gescheitert: betroffene States auf den letzten Wert der Box.
     *
     * @param name name of the value
     * @param grund reason for the log
     */
    async zuruecknehmen(name, grund) {
        const offen = this.ausstehend.get(name);
        if (!offen) {
            return;
        }
        this.clearTimeout(offen.timer);
        this.ausstehend.delete(name);
        if (offen.letzterBoxWert !== undefined) {
            this.log.warn(`${name}: box reports ${offen.letzterBoxWert} instead of ${offen.ziel} - taken over`);
            const id = `values.${name}`;
            await this.setStateAsync(id, { val: offen.letzterBoxWert, ack: true }).catch(() => {});
        } else {
            this.log.warn(`${name}: ${grund} - back to the last value of the box`);
        }
        const e = this.katalogNachName.get(name);
        for (const id of offen.ids) {
            await this.zurueckAufLetztenWert(id, e);
        }
    }

    async zurueckAufLetztenWert(id, e) {
        try {
            let wert = e && this.lastValues.has(`val:${e.name}`) ? this.lastValues.get(`val:${e.name}`) : undefined;
            if (wert === undefined) {
                const st = await this.getStateAsync(id);
                if (!st) {
                    return;
                }
                wert = st.val;
            }
            await this.setStateAsync(id, { val: wert, ack: true });
        } catch {
            /* ignorieren */
        }
    }

    /**
     * Werte einer Push-Meldung direkt nach values.* (Liste wie im Gesamtstand).
     *
     * @param plain decrypted push message
     */
    async applyPushWerte(plain) {
        if (!this.valueCatalog) {
            return;
        }
        const antwort = protocol.decodeResponse(plain);
        const liste = antwort && protocol.parseValueList(antwort.payload);
        if (!liste || !liste.length) {
            return;
        }
        // Nur wenn jeder Eintrag bekannt ist - sonst ist es keine Werteliste.
        const katalog = this.valueCatalog;
        if (!liste.every(t => katalog.has(parseInt(t.idHex.slice(0, 4), 16)))) {
            return;
        }
        await this.applyValueEntries(liste);
    }

    /**
     * Neustart der Box wie „MACH neu starten" in der App: SYSTEM_RESET
     * (opcode 0x09, leerer Body) in der laufenden Session. Kommt nur an,
     * solange die Box noch antwortet - gegen einen Komplett-Haenger hilft
     * er nicht. Die WebSocket-Session zum Backend ueberlebt den Neustart.
     *
     * @param id state ID
     */
    async sendeReboot(id) {
        await this.setStateAsync(id, { val: false, ack: true }).catch(() => {});
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) {
            this.log.error('Restart: no open connection to the box.');
            return;
        }
        if (!this.subscribed) {
            this.log.error('Restart: handshake not finished yet - the box would reject it.');
            return;
        }
        const seit = Date.now() - this.letzterReboot;
        if (seit < REBOOT_MIN_ABSTAND_MS) {
            this.log.warn(`Restart refused: the last one was only ${Math.round(seit / 1000)} s ago.`);
            return;
        }
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeSystemResetFrame(seq, this.sharedSecret));
            this.letzterReboot = Date.now();
            this.pendingWrites.set(seq, { id, oldValue: false, name: 'REBOOT', ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
            this.log.info(`REBOOT -> SYSTEM_RESET sent (seq=0x${seq.toString(16).padStart(2, '0')})`);
        } catch (e) {
            this.log.error(`Restart failed: ${e.message}`);
        }
    }

    cleanupWebSocket() {
        if (this.heartbeatTimer) {
            this.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.statsTimer) {
            this.clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        if (this.getAllTimer) {
            this.clearInterval(this.getAllTimer);
            this.getAllTimer = null;
        }
        if (this.getAllNachPushTimer) {
            this.clearTimeout(this.getAllNachPushTimer);
            this.getAllNachPushTimer = null;
        }
        this.l0Teile = [];
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
            } catch {
                // ignore
            }
            try {
                this.ws.close(1000, 'cleanup');
            } catch {
                // ignore
            }
            try {
                this.ws.terminate();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    scheduleReconnect() {
        if (this.stopping || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = this.setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopping) {
                this.connect();
            }
        }, RECONNECT_DELAY_MS);
    }

    onUnload(callback) {
        try {
            this.stopping = true;
            this.cleanupWebSocket();
            if (this.reconnectTimer) {
                this.clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Mach(options);
} else {
    new Mach();
}
