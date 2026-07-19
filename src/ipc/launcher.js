// src/ipc/launcher.js — launcher IPC (extraído do main.js, REF passo 5).
// Detecta CLIs de agentes + terminais disponíveis e sobe o agente num terminal
// (externo no macOS via osascript/open; aba embutida no Linux via node-pty). A
// LÓGICA PURA (pickTerminal/terminalArgs/tmuxSessionName/tmuxWrap/TERMINAL_ORDER)
// continua em src/launcher.js; este módulo é o glue IPC + spawn.
//
// DI: getSettings, notifyUser, T, scanPathBin (compartilhada c/ hasBin), hasBin,
// lastSessionCwd, ensureTermWin/addTermSession/spawnPtyLocal (do domínio terminal
// — passadas pelo main até o REF passo 2 extrair o terminal).
// Retorna { detectLaunchers, launchAgent } para o tray.

function setupLauncherIpc({ ipcMain, getSettings, notifyUser, T, scanPathBin, hasBin, lastSessionCwd, ensureTermWin, addTermSession, spawnPtyLocal }) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const { AGENTS } = require('../agents');
  const launcher = require('../launcher');
  const { shellQuote } = require('../validate');

  function escapeAppleScriptString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function detectLaunchers() {
    if (_launchers && Date.now() - _launchersAt < 10000) return _launchers; // cache 10s
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

    // Linux: lança DIRETO numa aba da janela Terminal, dentro de um tmux próprio.
    // Não depende de terminal externo (tilix/Warp) — o ATL controla o spawn e
    // garante o wrap; o hook do agente captura tmux_session (#S) e o overlay mostra.
    const hasTmux = hasBin('tmux');
    const sessionName = launcher.tmuxSessionName(agent) + '-' + Date.now().toString(36);
    ensureTermWin();
    const tabId = addTermSession({ title: (a && a.label) || agent, kind: 'local' });
    spawnPtyLocal(tabId, hasTmux ? launcher.tmuxWrap([entry.path], sessionName) : [entry.path], dir);
  }

  function openInWarp(cmdArray, dir) {
    const warpDir = path.join(process.env.HOME || '/', '.warp', 'launch_configurations');
    try {
      fs.mkdirSync(warpDir, { recursive: true });
      const yamlPath = path.join(warpDir, 'atl-attach.yaml');
      const cmdStr = cmdArray.map(shellQuote).join(' ');   // cada arg shell-quoted → cmd shell seguro
      const yaml = [
        'name: ATL Attach', 'windows:', '  - tabs:', '      - panes:',
        `          - cwd: ${JSON.stringify(dir)}`,
        '            commands:',
        `              - ${JSON.stringify(cmdStr)}`,
      ].join('\n') + '\n';
      fs.writeFileSync(yamlPath, yaml, 'utf8');
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(opener, ['warp://launch/atl-attach'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    } catch { return false; }
  }

  function openCmdInTerminal(cmdArray, cwd) {
    const dir = (cwd && typeof cwd === 'string') ? cwd : (process.env.HOME || '/');
    if (getSettings().terminal === 'warp') { if (openInWarp(cmdArray, dir)) return; }   // pref Warp
    const avail = availableTerminals();
    const term = launcher.pickTerminal(getSettings().terminal, avail);
    const useTerm = term || (avail.includes('gnome-terminal') ? 'gnome-terminal' : 'x-terminal-emulator');
    const args = launcher.terminalArgs(useTerm, dir, cmdArray) || ['-e', ...cmdArray];
    try { spawn(useTerm, args, { detached: true, stdio: 'ignore', cwd: dir }).unref(); }
    catch (e) { notifyUser('Attach failed: ' + e.message); }
  }

  ipcMain.handle('get-launchers', () => detectLaunchers().map((l) => ({ id: l.id, label: AGENTS[l.id].label })));
  ipcMain.on('launch-agent', (_e, target) => launchAgent(target || {}));

  return { detectLaunchers, launchAgent };
}

module.exports = { setupLauncherIpc };

