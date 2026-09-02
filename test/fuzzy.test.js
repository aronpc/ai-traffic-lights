// Testes do matcher fuzzy (#55): subsequência case-insensitive com score por
// contiguidade e boundary de palavra, e o filtro de sessão que o usa.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fuzzyScore, sessionMatches } = require('../src/fuzzy.js');

test('fuzzyScore: subsequência em ordem casa; falta de char → -1', () => {
  assert.ok(fuzzyScore('tra', 'ai-traffic-light') >= 0, 'subsequência presente');
  assert.ok(fuzzyScore('atl', 'ai-traffic-light') >= 0, 'espalhada também casa (score menor)');
  assert.equal(fuzzyScore('ttt', 'ai-traffic-light'), -1, '3 t não existem');
  assert.equal(fuzzyScore('lig', 'traffic'), -1, 'fora de ordem não é subsequência');
});

test('fuzzyScore: case-insensitive e acento não é magicamente casado', () => {
  assert.ok(fuzzyScore('TRA', 'traffic') >= 0);
  assert.ok(fuzzyScore('Tra', 'AI-Traffic-Light') >= 0);
  assert.equal(fuzzyScore('tra', ''), -1, 'texto vazio nunca casa');
});

test('fuzzyScore: contiguidade e boundary pontuam mais que casamento espalhado', () => {
  // "lig" no INÍCIO de "lights" (boundary + contíguo) > "lig" espalhado em "beligerante"
  const bom = fuzzyScore('lig', 'lights');
  const ruim = fuzzyScore('lig', 'beligerante');
  assert.ok(bom > ruim, `boundary+contíguo (${bom}) deve superar meio de palavra (${ruim})`);
  // contíguo puro: "tra" seguido em "traffic" > "tra" espalhado em "t..r..a"
  assert.ok(fuzzyScore('tra', 'traffic') > fuzzyScore('tra', 'tortoise-rabbit-anteater'),
    'chars seguidos pontuam mais que espalhados');
});

test('fuzzyScore: query vazia é match neutro (0) — sem busca ativa', () => {
  assert.equal(fuzzyScore('', 'qualquer'), 0);
});

test('fuzzyScore: espaços da query são flexíveis', () => {
  assert.ok(fuzzyScore('tra lig', 'ai-traffic-light') >= 0, 'espaço casa com o hífen/posição qualquer');
});

test('sessionMatches: casa label, origin, model e tmux_session', () => {
  const s = {
    session_id: 's1', pid: 42, cwd: '/home/dev/api-server',
    origin: 'notebook-hg', model: 'glm-5.2', tmux_session: 'work-main',
  };
  assert.ok(sessionMatches('api', s, 'api-server'), 'pelo label (basename do cwd)');
  assert.ok(sessionMatches('note', s, 'api-server'), 'pela máquina de origem');
  assert.ok(sessionMatches('glm', s, 'api-server'), 'pelo modelo');
  assert.ok(sessionMatches('main', s, 'api-server'), 'pela sessão tmux');
  assert.ok(sessionMatches('SERV', s, 'api-server'), 'case-insensitive no campo');
  assert.equal(sessionMatches('zzz', s, 'api-server'), false, 'nada casa');
  assert.equal(sessionMatches('api', s, ''), false, 'label vazio e nenhum outro campo casa');
});

test('sessionMatches: query vazia → sempre true (sem filtro)', () => {
  assert.equal(sessionMatches('', { cwd: '/x' }, 'x'), true);
});

test('sessionMatches: objeto sessão ausente não explode', () => {
  assert.equal(sessionMatches('abc', null, 'abc'), true, 'o label ainda casa');
  assert.equal(sessionMatches('zzz', null, 'abc'), false);
});
