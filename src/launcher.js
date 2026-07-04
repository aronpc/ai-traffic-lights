// launcher.js — lógica PURA do Quick Launcher (spawn de agente num terminal).
// O I/O (scan de PATH, spawn) fica no main; aqui ficam as decisões testáveis:
// qual terminal usar, e como montar os argv (flag de cwd + comando do agente).

// Terminais suportados. Cada um tem um flag de working-directory e um
// separador antes do comando do agente (-e para Tilix/Ghostty, -- p/ GNOME).
// Ghostty: working-directory é config-key; -e roda o comando (ver ghostty --help).
const TERMINALS = {
  tilix:            { label: 'Tilix',           cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['-e', ...cmd] },
  'gnome-terminal': { label: 'GNOME Terminal',  cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['--', ...cmd] },
  ghostty:          { label: 'Ghostty',          cwd: (d) => [`--working-directory=${d}`], exec: (cmd) => ['-e', ...cmd] },
};

// Ordem de preferência do 'auto' (o 1º presente no PATH vence).
const TERMINAL_ORDER = ['tilix', 'gnome-terminal', 'ghostty'];

// Resolve qual terminal usar: pref manual ('custom' ou um id presente) > auto.
// Retorna 'custom', um id suportado, ou null (nenhum terminal conhecido).
function pickTerminal(pref, available) {
  if (pref && pref !== 'auto') {
    if (pref === 'custom' || available.includes(pref)) return pref;
  }
  return TERMINAL_ORDER.find((t) => available.includes(t)) || null;
}

// Monta os argv: [flags de cwd] + [separador/comando] + [agente].
// agentCmd = array (ex.: ['/usr/bin/claude']); Retorna null se terminal_unknown.
function terminalArgs(terminalId, cwd, agentCmd) {
  const t = TERMINALS[terminalId];
  if (!t) return null;
  return [...t.cwd(cwd), ...t.exec(agentCmd)];
}

if (typeof module !== 'undefined') module.exports = { TERMINALS, TERMINAL_ORDER, pickTerminal, terminalArgs };
