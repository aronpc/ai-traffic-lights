// Testes do estado persistente das marcas de leitura (#56): merge LWW por
// chave (maior readAt vence — uma marca velha NUNCA "des-lê"), carga tolerante
// e gravação roundtrip no padrão tmpdir dos outros módulos.
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
  // marca mais NOVA aplicada
  ({ state } = applyMarks(state, [{ key: 'local:1', readAt: 200 }]));
  assert.equal(state['local:1'], 200, 'readAt maior substitui');
  // marca mais VELHA ignorada (não des-lê)
  ({ state } = applyMarks(state, [{ key: 'local:1', readAt: 50 }]));
  assert.equal(state['local:1'], 200, 'readAt menor NUNCA regride');
  // IGUAL também não conta como aplicada (idempotente)
  const r = applyMarks(state, [{ key: 'local:1', readAt: 200 }]);
  assert.deepEqual(r.applied, [], 'mesma marca = nada aplicado');
});

test('applyMarks: applied traz SÓ o que mudou (o caller empurra isso ao renderer)', () => {
  const { state, applied } = applyMarks(
    { 'local:1': 100 },
    [
      { key: 'local:1', readAt: 300 },   // muda
      { key: 'local:2', readAt: 150 },   // nova
      { key: 'local:1', readAt: 50 },    // velha, ignorada
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
    { key: '', readAt: 10 },            // chave vazia
    { key: 'k', readAt: 0 },            // epoch 0 inválido
    { key: 'k', readAt: -5 },           // negativo
    { key: 'k', readAt: 'abc' },        // não-numérico
    { key: 'k', readAt: 1.9 },          // fracionário → floor
    { key: 'ok', readAt: '123' },       // string numérica ok
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
  // tipos errados dentro de JSON válido também caem fora
  const weird = path.join(dir, 'weird.json');
  fs.writeFileSync(weird, JSON.stringify({ 'local:1': 10, bad: 'x', neg: -1, arr: [1, 2] }));
  assert.deepEqual(loadReadMarks(weird), { 'local:1': 10 }, 'só entradas válidas sobrevivem');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save: falha de escrita → false, sem throw (dir inexistente)', () => {
  assert.equal(saveReadMarks('/dir/que/não/existe/rm.json', { a: 1 }), false);
});

// ---- reseedMarks: re-semeadura das chaves vivas na reconexão do peer ----

test('reseedMarks: devolve o estado VIGENTE só das chaves pedidas', () => {
  const state = { 'peer:1': 100, 'peer:2': 200, 'local:9': 300 };
  assert.deepEqual(reseedMarks(state, ['peer:1', 'peer:2']), { 'peer:1': 100, 'peer:2': 200 });
  // chave sem marca (sessão viva nunca lida) não entra
  assert.deepEqual(reseedMarks(state, ['peer:3']), {});
  // estado vazio / ausente
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
  // Cenário medido: peer conectado, sessão lida → marca persistida.
  let state = applyMarks({}, [{ key: 'peer:1234', readAt: 1000 }]).state;
  // Peer CAIU: o renderer poda a chave (liveKeys sem ela) — o estado do MAIN
  // continua com a marca, mas o renderer perdeu. Peer VOLTOU: o poll re-ancora
  // o readIdleSec e a marca recomputada chega IGUAL à persistida...
  const r = applyMarks(state, [{ key: 'peer:1234', readAt: 1000 }]);
  assert.deepEqual(r.applied, [], 'LWW pula a marca igual — nada é empurrado ao vivo');
  // ...e é AQUI que a sessão voltava vermelha: sem push, o renderer não
  // re-hidrata. O reseed devolve a marca vigente da chave viva:
  assert.deepEqual(reseedMarks(r.state, ['peer:1234']), { 'peer:1234': 1000 });
});
