// claude-config.test.js — resolução dos paths do Claude Code (config dir vivo
// vs legado congelado no HOME) + a integração com readClaudeConfig/readClaudeCreds
// (o bug do #58: ler ~/.claude.json congelado em vez de <configdir>/.claude.json).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cc = require('../src/claude-config.js');
const usage = require('../src/usage.js');

// Troca $HOME e $CLAUDE_CONFIG_DIR de verdade e chama SEM injeção — exerce o
// caminho de produção real (os.homedir() lê $HOME a cada chamada no POSIX;
// configDir consulta a env var sem parâmetro nenhum). Restaura no finally.
function withProdEnv(home, cfgdir, fn) {
  const hadHome = process.env.HOME, hadCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  if (cfgdir == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = cfgdir;
  try { return fn(); } finally {
    if (hadHome == null) delete process.env.HOME; else process.env.HOME = hadHome;
    if (hadCfg == null) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = hadCfg;
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atl-cc-'));

test('configCandidates: sem env → <home>/.claude/.claude.json primeiro, legado no fim', () => {
  const h = tmp();
  withProdEnv(h, null, () => {
    assert.deepEqual(cc.configCandidates(), [
      path.join(h, '.claude', '.claude.json'),
      path.join(h, '.claude.json'),
    ]);
  });
});

test('configCandidates: CLAUDE_CONFIG_DIR existente vence o default', () => {
  const h = tmp();
  const dir = tmp();   // dir "de verdade" — statSync passa
  withProdEnv(h, dir, () => {
    assert.deepEqual(cc.configCandidates(), [
      path.join(dir, '.claude.json'),
      path.join(h, '.claude.json'),
    ]);
  });
});

test('configCandidates: env inexistente é IGNORADO (cai no default)', () => {
  const h = tmp();
  withProdEnv(h, path.join(h, 'nao-existe'), () => {
    assert.equal(cc.configDir(), path.join(h, '.claude'));
  });
});

test('configDir: home injetado isola do CLAUDE_CONFIG_DIR ambiente (sandbox de teste)', () => {
  // a var setada apontando pra outro lugar NÃO pode vazar dentro do fixture
  const h = tmp();
  const other = tmp();
  withProdEnv(other, other, () => {
    assert.equal(cc.configDir({ home: h }), path.join(h, '.claude'));
  });
});

test('credsFile: sempre dentro do config dir (env vence default)', () => {
  const h = tmp();
  withProdEnv(h, null, () => assert.equal(cc.credsFile(), path.join(h, '.claude', '.credentials.json')));
  const dir = tmp();
  withProdEnv(h, dir, () => assert.equal(cc.credsFile(), path.join(dir, '.credentials.json')));
});

test('projectsRoots: env primeiro + históricos, deduplicado', () => {
  const h = tmp();
  withProdEnv(h, null, () => {
    assert.deepEqual(cc.projectsRoots(), [
      path.join(h, '.claude', 'projects'),
      path.join(h, '.zclaude', 'projects'),
    ]);
  });
  const dir = tmp();
  withProdEnv(h, dir, () => {
    assert.deepEqual(cc.projectsRoots(), [
      path.join(dir, 'projects'),
      path.join(h, '.claude', 'projects'),
      path.join(h, '.zclaude', 'projects'),
    ]);
  });
  // env apontando para o próprio default → sem duplicata
  withProdEnv(h, path.join(h, '.claude'), () => {
    assert.deepEqual(cc.projectsRoots(), [
      path.join(h, '.claude', 'projects'),
      path.join(h, '.zclaude', 'projects'),
    ]);
  });
});

// ---- integração: o bug do arquivo congelado (home injetado = isolado do env) ----

test('readClaudeConfig: layout novo <home>/.claude/.claude.json vence o legado no HOME', () => {
  const h = tmp();
  // legado no HOME (o "congelado") — conta com plano DIFERENTE ('Claude' genérico)
  // para provar quem venceu
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'personal' },   // não mapeado → 'Claude'
  }));
  // vivo no config dir
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
  }));
  const r = usage.readClaudeConfig({ home: h });
  assert.ok(r, 'acha conta');
  assert.equal(r.plan, 'Claude Max 5×', 'leu o do config dir, não o legado congelado');
});

test('readClaudeConfig: só o legado existe → fallback no HOME continua funcionando', () => {
  const h = tmp();
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
  }));
  const r = usage.readClaudeConfig({ home: h });
  assert.ok(r);
  assert.equal(r.plan, 'Claude Max 5×');
});

test('readClaudeConfig: symlink ~/.claude → perfil (dd-claude) atravessa sozinho', () => {
  const h = tmp();
  const perfil = tmp();
  fs.writeFileSync(path.join(perfil, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' },
  }));
  fs.symlinkSync(perfil, path.join(h, '.claude'));   // dd-claude: ~/.claude → ~/.<perfil>
  const r = usage.readClaudeConfig({ home: h });
  assert.ok(r);
  assert.equal(r.plan, 'Claude Max 5×', 'lê através do symlink sem realpath');
});

test('readClaudeConfig: nenhum arquivo → null (sem conta, não erro)', () => {
  assert.equal(usage.readClaudeConfig({ home: tmp() }), null);
});
