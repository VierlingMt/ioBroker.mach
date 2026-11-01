'use strict';
// ============================================================================
// Werte der Box in ioBroker: Darstellung (Typ, Rolle, Auswahl, Grenzen),
// Umrechnung Box <-> State und die Freigabe zum Schreiben.
//
// Alles richtet sich nach der Wertetabelle (get-drivers-json), nicht nach
// festen Namen - so funktioniert es mit jedem Wohnwagen und jeder Box.
// ============================================================================

/** Stufen fuer den Schreibzugriff (Instanz-Einstellung "schreiben"). */
const STUFEN = ['aus', 'bedienung', 'einrichtung'];

/**
 * Nie schreibbar, auch nicht ueber die eigene Freigabeliste: diese Werte
 * koennen die Box lahmlegen oder die eigene LTE-Verbindung kappen - danach
 * gaebe es aus der Ferne kein Zurueck.
 */
const HART_GESPERRT = [
    /BOOTLOADER/,
    /APPLICATION_RUNNING_STATUS/,
    /^SYSTEM_DEBUG$/,
    /DEBUG_MODE$/,
    /^LTE_VALUE$/,
    /^LTE_SIM_/,          // SIM-Steckplatz, APN, Benutzer, Passwort, PIN
    /^SYSTEM_BLE_PIN/,    // Bluetooth-Zugang zur Box
];

/**
 * Nur in der Stufe "einrichtung": Sensoren anlernen, Grenzwerte, Kennungen,
 * SIM-Zugang. Im Alltag braucht man das nicht, ein Tippfehler stoert aber
 * Sensoren oder Verbindung.
 */
const EINRICHTUNG = [
    /^SYSTEM_/,
    /^LTE_/,
    /^SMS_/,
    /^GPS_TIME$/,
    /SCAN_STATE$/,
    /ADDRESS$/,
    /_NAME$/,
    /^REGISTERED_/,
    /^DETECTED_/,
    /MANUFACTURER$/,
    /^ACCELER/,
    /_LIMIT(_|$)/,
    /^GAS_BOTTLE_HEIGHT/,
];

const passt = (liste, name) => liste.some((re) => re.test(name));

/** Eigene Liste aus der Konfiguration: Namen oder Muster mit *, getrennt durch Komma/Zeilen. */
function eigeneListe(text) {
    return String(text || '')
        .split(/[\s,;]+/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
        .map((x) => new RegExp(`^${x.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
}

/**
 * Darf dieser Wert geschrieben werden?
 * @param {object} eintrag Eintrag der Wertetabelle
 * @param {{stufe: string, freigaben: RegExp[], sperren: RegExp[]}} cfg
 * @returns {boolean}
 */
function istSchreibbar(eintrag, cfg) {
    if (!eintrag || !eintrag.typ) return false;
    const name = eintrag.name;
    if (passt(HART_GESPERRT, name)) return false;
    if (cfg.stufe === 'aus') return false;
    if (passt(cfg.sperren, name)) return false;
    if (passt(cfg.freigaben, name)) return true;
    if (!eintrag.writable) return false;
    if (eintrag.typ === 'string' || passt(EINRICHTUNG, name)) return cfg.stufe === 'einrichtung';
    return true;
}

const istAnAus = (e) => e.typ === 'categorical' && Array.isArray(e.categories)
    && e.categories.length === 2 && e.categories[0] === 'off' && e.categories[1] === 'on';

/** Aktion ohne Zustand: wird als Knopf je Auswahl angelegt. */
const istAktion = (e) => e.typ === 'categorical' && e.hasState === false && Array.isArray(e.categories);

function einheit(e) {
    if (e.unit) return e.unit;
    const n = e.name;
    if (/TEMPERATURE/.test(n)) return '°C';
    if (/BRIGHTNESS|_SOC$|_LEVEL$|SIGNAL_STRENGTH/.test(n)) return '%';
    if (/VOLTAGE/.test(n)) return 'V';
    if (/CURRENT$/.test(n)) return 'A';
    return undefined;
}

/**
 * ioBroker-Objekt (common) fuer values.<NAME>.
 * @param {object} e Eintrag der Wertetabelle
 * @param {boolean} schreibbar
 */
function objektDefinition(e, schreibbar) {
    // Aktionen ohne Zustand werden ueber eigene Knoepfe ausgeloest.
    if (istAktion(e)) schreibbar = false;
    const c = { name: e.name, read: true, write: !!schreibbar };
    const n = e.name;
    if (e.typ === 'categorical' && istAnAus(e)) {
        c.type = 'boolean';
        c.role = schreibbar ? (/LIGHT/.test(n) ? 'switch.light' : 'switch') : 'indicator';
    } else if (e.typ === 'categorical' && Array.isArray(e.categories)) {
        c.type = 'number';
        c.states = Object.fromEntries(e.categories.map((cat, i) => [i, String(cat)]));
        c.min = 0;
        c.max = e.categories.length - 1;
        if (!schreibbar) c.role = 'value';
        else if (/AIR_CONDITION_MODE$/.test(n)) c.role = 'level.mode.airconditioner';
        else if (/FAN_MODE$/.test(n)) c.role = 'level.mode.fan';
        else c.role = 'level';
    } else if (e.typ === 'integer' || e.typ === 'float') {
        c.type = 'number';
        const u = einheit(e);
        if (u) c.unit = u;
        if (e.range) {
            c.min = e.offState ? Math.min(0, e.range[0]) : e.range[0];
            c.max = e.range[1];
        }
        if (e.step) c.step = e.step;
        else if (e.typ === 'integer' && schreibbar) c.step = 1;
        if (schreibbar) {
            c.role = u === '°C' ? 'level.temperature' : /BRIGHTNESS/.test(n) ? 'level.dimmer' : 'level';
        } else {
            c.role = u === '°C' ? 'value.temperature'
                : u === 'V' ? 'value.voltage'
                    : u === 'A' ? 'value.current'
                        : /_SOC$/.test(n) ? 'value.battery' : 'value';
        }
    } else if (e.typ === 'string') {
        c.type = 'string';
        c.role = 'text';
    } else {
        c.type = 'number';
        c.role = 'value';
        c.write = false;
    }
    return c;
}

/** Knoepfe fuer eine Aktion ohne Zustand: [{suffix, index, common}]. */
function aktionsKnoepfe(e) {
    return (e.categories || []).map((cat, i) => ({
        suffix: String(cat).toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
        index: i,
        common: { name: `${e.name}: ${cat}`, type: 'boolean', role: 'button', read: false, write: true, def: false },
    }));
}

/**
 * Wert der Box (decodeCatalogValue) -> State-Wert passend zu objektDefinition.
 * @returns {*} undefined, wenn nicht darstellbar
 */
function zustandsWert(e, dekodiert) {
    if (!dekodiert) return undefined;
    const v = dekodiert.value;
    if (e.typ === 'categorical' && Array.isArray(e.categories)) {
        const idx = typeof v === 'number' ? v : e.categories.indexOf(v);
        if (istAnAus(e)) return idx === 1;
        return idx >= 0 ? idx : undefined;
    }
    if (e.typ === 'integer' && v === null) return e.offState ? 0 : null;
    return v;
}

/** State-Wert -> Wert fuer encodeCatalogValue (Index, Zahl, Text). */
function boxWert(e, val) {
    if (e.typ === 'categorical') {
        if (istAnAus(e)) {
            if (typeof val === 'string') return val === 'on' || val === 'true' ? 1 : 0;
            return val ? 1 : 0;
        }
        if (typeof val === 'string' && !/^\d+$/.test(val)) return val; // Name der Auswahl
        return Number(val);
    }
    if (e.typ === 'integer' || e.typ === 'float') return val === null ? null : Number(val);
    return val;
}

module.exports = {
    STUFEN,
    HART_GESPERRT,
    EINRICHTUNG,
    eigeneListe,
    istSchreibbar,
    istAnAus,
    istAktion,
    objektDefinition,
    aktionsKnoepfe,
    zustandsWert,
    boxWert,
};
