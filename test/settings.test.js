const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, isValidShortcut, mergeWithDefaults } = require('../src/settings.js');

test('isValidShortcut: aceita modificador + tecla', () => {
  assert.equal(isValidShortcut('Control+Alt+H'), true);
  assert.equal(isValidShortcut('CommandOrControl+Shift+Alt+L'), true);
  assert.equal(isValidShortcut('Super+Space'), true);
  assert.equal(isValidShortcut('Control+F5'), true);
});

test('isValidShortcut: rejeita sem modificador, token desconhecido, vazio', () => {
  assert.equal(isValidShortcut('H'), false);            // sem modificador
  assert.equal(isValidShortcut('Control'), false);      // só modificador
  assert.equal(isValidShortcut('Control+'), false);     // tecla vazia
  assert.equal(isValidShortcut('Control+Wibble'), false); // token inexistente
  assert.equal(isValidShortcut(''), false);
  assert.equal(isValidShortcut(null), false);
  assert.equal(isValidShortcut(123), false);
});

test('mergeWithDefaults: defaults quando input vazio/podre', () => {
  assert.deepEqual(mergeWithDefaults(null), DEFAULTS);
  assert.deepEqual(mergeWithDefaults({}), DEFAULTS);
  assert.deepEqual(mergeWithDefaults('lixo'), DEFAULTS);
});

test('mergeWithDefaults: aceita só valores válidos, descarta o resto', () => {
  const m = mergeWithDefaults({ idleThresholdSec: 120, escalateIdle: false, shortcut: 'Super+Space' });
  assert.equal(m.idleThresholdSec, 120);
  assert.equal(m.escalateIdle, false);
  assert.equal(m.shortcut, 'Super+Space');
});

test('mergeWithDefaults: idle inválido cai no default, não em undefined', () => {
  assert.equal(mergeWithDefaults({ idleThresholdSec: -5 }).idleThresholdSec, DEFAULTS.idleThresholdSec);
  assert.equal(mergeWithDefaults({ idleThresholdSec: 'x' }).idleThresholdSec, DEFAULTS.idleThresholdSec);
  assert.equal(mergeWithDefaults({ idleThresholdSec: 90.7 }).idleThresholdSec, 90); // floor
});

test('mergeWithDefaults: showUsage (footer uso vs launcher) default true, aceita bool', () => {
  assert.equal(DEFAULTS.showUsage, true);
  assert.equal(mergeWithDefaults({}).showUsage, true);
  assert.equal(mergeWithDefaults({ showUsage: false }).showUsage, false);
  assert.equal(mergeWithDefaults({ showUsage: 'x' }).showUsage, true); // inválido → default
});

test('mergeWithDefaults: collapsed (estado da janela) default false, aceita bool', () => {
  assert.equal(DEFAULTS.collapsed, false);
  assert.equal(mergeWithDefaults({}).collapsed, false);
  assert.equal(mergeWithDefaults({ collapsed: true }).collapsed, true);
  assert.equal(mergeWithDefaults({ collapsed: 'x' }).collapsed, false); // inválido → default
});

test('mergeWithDefaults: opacity default 0.97, clampa em [0.6, 1.0]', () => {
  assert.equal(DEFAULTS.opacity, 0.97);
  assert.equal(mergeWithDefaults({}).opacity, 0.97);
  assert.equal(mergeWithDefaults({ opacity: 0.8 }).opacity, 0.8);
  assert.equal(mergeWithDefaults({ opacity: 0.3 }).opacity, 0.6);   // abaixo → clampa
  assert.equal(mergeWithDefaults({ opacity: 2 }).opacity, 1.0);     // acima → clampa
  assert.equal(mergeWithDefaults({ opacity: 'x' }).opacity, 0.97);  // não-número → default
  assert.equal(mergeWithDefaults({ opacity: NaN }).opacity, 0.97);  // NaN → default
});

test('mergeWithDefaults: markReadOnClick default true, aceita bool', () => {
  assert.equal(DEFAULTS.markReadOnClick, true);
  assert.equal(mergeWithDefaults({}).markReadOnClick, true);
  assert.equal(mergeWithDefaults({ markReadOnClick: false }).markReadOnClick, false);
  assert.equal(mergeWithDefaults({ markReadOnClick: 'x' }).markReadOnClick, true); // inválido → default
});

test('mergeWithDefaults: notifyOnReset default true, aceita bool', () => {
  assert.equal(DEFAULTS.notifyOnReset, true);
  assert.equal(mergeWithDefaults({}).notifyOnReset, true);
  assert.equal(mergeWithDefaults({ notifyOnReset: false }).notifyOnReset, false);
  assert.equal(mergeWithDefaults({ notifyOnReset: 'x' }).notifyOnReset, true); // inválido → default
});

test('mergeWithDefaults: resetNotifyThresholdPct default 90, clampa [1,100], arredonda', () => {
  assert.equal(DEFAULTS.resetNotifyThresholdPct, 90);
  assert.equal(mergeWithDefaults({}).resetNotifyThresholdPct, 90);
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 50 }).resetNotifyThresholdPct, 50);
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 0 }).resetNotifyThresholdPct, 1);     // abaixo → clampa
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 150 }).resetNotifyThresholdPct, 100); // acima → clampa
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 88.6 }).resetNotifyThresholdPct, 89); // arredonda
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 'x' }).resetNotifyThresholdPct, 90);  // não-número → default
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: NaN }).resetNotifyThresholdPct, 90);  // NaN → default
});

test('mergeWithDefaults: soundEnabled default true, aceita bool', () => {
  assert.equal(DEFAULTS.soundEnabled, true);
  assert.equal(mergeWithDefaults({ soundEnabled: false }).soundEnabled, false);
  assert.equal(mergeWithDefaults({ soundEnabled: 'x' }).soundEnabled, true); // inválido → default
});

test('mergeWithDefaults: soundVolume default 0.18, clampa [0,1]', () => {
  assert.equal(DEFAULTS.soundVolume, 0.18);
  assert.equal(mergeWithDefaults({ soundVolume: 0.5 }).soundVolume, 0.5);
  assert.equal(mergeWithDefaults({ soundVolume: -1 }).soundVolume, 0);      // abaixo → clampa
  assert.equal(mergeWithDefaults({ soundVolume: 5 }).soundVolume, 1);       // acima → clampa
  assert.equal(mergeWithDefaults({ soundVolume: 'x' }).soundVolume, 0.18);  // não-número → default
});

test('mergeWithDefaults: soundType aceita presets + custom; inválido → default (beep)', () => {
  assert.equal(DEFAULTS.soundType, 'beep');
  assert.equal(mergeWithDefaults({ soundType: 'chime' }).soundType, 'chime');
  assert.equal(mergeWithDefaults({ soundType: 'custom' }).soundType, 'custom');
  assert.equal(mergeWithDefaults({ soundType: 'nope' }).soundType, 'beep'); // não suportado
  assert.equal(mergeWithDefaults({ soundType: 42 }).soundType, 'beep');
});

test('mergeWithDefaults: soundFile só aceita string curta', () => {
  assert.equal(mergeWithDefaults({ soundFile: '/x/alert.mp3' }).soundFile, '/x/alert.mp3');
  assert.equal(mergeWithDefaults({ soundFile: 9 }).soundFile, '');
  assert.equal(mergeWithDefaults({ soundFile: 'x'.repeat(4097) }).soundFile, '');
});

test('mergeWithDefaults: atalho inválido é ignorado (mantém default)', () => {
  assert.equal(mergeWithDefaults({ shortcut: 'H' }).shortcut, DEFAULTS.shortcut);
  assert.equal(mergeWithDefaults({ shortcut: 'Control+Que' }).shortcut, DEFAULTS.shortcut);
});

test('mergeWithDefaults: lang aceita auto/en/pt; inválido cai no default (auto)', () => {
  assert.equal(DEFAULTS.lang, 'auto');
  assert.equal(mergeWithDefaults({ lang: 'pt' }).lang, 'pt');
  assert.equal(mergeWithDefaults({ lang: 'en' }).lang, 'en');
  assert.equal(mergeWithDefaults({ lang: 'auto' }).lang, 'auto');
  assert.equal(mergeWithDefaults({ lang: 'de' }).lang, 'auto');   // não suportado
  assert.equal(mergeWithDefaults({ lang: 42 }).lang, 'auto');     // tipo errado
});

test('mergeWithDefaults: terminal aceita auto/ids/custom; inválido cai no default', () => {
  assert.equal(DEFAULTS.terminal, 'auto');
  assert.equal(mergeWithDefaults({ terminal: 'tilix' }).terminal, 'tilix');
  assert.equal(mergeWithDefaults({ terminal: 'custom' }).terminal, 'custom');
  assert.equal(mergeWithDefaults({ terminal: 'kitty' }).terminal, 'auto'); // não suportado
  assert.equal(mergeWithDefaults({ terminal: 1 }).terminal, 'auto');
});

test('mergeWithDefaults: terminalCmd só aceita string curta', () => {
  assert.equal(mergeWithDefaults({ terminalCmd: 'kitty -e {cmd}' }).terminalCmd, 'kitty -e {cmd}');
  assert.equal(mergeWithDefaults({ terminalCmd: 9 }).terminalCmd, '');
  assert.equal(mergeWithDefaults({ terminalCmd: 'x'.repeat(1001) }).terminalCmd, '');
});

test('mergeWithDefaults: launchers filtra pares chave/string válidos', () => {
  assert.deepEqual(mergeWithDefaults({ launchers: { claude: '/x/claude', gemini: '/y/gemini' } }).launchers,
    { claude: '/x/claude', gemini: '/y/gemini' });
  assert.deepEqual(mergeWithDefaults({ launchers: { claude: 9 } }).launchers, {}); // valor não-string
  assert.deepEqual(mergeWithDefaults({ launchers: [] }).launchers, {});            // array, não objeto
  assert.deepEqual(mergeWithDefaults({ launchers: 'nope' }).launchers, {});
});
