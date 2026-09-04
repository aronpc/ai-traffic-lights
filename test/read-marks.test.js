// Tests for the persistent state of read marks (#56): per-key LWW merge
// (highest readAt wins — an old mark NEVER "un-reads"), tolerant loading
// and tmpdir round-trip persistence in the pattern of the other modules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadReadMarks, saveReadMarks, applyMarks, reseedMarks } = require('../src/read-marks.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-rm-'));

test('applyMarks: LWW — maior readAt vence, menor não regride', () => {
  let { state } = applyMarks({}, [{ key: 'local:1', readAt: 100 }]);
  assert.equal(state['local:1'], 100);
  // NEWER mark applied
  ({ state } = applyMarks(state, [{ key: 'local:1', readAt: 200 }]));
  assert.equal(state['local:1'], 200, 'readAt maior substitui');
  // OLDER mark ignored (does not un-read)
  ({ state } = applyMarks(state, [{ key: 'local:1', readAt: 50 }]));
  assert.equal(state['local:1'], 200, 'readAt menor NUNCA regride');
  // EQUAL also doesn't count as applied (idempotent)
  const r = applyMarks(state, [{ key: 'local:1', readAt: 200 }]);
  assert.deepEqual(r.applied, [], 'mesma marca = nada aplicado');
});

test('applyMarks: applied traz SÓ o que mudou (o caller empurra isso ao renderer)', () => {
  const { state, applied } = applyMarks(
    { 'local:1': 100 },
    [
      { key: 'local:1', readAt: 300 },   // changes
      { key: 'local:2', readAt: 150 },   // new
      { key: 'local:1', readAt: 50 },    // old, ignored
    ],
  );
  assert.equal(state['local:1'], 300);
  assert.equal(state['local:2'], 150);
  assert.deepEqual(applied, [
    { key: 'local:1', readAt: 300 },
    { key: 'local:2', readAt: 150 },
  ]);
});

test('applyMarks: itens inválidos são pulados, lote não explode', () => {
  const { state, applied } = applyMarks({}, [
    null,
    {},
    { key: '', readAt: 10 },            // empty key
    { key: 'k', readAt: 0 },            // epoch 0 invalid
    { key: 'k', readAt: -5 },           // negative
    { key: 'k', readAt: 'abc' },        // non-numeric
    { key: 'k', readAt: 1.9 },          // fractional → floor
    { key: 'ok', readAt: '123' },       // numeric string ok
  ]);
  assert.equal(state.k, 1, '1.9 floored para 1');
  assert.equal(state.ok, 123, 'string numérica aceita');
  assert.equal(applied.length, 2);
});

test('applyMarks: marks não-array → estado intacto, nada aplicado', () => {
  const r1 = applyMarks({ 'local:1': 5 }, null);
  assert.deepEqual(r1.state, { 'local:1': 5 });
  assert.deepEqual(r1.applied, []);
  const r2 = applyMarks(null, [{ key: 'x', readAt: 9 }]);
  assert.equal(r2.state.x, 9, 'state inicial null não explode');
});

test('load/save roundtrip no tmpdir', () => {
  const dir = tmp();
  const f = path.join(dir, 'read-marks.json');
  const { state } = applyMarks({}, [{ key: 'local:1', readAt: 42 }, { key: 'peer:2', readAt: 43 }]);
  assert.equal(saveReadMarks(f, state), true);
  assert.deepEqual(loadReadMarks(f), { 'local:1': 42, 'peer:2': 43 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: arquivo ausente ou corrompido → {} (degradável, marca de leitura não é crítico)', () => {
  const dir = tmp();
  assert.deepEqual(loadReadMarks(path.join(dir, 'nope.json')), {}, 'ausente');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{não é json');
  assert.deepEqual(loadReadMarks(bad), {}, 'corrompido');
  // wrong types inside valid JSON also drop out
  const weird = path.join(dir, 'weird.json');
  fs.writeFileSync(weird, JSON.stringify({ 'local:1': 10, bad: 'x', neg: -1, arr: [1, 2] }));
  assert.deepEqual(loadReadMarks(weird), { 'local:1': 10 }, 'só entradas válidas sobrevivem');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save: falha de escrita → false, sem throw (dir inexistente)', () => {
  assert.equal(saveReadMarks('/dir/que/não/existe/rm.json', { a: 1 }), false);
});

// ---- reseedMarks: re-seeding the live keys on peer reconnection ----

test('reseedMarks: devolve o estado VIGENTE só das chaves pedidas', () => {
  const state = { 'peer:1': 100, 'peer:2': 200, 'local:9': 300 };
  assert.deepEqual(reseedMarks(state, ['peer:1', 'peer:2']), { 'peer:1': 100, 'peer:2': 200 });
  // key without a mark (live session never read) doesn't get in
  assert.deepEqual(reseedMarks(state, ['peer:3']), {});
  // empty / missing state
  assert.deepEqual(reseedMarks({}, ['peer:1']), {});
  assert.deepEqual(reseedMarks(null, ['peer:1']), {});
});

test('reseedMarks: keys com lixo não explodem (null/vazio/não-string/sobras)', () => {
  assert.deepEqual(reseedMarks({ 'peer:1': 10 }, [null, '', 42, 'peer:1']), { 'peer:1': 10 });
  assert.deepEqual(reseedMarks({ 'peer:1': 10 }, 'peer:1'), {}, 'keys não-array → vazio');
});

test('reseedMarks: marca fracionária vira floor (mesma higiene do load)', () => {
  assert.deepEqual(reseedMarks({ 'peer:1': 100.9 }, ['peer:1']), { 'peer:1': 100 });
});

test('regressão review #56: ciclo LWW-pula + reseed fecha a reconexão do peer', () => {
  // Measured scenario: peer connected, session read → mark persisted.
  let state = applyMarks({}, [{ key: 'peer:1234', readAt: 1000 }]).state;
  // Peer WENT DOWN: the renderer prunes the key (liveKeys without it) — MAIN's
  // state still has the mark, but the renderer lost it. Peer CAME BACK: the
  // poll re-anchors readIdleSec and the recomputed mark arrives EQUAL to the persisted one...
  const r = applyMarks(state, [{ key: 'peer:1234', readAt: 1000 }]);
  assert.deepEqual(r.applied, [], 'LWW pula a marca igual — nada é empurrado ao vivo');
  // ...and THIS is where the session went back to red: with no push, the
  // renderer doesn't re-hydrate. reseed returns the standing mark of the live key:
  assert.deepEqual(reseedMarks(r.state, ['peer:1234']), { 'peer:1234': 1000 });
});
