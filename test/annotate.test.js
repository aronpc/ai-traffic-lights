// Testes do annotator de conta Claude por sessão (src/annotate.js, extraído
// do main no fix do review): cache só do dir por pid (environ não muda),
// rótulo recomputado a cada ciclo — rename no tile propaga, environ ilegível
// não congela no default e pid reusado re-lê o environ. Deps de I/O mockadas;
// parseEnviron/accountLabel/agentOf REAIS (puras).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeAnnotator } = require('../src/annotate.js');
const { agentOf } = require('../src/agents.js');
const usage = require('../src/usage.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ann-'));

// Monta o annotator com environ/labels programáveis e conta as leituras.
function setup({ labels = {}, configs = {}, apis = {} } = {}) {
  const dir = tmp();
  const labelsFile = path.join(dir, 'account-labels.json');
  fs.writeFileSync(labelsFile, JSON.stringify(labels));
  const state = { environ: {}, reads: 0 };   // pid → raw do environ ('' = ilegível)
  const annotate = makeAnnotator({
    getEnviron: (pid) => { state.reads++; return state.environ[pid] !== undefined ? state.environ[pid] : ''; },
    parseEnviron: usage.parseEnviron,
    readClaudeConfig: (d) => configs[d] || null,          // dir → .claude.json parseado
    claudeAccountKey: usage.claudeAccountKey,
    accountLabel: usage.accountLabel,
    apiProviderFromSettings: (d) => apis[d] || null,
    agentOf,
    labelsFile,
    fs,
  });
  const env = (pid, raw) => { state.environ[pid] = raw; };
  const sess = (pid, session_id, extra = {}) => ({
    session_id, pid, cwd: '/p', agent: 'claude', last_event: 'Stop', last_event_ts: 1, ...extra,
  });
  return { annotate, state, env, sess, labelsFile, dir };
}

const RAW_A = 'PATH=/x\0CLAUDE_CONFIG_DIR=/home/u/.prof-a\0TERM=xterm\0';

test('anota o rótulo da conta do CLAUDE_CONFIG_DIR (org name vence)', () => {
  const { annotate, env, sess } = setup({ configs: { '/home/u/.prof-a': { accountName: 'Org Alpha' } } });
  env(100, RAW_A);
  const s = sess(100, 's1');
  annotate([s]);
  assert.equal(s.account, 'Org Alpha');
});

test('review: rename no tile PROPAGA — rótulo recomputa a cada ciclo', () => {
  // O bug: o label era cacheado por pid; account-labels.json novo só era lido
  // para pid NOVO — o modal mostrava o rótulo velho até a sessão morrer.
  const t = setup({ configs: { '/home/u/.prof-a': { accountUuid: 'uuid-a', accountName: 'Org Alpha' } } });
  t.env(100, RAW_A);
  const s1 = t.sess(100, 's1');
  t.annotate([s1]);
  assert.equal(s1.account, 'Org Alpha');

  fs.writeFileSync(t.labelsFile, JSON.stringify({ 'uuid-a': 'Meu Apelido' }));
  const s2 = t.sess(100, 's1');                     // MESMA sessão, próximo ciclo
  t.annotate([s2]);
  assert.equal(s2.account, 'Meu Apelido', 'apelido novo vale no ciclo seguinte');
});

test('review: environ ilegível NÃO congela no default — retry no próximo ciclo', () => {
  // O bug: getProcessEnviron devolve '' na falha (pid morto/race de exec);
  // parseEnviron('') = {} → dir=null cacheado → conta default PARA SEMEMA,
  // mesmo quando o environ ficasse legível. Agora '' não entra no cache.
  const t = setup({ configs: { '/home/u/.prof-a': { accountName: 'Org Alpha' } } });
  t.env(100, '');                                   // ilegível neste ciclo
  let s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, undefined, 'sem rótulo quando não conseguiu ler');

  t.env(100, RAW_A);                                // legível no ciclo seguinte
  s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'Org Alpha', 'recuperou — nada foi cacheado da falha');
});

test('review: pid REUSADO por outro processo re-lê o environ (guard por session_id)', () => {
  // O bug: pid morre → novo processo pega o MESMO pid → cache hit → rótulo
  // da sessão ANTIGA. O hit agora exige o mesmo session_id.
  const t = setup({
    configs: {
      '/home/u/.prof-a': { accountName: 'Conta A' },
      '/home/u/.prof-b': { accountName: 'Conta B' },
    },
  });
  t.env(100, RAW_A);
  t.annotate([t.sess(100, 's1')]);
  t.env(100, 'CLAUDE_CONFIG_DIR=/home/u/.prof-b\0');
  const s2 = t.sess(100, 's2');                     // processo NOVO, mesmo pid
  t.annotate([s2]);
  assert.equal(s2.account, 'Conta B', 'pid reusado resolve a conta do processo novo');
});

test('cache do dir: mesma sessão NÃO re-lê o environ (1 leitura por sessão nova)', () => {
  const t = setup({ configs: { '/home/u/.prof-a': { accountName: 'Org Alpha' } } });
  t.env(100, RAW_A);
  t.annotate([t.sess(100, 's1')]);
  t.annotate([t.sess(100, 's1')]);
  t.annotate([t.sess(100, 's1')]);
  assert.equal(t.state.reads, 1, 'environ lido 1x — dir é imutável na vida do processo');

  t.annotate([]);                                   // sessão morreu → prune
  t.annotate([t.sess(100, 's1')]);                  // voltou (novo processo)
  assert.equal(t.state.reads, 2, 'prune derrubou o cache: re-leu');
});

test('sessão REMOTA não é anotada aqui (peer já anota na origem)', () => {
  const t = setup({});
  t.env(100, RAW_A);
  const s = t.sess(100, 'r1', { origin: 'peerhost' });
  t.annotate([s]);
  assert.equal(s.account, undefined);
  assert.equal(t.state.reads, 0, 'nem chegou a ler o environ local');
});

test('sufixo de API alternativa: "gh-claude · vm-contabo:20128"', () => {
  const t = setup({
    configs: { '/home/u/.gh-claude': { accountUuid: 'u-gh' } },   // sem nome → basename do dir
    apis: { '/home/u/.gh-claude': 'vm-contabo:20128' },
  });
  t.env(100, 'CLAUDE_CONFIG_DIR=/home/u/.gh-claude\0');
  const s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'gh-claude · vm-contabo:20128');
});

test('dir null (conta default do symlink) anota com o config do home', () => {
  const t = setup({ configs: { null: { accountName: 'Default' } } });
  t.env(100, 'PATH=/x\0TERM=xterm\0');              // environ sem CLAUDE_CONFIG_DIR
  const s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'Default', 'sem a var = conta default, lida e cacheada (válida)');
});
