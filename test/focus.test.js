// Testes da lógica pura de click-to-focus (issue #1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseWindowId, pickWindow, tabChannel } = require('../src/focus.js');

test('parseWindowId: hex, decimal, inválidos', () => {
  assert.equal(parseWindowId('0x06a00007'), 0x06a00007);
  assert.equal(parseWindowId('50332154'), 50332154);
  assert.equal(parseWindowId(50332154), 50332154);
  assert.equal(parseWindowId(null), null);
  assert.equal(parseWindowId(''), null);
  assert.equal(parseWindowId('lixo'), null);
});

const wins = [
  { id: '0x0a', idNum: 0x0a, pid: 100 }, // outra app
  { id: '0x0b', idNum: 0x0b, pid: 200 }, // terminal da sessão
  { id: '0x0c', idNum: 0x0c, pid: 200 }, // 2ª janela do mesmo terminal
];

test('#1/H2 pickWindow: windowid válido (pid da sessão) é usado', () => {
  assert.equal(pickWindow('0x0b', wins, new Set([200, 999])), '0x0b');
});

test('#1/H2 pickWindow: windowid obsoleto/reciclado (pid alheio) é DESCARTADO', () => {
  // 0x0a existe mas pertence a outra app (pid 100 ∉ ancestrais) → não ativa
  // essa janela; cai na 1ª janela da sessão (pid 200).
  assert.equal(pickWindow('0x0a', wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: windowid ausente → 1ª janela da sessão', () => {
  assert.equal(pickWindow(null, wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: windowid inexistente na lista → fallback por pid', () => {
  assert.equal(pickWindow('0xff', wins, new Set([200])), '0x0b');
});

test('#1/H2 pickWindow: nenhuma janela da sessão → null (nada a ativar)', () => {
  assert.equal(pickWindow('0xff', wins, new Set([777])), null);
});

test('#1 tabChannel: Warp → xdg-open da focus_url', () => {
  assert.deepEqual(
    tabChannel({ focus_url: 'warp://session/abc', term_program: 'WarpTerminal' }),
    { kind: 'warp', value: 'warp://session/abc' },
  );
});

test('#1 tabChannel: Tilix → gdbus com o tilix_id', () => {
  assert.deepEqual(
    tabChannel({ tilix_id: '5b95bf87-uuid', term_program: 'tilix' }),
    { kind: 'tilix', value: '5b95bf87-uuid' },
  );
});

test('#1 tabChannel: focus_url tem precedência sobre tilix_id', () => {
  assert.deepEqual(
    tabChannel({ focus_url: 'warp://session/x', tilix_id: 'y' }),
    { kind: 'warp', value: 'warp://session/x' },
  );
});

test('#1 tabChannel: sem canal (gnome-terminal etc.) → null', () => {
  assert.equal(tabChannel({ term_program: 'gnome-terminal' }), null);
  assert.equal(tabChannel({}), null);
  assert.equal(tabChannel(null), null);
  // focus_url não-warp é ignorado (allowlist de esquema)
  assert.equal(tabChannel({ focus_url: 'http://evil' }), null);
});
