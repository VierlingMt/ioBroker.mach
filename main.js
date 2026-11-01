'use strict';

const utils = require('@iobroker/adapter-core');
const WebSocket = require('ws');

const protocol = require('./lib/protocol');
const { FRAME_NAMES, TLV_NAMES, WRITE_NAMES } = require('./lib/mappings');
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
 */
function passendeRolle(role, type, writable) {
    if (!writable) {
        if (role.startsWith('switch')) return type === 'boolean' ? 'indicator' : 'value';
        if (role === 'level.temperature') return 'value.temperature';
        if (role.startsWith('level')) return 'value';
    }
    if (role.startsWith('indicator') && type !== 'boolean') return 'value';
    return role;
}

const ORDNER_NAMEN = {
    values: 'Values of the box (named like in the app)',
    tlv: 'Raw values not named yet',
    frames: 'Raw push messages not named yet',
};

const VERTRAULICH = new Set([
    'SYSTEM_BLE_PIN', 'SYSTEM_BLE_PIN_DEFAULT',
    'LTE_EMBEDDED_SIM_ICCID', 'LTE_INSERTED_SIM_ICCID', 'LTE_SIM_ID_VALUE', 'LTE_MODEM_IMEI',
]);
// Ablage der Server-Wertetabelle zur Analyse (ioBroker-Dateispeicher).
const ABLAGE_ADAPTER = '0_userdata.0';

class Mach extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'mach',
        });

        this.ws = null;
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.stopping = false;
        this.sharedSecret = null;
        this.lastValues = new Map();
        this.ensuredObjects = new Set();
        this.seqCounter = 1;          // C->S Schreib-Counter, resettet bei Reconnect
        this.pendingWrites = new Map(); // seq -> {id, oldValue, name, ts} fuer NACK-Rollback
        this.letzterReboot = 0;
        this.getAllTimer = null;
        this.getAllNachPushTimer = null;
        this.letzterGetAll = 0;
        this.valueCatalog = null;       // Map<valueId, {name, typ, ...}> aus get-drivers-json
        this.katalogNachName = new Map(); // Name -> Eintrag der Wertetabelle
        this.schreibCfg = { stufe: 'bedienung', freigaben: [], sperren: [] };
        this.schreibQueue = [];
        this.schreibLaeuft = false;
        this.ausstehend = new Map();    // Name -> {ziel, ids, timer} bis die Box den Wert meldet
        this.knoepfe = new Map();       // values.<NAME>_<AKTION> -> {e, index}
        this.werteDefiniert = new Map(); // values.<NAME> -> JSON der zuletzt gesetzten Definition
        this.l0Teile = [];             // Teilstuecke einer mehrteiligen L0-Nachricht

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', { val: false, ack: true });

        // Ordner auch fuer States aus aelteren Versionen anlegen, die keine
        // Werte mehr bekommen (z. B. frames.*) - sonst fehlen sie dauerhaft.
        try {
            const objekte = await this.getAdapterObjectsAsync();
            for (const [id, obj] of Object.entries(objekte)) {
                if (obj && obj.type === 'state') await this._ensureParents(id.slice(this.namespace.length + 1));
            }
        } catch (e) {
            this.log.warn(`Ordner fuer vorhandene States nicht angelegt: ${e.message}`);
        }

        const { username, password, machId } = this.config;
        if (!username || !password || !machId) {
            this.log.error('Konfiguration unvollstaendig: bitte username, password und machId in der Adapter-Konfiguration eintragen.');
            return;
        }

        const stufe = werte.STUFEN.includes(this.config.schreiben) ? this.config.schreiben : 'bedienung';
        this.schreibCfg = {
            stufe,
            freigaben: werte.eigeneListe(this.config.eigeneFreigaben),
            sperren: werte.eigeneListe(this.config.eigeneSperren),
        };
        this.log.info(`Schreibzugriff: ${stufe}${this.config.eigeneFreigaben ? `, eigene Freigaben: ${this.config.eigeneFreigaben}` : ''}${this.config.eigeneSperren ? `, eigene Sperren: ${this.config.eigeneSperren}` : ''}`);

        this.subscribeStates('*');
        // machId und Benutzer nur gekuerzt: Logs landen oft in Foren.
        this.log.info(`mach adapter ready – machId=${String(machId).slice(0, 4)}…, user=${String(username).replace(/^(.).*@/, '$1…@')}`);
        await this.precreateKnownStates();
        await this.setObjectNotExistsAsync('control', {
            type: 'channel', common: { name: 'Steuerung' }, native: {},
        });
        await this.setObjectNotExistsAsync('control.reboot', {
            type: 'state',
            common: {
                name: 'MACH-Box neu starten (wie in der App)',
                type: 'boolean', role: 'button', read: false, write: true, def: false,
            },
            native: {},
        });
        this.connect();
    }

    /**
     * Bekannte States schon beim Start anlegen (statt erst beim ersten
     * Frame-Empfang). Damit sind schreibbare States wie Heizung_Schalter
     * und Heizung_Sollwert sofort im Object-Browser sichtbar und nutzbar,
     * auch wenn die Box den Wert seit dem letzten Power-Cycle noch nie
     * gepusht hat.
     *
     * Setzt zusaetzlich Default-Werte (boolean -> false, number -> null,
     * string -> '') falls der State noch nie einen Wert hatte. Damit
     * stolpern Konsumenten (z.B. Monitoring-Skripte) nicht ueber undefined.
     * Quality-Bit q=0x40 markiert "default value, kein echter Wert".
     */
    async precreateKnownStates() {
        let count = 0;

        // Bekannte Frames (FRAME_NAMES)
        for (const frame of Object.values(FRAME_NAMES)) {
            if (!frame || !frame.name) continue;
            if (typeof frame.decode === 'function') {
                // Meta aus dummy-decode(0) extrahieren
                try {
                    const sample = frame.decode(0);
                    const idRel = `named.${frame.name}`;
                    const isWritable = !!WRITE_NAMES[frame.name];
                    await this._ensureObject(idRel, sample, isWritable);
                    count++;
                } catch (_e) { /* decoder mag 0 nicht? - skip */ }
            } else {
                // Frames ohne Decoder: B0/B1 als rohe Zahlen anlegen
                for (const suffix of ['_B0', '_B1']) {
                    const idRel = `named.${frame.name}${suffix}`;
                    await this._ensureObject(idRel, { type: 'number', role: 'value' });
                    count++;
                }
            }
        }

        // Bekannte TLVs (TLV_NAMES)
        for (const tlv of Object.values(TLV_NAMES)) {
            if (!tlv || !tlv.name) continue;
            const idRel = `named.${tlv.name}`;
            await this._ensureObject(idRel, tlv.meta || { type: 'number', role: 'value' });
            count++;
        }

        this.log.info(`Bekannte States vorab angelegt: ${count}`);
    }

    /**
     * Object anlegen (falls noch nicht da). State-Wert NICHT setzen -
     * das passiert beim ersten Frame-Empfang via _upsert. Trennt
     * Object-Definition von State-Wert.
     */
    /**
     * Ordner ueber einem State anlegen: ioBroker verlangt fuer jeden
     * Pfadabschnitt ein eigenes Objekt (values, tlv.<id>, frames.<id> ...).
     */
    async _ensureParents(idRel) {
        const teile = idRel.split('.');
        for (let i = 1; i < teile.length; i++) {
            const id = teile.slice(0, i).join('.');
            if (this.ensuredObjects.has(id)) continue;
            await this.setObjectNotExistsAsync(id, {
                type: i === 1 ? 'folder' : 'channel',
                common: { name: ORDNER_NAMEN[id] || id },
                native: {},
            });
            this.ensuredObjects.add(id);
        }
    }

    async _ensureObject(idRel, meta, isWritable = false) {
        if (this.ensuredObjects.has(idRel)) return;
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
                if (meta.type === 'boolean') defaultVal = false;
                else if (meta.type === 'string') defaultVal = '';
                // q=0x40 = "default value" (kein echter Wert)
                await this.setStateAsync(idRel, { val: defaultVal, ack: true, q: 0x40 });
            }
        } catch (_e) { /* ignore */ }
        this.ensuredObjects.add(idRel);
    }

    async connect() {
        if (this.stopping) return;
        const { username, password, machId } = this.config;
        try {
            this.log.debug('HTTP-Auth-Flow startet ...');
            const auth = await protocol.authFlow(username, password, machId, this.log);
            this.sharedSecret = auth.sharedSecret;
            this.lastAuth = auth;
            this.runHmacSelfTest();
            await this.ladeWerteTabelle(auth);
            this.log.info(`Auth OK, device="${auth.deviceName}", sharedSecret-len=${auth.sharedSecret.length}B`);
            this.openWebSocket(auth.wsUrl, auth.wsToken, machId, auth.sharedAgent);
        } catch (e) {
            this.log.error(`Auth fehlgeschlagen: ${e.message}`);
            this.scheduleReconnect();
        }
    }

    openWebSocket(wsUrl, wsToken, machId, sharedAgent) {
        if (this.stopping) return;
        this.log.info(`WS connecting to: ${wsUrl} (agent-shared=${!!sharedAgent})`);

        // Header wie die App: nur token + id, kein User-Agent.
        // sharedAgent: derselbe https.Agent wie die HTTP-Auth-Calls, damit
        // der WS-Upgrade ggf. den TCP-Socket der vorigen Calls weiterverwendet
        // (App nutzt EIN OkHttp-Client - gleicher Connection-Pool).
        this.ws = new WebSocket(wsUrl, {
            headers: {
                token: wsToken,
                id: machId,
            },
            perMessageDeflate: true,
            agent: sharedAgent,
        });

        this.ws.on('open', () => {
            if (this.stopping) { try { this.ws.terminate(); } catch (_) {} return; }
            this.log.info('WebSocket open');
            this.seqCounter = 1;   // bei jedem (Re-)connect zuruecksetzen
            this.subscribed = false;
            this.setStateAsync('info.connection', { val: true, ack: true }).catch(() => {});
            try { this.ws.send('GET_SYSTEM_CONNECTED'); } catch (_) {}

            // Handshake wie die App beim Kaltstart (nur lesende Opcodes, siehe
            // sendHandshake), danach Gesamtstand holen und regelmaessig wieder.
            this.sendHandshake().then(() => {
                this.requestAllValues('Verbindungsaufbau');
                if (this.getAllTimer) this.clearInterval(this.getAllTimer);
                this.getAllTimer = this.setInterval(() => this.requestAllValues('Intervall'), GET_ALL_INTERVAL_MS);
            }).catch(e => {
                this.log.error(`Handshake error: ${e.message}`);
            });
            this.heartbeatTimer = this.setInterval(() => {
                if (this.stopping) return;
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    try { this.ws.send('GET_SYSTEM_CONNECTED'); } catch (_) {}
                }
            }, HEARTBEAT_INTERVAL_MS);
        });

        // Diagnose-Counter (v0.1.1)
        this.msgStats = {
            binaryTotal: 0,
            textTotal: 0,
            decryptFail: 0,
            decodeFail: 0,
            framesByOuter: new Map(),
        };

        this.ws.on('message', async (data, isBinary) => {
            if (this.stopping) return;
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
                    if (teil.teil === 1) this.l0Teile = [];
                    this.l0Teile.push(teil.daten);
                    if (teil.teil < teil.von) return;
                    if (this.l0Teile.length !== teil.von) {
                        this.log.warn(`L0: ${this.l0Teile.length} von ${teil.von} Teilen erhalten - Nachricht verworfen.`);
                        this.l0Teile = [];
                        return;
                    }
                    buf = Buffer.concat([Buffer.from([0x00, 0x01, 0x01]), ...this.l0Teile, Buffer.from([0xff])]);
                    this.l0Teile = [];
                }
                if (this.msgStats.binaryTotal === 1) {
                    this.log.info(`first binary message received: ${buf.length}B, prefix=${buf.slice(0, 8).toString('hex')}`);
                }
                // L1-Kurzantwort (11 Byte): 00 01 01 [01 len:2 msgId status crc FE] FF.
                // Status: 0 = OK, 3 = INCORRECT_CRC usw. Kommt
                // nur bei Fehlern auf L1-Ebene; Erfolg liefert eine L2-Antwort.
                if (buf.length < 32 && buf.length >= 9 && buf[0] === 0x00 && buf[1] === 0x01) {
                    const seqEcho = buf[6] !== undefined ? buf[6] : -1;
                    const statusByte = buf[7] !== undefined ? buf[7] : -1;
                    const name = protocol.statusName(protocol.L1_STATUS, statusByte);
                    this.log.info(`Box L1-Antwort: msgId=0x${seqEcho.toString(16).padStart(2,'0')} status=${name} hex=${buf.toString('hex')}`);
                    await this.beendeAusstehend(seqEcho, statusByte === 0, `L1 ${name}`);
                    return;
                }
                const plain = protocol.decryptFrame(buf, this.sharedSecret);
                if (!plain) {
                    this.msgStats.decryptFail++;
                    if (this.msgStats.decryptFail <= 3) {
                        this.log.warn(`decrypt FAIL #${this.msgStats.decryptFail} for ${buf.length}B frame, prefix=${buf.slice(0, 8).toString('hex')}`);
                    }
                    return;
                }
                // Antwort auf ein eigenes Kommando (msgId = unsere seq); Push-
                // Meldungen tragen msgId 0xFF.
                if (plain[2] !== 0xFF) {
                    await this.verarbeiteAntwort(protocol.decodeResponse(plain));
                    return;
                }
                const decoded = protocol.decodeFrame(plain);
                if (!decoded) {
                    this.msgStats.decodeFail++;
                    if (this.msgStats.decodeFail <= 3) {
                        this.log.warn(`decode FAIL #${this.msgStats.decodeFail}, plaintext-prefix=${plain.slice(0, 8).toString('hex')}`);
                    }
                    return;
                }
                const cnt = (this.msgStats.framesByOuter.get(decoded.outerIdHex) || 0) + 1;
                this.msgStats.framesByOuter.set(decoded.outerIdHex, cnt);
                if (cnt === 1) {
                    this.log.info(`first frame outer=${decoded.outerIdHex} format=${decoded.format}`);
                }
                // info.lastFrameAt fuer Staleness-Tracking
                this.setStateAsync('info.lastFrameAt', { val: Date.now(), ack: true }).catch(() => {});
                await this.applyDecodedFrame(decoded);
                await this.applyPushWerte(plain);
                this.getAllNachPush();
            } catch (e) {
                if (!this.stopping) this.log.warn(`WS msg error: ${e.message}`);
            }
        });

        // Periodische Diagnose-Zusammenfassung. Default 5 min auf debug-level
        // (sonst flutet das den iobroker-Log nach Tagen Laufzeit).
        // Bei loglevel=debug werden alle 30 s detaillierte Stats geloggt.
        this.statsTimer = this.setInterval(() => {
            if (this.stopping) return;
            const s = this.msgStats;
            const knownOuters = [...s.framesByOuter.keys()].filter(k => FRAME_NAMES[k]).length;
            const unknownOuters = s.framesByOuter.size - knownOuters;
            // Top-5 outer-ids by count
            const top = [...s.framesByOuter.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([k, v]) => {
                    const meta = FRAME_NAMES[k];
                    return `${k}(${v}${meta ? '/' + meta.name : '/?'})`;
                })
                .join(' ');
            this.log.debug(`stats: binary=${s.binaryTotal} text=${s.textTotal} decryptFail=${s.decryptFail} decodeFail=${s.decodeFail} unique-outer-ids=${s.framesByOuter.size} (known=${knownOuters} unknown=${unknownOuters}) top: ${top}`);
        }, 30_000);

        this.ws.on('close', (code) => {
            if (this.stopping) return;
            this.log.warn(`WebSocket close ${code}`);
            this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
            this.cleanupWebSocket();
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            if (!this.stopping) this.log.error(`WebSocket error: ${err.message}`);
        });
    }

    async applyDecodedFrame(decoded) {
        const frameMeta = FRAME_NAMES[decoded.outerIdHex];

        // ---- outerVal verarbeiten (Multi-TLV-Frames haben outerVal vor den TLVs)
        // Wichtig fuer z.B. Heizung_Schalter: outerVal[0] = 0/1, dahinter Multi-TLV.
        // Ohne diesen Block wuerde der frameMeta-Decode nur bei C_raw aufgerufen,
        // und Multi-TLV-Varianten desselben Wires wuerden den State nie aendern.
        if (decoded.outerValBytes) {
            const b0 = decoded.outerValBytes[0];
            const b1 = decoded.outerValBytes.length > 1 ? decoded.outerValBytes[1] : 0;
            const prev = this.lastValues.get(`outer:${decoded.outerIdHex}`);
            const nowVal = (b0 << 8) | b1;
            const changed = (prev !== nowVal);
            if (changed) {
                this.lastValues.set(`outer:${decoded.outerIdHex}`, nowVal);
            }

            if (frameMeta) {
                if (changed) {
                    if (frameMeta.decode) {
                        const result = frameMeta.decode(b0);
                        await this.upsertNamed(frameMeta.name, result.value, {
                            type: result.type || 'number',
                            role: result.role || 'value',
                            unit: result.unit || '',
                        });
                        this.log.debug(`Δ ${frameMeta.name} = ${result.label} (via outerVal)`);

                        // v0.1.4: Hardcode-Fix - Box pusht beim Heizung-Einschalten
                        // den Sollwert nicht neu, intern resettet er aber auf 5°C
                        // (Aldé-Frostschutz). Wir spiegeln das hier:
                        if (decoded.outerIdHex === '3d800e01' && result.value === true) {
                            await this.upsertNamed('Heizung_Sollwert', 5, {
                                type: 'number',
                                role: 'level.temperature',
                                unit: '°C',
                            });
                            this.log.info('Heizung_Schalter -> AN: Heizung_Sollwert auto-reset auf 5°C (Frostschutz-Default)');
                        }
                    } else {
                        await this.upsertNamed(`${frameMeta.name}_B0`, b0, { type: 'number', role: 'value' });
                        if (decoded.outerValBytes.length > 1) {
                            await this.upsertNamed(`${frameMeta.name}_B1`, b1, { type: 'number', role: 'value' });
                        }
                    }
                }
            } else if (changed) {
                // v0.1.4: Auch unbekannte Multi-TLV-Frames bekommen outerVal
                // exposed -> bei AC, Wasser-Pumpe etc. sieht der User wenigstens
                // den outerVal[0] als On/Off-Aequivalent in frames.<id>.outerVal_*
                const fid = `frames.${decoded.outerIdHex}`;
                await this.upsertGeneric(`${fid}.outerVal_b0`, b0,
                    { type: 'number', role: 'value', name: `${decoded.outerIdHex} outerVal B0` });
                if (decoded.outerValBytes.length > 1) {
                    await this.upsertGeneric(`${fid}.outerVal_b1`, b1,
                        { type: 'number', role: 'value', name: `${decoded.outerIdHex} outerVal B1` });
                }
                await this.upsertGeneric(`${fid}.outerVal_hex`, decoded.outerValBytes.toString('hex'),
                    { type: 'string', role: 'text', name: `${decoded.outerIdHex} outerVal hex` });
            }
        }

        // ---- Multi-TLV Frames (Format A / B) ----
        if (decoded.tlvs) {
            for (const tlv of decoded.tlvs) {
                const valNum = protocol.bytesAsNumber(tlv.valBytes);
                const map = TLV_NAMES[tlv.idHex];
                if (map) {
                    // Bekannter TLV -> named.<symbol>
                    const transformed = map.transform(valNum);
                    await this.upsertNamed(map.name, transformed, map.meta || { type: 'number', role: 'value' });
                    const prev = this.lastValues.get(`tlv:${tlv.idHex}`);
                    if (prev !== valNum) {
                        this.lastValues.set(`tlv:${tlv.idHex}`, valNum);
                        this.log.debug(`Δ ${map.name} = ${transformed}`);
                    }
                } else {
                    // Unbekannter TLV -> tlv.<id>_t<type>.{raw,hex} (Discovery)
                    const tlvId = `tlv.${tlv.idHex}_t${tlv.type.toString(16).padStart(2, '0')}`;
                    await this.upsertGeneric(`${tlvId}.raw`, valNum,
                        { type: 'number', role: 'value', name: `TLV ${tlv.idHex} raw` });
                    await this.upsertGeneric(`${tlvId}.hex`, tlv.valBytes.toString('hex'),
                        { type: 'string', role: 'text', name: `TLV ${tlv.idHex} hex` });
                }
            }

            // Abgeleitete Werte: LTE-Volumen-Aggregate
            const remaining = decoded.tlvs.find(t => t.idHex === '009d0046');
            const used      = decoded.tlvs.find(t => t.idHex === '009e0046');
            if (remaining && used) {
                const r = protocol.bytesAsNumber(remaining.valBytes);
                const u = protocol.bytesAsNumber(used.valBytes);
                const total = r + u;
                await this.upsertNamed('LTE_Remaining_MB', +(r / 1024 / 1024).toFixed(2),
                    { type: 'number', role: 'value', unit: 'MB' });
                await this.upsertNamed('LTE_Used_MB',      +(u / 1024 / 1024).toFixed(2),
                    { type: 'number', role: 'value', unit: 'MB' });
                await this.upsertNamed('LTE_Total_MB',     +(total / 1024 / 1024).toFixed(2),
                    { type: 'number', role: 'value', unit: 'MB' });
                if (total > 0) {
                    await this.upsertNamed('LTE_Used_Percent', +(u * 100 / total).toFixed(1),
                        { type: 'number', role: 'value', unit: '%' });
                }
            }
        }

        // ---- Format C (Switch/Sensor) ----
        if (decoded.format === 'C_raw' && decoded.rawBytes) {
            const b0 = decoded.rawBytes[0];
            const b1 = decoded.rawBytes.length > 1 ? decoded.rawBytes[1] : 0;
            const prev = this.lastValues.get(`frame:${decoded.outerIdHex}`);
            const nowVal = (b0 << 8) | b1;
            if (prev === nowVal) return;
            this.lastValues.set(`frame:${decoded.outerIdHex}`, nowVal);

            if (frameMeta && frameMeta.decode) {
                // Bekannter Frame mit Decoder -> named.<symbol> = decoded value
                const result = frameMeta.decode(b0);
                await this.upsertNamed(frameMeta.name, result.value, {
                    type: result.type || 'number',
                    role: result.role || 'value',
                    unit: result.unit || '',
                });
                this.log.debug(`Δ ${frameMeta.name} = ${result.label}`);
            } else if (frameMeta) {
                // Bekannter Frame ohne Decoder -> raw B0/B1 unter named.<symbol>_*
                await this.upsertNamed(`${frameMeta.name}_B0`, b0,
                    { type: 'number', role: 'value' });
                await this.upsertNamed(`${frameMeta.name}_B1`, b1,
                    { type: 'number', role: 'value' });
            } else {
                // Unbekannter Frame -> frames.<outerId>.* (Discovery)
                const fid = `frames.${decoded.outerIdHex}`;
                await this.upsertGeneric(`${fid}.b0`, b0,
                    { type: 'number', role: 'value', name: `${decoded.outerIdHex} B0` });
                await this.upsertGeneric(`${fid}.b1`, b1,
                    { type: 'number', role: 'value', name: `${decoded.outerIdHex} B1` });
                await this.upsertGeneric(`${fid}.hex`, decoded.rawHex || '',
                    { type: 'string', role: 'text', name: `${decoded.outerIdHex} raw hex` });
            }
        }
    }

    /**
     * State unter `named.<name>` setzen, beim ersten Mal Object anlegen.
     */
    async upsertNamed(name, value, meta) {
        const id = `named.${name}`;
        await this._upsert(id, value, { ...meta, name });
    }

    /**
     * Generisches upsert fuer beliebige Pfade unterhalb der Instanz
     * (z.B. tlv.* oder frames.* fuer Discovery-States).
     */
    async upsertGeneric(idRel, value, meta) {
        await this._upsert(idRel, value, meta);
    }

    async _upsert(idRel, value, meta) {
        if (!this.ensuredObjects.has(idRel)) {
            // named.<X> ist writable wenn X in WRITE_NAMES steht
            const namedMatch = idRel.match(/^named\.(.+)$/);
            const isWritable = !!(namedMatch && WRITE_NAMES[namedMatch[1]]);
            await this._ensureObject(idRel, meta, isWritable);
            this.log.info(`new state: ${idRel} = ${value}${meta.unit ? ' ' + meta.unit : ''}${isWritable ? ' [writable]' : ''}`);
        }
        await this.setStateAsync(idRel, { val: value, ack: true });
    }

    /**
     * Selbsttest der Pruefsummen. Ein HMAC-Test braeuchte Werte einer
     * bestimmten Box (ihr Schluessel) und ist deshalb nicht hier.
     */
    runHmacSelfTest() {
        if (!protocol.l1CrcSelfTest()) {
            this.log.warn('L1-CRC-Selbsttest FAIL - die Box wuerde jedes Kommando mit INCORRECT_CRC ablehnen.');
        }
    }

    /** Naechste Nachrichten-ID: 0x00 und 0xFF (Push) auslassen. */
    nextSeq() {
        let seq = this.seqCounter & 0xff;
        if (seq === 0x00 || seq === 0xff) seq = 0x01;
        this.seqCounter = seq + 1;
        return seq;
    }

    /**
     * Wertetabelle der App aus get-drivers-json + getConfig. Ohne sie gibt
     * es keine values.*-States; unbekannte Eintraege landen dann roh unter
     * tlv.*. Die Rohantworten gehen zur Analyse in den Dateispeicher.
     */
    async ladeWerteTabelle(auth) {
        try {
            this.valueCatalog = protocol.buildValueCatalog(auth.driversResponse, auth.configResponse);
        } catch (e) {
            this.valueCatalog = null;
            this.log.warn(`Wertetabelle nicht lesbar: ${e.message}`);
        }
        this.katalogNachName = new Map();
        if (this.valueCatalog) {
            for (const e of this.valueCatalog.values()) this.katalogNachName.set(e.name, e);
            this.log.info(`Wertetabelle: ${this.valueCatalog.size} Werte bekannt (get-drivers-json)`);
        } else {
            const felder = auth.driversResponse && typeof auth.driversResponse === 'object'
                ? Object.keys(auth.driversResponse).join(', ') : typeof auth.driversResponse;
            this.log.warn(`Wertetabelle fehlt in get-drivers-json (Felder: ${felder}) - nur Rohwerte unter tlv.*`);
        }
        for (const [datei, inhalt] of [['drivers.json', auth.driversResponse], ['config.json', auth.configResponse]]) {
            if (inhalt == null) continue;
            try {
                await this.writeFileAsync(ABLAGE_ADAPTER, `mach/${datei}`, JSON.stringify(inhalt, null, 1));
            } catch (e) {
                this.log.debug(`Ablage ${datei} fehlgeschlagen: ${e.message}`);
            }
        }
    }

    /** Nach einer Push-Meldung den Gesamtstand nachziehen (entprellt). */
    getAllNachPush() {
        if (this.getAllNachPushTimer) return;
        const warte = Math.max(GET_ALL_NACH_PUSH_MS, this.letzterGetAll + GET_ALL_MIN_ABSTAND_MS - Date.now());
        this.getAllNachPushTimer = this.setTimeout(() => {
            this.getAllNachPushTimer = null;
            this.requestAllValues('nach Push');
        }, warte);
    }

    /** Gesamtstand anfordern (GET_ALL_DEVICE_VALUES, opcode 0x05). */
    requestAllValues(anlass) {
        if (this.stopping || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) return;
        this.letzterGetAll = Date.now();
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeGetAllValuesFrame(seq, this.sharedSecret));
            this.pendingWrites.set(seq, { id: null, oldValue: null, name: 'GET_ALL', ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 15_000);
            this.log.debug(`GET_ALL_DEVICE_VALUES gesendet (${anlass}, seq=0x${seq.toString(16).padStart(2, '0')})`);
        } catch (e) {
            this.log.warn(`GET_ALL_DEVICE_VALUES nicht gesendet: ${e.message}`);
        }
    }

    /** L2-Antwort auf ein eigenes Kommando auswerten. */
    async verarbeiteAntwort(antwort) {
        if (!antwort) return;
        const ok = antwort.status === 0;
        const name = protocol.statusName(protocol.L2_STATUS, antwort.status);
        if (antwort.opcode === 0x05 && ok) {
            await this.applyAllValues(antwort.payload);
        } else if (antwort.opcode === 0x06 && ok) {
            const liste = protocol.parseValueList(antwort.payload);
            if (liste) await this.applyValueEntries(liste, { legacy: true });
        } else {
            this.log.debug(`Box L2-Antwort: msgId=0x${antwort.msgId.toString(16)} opcode=0x${antwort.opcode.toString(16)} status=${name}`);
        }
        await this.beendeAusstehend(antwort.msgId, ok, `L2 ${name}`);
    }

    /** Ausstehendes Kommando abschliessen; bei Fehler einen Schreibwert zuruecknehmen. */
    async beendeAusstehend(seq, ok, grund) {
        const pending = this.pendingWrites.get(seq);
        if (!pending) return;
        this.pendingWrites.delete(seq);
        if (pending.art === 'GET') return;
        if (pending.art === 'SET') {
            if (ok) {
                this.log.info(`${pending.name}: Box OK (seq=0x${seq.toString(16).padStart(2, '0')})`);
                // Gleich nachfragen, statt auf Push oder Gesamtstand zu warten.
                if (pending.e) this.setTimeout(() => this.frageWert(pending.e), NACHFRAGE_NACH_MS);
            } else {
                this.log.warn(`${pending.name}: Box lehnt ab (${grund})`);
                await this.zuruecknehmen(pending.name, `Box lehnt ab (${grund})`);
            }
            return;
        }
        if (ok) {
            this.log.info(`${pending.name}: Box OK (seq=0x${seq.toString(16).padStart(2, '0')})`);
            return;
        }
        this.log.warn(`${pending.name}: Box lehnt ab (${grund})`);
        if (pending.id && pending.name !== 'REBOOT') {
            try {
                await this.setStateAsync(pending.id, { val: pending.oldValue, ack: true });
            } catch (_) {}
        }
    }

    /**
     * Gesamtstand der Box (Antwort auf GET_ALL_DEVICE_VALUES). Jeder Eintrag
     * ist derselbe [valueId][type][len][wert] wie in einer Push-Meldung und
     * laeuft deshalb ueber dieselbe Zuordnung (FRAME_NAMES / TLV_NAMES).
     */
    async applyAllValues(payload) {
        const eintraege = protocol.parseValueList(payload);
        if (!eintraege) {
            this.log.warn(`GET_ALL-Antwort nicht lesbar (${payload.length} B): ${payload.subarray(0, 32).toString('hex')}...`);
            return;
        }
        const { benannt, roh } = await this.applyValueEntries(eintraege, { legacy: true });
        await this.setStateAsync('info.lastAllValuesAt', { val: Date.now(), ack: true }).catch(() => {});
        this.log.info(`Gesamtstand von der Box: ${eintraege.length} Werte (${benannt} benannt, ${roh} roh)`);
    }

    /**
     * Eintraege einer Werteliste (Gesamtstand, Einzelabfrage oder Push)
     * uebernehmen: bekannte Werte nach values.<NAME>, unbekannte roh nach
     * tlv.*. legacy: zusaetzlich die alten named.*-States fuehren (bei Push
     * erledigt das schon applyDecodedFrame).
     */
    async applyValueEntries(eintraege, { legacy }) {
        let benannt = 0, roh = 0;
        for (const tlv of eintraege) {
            if (tlv.valBytes.length === 0) continue;
            // Bisherige named.*-States weiterfuehren (Skripte haengen daran).
            const frame = protocol.valueEntryAsFrame(tlv);
            if (legacy && tlv.valBytes.length <= 8 && FRAME_NAMES[frame.outerIdHex]) await this.applyDecodedFrame(frame);
            // Jeder Wert genau einmal: bekannt -> values.<NAME>, sonst roh tlv.*.
            const eintrag = this.valueCatalog && this.valueCatalog.get(parseInt(tlv.idHex.slice(0, 4), 16));
            if (eintrag && VERTRAULICH.has(eintrag.name)) continue;
            const wert = eintrag ? werte.zustandsWert(eintrag, protocol.decodeCatalogValue(eintrag, tlv.valBytes)) : undefined;
            if (wert !== undefined) {
                benannt++;
                await this.setzeWert(eintrag, wert);
            } else if (legacy) {
                roh++;
                await this.applyDecodedFrame({ format: 'GET_ALL', outerIdHex: '', tlvs: [tlv] });
            }
        }
        return { benannt, roh };
    }

    /** values.<NAME> anlegen/anpassen und Wert der Box setzen (ack). */
    async setzeWert(e, wert) {
        const id = `values.${e.name}`;
        await this.definiereWert(e);
        // Waehrend ein Befehl aussteht: ein abweichender Wert ist oft nur die
        // alte Meldung, die kurz nach dem Befehl noch eintrifft. Dann nicht
        // zurueckspringen, sondern bis zur Frist warten und nachfragen.
        if (this.wartetAufBox(e, wert)) return;
        this.bestaetige(e, wert);
        const key = `val:${e.name}`;
        if (this.lastValues.has(key) && this.lastValues.get(key) === wert) return;
        this.lastValues.set(key, wert);
        await this.setStateAsync(id, { val: wert, ack: true });
    }

    /**
     * Objekt values.<NAME> passend zur Wertetabelle (Typ, Rolle, Auswahl,
     * Grenzen, schreibbar). Bestehende Objekte aus aelteren Versionen werden
     * angepasst statt neu angelegt; Aktionen bekommen Knoepfe.
     */
    async definiereWert(e) {
        const id = `values.${e.name}`;
        const schreibbar = werte.istSchreibbar(e, this.schreibCfg);
        const common = werte.objektDefinition(e, schreibbar);
        const sig = JSON.stringify(common);
        if (this.werteDefiniert.get(id) === sig) return;
        await this._ensureParents(id);
        await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
        const obj = await this.getObjectAsync(id);
        const alt = obj && obj.common ? obj.common : {};
        const felder = ['type', 'role', 'write', 'unit', 'min', 'max', 'step'];
        const anders = felder.some((f) => alt[f] !== common[f])
            || JSON.stringify(alt.states || null) !== JSON.stringify(common.states || null);
        if (anders) {
            const neu = { ...common };
            for (const f of [...felder, 'states']) if (!(f in neu) && f in alt) neu[f] = null;
            await this.extendObjectAsync(id, { common: neu });
            if (alt.type && alt.type !== common.type) this.lastValues.delete(`val:${e.name}`);
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
                this.log.warn(`Handshake abgebrochen: WS nicht offen (bei ${step.label})`);
                return;
            }
            try {
                const frame = protocol.encodeOpcodeFrame(step.seq, step.op, step.body, this.sharedSecret);
                this.ws.send(frame);
                this.log.info(`Handshake ${step.label} sent (seq=0x${step.seq.toString(16).padStart(2,'0')} op=0x${step.op.toString(16).padStart(2,'0')} ${frame.length}B)`);
            } catch (e) {
                this.log.error(`Handshake ${step.label} failed: ${e.message}`);
                return;
            }
            await this.delay(350);
        }
        this.subscribed = true;
        this.log.info('Handshake komplett. Writes ab seq=0x0a freigeschaltet.');
    }

    /**
     * onStateChange wird vom ioBroker-Core aufgerufen wenn ein State sich
     * aendert. Fuer eigene Writes ist `state.ack === false` charakteristisch
     * (User-/Skript-Befehl). Wir filtern hier alles andere weg.
     */
    async onStateChange(id, state) {
        if (!state || state.ack) return;   // eigener Echo nach erfolgreichem write -> ignorieren
        if (this.stopping) return;
        if (id.endsWith('.control.reboot')) {
            if (state.val) await this.sendeReboot(id);
            return;
        }
        const rel = id.slice(this.namespace.length + 1);

        // Knopf einer Aktion (z. B. values.LIGHT_SYSTEM_MEMORY_1_SAVE)
        const knopf = this.knoepfe.get(rel);
        if (knopf) {
            await this.setStateAsync(rel, { val: false, ack: true }).catch(() => {});
            if (!state.val) return;
            if (!werte.istSchreibbar(knopf.e, this.schreibCfg)) {
                this.log.warn(`${rel}: Schreiben ist fuer ${knopf.e.name} nicht freigegeben.`);
                return;
            }
            this.planeSchreiben(knopf.e, knopf.index, [], `${knopf.e.name}=${knopf.e.categories[knopf.index]}`, false);
            return;
        }

        let e = null;
        if (rel.startsWith('values.')) {
            e = this.katalogNachName.get(rel.slice('values.'.length)) || null;
        } else if (rel.startsWith('named.')) {
            const cfg = WRITE_NAMES[rel.slice('named.'.length)];
            if (!cfg) return;
            e = this.katalogNachName.get(cfg.katalog) || null;
            if (!e) {
                await this.schreibeOhneTabelle(rel, cfg, state.val);
                return;
            }
        } else {
            return;
        }
        if (!e || !werte.istSchreibbar(e, this.schreibCfg) || werte.istAktion(e)) {
            this.log.warn(`${rel}: Schreiben ist nicht freigegeben (Einstellung "Schreibzugriff" oder eigene Freigaben).`);
            await this.zurueckAufLetztenWert(rel, e);
            return;
        }
        this.planeSchreiben(e, werte.boxWert(e, state.val), [rel], `${e.name}=${state.val}`, true);
    }

    /**
     * Befehl pruefen und in die Warteschlange stellen. ids: States, die bis
     * zur Bestaetigung der Box auf ack=false stehen.
     */
    planeSchreiben(e, roh, ids, text, bestaetigen) {
        let bytes;
        try {
            bytes = protocol.encodeCatalogValue(e, roh);
        } catch (err) {
            this.log.warn(`${text}: abgelehnt - ${err.message}`);
            for (const id of ids) this.zurueckAufLetztenWert(id, e);
            return;
        }
        const ziel = e.typ === 'string'
            ? String(roh)
            : werte.zustandsWert(e, protocol.decodeCatalogValue(e, bytes));
        this.schreibQueue.push({ e, bytes, ids, text, bestaetigen, ziel });
        if (!this.schreibLaeuft) this.arbeiteSchreibQueue().catch((err) => this.log.warn(`Schreiben: ${err.message}`));
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
            this.log.warn(`${a.text}: keine fertige Verbindung zur Box - nicht gesendet.`);
            for (const id of a.ids) await this.zurueckAufLetztenWert(id, a.e);
            return;
        }
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeSetValueFrame(seq, a.e.id, a.bytes, this.sharedSecret));
        } catch (err) {
            this.log.error(`${a.text}: Senden fehlgeschlagen - ${err.message}`);
            for (const id of a.ids) await this.zurueckAufLetztenWert(id, a.e);
            return;
        }
        this.pendingWrites.set(seq, { art: 'SET', name: a.e.name, e: a.e, ts: Date.now() });
        this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
        if (a.bestaetigen) {
            const vorher = this.ausstehend.get(a.e.name);
            if (vorher) this.clearTimeout(vorher.timer);
            this.lastValues.delete(`val:${a.e.name}`);
            const ids = [...new Set([...(vorher ? vorher.ids : []), ...a.ids])];
            const timer = this.setTimeout(() => {
                this.zuruecknehmen(a.e.name, `keine Bestaetigung nach ${BESTAETIGUNG_FRIST_MS / 1000} s`);
            }, BESTAETIGUNG_FRIST_MS);
            this.ausstehend.set(a.e.name, { ziel: a.ziel, ids, timer });
        }
        this.log.info(`SCHREIBEN -> ${a.text} (valueId ${a.e.id}, seq=0x${seq.toString(16).padStart(2, '0')}, Daten ${a.bytes.toString('hex')})`);
    }

    /** Einzelnen Wert bei der Box abfragen (GET_DEVICE_VALUE_FOR_VALUEID). */
    frageWert(e) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) return;
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeGetValueFrame(seq, e.id, this.sharedSecret));
            this.pendingWrites.set(seq, { art: 'GET', name: `GET ${e.name}`, ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
        } catch (err) {
            this.log.debug(`Abfrage ${e.name}: ${err.message}`);
        }
    }

    /** true, wenn ein Befehl aussteht und die Box (noch) etwas anderes meldet. */
    wartetAufBox(e, wert) {
        const offen = this.ausstehend.get(e.name);
        if (!offen || offen.ziel === undefined || offen.ziel === wert) return false;
        offen.letzterBoxWert = wert;
        this.lastValues.set(`val:${e.name}`, wert);
        if (!offen.nachgefragt) {
            offen.nachgefragt = true;
            this.setTimeout(() => this.frageWert(e), 3_000);
        }
        return true;
    }

    /** Die Box hat einen Wert gemeldet: ausstehendes Schreiben abschliessen. */
    bestaetige(e, wert) {
        const offen = this.ausstehend.get(e.name);
        if (!offen) return;
        this.clearTimeout(offen.timer);
        this.ausstehend.delete(e.name);
        this.log.info(`${e.name}: Box bestaetigt ${wert}`);
        // Weitere States (z. B. named.Heizung_Schalter) auf den Wert der Box.
        for (const id of offen.ids) {
            if (id === `values.${e.name}`) continue;
            this.setStateAsync(id, { val: wert, ack: true }).catch(() => {});
        }
    }

    /** Schreiben gescheitert: betroffene States auf den letzten Wert der Box. */
    async zuruecknehmen(name, grund) {
        const offen = this.ausstehend.get(name);
        if (!offen) return;
        this.clearTimeout(offen.timer);
        this.ausstehend.delete(name);
        if (offen.letzterBoxWert !== undefined) {
            this.log.warn(`${name}: Box meldet ${offen.letzterBoxWert} statt ${offen.ziel} - uebernommen`);
            const id = `values.${name}`;
            await this.setStateAsync(id, { val: offen.letzterBoxWert, ack: true }).catch(() => {});
        } else {
            this.log.warn(`${name}: ${grund} - zurueck auf den letzten Wert der Box`);
        }
        const e = this.katalogNachName.get(name);
        for (const id of offen.ids) await this.zurueckAufLetztenWert(id, e);
    }

    async zurueckAufLetztenWert(id, e) {
        try {
            let wert = e && this.lastValues.has(`val:${e.name}`) ? this.lastValues.get(`val:${e.name}`) : undefined;
            if (wert === undefined) {
                const st = await this.getStateAsync(id);
                if (!st) return;
                wert = st.val;
            }
            await this.setStateAsync(id, { val: wert, ack: true });
        } catch (_) { /* ignorieren */ }
    }

    /** Werte einer Push-Meldung direkt nach values.* (Liste wie im Gesamtstand). */
    async applyPushWerte(plain) {
        if (!this.valueCatalog) return;
        const antwort = protocol.decodeResponse(plain);
        const liste = antwort && protocol.parseValueList(antwort.payload);
        if (!liste || !liste.length) return;
        // Nur wenn jeder Eintrag bekannt ist - sonst ist es keine Werteliste.
        if (!liste.every((t) => this.valueCatalog.has(parseInt(t.idHex.slice(0, 4), 16)))) return;
        await this.applyValueEntries(liste, { legacy: false });
    }

    /** Ohne Wertetabelle: alter Schreibweg nur fuer die Heizung (named.*). */
    async schreibeOhneTabelle(rel, cfg, val) {
        if (this.schreibCfg.stufe === 'aus') {
            this.log.warn(`${rel}: Schreibzugriff ist ausgeschaltet.`);
            return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) {
            this.log.error(`Schreibversuch ${rel}=${val} bei nicht offener Verbindung.`);
            return;
        }
        let valueByte;
        try {
            valueByte = cfg.encode(val);
        } catch (err) {
            this.log.error(`encode fehlgeschlagen fuer ${rel}=${val}: ${err.message}`);
            return;
        }
        const seq = this.nextSeq();
        this.ws.send(protocol.encodeWriteFrame(seq, cfg.wireByte, valueByte, this.sharedSecret));
        this.pendingWrites.set(seq, { name: rel, ts: Date.now() });
        this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
        this.log.info(`WRITE -> ${rel}=${val} (ohne Wertetabelle, wire=0x${cfg.wireByte.toString(16)})`);
    }

    /**
     * Neustart der Box wie „MACH neu starten" in der App: SYSTEM_RESET
     * (opcode 0x09, leerer Body) in der laufenden Session. Kommt nur an,
     * solange die Box noch antwortet - gegen einen Komplett-Haenger hilft
     * er nicht. Die WebSocket-Session zum Backend ueberlebt den Neustart.
     */
    async sendeReboot(id) {
        await this.setStateAsync(id, { val: false, ack: true }).catch(() => {});
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sharedSecret) {
            this.log.error('Neustart: keine offene Verbindung zur Box.');
            return;
        }
        if (!this.subscribed) {
            this.log.error('Neustart: Handshake noch nicht abgeschlossen - Box wuerde ablehnen.');
            return;
        }
        const seit = Date.now() - this.letzterReboot;
        if (seit < REBOOT_MIN_ABSTAND_MS) {
            this.log.warn(`Neustart abgelehnt: letzter erst vor ${Math.round(seit / 1000)} s.`);
            return;
        }
        const seq = this.nextSeq();
        try {
            this.ws.send(protocol.encodeSystemResetFrame(seq, this.sharedSecret));
            this.letzterReboot = Date.now();
            this.pendingWrites.set(seq, { id, oldValue: false, name: 'REBOOT', ts: Date.now() });
            this.setTimeout(() => this.pendingWrites.delete(seq), 10_000);
            this.log.info(`REBOOT -> SYSTEM_RESET gesendet (seq=0x${seq.toString(16).padStart(2, '0')})`);
        } catch (e) {
            this.log.error(`Neustart fehlgeschlagen: ${e.message}`);
        }
    }

    cleanupWebSocket() {
        if (this.heartbeatTimer) { this.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.statsTimer) { this.clearInterval(this.statsTimer); this.statsTimer = null; }
        if (this.getAllTimer) { this.clearInterval(this.getAllTimer); this.getAllTimer = null; }
        if (this.getAllNachPushTimer) { this.clearTimeout(this.getAllNachPushTimer); this.getAllNachPushTimer = null; }
        this.l0Teile = [];
        if (this.ws) {
            try { this.ws.removeAllListeners(); } catch (_) {}
            try { this.ws.close(1000, 'cleanup'); } catch (_) {}
            try { this.ws.terminate(); } catch (_) {}
            this.ws = null;
        }
    }

    scheduleReconnect() {
        if (this.stopping || this.reconnectTimer) return;
        this.reconnectTimer = this.setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.stopping) this.connect();
        }, RECONNECT_DELAY_MS);
    }

    onUnload(callback) {
        try {
            this.stopping = true;
            this.cleanupWebSocket();
            if (this.reconnectTimer) { this.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
            this.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
            callback();
        } catch (_e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Mach(options);
} else {
    new Mach();
}
