// Regressão #56 (chaves cruzadas): rewriteKeyOrigin traduz o segmento de
// origem de uma sessionKey entre namespaces — o overlay do receptor conhece a
// sessão como 'peer:1234', a ORIGEM conhece como 'local:1234', e a marca de
// lido postada precisa chegar no namespace de quem aplica.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originOf, sessionKey, rewriteKeyOrigin } = require('../src/identity.js');

test('rewriteKeyOrigin: peer→local (o caso do POST /read — quem clica postà na origem)', () => {
  assert.equal(rewriteKeyOrigin('peer:1234', 'peer', 'local'), 'local:1234');
  assert.equal(rewriteKeyOrigin('notebook-hg:9876', 'notebook-hg', 'local'), 'local:9876');
});

test('rewriteKeyOrigin: local→peer (sentido inverso — ida e volta fecha)', () => {
  assert.equal(rewriteKeyOrigin('local:1234', 'local', 'peer'), 'peer:1234');
  // ida e volta = chave original
  const ida = rewriteKeyOrigin('peer:1234', 'peer', 'local');
  assert.equal(rewriteKeyOrigin(ida, 'local', 'peer'), 'peer:1234');
});

test('rewriteKeyOrigin: origem vazia da chave é o próprio namespace local', () => {
  // sessionKey nunca gera isso (sempre prefixa), mas a função é tolerante:
  assert.equal(rewriteKeyOrigin('local', 'local', 'peer'), 'peer');
  assert.equal(rewriteKeyOrigin('peer', 'peer', 'local'), 'local');
});

test('rewriteKeyOrigin: chave que NÃO casa com from volta intacta', () => {
  assert.equal(rewriteKeyOrigin('other:1234', 'peer', 'local'), 'other:1234');
  // armadilha do prefixo: 'peer-x' começa com 'peer' mas não com 'peer:'
  assert.equal(rewriteKeyOrigin('peer-x:1', 'peer', 'local'), 'peer-x:1');
});

test('rewriteKeyOrigin: entrada inválida → string vazia, nunca exceção', () => {
  assert.equal(rewriteKeyOrigin('', 'peer', 'local'), '');
  assert.equal(rewriteKeyOrigin(null, 'peer', 'local'), '');
  assert.equal(rewriteKeyOrigin(undefined, 'peer', 'local'), '');
  assert.equal(rewriteKeyOrigin(1234, 'peer', 'local'), '');
});

test('rewriteKeyOrigin: from ausente assume local (default do originOf)', () => {
  assert.equal(rewriteKeyOrigin('local:1234', undefined, 'peer'), 'peer:1234');
  assert.equal(rewriteKeyOrigin('local:1234', '', 'peer'), 'peer:1234');
});

// guarda dos irmãos que já existiam (não é regressão do #56, é sanidade do módulo)
test('sessionKey/originOf continuam íntegros', () => {
  assert.equal(originOf({}), 'local');
  assert.equal(originOf({ origin: 'peer' }), 'peer');
  assert.equal(sessionKey({ pid: 42 }), 'local:42');
  assert.equal(sessionKey({ origin: 'p', session_id: 'abc' }), 'p:abc');
  assert.equal(sessionKey(null), '');
});
