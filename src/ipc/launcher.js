// src/ipc/launcher.js — launcher IPC (extracted from main.js, REF step 5).
// Detects available agent CLIs + terminals and brings the agent up in a
// terminal (external on macOS via osascript/open; embedded tab on Linux via
// node-pty). The PURE LOGIC (pickTerminal/terminalArgs/tmuxSessionName/
// tmuxWrap/TERMINAL_ORDER) stays in src/launcher.js; this module is the IPC
// glue + spawn.
//
// DI: getSettings, notifyUser, T, scanPathBin (shared w/ hasBin), hasBin,
// lastSessionCwd, ensureTermWin/addTermSession/spawnPtyLocal (from the terminal
// domain — passed by main until REF step 2 extracts the terminal).
// Returns { detectLaunchers, launchAgent } for the tray.

function setupLauncherIpc({ ipcMain, getSettings, notifyUser, T, scanPathBin, hasBin, lastSessionCwd, ensureTermWin, addTermSession, spawnPtyLocal }) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const { AGENTS } = require('../agents');
  const launcher = require('../launcher');

  function escapeAppleScriptString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // Which agents have a CLI available? The settings override takes precedence
  // over PATH.
  // Cache of the PATH scan — came along from main in REF step 5 (the vars had
  // stayed there, out of this module's scope → ReferenceError on the 1st
  // get-launchers).
  let _launchers = null, _launchersAt = 0;

  function detectLaunchers() {
    if (_launchers && Date.now() - _launchersAt < 10000) return _launchers; // 10s cache
    const out = [];
    for (const [id, a] of Object.entries(AGENTS)) {
      if (!a.bin) continue;
      const override = getSettings().launchers && getSettings().launchers[id];
      const path = (typeof override === 'string' && override) ? override : scanPathBin(a.bin);
      if (path) out.push({ id, path, overridden: !!override });
    }
    _launchers = out;
    _launchersAt = Date.now();
    return out;
  }

  function availableTerminals() {
    if (process.platform === 'darwin') {
      const list = [];
      const homeApps = path.join(process.env.HOME || '/', 'Applications');

      if (fs.existsSync('/Applications/iTerm.app') || 
          fs.existsSync(path.join(homeApps, 'iTerm.app')) || 
          !!scanPathBin('iterm')) {
        list.push('iterm2');
      }
      if (fs.existsSync('/System/Applications/Utilities/Terminal.app') || 
          fs.existsSync('/Applications/Utilities/Terminal.app') || 
          fs.existsSync(path.join(homeApps, 'Utilities/Terminal.app'))) {
        list.push('terminal');
      }
      if (fs.existsSync('/Applications/Warp.app') || 
          fs.existsSync(path.join(homeApps, 'Warp.app')) ||
          !!scanPathBin('warp')) {
        list.push('warp');
      }
      if (fs.existsSync('/Applications/Ghostty.app') || 
          fs.existsSync(path.join(homeApps, 'Ghostty.app')) || 
          !!scanPathBin('ghostty')) {
        list.push('ghostty');
      }
      return list;
    }
    return launcher.TERMINAL_ORDER.filter((t) => !!scanPathBin(t));
  }

  function launchAgent({ agent, cwd }) {
    const a = AGENTS[agent];
    if (!a) return;
    const entry = detectLaunchers().find((l) => l.id === agent);
    if (!entry) { notifyUser(T('ntf_no_launcher', { agent: a.label })); return; }
    const dir = (cwd && typeof cwd === 'string') ? cwd : (lastSessionCwd() || process.env.HOME || '/');

    if (process.platform === 'darwin') {
      const term = getSettings().terminal === 'auto' ? (availableTerminals()[0] || 'terminal') : getSettings().terminal;

      if (term === 'terminal') {
        const escDir = escapeAppleScriptString(dir);
        const escPath = escapeAppleScriptString(entry.path);
        const appleScript = `
          tell application "Terminal"
            do script "cd " & quoted form of "${escDir}" & " && " & quoted form of "${escPath}"
            activate
          end tell
        `;
        try { spawn('osascript', ['-e', appleScript], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { notifyUser(`Launch failed: ${e.message}`); }
        return;
      }

      if (term === 'iterm2') {
        const escDir = escapeAppleScriptString(dir);
        const escPath = escapeAppleScriptString(entry.path);
        const appleScript = `
          tell application "iTerm"
            create window with default profile
            tell current session of current window
              write text "cd " & quoted form of "${escDir}" & " && " & quoted form of "${escPath}"
            end tell
            activate
          end tell
        `;
        try { spawn('osascript', ['-e', appleScript], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { notifyUser(`Launch failed: ${e.message}`); }
        return;
      }

      if (term === 'warp') {
        const warpDir = path.join(process.env.HOME || '/', '.warp', 'launch_configurations');
        try {
          fs.mkdirSync(warpDir, { recursive: true });
          const configName = `ai-traffic-lights-${agent}`;
          const yamlPath = path.join(warpDir, `${configName}.yaml`);
          const yamlContent = [
            `name: AI Traffic Lights - ${agent}`,
            `windows:`,
            `  - tabs:`,
            `      - panes:`,
            `          - cwd: ${JSON.stringify(dir)}`,
            `            commands:`,
            `              - ${JSON.stringify(entry.path)}`
          ].join('\n') + '\n';
          fs.writeFileSync(yamlPath, yamlContent, 'utf8');
          spawn('open', [`warp://launch/${configName}`], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {
          notifyUser(`Launch failed: ${e.message}`);
        }
        return;
      }

      if (term === 'ghostty') {
        try { spawn('open', ['-a', 'Ghostty', '--args', `--working-directory=${dir}`, `--initial-command=${entry.path}`], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { notifyUser(`Launch failed: ${e.message}`); }
        return;
      }
    }

    // Linux: launches DIRECTLY into a tab of the Terminal window, inside its
    // own tmux. Doesn't depend on an external terminal (tilix/Warp) — ATL
    // controls the spawn and guarantees the wrap; the agent hook captures
    // tmux_session (#S) and the overlay shows it.
    const hasTmux = hasBin('tmux');
    const sessionName = launcher.tmuxSessionName(agent) + '-' + Date.now().toString(36);
    ensureTermWin();
    const tabId = addTermSession({ title: (a && a.label) || agent, kind: 'local' });
    spawnPtyLocal(tabId, hasTmux ? launcher.tmuxWrap([entry.path], sessionName) : [entry.path], dir);
  }

  // (openInWarp/openCmdInTerminal removed: they were the last callers of
  // pickTerminal/terminalArgs in IPC and had NO caller at all — dead code
  // since REF step 5. The pure logic remains in src/launcher.js, with tests.)

  ipcMain.handle('get-launchers', () => detectLaunchers().map((l) => ({ id: l.id, label: AGENTS[l.id].label })));
  ipcMain.on('launch-agent', (_e, target) => launchAgent(target || {}));

  return { detectLaunchers, launchAgent };
}

module.exports = { setupLauncherIpc };

