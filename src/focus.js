// focus.js — lógica PURA do click-to-focus (issue #1). Sem I/O: recebe dados
// já coletados (janelas, ancestrais, state) e decide o que fazer. main.js faz
// o I/O (ler /proc, wmctrl/gdbus/xdg-open) e chama estas funções — assim a
// decisão é testável sem Electron/X11.

// Normaliza um windowid (hex "0x…" ou decimal) para número. null se inválido.
function parseWindowId(windowid) {
  if (windowid == null) return null;
  const s = String(windowid).trim();
  if (!s) return null;
  const n = parseInt(s, s.startsWith('0x') ? 16 : 10);
  return Number.isNaN(n) ? null : n;
}

// Escolhe QUAL janela ativar (issue #1, H2: valida o windowid antes de usar).
//   windowid    — id gravado no state file (pode estar obsoleto/reciclado)
//   wins        — [{id, idNum, pid}] de `wmctrl -l -p`
//   ancestorPids— Set de pids na árvore de processos da sessão (o terminal
//                 dono da janela está aí; no Warp/Tilix é o processo do app)
// Regra: só confia no windowid se a janela AINDA existe E pertence à sessão
// (pid ∈ ancestrais) — senão um id reciclado focaria a janela errada. Sem
// windowid válido, cai na 1ª janela da sessão. null = nada a ativar.
function pickWindow(windowid, wins, ancestorPids) {
  const wid = parseWindowId(windowid);
  if (wid != null) {
    const exact = wins.find((w) => w.idNum === wid);
    if (exact && ancestorPids.has(exact.pid)) return exact.id; // validado
  }
  const owned = wins.find((w) => ancestorPids.has(w.pid));      // fallback
  return owned ? owned.id : null;
}

// Extrai os hints de foco de um /proc/<pid>/environ (KEY=VAL separados por
// NUL). É a fonte VIVA — usada no clique pra enriquecer sessões cujo state
// ainda não tem o hint (evento anterior ao hook novo, ou sessão só-/proc).
function parseEnviron(text) {
  const out = { focus_url: null, tilix_id: null, tmux_pane: null };
  if (!text) return out;
  for (const line of text.split('\0')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq);
    if (k === 'WARP_FOCUS_URL') out.focus_url = line.slice(eq + 1);
    else if (k === 'TILIX_ID') out.tilix_id = line.slice(eq + 1);
    else if (k === 'TMUX_PANE') out.tmux_pane = line.slice(eq + 1);
  }
  return out;
}

// Escolhe o canal nativo que foca a ABA/sessão exata dentro do terminal
// (janela é responsabilidade do X11; aba é interna ao terminal).
//   warp  → xdg-open  warp://session/<uuid>   (state.focus_url)
//   tilix → gdbus     activate-terminal <id>  (state.tilix_id)
// Retorna {kind, value} ou null (sem canal → só o raise de janela).
function tabChannel(state) {
  if (!state) return null;
  const furl = state.focus_url;
  if (furl && String(furl).startsWith('warp://')) return { kind: 'warp', value: String(furl) };
  if (state.tilix_id) return { kind: 'tilix', value: String(state.tilix_id) };
  return null;
}

// tmux: foca o PAINEL do agente dentro do multiplexador. É COMPLEMENTAR ao
// raise de janela e ao tabChannel — o agente pode estar num pane tmux dentro
// do Warp/Tilix/qualquer terminal, então isto roda ALÉM deles. O pane id
// ($TMUX_PANE, ex "%3") é global no server tmux; validamos o formato pra ele
// nunca virar um argumento inesperado do `tmux`.
function tmuxTarget(state) {
  if (!state || !state.tmux_pane) return null;
  const p = String(state.tmux_pane);
  return /^%[0-9]+$/.test(p) ? p : null;
}

// Decide se o clique virou no-op (foco inviável): Wayland + não raiseou a
// janela (wmctrl é cego pra apps Wayland-nativos) + sem canal de aba. O main
// coleta hasTab (tabChannel != null) e raised (raiseWindow devolveu true) e
// pede a decisão aqui — assim o gate fica testável e cobre QUALQUER terminal
// Wayland-nativo sem canal (GNOME Terminal, Console/kgx, …), não uma lista
// fixa. Em X11/XWayland o raise funciona, então nunca dispara. (issue: foco
// do terminal padrão do Ubuntu no Wayland.)
function isFocusUnsupported(state) {
  return !!state && !!state.wayland && !state.raised && !state.hasTab;
}

if (typeof module !== 'undefined') module.exports = { parseWindowId, pickWindow, tabChannel, tmuxTarget, parseEnviron, isFocusUnsupported };
