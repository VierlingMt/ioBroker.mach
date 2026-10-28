'use strict';
// ============================================================================
// MACH 2.0 – Wire-ID Mappings (S->C Lese-Pfad)
//
// Quelle: eigene Beobachtung der Push-Meldungen, siehe PROTOCOL.md
// Wenn neue Wire-IDs verifiziert werden: hier ergaenzen + MAPPINGS.md
// pflegen.
// ============================================================================

/**
 * S->C Format-C Frames (1-2 Byte Nutzlast). Wenn ein Frame mit dieser
 * outerIdHex reinkommt, wird ein State unter `named.<name>` angelegt.
 * `decode(b0)` liefert `{ value, unit, label }`.
 *
 * Wer keinen `decode` hat wird als generischer "B0/B1" State exposed.
 */
const FRAME_NAMES = {
    // Format A: Sensor-Group-Frames (69ee + Multi-TLVs)
    '98803304': { name: 'GPS_Group',          desc: 'GPS Position-Frame' },
    '9d004604': { name: 'LTE_Group',          desc: 'LTE Datenvolumen-Frame' },
    'bc003004': { name: 'Counter_BC',         desc: 'Heartbeat-Counter (~1/sec)' },
    'c6003004': { name: 'Counter_C6',         desc: 'Heartbeat-Counter' },

    // Format B: Status-Frames (outer-val + Inner-TLVs + Tail)
    '15004402': { name: 'Battery_Group',      desc: 'Bordbatterie' },
    '00800901': { name: 'PowerStatus_Group',  desc: 'Strom-Statusquelle' },
    '21802101': { name: 'Status_2180',        desc: 'unbekannt – statisch' },

    // Format C: Switch-Frames (Nutzlast + Tail)
    '43804701': {
        name: 'Heizung_Sollwert',
        desc: 'Aldé Heizungs-Soll',
        decode: b0 => ({ value: b0 * 0.5, unit: '°C', label: `${b0 * 0.5}°C`, type: 'number', role: 'level.temperature' }),
    },
    // 3d800e01 traegt den Ein/Aus-Zustand der Heizung (AIR_HEATER_VALUE).
    // App-Test 2026-10-27: aus -> B0=0 + Inner-TLV 0040:8008 = 0, an ->
    // B0=1 + TLV = 1. Geschrieben wird nach Wire-Byte
    // 0x40 SCHREIBT - zurueck kommt der Zustand aber hier, als TLV 0x40.
    // Der Name "Heizung_Aktiv" bleibt, weil Skripte daran haengen; die
    // fruehere Deutung "Brenner aktiv" war falsch.
    '3d800e01': {
        name: 'Heizung_Aktiv',
        desc: 'Aldé Heizung an/aus (Lese-Zustand, verifiziert 2026-10-27)',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'indicator' }),
    },
    // 40800801: Schreibziel der App (Wire-Byte 0x40). Als S->C-Frame
    // aendert er sich beim Schalten NICHT (App-Test 2026-10-27) - zum
    // Lesen des Zustands Heizung_Aktiv (3d800e01) nehmen.
    '40800801': {
        name: 'Heizung_Schalter',
        desc: 'Aldé Heizung an/aus (writable, AIR_HEATER_VALUE)',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'switch.power' }),
    },
    '96800801': {
        name: 'GPS_Schalter',
        desc: 'GPS-Modul an/aus',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'switch' }),
    },
    '1a800801': {
        name: 'Kuehlschrank_Schalter',
        // Verifiziert 2026-10-27 per App an/aus. Kommt nur bei Aenderung -
        // ein verpasster Wechsel bleibt stehen (stand 2 Monate auf "an").
        desc: 'Kuehlschrank an/aus (B0=0/1, verifiziert 2026-10-27)',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'switch.power' }),
    },
    '01000101': {
        name: 'Landstrom_Schalter',
        desc: 'Landstrom (Shore Power) an/aus (B0=0/1, verifiziert 2026-04-28)',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'switch.power' }),
    },
    '5b803b01': {
        name: 'Lichtgruppe_1',
        desc: 'Lichtgruppe 1 Helligkeit',
        decode: b0 => ({ value: b0, unit: '%', label: `${b0}%`, type: 'number', role: 'level.dimmer' }),
    },

    // KORRIGIERT 2026-04-29:
    // 8a002d01 ist NICHT Aussentemperatur sondern LTE-Signal-Strength!
    // Die fruehere /5-Skala war Zufall: LTE-Wert 91 -> 18.2 sah aus wie 18°C
    // bei App-Anzeige 18°C. Tatsaechlich: LTE_SIGNAL_STRENGTH.
    // B0 = Signal in % (0..100).
    '8a002d01': {
        name: 'LTE_Signal_Strength',
        desc: 'LTE-Signalstaerke in %',
        decode: b0 => ({
            value: b0,
            unit: '%',
            label: `${b0}%`,
            type: 'number',
            role: 'value',
        }),
    },

    // Air-Condition-Schalter + Sub-Werte (entdeckt 2026-04-28)
    // outerVal[0] = 0/1 (AC AUS/AN). Inner-TLVs noch nicht final dekodiert:
    //   00318038 = ? (vermutet Setpoint, aber Encoding noch unklar)
    //   00328016 = ? (Modus / Fan?)
    //   0033801b = ? (Modus / Fan?)
    //   00390001 = ? (Status-Bit)
    '2f800801': {
        name: 'AirCondition_Schalter',
        desc: 'Klimaanlage an/aus (outerVal[0]=0/1)',
        decode: b0 => ({
            value: !!b0,
            unit: '',
            label: b0 ? 'AN' : 'AUS',
            type: 'boolean',
            role: 'switch.power',
        }),
    },

    // Innen-Temperatur (verifiziert 2026-04-28: B0=33 -> 33°C bei App 33°C)
    // Encoding: B0 = °C direkt (keine Skalierung)
    '51002d01': {
        name: 'Innentemperatur',
        desc: 'Innentemperatur (B0 = °C direkt)',
        decode: b0 => ({
            value: b0,
            unit: '°C',
            label: `${b0}°C`,
            type: 'number',
            role: 'value.temperature',
        }),
    },

    // 97002d01 verifiziert 2026-04-29: GPS_VISIBLE_SATELLITES.
    // B0 = Anzahl sichtbare Satelliten.
    '97002d01': {
        name: 'GPS_VisibleSatellites',
        desc: 'Sichtbare GPS-Satelliten',
        decode: b0 => ({
            value: b0,
            unit: '',
            label: `${b0}`,
            type: 'number',
            role: 'value',
        }),
    },
    'b5003101': { name: 'Sensor_b500', desc: 'unklar (B0 ~ 91, koennte Aussenfeuchtigkeit sein - OUTSIDE_MEASURED_HUMIDITY)' },
    // Aussentemperatur (verifiziert 2026-04-29 durch User-Beobachtung:
    // morgens B0=10 bei App 10°C, mittags B0=17 bei App 17°C).
    // Encoding: B0 = °C direkt, gleich wie Innentemperatur (51002d01).
    '53002d01': {
        name: 'Aussentemperatur',
        desc: 'Aussentemperatur (B0 = °C direkt, OUTSIDE_MEASURED_TEMPERATURE)',
        decode: b0 => ({
            value: b0,
            unit: '°C',
            label: `${b0}°C`,
            type: 'number',
            role: 'value.temperature',
        }),
    },

    // Lichtgruppen 2-4 (beobachtet 2026-04-29 - kommen zusammen
    // mit 5b803b01 in einem Multi-Frame mit Brightness 0..50 als Roh-Wert).
    // Bisher nur 5b verifiziert (Lichtgruppe_1), die anderen analog.
    '5c803b01': {
        name: 'Lichtgruppe_2',
        desc: 'Lichtgruppe 2 Helligkeit',
        decode: b0 => ({ value: b0, unit: '%', label: `${b0}%`, type: 'number', role: 'level.dimmer' }),
    },
    '5d803b01': {
        name: 'Lichtgruppe_3',
        desc: 'Lichtgruppe 3 Helligkeit',
        decode: b0 => ({ value: b0, unit: '%', label: `${b0}%`, type: 'number', role: 'level.dimmer' }),
    },
    '5e803b01': {
        name: 'Lichtgruppe_4',
        desc: 'Lichtgruppe 4 Helligkeit',
        decode: b0 => ({ value: b0, unit: '%', label: `${b0}%`, type: 'number', role: 'level.dimmer' }),
    },

    // Internal-Light-Schalter (beobachtet 2026-04-29: kommt im selben
    // Multi-Frame wie 5b/5c/5d/5e, B0 immer 1, B1 = on/off).
    '84800801': {
        name: 'Innenlicht_Schalter',
        desc: 'Innenbeleuchtung an/aus',
        decode: b0 => ({ value: !!b0, unit: '', label: b0 ? 'AN' : 'AUS', type: 'boolean', role: 'switch.power' }),
    },

    // Frame 39000101 (entdeckt 2026-04-28 beim AC-Auto-Test):
    // B0=1, B1=249. Vermutet AC-bezogener Status-Frame, ggf. Auto-Mode-Bit.
    // Final unverified - bleibt mit B0/B1-Exposure stehen.
    '39000101': { name: 'AirCondition_StatusFrame', desc: 'unklar (entdeckt bei AC-Auto)' },
};

/**
 * Sub-TLV Mappings innerhalb von Multi-TLV-Frames.
 * Key = id1Hex + id2Hex (8 hex chars).
 * `transform(valNum)` liefert den finalen State-Wert.
 * `meta` definiert State-Metadaten (type, role, unit).
 */
const TLV_NAMES = {
    // Battery-Subsystem (subsys 0044/0031)
    '00160044': {
        name: 'Battery_Voltage_V',
        transform: v => +(v / 1000).toFixed(3),
        meta: { type: 'number', role: 'value.voltage', unit: 'V' },
    },
    '00170031': {
        name: 'Battery_SOC_Percent',
        transform: v => v,
        meta: { type: 'number', role: 'value.battery', unit: '%' },
    },

    // GPS-Subsystem (verifiziert / vermutet 2026-04-28)
    // sequentielle Sub-IDs 0x98-0x9c gehoeren alle zur GPS-Group:
    //   0x98 = GPS_Time (Unix-Epoch s, 4 bytes)
    //   0x99 = GPS_Altitude (Skala noch zu verifizieren - cm? dm?)
    //   0x9a = GPS_Velocity (vermutet, im Stand 0)
    //   0x9b = GPS_Longitude (×1e7)
    //   0x9c = GPS_Latitude (×1e7)
    '00988033': {
        name: 'GPS_Time',
        transform: v => v,
        meta: { type: 'number', role: 'value.time', unit: 's' },
    },
    '00990042': {
        // Skala unklar - bei Stand: 3549. Testort ~270 m. 3549/10 = 354.9m,
        // ggf. mit Offset oder anderer Skala. Bis zur Verifikation: raw.
        name: 'GPS_Altitude',
        transform: v => v,
        meta: { type: 'number', role: 'value.gps.elevation' },
    },
    '009a0043': {
        // Im Stand 0. Skala bei Fahrt zu verifizieren (cm/s? km/h*100?)
        name: 'GPS_Velocity',
        transform: v => v,
        meta: { type: 'number', role: 'value.speed' },
    },
    '009b0046': {
        name: 'GPS_Longitude_deg',
        transform: v => +(v / 1e7).toFixed(7),
        meta: { type: 'number', role: 'value.gps.longitude', unit: '°' },
    },
    '009c0046': {
        name: 'GPS_Latitude_deg',
        transform: v => +(v / 1e7).toFixed(7),
        meta: { type: 'number', role: 'value.gps.latitude', unit: '°' },
    },
    '009d0046': {
        name: 'LTE_Volume_Remaining',
        transform: v => v,
        meta: { type: 'number', role: 'value', unit: 'B' },
    },
    '009e0046': {
        name: 'LTE_Volume_Used',
        transform: v => v,
        meta: { type: 'number', role: 'value', unit: 'B' },
    },
    '009f0046': {
        name: 'LTE_Counter_9f',
        // Signed32 BE: TLV ist 4 Bytes unsigned-decoded -> bei sehr grossen
        // Werten signed-konvertieren (typische Range im Test war
        // ±100000, also kein Problem mit Vorzeichen-Erkennung)
        transform: v => (v >= 0x80000000 ? v - 0x100000000 : v),
        meta: { type: 'number', role: 'value' },
    },

    // Air-Condition-Sub-Werte (verifiziert 2026-04-28)
    // 00318038 = Setpoint (B0 = °C direkt). 16°C -> raw=16
    '00318038': {
        name: 'AirCondition_Sollwert',
        transform: v => v,
        meta: { type: 'number', role: 'level.temperature', unit: '°C' },
    },
    // 00328016 = Luefter-Modus (Codes laut Wertetabelle):
    //   0 = low (langsam)
    //   1 = mid
    //   2 = high (schnell)
    //   3 = night
    '00328016': {
        name: 'AirCondition_FanMode',
        transform: v => v,
        meta: { type: 'number', role: 'value' },
    },
    // 0033801b = AC-Modus (Codes laut Wertetabelle):
    //   0 = off
    //   1 = fan
    //   2 = cool
    //   3 = heat
    //   4 = auto
    '0033801b': {
        name: 'AirCondition_Mode',
        transform: v => v,
        meta: { type: 'number', role: 'value' },
    },
    // 00390001 = Status/Error-Bit (beobachtet: 0 wenn AC aus/Cool/Heat, 1 in Auto)
    '00390001': {
        name: 'AirCondition_Status',
        transform: v => v,
        meta: { type: 'number', role: 'value' },
    },
    // 003c0001 = Manual-Mode-Flag (AIR_CONDITION_FLAG_MANUAL_MODE on/off). Korreliert
    // zufaellig mit Landstrom weil AC nur bei 230V manuell bedienbar ist.
    '003c0001': {
        name: 'AirCondition_ManualMode',
        transform: v => v,
        meta: { type: 'number', role: 'indicator' },
    },

    // Aussenlicht-Dimmer (verifiziert 2026-04-28):
    // raw 0..60 = 0..100%. Beobachtungen: 60->100%, 37->62%, 10->17%, 0->aus.
    '0085803b': {
        name: 'Aussenlicht_Helligkeit',
        transform: v => Math.round((v * 100) / 60),
        meta: { type: 'number', role: 'level.dimmer', unit: '%' },
    },

    // PowerStatus-Subsystem (mehrere unklare Bits)
    '00598008': { name: 'PowerStatus_5980', transform: v => v, meta: { type: 'number', role: 'value' } },
    '00010001': { name: 'PowerStatus_0001', transform: v => v, meta: { type: 'number', role: 'value' } },
    '0008002e': { name: 'Counter_8_2e',     transform: v => v, meta: { type: 'number', role: 'value' } },

    // 21802101-Frame
    '00268022': { name: 'Status_26_22',     transform: v => v, meta: { type: 'number', role: 'value' } },
};

/**
 * Schreibbare States (C->S). Key = State-Name unter `named.<name>`.
 * `wireByte` ist das erste Byte der zugehoerigen S->C-outerId,
 * `encode(value)` liefert den 1-Byte Wert fuer die Wire-Payload.
 *
 * Live verifiziert 2026-10-28 (Heizung an/aus, Sollwert).
 */
const WRITE_NAMES = {
    Heizung_Schalter: {
        wireByte: 0x40,
        encode: v => (v ? 1 : 0),
    },
    Heizung_Sollwert: {
        wireByte: 0x43,
        // Sollwert in 0.5°C-Schritten, raw = °C * 2. Range typ. 5..30°C -> 10..60 raw.
        encode: v => {
            const raw = Math.round(Number(v) * 2);
            if (Number.isNaN(raw)) throw new Error(`invalid Sollwert: ${v}`);
            return Math.max(0, Math.min(60, raw));
        },
    },
};

module.exports = { FRAME_NAMES, TLV_NAMES, WRITE_NAMES };
