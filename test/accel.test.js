const { test } = require('node:test');
const assert = require('node:assert/strict');
const { accelFromEvent, keyFromCode, keyFromChar } = require('../src/accel.js');
const { isValidShortcut } = require('../src/settings.js');

// Minimal keydown event: only what accelFromEvent reads.
const ev = (code, key, mods = {}) => ({
  code, key,
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
});

test('keyFromCode: accepts the settings.js subset and rejects the rest', () => {
  assert.equal(keyFromCode('KeyH'), 'H');
  assert.equal(keyFromCode('Digit1'), '1');
  assert.equal(keyFromCode('F12'), 'F12');
  assert.equal(keyFromCode('Space'), 'Space');
  assert.equal(keyFromCode('ArrowUp'), 'Up');
  assert.equal(keyFromCode('ControlLeft'), null);   // a modifier is not a key
  assert.equal(keyFromCode('Numpad5'), null);       // outside the accepted subset
  assert.equal(keyFromCode(''), null);
  assert.equal(keyFromCode(undefined), null);
});

// The regression behind this module: on macOS Option composes a character, so
// Option+H arrives as e.key = "˙" — which never matched [A-Z0-9]. Capture used
// to return null, making any Alt shortcut impossible to set on the Mac.
test('accelFromEvent: captures Alt on macOS, where e.key arrives composed', () => {
  const acc = accelFromEvent(ev('KeyH', '˙', { ctrl: true, alt: true, shift: true }));
  assert.equal(acc, 'Control+Alt+Shift+H');
  assert.equal(isValidShortcut(acc), true);         // main can actually register it
});

test('accelFromEvent: Shift on the number row does not turn into a symbol', () => {
  assert.equal(accelFromEvent(ev('Digit1', '!', { ctrl: true, shift: true })), 'Control+Shift+1');
});

test('accelFromEvent: e.key is the fallback when there is no usable code', () => {
  assert.equal(accelFromEvent(ev('', 'h', { ctrl: true, alt: true })), 'Control+Alt+H');
  assert.equal(accelFromEvent(ev(undefined, ' ', { meta: true })), 'Super+Space');
  assert.equal(keyFromChar('f5'), 'F5');
  assert.equal(keyFromChar('˙'), null);
});

test('accelFromEvent: null while only modifiers are held', () => {
  assert.equal(accelFromEvent(ev('ControlLeft', 'Control', { ctrl: true })), null);
  assert.equal(accelFromEvent(ev('AltLeft', 'Alt', { alt: true })), null);
});

test('accelFromEvent: modifier order is stable (Control+Alt+Shift+Super)', () => {
  const acc = accelFromEvent(ev('KeyL', 'l', { shift: true, ctrl: true, meta: true, alt: true }));
  assert.equal(acc, 'Control+Alt+Shift+Super+L');
});
