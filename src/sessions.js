// sessions.js — PURE merge/dedup logic for sessions (issue: Tilix would vanish).
// main.js does the I/O (read state dir + probe /proc) and calls mergeSessions.
//
// WHY term_program is NO LONGER the "is a terminal" gate:
// Tilix (and others) do NOT export TERM_PROGRAM — only TILIX_ID. The old filter
// `.filter(s => s.term_program)` deleted those sessions along with headless
// processes. The correct "interactive" gate already exists in another layer:
//   • state file → the hook only fires in an interactive session (SessionStart etc.)
//   • /proc probe → gate is parent = shell (zsh/bash/...) OR no controlling tty
//     (headless: nohup/SDK/tool-spawned). Daemons/MCP servers whose parent is
//     node/claude WITH a tty stay excluded.
// Hence no extra filtering by term_program is necessary.

const { sessionKey } = require('./identity.js');

// Dedupe by sessionKey (origin:pid||session_id) — 1 process = 1 terminal =
// 1 row. Same pid with 2 session_ids (a job routing 2 contexts): keep the
// most recent event. Missing pid: dedupe by session_id (never collides).
// The `origin` prefix is what PREVENTS the collision across machines: two terminals
// on different machines with the same pid become distinct keys. Default
// 'local' when the session comes without origin (legacy state file / /proc probe).
function mergeSessions(stateFileSessions, discovered) {
  const sessions = (stateFileSessions || []).map((s) => (s.origin ? s : { ...s, origin: 'local' }));
  for (const { pid, agent, headless } of discovered || []) {
    if (pid && !sessions.some((s) => s.pid === pid && originOfLocal(s))) {
      sessions.push({
        session_id: `proc-${pid}`, pid, agent, origin: 'local',
        cwd: null,
        // 'terminal' claims a shell under it — a headless agent has none, and
        // carries the flag instead (the overlay draws ⌨ in its own column).
        term_program: headless ? null : 'terminal',
        ...(headless ? { headless: true } : {}),
        last_event: 'ativo', last_event_ts: 0,
      });
    }
  }
  const byKey = new Map();
  for (const s of sessions) {
    const key = sessionKey(s);
    const prev = byKey.get(key);
    if (!prev || (s.last_event_ts || 0) >= (prev.last_event_ts || 0)) byKey.set(key, s);
  }
  return [...byKey.values()];
}
// local helper: the session is local (didn't come in as a duplicate discovery from another origin)
function originOfLocal(s) { return (s.origin || 'local') === 'local'; }

if (typeof module !== 'undefined') module.exports = { mergeSessions };
