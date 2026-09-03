// src/ipc/focus.js — focus IPC (extracted from main.js, REF step 4).
// Electron-bound (ipcMain) + process I/O (wmctrl/osascript/tmux/ps/proc).
// The PURE LOGIC (pickWindow/tabChannel/tmuxTarget/tmuxClientPid/parseEnviron/
// focusFailure) stays in src/focus.js (tested); this module is the IPC glue +
// the focus I/O.
//
// PLATFORM — each primitive answers for itself and degrades silently when it
// can't answer (never throws):
//   read environ  linux /proc/<pid>/environ · macOS `ps -E` · Windows: NONE
//                 (requires native code) → no hints, no anchor, no proof
//   ancestors     linux /proc/<pid>/status · macOS `ps -o ppid=` · Windows: —
//   raise         linux wmctrl (X11; native Wayland is blind) · macOS osascript
//   tmux anchor   linux and macOS (same binary) · Windows: n/a
//
// DI: getProcessEnviron (shared w/ usage — reads environ from proc),
// notifyUser, T, IS_WAYLAND. parseMacOSEnviron/escapeAppleScriptString/
// getProcessEnviron stay in main (shared w/ usage/launcher).

function setupFocusIpc({ ipcMain, getProcessEnviron, notifyUser, T, IS_WAYLAND }) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const focus = require('../focus');

  // Builds the set of ancestor PIDs (to match the agent's window/tab even
  // when the agent is a child of a wrapper). /proc on Linux, ps on macOS.
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

  // Known terminals: process comm → key used as PROOF in
  // focus.tabChannel, and the app name for the fallback AppleScript on macOS.
  // Patterns anchored at the start because /proc/<pid>/comm truncates at 15
  // chars (gnome-terminal-server becomes "gnome-terminal-").
  // ADDING A TERMINAL = one line here + one in TAB_CHANNELS (src/focus.js)
  // + the executor in focusTab, if it has a tab channel.
  // `base` matches against the BASENAME (anchored at the start); `bundle`
  // against the whole path, and only exists on macOS, where `ps -o comm=`
  // returns the full executable. Both are intentionally strict: a loose
  // pattern like /warp/i against the whole path would match any ancestor
  // under a directory with "warp" in the name (a user named warp,
  // ~/warpdev/bin/node) — and "proving" Warp by mistake reopens exactly the
  // ghost channel this fix exists to block.
  const TERMINALS = [
    { key: 'warp',      base: /^warp/i,           bundle: /\/Warp\.app\//,     mac: 'Warp' },
    { key: 'iterm',     base: /^iterm/i,          bundle: /\/iTerm\.app\//,    mac: 'iTerm2' },
    { key: 'apple',     base: /^Terminal$/,       bundle: /\/Terminal\.app\//, mac: 'Terminal' },
    { key: 'ghostty',   base: /^ghostty/i,        bundle: /\/Ghostty\.app\//,  mac: 'Ghostty' },
    { key: 'tilix',     base: /^tilix/i },
    { key: 'konsole',   base: /^konsole/i },
    { key: 'kitty',     base: /^kitty/i },
    { key: 'alacritty', base: /^alacritty/i },
    { key: 'wezterm',   base: /^wezterm/i },
    { key: 'gnome',     base: /^gnome-terminal/i },
    { key: 'xfce4',     base: /^xfce4-terminal/i },
  ];

  // comm of a pid. '' when it can't be determined (Windows, /proc that
  // vanished, ps that failed) — the caller treats '' as "unknown", never as
  // an error.
  function procComm(pid) {
    try {
      if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (process.platform === 'darwin') {
        return execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8', timeout: 500 }).trim();
      }
    } catch {}
    return '';
  }

  // Which terminal is drawing this session, proven by the process tree of
  // the anchor pid. null = nobody we recognize → no channel released.
  function detectTerminal(ancestorPids) {
    for (const p of ancestorPids) {
      const comm = procComm(p);
      if (!comm) continue;
      const base = path.basename(comm);
      for (const t of TERMINALS) {
        if (t.base.test(base)) return t;
        if (t.bundle && t.bundle.test(comm)) return t;
      }
    }
    return null;
  }

  // Activates the window. xdotool BEFORE wmctrl: `xdo_activate_window` sends
  // _NET_ACTIVE_WINDOW with source indication "pager" (data.l[0]=2, verified
  // in libxdo's .rodata), which Mutter accepts even with
  // focus-new-windows='smart'; `wmctrl -i -a` sends the legacy form and from
  // the 2nd consecutive click the request could be ignored — the window just
  // flashed in the dock. --sync with a short timeout: if the WM refuses, the
  // throw returns false instead of lying.
  function activateWindow(id) {
    if (!id) return false;
    try { execFileSync('xdotool', ['windowactivate', '--sync', String(id)], { timeout: 900 }); return true; } catch {}
    try { execFileSync('wmctrl', ['-i', '-a', String(id)], { timeout: 2000 }); return true; } catch {}
    return false;
  }

  // AppleScript has no native escaping; quotes and backslashes must be escaped.
  function escapeAppleScriptString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Order: on X11, raise the window then switch the tab. On Wayland, the tab
  // first (wmctrl only sees XWayland) and the raise becomes a bonus attempt.
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
    if (process.platform !== 'linux') return false; // Windows: no implementation
    let out = '';
    try { out = execFileSync('wmctrl', ['-l', '-p'], { encoding: 'utf8', timeout: 2000 }); } catch { return false; }
    const wins = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+\S+\s+(\d+)\s/);
      if (m) wins.push({ id: m[1], idNum: parseInt(m[1], 16), pid: parseInt(m[2], 10) });
    }
    const id = focus.pickWindow(windowid, wins, ancestors);
    return id ? activateWindow(id) : false;
  }

  // Runs the chosen channel. Returns whether the tab was actually reached —
  // the caller needs the truth to decide whether to notify the user.
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
        // iTerm2 exposes the session by id (the uuid after the ':' in
        // ITERM_SESSION_ID), already validated as [A-Za-z0-9-] in
        // focus.TAB_CHANNELS.
        // The script scans windows/tabs/sessions and EXITS 0 even without
        // finding anything, so the exit code proves no focus at all: it returns
        // "hit"/"miss" and that's what we check. Without this, a stale
        // ITERM_SESSION_ID (closed tab, agent alive in tmux) would count as
        // success and the user wouldn't be notified.
        // NOT VALIDATED ON macOS — see docs/ARCHITECTURE.md.
        const id = escapeAppleScriptString(ch.value);
        const out = execFileSync('osascript', ['-e', [
          'tell application "iTerm2"', 'activate',
          'repeat with w in windows', 'repeat with t in tabs of w', 'repeat with s in sessions of t',
          `if id of s is "${id}" then`, 'select w', 'select t', 'select s', 'return "hit"',
          'end if', 'end repeat', 'end repeat', 'end repeat', 'end tell',
          'return "miss"',
        ].join('\n')], { encoding: 'utf8', timeout: 3000 });
        return String(out).trim() === 'hit';
      } else {
        return false;
      }
      return true;
    } catch { return false; }
  }

  // Focuses the agent's PANE inside tmux (complementary to raise/tab). The
  // pane id ($TMUX_PANE) is global on the server; select-window brings the
  // pane's window and select-pane activates it. execFileSync doesn't go
  // through a shell and the pane is validated in focus.tmuxTarget → safe as
  // an argument.
  function focusTmuxPane(state) {
    const pane = focus.tmuxTarget(state);
    if (!pane) return false;
    try {
      execFileSync('tmux', ['select-window', '-t', pane], { timeout: 2000 });
      execFileSync('tmux', ['select-pane', '-t', pane], { timeout: 2000 });
      return true;
    } catch { return false; }
  }

  // Resolves the PID of the tmux CLIENT attached to the agent's pane session.
  // It's the missing link under tmux: the server is a daemon reparented to
  // init, so the agent's PID NEVER reaches the terminal — but the client is a
  // direct child of it. Two tmux calls (list-panes/list-clients); the choice
  // is pure and tested in focus.tmuxClientPid. null when there's no attached
  // tmux/pane/client. Returns { pid, asked }. The distinction matters for
  // the message:
  //   asked=false → we couldn't ASK tmux (binary outside the Electron
  //     process's PATH — which in a .desktop/AppImage is minimal —, socket in
  //     another TMUX_TMPDIR, Flatpak/Snap packaging, unexpected output).
  //     Saying "run attach" on a session that is attached and visible is worse
  //     than staying quiet.
  //   asked=true + pid=null → we asked and there is no client: truly detached.
  function tmuxClientPidOf(state) {
    const pane = focus.tmuxTarget(state);
    if (!pane) return { pid: null, asked: false };
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
      return { pid: focus.tmuxClientPid(pane, panes, clients), asked: true };
    } catch { return { pid: null, asked: false }; }
  }

  // Enriches the target with focus hints read LIVE from the process.
  // The state file holds a snapshot captured at prompt time; environ is the
  // live source — covers sessions whose event came before the current hook
  // and those detected only via /proc (no focus_url/tilix_id in state).
  // State takes precedence.
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

  // Under tmux, re-anchors the target on the tmux CLIENT of the agent's
  // session:
  //  • anchorPid — the client IS a child of the emulator, so
  //    ancestorPidsOf(anchorPid) reaches the window; the agent's dies at
  //    `tmux server → systemd`.
  //  • tab hints — the ones from state came from the FROZEN environ of the
  //    tmux server and are identical across ALL its sessions. The client's
  //    are per-tab and live, so they REPLACE the state's EN BLOC. Replacing
  //    en bloc (not with `||`) is what kills the ghost: when the server was
  //    born in a Warp that isn't even running today and the client is in
  //    Tilix, the client has no focus_url at all — and `||` would let the
  //    stale `warp://` through, opening Warp on top of the real terminal.
  //    With no client hint, what's left to decide is the terminal proof
  //    (detectTerminal), which is the correct behavior.
  //  • windowid — KEPT: it was captured by xdotool at prompt time, and
  //    pickWindow validates it against the client's ancestors, which now
  //    reach the emulator.
  //  • detached — there's a pane but no attached client: the session exists,
  //    the window doesn't.
  function anchorOnTmuxClient(t) {
    if (!focus.tmuxTarget(t)) return t;              // not in tmux
    const { pid: cpid, asked } = tmuxClientPidOf(t);
    if (!cpid) return asked ? { ...t, detached: true } : t;
    // Replacing en bloc is only safe when the read WORKED. getProcessEnviron
    // returns '' on any stumble (on macOS it's `ps -E`, which doesn't always
    // answer), and in that case zeroing the three hints would kill a channel
    // that was right. With no read we keep the state's: they may be stale,
    // but the terminal proof (detectTerminal) still blocks the wrong app's
    // channel.
    const raw = getProcessEnviron(cpid);
    if (!raw) return { ...t, anchorPid: cpid };
    const live = focus.parseEnviron(raw);
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
    // Session from ANOTHER machine (P2P sync): the pid belongs to another
    // kernel. We refuse BEFORE touching /proc or wmctrl — interpreting that
    // pid here would focus a homonymous local process, which is the same
    // class of error as a recycled windowid, one level up.
    if (focus.isRemoteSession(target)) { notifyUser(T('ntf_focus_remote')); return; }

    const t = anchorOnTmuxClient(enrichTarget(target));
    // A single tree scan, shared by the window and the terminal proof —
    // on macOS each level costs a fork of `ps`.
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
    // Complementary: the agent's pane inside tmux. NOT counted in the success
    // computation: `tmux select-pane` exits 0 even when the window containing
    // the pane is buried behind others (or the client is detached), so
    // counting it silenced exactly the case the warning was written for —
    // native Wayland terminal with no tab channel, window out of wmctrl's
    // reach.
    if (!st.detached) focusTmuxPane(st);

    // Nothing raised and no tab reached = click with no effect. We notify
    // with the reason instead of looking broken — silence here is the worst
    // outcome.
    const why = focus.focusFailure({
      wayland: IS_WAYLAND, raised, hasTab: tabbed, detached: st.detached,
    });
    if (why) notifyUser(T(`ntf_focus_${why}`));
  }

  ipcMain.on('focus', (_e, target) => focusSession(target));
}

module.exports = { setupFocusIpc };
