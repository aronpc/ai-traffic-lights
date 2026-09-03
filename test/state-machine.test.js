// Tests for the pure functions: computeState / iconFor (state-machine.js) and
// agentOf (agents.js). Run with `node --test` (native, no dependencies).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeState, iconFor, sortByUrgency, groupBreaks } = require('../src/state-machine.js');
const { agentOf } = require('../src/agents.js');

const NOW = 1_800_000_000;                 // fixed epoch (deterministic tests)
const state = (last_event, agoSec = 0) => ({ last_event, last_event_ts: NOW - agoSec });

test('computeState: eventos de processamento → amarelo/tool', () => {
  for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    assert.deepEqual(computeState(state(e), NOW), { level: 'processing', reason: 'tool' }, e);
  }
});

test('computeState: razões explícitas de "precisa de você" → vermelho', () => {
  assert.deepEqual(computeState(state('PermissionRequest'), NOW), { level: 'awaiting', reason: 'permission' });
  assert.deepEqual(computeState(state('Question'), NOW), { level: 'awaiting', reason: 'question' });
  assert.deepEqual(computeState(state('PostToolUseFailure'), NOW), { level: 'awaiting', reason: 'error' });
  assert.deepEqual(computeState(state('Notification'), NOW), { level: 'awaiting', reason: 'question' }, 'sem tipo → vermelho conservador');
});

test('computeState: readAt rebaixa vermelho → read (cinza) quando cobre o evento', () => {
  // session red due to permission, event at NOW-10
  const s = state('PermissionRequest', 10);        // last_event_ts = NOW - 10
  // without readAt → normal red
  assert.deepEqual(computeState(s, NOW), { level: 'awaiting', reason: 'permission' });
  // readAt >= last_event_ts → READ (gray), keeps the reason
  assert.deepEqual(computeState(s, NOW, null, NOW - 10), { level: 'read', reason: 'permission' });
  assert.deepEqual(computeState(s, NOW, null, NOW), { level: 'read', reason: 'permission' });
});

test('computeState: evento vermelho NOVO (ts > readAt) reacende', () => {
  // marked read at NOW-100, but the event is more recent (NOW-5)
  const s = state('PostToolUseFailure', 5);        // last_event_ts = NOW - 5
  assert.deepEqual(computeState(s, NOW, null, NOW - 100), { level: 'awaiting', reason: 'error' },
    'notificação nova depois da marca → volta a vermelho');
});

test('computeState: readAt NÃO afeta amarelo nem verde', () => {
  // processing (yellow) never turns gray
  assert.deepEqual(computeState(state('PreToolUse'), NOW, null, NOW), { level: 'processing', reason: 'tool' });
  // done (green) never turns gray
  assert.deepEqual(computeState(state('Stop'), NOW, null, NOW), { level: 'done', reason: 'ok' });
});

test('computeState: idle escalado (awaiting) também pode ser marcado lido', () => {
  // old Stop → escalated to awaiting/idle; readAt covering it → read
  const s = state('Stop', 400);                    // > threshold default (300s)
  assert.deepEqual(computeState(s, NOW, null), { level: 'awaiting', reason: 'idle' });
  assert.deepEqual(computeState(s, NOW, null, NOW - 400), { level: 'read', reason: 'idle' });
});

test('iconFor: nível read → 👁', () => {
  assert.equal(iconFor({ level: 'read', reason: 'permission' }), '👁');
});

test('sortByUrgency: read vai pro fim (menos urgente que done)', () => {
  const mk = (level, ts) => ({ s: { last_event_ts: ts }, st: { level } });
  const out = sortByUrgency([mk('read', 100), mk('awaiting', 50), mk('done', 80), mk('processing', 90)]);
  assert.deepEqual(out.map((x) => x.st.level), ['awaiting', 'processing', 'done', 'read']);
});

test('computeState: Notification classifica por notification_type (não por message)', () => {
  const notif = (type) => ({ ...state('Notification'), notification_type: type });
  // benign → green (auth/elicitation completed/answered)
  for (const t of ['auth_success', 'elicitation_complete', 'elicitation_response']) {
    assert.deepEqual(computeState(notif(t), NOW), { level: 'done', reason: 'ok' }, `${t} → benigno`);
  }
  // needs you → red
  for (const t of ['permission_prompt', 'idle_prompt', 'elicitation_dialog']) {
    assert.deepEqual(computeState(notif(t), NOW), { level: 'awaiting', reason: 'question' }, `${t} → vermelho`);
  }
  // unknown type → conservative red (don't risk a false green)
  assert.deepEqual(computeState(notif('new_future_type'), NOW), { level: 'awaiting', reason: 'question' }, 'desconhecido → vermelho');
});

test('computeState: SessionStart → verde (não escala, mesmo antigo)', () => {
  assert.deepEqual(computeState(state('SessionStart'), NOW), { level: 'done', reason: 'ok' });
  assert.deepEqual(computeState(state('SessionStart', 9999), NOW), { level: 'done', reason: 'ok' });
});

test('computeState: Stop recente → verde', () => {
  assert.deepEqual(computeState(state('Stop', 10), NOW), { level: 'done', reason: 'ok' });
});

test('computeState: escalada idle só no Stop, limite 5min', () => {
  assert.deepEqual(computeState(state('Stop', 299), NOW), { level: 'done', reason: 'ok' }, 'abaixo do limite');
  assert.deepEqual(computeState(state('Stop', 301), NOW), { level: 'awaiting', reason: 'idle' }, 'acima do limite');
  // SessionEnd/SessionStart do NOT escalate even when idle
  assert.deepEqual(computeState(state('SessionEnd', 9999), NOW), { level: 'done', reason: 'ok' });
});

test('computeState: evento desconhecido → verde conservador', () => {
  assert.deepEqual(computeState(state('ativo'), NOW), { level: 'done', reason: null });
});

test('sortByUrgency: urgência primária (🔴>🟡>🟢>read); mesmo nível = ESTÁVEL por origem+id (local agrupa antes dos peers)', () => {
  const mk = (level, id, origin) => ({ s: { session_id: id, origin: origin || 'local', last_event_ts: 0 }, st: { level } });
  // green, 2 reds (local + remote), yellow — shuffled input order
  const ranked = [mk('done', 'd1'), mk('awaiting', 'r1', 'local'), mk('processing', 'p1'), mk('awaiting', 'r2', 'notebook-hg')];
  const out = sortByUrgency(ranked).map((r) => `${r.st.level}:${r.s.origin}:${r.s.session_id}`);
  assert.deepEqual(out, ['awaiting:local:r1', 'awaiting:notebook-hg:r2', 'processing:local:p1', 'done:local:d1']);
});

test('sortByUrgency: local antes dos peers mesmo quando o hostname ordena antes (alienware < local)', () => {
  const mk = (level, id, origin) => ({ s: { session_id: id, origin: origin || 'local', last_event_ts: 0 }, st: { level } });
  // 'alienware' < 'local' alphabetically — before the fix (plain origin string),
  // the peer came before local (PR-32 #20).
  const ranked = [mk('done', 'a1', 'alienware'), mk('done', 'l1', 'local'), mk('done', 'z9', 'notebook-hg')];
  const out = sortByUrgency(ranked).map((r) => `${r.s.origin}:${r.s.session_id}`);
  assert.deepEqual(out, ['local:l1', 'alienware:a1', 'notebook-hg:z9'], 'local primeiro (peso 0), depois peers em ordem alfabética');
});

test('sortByUrgency: não muta o array original', () => {
  const ranked = [{ s: { last_event_ts: 2 }, st: { level: 'done' } }, { s: { last_event_ts: 1 }, st: { level: 'awaiting' } }];
  const snap = ranked.map((r) => r.st.level);
  sortByUrgency(ranked);
  assert.deepEqual(ranked.map((r) => r.st.level), snap, 'original intacto');
});

// ---- sortByUrgency originFirst (#54): contiguous host blocks ----
test('sortByUrgency {originFirst}: origem é chave primária — peer 🔴 NÃO invade o bloco local', () => {
  const mk = (level, id, origin) => ({ s: { session_id: id, origin: origin || 'local', last_event_ts: 0 }, st: { level } });
  // same scenario as the test above, but with originFirst: urgency (peer 🔴)
  // orders WITHIN the block, not between blocks — without this the peer's
  // header would show up in the MIDDLE of the local rows (fragmented block).
  const ranked = [mk('done', 'd1'), mk('awaiting', 'r1', 'local'), mk('processing', 'p1'), mk('awaiting', 'r2', 'notebook-hg')];
  const out = sortByUrgency(ranked, { originFirst: true }).map((r) => `${r.s.origin}:${r.s.session_id}`);
  assert.deepEqual(out, ['local:r1', 'local:p1', 'local:d1', 'notebook-hg:r2'],
    'bloco local contíguo (urgência interna), depois o peer');
});

test('sortByUrgency {originFirst}: peers entre si em ordem alfabética, blocos contíguos', () => {
  const mk = (level, id, origin) => ({ s: { session_id: id, origin, last_event_ts: 0 }, st: { level } });
  const ranked = [mk('done', 'z1', 'zeta'), mk('awaiting', 'a1', 'alpha'), mk('processing', 'l1', 'local')];
  const out = sortByUrgency(ranked, { originFirst: true }).map((r) => `${r.s.origin}:${r.s.session_id}`);
  assert.deepEqual(out, ['local:l1', 'alpha:a1', 'zeta:z1'], 'local, depois peers A→Z, cada um contíguo');
});

// ---- groupBreaks (#54): block cuts by origin in an already sorted list ----
test('groupBreaks: um corte por transição de origem, com count e startIdx', () => {
  const mk = (id, origin) => ({ s: { session_id: id, origin }, st: { level: 'done' } });
  // list ALREADY sorted (sortByUrgency): 2 local, 2 from peer A, 1 from peer B
  const ordered = [mk('l1'), mk('l2'), mk('a1', 'alpha'), mk('a2', 'alpha'), mk('b1', 'beta')];
  assert.deepEqual(groupBreaks(ordered), [
    { origin: 'local', startIdx: 0, count: 2, worst: 'done' },
    { origin: 'alpha', startIdx: 2, count: 2, worst: 'done' },
    { origin: 'beta', startIdx: 4, count: 1, worst: 'done' },
  ]);
});

test('groupBreaks: worst é o nível mais urgente do bloco (awaiting > processing > done > read)', () => {
  const mk = (id, origin, level) => ({ s: { session_id: id, origin }, st: { level } });
  const ordered = [mk('r1', 'local', 'read'), mk('d1', 'local', 'done'), mk('p1', 'alpha', 'processing'), mk('a1', 'alpha', 'awaiting')];
  const breaks = groupBreaks(ordered);
  assert.equal(breaks[0].worst, 'done', 'done mais urgente que read');
  assert.equal(breaks[1].worst, 'awaiting', 'awaiting mais urgente que processing');
});

test('groupBreaks: lista vazia e bloco único', () => {
  assert.deepEqual(groupBreaks([]), []);
  const mk = (id) => ({ s: { session_id: id, origin: 'local' }, st: { level: 'done' } });
  assert.deepEqual(groupBreaks([mk('l1'), mk('l2')]), [{ origin: 'local', startIdx: 0, count: 2, worst: 'done' }], '1 bloco = 1 corte');
});

test('sortByUrgency: mesmo nível NÃO reordena por timestamp (estável — evita a lista pular a cada evento)', () => {
  // 2 done with swapped timestamps: order is by identity, not by ts.
  const ranked = [
    { s: { session_id: 'a', origin: 'local', last_event_ts: 10 }, st: { level: 'done' } },
    { s: { session_id: 'b', origin: 'local', last_event_ts: 90 }, st: { level: 'done' } },
  ];
  assert.deepEqual(sortByUrgency(ranked).map((r) => r.s.session_id), ['a', 'b'], 'estável por id (não pula quando ts muda)');
});

test('iconFor: cada reason tem seu ícone; fallback por level', () => {
  assert.equal(iconFor({ level: 'awaiting', reason: 'permission' }), '🔑');
  assert.equal(iconFor({ level: 'awaiting', reason: 'error' }), '⚠');
  assert.equal(iconFor({ level: 'awaiting', reason: 'question' }), '❓');
  assert.equal(iconFor({ level: 'awaiting', reason: 'idle' }), '⏰');
  assert.equal(iconFor({ level: 'processing', reason: 'tool' }), '🛠');
  assert.equal(iconFor({ level: 'done', reason: 'ok' }), '✓');
  assert.equal(iconFor({ level: 'processing', reason: null }), '🛠', 'fallback processing');
  assert.equal(iconFor({ level: 'done', reason: null }), '✓', 'fallback done');
});

test('agentOf: resolve agente conhecido, cai no default (claude) senão', () => {
  assert.equal(agentOf({ agent: 'claude' }), 'claude');
  assert.equal(agentOf({ agent: 'antigravity' }), 'antigravity');
  assert.equal(agentOf({ agent: 'opencode' }), 'opencode');
  assert.equal(agentOf({ agent: 'inexistente' }), 'claude', 'agente fora do registro → default');
  assert.equal(agentOf({}), 'claude', 'sem campo agent (state v1) → default');
  assert.equal(agentOf(null), 'claude', 'null → default');
});
