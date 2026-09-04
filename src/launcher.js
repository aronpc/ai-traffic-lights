// launcher.js — PURE Quick Launcher logic (spawning an agent in a terminal).
// The I/O (PATH scan, spawn) lives in main; here live the testable decisions:
// which terminal to use, and how to build the argv (cwd flag + agent command).

// Supported terminals. Each has a working-directory flag and a
// separator before the agent command (-e for Tilix/Ghostty, -- for GNOME).
// Ghostty: working-directory is a config key; -e runs the command (see ghostty --help).
const TERMINALS = {
  tilix:            { label: 'Tilix',           cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['-e', ...cmd] },
  'gnome-terminal': { label: 'GNOME Terminal',  cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['--', ...cmd] },
  ghostty:          { label: 'Ghostty',          cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['-e', ...cmd] },
};

// Preference order for 'auto' (the 1st one present in the PATH wins).
const TERMINAL_ORDER = ['tilix', 'gnome-terminal', 'ghostty'];

// Resolves which terminal to use: manual pref ('custom' or a present id) > auto.
// Returns 'custom', a supported id, or null (no known terminal).
function pickTerminal(pref, available) {
  if (pref && pref !== 'auto') {
    if (pref === 'custom' || available.includes(pref)) return pref;
  }
  return TERMINAL_ORDER.find((t) => available.includes(t)) || null;
}

// Builds the argv: [cwd flags] + [separator/command] + [agent].
// agentCmd = array (e.g. ['/usr/bin/claude']); returns null if terminal_unknown.
function terminalArgs(terminalId, cwd, agentCmd) {
  const t = TERMINALS[terminalId];
  if (!t) return null;
  return [...t.cwd(cwd), ...t.exec(agentCmd)];
}

// Auto-wrap: runs the agent INSIDE a `tmux new-session` (its own session) → the
// hook captures tmux_session (#S) → the click attaches in the Terminal window.
// The sessionName must be unique (main appends a Date-like suffix); it is
// sanitized here because it enters as a tmux argv (comes from config/agent).
function tmuxSessionName(agentId) {
  return 'atl-' + String(agentId || 'agent').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
}
function tmuxWrap(agentCmd, sessionName) {
  const name = /^[A-Za-z0-9._-]+$/.test(sessionName) ? sessionName : 'atl-agent';
  return ['tmux', 'new-session', '-s', name, ...agentCmd];
}

if (typeof module !== 'undefined') module.exports = { TERMINALS, TERMINAL_ORDER, pickTerminal, terminalArgs, tmuxSessionName, tmuxWrap };
