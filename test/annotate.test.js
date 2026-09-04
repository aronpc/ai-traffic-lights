// Tests for the per-session Claude account annotator (src/annotate.js,
// extracted from main in the review fix): dir-only cache per pid (environ
// doesn't change), label recomputed on every cycle — tile rename propagates,
// unreadable environ doesn't freeze on the default, and a reused pid re-reads
// the environ. I/O deps mocked; parseEnviron/accountLabel/agentOf REAL (pure).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeAnnotator } = require('../src/annotate.js');
const { agentOf } = require('../src/agents.js');
const usage = require('../src/usage.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-ann-'));

// Builds the annotator with programmable environ/labels and counts reads.
function setup({ labels = {}, configs = {}, apis = {} } = {}) {
  const dir = tmp();
  const labelsFile = path.join(dir, 'account-labels.json');
  fs.writeFileSync(labelsFile, JSON.stringify(labels));
  const state = { environ: {}, reads: 0 };   // pid → raw environ ('' = unreadable)
  const annotate = makeAnnotator({
    getEnviron: (pid) => { state.reads++; return state.environ[pid] !== undefined ? state.environ[pid] : ''; },
    parseEnviron: usage.parseEnviron,
    readClaudeConfig: (d) => configs[d] || null,          // dir → parsed .claude.json
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
  // The bug: the label was cached per pid; a new account-labels.json was only
  // read for a NEW pid — the modal showed the old label until the session died.
  const t = setup({ configs: { '/home/u/.prof-a': { accountUuid: 'uuid-a', accountName: 'Org Alpha' } } });
  t.env(100, RAW_A);
  const s1 = t.sess(100, 's1');
  t.annotate([s1]);
  assert.equal(s1.account, 'Org Alpha');

  fs.writeFileSync(t.labelsFile, JSON.stringify({ 'uuid-a': 'Meu Apelido' }));
  const s2 = t.sess(100, 's1');                     // SAME session, next cycle
  t.annotate([s2]);
  assert.equal(s2.account, 'Meu Apelido', 'apelido novo vale no ciclo seguinte');
});

test('review: environ ilegível NÃO congela no default — retry no próximo ciclo', () => {
  // The bug: getProcessEnviron returns '' on failure (dead pid/exec race);
  // parseEnviron('') = {} → dir=null cached → default account FOREVER, even
  // when the environ became readable. Now '' doesn't enter the cache.
  const t = setup({ configs: { '/home/u/.prof-a': { accountName: 'Org Alpha' } } });
  t.env(100, '');                                   // unreadable this cycle
  let s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, undefined, 'sem rótulo quando não conseguiu ler');

  t.env(100, RAW_A);                                // readable on the next cycle
  s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'Org Alpha', 'recuperou — nada foi cacheado da falha');
});

test('review: pid REUSADO por outro processo re-lê o environ (guard por session_id)', () => {
  // The bug: pid dies → a new process takes the SAME pid → cache hit → the
  // OLD session's label. The hit now requires the same session_id.
  const t = setup({
    configs: {
      '/home/u/.prof-a': { accountName: 'Conta A' },
      '/home/u/.prof-b': { accountName: 'Conta B' },
    },
  });
  t.env(100, RAW_A);
  t.annotate([t.sess(100, 's1')]);
  t.env(100, 'CLAUDE_CONFIG_DIR=/home/u/.prof-b\0');
  const s2 = t.sess(100, 's2');                     // NEW process, same pid
  t.annotate([s2]);
  assert.equal(s2.account, 'Conta B', 'pid reusado resolve a conta do processo novo');
});

test('review: sid SINTÉTICO (proc-<pid>) NÃO vale como cache hit — pid reciclado re-lê', () => {
  // The bug (CodeRabbit PR #63): the /proc discovery fabricates the sid as
  // `proc-<pid>`; a RECYCLED pid regenerates the SAME synthetic sid while
  // being ANOTHER process → `hit.sid === sid` served the previous process's
  // account. A synthetic sid never validates a hit (and never enters the
  // cache), so the environ is re-read every cycle.
  const t = setup({
    configs: {
      '/home/u/.prof-a': { accountName: 'Conta A' },
      '/home/u/.prof-b': { accountName: 'Conta B' },
    },
  });
  t.env(100, RAW_A);
  t.annotate([t.sess(100, 'proc-100')]);
  t.env(100, 'CLAUDE_CONFIG_DIR=/home/u/.prof-b\0');
  const s2 = t.sess(100, 'proc-100');              // recycled pid, SAME synthetic sid
  t.annotate([s2]);
  assert.equal(s2.account, 'Conta B', 'o sintético não autentica o processo: label do environ NOVO');
  assert.equal(t.state.reads, 2, 'cache não valeu — re-leu o environ');
});

test('cache do dir: mesma sessão NÃO re-lê o environ (1 leitura por sessão nova)', () => {
  const t = setup({ configs: { '/home/u/.prof-a': { accountName: 'Org Alpha' } } });
  t.env(100, RAW_A);
  t.annotate([t.sess(100, 's1')]);
  t.annotate([t.sess(100, 's1')]);
  t.annotate([t.sess(100, 's1')]);
  assert.equal(t.state.reads, 1, 'environ lido 1x — dir é imutável na vida do processo');

  t.annotate([]);                                   // session died → prune
  t.annotate([t.sess(100, 's1')]);                  // came back (new process)
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
    configs: { '/home/u/.gh-claude': { accountUuid: 'u-gh' } },   // no name → dir basename
    apis: { '/home/u/.gh-claude': 'vm-contabo:20128' },
  });
  t.env(100, 'CLAUDE_CONFIG_DIR=/home/u/.gh-claude\0');
  const s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'gh-claude · vm-contabo:20128');
});

test('dir null (conta default do symlink) anota com o config do home', () => {
  const t = setup({ configs: { null: { accountName: 'Default' } } });
  t.env(100, 'PATH=/x\0TERM=xterm\0');              // environ without CLAUDE_CONFIG_DIR
  const s = t.sess(100, 's1');
  t.annotate([s]);
  assert.equal(s.account, 'Default', 'sem a var = conta default, lida e cacheada (válida)');
});
