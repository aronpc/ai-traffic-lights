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

// Decide se o clique virou no-op: não raiseou a janela E não havia canal de
// aba. O main coleta hasTab (tabChannel != null) e raised (raiseWindow devolveu
// true) e pede a decisão aqui — assim o gate fica testável.
// Antes exigia `wayland: true`, o que deixava o X11 mudo: quando o raise falha
// ali (multiplexador quebrando a árvore de processos, ou o Mutter recusando a
// ativação) o clique não fazia NADA e não dizia nada. A plataforma não muda a
// pergunta — "teve algum efeito?" vale nas duas.
function isFocusUnsupported(state) {
  return !!state && !state.raised && !state.hasTab;
}

if (typeof module !== 'undefined') module.exports = { parseWindowId, pickWindow, tabChannel, tmuxTarget, tmuxClientPid, parseEnviron, isFocusUnsupported };
