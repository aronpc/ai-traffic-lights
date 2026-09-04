const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, isValidShortcut, mergeWithDefaults, updaterFlags, isPrerelease } = require('../src/settings.js');

test('isPrerelease: true só com sufixo de pre-release (canal beta)', () => {
  assert.equal(isPrerelease('0.7.4-beta.1'), true);
  assert.equal(isPrerelease('0.8.0-beta.3'), true);
  assert.equal(isPrerelease('0.7.3'), false);          // stable
  assert.equal(isPrerelease(undefined), false);
  assert.equal(isPrerelease(''), false);
});

test('isValidShortcut: aceita modificador + tecla', () => {
  assert.equal(isValidShortcut('Control+Alt+H'), true);
  assert.equal(isValidShortcut('CommandOrControl+Shift+Alt+L'), true);
  assert.equal(isValidShortcut('Super+Space'), true);
  assert.equal(isValidShortcut('Control+F5'), true);
});

test('isValidShortcut: rejeita sem modificador, token desconhecido, vazio', () => {
  assert.equal(isValidShortcut('H'), false);            // no modifier
  assert.equal(isValidShortcut('Control'), false);      // modifier only
  assert.equal(isValidShortcut('Control+'), false);     // empty key
  assert.equal(isValidShortcut('Control+Wibble'), false); // nonexistent token
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
  assert.equal(mergeWithDefaults({ showUsage: 'x' }).showUsage, true); // invalid → default
});

test('mergeWithDefaults: collapsed (estado da janela) default false, aceita bool', () => {
  assert.equal(DEFAULTS.collapsed, false);
  assert.equal(mergeWithDefaults({}).collapsed, false);
  assert.equal(mergeWithDefaults({ collapsed: true }).collapsed, true);
  assert.equal(mergeWithDefaults({ collapsed: 'x' }).collapsed, false); // invalid → default
});

test('mergeWithDefaults: opacity default 0.97, clampa em [0.6, 1.0]', () => {
  assert.equal(DEFAULTS.opacity, 0.97);
  assert.equal(mergeWithDefaults({}).opacity, 0.97);
  assert.equal(mergeWithDefaults({ opacity: 0.8 }).opacity, 0.8);
  assert.equal(mergeWithDefaults({ opacity: 0.3 }).opacity, 0.6);   // below → clamps
  assert.equal(mergeWithDefaults({ opacity: 2 }).opacity, 1.0);     // above → clamps
  assert.equal(mergeWithDefaults({ opacity: 'x' }).opacity, 0.97);  // non-number → default
  assert.equal(mergeWithDefaults({ opacity: NaN }).opacity, 0.97);  // NaN → default
});

test('mergeWithDefaults: markReadOnClick default true, aceita bool', () => {
  assert.equal(DEFAULTS.markReadOnClick, true);
  assert.equal(mergeWithDefaults({}).markReadOnClick, true);
  assert.equal(mergeWithDefaults({ markReadOnClick: false }).markReadOnClick, false);
  assert.equal(mergeWithDefaults({ markReadOnClick: 'x' }).markReadOnClick, true); // invalid → default
});

test('mergeWithDefaults: notifyOnReset default true, aceita bool', () => {
  assert.equal(DEFAULTS.notifyOnReset, true);
  assert.equal(mergeWithDefaults({}).notifyOnReset, true);
  assert.equal(mergeWithDefaults({ notifyOnReset: false }).notifyOnReset, false);
  assert.equal(mergeWithDefaults({ notifyOnReset: 'x' }).notifyOnReset, true); // invalid → default
});

test('mergeWithDefaults: resetNotifyThresholdPct default 90, clampa [1,100], arredonda', () => {
  assert.equal(DEFAULTS.resetNotifyThresholdPct, 90);
  assert.equal(mergeWithDefaults({}).resetNotifyThresholdPct, 90);
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 50 }).resetNotifyThresholdPct, 50);
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 0 }).resetNotifyThresholdPct, 1);     // below → clamps
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 150 }).resetNotifyThresholdPct, 100); // above → clamps
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 88.6 }).resetNotifyThresholdPct, 89); // rounds
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: 'x' }).resetNotifyThresholdPct, 90);  // non-number → default
  assert.equal(mergeWithDefaults({ resetNotifyThresholdPct: NaN }).resetNotifyThresholdPct, 90);  // NaN → default
});

test('mergeWithDefaults: soundEnabled default true, aceita bool', () => {
  assert.equal(DEFAULTS.soundEnabled, true);
  assert.equal(mergeWithDefaults({ soundEnabled: false }).soundEnabled, false);
  assert.equal(mergeWithDefaults({ soundEnabled: 'x' }).soundEnabled, true); // invalid → default
});

test('mergeWithDefaults: soundVolume default 0.18, clampa [0,1]', () => {
  assert.equal(DEFAULTS.soundVolume, 0.18);
  assert.equal(mergeWithDefaults({ soundVolume: 0.5 }).soundVolume, 0.5);
  assert.equal(mergeWithDefaults({ soundVolume: -1 }).soundVolume, 0);      // below → clamps
  assert.equal(mergeWithDefaults({ soundVolume: 5 }).soundVolume, 1);       // above → clamps
  assert.equal(mergeWithDefaults({ soundVolume: 'x' }).soundVolume, 0.18);  // non-number → default
});

test('mergeWithDefaults: soundType aceita presets + custom; inválido → default (beep)', () => {
  assert.equal(DEFAULTS.soundType, 'beep');
  assert.equal(mergeWithDefaults({ soundType: 'chime' }).soundType, 'chime');
  assert.equal(mergeWithDefaults({ soundType: 'custom' }).soundType, 'custom');
  assert.equal(mergeWithDefaults({ soundType: 'nope' }).soundType, 'beep'); // not supported
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
  assert.equal(mergeWithDefaults({ lang: 'de' }).lang, 'auto');   // not supported
  assert.equal(mergeWithDefaults({ lang: 42 }).lang, 'auto');     // wrong type
});

test('mergeWithDefaults: terminal aceita auto/ids/custom; inválido cai no default', () => {
  assert.equal(DEFAULTS.terminal, 'auto');
  assert.equal(mergeWithDefaults({ terminal: 'tilix' }).terminal, 'tilix');
  assert.equal(mergeWithDefaults({ terminal: 'custom' }).terminal, 'custom');
  assert.equal(mergeWithDefaults({ terminal: 'kitty' }).terminal, 'auto'); // not supported
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
  assert.deepEqual(mergeWithDefaults({ launchers: { claude: 9 } }).launchers, {}); // non-string value
  assert.deepEqual(mergeWithDefaults({ launchers: [] }).launchers, {});            // array, not object
  assert.deepEqual(mergeWithDefaults({ launchers: 'nope' }).launchers, {});
});

// ---- multi-machine sync (P2P): FULL OPT-IN, everything OFF by default ----
test('sync: default é TUDO off/seguro (enabled/share/shareTranscripts false)', () => {
  const s = DEFAULTS.sync;
  assert.equal(s.enabled, false, 'enabled off por padrão');
  assert.equal(s.share, false, 'share off por padrão');
  assert.equal(s.shareTranscripts, false, 'shareTranscripts off por padrão');
  assert.deepEqual(s.peers, [], 'sem peers por padrão');
  assert.equal(s.token, '', 'token vazio por padrão');
  assert.equal(typeof s.port, 'number', 'porta numérica');
});

test('sync: input vazio/podre → defaults (não vira undefined)', () => {
  assert.deepEqual(mergeWithDefaults({}).sync, DEFAULTS.sync);
  assert.deepEqual(mergeWithDefaults({ sync: 'lixo' }).sync, DEFAULTS.sync);
  assert.deepEqual(mergeWithDefaults({ sync: [] }).sync, DEFAULTS.sync);
});

test('sync: aceita campos válidos', () => {
  const s = mergeWithDefaults({
    sync: { enabled: true, share: true, shareTranscripts: true, port: 8080, token: 'sekret', node: 'alienware', peers: [{ name: 'srv', host: '100.64.0.2' }] },
  }).sync;
  assert.equal(s.enabled, true);
  assert.equal(s.share, true);
  assert.equal(s.shareTranscripts, true);
  assert.equal(s.port, 8080);
  assert.equal(s.token, 'sekret');
  assert.equal(s.node, 'alienware');
  assert.deepEqual(s.peers, [{ name: 'srv', host: '100.64.0.2' }]);
});

test('sync: booleanos inválidos → default false; porta clampada [1,65535]', () => {
  const s = mergeWithDefaults({ sync: { enabled: 'x', share: 1, port: 99999, port2: 0 } }).sync;
  assert.equal(s.enabled, false);
  assert.equal(s.share, false);
  assert.equal(s.port, 65535);          // above → clamps
  assert.equal(mergeWithDefaults({ sync: { port: 0 } }).sync.port, 1); // below → clamps
  assert.equal(mergeWithDefaults({ sync: { port: 'x' } }).sync.port, DEFAULTS.sync.port);
});

test('sync: peers saneados (sem host descarta; name fallback = host; teto 32)', () => {
  const s = mergeWithDefaults({ sync: { peers: [
    { name: 'ok', host: 'h1' },
    { name: 'semhost' },                  // discarded (no host)
    { host: 'h2' },                       // name fallback = host
    'nao-objeto',                         // discarded
    { name: 9, host: 123 },               // non-string host → discarded
  ] } }).sync;
  assert.deepEqual(s.peers, [{ name: 'ok', host: 'h1' }, { name: 'h2', host: 'h2' }]);
  const many = mergeWithDefaults({ sync: { peers: Array.from({ length: 40 }, (_, i) => ({ host: 'h' + i })) } }).sync;
  assert.equal(many.peers.length, 32, 'teto de 32 peers');
});

test('sync.allowAttach: default false + coerce boolean', () => {
  assert.equal(DEFAULTS.sync.allowAttach, false);
  assert.equal(mergeWithDefaults({ sync: { allowAttach: true } }).sync.allowAttach, true);
  assert.equal(mergeWithDefaults({ sync: { allowAttach: 'yes' } }).sync.allowAttach, false, 'não-boolean → default false');
});

// ---- update channel (stable / beta) ----
// The rule that matters most is the DEFAULT: anyone who touched nothing must
// stay on the stable channel, or a pre-release published on GitHub would leak to everyone.

test('updateChannel: default é stable e só aceita valores conhecidos', () => {
  assert.equal(DEFAULTS.updateChannel, 'stable');
  assert.equal(mergeWithDefaults(null).updateChannel, 'stable');
  assert.equal(mergeWithDefaults({}).updateChannel, 'stable');
  assert.equal(mergeWithDefaults({ updateChannel: 'beta' }).updateChannel, 'beta');
  assert.equal(mergeWithDefaults({ updateChannel: 'nightly' }).updateChannel, 'stable'); // unknown
  assert.equal(mergeWithDefaults({ updateChannel: 'dev' }).updateChannel, 'stable');     // a custom suffix is not a channel
  assert.equal(mergeWithDefaults({ updateChannel: true }).updateChannel, 'stable');      // wrong type
  assert.equal(mergeWithDefaults({ updateChannel: '' }).updateChannel, 'stable');
});

test('updaterFlags: stable nunca aceita pre-release', () => {
  assert.deepEqual(updaterFlags('stable', '0.7.3'),
    { allowPrerelease: false, allowDowngrade: false });
  // garbage/missing value falls back to stable — never opens the beta channel by accident
  assert.equal(updaterFlags(undefined, '0.7.3').allowPrerelease, false);
  assert.equal(updaterFlags(null, '0.7.3').allowPrerelease, false);
  assert.equal(updaterFlags('BETA', '0.7.3').allowPrerelease, false); // case-sensitive on purpose
});

test('updaterFlags: beta liga allowPrerelease e nunca downgrade', () => {
  assert.deepEqual(updaterFlags('beta', '0.7.3'),
    { allowPrerelease: true, allowDowngrade: false });
  assert.deepEqual(updaterFlags('beta', '0.7.4-beta.3'),
    { allowPrerelease: true, allowDowngrade: false });
});

test('updaterFlags: sair do canal beta libera o downgrade (0.7.4-beta.3 → 0.7.3)', () => {
  // Running a pre-release and asking for stable: without allowDowngrade the
  // app would be stuck on the beta, because 0.7.3 < 0.7.4-beta.3 in semver.
  assert.deepEqual(updaterFlags('stable', '0.7.4-beta.3'),
    { allowPrerelease: false, allowDowngrade: true });
  assert.equal(updaterFlags('stable', '1.0.0-beta.1').allowDowngrade, true);
  // already on stable, downgrade stays off — it would do nothing but harm
  assert.equal(updaterFlags('stable', '0.7.4').allowDowngrade, false);
  assert.equal(updaterFlags('stable', '').allowDowngrade, false);
  assert.equal(updaterFlags('stable', undefined).allowDowngrade, false);
});
