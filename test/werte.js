'use strict';
// Encoder und Freigaben gegen bekannte App-Frames pruefen. Laeuft ohne
// weitere Pakete: node test/werte.js
const assert = require('node:assert/strict');
const p = require('../lib/protocol');
const w = require('../lib/werte');

const heizung = { id: 64, name: 'AIR_HEATER_VALUE', typ: 'categorical', categories: ['off', 'on'], writable: true, hasState: true };
const soll = { id: 67, name: 'AIR_HEATER_TEMPERATURE', typ: 'float', dividend: 2, bytes: 1, range: [5, 30], step: 0.5, writable: true, hasState: true };
const licht = { id: 91, name: 'LIGHT_GROUP_1_BRIGHTNESS', typ: 'integer', range: [1, 100], offState: true, bytes: 1, writable: true, hasState: true };
const boiler = { id: 73, name: 'WATER_HEATER_TEMPERATURE', typ: 'categorical', categories: ['off', 'normal', 'boost'], writable: true, hasState: true };
const speicher = { id: 116, name: 'LIGHT_SYSTEM_MEMORY_1', typ: 'categorical', categories: ['save', 'restore'], writable: true, hasState: false };
const apn = { id: 145, name: 'LTE_SIM_APN_VALUE', typ: 'string', writable: true, hasState: true };
const name = { id: 522, name: 'BLUETOOTH_BATTERY_1_NAME', typ: 'string', writable: true, hasState: true };
const innen = { id: 70, name: 'LIVING_MEASURED_TEMPERATURE', typ: 'integer', bytes: 1, writable: false, hasState: true };

const nutzdaten = (e, roh) => Buffer.concat([p.intBE(e.id, 2), p.encodeCatalogValue(e, roh)]).toString('hex');

// Byte fuer Byte wie die App (Mitschnitte und App-Tests)
assert.equal(nutzdaten(heizung, w.boxWert(heizung, true)), '004001');
assert.equal(nutzdaten(heizung, w.boxWert(heizung, false)), '004000');
assert.equal(nutzdaten(soll, 5), '00430a');
assert.equal(nutzdaten(soll, 17.5), '004323');
assert.equal(nutzdaten(licht, 42), '005b2a');
assert.equal(nutzdaten(licht, 0), '005b00');            // aus = 1 Byte 0
assert.equal(nutzdaten(boiler, 2), '004902');
assert.equal(nutzdaten(boiler, 'normal'), '004901');
assert.equal(nutzdaten(name, 'Bord'), '020a04426f7264');  // valueId > 255, Text mit Laenge

// Unzulaessiges wird abgelehnt
for (const [e, v] of [[soll, 4], [soll, 31], [soll, 5.3], [licht, 101], [licht, 2.5], [heizung, 'x'], [boiler, 3]]) {
    assert.throws(() => p.encodeCatalogValue(e, v), `${e.name}=${v} haette abgelehnt werden muessen`);
}

// Freigaben
const cfg = (stufe, freigaben = '', sperren = '') => ({ stufe, freigaben: w.eigeneListe(freigaben), sperren: w.eigeneListe(sperren) });
assert.equal(w.istSchreibbar(heizung, cfg('bedienung')), true);
assert.equal(w.istSchreibbar(heizung, cfg('aus')), false);
assert.equal(w.istSchreibbar(name, cfg('bedienung')), false);       // Text nur in "einrichtung"
assert.equal(w.istSchreibbar(name, cfg('einrichtung')), true);
assert.equal(w.istSchreibbar(apn, cfg('einrichtung')), false);       // fest gesperrt
assert.equal(w.istSchreibbar(apn, cfg('einrichtung', 'LTE_SIM_APN_VALUE')), false);
assert.equal(w.istSchreibbar(innen, cfg('bedienung')), false);       // laut Tabelle nicht schreibbar
assert.equal(w.istSchreibbar(innen, cfg('bedienung', 'LIVING_*')), true); // eigene Freigabe
assert.equal(w.istSchreibbar(heizung, cfg('bedienung', '', 'AIR_HEATER_*')), false); // eigene Sperre

// Bewegliche Teile, Ventile, Schloesser, Generator: nur mit eigener Freigabe
const markise = { id: 900, name: 'UTILITIES_AWNING_VALUE', typ: 'categorical', categories: ['off', 'on'], writable: true, hasState: true };
const ventil = { id: 901, name: 'DRAIN_VALVE_GREY_WATER', typ: 'categorical', categories: ['close', 'open'], writable: true, hasState: true };
assert.equal(w.istSchreibbar(markise, cfg('einrichtung')), false);
assert.equal(w.istSchreibbar(ventil, cfg('bedienung')), false);
assert.equal(w.istSchreibbar(markise, cfg('bedienung', 'UTILITIES_AWNING_VALUE')), true);

// Darstellung in ioBroker
assert.deepEqual(w.objektDefinition(heizung, true), { name: 'AIR_HEATER_VALUE', read: true, write: true, type: 'boolean', role: 'switch' });
assert.equal(w.objektDefinition(heizung, false).role, 'indicator');
const b = w.objektDefinition(boiler, true);
assert.deepEqual(b.states, { 0: 'off', 1: 'normal', 2: 'boost' });
assert.equal(b.type, 'number');
const s = w.objektDefinition(soll, true);
assert.equal(s.role, 'level.temperature');
assert.equal(s.min, 5);
assert.equal(s.step, 0.5);
assert.equal(w.objektDefinition(licht, true).min, 0);               // 0 = aus
assert.equal(w.objektDefinition(speicher, true).write, false);      // Aktion -> Knoepfe
assert.deepEqual(w.aktionsKnoepfe(speicher).map((k) => k.suffix), ['SAVE', 'RESTORE']);

// Werte der Box -> State
assert.equal(w.zustandsWert(heizung, p.decodeCatalogValue(heizung, Buffer.from([1]))), true);
assert.equal(w.zustandsWert(boiler, p.decodeCatalogValue(boiler, Buffer.from([2]))), 2);
assert.equal(w.zustandsWert(licht, p.decodeCatalogValue(licht, Buffer.from([0]))), 0);
assert.equal(w.zustandsWert(soll, p.decodeCatalogValue(soll, Buffer.from([0x23]))), 17.5);

console.log('werte: alle Pruefungen bestanden');
