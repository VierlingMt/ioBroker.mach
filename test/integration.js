'use strict';
const path = require('path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

const state = (extra = {}) => ({
    type: 'state',
    common: { name: 'old', type: 'number', role: 'value', read: true, write: false, ...extra },
    native: {},
});

// Startet den Adapter in einer echten js-controller-Umgebung. Ohne
// Zugangsdaten meldet er nur „Configuration incomplete" und muss trotzdem
// sauber laufen und sich beenden lassen.
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        // 2.0.0 entfernt named.* und frames.* aus aelteren Versionen -
        // States mit eigenen Einstellungen (History & Co.) bleiben stehen.
        suite('Clean-up of the trees of versions before 2.0.0', getHarness => {
            it('deletes named.* and frames.*, keeps states with custom settings', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                const objekte = {
                    'mach.0.named': { type: 'folder', common: { name: 'named' }, native: {} },
                    'mach.0.named.Heizung_Aktiv': state({ type: 'boolean', role: 'indicator' }),
                    'mach.0.named.Innentemperatur': state({ custom: { 'history.0': { enabled: true } } }),
                    'mach.0.frames': { type: 'folder', common: { name: 'frames' }, native: {} },
                    'mach.0.frames.1a800801': { type: 'channel', common: { name: '1a800801' }, native: {} },
                    'mach.0.frames.1a800801.b0': state(),
                    'mach.0.tlv': { type: 'folder', common: { name: 'tlv' }, native: {} },
                    'mach.0.tlv.00ab0001_t01': { type: 'channel', common: { name: 'raw' }, native: {} },
                    'mach.0.tlv.00ab0001_t01.raw': state(),
                };
                for (const [id, obj] of Object.entries(objekte)) {
                    await harness.objects.setObjectAsync(id, obj);
                }
                await harness.startAdapterAndWait();
                await new Promise(resolve => setTimeout(resolve, 3000));
                const da = async id => !!(await harness.objects.getObjectAsync(id));

                assert.equal(await da('mach.0.named.Heizung_Aktiv'), false, 'named state without custom must be deleted');
                assert.equal(await da('mach.0.named.Innentemperatur'), true, 'state with custom settings must stay');
                assert.equal(await da('mach.0.named'), true, 'folder of a kept state must stay');
                assert.equal(await da('mach.0.frames.1a800801.b0'), false);
                assert.equal(await da('mach.0.frames.1a800801'), false);
                assert.equal(await da('mach.0.frames'), false);
                assert.equal(await da('mach.0.tlv.00ab0001_t01.raw'), true, 'tlv.* is still used and must stay');
                // Kein harness.stopAdapter(): ab js-controller 8 befolgt der
                // Adapter sigKill nur vom eigenen Host, der Harness schickt es
                // als system.host.testing und wartet dann ohne Zeitlimit. Das
                // Testframework beendet den Adapter nach jedem Test selbst.
            });
        });
    },
});
