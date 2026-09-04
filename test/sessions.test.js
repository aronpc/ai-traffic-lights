// Tests for session merge/dedup (regression: Tilix vanished due to null term_program).
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
  // WARP and TILIX have state files; the 3rd claude (3759491) only via /proc
  const discovered = [{ pid: 3308681, agent: 'claude' }, { pid: 3759491, agent: 'claude' }];
  const out = mergeSessions([WARP, TILIX], discovered);
  const pids = out.map((s) => s.pid).sort();
  assert.deepEqual(pids, [3308681, 3553176, 3759491]);
  // WARP (already has a state file) doesn't get a duplicate proc- entry
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
  // there is no term_program gate anymore — who shows up is decided in another layer
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

// ---- phase 1 (P2P sync): dedup namespaced by origin ----
test('mesmo pid em origens diferentes NÃO colide (namespacing)', () => {
  // Two machines can have the same pid (e.g. 1234). Without the origin
  // prefix, one would overwrite the other in dedup. They are distinct rows.
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
  // discovered (proc) too
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

// ---- headless: discovered sem terminal entra com a flag (e SEM term_program) ----
test('discovered headless: flag headless=true e term_program=null', () => {
  const out = mergeSessions([], [{ pid: 4242, agent: 'claude', headless: true }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'proc-4242');
  assert.equal(out[0].headless, true, 'flag preservada no merge');
  assert.equal(out[0].term_program, null, "'terminal' seria mentira — não há shell embaixo");
});
