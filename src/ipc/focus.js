// src/ipc/focus.js — focus IPC (extraído do main.js, REF passo 4).
// Electron-bound (ipcMain) + I/O de processo (wmctrl/osascript/tmux/ps/proc).
// A LÓGICA PURA (pickWindow/tabChannel/tmuxTarget/parseEnviron/isFocusUnsupported)
// continua em src/focus.js (testada); este módulo é o glue IPC + o I/O de foco.
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

  function findTerminalAppNameFromPid(pid) {
    const ancestors = Array.from(ancestorPidsOf(pid));
    for (const p of ancestors) {
      try {
        const commPath = execFileSync('ps', ['-p', p, '-o', 'comm='], { encoding: 'utf8', timeout: 500 }).trim();
        const name = path.basename(commPath).toLowerCase();
        if (name.includes('warp') || commPath.includes('Warp.app')) return 'Warp';
        if (name.includes('iterm') || commPath.includes('iTerm.app')) return 'iTerm';
        if (name.includes('terminal') || commPath.includes('Terminal.app')) return 'Terminal';
        if (name.includes('ghostty') || commPath.includes('Ghostty.app')) return 'Ghostty';
      } catch {}
    }
    return null;
  }

  // Ordem: no X11, raise a janela e então troca a aba. No Wayland, a aba primeiro
  // (wmctrl só enxerga XWayland) e o raise vira tentativa-bônus.
  function raiseWindow(windowid, pid) {
    if (!pid) return false;
    if (process.platform === 'darwin') {
      const ancestors = Array.from(ancestorPidsOf(pid));
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const apid = ancestors[i];
        try {
          const check = execFileSync('osascript', ['-e', `tell application "System Events" to get name of first process whose unix id is ${apid}`], { encoding: 'utf8', timeout: 500 }).trim();
          if (check) {
            execFileSync('osascript', ['-e', `tell application "System Events" to set frontmost of first process whose unix id is ${apid} to true`], { timeout: 1000 });
            return true;
          }
        } catch {}
      }
      const appName = findTerminalAppNameFromPid(pid);
      if (appName) {
        try {
          execFileSync('osascript', ['-e', `tell application "${appName}" to activate`], { timeout: 2000 });
          return true;
        } catch {}
      }
      return false;
    }
    let list = '';
    try { list = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf8', timeout: 2000 }); } catch { return false; }
    const wins = [];
    for (const line of list.split('\n')) {
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s/);
      if (m) wins.push({ id: m[1], idNum: parseInt(m[1], 16), pid: parseInt(m[2], 10) });
    }
    const id = focus.pickWindow(windowid, wins, ancestorPidsOf(pid));
    if (id) { try { execFileSync('wmctrl', ['-i', '-a', id], { timeout: 2000 }); return true; } catch { return false; } }
    return false;
  }

  function focusTab(state) {
    const ch = focus.tabChannel(state);
    if (!ch) return;
    try {
      if (ch.kind === 'warp') {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execFileSync(cmd, [ch.value], { timeout: 2000 });
      } else if (ch.kind === 'tilix') {
        execFileSync('gdbus', ['call', '--session', '--dest', 'com.gexperts.Tilix',
          '--object-path', '/com/gexpencers.Tilix', '--method', 'org.gtk.Actions.Activate',
          'activate-terminal', `[<'${ch.value}'>]`, '{}'], { timeout: 2000 });
      }
    } catch {}
  }

  // Foca o PAINEL do agente dentro do tmux (complementar ao raise/tab). O pane
  // id ($TMUX_PANE) é global no server; select-window traz a janela do pane e
  // select-pane o ativa. execFileSync não passa por shell e o pane é validado
  // em focus.tmuxTarget → seguro como argumento.
  function focusTmuxPane(state) {
    const pane = focus.tmuxTarget(state);
    if (!pane) return;
    try {
      execFileSync('tmux', ['select-window', '-t', pane], { timeout: 2000 });
      execFileSync('tmux', ['select-pane', '-t', pane], { timeout: 2000 });
    } catch {}
  }

  // Enriquece o alvo com os hints de foco lidos AO VIVO do processo.
  // O state file guarda um snapshot capturado no prompt; o environ é a fonte
  // viva — cobre sessões cujo evento veio antes do hook atual e as detectadas
  // só via /proc (sem focus_url/tilix_id no state). O state tem precedência.
  function enrichTarget(target) {
    if (!target || !target.pid) return target;
    if (target.focus_url && target.tilix_id && target.tmux_pane) return target;
    try {
      const hints = focus.parseEnviron(getProcessEnviron(target.pid));
      return {
        ...target,
        focus_url: target.focus_url || hints.focus_url,
        tilix_id: target.tilix_id || hints.tilix_id,
        tmux_pane: target.tmux_pane || hints.tmux_pane,
      };
    } catch { return target; }
  }

  function focusSession(target) {
    if (!target) return;
    const t = enrichTarget(target);
    const hasTab = !!focus.tabChannel(t) || !!focus.tmuxTarget(t);
    let raised = false;
    if (IS_WAYLAND) { focusTab(t); raised = raiseWindow(t.windowid, t.pid); }
    else { raised = raiseWindow(t.windowid, t.pid); focusTab(t); }
    focusTmuxPane(t);   // complementar: foca o pane do agente dentro do tmux
    // Wayland + sem canal de aba + sem janela alcançável pelo wmctrl (ex.: GNOME
    // Terminal nativo) → o clique vira no-op silencioso. Avisamos em vez de parecer
    // quebrado (issue: foco do terminal padrão do Ubuntu no Wayland).
    if (focus.isFocusUnsupported({ wayland: IS_WAYLAND, raised, hasTab })) {
      notifyUser(T('ntf_focus_unsupported_wayland'));
    }
  }

  ipcMain.on('focus', (_e, target) => focusSession(target));
}

module.exports = { setupFocusIpc };
