// focus.js — PURE click-to-focus logic (issue #1). No I/O: takes already
// collected data (windows, ancestors, state) and decides what to do. main.js
// does the I/O (reading /proc, wmctrl/gdbus/xdg-open) and calls these
// functions — so the decision is testable without Electron/X11.

// Normalizes a windowid (hex "0x…" or decimal) to a number. null if invalid.
function parseWindowId(windowid) {
  if (windowid == null) return null;
  const s = String(windowid).trim();
  if (!s) return null;
  const n = parseInt(s, s.startsWith('0x') ? 16 : 10);
  return Number.isNaN(n) ? null : n;
}

// Chooses WHICH window to activate (issue #1, H2: validate the windowid
// before using it).
//   windowid    — id recorded in the state file (may be stale/recycled)
//   wins        — [{id, idNum, pid}] from `wmctrl -l -p`
//   ancestorPids— Set of pids in the session's process tree (the window's
//                 owning terminal is in there; in Warp/Tilix it is the app
//                 process)
// Rule: only trust the windowid if the window STILL exists AND belongs to the
// session (pid ∈ ancestors) — otherwise a recycled id would focus the wrong
// window. Without a valid windowid, fall back to the session's 1st window.
// null = nothing to activate.
function pickWindow(windowid, wins, ancestorPids) {
  const wid = parseWindowId(windowid);
  if (wid != null) {
    const exact = wins.find((w) => w.idNum === wid);
    if (exact && ancestorPids.has(exact.pid)) return exact.id; // validated
  }
  const owned = wins.find((w) => ancestorPids.has(w.pid));      // fallback
  return owned ? owned.id : null;
}

// Extracts focus hints from a /proc/<pid>/environ (Linux) or from the
// normalized output of `ps -E` (macOS) — NUL-separated KEY=VAL pairs. It is
// the LIVE source: used on click to enrich sessions whose state does not yet
// carry the hint (event older than the new hook, or /proc-only session) and to
// RE-SYNC hints from the tmux client. On Windows there is no equivalent
// (reading another process's environ requires native code) — there the caller
// passes ''.
// WARNING: every field here is MACHINE-LOCAL — it identifies a window/tab/pane
// of this kernel. When adding one, also include it in LOCAL_ONLY (src/net.js),
// otherwise it crosses the sync and reaches a peer pointing at nothing.
const ENV_HINTS = {
  WARP_FOCUS_URL: 'focus_url',   // Warp (Linux/macOS) — warp://session/<uuid>
  TILIX_ID: 'tilix_id',          // Tilix (Linux) — terminal uuid
  ITERM_SESSION_ID: 'iterm_id',  // iTerm2 (macOS) — "w0t0p0:<uuid>"
  TMUX_PANE: 'tmux_pane',        // tmux — "%N", the agent's pane
};

function emptyHints() {
  const out = {};
  for (const k of Object.keys(ENV_HINTS)) out[ENV_HINTS[k]] = null;
  return out;
}

function parseEnviron(text) {
  const out = emptyHints();
  if (!text) return out;
  for (const line of String(text).split('\0')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const field = ENV_HINTS[line.slice(0, eq)];
    if (field) out[field] = line.slice(eq + 1);
  }
  return out;
}

// Native channels that focus the exact TAB inside the terminal (the window
// belongs to the window manager; the tab is internal to the terminal and only
// it can reach it).
//
// `app` is the required PROOF. The hint alone is NOT enough: an inherited hint
// outlives the app that created it. A WARP_FOCUS_URL frozen in the environ of
// a tmux server born inside Warp leaks into every new pane, forever — and
// triggering that value raises Warp over the terminal that is actually on
// screen. Re-syncing the hint from the client does not cover this: when the
// client has no WARP_FOCUS_URL at all (tmux currently running in Tilix), the
// state ghost survives a `live.focus_url || t.focus_url`. Requiring proof
// covers it.
//
// The prover is the caller (src/ipc/focus.js), sweeping the process tree of
// the anchor pid and filling in state.terminal. No proof → no channel, and the
// click degrades to just raising the window: it never opens the wrong app.
//
// ADDING A TERMINAL = one line here + the comm in TERMINALS (ipc/focus.js)
// + the executor in focusTab. Nothing else.
// `valid` runs AFTER `map` and is the channel's trust boundary: the value
// comes out of an environ (or, via IPC, out of a field sent by the renderer)
// and becomes an argument to an external program. Validating the FORMAT is
// safer than escaping, the same way tmuxTarget does with the pane's "%N".
const ID = /^[A-Za-z0-9-]{1,64}$/;
const TAB_CHANNELS = [
  { kind: 'warp',  app: 'warp',  field: 'focus_url', valid: (v) => v.startsWith('warp://') },
  // ITERM_SESSION_ID is "w0t0p0:<uuid>"; AppleScript wants only the uuid. That
  // uuid is INTERPOLATED into the script body — a value with \n would close
  // the `if` line and inject commands executed by osascript under the user's
  // account.
  { kind: 'iterm', app: 'iterm', field: 'iterm_id',
    map: (v) => (v.includes(':') ? v.slice(v.indexOf(':') + 1) : v),
    valid: (v) => ID.test(v) },
  // The tilix_id becomes a D-Bus variant (`[<'…'>]`): a single quote would
  // break gvariant's parse. It is not shell (execFileSync does not go through
  // a shell), but the malformed argument makes the call fail silently.
  { kind: 'tilix', app: 'tilix', field: 'tilix_id', valid: (v) => ID.test(v) },
];

function tabChannel(state) {
  if (!state || !state.terminal) return null;
  for (const ch of TAB_CHANNELS) {
    if (ch.app !== state.terminal) continue;
    const raw = state[ch.field];
    if (!raw) continue;
    let value = String(raw);
    if (ch.map) value = ch.map(value);
    if (!value) continue;
    if (ch.valid && !ch.valid(value)) continue;
    return { kind: ch.kind, value };
  }
  return null;
}

// tmux: focuses the agent's PANE inside the multiplexer. It is COMPLEMENTARY
// to the window raise and to tabChannel — the agent may be in a tmux pane
// inside Warp/Tilix/any terminal, so this runs IN ADDITION to them. The pane
// id ($TMUX_PANE, e.g. "%3") is global in the tmux server; we validate the
// format so it never becomes an unexpected `tmux` argument.
function tmuxTarget(state) {
  if (!state || !state.tmux_pane) return null;
  const p = String(state.tmux_pane);
  return /^%[0-9]+$/.test(p) ? p : null;
}

// Under tmux, the agent's PID does NOT reach the terminal: the tmux server is
// a daemon reparented to init (systemd --user), so the agent's PPid chain is
// agent → zsh → tmux server → systemd — the emulator (Warp/Tilix/…) never
// appears. What IS a child of the terminal is the tmux CLIENT (one per
// attached tab). This function picks the RIGHT client: the one attached to the
// agent's pane's session. Without this pickWindow finds no window at all
// (raise fails) and the state's focus_url comes from the server's FROZEN
// environ (the same for all tabs → xdg-open always focuses the wrong tab).
//   pane    — "%41" (state.tmux_pane)
//   panes   — [{pane, session}] from `tmux list-panes -a`
//   clients — [{session, pid, activity}] from `tmux list-clients`
// Returns the client's pid, or null (pane without session/without an attached
// client — a detached session is normal: the agent runs, there is just no
// window to focus). Ties are broken by the most recent activity when there
// are N clients on the same session.
function tmuxClientPid(pane, panes, clients) {
  if (!pane || !Array.isArray(panes) || !Array.isArray(clients)) return null;
  const entry = panes.find((p) => p && p.pane === pane);
  if (!entry) return null;
  const attached = clients.filter((c) => c && c.session === entry.session && c.pid > 0);
  if (!attached.length) return null;
  const best = attached.reduce((a, b) => ((b.activity || 0) > (a.activity || 0) ? b : a));
  return best.pid;
}

// Session from ANOTHER machine (P2P sync): its `pid` belongs to another
// kernel, and interpreting it here would focus a local process with the same
// id — the same class of error as the recycled windowid, one level up.
// `origin` comes from identity.js ('local' = this machine; peer name =
// remote).
function isRemoteSession(state) {
  return !!state && !!state.origin && state.origin !== 'local';
}

// Click outcome: null when it had an effect, otherwise the REASON for the
// no-op, so the caller can pick the message. Previously only Wayland was
// reported, but the same silence happens on X11/macOS when the session is in
// a tmux with no attached client, or when it is not even from this machine —
// "did nothing, without warning" is the worst possible outcome. Order = from
// most specific to most generic.
//   remote   — session from another host: there is nothing to focus here
//   detached — tmux with no attached client: the session exists, the window
//              does not
//   headless — no controlling terminal AT ALL (nohup/SDK/claude -p spawned by
//              another tool): there is no window, and never was
//   wayland  — native Wayland and the terminal exposes no tab channel
//   nowindow — no window for the session and no channel
function focusFailure(state) {
  if (!state) return null;
  if (isRemoteSession(state)) return 'remote';
  if (state.raised || state.hasTab) return null;
  if (state.detached) return 'detached';
  if (state.headless) return 'headless';
  if (state.wayland) return 'wayland';
  return 'nowindow';
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseWindowId, pickWindow, tabChannel, tmuxTarget, tmuxClientPid,
    parseEnviron, focusFailure, isRemoteSession, TAB_CHANNELS, ENV_HINTS,
  };
}
