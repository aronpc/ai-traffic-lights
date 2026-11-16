// src/annotate.js — in-memory annotation of each LOCAL session, from the pid's
// environ (same /proc read for everything):
//  • devpit_pane: DEVPIT_PANE for EVERY agent (Claude, Codex, OpenCode...),
//    stamped BEFORE the Claude account gate below — a devpit leaf marks the
//    pane the agent runs in, whatever the agent is. Value must match
//    DEVPIT_LEAF_RE (validate.js); anything off the format or absent → null
//    (null = "checked, no pane", undefined = "didn't check"). Machine-local:
//    listed in LOCAL_ONLY (net.js), never crosses the sync.
//  • account: Claude-only label from CLAUDE_CONFIG_DIR (#58 / details modal) —
//    the same account discovery as claudeAccountsFromSessions, per session.
//
// The cache here holds only what does NOT change over the process's lifetime
// (environ → { dir, pane }); the LABEL is recomputed on every call — a nickname
// renamed in the bar tile (account-labels.json) propagates on the next cycle.
// Cache invariants (review findings):
//  • pid → { sid, dir, pane } only enters with the environ READ: getEnviron
//    returns '' on a dead pid/exec race → do NOT cache (the label would be
//    frozen on the default account forever), retry on the next cycle;
//  • a hit only counts with the SAME session_id — a pid reused by another
//    process arrives with a different sid and the environ is re-read; a
//    SYNTHETIC sid (`proc-<pid>`) regenerates itself on a recycled pid and
//    therefore never enters the cache (identity.js isSyntheticSessionId);
//  • pids outside the live set are pruned at the end of the call.
// In-memory annotation: none of this is written to the state file. Remote
// sessions (with origin) already arrive annotated by the peer — the label is
// harmless (nickname/org/local-part, never full email/uuid) and is NOT
// LOCAL_ONLY.

const { isLocalSession, isSyntheticSessionId } = require('./identity.js');
const { DEVPIT_LEAF_RE } = require('./validate.js');

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
  const pidDir = new Map();        // pid → { sid, dir, pane }
  return function annotate(sessions) {
    if (!Array.isArray(sessions)) return sessions;
    const alive = new Set();
    let labels;                    // lazy: labelsFile 1x per cycle (small file)
    for (const s of sessions) {
      // LOCAL sessions with a pid, ANY agent (the devpit pane below is not
      // Claude's): a remote session's pid is a process on the other machine —
      // probing it in the local /proc can collide with an unrelated local
      // process. Locals come without origin (collect) or with 'local'
      // (state file).
      if (!isLocalSession(s) || !s.pid) continue;
      alive.add(s.pid);
      const sid = s.session_id || '';
      // SYNTHETIC sid (`proc-<pid>`, /proc discovery): derived from the pid, so
      // a recycled pid regenerates the SAME sid while being ANOTHER process —
      // `hit.sid === sid` would hand the cache entry (and the label) of the
      // PREVIOUS process's account to the new one. A synthetic sid never
      // counts as a hit and never enters the cache (the environ re-read on
      // every cycle is one /proc open per discovered session — cheap).
      const synthetic = isSyntheticSessionId(sid);
      const claude = agentOf(s) === 'claude';
      let dir;
      let pane;
      const hit = pidDir.get(s.pid);
      if (hit && hit.sid === sid && !synthetic) {
        dir = hit.dir;             // environ does not change: cache valid for the same process
        pane = hit.pane;
      } else {
        // '' = unreadable (pid died / fork-exec race / ps failed): do NOT
        // cache — the null/default label would become permanent.
        const raw = getEnviron(s.pid);
        if (!raw) continue;
        try {
          // One environ read feeds both annotations. DEVPIT_PANE is for every
          // agent (BEFORE the Claude gate right below); CLAUDE_CONFIG_DIR
          // stays CLAUDE-ONLY — a non-Claude session never resolves an
          // account from it.
          const env = parseEnviron(raw, ['DEVPIT_PANE', 'CLAUDE_CONFIG_DIR']);
          pane = DEVPIT_LEAF_RE.test(env.DEVPIT_PANE || '') ? env.DEVPIT_PANE : null;
          dir = claude ? (env.CLAUDE_CONFIG_DIR || null) : null;
        }
        catch { continue; }
        if (!synthetic) pidDir.set(s.pid, { sid, dir, pane });
      }
      // Stamped for every local session whose environ was read: valid leaf →
      // the id, absent/off-format → null (distinct from undefined = unchecked,
      // e.g. remote session or unreadable environ).
      s.devpit_pane = pane;
      // Claude account label — the gate sits BELOW the devpit read above.
      if (!claude) continue;
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
