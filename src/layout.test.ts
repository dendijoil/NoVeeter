import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLayout } from './layout.ts';

test('migrates the blueprint layout and validates portable settings', () => {
  const layout = parseLayout({
    activePreset: 'Compact Daily', window: { width: 200, height: Infinity },
    globalModules: { showMasterSection: false },
    strips: [{ index: 5, visibility: 'collapsed', customName: ' GAME ', modules: { intellipan: false, audibility: false, eqAndFx: true, routingButtons: ['A1', 'B3', 'X'] } }, { index: -1 }],
    buses: [{ index: 2, visibility: 'hidden' }],
  });
  assert.equal(layout.activePreset, 'Compact Daily');
  assert.deepEqual(layout.window, { width: 340, height: 620, alwaysOnTop: false });
  assert.equal(layout.presets[0].channels.length, 16);
  assert.deepEqual(layout.presets[0].channels[5], {
    visibility: 'hidden', customName: 'GAME', routeMask: 129,
    modules: { intellipan: false, audibility: false, eqFx: true },
  });
  assert.equal(layout.presets[0].channels[10].visibility, 'hidden');
  const profile = layout.presets[0];
  assert.equal(profile.showMasterSection, false);
  assert.equal(profile.showInputs, true);
  profile.showInputs = false;
  profile.modules.fxSends = false;
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), layout);
});

test('sing settings are validated with safe defaults', () => {
  assert.deepEqual(parseLayout(null).sing, { mic: 1, music: 64, duck: 10 });
  assert.deepEqual(parseLayout({ sing: { mic: 99, music: -1, duck: 500 } }).sing, { mic: 1, music: 64, duck: 30 });
});
