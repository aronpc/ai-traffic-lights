// claude-config.js — resolução dos paths do Claude Code na máquina.
//
// O Claude Code guarda tudo dentro de um CONFIG DIR (não mais no HOME):
//   <dir>/.claude.json        estado vivo (conta OAuth, plano, passes)
//   <dir>/.credentials.json   token OAuth (claudeAiOauth.accessToken)
//   <dir>/projects/           transcripts .jsonl por projeto
// O dir é $CLAUDE_CONFIG_DIR quando setado (perfis nomeados: zclaude, nclaude…)
// e ~/.claude no default — que pode ser um SYMLINK para o perfil ativo
// (troca pelo dd-claude). Ler pelo caminho ~/.claude/... atravessa o symlink
// naturalmente; nenhum realpath é preciso para LER (só para deduplicar dirs
// iguais sob nomes diferentes, feito no coletor multi-conta).
//
// O .claude.json ainda tem fallback legado em ~/.claude.json (layout pré-migração,
// que o próprio Claude Code parou de atualizar — ler só ele é o bug do "arquivo
// congelado"). Ordem: dir novo primeiro, legado por último.

const fs = require('fs');
const os = require('os');
const path = require('path');

// O config dir efetivo: $CLAUDE_CONFIG_DIR (se aponta para dir existente) ou
// ~/.claude. Injetar `home` é ser SANDBOX de teste: ignora o CLAUDE_CONFIG_DIR
// ambiente — na máquina do dev a var vive setada (perfis dd-claude) e vazaria
// dentro de qualquer fixture. O caminho de produção (sem `home`) a honra.
function configDir({ home } = {}) {
  if (home) return path.join(home, '.claude');
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    try { if (fs.statSync(env).isDirectory()) return env; } catch {}
  }
  return path.join(os.homedir(), '.claude');
}

// Candidatos do .claude.json em ordem de preferência: o do config dir (vivo),
// depois o legado no HOME (congelado desde a migração — melhor que nada).
// `dir` explícito = conta nomeada (multi-conta): um candidato SÓ, sem fallback
// legado — o ~/.claude.json do HOME pertence a OUTRA conta, cair nele mostraria
// o plano errado na barra da conta certa.
function configCandidates({ home, dir } = {}) {
  if (dir) return [path.join(dir, '.claude.json')];
  const h = home || os.homedir();
  return [path.join(configDir({ home }), '.claude.json'), path.join(h, '.claude.json')];
}

// .credentials.json só existiu dentro do dir — um caminho só.
function credsFile({ home, dir } = {}) {
  return path.join(dir || configDir({ home }), '.credentials.json');
}

// settings.json do config dir (model default, hooks, e o bloco `env` que pode
// trocar a API por um proxy próprio via ANTHROPIC_BASE_URL — perfis técnicos).
// VIVE no dir (não há fallback legado no HOME) e `dir` explícito = conta nomeada.
function settingsFile({ home, dir } = {}) {
  return path.join(dir || configDir({ home }), 'settings.json');
}

// Roots de transcripts em ordem de preferência: o do config dir, depois os
// dois históricos hardcoded (~/.claude/projects cobre default+symlink;
// ~/.zclaude/projects cobre o perfil zclaude pré-descoberta-dinâmica).
// Deduplicado: CLAUDE_CONFIG_DIR apontando para o próprio default não varre 2×.
function projectsRoots({ home } = {}) {
  const h = home || os.homedir();
  return [...new Set([
    path.join(configDir({ home }), 'projects'),
    path.join(h, '.claude', 'projects'),
    path.join(h, '.zclaude', 'projects'),
  ])];
}

module.exports = { configDir, configCandidates, credsFile, settingsFile, projectsRoots };
