// identity.js — cross-machine ROW identity (phase 1 of the P2P sync).
//
// The key of "1 process = 1 terminal = 1 overlay row" needs to be
// namespaced by ORIGIN (machine), because `pid`/`session_id` COLLIDE across
// machines — both have pid 1234, and the `proc-<pid>` fallback collides too.
// Without this, (future) remote sessions would overwrite local ones in the dedup/Map.
//
//   origin: 'local' for sessions from THIS machine; the peer's name for remote ones.
//   sessionKey(s) = origin + ':' + (pid || session_id)   → dedup/snooze/render/readMarks
//
// Loaded in TWO contexts:
//   • browser: <script src="identity.js"> in index.html (functions become globals)
//   • Node:    require('./identity.js') in sessions.js / main.js / agent.js (future)
// That's why it declares the functions at top level (global in a classic script) and only
// exports via module.exports when module exists (Node).

function originOf(s) {
  return (s && s.origin) || 'local';
}

// Session from THIS machine? Locals from collect come WITHOUT origin (undefined) or with
// 'local' (state file); remote ones arrive from pollPeers with the PEER NAME. Whoever
// reads the LOCAL /proc (the pid's environ/cwd) NEEDS this filter: a remote
// session's pid is a process on the OTHER machine — probing it here can collide
// with an unrelated local process and fabricate a phantom account/bar (review:
// claudeAccountsFromSessions, glmCredsFromSessions and codexCwdsFromSessions
// used to read peer pids). Pure and tolerant: null/undefined is NOT local.
function isLocalSession(s) {
  return !!s && (!s.origin || s.origin === 'local');
}

// The ROW's key — never the cwd, never the bare pid/session_id. A stable string
// to use in Map/Set and in JSON. Empty only if the session comes without pid AND without session_id.
function sessionKey(s) {
  if (!s) return '';
  return originOf(s) + ':' + (s.pid || s.session_id || '');
}

// Rewrites the ORIGIN segment of a key: 'peer:1234' → 'local:1234'.
// The client that clicks a remote session holds the sessionKey in the RECEIVER's
// namespace ('peer:1234'); before posting the read mark to the ORIGIN (#56),
// it translates to how the origin knows its own session ('local:1234'). Pure and
// tolerant: a key that doesn't match `from` comes back intact, empty becomes empty.
function rewriteKeyOrigin(key, from, to) {
  if (typeof key !== 'string' || !key) return '';
  const f = from || 'local';
  if (key === f) return to || 'local';
  if (key.startsWith(f + ':')) return (to || 'local') + key.slice(f.length);
  return key;
}

// The ALIAS (rename) key — the AGENT's session_id (the UUID `claude
// --resume` accepts), not ATL's internal key: the alias belongs to the agent's
// SESSION, survives overlay restarts and travels well across machines. pid
// fallback for headless processes without session_id. It used to live in renderer.js;
// moved here when the details window (details.js) started resolving
// aliases too — this is session identity, both pages need the
// SAME function (divergent keys = the alias never matches).
function aliasKey(s) {
  return String((s && (s.session_id || s.pid)) || '');
}

// SYNTHETIC session_id: the /proc discovery fallback (`proc-<pid>`,
// sessions.js) for processes that never fired the hook. It is NOT a stable
// identity — it is derived from the pid, so a RECYCLED pid regenerates the
// SAME synthetic sid while being a DIFFERENT process (e.g. another Claude
// profile). Caches keyed by session_id must NOT trust it (annotate.js's
// pid→dir cache reads the environ again instead of reusing the entry).
function isSyntheticSessionId(sid) {
  return typeof sid === 'string' && /^proc-\d+$/.test(sid);
}

if (typeof module !== 'undefined') module.exports = { originOf, isLocalSession, sessionKey, rewriteKeyOrigin, aliasKey, isSyntheticSessionId };
