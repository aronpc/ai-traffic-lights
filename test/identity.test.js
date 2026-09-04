// Regression #56 (crossed keys): rewriteKeyOrigin translates the origin
// segment of a sessionKey between namespaces — the receiving overlay knows
// the session as 'peer:1234', the ORIGIN knows it as 'local:1234', and the
// posted read mark must arrive in the applier's namespace.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originOf, sessionKey, rewriteKeyOrigin, isLocalSession } = require('../src/identity.js');

test('rewriteKeyOrigin: peer→local (o caso do POST /read — quem clica postà na origem)', () => {
  assert.equal(rewriteKeyOrigin('peer:1234', 'peer', 'local'), 'local:1234');
  assert.equal(rewriteKeyOrigin('notebook-hg:9876', 'notebook-hg', 'local'), 'local:9876');
});

test('rewriteKeyOrigin: local→peer (sentido inverso — ida e volta fecha)', () => {
  assert.equal(rewriteKeyOrigin('local:1234', 'local', 'peer'), 'peer:1234');
  // round trip = original key
  const ida = rewriteKeyOrigin('peer:1234', 'peer', 'local');
  assert.equal(rewriteKeyOrigin(ida, 'local', 'peer'), 'peer:1234');
});

test('rewriteKeyOrigin: origem vazia da chave é o próprio namespace local', () => {
  // sessionKey never produces this (always prefixes), but the function is tolerant:
  assert.equal(rewriteKeyOrigin('local', 'local', 'peer'), 'peer');
  assert.equal(rewriteKeyOrigin('peer', 'peer', 'local'), 'local');
});

test('rewriteKeyOrigin: chave que NÃO casa com from volta intacta', () => {
  assert.equal(rewriteKeyOrigin('other:1234', 'peer', 'local'), 'other:1234');
  // prefix trap: 'peer-x' starts with 'peer' but not with 'peer:'
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

// guard for the siblings that already existed (not an #56 regression, module sanity)
test('sessionKey/originOf continuam íntegros', () => {
  assert.equal(originOf({}), 'local');
  assert.equal(originOf({ origin: 'peer' }), 'peer');
  assert.equal(sessionKey({ pid: 42 }), 'local:42');
  assert.equal(sessionKey({ origin: 'p', session_id: 'abc' }), 'p:abc');
  assert.equal(sessionKey(null), '');
});

// ================= review fix #7: REMOTE session pid in local /proc =================
// claudeAccountsFromSessions / glmCredsFromSessions / codexCwdsFromSessions
// read the environ/cwd of the pid of EVERY session — including the ones from
// sync, whose pid is a process ON THE PEER. A pid collision with an unrelated
// local process fabricated a phantom account/bar. isLocalSession is the
// filter.
test('isLocalSession: local é sem origin OU origin "local"; peer NÃO é', () => {
  assert.equal(isLocalSession({ pid: 123 }), true, 'collect não seta origin');
  assert.equal(isLocalSession({ pid: 123, origin: 'local' }), true, 'state file grava local');
  assert.equal(isLocalSession({ pid: 123, origin: 'notebook-hg' }), false, 'pollPeers seta o nome do peer');
});

test('isLocalSession: null/undefined NÃO é local (call sites fazem skip)', () => {
  assert.equal(isLocalSession(null), false);
  assert.equal(isLocalSession(undefined), false);
});
