// src/annotate.js — Claude account for each LOCAL session (#58 / details
// modal). Extracted from main to be testable: resolves the account label from
// the CLAUDE_CONFIG_DIR read out of the pid's environ — the same account
// discovery as claudeAccountsFromSessions, but per session.
//
// The cache here holds only what does NOT change over the process's lifetime
// (environ → dir); the LABEL is recomputed on every call — a nickname renamed
// in the bar tile (account-labels.json) propagates on the next cycle. Cache
// invariants (review findings):
//  • pid → { sid, dir } only enters with the environ READ: getEnviron returns
//    '' on a dead pid/exec race → do NOT cache (the label would be frozen on
//    the default account forever), retry on the next cycle;
//  • a hit only counts with the SAME session_id — a pid reused by another
//    process arrives with a different sid and the environ is re-read;
//  • pids outside the live set are pruned at the end of the call.
// In-memory annotation: none of this is written to the state file. Remote
// sessions (with origin) already arrive annotated by the peer — the label is
// harmless (nickname/org/local-part, never full email/uuid) and is NOT
// LOCAL_ONLY.

const { isLocalSession } = require('./identity.js');

function makeAnnotator({
  getEnviron,                      // (pid) → raw environ ('' = unreadable)
  parseEnviron,                    // usage.parseEnviron
  readClaudeConfig,                // (dir) → profile config (mtime cache in usage)
  claudeAccountKey,                // usage.claudeAccountKey (review #9: SAME key as tile/rename)
  accountLabel,                    // usage.accountLabel
  apiProviderFromSettings,         // usage.apiProviderFromSettings
  agentOf,                         // agents.agentOf
  labelsFile,                      // ACCOUNT_LABELS_FILE (account-labels.json)
  fs,
}) {
  const pidDir = new Map();        // pid → { sid, dir }
  return function annotate(sessions) {
    if (!Array.isArray(sessions)) return sessions;
    const alive = new Set();
    let labels;                    // lazy: labelsFile 1x per cycle (small file)
    for (const s of sessions) {
      // LOCAL sessions only: a remote session's pid is a process on the other
      // machine — probing it in the local /proc can collide with an unrelated
      // local process. Locals come without origin (collect) or with 'local'
      // (state file).
      if (!isLocalSession(s) || agentOf(s) !== 'claude' || !s.pid) continue;
      alive.add(s.pid);
      const sid = s.session_id || '';
      let dir;
      const hit = pidDir.get(s.pid);
      if (hit && hit.sid === sid) {
        dir = hit.dir;             // environ does not change: cache valid for the same process
      } else {
        // '' = unreadable (pid died / fork-exec race / ps failed): do NOT
        // cache — the null/default label would become permanent.
        const raw = getEnviron(s.pid);
        if (!raw) continue;
        try { dir = parseEnviron(raw, ['CLAUDE_CONFIG_DIR']).CLAUDE_CONFIG_DIR || null; }
        catch { continue; }
        pidDir.set(s.pid, { sid, dir });
      }
      // Label resolves on EVERY call (only the dir is cached): a rename in the
      // tile changes account-labels.json and the details modal sees it on the
      // next cycle.
      let label = null;
      try {
        const pc = readClaudeConfig(dir);
        if (labels === undefined) {
          try { labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')) || {}; } catch { labels = {}; }
        }
        // Identity key has ONE definition (claudeAccountKey injected — the
        // SAME one as tile/rename/dedup, review #9). Fallback
        // labels[accountUuid]: a nickname saved before the org key keeps
        // working.
        const key = claudeAccountKey(pc, dir);
        const manual = labels[key] || (pc && pc.accountUuid && labels[pc.accountUuid]) || null;
        label = accountLabel(pc, dir, manual);
      } catch {}
      // Profile's alternative API (settings.json env.ANTHROPIC_BASE_URL): a
      // technical profile's session (e.g. gh-claude → vm-contabo/GLM proxy)
      // shows "gh-claude · vm-contabo:20128" instead of the dir's bare name —
      // the host tells WHICH API the session actually uses. Org profiles have
      // no base_url → label intact. dir null (symlink default account) → no
      // provider.
      const api = dir && apiProviderFromSettings(dir);
      if (label && api) label += ' · ' + api;
      if (label) s.account = label;
    }
    for (const pid of pidDir.keys()) if (!alive.has(pid)) pidDir.delete(pid);
    return sessions;
  };
}

module.exports = { makeAnnotator };
