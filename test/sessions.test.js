// Testes do merge/dedup de sessões (regressão: Tilix sumia por term_program null).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeSessions } = require('../src/sessions.js');

const TILIX = { session_id: 's-tilix', pid: 3553176, agent: 'claude', term_program: null, last_event: 'Stop', last_event_ts: 100 };
const WARP = { session_id: 's-warp', pid: 3308681, agent: 'claude', term_program: 'WarpTerminal', last_event: 'Stop', last_event_ts: 100 };

test('sessão com term_program=null (Tilix) NÃO é mais descartada', () => {
  const out = mergeSessions([TILIX], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 's-tilix');
});

test('mescla state files + descobertos via /proc, sem duplicar por pid', () => {
  // WARP e TILIX têm state file; o 3º claude (3759491) só via /proc
  const discovered = [{ pid: 3308681, agent: 'claude' }, { pid: 3759491, agent: 'claude' }];
  const out = mergeSessions([WARP, TILIX], discovered);
  const pids = out.map((s) => s.pid).sort();
  assert.deepEqual(pids, [3308681, 3553176, 3759491]);
  // o WARP (já tem state file) não ganha entrada proc- duplicada
  assert.equal(out.filter((s) => s.pid === 3308681).length, 1);
});

test('dedupe por pid mantém o evento mais recente', () => {
  const a = { session_id: 'a', pid: 9, last_event_ts: 100 };
  const b = { session_id: 'b', pid: 9, last_event_ts: 200 };
  const out = mergeSessions([a, b], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'b', 'ficou o mais recente');
});

test('pid ausente dedupe por session_id (nunca colide)', () => {
  const out = mergeSessions([
    { session_id: 'x', pid: null, last_event_ts: 1 },
    { session_id: 'y', pid: null, last_event_ts: 1 },
  ], []);
  assert.equal(out.length, 2);
});

test('sem term_program filter: headless-fiction e real coexistem só por pid', () => {
  // não há mais gate por term_program — quem aparece é decidido em outra camada
  const out = mergeSessions([
    { session_id: 'h', pid: 1, term_program: null, last_event_ts: 5 },
  ], []);
  assert.equal(out.length, 1);
});

test('discovered sem state file vira entrada proc-', () => {
  const out = mergeSessions([], [{ pid: 42, agent: 'opencode' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'proc-42');
  assert.equal(out[0].agent, 'opencode');
  assert.equal(out[0].term_program, 'terminal');
});

test('inputs vazios/nulos → []', () => {
  assert.deepEqual(mergeSessions([], []), []);
  assert.deepEqual(mergeSessions(null, null), []);
});

// ---- fase 1 (sync P2P): dedup namespaced por origin ----
test('mesmo pid em origens diferentes NÃO colide (namespacing)', () => {
  // Duas máquinas podem ter o mesmo pid (ex.: 1234). Sem o prefixo origin,
  // uma sobrescreveria a outra no dedup. Elas são linhas distintas.
  const out = mergeSessions([
    { session_id: 'local-a', pid: 1234, origin: 'local', last_event_ts: 10 },
    { session_id: 'peer-a', pid: 1234, origin: 'alienware', last_event_ts: 20 },
  ], []);
  assert.equal(out.length, 2, 'mesmo pid, origens diferentes → 2 linhas');
  assert.ok(out.some((s) => s.origin === 'local' && s.session_id === 'local-a'));
  assert.ok(out.some((s) => s.origin === 'alienware' && s.session_id === 'peer-a'));
});

test('origin default = local quando ausente (state file legado / proc)', () => {
  const out = mergeSessions([{ session_id: 's', pid: 7, last_event_ts: 1 }], []);
  assert.equal(out[0].origin, 'local', 'recebe origin=local');
  // discovered (proc) também
  const p = mergeSessions([], [{ pid: 99, agent: 'claude' }]);
  assert.equal(p[0].origin, 'local');
});

test('mesmo pid + mesma origin ainda dedupe (mantém mais recente)', () => {
  const out = mergeSessions([
    { session_id: 'a', pid: 5, origin: 'local', last_event_ts: 100 },
    { session_id: 'b', pid: 5, origin: 'local', last_event_ts: 200 },
  ], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'b');
});
