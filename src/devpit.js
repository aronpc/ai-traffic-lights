// devpit.js — PURE row-level decision for the devpit integration (open a
// local session's pane in the devpit desktop app). Same dual-context
// convention as identity.js/state-machine.js: top-level functions (globals
// when loaded via <script> in index.html, BEFORE renderer.js) + module.exports
// for the Node tests.
//
// ONE function decides what a ROW CLICK does — the click handler and the
// hover action call it, so the two can never disagree:
//   'devpit' — LOCAL session whose agent runs inside devpit (s.devpit_pane,
//              stamped by annotate.js from DEVPIT_PANE, LOCAL_ONLY): open the
//              pane in the devpit app.
//   'focus'  — any other LOCAL session: the pre-devpit behavior — focus the
//              terminal where the session already runs.
//   'remote' — session from a peer (P2P sync). NEVER 'devpit': the pane lives
//              on the ORIGIN machine; even if a devpit_pane traveled inside
//              the sync payload, opening it here is meaningless.
// Self-contained on purpose (no require): `require('./devpit.js')` works
// alone — the local test mirrors identity.js's isLocalSession.
function rowAction(s) {
  if (!s || (s.origin && s.origin !== 'local')) return 'remote';
  return s.devpit_pane ? 'devpit' : 'focus';
}

if (typeof module !== 'undefined') module.exports = { rowAction };
