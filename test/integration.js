'use strict';
const path = require('path');
const { tests } = require('@iobroker/testing');

// Startet den Adapter in einer echten js-controller-Umgebung. Ohne
// Zugangsdaten meldet er nur „Konfiguration unvollständig" und muss
// trotzdem sauber laufen und sich beenden lassen.
tests.integration(path.join(__dirname, '..'));
