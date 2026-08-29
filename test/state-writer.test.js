// Regra de ouro do contrato de state file, em teste.
//
// "Preserve, don't regress" vivia só em prosa (docs/ARCHITECTURE.md) e por isso
// foi violada: o adapter do Kiro apagava transcript_path e os campos de foco a
// cada evento — achado 08 do review da PR #46. Regra em comentário é sugestão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { atomicWrite, mergeState, PRESERVADOS } = require('../src/state-writer.js');

test('mergeState: chave de TERCEIRO sobrevive a um evento que não a conhece', () => {
  // o caso que quebrou de verdade: o backfillModels() do overlay escreve
  // transcript_path, e o evento seguinte do adapter o apagava.
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
  // um adapter roda dentro do processo do host: exceção aqui derruba o app.
  const explode = { writeFileSync: () => { throw new Error('ENOSPC'); }, renameSync: () => {} };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, explode), false);
  const explodeNoRename = { writeFileSync: () => {}, renameSync: () => { throw new Error('EACCES'); } };
  assert.equal(atomicWrite('/s/x.json', { a: 1 }, explodeNoRename), false);
});
