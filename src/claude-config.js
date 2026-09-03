// claude-config.js — resolves Claude Code paths on the machine.
//
// Claude Code keeps everything inside a CONFIG DIR (no longer in HOME):
//   <dir>/.claude.json        live state (OAuth account, plan, passes)
//   <dir>/.credentials.json   OAuth token (claudeAiOauth.accessToken)
//   <dir>/projects/           per-project .jsonl transcripts
// The dir is $CLAUDE_CONFIG_DIR when set (named profiles: zclaude, nclaude…)
// and ~/.claude by default — which may be a SYMLINK to the active profile
// (switched by dd-claude). Reading via the ~/.claude/... path traverses the
// symlink naturally; no realpath is needed to READ (only to deduplicate equal
// dirs under different names, done in the multi-account collector).
//
// .claude.json also has a legacy fallback at ~/.claude.json (pre-migration
// layout, which Claude Code itself stopped updating — reading only it is the
// "frozen file" bug). Order: new dir first, legacy last.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The effective config dir: $CLAUDE_CONFIG_DIR (if it points to an existing
// dir) or ~/.claude. Injecting `home` means being a test SANDBOX: ignores the
// ambient CLAUDE_CONFIG_DIR — on the dev's machine the var is always set
// (dd-claude profiles) and would leak into any fixture. The production path
// (without `home`) honors it.
function configDir({ home } = {}) {
  if (home) return path.join(home, '.claude');
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) {
    try { if (fs.statSync(env).isDirectory()) return env; } catch {}
  }
  return path.join(os.homedir(), '.claude');
}

// .claude.json candidates in preference order: the config dir's (live),
// then the legacy one in HOME (frozen since the migration — better than nothing).
// Explicit `dir` = named account (multi-account): a SINGLE candidate, no
// legacy fallback — HOME's ~/.claude.json belongs to ANOTHER account, falling
// into it would show the wrong plan on the right account's bar.
function configCandidates({ home, dir } = {}) {
  if (dir) return [path.join(dir, '.claude.json')];
  const h = home || os.homedir();
  return [path.join(configDir({ home }), '.claude.json'), path.join(h, '.claude.json')];
}

// .credentials.json only ever existed inside the dir — a single path.
function credsFile({ home, dir } = {}) {
  return path.join(dir || configDir({ home }), '.credentials.json');
}

// settings.json from the config dir (default model, hooks, and the `env`
// block that can swap the API for a custom proxy via ANTHROPIC_BASE_URL —
// technical profiles). Lives in the dir (no legacy fallback in HOME) and
// explicit `dir` = named account.
function settingsFile({ home, dir } = {}) {
  return path.join(dir || configDir({ home }), 'settings.json');
}

// Transcript roots in preference order: the config dir's, then the two
// hardcoded historical ones (~/.claude/projects covers default+symlink;
// ~/.zclaude/projects covers the zclaude profile from before dynamic discovery).
// Deduplicated: CLAUDE_CONFIG_DIR pointing at the default itself does not scan 2×.
function projectsRoots({ home } = {}) {
  const h = home || os.homedir();
  return [...new Set([
    path.join(configDir({ home }), 'projects'),
    path.join(h, '.claude', 'projects'),
    path.join(h, '.zclaude', 'projects'),
  ])];
}

module.exports = { configDir, configCandidates, credsFile, settingsFile, projectsRoots };
