const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validSessionId, shellQuote, desktopEscape, boundsOnScreen } = require('../src/validate.js');

test('validSessionId: aceita IDs seguros', () => {
  assert.equal(validSessionId('abc-123'), true);
  assert.equal(validSessionId('8fbb3b6e-ba84-4a0f-be3f-dcd4290936ac'), true);
  assert.equal(validSessionId('proc_42'), true);
  assert.equal(validSessionId('a.b'), true);
});

test('validSessionId: REJEITA path traversal e caracteres perigosos', () => {
  assert.equal(validSessionId('../foo'), false);
  assert.equal(validSessionId('../../etc/passwd'), false);
  assert.equal(validSessionId('a/b'), false, 'barra =Traversal real');
  assert.equal(validSessionId('a b'), false, 'espaço');
  assert.equal(validSessionId('a;b'), false);
  // ".." alone is NOT traversal: it becomes the filename "..json" INSIDE STATE_DIR
  // (without '/' there is no directory escape). Allowing it is harmless and useful for IDs.
  assert.equal(validSessionId('..'), true);
  assert.equal(validSessionId(''), false, 'vazio');
  assert.equal(validSessionId(null), false);
  assert.equal(validSessionId(123), false);
  assert.equal(validSessionId('a'.repeat(300)), false, 'comprimento absurdo');
});

test('shellQuote: envolve caminho simples em aspas', () => {
  assert.equal(shellQuote('/home/user/bin/hook.sh'), "'/home/user/bin/hook.sh'");
});

test('shellQuote: escapa aspas simples internas', () => {
  assert.equal(shellQuote("/home/a b/c'd"), "'/home/a b/c'\\''d'");
});

test('shellQuote: path com espaço fica seguro p/ shell', () => {
  // the result, evaluated by bash, expands to a single argument
  assert.equal(shellQuote('/home/my dir/x'), "'/home/my dir/x'");
});

test('desktopEscape: escapa espaço e reservados', () => {
  assert.equal(desktopEscape('/home/my dir/app'), '/home/my\\ dir/app');
  assert.equal(desktopEscape('a"b'), 'a\\"b');
  assert.equal(desktopEscape('a$b'), 'a\\$b');
});

test('desktopEscape: path sem reservados fica intacto', () => {
  assert.equal(desktopEscape('/usr/bin/electron'), '/usr/bin/electron');
});

// ---- boundsOnScreen: saved position vs active screens (PR-32 #19) ----
// Real 3-monitor layout: [left 0..1920] [primary 1920..4480] [right 4480..6400].
// Before, the Terminal window validated only against the PRIMARY and silently
// discarded the position of whoever was on the side monitors, on every reopen.
const DISPLAYS = [
  { workArea: { x: 0,    y: 0, width: 1920, height: 1080 } },   // left
  { workArea: { x: 1920, y: 0, width: 2560, height: 1080 } },   // primary
  { workArea: { x: 4480, y: 0, width: 1920, height: 1080 } },   // right
];

test('boundsOnScreen: posição em QUALQUER monitor é preservada (multi-monitor)', () => {
  assert.equal(boundsOnScreen({ x: 200,  y: 300 }, DISPLAYS), true, 'monitor esquerdo');
  assert.equal(boundsOnScreen({ x: 2400, y: 300 }, DISPLAYS), true, 'monitor primário');
  assert.equal(boundsOnScreen({ x: 5000, y: 300 }, DISPLAYS), true, 'monitor direito');
});

test('boundsOnScreen: fora de todas as telas (monitor desconectado) → false', () => {
  assert.equal(boundsOnScreen({ x: 9999, y: 300 }, DISPLAYS), false, 'além da última tela');
  assert.equal(boundsOnScreen({ x: -500, y: 300 }, DISPLAYS), false, 'antes da primeira');
  assert.equal(boundsOnScreen({ x: 200, y: 5000 }, DISPLAYS), false, 'y fora');
});

test('boundsOnScreen: bordas — início inclusivo, fim exclusivo', () => {
  assert.equal(boundsOnScreen({ x: 1920, y: 0 }, DISPLAYS), true,  'x na borda esquerda do primário');
  assert.equal(boundsOnScreen({ x: 6400, y: 0 }, DISPLAYS), false, 'x no fim exato do último (exclusivo)');
});

test('boundsOnScreen: entrada inválida → false (nunca lança)', () => {
  assert.equal(boundsOnScreen(null, DISPLAYS), false);
  assert.equal(boundsOnScreen({}, DISPLAYS), false);
  assert.equal(boundsOnScreen({ x: '200', y: 300 }, DISPLAYS), false, 'x string');
  assert.equal(boundsOnScreen({ x: 200, y: 300 }, null), false, 'sem displays');
  assert.equal(boundsOnScreen({ x: 200, y: 300 }, [null, {}]), false, 'displays podres');
});
