'use strict';
const path = require('path');
const { tests } = require('@iobroker/testing');

// Prüft package.json und io-package.json auf die Pflichtfelder von ioBroker.
tests.packageFiles(path.join(__dirname, '..'));
