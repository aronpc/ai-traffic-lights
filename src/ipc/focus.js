// src/ipc/focus.js — focus IPC (extraído do main.js, REF passo 4).
// Electron-bound (ipcMain) + I/O de processo (wmctrl/osascript/tmux/ps/proc).
// A LÓGICA PURA (pickWindow/tabChannel/tmuxTarget/tmuxClientPid/parseEnviron/
// focusFailure) continua em src/focus.js (testada); este módulo é o glue IPC +
// o I/O de foco.
//
// PLATAFORMA — cada primitiva responde por si e degrada em silêncio quando não
// sabe responder (nunca lança):
//   ler environ  linux /proc/<pid>/environ · macOS `ps -E` · Windows: NÃO HÁ
//                (exige código nativo) → sem hints, sem âncora, sem prova
//   ancestrais   linux /proc/<pid>/status · macOS `ps -o ppid=` · Windows: —
//   levantar     linux wmctrl (X11; Wayland nativo é cego) · macOS osascript
//   âncora tmux  linux e macOS (mesmo binário) · Windows: n/a
//
// DI: getProcessEnviron (compartilhado c/ usage — lê environ do proc), notifyUser,
// T, IS_WAYLAND. parseMacOSEnviron/escapeAppleScriptString/getProcessEnviron
// ficam no main (compartilhados c/ usage/launcher).

function setupFocusIpc({ ipcMain, getProcessEnviron, notifyUser, T, IS_WAYLAND }) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const focus = require('../focus');

  // Constroi o set de PIDs ancestrais (para casar janela/aba do agente mesmo
  // quando o agente é filho de um wrapper). /proc no Linux, ps no macOS.
  function ancestorPidsOf(pid) {
    const set = new Set();
    let p = pid;
    if (process.platform === 'darwin') {
      for (let i = 0; i < 25 && p > 1; i++) {
        set.add(p);
        try {
          const ppidStr = execFileSync('ps', ['-o', 'ppid=', '-p', p], { encoding: 'utf8', timeout: 1000 }).trim();
          if (!ppidStr) break;
          p = parseInt(ppidStr, 10);
        } catch { break; }
      }
    } else {
      for (let i = 0; i < 25 && p > 1; i++) {
        set.add(p);
        try {
          const m = fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^PPid:\s+(\d+)/m);
          if (!m) break;
          p = parseInt(m[1], 10);
        } catch { break; }
      }
    }
    return set;
  }

  // Terminais conhecidos: comm do processo → chave usada como PROVA em
  // focus.tabChannel, e o nome do app pro AppleScript de fallback no macOS.
  // Padrões ancorados no início porque /proc/<pid>/comm trunca em 15 chars
  // (gnome-terminal-server vira "gnome-terminal-").
  // ADICIONAR UM TERMINAL = uma linha aqui + uma em TAB_CHANNELS (src/focus.js)
  // + o executor em focusTab, se ele tiver canal de aba.
  const TERMINALS = [
    { key: 'warp',      match: /warp/i,             mac: 'Warp' },
    { key: 'iterm',     match: /^iterm/i,           mac: 'iTerm' },
    { key: 'apple',     match: /^Terminal$/,        mac: 'Terminal' },
    { key: 'ghostty',   match: /^ghostty/i,         mac: 'Ghostty' },
    { key: 'tilix',     match: /^tilix/i },
    { key: 'konsole',   match: /^konsole/i },
    { key: 'kitty',     match: /^kitty/i },
    { key: 'alacritty', match: /^alacritty/i },
    { key: 'wezterm',   match: /^wezterm/i },
    { key: 'gnome',     match: /^gnome-terminal/i },
    { key: 'xfce4',     match: /^xfce4-terminal/i },
  ];

  // comm de um pid. '' quando não dá pra saber (Windows, /proc que sumiu, ps
  // que falhou) — o chamador trata '' como "desconhecido", nunca como erro.
  function procComm(pid) {
    try {
      if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (process.platform === 'darwin') {
        return execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8', timeout: 500 }).trim();
      }
    } catch {}
    return '';
  }

  // Qual terminal está desenhando esta sessão, provado pela árvore de processos
  // do pid de âncora. null = não reconhecemos ninguém → nenhum canal liberado.
  function detectTerminal(ancestorPids) {
    for (const p of ancestorPids) {
      const comm = procComm(p);
      if (!comm) continue;
      const base = path.basename(comm);
      for (const t of TERMINALS) if (t.match.test(base) || t.match.test(comm)) return t;
    }
    return null;
  }

  // AppleScript não tem escape nativo; aspas e barras precisam ir escapadas.
  function escapeAppleScriptString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Ordem: no X11, raise a janela e então troca a aba. No Wayland, a aba primeiro
  // (wmctrl só enxerga XWayland) e o raise vira tentativa-bônus.
  function raiseWindow(windowid, ancestors, macApp) {
    if (!ancestors || !ancestors.size) return false;
    if (process.platform === 'darwin') {
      const list = Array.from(ancestors);
      for (let i = list.length - 1; i >= 0; i--) {
        const apid = list[i];
        try {
          const check = execFileSync('osascript', ['-e', `tell application "System Events" to get name of first process whose unix id is ${apid}`], { encoding: 'utf8', timeout: 500 }).trim();
          if (check) {
            execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of first process whose unix id is ${apid} to true`], { timeout: 1000 });
            return true;
          }
        } catch {}
      }
      if (macApp) {
        try {
          execFileSync('osascript', ['-e', `tell application "${escapeAppleScriptString(macApp)}" to activate`], { timeout: 2000 });
          return true;
        } catch {}
      }
      return false;
    }
    if (process.platform !== 'linux') return false; // Windows: sem implementação
    let out = '';
    try { out = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf8', timeout: 2000 }); } catch { return false; }
    const wins = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s/);
      if (m) wins.push({ id: m[1], idNum: parseInt(m[1], 16), pid: parseInt(m[2], 10) });
    }
    const id = focus.pickWindow(windowid, wins, ancestors);
    if (id) { try { execFileSync('wmctrl', ['-i', '-a', id], { timeout: 2000 }); return true; } catch { return false; } }
    return false;
  }

  // Executa o canal escolhido. Devolve se a aba foi de fato alcançada — o
  // chamador precisa da verdade pra decidir se avisa o usuário.
  function focusTab(state) {
    const ch = focus.tabChannel(state);
    if (!ch) return false;
    try {
      if (ch.kind === 'warp') {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execFileSync(cmd, [ch.value], { timeout: 2000 });
      } else if (ch.kind === 'tilix') {
        execFileSync('gdbus', ['call', '--session', '--dest', 'com.gexperts.Tilix',
          '--object-path', '/com/gexperts/Tilix', '--method', 'org.gtk.Actions.Activate',
          'activate-terminal', `[<'${ch.value}'>]`, '{}'], { timeout: 2000 });
      } else if (ch.kind === 'iterm') {
        // iTerm2 expõe a sessão por id (o uuid depois do ':' em ITERM_SESSION_ID).
        // NÃO VALIDADO EM macOS — ver docs/ARCHITECTURE.md.
        const id = escapeAppleScriptString(ch.value);
        execFileSync('osascript', ['-e', [
          'tell application "iTerm2"', 'activate',
          'repeat with w in windows', 'repeat with t in tabs of w', 'repeat with s in sessions of t',
          `if id of s is "${id}" then`, 'select w', 'select t', 'select s', 'return',
          'end if', 'end repeat', 'end repeat', 'end repeat', 'end tell',
        ].join('\n')], { timeout: 3000 });
      } else {
        return false;
      }
      return true;
    } catch { return false; }
  }

  // Foca o PAINEL do agente dentro do tmux (complementar ao raise/tab). O pane
  // id ($TMUX_PANE) é global no server; select-window traz a janela do pane e
  // select-pane o ativa. execFileSync não passa por shell e o pane é validado
  // em focus.tmuxTarget → seguro como argumento.
  function focusTmuxPane(state) {
    const pane = focus.tmuxTarget(state);
    if (!pane) return false;
    try {
      execFileSync('tmux', ['select-window', '-t', pane], { timeout: 2000 });
      execFileSync('tmux', ['select-pane', '-t', pane], { timeout: 2000 });
      return true;
    } catch { return false; }
  }

  // Resolve o PID do tmux CLIENT anexado à sessão do pane do agente. É o elo
  // que falta sob tmux: o server é um daemon reparentado pro init, então o PID
  // do agente NUNCA alcança o terminal — mas o client é filho direto dele.
  // Duas chamadas ao tmux (list-panes/list-clients); a escolha é pura e testada
  // em focus.tmuxClientPid. null quando não há tmux/pane/client anexado.
  function tmuxClientPidOf(state) {
    const pane = focus.tmuxTarget(state);
    if (!pane) return null;
    try {
      const panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{session_name}'],
        { encoding: 'utf8', timeout: 2000 })
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => { const [p, ...s] = l.split(' '); return { pane: p, session: s.join(' ') }; });
      const clients = execFileSync('tmux', ['list-clients', '-F', '#{client_session} #{client_pid} #{client_activity}'],
        { encoding: 'utf8', timeout: 2000 })
        .split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const parts = l.split(' ');
          const activity = parseInt(parts.pop(), 10);
          const pid = parseInt(parts.pop(), 10);
          return { session: parts.join(' '), pid, activity: Number.isNaN(activity) ? 0 : activity };
        });
      return focus.tmuxClientPid(pane, panes, clients);
    } catch { return null; }
  }

  // Enriquece o alvo com os hints de foco lidos AO VIVO do processo.
  // O state file guarda um snapshot capturado no prompt; o environ é a fonte
  // viva — cobre sessões cujo evento veio antes do hook atual e as detectadas
  // só via /proc (sem focus_url/tilix_id no state). O state tem precedência.
  function enrichTarget(target) {
    if (!target || !target.pid) return target;
    try {
      const hints = focus.parseEnviron(getProcessEnviron(target.pid));
      return {
        ...target,
        focus_url: target.focus_url || hints.focus_url,
        tilix_id: target.tilix_id || hints.tilix_id,
        iterm_id: target.iterm_id || hints.iterm_id,
        tmux_pane: target.tmux_pane || hints.tmux_pane,
      };
    } catch { return target; }
  }

  // Sob tmux, reancora o alvo no tmux CLIENT da sessão do agente:
  //  • anchorPid — o client É filho do emulador, então ancestorPidsOf(anchorPid)
  //    alcança a janela; a do agente morre no `tmux server → systemd`.
  //  • hints de aba — os do state vieram do environ CONGELADO do server tmux e
  //    são idênticos em TODAS as sessões dele. Os do client são por-aba e
  //    vivos, então SUBSTITUEM os do state EM BLOCO. Substituir em bloco (e não
  //    com `||`) é o que mata o fantasma: quando o server nasceu num Warp que
  //    hoje nem roda e o client está no Tilix, o client não tem focus_url
  //    nenhum — e um `||` deixaria o `warp://` velho passar, abrindo o Warp por
  //    cima do terminal real. Sem hint do client, sobra a prova do terminal
  //    (detectTerminal) pra decidir, que é o comportamento correto.
  //  • windowid — MANTIDO: foi capturado pelo xdotool no prompt, e pickWindow o
  //    valida contra os ancestrais do client, que agora alcançam o emulador.
  //  • detached — há pane mas nenhum client anexado: a sessão existe, janela não.
  function anchorOnTmuxClient(t) {
    if (!focus.tmuxTarget(t)) return t;              // não está em tmux
    const cpid = tmuxClientPidOf(t);
    if (!cpid) return { ...t, detached: true };
    const live = focus.parseEnviron(getProcessEnviron(cpid));
    return {
      ...t,
      anchorPid: cpid,
      focus_url: live.focus_url,
      tilix_id: live.tilix_id,
      iterm_id: live.iterm_id,
    };
  }

  function focusSession(target) {
    if (!target) return;
    // Sessão de OUTRA máquina (sync P2P): o pid é de outro kernel. Recusamos
    // ANTES de tocar em /proc ou wmctrl — interpretar esse pid aqui focaria um
    // processo local homônimo, que é a mesma classe de erro do windowid
    // reciclado, um nível acima.
    if (focus.isRemoteSession(target)) { notifyUser(T('ntf_focus_remote')); return; }

    const t = anchorOnTmuxClient(enrichTarget(target));
    // Uma varredura só da árvore, compartilhada pela janela e pela prova do
    // terminal — no macOS cada nível custa um fork de `ps`.
    const ancestors = ancestorPidsOf(t.anchorPid || t.pid);
    const term = detectTerminal(ancestors);
    const st = { ...t, terminal: term ? term.key : null };
    const macApp = term ? (term.mac || null) : null;

    let raised = false, tabbed = false;
    if (IS_WAYLAND) {
      tabbed = focusTab(st);
      raised = raiseWindow(st.windowid, ancestors, macApp);
    } else {
      raised = raiseWindow(st.windowid, ancestors, macApp);
      tabbed = focusTab(st);
    }
    // Complementar: o painel do agente dentro do tmux. Sem client anexado isso
    // não tem efeito VISÍVEL, então não conta como "o clique funcionou".
    const paned = st.detached ? false : focusTmuxPane(st);

    // Nada levantado e nada alcançado = clique sem efeito. Avisamos com a razão
    // em vez de parecer quebrado — silêncio aqui é o pior desfecho.
    const why = focus.focusFailure({
      wayland: IS_WAYLAND, raised, hasTab: tabbed || paned, detached: st.detached,
    });
    if (why) notifyUser(T(`ntf_focus_${why}`));
  }

  ipcMain.on('focus', (_e, target) => focusSession(target));
}

module.exports = { setupFocusIpc };
