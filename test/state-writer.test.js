// The golden rule of the state file contract, as a test.
//
// "Preserve, don't regress" lived only in prose (docs/ARCHITECTURE.md) and was
// therefore violated: the Kiro adapter wiped transcript_path and the focus
// fields on every event — finding 08 of the PR #46 review. A rule in a comment
// is a suggestion.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { atomicWrite, mergeState, PRESERVADOS } = require('../src/state-writer.js');

test('mergeState: chave de TERCEIRO sobrevive a um evento que não a conhece', () => {
  // the case that actually broke: the overlay's backfillModels() writes
  // transcript_path, and the adapter's next event wiped it.
  const ex = { session_id: 's', transcript_path: '/t.jsonl', campo_de_outro: 42 };
  const out = mergeState(ex, { last_event: 'Stop' });
  assert.equal(out.transcript_path, '/t.jsonl');
  assert.equal(out.campo_de_outro, 42, 'chave desconhecida não pode ser apagada');
  assert.equal(out.last_event, 'Stop');
});

test('mergeState: campos preservados não regridem para null', () => {
  const ex = {};
  for (const k of PRESERVADOS) ex[k] = `valor-${k}`;
  const out = mergeState(ex, { last_event: 'PreToolUse', cwd: null, windowid: undefined });
  for (const k of PRESERVADOS) assert.equal(out[k], `valor-${k}`, `${k} regrediu`);
});

test('mergeState: patch com valor REAL sobrescreve o preservado', () => {
  const out = mergeState({ cwd: '/velho', model: 'antigo' }, { cwd: '/novo' });
  assert.equal(out.cwd, '/novo', 'o evento sabe mais que o state quando traz valor');
  assert.equal(out.model, 'antigo');
});

test('mergeState: campo preservado ausente nos dois lados vira null explícito', () => {
  const out = mergeState({}, { last_event: 'Stop' });
  for (const k of PRESERVADOS) assert.equal(out[k], null, `${k} deveria ser null`);
});

test('mergeState: events é append-only e para em 50', () => {
  const ex = { events: Array.from({ length: 50 }, (_, i) => ({ ts: i, event: 'PreToolUse' })) };
  const out = mergeState(ex, {}, { ts: 999, event: 'Stop' });
  assert.equal(out.events.length, 50, 'teto de 50');
  assert.equal(out.events.at(-1).event, 'Stop', 'o novo entra no fim');
  assert.equal(out.events[0].ts, 1, 'o mais antigo sai (era ts=0)');
});

test('mergeState: sem evento, o histórico fica intacto', () => {
  const ex = { events: [{ ts: 1, event: 'Stop' }] };
  assert.deepEqual(mergeState(ex, { model: 'x' }).events, ex.events);
});

test('mergeState: entrada degenerada não lança', () => {
  for (const e of [null, undefined, 'lixo', 42]) {
    const out = mergeState(e, { last_event: 'Stop' });
    assert.equal(out.last_event, 'Stop');
  }
});

// ---- atomicWrite ----

function fsFalso() {
  const arquivos = new Map();
  return {
    arquivos,
    writeFileSync: (p, d) => arquivos.set(p, d),
    renameSync: (a, b) => { arquivos.set(b, arquivos.get(a)); arquivos.delete(a); },
  };
}

test('atomicWrite: escreve no .tmp e só então renomeia (leitor nunca vê meio arquivo)', () => {
  const io = fsFalso();
  const ordem = [];
  const espiao = {
    writeFileSync: (p, d) => { ordem.push(`write ${p}`); io.writeFileSync(p, d); },
    renameSync: (a, b) => { ordem.push(`rename ${a} → ${b}`); io.renameSync(a, b); },
  };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, espiao), true);
  assert.deepEqual(ordem, ['write /s/x.json.tmp', 'rename /s/x.json.tmp → /s/x.json']);
  assert.equal(io.arquivos.get('/s/x.json'), '{"a":1}');
  assert.equal(io.arquivos.has('/s/x.json.tmp'), false, 'não deixa .tmp órfão');
});

test('atomicWrite: falha de I/O devolve false em vez de lançar', () => {
  // an adapter runs inside the host process: an exception here takes the app down.
  const explode = { writeFileSync: () => { throw new Error('ENOSPC'); }, renameSync: () => {} };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, explode), false);
  const explodeNoRename = { writeFileSync: () => {}, renameSync: () => { throw new Error('EACCES'); } };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, explodeNoRename), false);
});

// ---- contrato do notification_type ----

test('mergeState: notification_type é limpo quando o evento não é Notification', () => {
  // docs/ARCHITECTURE.md: "null unless last_event == Notification". The hook
  // rewrites it on every event; preserving it would make computeState classify
  // the NEXT untyped notification by the previous one's discriminator.
  const ex = { last_event: 'Notification', notification_type: 'permission_prompt' };
  assert.equal(mergeState(ex, { last_event: 'Stop' }).notification_type, null);
  assert.equal(mergeState(ex, { last_event: 'PreToolUse' }).notification_type, null);
});

test('mergeState: notification_type vem do PATCH, nunca do state anterior', () => {
  // this test used to assert the opposite and hid the hole: a NEW Notification
  // without a type inherited the previous discriminator, and computeState
  // classified it by the wrong reason. The field describes the CURRENT event.
  const ex = { last_event: 'Notification', notification_type: 'permission_prompt' };
  assert.equal(mergeState(ex, { last_event: 'Notification' }).notification_type, null,
    'Notification sem tipo não herda o tipo da anterior');
  assert.equal(mergeState(ex, { last_event: 'Notification', notification_type: 'idle_prompt' }).notification_type,
    'idle_prompt', 'o tipo do patch manda');
});

test('mergeState: patch degenerado não lança (o catch cego do adapter engoliria)', () => {
  for (const p of [undefined, null, 'lixo', 42]) {
    assert.doesNotThrow(() => mergeState({ a: 1 }, p));
  }
});

test('atomicWrite: rename que falha não deixa .tmp órfão', () => {
  // the payload was already written; without cleanup the .tmp stays forever
  // (readers filter by `.json` and never collect it).
  const arquivos = new Map();
  const io = {
    writeFileSync: (p, d) => arquivos.set(p, d),
    renameSync: () => { throw new Error('EACCES'); },
    unlinkSync: (p) => arquivos.delete(p),
  };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, io), false);
  assert.equal(arquivos.has('/s/x.json.tmp'), false, '.tmp deveria ter sido removido');
});
