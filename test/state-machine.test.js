// Testes das funções puras: computeState / iconFor (state-machine.js) e
// agentOf (agents.js). Rodam com `node --test` (nativo, sem dependências).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeState, iconFor, sortByUrgency } = require('../src/state-machine.js');
const { agentOf } = require('../src/agents.js');

const NOW = 1_800_000_000;                 // epoch fixo (testes determinísticos)
const state = (last_event, agoSec = 0) => ({ last_event, last_event_ts: NOW - agoSec });

test('computeState: eventos de processamento → amarelo/tool', () => {
  for (const e of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
    assert.deepEqual(computeState(state(e), NOW), { level: 'processing', reason: 'tool' }, e);
  }
});

test('computeState: razões explícitas de "precisa de você" → vermelho', () => {
  assert.deepEqual(computeState(state('PermissionRequest'), NOW), { level: 'awaiting', reason: 'permission' });
  assert.deepEqual(computeState(state('PostToolUseFailure'), NOW), { level: 'awaiting', reason: 'error' });
  assert.deepEqual(computeState(state('Notification'), NOW), { level: 'awaiting', reason: 'question' });
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
  // SessionEnd/SessionStart NÃO escalam mesmo idle
  assert.deepEqual(computeState(state('SessionEnd', 9999), NOW), { level: 'done', reason: 'ok' });
});

test('computeState: evento desconhecido → verde conservador', () => {
  assert.deepEqual(computeState(state('ativo'), NOW), { level: 'done', reason: null });
});

test('sortByUrgency: vermelhos no topo; dentro de awaiting a mais antiga primeiro', () => {
  const mk = (level, ts) => ({ s: { last_event_ts: ts }, st: { level } });
  // verde novo (100), vermelho recente (200), amarelo (300), vermelho antigo (50)
  const ranked = [mk('done', 100), mk('awaiting', 200), mk('processing', 300), mk('awaiting', 50)];
  const out = sortByUrgency(ranked).map((r) => `${r.st.level}:${r.s.last_event_ts}`);
  assert.deepEqual(out, ['awaiting:50', 'awaiting:200', 'processing:300', 'done:100'], '🔴(antigo) → 🔴(novo) → 🟡 → 🟢');
});

test('sortByUrgency: não muta o array original', () => {
  const ranked = [{ s: { last_event_ts: 2 }, st: { level: 'done' } }, { s: { last_event_ts: 1 }, st: { level: 'awaiting' } }];
  const snap = ranked.map((r) => r.st.level);
  sortByUrgency(ranked);
  assert.deepEqual(ranked.map((r) => r.st.level), snap, 'original intacto');
});

test('sortByUrgency: dentro de done/processing o mais recente vem primeiro', () => {
  const ranked = [
    { s: { last_event_ts: 10 }, st: { level: 'done' } },
    { s: { last_event_ts: 90 }, st: { level: 'done' } },
  ];
  assert.deepEqual(sortByUrgency(ranked).map((r) => r.s.last_event_ts), [90, 10], 'recente antes');
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
  assert.equal(agentOf({ agent: 'gemini' }), 'gemini');
  assert.equal(agentOf({ agent: 'opencode' }), 'opencode');
  assert.equal(agentOf({ agent: 'inexistente' }), 'claude', 'agente fora do registro → default');
  assert.equal(agentOf({}), 'claude', 'sem campo agent (state v1) → default');
  assert.equal(agentOf(null), 'claude', 'null → default');
});
