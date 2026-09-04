// state-machine.js — computes the traffic-light state from the state file.
//
// WHY THIS RUNS IN THE RENDERER (and not in the hook): idle escalation
// (green→red after N min) requires comparing the last Stop's timestamp against
// NOW. The hook is event-driven (no clock); only the renderer has a
// setInterval to re-evaluate.
//
// Decisions (plan §6): 3 colors. Error = red ⚠. Idle > N min escalates to red.
// `reason` is the sub-icon (the reason), not a new color.

// Idle escalation defaults — overridden by computeState's cfg when the user
// configures them (see src/settings.js + the Preferences window).
const DEFAULT_IDLE_THRESHOLD_SEC = 5 * 60;  // green→red after 5 min idle
const DEFAULT_ESCALATE_IDLE = true;         // toggle (plan §6, option c)

// Event → {level, reason} map. Explicit (awaiting) reasons come first.
// Notification is NOT here — it is classified by notification_type below
// (auth_success / elicitation_complete / elicitation_response are benign).
const REASON_FOR = {
  PermissionRequest: { level: 'awaiting', reason: 'permission' },
  Question: { level: 'awaiting', reason: 'question' },
  PostToolUseFailure: { level: 'awaiting', reason: 'error' },
};

// Notification types that do NOT need the user (Claude Code docs):
//   auth_success            — authentication succeeded
//   elicitation_complete    — the MCP elicitation flow finished
//   elicitation_response    — user answered an elicitation
// The others (permission_prompt, idle_prompt, elicitation_dialog) are 🔴.
// Classify by notification_type, NEVER by substring of message (unstable
// across versions and subject to i18n).
const BENIGN_NOTIFICATION_TYPES = new Set(['auth_success', 'elicitation_complete', 'elicitation_response']);

const PROCESSING_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

// Icon per reason (sub-icon next to the name).
const REASON_ICON = {
  permission: '🔑', question: '❓', error: '⚠', idle: '⏰', tool: '🛠', ok: '✓',
};

/**
 * @param {object} state  parsed state file {last_event, last_event_ts, ...}
 * @param {number} nowSec  current epoch (Date.now()/1000)
 * @param {object} [cfg]   {idleThresholdSec, escalateIdle} — configurable
 * @param {number} [readAt]  ts (epoch s) up to which the session was marked READ.
 *   If the session would be 'awaiting' but the last event is <= readAt (no new
 *   notification since the mark), demote it to 'read' (gray). A red event with
 *   last_event_ts > readAt re-lights naturally.
 * @returns {{level:'processing'|'done'|'awaiting'|'read', reason:string|null}}
 */
function computeState(state, nowSec, cfg, readAt) {
  const st = baseState(state, nowSec, cfg);
  // "Mark as read": only demotes reds (awaiting) and only if the mark covers
  // the current event. Yellow/green never turn gray. readAt is per-session.
  if (st.level === 'awaiting' && typeof readAt === 'number'
      && (state.last_event_ts || 0) <= readAt) {
    return { level: 'read', reason: st.reason };
  }
  return st;
}

function baseState(state, nowSec, cfg) {
  const last = state.last_event;
  const escalate = cfg ? cfg.escalateIdle : DEFAULT_ESCALATE_IDLE;
  const threshold = cfg ? cfg.idleThresholdSec : DEFAULT_IDLE_THRESHOLD_SEC;

  // 1. Notification: classify by notification_type (benign → green).
  if (last === 'Notification') {
    if (state.notification_type && BENIGN_NOTIFICATION_TYPES.has(state.notification_type)) {
      return { level: 'done', reason: 'ok' };
    }
    return { level: 'awaiting', reason: 'question' };
  }

  // 2. Explicit "needs you" reasons (red).
  if (REASON_FOR[last]) return REASON_FOR[last];

  // 3. Processing (yellow).
  if (PROCESSING_EVENTS.has(last)) return { level: 'processing', reason: 'tool' };

  // 4. Done (green) — with optional idle escalation.
  if (last === 'Stop' || last === 'SessionStart' || last === 'SessionEnd') {
    const ageSec = nowSec - (state.last_event_ts || 0);
    if (escalate && last === 'Stop' && ageSec > threshold) {
      return { level: 'awaiting', reason: 'idle' };
    }
    return { level: 'done', reason: 'ok' };
  }

  // 5. Unknown event → conservative green.
  return { level: 'done', reason: null };
}

function iconFor(st) {
  if (st.level === 'read') return '👁';                 // read (silenced until a new notification)
  return REASON_ICON[st.reason] || (st.level === 'processing' ? '🛠' : '✓');
}

// ---- urgency ordering (reds at the top) ----
// Rank: awaiting (🔴) < processing (🟡) < done (🟢) < read (gray, resolved).
// Within the same level there is NO time ordering (oldest/waiting the
// longest): the key is STABLE — local before peers, peers in alphabetical
// order, then session id. Sorting by last_event_ts would make the list
// re-sort on every tool call (~2s), confusing local/remote and causing
// mis-clicks at the top.
const URGENCY_RANK = { awaiting: 0, processing: 1, done: 2, read: 3 };
// opts.originFirst (grouped mode, #54): ORIGIN as the primary key (local
// first, peers alphabetical) and urgency WITHIN the block. Without it urgency
// is primary — a 🔴 peer comes before local 🟢 — which is the flat list's
// behavior, but it would fragment host blocks into several pieces (repeated
// header in the middle).
function sortByUrgency(ranked, opts) {
  // STABLE key by id (not by last_event_ts, which changes on every tool call
  // and would make the list RE-SORT every ~2s — it confused local/remote,
  // caused mis-clicks). The list only changes when URGENCY changes.
  const skey = (x) => ((x.s && (x.s.session_id || x.s.pid)) || '');
  const originOf = (x) => ((x.s && x.s.origin) || 'local');
  const isLocal = (x) => { const o = originOf(x); return !o || o === 'local'; };
  const originFirst = !!(opts && opts.originFirst);
  const byOrigin = (a, b) => {
    // LOCAL (this host) always before peers — avoids mis-clicks and
    // groups the user's machine at the top. It used to be a plain origin
    // string sort, and common hostnames ("alienware") sorted before "local"
    // (PR-32 #20).
    const al = isLocal(a), bl = isLocal(b);
    if (al !== bl) return al ? -1 : 1;
    const oa = originOf(a), ob = originOf(b);
    if (oa !== ob) return oa < ob ? -1 : 1;   // peers: stable alphabetical order
    return 0;
  };
  return [...ranked].sort((a, b) => {
    const la = (a.st && a.st.level) || 'done';
    const lb = (b.st && b.st.level) || 'done';
    if (originFirst) {
      const o = byOrigin(a, b);
      if (o) return o;
    }
    if (la !== lb) return URGENCY_RANK[la] - URGENCY_RANK[lb];
    if (!originFirst) {
      const o = byOrigin(a, b);
      if (o) return o;
    }
    const ka = skey(a), kb = skey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---- grouping by host (#54) ----
// Group cuts of a list ALREADY ordered by sortByUrgency (which leaves
// sessions contiguous by origin: local first, peers alphabetical). Each cut
// describes a block: {origin, startIdx, count, worst} — startIdx is the index
// in `ordered` where the block starts, worst the most urgent level inside it
// (for the header to summarize "notebook-hg · 3 🔴"). Pure: the renderer
// decides whether to draw.
function groupBreaks(ordered) {
  const breaks = [];
  let cur = null;
  for (let i = 0; i < ordered.length; i++) {
    const s = (ordered[i] && ordered[i].s) || {};
    const level = (ordered[i].st && ordered[i].st.level) || 'done';
    const origin = s.origin || 'local';
    if (!cur || cur.origin !== origin) {
      cur = { origin, startIdx: i, count: 0, worst: level };
      breaks.push(cur);
    }
    cur.count++;
    if (URGENCY_RANK[level] < URGENCY_RANK[cur.worst]) cur.worst = level;
  }
  return breaks;
}

if (typeof module !== 'undefined') module.exports = { computeState, iconFor, sortByUrgency, groupBreaks };
