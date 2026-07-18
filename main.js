// main.js — processo principal do Electron (ai-traffic-lights).
// Janela overlay translúcida, sempre no topo. Observa o diretório de estado,
// envia sessões ao renderer, auto-redimensiona a altura pelo nº de linhas,
// e persiste largura + posição entre reinícios.

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification, nativeImage, globalShortcut, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { AGENTS, agentOf } = require('./src/agents');
const hookInstaller = require('./src/hook-installer');
const focus = require('./src/focus');
const sessions = require('./src/sessions');
const collect = require('./src/collect');
const net = require('./src/net');
const transcript = require('./src/transcript');
const settingsLib = require('./src/settings');
const i18n = require('./src/i18n');
const launcher = require('./src/launcher');
const usage = require('./src/usage');
const { spawn } = require('child_process');
const { desktopEscape, shellQuote } = require('./src/validate');

// Flags de sandbox/shared-memory (--no-sandbox --disable-dev-shm-usage) vão na
// LINHA DE COMANDO: build.linux.executableArgs (packaged) e scripts.start (dev).
// Precisam chegar ao Chromium ANTES de ele inicializar o sandbox/shm — aqui no
// main.js é tarde demais (appendSwitch não funciona p/ esses switches), e a
// janela ficava transparente (sem compositing). Não usar appendSwitch aqui.

// Versão do app (do package.json — app.getVersion lê direto, funciona no asar)
// e URL pública do repo (rodapé das Preferências + tooltip do tray).
const APP_VERSION = app.getVersion();
const REPO_URL = 'https://github.com/aronpc/ai-traffic-lights';

// Instância única: relançar o app não duplica o overlay — TOGGLA o existente
// e sai. Previne overlays duplicados (autostart + lançamento manual) e dá um
// caminho de atalho no Wayland, onde X grabs (globalShortcut) não disparam
// com um app Wayland nativo em foco: vincule um atalho do GNOME ao comando
// do app e cada acionamento mostra/oculta.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => toggleWin());

// Sessão gráfica: no Wayland, wmctrl/xdotool só enxergam janelas XWayland —
// o foco por janela degrada e a URI nativa do terminal vira o caminho titular.
// Em XWayland forçado (--ozone-platform=x11 via executableArgs/start), o app é
// X11: wmctrl/xdotool enxergam as janelas e alwaysOnTop funciona (Wayland
// nativo ignora 'above'). Só tratamos como Wayland nativo (onde wmctrl falha e
// o foco por janela degrada) quando a flag NÃO está presente E a sessão é wayland.
const IS_WAYLAND = !process.argv.includes('--ozone-platform=x11') &&
  (process.env.XDG_SESSION_TYPE === 'wayland' ||
    (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11'));

// Diretório de dados neutro (XDG) — o state dir é o contrato entre adapters
// (escritores) e este app (leitor). Ver src/agents.js e hooks/traffic-hook.sh.
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const BASE_DIR = path.join(DATA_HOME, 'ai-traffic-lights');
const STATE_DIR = path.join(BASE_DIR, 'state');
const BOUNDS_FILE = path.join(BASE_DIR, 'window.json'); // {x, y, width}
const ALIASES_FILE = path.join(BASE_DIR, 'aliases.json'); // {sessionKey: apelido}
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json'); // {idleThresholdSec, escalateIdle, shortcut}
const USAGE_FILE = path.join(BASE_DIR, 'usage.json'); // último uso conhecido (sobrevive a reinício; mostrado stale até refrescar)
const CLAUDE_COOLDOWN_FILE = path.join(BASE_DIR, 'claude-cooldown.json'); // {until:<ms>} — cooldown do 429 da API de uso (SÓ o timestamp, nunca o token)
const SETTINGS_BOUNDS_FILE = path.join(BASE_DIR, 'settings-window.json'); // {x, y, width, height}
const TERM_BOUNDS_FILE = path.join(BASE_DIR, 'term-window.json'); // {x, y, width, height} da janela Terminal
const AUTOSTART_FILE = path.join(process.env.HOME, '.config/autostart/ai-traffic-lights.desktop');

// ---- migração da era claude-traffic-light (pré-rename) ----
const OLD_BASE = path.join(process.env.HOME, '.claude-shared/traffic-light');
const OLD_AUTOSTART = path.join(process.env.HOME, '.config/autostart/claude-traffic-light.desktop');
function migrateOldBase() {
  try {
    if (!fs.existsSync(OLD_BASE)) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // window.json / aliases.json: copia se ainda não existirem no novo lugar
    for (const f of ['window.json', 'aliases.json']) {
      const from = path.join(OLD_BASE, f), to = path.join(BASE_DIR, f);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to); } catch {}
    }
    // state files: move os que não existem no novo dir (hook pode já ter criado)
    const oldState = path.join(OLD_BASE, 'state');
    try {
      for (const f of fs.readdirSync(oldState).filter((x) => x.endsWith('.json'))) {
        const to = path.join(STATE_DIR, f);
        try { if (!fs.existsSync(to)) fs.renameSync(path.join(oldState, f), to); } catch {}
      }
    } catch {}
  } catch {}
}

// Mapas de detecção (COMM_TO_AGENT/ARGV_TO_AGENT/SHELLS) e a sonda /proc vivem
// em src/collect.js (core Electron-free, reusado pelo futuro agent.js headless).
// AGENTS ainda é usado aqui p/ UI/launcher/tray.

const DEFAULT_W = 360;
const HEADER_H = 58; // tem que casar com --header-h do CSS
const MIN_W = 348, MAX_W = 720; // 348: header com 5 botões (lista+footer+prefs+expand+fechar) sem cortar o ×
const MIN_H = HEADER_H + 40, MAX_H = 640;

let win;

// Coleta de sessões: locais (collect) + remotas (peers, já com `origin` setada
// pelo pollPeers). Wrapper preserva os call sites (sendSessions, timers, ipc).
// Sessões remotas entram no MESMO pipeline — sessionKey (namespaced por origin,
// em identity.js) as separa das locais, sem colisão de pid entre máquinas.
function readSessions() {
  const local = collect.readSessions();
  if (!remoteSessions.size) return local;
  return local.concat(Array.from(remoteSessions.values()).flat());
}

// ---- click-to-focus: ativa a janela (e a ABA, quando possível) da sessão ----
// Duas responsabilidades separadas (a decisão pura vive em src/focus.js):
//  • JANELA (X11/wmctrl): pickWindow() valida o windowid gravado contra a
//    árvore de processos da sessão — um id obsoleto/reciclado não foca mais a
//    janela errada (issue #1, H2); sem id válido, 1ª janela do processo.
//  • ABA (canal nativo do terminal, invisível pro X11): tabChannel() escolhe
//    Warp (`xdg-open warp://session/<uuid>`) ou Tilix (`gdbus activate-terminal
//    <TILIX_ID>`). É a única forma de alcançar a aba/pane certa.
// Ordem: no X11, raise a janela e então troca a aba. No Wayland, a aba primeiro
// (wmctrl só enxerga XWayland) e o raise vira tentativa-bônus.
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
        '--object-path', '/com/gexperts/Tilix', '--method', 'org.gtk.Actions.Activate',
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

function parseMacOSEnviron(content) {
  if (!content) return '';
  const regex = /(?<=\s|^)([A-Za-z0-9_]+)=/g;
  const matches = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push({
      key: match[1],
      index: match.index,
      valueStart: match.index + match[0].length
    });
  }
  const envVars = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].valueStart;
    const end = (i + 1 < matches.length) ? matches[i + 1].index : content.length;
    const val = content.slice(start, end).trim();
    envVars.push(`${matches[i].key}=${val}`);
  }
  return envVars.join('\0');
}

function escapeAppleScriptString(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getProcessEnviron(pid) {
  if (!pid) return '';
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-p', pid, '-E'], { encoding: 'utf8', timeout: 1000 });
      const lines = output.split('\n');
      if (lines.length < 2) return '';
      const content = lines.slice(1).join(' ');
      return parseMacOSEnviron(content);
    } catch {
      return '';
    }
  } else {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      return '';
    }
  }
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

// ---- aliases (apelido manual por SESSÃO) ----
// Chave = identidade da sessão (session_id, fallback pid) — a MESMA linha do
// overlay, calculada em renderer.aliasKey. Antes era o cwd, o que fazia dois
// terminais no mesmo diretório compartilharem o apelido (renomear um renomeava
// todos). O main só persiste a chave opaca que o renderer manda.
function loadAliases() {
  try { return JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveAlias(key, alias) {
  const a = loadAliases();
  if (alias && alias.trim()) a[key] = alias.trim();
  else delete a[key];
  try { fs.writeFileSync(ALIASES_FILE, JSON.stringify(a)); } catch {}
}

// ---- idioma (i18n) ----
// Prioridade: escolha manual nas Preferências (settings.lang ≠ 'auto') >
// locale do sistema (app.getLocale, só vale após o ready). Distribuído aos
// renderers via IPC get-lang; default en até o ready — nada visível antes.
let LANG = 'en';
let T = i18n.makeT(LANG);
function applyLang() {
  const pref = settingsCfg && settingsCfg.lang;
  LANG = (pref === 'en' || pref === 'pt') ? pref : i18n.pickLang(app.getLocale());
  T = i18n.makeT(LANG);
}

// ---- settings (threshold de idle + atalho global) ----
let settingsCfg = settingsLib.mergeWithDefaults(null);   // sempre válido
function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return settingsLib.mergeWithDefaults(raw);
}
function persistSettings(cfg) {
  // Merge sobre o estado ATUAL, não sobre os defaults: as Preferências mandam
  // um cfg PARCIAL (só os campos delas). Sem espalhar settingsCfg antes, cada
  // save resetaria showUsage/collapsed/launchers pro default — apaga launcher
  // custom e pisca o rodapé. Crucial pro live-apply (grava a cada mudança) e
  // conserta o wipe latente que o "Salvar" batch já tinha.
  settingsCfg = settingsLib.mergeWithDefaults({ ...settingsCfg, ...cfg });
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCfg, null, 2)); } catch {}
  return settingsCfg;
}

// Registra o atalho configurado de mostrar/ocultar. Idempotente: limpa os
// anteriores antes. Mantém o legado CommandOrControl+Shift+Alt+L como rede
// de segurança (se o usuário muda o primário e esquece, ainda há um caminho).
function applyShortcut() {
  try { globalShortcut.unregisterAll(); } catch {}
  for (const acc of [settingsCfg.shortcut, 'CommandOrControl+Shift+Alt+L']) {
    if (acc && settingsLib.isValidShortcut(acc)) {
      try { globalShortcut.register(acc, toggleWin); } catch {}
    }
  }
}

// ---- Quick Launcher: detecta CLIs instalados e sobe um agente num terminal ----
// Detecção por PATH scan (fork-free: só fs.access nos dirs do PATH). O Electron
// roda fora do shell interativo, então não vê aliases — acha o binário real.
// CLIs só-alias (sem bin no PATH) entram via override settings.launchers[id].
function scanPathBin(bin) {
  const path = process.env.PATH || '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = path_join(dir, bin);
    try { if (fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true)) return p; } catch {}
  }
  return null;
}
function path_join(dir, bin) { // path.join local (sem sobrescrever o require)
  return dir.replace(/\/+$/, '') + '/' + bin;
}

// Quais agentes têm CLI disponível? Override do settings tem precedência sobre PATH.
let _launchers = null, _launchersAt = 0;
function detectLaunchers() {
  if (_launchers && Date.now() - _launchersAt < 10000) return _launchers; // cache 10s
  const out = [];
  for (const [id, a] of Object.entries(AGENTS)) {
    if (!a.bin) continue;
    const override = settingsCfg.launchers && settingsCfg.launchers[id];
    const path = (typeof override === 'string' && override) ? override : scanPathBin(a.bin);
    if (path) out.push({ id, path, overridden: !!override });
  }
  _launchers = out;
  _launchersAt = Date.now();
  return out;
}

// Quais terminais suportados estão no PATH? (pra 'auto' e pra validar o seletor)
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

// Cwd mais recente entre as sessões (pra onde o "+ agente" abre por padrão).
function lastSessionCwd() {
  let best = null, bestTs = 0;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
        if (s && s.cwd && (s.last_event_ts || 0) >= bestTs) { bestTs = s.last_event_ts || 0; best = s.cwd; }
      } catch {}
    }
  } catch {}
  return best;
}

// Sobe o agente num terminal no cwd dado. Detached + unref: o overlay não é pai
// do processo — a sessão entra no semáforo pelo caminho normal (hooks → state).
function launchAgent({ agent, cwd }) {
  const a = AGENTS[agent];
  if (!a) return;
  const entry = detectLaunchers().find((l) => l.id === agent);
  if (!entry) { notifyUser(T('ntf_no_launcher', { agent: a.label })); return; }
  const dir = (cwd && typeof cwd === 'string') ? cwd : (lastSessionCwd() || process.env.HOME || '/');

  if (process.platform === 'darwin') {
    const term = settingsCfg.terminal === 'auto' ? (availableTerminals()[0] || 'terminal') : settingsCfg.terminal;
    
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

// ---- attach remoto (tmux): abre um terminal LOCAL attachado a uma sessão tmux
// (local direto, ou remota via SSH/Tailscale). Vivo e compartilhado (multi-
// cliente): sem --resume, sem derrubar o terminal da outra máquina. Sanitiza
// nome+host (vêm de config/peer — anti-injeção de shell no comando remoto).
// Warp: launch-config YAML + warp://launch. O scheme warp:// costuma estar
// registrado (dev.warp.Warp.desktop) MESMO quando o binário `warp` não está no
// PATH — então xdg-open abre o app e roda o comando do config.
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
  if (settingsCfg.terminal === 'warp') { if (openInWarp(cmdArray, dir)) return; }   // pref Warp
  const avail = availableTerminals();
  const term = launcher.pickTerminal(settingsCfg.terminal, avail);
  const useTerm = term || (avail.includes('gnome-terminal') ? 'gnome-terminal' : 'x-terminal-emulator');
  const args = launcher.terminalArgs(useTerm, dir, cmdArray) || ['-e', ...cmdArray];
  try { spawn(useTerm, args, { detached: true, stdio: 'ignore', cwd: dir }).unref(); }
  catch (e) { notifyUser('Attach failed: ' + e.message); }
}
function attachRemote({ origin, tmux_session, cwd, alias, key }) {
  if (!tmux_session) { notifyUser(T('ntf_attach_no_tmux')); return; }
  const isLocal = !origin || origin === 'local';
  const dupKey = (isLocal ? 'local' : origin) + '|' + tmux_session;
  for (const [id, s] of termSessions) {   // dedupe: aba dessa sessão já existe → só foca
    if (((s.kind === 'local' ? 'local' : s.origin) + '|' + s.tmux_session) === dupKey) {
      ensureTermWin(); sendTerm('term-tab-activated', { tabId: id }); return;
    }
  }
  ensureTermWin();
  const title = alias || ((isLocal ? '' : origin + ' · ') + 'tmux: ' + tmux_session);
  const tabId = addTermSession({ title, kind: isLocal ? 'local' : 'remote', origin: isLocal ? null : origin, tmux_session, sessionKey: key });
  if (isLocal) {
    spawnPtyLocal(tabId, ['tmux', 'attach', '-t', tmux_session], cwd);
  } else {
    const host = originToHost.get(origin) || '';
    const s = (settingsCfg && settingsCfg.sync) || {};
    if (!host || !s.token) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem host/token para ' + origin + '\x1b[0m\r\n' }); return; }
    openRemotePty(tabId, { host, port: s.port, token: s.token, tmux_session });
  }
}

// ---- autostart ----
function autostartEnabled() {
  try { return fs.existsSync(AUTOSTART_FILE); } catch { return false; }
}
function setAutostart(on) {
  try {
    try { fs.unlinkSync(OLD_AUTOSTART); } catch {} // limpa o .desktop da era pré-rename
    if (on) {
      // Escapa cada path pelo spec .desktop (backslash em espaço/$/`/"). Sem
      // isso, um HOME com espaço quebra o Exec no login.
      const exec = desktopEscape(process.execPath);
      const appDir = desktopEscape(__dirname);
      const desktop = `[Desktop Entry]\nType=Application\nName=AI Traffic Lights\nExec=${exec} ${appDir} --no-sandbox\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, desktop);
    } else {
      try { fs.unlinkSync(AUTOSTART_FILE); } catch {}
    }
  } catch {}
}

// Envio seguro pro renderer. A janela pode existir mas o RENDER FRAME já ter
// sido descartado (crash do renderer, reload, devtools) — aí webContents.send
// lança "Render frame was disposed before WebFrameMain could be accessed" a
// CADA tick dos timers (5s/60s), spammando o stderr sem parar. Este guard checa
// webContents vivo/não-crashed e engole qualquer erro residual de corrida.
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return false;
  try { wc.send(channel, payload); return true; }
  catch { return false; }
}

function sendSessions() {
  sendToRenderer('sessions', readSessions());
}

// Limpeza: remove state files cujo PID morreu (sem SessionEnd — ex.: crash/kill
// do terminal). process.kill(pid,0) só testa existência (não afetado por ptrace).
// Também varre .tmp órfãos (escrita atômica abortada) com mais de 60s.
function reapDead() {
  let changed = false;
  try {
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.tmp'))) {
      try {
        const p = path.join(STATE_DIR, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 60_000) fs.unlinkSync(p);
      } catch {}
    }
    for (const f of fs.readdirSync(STATE_DIR).filter((x) => x.endsWith('.json'))) {
      const p = path.join(STATE_DIR, f);
      let s = null;
      try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      if (!s) {
        // vazio/corrompido (race de escrita): não tem pid pro reap normal.
        // Sessão viva regrava o arquivo no próximo evento (hook usa try/fromjson);
        // se está parado há >10min, é lixo de sessão morta — remove.
        try { if (Date.now() - fs.statSync(p).mtimeMs > 600_000) { fs.unlinkSync(p); changed = true; } } catch {}
        continue;
      }
      if (!s.pid) continue;
      try { process.kill(s.pid, 0); }         // vivo? (não lança)
      catch { try { fs.unlinkSync(p); changed = true; } catch {} }
    }
  } catch {}
  if (changed) sendSessions();
}

// ---- persistência de bounds (só width + posição; altura é auto) ----
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch { return null; }
}
let saveTimer = null;
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const [x, y] = win.getPosition();
      const [width] = win.getSize();
      fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ x, y, width }));
    } catch { /* ignore */ }
  }, 300);
}

// Aplica _NET_WM_STATE_SKIP_TASKBAR + SKIP_PAGER via wmctrl no X11 id da
// janela. No Wayland wmctrl é inócuo (silencioso). Idempotente.
function applySkip() {
  if (!win || win.isDestroyed() || IS_WAYLAND || process.platform === 'darwin') return;
  try {
    const buf = win.getNativeWindowHandle(); // X11: XID little-endian
    const xid = '0x' + buf.readUInt32LE(0).toString(16).padStart(8, '0');
    execFileSync('wmctrl', ['-i', '-r', xid, '-b', 'add,skip_taskbar,skip_pager'], { timeout: 1500 });
  } catch {}
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const scrW = display.workAreaSize.width;
  const bounds = loadBounds();
  const width = (bounds && bounds.width) || DEFAULT_W;
  let x = (bounds && typeof bounds.x === 'number') ? bounds.x : scrW - DEFAULT_W - 12;
  let y = (bounds && typeof bounds.y === 'number') ? bounds.y : 12;
  // Clamp: se a posição salva caiu fora das telas ativas (ex.: monitor externo
  // foi desconectado e o layout encolheu), traz de volta ao canto do primário.
  // Sem isto o WM pode relocar a janela pra um lugar inesperado ou ela some.
  const onScreen = screen.getAllDisplays().some((d) =>
    x >= d.bounds.x && x + width <= d.bounds.x + d.bounds.width &&
    y >= d.bounds.y && y + 40 <= d.bounds.y + d.bounds.height);
  if (!onScreen) {
    x = display.workArea.x + display.workAreaSize.width - width - 12;
    y = display.workArea.y + 12;
  }

  win = new BrowserWindow({
    width, height: HEADER_H + 120, // placeholder; renderer corrige via auto-height
    x, y,
    // Clamp no nível do WM: o gripper já limitava, mas o resize pela BORDA da
    // janela (resizable) ignorava MIN_W e deixava o header quebrar.
    minWidth: MIN_W, minHeight: HEADER_H,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,       // fora da barra de tarefas e do alt-tab (SKIP_TASKBAR/PAGER)
    maximizable: false,      // (não implementado no Linux; vale nas demais plataformas)
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Linux/Mutter ignora `maximizable` → reverte na hora qualquer maximize
  // (Super+↑, drag no topo da tela, tiling). Overlay nunca vira tela cheia.
  win.on('maximize', () => { try { win.unmaximize(); } catch {} });
  // Mutter/XWayland: o estado _NET_WM_STATE_ABOVE oscila ao perder foco (ver
  // CHANGELOG 0.6.7) — clicar em outra janela/no desktop derruba o always-on-top
  // sem passar por toggleWin/revealIfHidden. Reafirma no blur, do mesmo jeito
  // que já se faz no toggle/reveal (setAlwaysOnTop + moveTop).
  win.on('blur', () => {
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { win.moveTop(); } catch {}
  });
  // skipTaskbar FORÇADO via wmctrl: no Mutter, com frameless+transparent+
  // alwaysOnTop, nem a option `skipTaskbar` nem setSkipTaskbar() geram o
  // hint X11 _NET_WM_STATE_SKIP_TASKBAR/PAGER de forma confiável (ele é
  // rebuildado e descartado a cada chamada de always-on-top). O `type:
  // 'toolbar'` fazia o hint na marra — mas removia _NET_WM_ACTION_MOVE,
  // travando a janela. wmctrl aplica o skip SEM tocar nas allowed actions.
  // O IS_LINUX/X11 guarda isso: no Wayland nativo wmctrl é inócuo.
  win.once('ready-to-show', () => { try { win.setSkipTaskbar(true); } catch {} applySkip(); });
  win.loadFile(path.join(__dirname, 'src/index.html'));
  win.webContents.on('did-finish-load', sendSessions);
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Log do renderer só com ATL_DEBUG=1 (debug off em produção).
  if (process.env.ATL_DEBUG) {
    win.webContents.on('console-message', (_e, level, message) =>
      fs.appendFileSync('/tmp/atl-renderer.log', `[${level}] ${message}\n`));
  }
}

// Mostrar/ocultar centralizado. No show, re-afirma skipTaskbar — alguns WMs
// resetam o hint no ciclo hide/show (bug conhecido de Electron/X11).
function toggleWin() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else {
    win.show(); try { win.setSkipTaskbar(true); } catch {} try { win.moveTop(); } catch {}
    // Revelou o overlay (tray/atalho) → o usuário vai olhar; busca o % do Claude
    // agora (lazy). Cache de 5 min evita repetir a cada mostra/esconde.
    collectAndSendUsage({ claudeFetch: true });
  }
}

// Traz o overlay de volta à tela se ele estiver OCULTO (hide). Não rouba o foco
// do teclado — só reaplica show() + skipTaskbar (continua alwaysOnTop, fora da
// barra de tarefas). Usado pela feature "revelar quando oculto" (config em
// Notificações): dispara quando um agente fica vermelho, a cota reseta ou há
// update — cada um só se a opção correspondente estiver marcada.
function revealIfHidden() {
  try {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      try { win.setSkipTaskbar(true); } catch {}
      try { win.moveTop(); } catch {}
    }
  } catch { /* nunca derruba o fluxo que disparou o reveal */ }
}

// ---- tray (bandeja) ----
// Cópia estável do hook + registro no settings.json — caminho único que
// funciona do fonte E empacotado (AppImage monta em path efêmero).
function installHookFromApp() {
  try {
    const dest = hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR);
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      if (!hookInstaller.available(id)) continue;      // agente não presente na máquina
      const r = hookInstaller.install(id, dest);
      parts.push(`${t.label}: ${r.wrote ? T('ntf_installed', { a: r.added, u: r.updated }) : T('ntf_ok')}`);
    }
    if (hookInstaller.opencodeAvailable()) {
      hookInstaller.installOpencode(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
      parts.push('OpenCode: ' + T('ntf_plugin_ok'));
    }
    notifyUser(parts.length ? parts.join(' · ') : T('ntf_none_found'));
  } catch (e) { notifyUser(T('ntf_install_fail', { msg: e.message })); }
}
function removeHookFromApp() {
  try {
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      const r = hookInstaller.remove(id);
      if (r.removed) parts.push(`${t.label}: ${T('ntf_removed', { n: r.removed })}`);
    }
    if (hookInstaller.removeOpencode().removed) parts.push('OpenCode: ' + T('ntf_plugin_removed'));
    notifyUser(parts.length ? parts.join(' · ') : T('ntf_nothing_installed'));
  } catch (e) { notifyUser(T('ntf_remove_fail', { msg: e.message })); }
}
function notifyUser(body) {
  try { new Notification({ title: 'AI Traffic Lights', body, silent: true }).show(); } catch {}
}

let tray = null;
// Menu reconstruível fora do createTray: os labels dependem do idioma, e a
// troca nas Preferências re-renderiza o menu ao vivo (save-settings).
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: T('tray_show_hide'), accelerator: 'Ctrl+Alt+H', click: toggleWin },
    { type: 'checkbox', label: T('tray_autostart'), checked: autostartEnabled(),
      click: (it) => { setAutostart(it.checked); } },
    // Quick Launcher: submenu com cada CLI detectado (abre o terminal e sobe).
    ...(detectLaunchers().length ? [{
      label: T('launch_section'),
      submenu: detectLaunchers().map((l) => ({
        label: '+ ' + AGENTS[l.id].label,
        click: () => launchAgent({ agent: l.id }),
      })),
    }] : []),
    { type: 'separator' },
    { label: T('tray_install_hooks'), click: installHookFromApp },
    { label: T('tray_remove_hooks'), click: removeHookFromApp },
    { type: 'separator' },
    { label: T('tray_preferences'), click: createSettingsWindow },
    { label: T('tray_check_updates'), click: checkUpdatesManual },
    { label: T('tray_quit'), click: () => app.quit() },
  ]);
}
// ---- tray dinâmico: ícone pinta com a pior cor + tooltip com a contagem ----
// Variante por nível (bolinha colorida no canto do ícone-base). Sem sessões,
// cai no ícone neutro (não dá "tudo verde" com nada rodando).
const TRAY_ICON_FILE = {
  awaiting: 'tray-icon-r.png',
  processing: 'tray-icon-y.png',
  done: 'tray-icon-g.png',
};
const trayIcons = {};
for (const [lvl, file] of Object.entries(TRAY_ICON_FILE)) {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  trayIcons[lvl] = img.isEmpty() ? null : img;
}
const trayIconBase = nativeImage.createFromPath(path.join(__dirname, 'assets/tray-icon.png'));
function setTrayLevel({ level, awaiting = 0, processing = 0, done = 0 }) {
  if (!tray || tray.isDestroyed()) return;
  const total = awaiting + processing + done;
  const img = total > 0 ? trayIcons[level] : null;
  tray.setImage(img || trayIconBase);
  const parts = [];
  if (awaiting) parts.push(`🔴${awaiting}`);
  if (processing) parts.push(`🟡${processing}`);
  if (done) parts.push(`🟢${done}`);
  tray.setToolTip(total > 0 ? `AI Traffic Lights v${APP_VERSION}  ${parts.join(' ')}` : `AI Traffic Lights v${APP_VERSION}`);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/tray-icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(`AI Traffic Lights v${APP_VERSION}`);
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWin);
}

// ---- janela de Preferências (threshold de idle + atalho) ----
let settingsWin = null;
let settingsBoundsTimer = null;
function loadSettingsBounds() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_BOUNDS_FILE, 'utf8')); } catch { return null; }
}
function saveSettingsBounds() {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  clearTimeout(settingsBoundsTimer);
  settingsBoundsTimer = setTimeout(() => {
    try {
      const [x, y] = settingsWin.getPosition();
      // Só a posição: o tamanho é fixo (SETTINGS_W/H) e ignorado no load —
      // gravá-lo só persistiria dados mortos e confundiria versões futuras.
      fs.writeFileSync(SETTINGS_BOUNDS_FILE, JSON.stringify({ x, y }));
    } catch {}
  }, 300);
}
// Tamanho FIXO da janela de Preferências (não redimensionável): travado na
// altura da aba mais alta (Geral), medido no conteúdo real a 420px de largura.
// As abas mais curtas (Integração) ficam com espaço vazio; nenhuma rola.
// useContentSize faz width/height valerem para a ÁREA WEB (o .prefs preenche).
// 770px acomoda a maior aba (Notificações: 3 seções ≈ 555px de conteúdo) com
// folga — header(abas)+rodapé consomem ~170px. As abas curtas (Integração) ficam
// com espaço vazio; nenhuma rola. Em telas baixas (768px) o winH clampa à work
// area e a aba rola (header/rodapé ficam fixos).
const SETTINGS_W = 420, SETTINGS_H = 770;
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  const b = loadSettingsBounds() || {};
  // Clampa à altura da área útil do display: em telas baixas (ex.: 1366×768,
  // work area ~728px) a altura ideal (761) não cabe e, com resizable:false, o
  // rodapé/Fechar + o fim da aba Geral ficariam abaixo da tela, inalcançáveis.
  // O .tab-body (overflow-y:auto) rola; header/abas/.actions (flex:0 0 auto)
  // ficam fixos — o "Fechar" nunca some. Display mais próximo da posição salva
  // cobre multi-monitor; sem posição, cai no primário.
  const disp = (typeof b.x === 'number' && typeof b.y === 'number')
    ? screen.getDisplayNearestPoint({ x: b.x, y: b.y })
    : screen.getPrimaryDisplay();
  const winH = Math.min(SETTINGS_H, disp.workAreaSize.height - 24); // 24 = respiro
  settingsWin = new BrowserWindow({
    width: SETTINGS_W, height: winH,
    useContentSize: true,               // width/height = área web (o .prefs preenche)
    resizable: false,                   // tamanho travado na maior aba (pedido do usuário)
    maximizable: false, fullscreenable: false,
    x: typeof b.x === 'number' ? b.x : undefined,   // posição é lembrada; tamanho não
    y: typeof b.y === 'number' ? b.y : undefined,
    title: T('prefs_title'),
    icon: path.join(__dirname, 'build/icon.png'),
    // Mesmo chrome custom do overlay (ver createWindow acima): sem moldura
    // nativa + fundo transparente — o .prefs (settings.css) desenha o painel
    // arredondado com borda e sombra, e o header .bar é arrastável.
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // O overlay é always-on-top nível 'screen-saver' — sem elevar as Preferências
  // ao MESMO nível, elas abrem ATRÁS dele quando as janelas se sobrepõem.
  // Mesmo nível + criada depois = fica na frente.
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.loadFile(path.join(__dirname, 'src/settings.html'));
  settingsWin.on('move', saveSettingsBounds);          // só posição (tamanho é fixo)
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---- IPC ----
ipcMain.on('request-sessions', sendSessions);

ipcMain.on('set-expanded', (_e, { expanded, h } = {}) => {
  if (!win || win.isDestroyed()) return;
  // expandido = altura auto (renderer pede via auto-height); recolhido = só
  // header, ou header + rodapé quando houver launchers (h vem do renderer).
  if (!expanded) {
    const [w] = win.getSize();
    const height = Math.round(h) || HEADER_H;
    // mínimo ANTES do setSize: senão o WM recusa encolher abaixo do mínimo
    // que o autosize deixou no estado expandido (janela não reduzia ao recolher).
    win.setMinimumSize(MIN_W, height);
    win.setSize(w, height, false);
  } else {
    // Expandiu: o usuário quer VER o uso → busca o % do Claude agora (lazy). O
    // cache de 5 min evita spam de abrir/fechar; fora daqui o loop não bate.
    collectAndSendUsage({ claudeFetch: true });
  }
});

// Altura automática pelo conteúdo (n linhas). Largura e posição preservadas.
// O MÍNIMO da janela acompanha o conteúdo: não dá pra arrastar pra menos e
// cortar sessões — o overlay sempre cabe tudo (até o teto MAX_H, onde rola).
ipcMain.on('auto-height', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const clamped = Math.max(MIN_H, Math.min(Math.round(h), MAX_H));
  const [w] = win.getSize();
  // mínimo ANTES do setSize: ao encolher, o WM respeita o mínimo anterior e
  // rejeitaria o setSize abaixo dele (janela não reduzia).
  win.setMinimumSize(MIN_W, clamped);
  win.setSize(w, clamped, false);
});

// Gripper: só largura (altura é auto). Persiste ao soltar.
let resizeStart = null;
ipcMain.on('resize-start', () => {
  if (!win || win.isDestroyed()) return;
  resizeStart = win.getSize();
});
ipcMain.on('resize-move', (_e, { dw }) => {
  if (!win || win.isDestroyed() || !resizeStart) return;
  const w = Math.max(MIN_W, Math.min(resizeStart[0] + dw, MAX_W));
  win.setSize(Math.round(w), resizeStart[1], false);
});

ipcMain.on('quit', () => app.quit());

// Click-to-focus: ativa o terminal da sessão ({pid, windowid}).
ipcMain.on('focus', (_e, target) => focusSession(target));

// Aliases (apelido por sessão — chave = session_id|pid, ver renderer.aliasKey).
ipcMain.handle('get-aliases', () => loadAliases());
ipcMain.on('set-alias', (_e, { key, alias }) => {
  // valida no limite IPC: key é a identidade da sessão (session_id ou pid),
  // alias é string curta. Ignora payload malformado em vez de gravar lixo.
  if (typeof key !== 'string' || !key || key.length > 512) return;
  if (alias != null && (typeof alias !== 'string' || alias.length > 256)) return;
  saveAlias(key, alias);
  sendSessions();
  // atualiza o título da aba correspondente na janela Terminal (alias é o nome da aba)
  for (const [id, s] of termSessions) {
    if (s.sessionKey === key) {
      const t = alias || ((s.kind === 'local' ? '' : (s.origin || '') + ' · ') + 'tmux: ' + (s.tmux_session || 'shell'));
      s.title = t; sendTerm('term-tab-title', { tabId: id, title: t });
    }
  }
});

// Settings: leitura (Preferências), gravação (aplica atalho + avisa overlay),
// e abertura da janela a partir do renderer (caso queira botão no overlay um dia).
ipcMain.handle('get-settings', () => settingsCfg);
ipcMain.handle('get-lang', () => LANG);
ipcMain.handle('get-version', () => APP_VERSION);              // rodapé das Preferências
// Abre URL externa no navegador padrão. Só aceita http(s) — o renderer passa
// só o link do repo, mas o guarda evita que qualquer string vire comando/protocolo.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    try { shell.openExternal(url); } catch {}
  }
});
ipcMain.handle('get-repo-url', () => REPO_URL);
ipcMain.on('save-settings', (_e, cfg) => {
  // No live-apply isto dispara a CADA mudança nas Preferências. Só refaz o
  // trabalho caro quando o valor relevante mudou de fato (evita re-registrar o
  // globalShortcut e reconstruir o tray a cada tick de arraste do slider).
  const prevShortcut = settingsCfg.shortcut, prevLang = settingsCfg.lang;
  settingsCfg = persistSettings(cfg);
  applySync();                                                 // re-avalia servidor/poller (sync)
  if (settingsCfg.shortcut !== prevShortcut) applyShortcut();   // re-registra só se o atalho mudou
  if (settingsCfg.lang !== prevLang) {                          // idioma só se mudou
    applyLang();
    if (tray) tray.setContextMenu(buildTrayMenu());             // labels do tray no idioma novo
  }
  sendToRenderer('settings-changed', settingsCfg);
});
ipcMain.on('open-settings', () => createSettingsWindow());

// Sync multi-máquina: lê/gravar SÓ o sub-objeto sync (validado em persistSettings).
ipcMain.handle('get-sync', () => (settingsCfg && settingsCfg.sync) || null);
ipcMain.on('set-sync', (_e, syncCfg) => {
  settingsCfg = persistSettings({ sync: syncCfg });
  applySync();
  sendToRenderer('settings-changed', settingsCfg);
});
// Ver prompt de uma sessão: local lê direto do disco; remoto busca /transcript no peer.
ipcMain.handle('fetch-transcript', async (_e, { origin, key, n }) => {
  const N = Math.max(1, Math.min(50, parseInt(n || 20, 10)));
  if (!origin || origin === 'local') {
    try { const tp = collect.findTranscript(key); return tp ? transcript.lastMessages(tp, N) : []; }
    catch { return []; }
  }
  const s = (settingsCfg && settingsCfg.sync) || {};
  const host = originToHost.get(origin);
  if (!host) return [];
  return net.fetchTranscriptFromPeer({ host, port: s.port, token: s.token, key, n: N });
});

// Preferências espelha o tray: autostart + hooks. Mostrar/ocultar e sair
// reusam os canais 'toggle-visibility' e 'quit' já registrados.
ipcMain.handle('get-autostart', () => autostartEnabled());
ipcMain.on('set-autostart', (_e, on) => setAutostart(!!on));
ipcMain.on('install-hooks', () => installHookFromApp());
ipcMain.on('remove-hooks', () => removeHookFromApp());

// Notificação no vermelho.
ipcMain.on('notify', (_e, { title, body }) => {
  try { new Notification({ title, body, silent: true }).show(); } catch {}
});

// ---- som de alerta customizado ----
// Escolher um arquivo de áudio: abre o diálogo nativo e COPIA o arquivo pra
// BASE_DIR/sounds/alert.<ext> (sobrevive a mover/apagar o original). Devolve o
// caminho da cópia (o que fica salvo em settings.soundFile) ou null se cancelou.
ipcMain.handle('pick-sound-file', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: 'Escolher som de alerta',
      properties: ['openFile'],
      filters: [{ name: 'Áudio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const dir = path.join(BASE_DIR, 'sounds');
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(src).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.snd'])[0];
    const dest = path.join(dir, 'alert' + ext);
    // limpa cópias antigas (alert.*) pra não acumular formatos
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (/^alert\./.test(f) && p !== dest) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    fs.copyFileSync(src, dest);
    return dest;
  } catch { return null; }
});
// Ler os bytes do som custom pro renderer decodificar (Web Audio). TRAVA DE
// SEGURANÇA: só lê de dentro de BASE_DIR/sounds (nunca um caminho arbitrário),
// pra que uma config podre não vire leitura de arquivo qualquer do disco.
ipcMain.handle('get-sound-bytes', (_e, file) => {
  try {
    if (typeof file !== 'string') return null;
    const soundsDir = path.join(BASE_DIR, 'sounds');
    const resolved = path.resolve(file);
    if (resolved !== soundsDir && !resolved.startsWith(soundsDir + path.sep)) return null;
    return new Uint8Array(fs.readFileSync(resolved));
  } catch { return null; }
});

// Tray: mostrar/ocultar, autostart, sair.
ipcMain.on('toggle-visibility', toggleWin);
// Overlay pede pra voltar à frente (renderer detectou transição p/ vermelho).
ipcMain.on('reveal-overlay', () => { if (settingsCfg.revealOnRed) revealIfHidden(); });

// Tray dinâmico: renderer manda a pior cor + contagem a cada render.
ipcMain.on('set-tray-level', (_e, info) => setTrayLevel(info || {}));

// Quick Launcher: lista de agentes detectados + sobe um agente num terminal.
ipcMain.handle('get-launchers', () => detectLaunchers().map((l) => ({ id: l.id, label: AGENTS[l.id].label })));
ipcMain.on('launch-agent', (_e, target) => launchAgent(target || {}));
ipcMain.on('attach-remote', (_e, t) => attachRemote(t || {}));   // attach tmux (local ou via peer)

// ---- sync multi-máquina (P2P): servidor + poller, OPT-IN (fase 2) ----
// Sessões remotas dos peers são mergeadas em readSessions(); chegam com `origin`
// = nome do peer → sessionKey (namespaced) separa das locais. Idempotente: só
// derruba/sobe o lado que mudou de desejo/config. Sem efeito com sync desligado
// (superfície zero). Token vazio => nada sobe (fail-safe).
let remoteSessions = new Map();   // peerHost -> sessions[] (já com origin)
let originToHost = new Map();     // peerNodeName -> peerHost (p/ fetch-transcript remoto)
const livePeers = new Set();      // hosts que responderam /sessions (ATL ligado) — o menu + só mostra vivos
let syncServer = null, syncServerKey = null;
let stopPoll = null, pollKey = null;
let onlineSet = null, onlineTimer = null;   // peers online per Tailscale (gate do poller)
function syncNodeName() { return (settingsCfg.sync && settingsCfg.sync.node) || os.hostname() || 'local'; }
function applySync() {
  const s = (settingsCfg && settingsCfg.sync) || {};
  const tok = typeof s.token === 'string' ? s.token : '';
  // SERVIDOR (compartilhar minhas sessões): binda no IP da tailnet
  // (detectTailnetIP) — peers alcançam direto em http://<ip>:<porta>; auth por
  // token + WireGuard E2E (sem tailscale serve). Reinicia só se a config mudou.
  const srvKey = (s.enabled && s.share && tok) ? `${s.port}|${tok}|${s.shareTranscripts ? 1 : 0}|${s.allowAttach ? 1 : 0}|${syncNodeName()}` : '';
  if (!srvKey && syncServer) { try { syncServer.close(); } catch {} syncServer = null; syncServerKey = null; }
  if (srvKey && srvKey !== syncServerKey) {
    if (syncServer) { try { syncServer.close(); } catch {} }
    const bindHost = process.env.ATL_SYNC_BIND || net.detectTailnetIP();
    try {
      syncServer = net.startServer({
        port: s.port, token: tok, nodeName: syncNodeName(), shareTranscripts: !!s.shareTranscripts, allowAttach: !!s.allowAttach, ptySpawn: createPty, bindHost,
        getSessions: () => collect.readSessions(),
        getTranscript: (key, n) => {
          try { const tp = collect.findTranscript(key); return tp ? transcript.lastMessages(tp, n) : []; }
          catch { return []; }
        },
      });
      syncServerKey = srvKey;
      try { console.log('[sync] server up ' + (bindHost || '127.0.0.1') + ':' + s.port + ' (' + syncNodeName() + (bindHost ? '' : ' — localhost só, sem tailscale?') + ')'); } catch {}
    } catch (e) { try { console.log('[sync] server falhou: ' + e.message); } catch {} syncServer = null; syncServerKey = null; }
  }
  // CLIENTE (observar peers): poll de /sessions a cada 5s.
  const pKey = (s.enabled && Array.isArray(s.peers) && s.peers.length && tok) ? `${s.port}|${tok}|${s.peers.map((p) => p.host).join(',')}` : '';
  if (!pKey && stopPoll) { stopPoll(); stopPoll = null; pollKey = null; clearInterval(onlineTimer); onlineTimer = null; remoteSessions.clear(); livePeers.clear(); sendSessions(); }
  if (pKey && pKey !== pollKey) {
    if (stopPoll) { stopPoll(); }
    // Gate Tailscale: só tenta rede em peers que o Tailscale diz online. Set
    // refresh a cada 10s (barato, local); null => sem tailscale => sem gate (cai p/ backoff).
    onlineSet = net.tailscaleOnlineSet();
    clearInterval(onlineTimer);
    onlineTimer = setInterval(() => { onlineSet = net.tailscaleOnlineSet(); }, 10000);
    stopPoll = net.pollPeers({
      peers: s.peers, port: s.port, token: tok,
      isOnline: (h) => { if (!onlineSet) return true; const lc = String(h).toLowerCase(); return onlineSet.has(h) || onlineSet.has(lc); },
      onSessions: (host, sessions) => {
        remoteSessions.set(host, sessions);
        livePeers.add(host);   // ATL ligado no peer → habilita no menu + da termWin
        for (const s of sessions) if (s && s.origin) originToHost.set(s.origin, host); // p/ fetch-transcript remoto
        sendSessions();
      },
      onPeerState: (host, online) => { try { console.log('[sync] peer ' + host + ' ' + (online ? 'online' : 'offline (backoff)')); } catch {} if (online) livePeers.add(host); else livePeers.delete(host); },
    });
    pollKey = pKey;
  }
}

// ---- Janela Terminal (abas) — separada do overlay, maximizável ----
// O overlay NÃO hospeda mais o terminal: o estado dos pty/ws vive aqui (Map
// termSessions) e o renderer (src/term.html) só desenha abas + xterm, falando
// por IPC (tabId). Assim o overlay fica leve (não cresce, não bloqueia cliques).
let ptyLib = null;
// PATH garantido pro pty: electron/Chromium no Linux pode herdar PATH restrito
// (sem /usr/bin) → tmux/bash não achados → o auto-wrap em tmux falhava silenciosamente.
// Acrescenta os dirs base no fim (não sobrescreve o que já tá lá).
function ptyEnv() {
  const env = Object.assign({}, process.env);
  const cur = String(env.PATH || '').split(':').filter(Boolean);
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) if (!cur.includes(d)) cur.push(d);
  env.PATH = cur.join(':');
  return env;
}
// true se o bin existe no PATH do main OU nos dirs base (fallback robusto ao scanPathBin).
function hasBin(bin) {
  if (scanPathBin(bin)) return true;
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) { try { if (fs.existsSync(d + '/' + bin)) return true; } catch {} }
  return false;
}
function ptyEnsure() { if (!ptyLib) { try { ptyLib = require('node-pty'); } catch (e) { try { console.log('[pty] node-pty indisponível: ' + e.message); } catch {} } } return ptyLib; }
// factory p/ o SERVIDOR /pty (DI em net.startServer): 1 node-pty por conexão
// remota (peer attachando em MIM). Devolve handle {write,resize,kill}.
function createPty(cmd, cols, rows, { onData, onExit }) {
  const p = ptyEnsure(); if (!p) throw new Error('node-pty indisponível');
  const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: process.env.HOME, env: ptyEnv() });
  proc.onData(onData); proc.onExit(onExit);
  return { write: (d) => { try { proc.write(d); } catch {} }, resize: (c, r) => { try { proc.resize(c, r); } catch {} }, kill: () => { try { proc.kill(); } catch {} } };
}

let termWin = null;
const termSessions = new Map();   // tabId -> { title, kind, origin, tmux_session, proc, ws, cols, rows }
let tabSeq = 0;
let termWinReady = false;         // term.html carregou? Fila de IPCs até did-finish-load — evita perder term-tab-added/pty-out na 1ª abertura (janela vinha vazia).
const termQueue = [];
function sendTerm(ch, payload) {
  if (!termWin || termWin.isDestroyed()) return;
  if (!termWinReady) { termQueue.push([ch, payload]); return; }
  try { termWin.webContents.send(ch, payload); } catch {}
}
let termBoundsTimer = null;
function loadTermBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(TERM_BOUNDS_FILE, 'utf8'));
    if (b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number')) return b;
  } catch {}
  return null;
}
function saveTermBounds() {
  if (!termWin || termWin.isDestroyed() || termWin.isMaximized()) return;   // não persiste maximizada (senão reabre do tamanho da tela sem estar max)
  clearTimeout(termBoundsTimer);
  termBoundsTimer = setTimeout(() => {
    try {
      const b = termWin.getBounds();
      fs.writeFileSync(TERM_BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch {}
  }, 300);
}
function ensureTermWin() {
  if (termWin && !termWin.isDestroyed()) { try { termWin.show(); termWin.moveTop(); termWin.focus(); } catch {} return termWin; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = loadTermBounds();
  const w = (b && b.width) || Math.min(960, Math.max(640, Math.round(wa.width * 0.6)));
  const h = (b && b.height) || Math.min(680, Math.max(380, Math.round(wa.height * 0.7)));
  const x = (b && b.x >= wa.x && b.x < wa.x + wa.width) ? b.x : undefined;   // só se dentro da work area
  const y = (b && b.y >= wa.y && b.y < wa.y + wa.height) ? b.y : undefined;
  termWin = new BrowserWindow({
    width: w, height: h, minWidth: 560, minHeight: 320, title: 'ATL Terminal', x, y,
    frame: false, transparent: true, resizable: true, maximizable: true, fullscreenable: true,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: false, skipTaskbar: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  termWin.loadFile(path.join(__dirname, 'src/term.html'));
  termWin.webContents.once('did-finish-load', () => {
    termWinReady = true;
    for (const [ch, p] of termQueue.splice(0)) { try { termWin.webContents.send(ch, p); } catch {} }
    sendTerm('term-maximized', !!termWin.isMaximized());   // estado inicial: renderer tira o radius se maximizada
  });
  termWin.on('maximize', () => sendTerm('term-maximized', true));
  termWin.on('unmaximize', () => sendTerm('term-maximized', false));
  termWin.on('resize', saveTermBounds);   // persiste tamanho/posição (debounce; ignora se maximizada)
  termWin.on('move', saveTermBounds);
  termWin.on('closed', () => { termWin = null; termWinReady = false; termQueue.length = 0; termSessions.clear(); });
  return termWin;
}
function destroyTermSession(tabId) {
  const s = termSessions.get(tabId); if (!s) return;
  try { if (s.proc) s.proc.kill(); } catch {}
  if (s.ws) { try { s.ws.close(); } catch {} }
  termSessions.delete(tabId);
}
function addTermSession({ title, kind, origin, tmux_session, sessionKey }) {
  const tabId = ++tabSeq;
  termSessions.set(tabId, { title, kind, origin, tmux_session, sessionKey: sessionKey || null, proc: null, ws: null, cols: 80, rows: 24 });
  sendTerm('term-tab-added', { tabId, title });
  return tabId;
}
function closeTermSession(tabId) {
  destroyTermSession(tabId);
  sendTerm('term-tab-removed', { tabId });
  if (!termSessions.size && termWin && !termWin.isDestroyed()) try { termWin.hide(); } catch {}
}
// spawn node-pty local pra uma aba (shell novo ou tmux attach local).
function spawnPtyLocal(tabId, cmd, cwd) {
  const p = ptyEnsure(); const s = termSessions.get(tabId);
  if (!p || !s) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mnode-pty indisponível\x1b[0m\r\n' }); return; }
  try { console.log('[term] spawn tabId=' + tabId + ' cmd=' + JSON.stringify(cmd));
    const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: cwd || process.env.HOME, env: ptyEnv() });
    proc.onData((d) => sendTerm('pty-out', { tabId, data: d }));
    proc.onExit(() => sendTerm('pty-exit', { tabId }));
    s.proc = proc;
  } catch (e) { console.log('[term] spawn FAIL tabId=' + tabId + ': ' + (e.message || e)); sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m' + (e.message || e) + '\x1b[0m\r\n' }); }
}
// cliente WebSocket do /pty remoto pra uma aba (attach ao vivo no peer).
function openRemotePty(tabId, { host, port, token, tmux_session }) {
  const s = termSessions.get(tabId); if (!s) return;
  const url = 'ws://' + host + ':' + (port || 47474) + '/pty';
  let ws;
  try { ws = new (require('ws'))(url, { headers: { Authorization: 'Bearer ' + token } }); } catch (e) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mWebSocket falhou: ' + e.message + '\x1b[0m\r\n' }); return; }
  s.ws = ws;
  ws.on('open', () => { try { ws.send(JSON.stringify({ type: 'start', tmux_session, cols: s.cols, rows: s.rows })); } catch {} });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'out') sendTerm('pty-out', { tabId, data: m.data });
    else if (m.type === 'exit') sendTerm('pty-exit', { tabId });
    else if (m.type === 'error') sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + m.msg + '\x1b[0m\r\n' });
  });
  ws.on('error', (e) => sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + (e.message || 'erro de conexão') + '\x1b[0m\r\n' }));
}
// ---- handlers IPC da janela Terminal (abas) ----
ipcMain.on('term-new-shell', (_e, host) => {
  ensureTermWin();
  if (host && host !== 'local') {            // shell novo num peer remoto (via /pty, sem tmux_session)
    const cfg = (settingsCfg && settingsCfg.sync) || {};
    const tabId = addTermSession({ title: host + ' · shell', kind: 'remote', origin: host });
    if (!cfg.token) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem token sync configurado\x1b[0m\r\n' }); return; }
    openRemotePty(tabId, { host, port: cfg.port, token: cfg.token });   // sem tmux_session → shell novo no peer
  } else {
    const tabId = addTermSession({ title: 'shell', kind: 'local' });
    const hasTmux = hasBin('tmux');
    const cmd = hasTmux ? launcher.tmuxWrap([process.env.SHELL || 'bash'], launcher.tmuxSessionName('shell') + '-' + Date.now().toString(36)) : [process.env.SHELL || 'bash'];
    spawnPtyLocal(tabId, cmd, process.env.HOME);
  }
});
ipcMain.handle('term-hosts', () => {
  const peers = ((settingsCfg && settingsCfg.sync) || {}).peers || [];
  const live = peers.filter((p) => livePeers.has(p.host));   // só quem tem o ATL ligado (respondeu /sessions)
  return [{ id: 'local', label: 'local' }, ...live.map((p) => ({ id: p.host, label: p.name || p.host }))];
});
ipcMain.on('term-win-control', (_e, op) => {   // chrome custom frameless: min/max/close
  if (!termWin || termWin.isDestroyed()) return;
  try {
    if (op === 'min') termWin.minimize();
    else if (op === 'max') termWin.isMaximized() ? termWin.unmaximize() : termWin.maximize();
    else if (op === 'close') termWin.hide();
  } catch {}
});
// ---- resize via grip (frameless+transparent não tem resize nativo no Linux) ----
let termResizeStart = null;
ipcMain.on('resize-term-start', () => { if (termWin && !termWin.isDestroyed()) termResizeStart = termWin.getSize(); });
ipcMain.on('resize-term-move', (_e, { dw, dh }) => {
  if (!termWin || termWin.isDestroyed() || !termResizeStart) return;
  try { termWin.setSize(Math.max(560, Math.round(termResizeStart[0] + dw)), Math.max(320, Math.round(termResizeStart[1] + dh)), false); } catch {}
});
ipcMain.on('resize-term-end', () => { termResizeStart = null; });
ipcMain.on('term-switch-tab', () => { /* roteamento é por tabId (vem no input/resize); ativação é visual no renderer */ });
ipcMain.on('term-close-tab', (_e, tabId) => { if (tabId != null) closeTermSession(tabId); });
ipcMain.on('term-input', (_e, { tabId, data }) => {
  const s = termSessions.get(tabId); if (!s) return;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'in', data })); } catch {} }
  else if (s.proc) { try { s.proc.write(data); } catch {} }
});
ipcMain.on('term-resize', (_e, { tabId, cols, rows }) => {
  const s = termSessions.get(tabId); if (!s) return;
  if (cols > 0) s.cols = cols;
  if (rows > 0) s.rows = rows;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {} }
  else if (s.proc) { try { s.proc.resize(cols, rows); } catch {} }
});

app.whenReady().then(() => {
  migrateOldBase();                              // dados da era claude-traffic-light
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  // mantém a cópia estável do hook em dia (o settings.json aponta pra ela)
  try { hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR); } catch {}
  // idem pro plugin do OpenCode (só se o usuário já o instalou)
  hookInstaller.syncOpencodeIfInstalled(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
  settingsCfg = loadSettings();                      // threshold/atalho/idioma do usuário
  applyLang();                                       // Preferências (lang) > locale do sistema
  createWindow();
  createTray();
  applyShortcut();                                   // usa settingsCfg.shortcut (+ legado)
  if (collect.backfillModels()) sendSessions(); // preenche model das sessões existentes de cara
  chokidar
    .watch(STATE_DIR, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 } })
    .on('all', () => sendSessions());
  reapDead();
  setInterval(() => { collect.invalidateDiscovery(); reapDead(); sendSessions(); saveBounds(); }, 5000); // descobre novos + limpa mortos + captura posição (drag externo p/ ex.)
  // Consumo/reset dos agentes: GLM (rede, cache 30s) + Codex/Antigravity (disco).
  // Cadência própria (60s) — desacoplada das sessões (que refrescam a cada 5s).
  // O Claude é LAZY: o loop de fundo NÃO bate na API dele (limite agregado do
  // 429); só o boot e os gatilhos de UI (abrir/revelar overlay, ⟳) buscam o %.
  collectAndSendUsage({ claudeFetch: true });    // boot: 1 chamada p/ já ter o %
  setInterval(collectAndSendUsage, 60 * 1000);   // fundo: claudeFetch=false (não bate)
  setupAutoUpdater();                            // update checker (boot + 1h) — AppImage auto-update
  applySync();                                   // sync P2P: sobe servidor/poller se habilitado
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { for (const id of [...termSessions.keys()]) destroyTermSession(id); globalShortcut.unregisterAll(); });

// ---- consumo/reset dos agentes (Claude via ~/.claude.json, GLM via API) ----
// Coletor async (GLM faz rede → nunca bloqueia o ciclo de 5s das sessões).
// Em caso de erro, mantém o último usage válido (não pisca a UI a cada falha).
//
// Persistência: o último uso conhecido é gravado em usage.json e recarregado no
// boot — sobrevive a reinício. As linhas voltam com o fetchedAt antigo, então o
// mergeUsage já as marca stale (cinza) na hora; ou refrescam (viram cor viva) ou
// somem após USAGE_DROP_MS. Nunca mostra número velho como se fosse atual.
// Seguro em disco: o objeto de uso é só {plan,%,reset,...} — NÃO contém tokens.
function loadUsage() {
  try {
    const arr = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    // descarta o que já passou do teto de drop (não ressuscita lixo antigo).
    const now = Date.now();
    return arr.filter((e) => e && e.id && (now - (e.fetchedAt || 0)) < usage.USAGE_DROP_MS)
      .map((e) => ({ ...e, stale: true })); // entra sempre como stale até refrescar
  } catch { return []; }
}
let usageSaveTimer = null;
function saveUsage() {
  clearTimeout(usageSaveTimer);
  usageSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(USAGE_FILE, JSON.stringify(lastUsage)); } catch { /* ignore */ }
  }, 300);
}
let lastUsage = loadUsage();

// Cooldown do 429 da API de uso do Claude, PERSISTIDO em disco (com o contador
// de falhas p/ o backoff exponencial). Sem isto, rodar em dev (`bun start`/
// restarts) perde o estado a cada reinício, re-bate no boot e RE-ESCALA o rate
// limit. Grava só {until, fails} — NUNCA o token. Nunca lança.
function loadClaudeCooldown() {
  try {
    const o = JSON.parse(fs.readFileSync(CLAUDE_COOLDOWN_FILE, 'utf8'));
    const until = (o && typeof o.until === 'number' && o.until > Date.now()) ? o.until : 0;
    const fails = (o && typeof o.fails === 'number' && o.fails > 0) ? o.fails : 0;
    return { until, fails };
  } catch { return { until: 0, fails: 0 }; }
}
function saveClaudeCooldown({ until, fails } = {}) {
  claudeCooldownUntil = until || 0;
  claudeCooldownFails = fails || 0;
  try { fs.writeFileSync(CLAUDE_COOLDOWN_FILE, JSON.stringify({ until: claudeCooldownUntil, fails: claudeCooldownFails })); } catch { /* ignore */ }
}
const _cd0 = loadClaudeCooldown();
let claudeCooldownUntil = _cd0.until;
let claudeCooldownFails = _cd0.fails;

// Credenciais do GLM vivem no AMBIENTE DE CADA TERMINAL (o usuário tem terminais
// Claude/Anthropic e terminais Claude/GLM — z.ai), possivelmente com CONTAS
// z.ai DIFERENTES em terminais diferentes. Não estão em dotfile nem globais.
// Estratégia: varrer TODAS as sessões vivas cujo modelo é GLM e ler
// ANTHROPIC_BASE_URL/AUTH_TOKEN do /proc/<pid>/environ de cada uma. Dedup por
// token (mesma conta em N terminais → 1 bloco). Cada credencial distinta vira
// uma entrada; collectUsage busca o consumo de cada uma com a credencial dela.
// Zero token em disco. Nenhuma sessão GLM → lista vazia → faixa só com Claude.
function crypto_() { return require('crypto'); }
function glmCredsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const byToken = new Map(); // token → { env, label, suffix }
  for (const s of sessions) {
    if (!s.pid || !/^glm/i.test(s.model || '')) continue;
    let env;
    try {
      const raw = getProcessEnviron(s.pid);
      env = usage.parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    } catch { continue; } // processo morreu entre readSessions e a leitura
    if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
    const token = env.ANTHROPIC_AUTH_TOKEN;
    if (byToken.has(token)) continue;      // mesma conta já coletada
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = String(byToken.size + 1); }
    // rótulo da conta = host do endpoint (z.ai / bigmodel) — distingue provedores
    let label = '';
    try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch { /* base inválida */ }
    byToken.set(token, { env, label, suffix });
  }
  return [...byToken.values()];
}

// FALLBACK: o processo PRINCIPAL do Claude Code às vezes não herda as env vars
// do GLM no environ (lançado via wrapper/alias que não repassa), mas seus
// SUBPROCESSOS sim (MCP servers, shells filhos, etc.). Se glmCredsFromSessions
// não achou nada nos pids das sessões, varre todo o sistema procurando qualquer
// processo com ANTHROPIC_BASE_URL (z.ai/bigmodel) + token. A conta é uma só —
// qualquer processo que tenha as credenciais serve pra buscar o % do plano.
// Dedup por token. Nunca lança; só lê o que o dono consegue (EACCES → skip).
function glmCredsFromProc() {
  const byToken = new Map();
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('ps', ['-ax', '-E', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const content = m[2];
        const rawEnv = parseMacOSEnviron(content);
        const env = usage.parseEnviron(rawEnv, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
        if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
        if (!/api\.z\.ai|bigmodel\.cn/.test(env.ANTHROPIC_BASE_URL)) continue;
        const token = env.ANTHROPIC_AUTH_TOKEN;
        if (byToken.has(token)) continue;
        let suffix;
        try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
        catch { suffix = String(byToken.size + 1); }
        let label = '';
        try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch {}
        byToken.set(token, { env, label, suffix });
        if (byToken.size >= 2) break;
      }
    } catch { return []; }
  } else {
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(n => parseInt(n, 10)); } catch { return []; }
    for (const pid of pids) {
      let raw;
      try { raw = getProcessEnviron(pid); } catch { continue; }
      const env = usage.parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
      if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
      if (!/api\.z\.ai|bigmodel\.cn/.test(env.ANTHROPIC_BASE_URL)) continue;
      const token = env.ANTHROPIC_AUTH_TOKEN;
      if (byToken.has(token)) continue;
      let suffix;
      try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
      catch { suffix = String(byToken.size + 1); }
      let label = '';
      try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch {}
      byToken.set(token, { env, label, suffix });
      if (byToken.size >= 2) break;
    }
  }
  return [...byToken.values()];
}

// OpenCode guarda as credenciais dos providers em auth.json. Se houver o
// provider z.ai (zai-coding-plan), sua API key consulta a MESMA API de quota do
// GLM (/api/monitor/usage/quota/limit) → reaproveita readGlmUsage. Assim o uso
// do OpenCode-via-z.ai aparece na faixa mesmo sem sessão GLM viva no /proc.
// Zero token exposto além do que já está no auth.json local.
function opencodeGlmCreds() {
  const authFile = path.join(DATA_HOME, 'opencode', 'auth.json');
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return []; }
  const out = [];
  // provider zai-coding-plan (z.ai) — { type:'api', key:'...' }
  const zai = auth['zai-coding-plan'];
  if (zai && zai.type === 'api' && zai.key) {
    const token = zai.key;
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = 'oc'; }
    out.push({
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: token },
      label: 'z.ai', suffix,
    });
  }
  return out;
}

// Mescla duas listas de credenciais GLM, deduplicando pelo token (uma conta
// z.ai aberta no terminal E no OpenCode não deve virar 2 blocos iguais).
function mergeGlmCreds(a, b) {
  const byToken = new Map();
  for (const c of [...(a || []), ...(b || [])]) {
    const tok = c && c.env && c.env.ANTHROPIC_AUTH_TOKEN;
    if (tok && !byToken.has(tok)) byToken.set(tok, c);
  }
  return [...byToken.values()];
}

function getProcessCwd(pid) {
  if (!pid) return null;
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1000 });
      for (const line of output.split('\n')) {
        if (line.startsWith('n')) {
          return line.slice(1).trim();
        }
      }
    } catch {}
    return null;
  } else {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
}

// Codex é passivo: o uso vive no rollout da sessão, associado por cwd. As
// sessões Codex vivas são detectadas por /proc (sem state file próprio) e o
// cwd é lido de /proc/<pid>/cwd no Linux ou via lsof no macOS. Dedup por cwd.
function codexCwdsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const cwds = new Set();
  for (const s of sessions) {
    if (!s.pid || agentOf(s) !== 'codex') continue;
    try {
      const cwd = getProcessCwd(s.pid);
      if (cwd) cwds.add(cwd);
    } catch { /* processo morreu ou sem permissão */ }
  }
  return [...cwds];
}

async function collectAndSendUsage({ claudeFetch = false } = {}) {
  try {
    let glmCreds = glmCredsFromSessions();
    // Fallback 1: o próprio app foi lançado de um terminal GLM (vars já no env).
    if (!glmCreds.length && process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
      glmCreds = [{ env: process.env }];
    }
    // Fallback 2: o processo principal do Claude Code às vezes não herda as
    // vars, mas subprocessos sim. Varre o /proc inteiro procurando qualquer
    // processo com credenciais z.ai (a conta é uma só). Resolve o bug do GLM
    // "parar de atualizar" quando nenhuma sessão-monitorada tem as vars no environ.
    if (!glmCreds.length) glmCreds = glmCredsFromProc();
    // OpenCode: se tiver o provider z.ai (zai-coding-plan) no auth.json, a
    // credencial dele consulta a MESMA API de quota — mescla (dedup por token).
    glmCreds = mergeGlmCreds(glmCreds, opencodeGlmCreds());
    const codexCwds = codexCwdsFromSessions();
    const entries = await usage.collectUsage({
      glmCreds, codexCwds, home: app.getPath('home'),
      // LAZY: o loop de fundo (claudeFetch=false) NÃO bate na API do Claude — só
      // os gatilhos de UI (abrir/revelar overlay, ⟳) e o boot passam true. Tira o
      // app do limite agregado do 429 (compartilhado com o /status do Claude Code).
      claudeAllowFetch: claudeFetch,
      // cooldown do 429 persistido: não rebate na API enquanto vigente; o coletor
      // chama de volta setCooldown quando leva um 429 novo (grava {until, fails}).
      claudeCooldownUntil: claudeCooldownUntil,
      claudeCooldownFails: claudeCooldownFails,
      claudeSetCooldown: saveClaudeCooldown,
    });
    // Funde com o último estado: mantém o valor bom de cada linha se a coleta
    // atual falhou pra ela (evita zerar/sumir); esmaece pra cinza (stale) após
    // alguns min sem atualização em vez de piscar. Ver usage.mergeUsage.
    if (Array.isArray(entries)) { lastUsage = usage.mergeUsage(lastUsage, entries); saveUsage(); maybeNotifyReset(); }
  } catch { /* collectUsage já engole erros internamente; defeção dupla */ }
  sendToRenderer('usage', lastUsage);
  // meta p/ a UI: o cooldown do 429 (se vigente) alimenta o tooltip do botão ⟳.
  sendToRenderer('usage-meta', { claudeCooldownUntil: claudeCooldownUntil > Date.now() ? claudeCooldownUntil : 0, claudeCooldownFails: claudeCooldownUntil > Date.now() ? claudeCooldownFails : 0 });
}

// Estado (por id) que detectReset usa entre coletas p/ achar a transição
// "estava esgotado → resetou". Vive só na memória do processo: se o app estava
// fechado no horário do reset, não há estado prévio → não notifica retroativo
// (proposital — o usuário já vê a barra liberada ao reabrir).
let resetNotifyState = {};
// Após cada coleta, vê se algum limite ESGOTADO acabou de resetar e — se o
// usuário deixou ligado (settings.notifyOnReset) — dispara uma notificação
// nativa COM som (silent:false; é um evento que o usuário estava esperando).
// Nunca lança: a detecção de reset não pode derrubar o loop de uso.
function maybeNotifyReset() {
  try {
    if (settingsCfg.notifyOnReset === false) { resetNotifyState = {}; return; }
    const threshold = typeof settingsCfg.resetNotifyThresholdPct === 'number' ? settingsCfg.resetNotifyThresholdPct : 90;
    const { toNotify, nextState } = usage.detectReset(resetNotifyState, lastUsage, Date.now(), threshold);
    resetNotifyState = nextState;
    for (const e of toNotify) {
      const name = [e.plan, e.title].filter(Boolean).join(' · ') || e.id;
      try { new Notification({ title: 'AI Traffic Lights', body: T('ntf_tokens_reset', { name }), silent: false }).show(); } catch {}
    }
    if (toNotify.length && settingsCfg.revealOnReset) revealIfHidden(); // traz à frente se oculto
  } catch { /* detecção de reset nunca derruba a coleta */ }
}
ipcMain.on('request-usage', () => {
  sendToRenderer('usage', lastUsage);
  sendToRenderer('usage-meta', { claudeCooldownUntil: claudeCooldownUntil > Date.now() ? claudeCooldownUntil : 0, claudeCooldownFails: claudeCooldownUntil > Date.now() ? claudeCooldownFails : 0 });
});

// Force (botão ⟳): fura o cache de CONVENIÊNCIA (5min Claude / 30s GLM) e
// recoleta na hora. NÃO fura o cooldown do 429 — esse vive no disco e é injetado
// em collectUsage, então mesmo com o cache limpo o coletor não re-bate durante a
// janela de rate limit (evita re-escalar). É "atualizar já", não "ignorar limite".
ipcMain.on('force-usage', () => {
  try {
    // Durante cooldown ativo NÃO limpa o cache do Claude: ele guarda o último
    // valor bom que readClaudeUsage usa como fallback. Limpá-lo faria o tile
    // regredir p/ plano-só (perder o %) só porque o usuário clicou ⟳ no rate
    // limit. Fora do cooldown, limpa normalmente p/ forçar recoleta real.
    if (!(claudeCooldownUntil > Date.now())) usage._clearClaudeCache();
    usage._clearGlmCache();
    usage._clearCodexCache();
  } catch { /* ignore */ }
  collectAndSendUsage({ claudeFetch: true });   // ⟳: gatilho de UI → busca o % agora
});

// ---- update checker (versão + release mais nova do GitHub) ----
// Detecta COMO o app foi instalado pra oferecer o caminho de atualização certo.
//   appimage → AppImage type 2 (execPath em /tmp/.mount_<nome>, ou *.AppImage)
//   deb      → instalado em /opt (electronic-builder deb vira /opt/AI Traffic Lights)
//   npm      → rodando de node_modules (npm install / dev)
//   source   → clone do repo (dev direto)
//
// A detecção de AppImage NÃO depende só da env APPIMAGE: o Electron 43 às vezes
// a perde no re-exec do sandbox, então conferimos também o execPath (mount point
// /tmp/.mount_<nome>). Quando detectamos AppImage sem a env, recuperamos o caminho
// do .AppImage e re-exportamos em process.env.APPIMAGE — o electron-updater
// depende dela pra (a) saber que é AppImage e (b) qual arquivo substituir na
// instalação. Sem isto, o auto-update nunca aparecia (sempre caía em "abrir release").
function detectInstallMethod() {
  if (process.env.APPIMAGE) return 'appimage';
  const exe = process.execPath || '';
  if (/^\/tmp\/\.mount_[^/]+\//.test(exe) || /\.AppImage$/i.test(exe)) {
    const resolved = resolveAppImagePath();
    if (resolved && !process.env.APPIMAGE) process.env.APPIMAGE = resolved;
    return 'appimage';
  }
  const appPath = app.getAppPath();
  if (/\/opt\/AI Traffic Lights/.test(exe) || appPath.includes('/opt/')) return 'deb';
  if (appPath.includes('node_modules')) return 'npm';
  return 'source';
}

// Recupera o caminho absoluto do .AppImage em execução quando o runtime perdeu a
// env APPIMAGE. Cascata: env → execPath (*.AppImage) → Exec= do .desktop do app
// (fonte confiável mantida pelo próprio app) → busca por basename do mount em
// locais canônicos (~/Applications, ~/.local/bin, ~/Downloads, /opt).
function resolveAppImagePath() {
  if (process.env.APPIMAGE) return process.env.APPIMAGE;
  const exe = process.execPath || '';
  if (/\.AppImage$/i.test(exe)) return exe;
  try {
    const home = app.getPath('home');
    const desktops = [
      path.join(home, '.local', 'share', 'applications', 'ai-traffic-lights.desktop'),
      AUTOSTART_FILE,
    ];
    for (const dp of desktops) {
      try {
        const m = fs.readFileSync(dp, 'utf8').match(/^Exec=(\S+\.AppImage)\b/m);
        if (m && fs.existsSync(m[1])) return m[1];
      } catch {}
    }
    const mm = exe.match(/\/tmp\/\.mount_([^/]+)/);
    if (mm) {
      const dirs = [path.join(home, 'Applications'), path.join(home, '.local', 'bin'), path.join(home, 'Downloads'), '/opt'];
      for (const d of dirs) {
        let ents; try { ents = fs.readdirSync(d); } catch { continue; }
        for (const f of ents) if (/\.AppImage$/i.test(f) && /ai.?traffic.?lights/i.test(f)) return path.join(d, f);
      }
    }
  } catch {}
  return null;
}
// Compara versões semver ('0.3.2' vs '0.4.0'); >0 se a>b, 0 se iguais, <0 se a<b.
function semverCmp(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
// ---- auto-updater (AppImage) + estado de update ----
// electron-updater só auto-atualiza AppImage no Linux; deb/npm/source caem no
// fallback GitHub-API (só informativo → abre a release no navegador).
let autoUpdater = null;
let _manualCheck = false;   // verificação manual pelo tray → notifica o resultado
let updateState = {
  hasUpdate: false, latest: null, method: null,
  status: 'idle', progress: 0, url: null,
  canAutoInstall: false, error: null,
};
function emitUpdateState() {
  if (win && !win.isDestroyed()) win.webContents.send('update-state', updateState);
}
function setUpdateState(patch) { updateState = { ...updateState, ...patch }; emitUpdateState(); }

// Configura o autoUpdater (eventos) e dispara a 1ª checagem + scheduler 1h.
// Chamado no app.whenReady (precisa de app pronto p/ detectInstallMethod/getAppPath).
function setupAutoUpdater() {
  const method = detectInstallMethod();
  updateState.method = method;
  if (method === 'appimage') {
    try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { console.error('[auto-update] require electron-updater falhou:', e && e.message); autoUpdater = null; }
  }
  updateState.canAutoInstall = !!autoUpdater;
  if (autoUpdater) {
    autoUpdater.autoDownload = true;           // baixa sozinho ao detectar (instala no clique "↻" ou no quit)
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      const v = ((info && info.version) || '').replace(/^v/, '');
      setUpdateState({ hasUpdate: true, latest: v, url: REPO_URL + '/releases/tag/v' + v, status: 'available', error: null });
      if (_manualCheck) _notifyManualResult(true, v, null);
      if (settingsCfg.revealOnUpdate) revealIfHidden(); // traz à frente se oculto
    });
    autoUpdater.on('update-not-available', () => { setUpdateState({ hasUpdate: false, status: 'idle' }); if (_manualCheck) _notifyManualResult(false, null, null); });
    autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', progress: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', () => setUpdateState({ status: 'ready', progress: 100 }));
    autoUpdater.on('error', (e) => { const msg = String((e && e.message) || e); setUpdateState({ status: 'error', error: msg }); if (_manualCheck) _notifyManualResult(false, null, msg); });
  }
  checkForUpdates();                            // 1ª checagem no boot
  setInterval(checkForUpdates, 60 * 60 * 1000); // re-checa a cada 1h
}

// Cache da checagem GitHub-API (fallback não-appimage): 30min pra não spammar.
let _updateCache = null;
async function checkUpdateGithub() {
  const now = Date.now();
  if (_updateCache && now - _updateCache.checkedAt < 30 * 60 * 1000) return _updateCache.info;
  const info = { current: APP_VERSION, method: updateState.method, latest: null, hasUpdate: false, url: null, error: null };
  try {
    const https = require('https');
    const body = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: '/repos/aronpc/ai-traffic-lights/releases/latest',
        method: 'GET',
        headers: { 'User-Agent': 'ai-traffic-lights', Accept: 'application/vnd.github+json' },
        timeout: 5000,
      }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    const j = JSON.parse(body);
    info.latest = (j.tag_name || '').replace(/^v/, '');
    info.url = j.html_url || (REPO_URL + '/releases/latest');
    info.hasUpdate = info.latest ? semverCmp(info.latest, APP_VERSION) > 0 : false;
  } catch (e) {
    info.error = String(e.message || e); // offline/timeout → sem update, sem quebrar
  }
  _updateCache = { checkedAt: now, info };
  return info;
}

// Dispara a verificação (AppImage → autoUpdater; demais → GitHub-API). Nunca lança.
async function checkForUpdates() {
  try {
    if (autoUpdater) { await autoUpdater.checkForUpdates(); return; }
    const info = await checkUpdateGithub();
    setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
  } catch (e) {
    setUpdateState({ status: 'error', error: String((e && e.message) || e) });
  }
}

// Verificação MANUAL pelo tray: ignora o cache e notifica o resultado.
async function checkUpdatesManual() {
  _manualCheck = true;
  _updateCache = null;
  try {
    if (autoUpdater) { await autoUpdater.checkForUpdates(); return; } // resultado → eventos + _notifyManualResult
    const info = await checkUpdateGithub();
    setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
    _notifyManualResult(info.hasUpdate, info.latest, info.error);
  } catch (e) {
    _notifyManualResult(false, null, String((e && e.message) || e));
  } finally {
    if (!autoUpdater) _manualCheck = false; // AppImage: é o evento quem limpa a flag
  }
}
// Notificação de fim da verificação manual (achou / em dia / erro).
function _notifyManualResult(hasUpdate, latest, error) {
  _manualCheck = false;
  try {
    let n;
    if (error) n = new Notification({ title: 'AI Traffic Lights', body: T('ntf_update_error'), silent: true });
    else if (hasUpdate) {
      n = new Notification({ title: 'AI Traffic Lights', body: T('ntf_update_available', { v: latest }), silent: false });
      n.on('click', () => { try { if (updateState.url) shell.openExternal(updateState.url); } catch {} });
    } else n = new Notification({ title: 'AI Traffic Lights', body: T('ntf_up_to_date'), silent: true });
    n.show();
  } catch {}
}

ipcMain.handle('get-update', () => { if (updateState.status === 'idle' && !updateState.latest) checkForUpdates(); return updateState; });
ipcMain.on('check-update', () => { _updateCache = null; checkForUpdates(); });   // "verificar agora" ignora o cache
ipcMain.on('download-update', () => { if (autoUpdater) { try { autoUpdater.downloadUpdate(); } catch {} } });
ipcMain.on('install-update', () => { if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch {} } });
