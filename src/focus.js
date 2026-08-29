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

// Extrai os hints de foco de um /proc/<pid>/environ (Linux) ou da saída
// normalizada de `ps -E` (macOS) — KEY=VAL separados por NUL. É a fonte VIVA:
// usada no clique pra enriquecer sessões cujo state ainda não tem o hint
// (evento anterior ao hook novo, ou sessão só-/proc) e pra RESSINCRONIZAR os
// hints a partir do tmux client. No Windows não há equivalente (ler o environ
// de outro processo exige código nativo) — lá o chamador passa ''.
// ATENÇÃO: todo campo daqui é MACHINE-LOCAL — identifica uma janela/aba/painel
// deste kernel. Ao adicionar um, inclua-o também em LOCAL_ONLY (src/net.js),
// senão ele atravessa o sync e chega num peer apontando pra nada.
const ENV_HINTS = {
  WARP_FOCUS_URL: 'focus_url',   // Warp (Linux/macOS) — warp://session/<uuid>
  TILIX_ID: 'tilix_id',          // Tilix (Linux) — uuid do terminal
  ITERM_SESSION_ID: 'iterm_id',  // iTerm2 (macOS) — "w0t0p0:<uuid>"
  TMUX_PANE: 'tmux_pane',        // tmux — "%N", pane do agente
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

// Canais nativos que focam a ABA exata dentro do terminal (a janela é do
// gerenciador de janelas; a aba é interna ao terminal e só ele alcança).
//
// `app` é a PROVA exigida. O hint sozinho NÃO basta: hint herdado sobrevive ao
// app que o criou. Um WARP_FOCUS_URL congelado no environ de um tmux server
// nascido dentro do Warp vaza pra todo pane novo, para sempre — e disparar
// esse valor levanta o Warp por cima do terminal que está de fato na tela.
// Ressincronizar o hint a partir do client não cobre isso: quando o client não
// tem WARP_FOCUS_URL nenhum (tmux hoje rodando no Tilix), o fantasma do state
// sobrevive a um `live.focus_url || t.focus_url`. Exigir prova cobre.
//
// Quem prova é o chamador (src/ipc/focus.js), varrendo a árvore de processos
// do pid de âncora e preenchendo state.terminal. Sem prova → sem canal, e o
// clique degrada pra só levantar a janela: jamais abre o app errado.
//
// ADICIONAR UM TERMINAL = uma linha aqui + o comm em TERMINALS (ipc/focus.js)
// + o executor em focusTab. Nada mais.
const TAB_CHANNELS = [
  { kind: 'warp',  app: 'warp',  field: 'focus_url', valid: (v) => v.startsWith('warp://') },
  // ITERM_SESSION_ID é "w0t0p0:<uuid>"; o AppleScript quer só o uuid.
  { kind: 'iterm', app: 'iterm', field: 'iterm_id', map: (v) => (v.includes(':') ? v.slice(v.indexOf(':') + 1) : v) },
  { kind: 'tilix', app: 'tilix', field: 'tilix_id' },
];

function tabChannel(state) {
  if (!state || !state.terminal) return null;
  for (const ch of TAB_CHANNELS) {
    if (ch.app !== state.terminal) continue;
    const raw = state[ch.field];
    if (!raw) continue;
    let value = String(raw);
    if (ch.valid && !ch.valid(value)) continue;
    if (ch.map) value = ch.map(value);
    if (!value) continue;
    return { kind: ch.kind, value };
  }
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

// Sob tmux, o PID do agente NÃO alcança o terminal: o tmux server é um daemon
// reparentado pro init (systemd --user), então a cadeia de PPid do agente é
// agente → zsh → tmux server → systemd — o emulador (Warp/Tilix/…) nunca
// aparece. Quem É filho do terminal é o tmux CLIENT (um por aba anexada).
// Esta função escolhe o client CERTO: o que está anexado à sessão do pane do
// agente. Sem isso o pickWindow não acha janela nenhuma (raise falha) e o
// focus_url do state vem do environ CONGELADO do server (o mesmo pra todas as
// abas → xdg-open foca sempre a aba errada).
//   pane    — "%41" (state.tmux_pane)
//   panes   — [{pane, session}] de `tmux list-panes -a`
//   clients — [{session, pid, activity}] de `tmux list-clients`
// Retorna o pid do client, ou null (pane sem sessão/sem client anexado —
// sessão detached é normal: o agente roda, só não tem janela pra focar).
// Desempata pelo activity mais recente quando há N clients na mesma sessão.
function tmuxClientPid(pane, panes, clients) {
  if (!pane || !Array.isArray(panes) || !Array.isArray(clients)) return null;
  const entry = panes.find((p) => p && p.pane === pane);
  if (!entry) return null;
  const attached = clients.filter((c) => c && c.session === entry.session && c.pid > 0);
  if (!attached.length) return null;
  const best = attached.reduce((a, b) => ((b.activity || 0) > (a.activity || 0) ? b : a));
  return best.pid;
}

// Sessão de OUTRA máquina (sync P2P): o `pid` dela é de outro kernel, e
// interpretá-lo aqui focaria um processo local homônimo — a mesma classe de
// erro do windowid reciclado, um nível acima. `origin` vem de identity.js
// ('local' = esta máquina; nome do peer = remota).
function isRemoteSession(state) {
  return !!state && !!state.origin && state.origin !== 'local';
}

// Desfecho do clique: null quando teve efeito, senão a RAZÃO do no-op, pro
// chamador escolher a mensagem. Antes só o Wayland era reportado, mas o mesmo
// silêncio acontece no X11/macOS quando a sessão está num tmux sem client
// anexado, ou quando ela nem é desta máquina — "não fez nada, sem avisar" é o
// pior desfecho possível. Ordem = do mais específico ao mais genérico.
//   remote   — sessão de outro host: não há o que focar aqui
//   detached — tmux sem client anexado: a sessão existe, janela não
//   wayland  — Wayland nativo e o terminal não expõe canal de aba
//   nowindow — nenhuma janela da sessão e nenhum canal
function focusFailure(state) {
  if (!state) return null;
  if (isRemoteSession(state)) return 'remote';
  if (state.raised || state.hasTab) return null;
  if (state.detached) return 'detached';
  if (state.wayland) return 'wayland';
  return 'nowindow';
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseWindowId, pickWindow, tabChannel, tmuxTarget, tmuxClientPid,
    parseEnviron, focusFailure, isRemoteSession, TAB_CHANNELS, ENV_HINTS,
  };
}
