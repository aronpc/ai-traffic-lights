// main.js — Electron main process (ai-traffic-lights).
// Translucent overlay window, always on top. Watches the state directory,
// sends sessions to the renderer, auto-resizes height by line count,
// and persists width + position across restarts.

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, Notification, nativeImage, globalShortcut, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const chokidar = require('chokidar');
const { AGENTS, agentOf } = require('./src/agents');
const hookInstaller = require('./src/hook-installer');
const kiroAdapter   = require('./adapters/kiro/ai-traffic-lights');
const focus = require('./src/focus');
const sessions = require('./src/sessions');
const collect = require('./src/collect');
const net = require('./src/net');
const transcript = require('./src/transcript');
const settingsLib = require('./src/settings');
const i18n = require('./src/i18n');
const launcher = require('./src/launcher');
const usage = require('./src/usage');
const claudePaths = require('./src/claude-config');
const readMarksLib = require('./src/read-marks');
const { sessionKey, rewriteKeyOrigin, isLocalSession } = require('./src/identity');
const { spawn } = require('child_process');
const { desktopEscape, shellQuote, boundsOnScreen } = require('./src/validate');

// Sandbox/shared-memory flags (--no-sandbox --disable-dev-shm-usage) go on the
// COMMAND LINE: build.linux.executableArgs (packaged) and scripts.start (dev).
// They must reach Chromium BEFORE it initializes the sandbox/shm — here in
// main.js it is too late (appendSwitch does not work for these switches), and
// the window would render transparent (no compositing). Do not use appendSwitch here.

// App version (from package.json — app.getVersion reads it directly, works in asar)
// and the repo public URL (Preferences footer + tray tooltip).
const APP_VERSION = app.getVersion();
const REPO_URL = 'https://github.com/aronpc/ai-traffic-lights';
// P2P sync feature is beta: only in pre-release builds (0.7.4-beta.N, read
// from app.getVersion). In the stable/source build (0.7.3) the Synchronization
// tab is hidden and nothing sync-related is written or uploaded.
const SYNC_AVAILABLE = settingsLib.isPrerelease(APP_VERSION);

// Single instance: relaunching the app does not duplicate the overlay — it
// TOGGLES the existing one and exits. Prevents duplicate overlays (autostart +
// manual launch) and provides a shortcut path on Wayland, where X grabs
// (globalShortcut) do not fire when a native Wayland app has focus: bind a
// GNOME shortcut to the app command and each activation shows/hides it.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => toggleWin());

// Graphical session: on Wayland, wmctrl/xdotool only see XWayland windows —
// per-window focus degrades and the terminal's native URI becomes the primary path.
// Under forced XWayland (--ozone-platform=x11 via executableArgs/start), the app is
// X11: wmctrl/xdotool see its windows and alwaysOnTop works (native
// Wayland ignores 'above'). We only treat it as native Wayland (where wmctrl
// fails and per-window focus degrades) when the flag is NOT present AND the session is wayland.
const IS_WAYLAND = !process.argv.includes('--ozone-platform=x11') &&
  (process.env.XDG_SESSION_TYPE === 'wayland' ||
    (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11'));

// Neutral (XDG) data directory — the state dir is the contract between adapters
// (writers) and this app (reader). See src/agents.js and hooks/traffic-hook.sh.
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(process.env.HOME, '.local/share');
const BASE_DIR = path.join(DATA_HOME, 'ai-traffic-lights');
const STATE_DIR = path.join(BASE_DIR, 'state');
const BOUNDS_FILE = path.join(BASE_DIR, 'window.json'); // {x, y, width}
const ALIASES_FILE = path.join(BASE_DIR, 'aliases.json'); // {sessionKey: nickname}
const ACCOUNT_LABELS_FILE = path.join(BASE_DIR, 'account-labels.json'); // {accountUuid|dir: Claude ACCOUNT nickname (#58)
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json'); // {idleThresholdSec, escalateIdle, shortcut}
const USAGE_FILE = path.join(BASE_DIR, 'usage.json'); // last known usage (survives restart; shown stale until refreshed)
const CLAUDE_COOLDOWN_FILE = path.join(BASE_DIR, 'claude-cooldown.json'); // {until:<ms>} — 429 cooldown from the usage API (ONLY the timestamp, never the token)
const SETTINGS_BOUNDS_FILE = path.join(BASE_DIR, 'settings-window.json'); // {x, y, width, height}
const TERM_BOUNDS_FILE = path.join(BASE_DIR, 'term-window.json'); // {x, y, width, height} of the Terminal window
const READ_MARKS_FILE = path.join(BASE_DIR, 'read-marks.json'); // {sessionKey: readAt} — persistent read mark (#56)
const AUTOSTART_FILE = path.join(process.env.HOME, '.config/autostart/ai-traffic-lights.desktop');

// ---- migration from the claude-traffic-light era (pre-rename) ----
const OLD_BASE = path.join(process.env.HOME, '.claude-shared/traffic-light');
const OLD_AUTOSTART = path.join(process.env.HOME, '.config/autostart/claude-traffic-light.desktop');
function migrateOldBase() {
  try {
    if (!fs.existsSync(OLD_BASE)) return;
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // window.json / aliases.json: copy if they do not yet exist in the new location
    for (const f of ['window.json', 'aliases.json']) {
      const from = path.join(OLD_BASE, f), to = path.join(BASE_DIR, f);
      try { if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to); } catch {}
    }
    // state files: move the ones that do not exist in the new dir (the hook may have already created them)
    const oldState = path.join(OLD_BASE, 'state');
    try {
      for (const f of fs.readdirSync(oldState).filter((x) => x.endsWith('.json'))) {
        const to = path.join(STATE_DIR, f);
        try { if (!fs.existsSync(to)) fs.renameSync(path.join(oldState, f), to); } catch {}
      }
    } catch {}
  } catch {}
}

// Detection maps (COMM_TO_AGENT/ARGV_TO_AGENT/SHELLS) and the /proc probe live
// in src/collect.js (Electron-free core, reused by the future headless agent.js).
// AGENTS is still used here for UI/launcher/tray.

const DEFAULT_W = 360;
const HEADER_H = 58; // must match --header-h from the CSS
const MIN_W = 348, MAX_W = 720; // 348: header with 5 buttons (list+footer+prefs+expand+close) without clipping the ×
const MIN_H = HEADER_H + 40;

let win;

// Overlay height ceiling = 90% of the work area of the SCREEN the window is
// on (not a fixed value): scrolling the list is the last resort, only when
// the sessions do not fit even in nearly the whole screen. Recomputed on every
// auto-height — dragging the overlay to a smaller monitor fixes the ceiling on
// the next render (2s). It used to be MAX_H = 640 fixed: on 1080p the list
// scrolled at ~16 rows using only 60% of the screen. The 90% (not 100%) leaves
// breathing room so the overlay never touches the screen bottom or covers the
// dock/notifications.
function maxOverlayH() {
  if (!win || win.isDestroyed()) return 640;
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  return Math.max(MIN_H, Math.round(wa.height * 0.9));
}

// Session collection: local (collect) + remote (peers, already carrying
// `origin` set by pollPeers). The wrapper preserves call sites (sendSessions,
// timers, ipc). Remote sessions enter the SAME pipeline — sessionKey
// (namespaced by origin, in identity.js) keeps them apart from local ones,
// with no pid collision across machines.
function readSessions() {
  const local = collect.readSessions();
  const all = remoteSessions.size ? local.concat(Array.from(remoteSessions.values()).flat()) : local;
  return annotateClaudeAccounts(all);
}

// Claude account for each session (details modal): resolves the label from the
// CLAUDE_CONFIG_DIR in the pid's environ — same discovery as
// claudeAccountsFromSessions (#58), but per session. The logic lives in
// src/annotate.js (testable): only the dir is cached per pid (environ does not
// change over the process lifetime → one /proc read per NEW session), label
// recomputed every cycle (a tile rename propagates) and hits stored by
// session_id (a pid reused by another process re-reads the environ). Remote
// sessions (with origin) already arrive annotated by the peer: the label is
// harmless (nickname/org/local-part — never full email/uuid) and is NOT
// LOCAL_ONLY, it travels in the /sessions payload.
// In-memory annotation: none of this is written to the state file.
const annotateClaudeAccounts = require('./src/annotate').makeAnnotator({
  getEnviron: getProcessEnviron,
  parseEnviron: usage.parseEnviron,
  readClaudeConfig: (dir) => usage.readClaudeConfig({ home: app.getPath('home'), dir }), // cache mtime
  claudeAccountKey: usage.claudeAccountKey,
  accountLabel: usage.accountLabel,
  apiProviderFromSettings: usage.apiProviderFromSettings,
  agentOf,
  labelsFile: ACCOUNT_LABELS_FILE,
  fs,
});

// ---- click-to-focus: activates the session's window (and TAB, when possible) ----
// Two separate responsibilities (the pure decision lives in src/focus.js):
//  • WINDOW (X11/wmctrl): pickWindow() validates the stored windowid against
//    the session's process tree — a stale/recycled id no longer focuses the
//    wrong window (issue #1, H2); without a valid id, the process's 1st window.
//  • TAB (terminal's native channel, invisible to X11): tabChannel() picks
//    Warp (`xdg-open warp://session/<uuid>`) or Tilix (`gdbus activate-terminal
//    <TILIX_ID>`). It is the only way to reach the right tab/pane.
// focus (raiseWindow/focusTab/focusTmuxPane/enrichTarget/focusSession + ancestorPidsOf): extracted to src/ipc/focus.js (REF step 4)
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

// aliases (loadAliases/saveAlias + get-aliases/set-alias handlers): extracted
// to src/ipc/aliases.js (REF step 7). Registered at boot via setupAliasesIpc.

// ---- language (i18n) ----
// Priority: manual choice in Preferences (settings.lang ≠ 'auto') >
// system locale (app.getLocale, only valid after ready). Delivered to
// renderers via get-lang IPC; default en until ready — nothing visible before.
let LANG = 'en';
let T = i18n.makeT(LANG);
function applyLang() {
  const pref = settingsCfg && settingsCfg.lang;
  LANG = (pref === 'en' || pref === 'pt') ? pref : i18n.pickLang(app.getLocale());
  T = i18n.makeT(LANG);
}

// ---- settings (idle threshold + global shortcut) ----
let settingsCfg = settingsLib.mergeWithDefaults(null);   // always valid
function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return settingsLib.mergeWithDefaults(raw);
}
function persistSettings(cfg) {
  // Merge over the CURRENT state, not over the defaults: Preferences sends a
  // PARTIAL cfg (only its own fields). Without spreading settingsCfg first,
  // every save would reset showUsage/collapsed/launchers to default — wiping
  // custom launchers and flickering the footer. Crucial for live-apply (writes
  // on every change) and fixes the latent wipe the batch "Save" already had.
  settingsCfg = settingsLib.mergeWithDefaults({ ...settingsCfg, ...cfg });
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCfg, null, 2)); } catch {}
  return settingsCfg;
}

// Registers the configured show/hide shortcut. Idempotent: clears the
// previous ones first. Keeps the legacy CommandOrControl+Shift+Alt+L as a
// safety net (if the user changes the primary one and forgets, there is still
// a way in).
function applyShortcut() {
  try { globalShortcut.unregisterAll(); } catch {}
  for (const acc of [settingsCfg.shortcut, 'CommandOrControl+Shift+Alt+L']) {
    if (acc && settingsLib.isValidShortcut(acc)) {
      try { globalShortcut.register(acc, toggleWin); } catch {}
    }
  }
}

// ---- Quick Launcher: detects installed CLIs and starts an agent in a terminal ----
// Detection via PATH scan (fork-free: only fs.access on the PATH dirs).
// Electron runs outside the interactive shell, so it does not see aliases —
// it finds the real binary.
// Alias-only CLIs (no binary in PATH) come in via the settings.launchers[id] override.
// launcher (detectLaunchers/availableTerminals/launchAgent): extracted to src/ipc/launcher.js (REF step 5)
function scanPathBin(bin) {
  const path = process.env.PATH || '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const p = path_join(dir, bin);
    try { if (fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true)) return p; } catch {}
  }
  return null;
}
function path_join(dir, bin) { // local path.join (without shadowing the require)
  return dir.replace(/\/+$/, '') + '/' + bin;
}

// detectLaunchers + its cache (_launchers/_launchersAt): extracted to
// src/ipc/launcher.js (REF step 5), along with availableTerminals.

// Most recent cwd among the sessions (where "+ agent" opens by default).
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

// Starts the agent in a terminal at the given cwd. Detached + unref: the
// overlay is not the process's parent — the session enters the traffic light
// through the normal path (hooks → state).

// ---- remote attach (tmux): opens a LOCAL terminal attached to a tmux session
// (directly local, or remote via SSH/Tailscale). Live and shared (multi-
// client): no --resume, no killing the other machine's terminal. Sanitizes
// name+host (they come from config/peer — shell-injection guard for the remote command).
// Warp: launch-config YAML + warp://launch. The warp:// scheme is usually
// registered (dev.warp.Warp.desktop) EVEN when the `warp` binary is not in
// PATH — so xdg-open opens the app and runs the command from the config.
// Terminal tab name. Order: alias > row label (the renderer sends the
// SAME labelFor it draws in the list) > cwd basename > 'tmux: <session>'.
// The tmux-name fallback is the last resort: it is the multiplexer's internal
// id ("41"), tells the user nothing and did not match the list name.
// A remote session carries the origin machine prefix.
function termTabTitle({ alias, label, cwd, tmux_session, origin, isLocal }) {
  const base = alias
    || label
    || (cwd ? String(cwd).replace(/\/+$/, '').split('/').pop() : '')
    || ('tmux: ' + (tmux_session || 'shell'));
  return (isLocal ? '' : (origin || '') + ' · ') + base;
}

// Reconnects a tab whose connection died (pty closed / WS dropped). Reuses
// what the session already stores — it does not depend on anything from the
// clicked row, so it works even when the revive comes from a click on the
// tab, not the list. Clears the screen first: the old buffer belongs to a
// connection that no longer exists.
function reviveTermSession(tabId, s) {
  sendTerm('pty-out', { tabId, data: '\x1b[2J\x1b[H\x1b[90m[reconectando…]\x1b[0m\r\n' });
  if (s.kind === 'local') {
    spawnPtyLocal(tabId, ['tmux', 'attach', '-t', s.tmux_session], s.cwd);
    return;
  }
  const host = originToHost.get(s.origin) || '';
  const cfg = (settingsCfg && settingsCfg.sync) || {};
  if (!host || !cfg.token) {
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem host/token para ' + (s.origin || '?') + '\x1b[0m\r\n' });
    return;
  }
  openRemotePty(tabId, { host, port: cfg.port, token: cfg.token, tmux_session: s.tmux_session });
}

function attachRemote({ origin, tmux_session, cwd, alias, key, label }) {
  if (!tmux_session) { notifyUser(T('ntf_attach_no_tmux')); return; }
  const isLocal = !origin || origin === 'local';
  const dupKey = (isLocal ? 'local' : origin) + '|' + tmux_session;
  // dedupe: a tab for this session already exists → focus it. But if the
  // connection DIED (peer restarted, wifi dropped, sync turned off on the other
  // side), the tab is left orphaned in the Map with ws/proc null: focusing
  // without reconnecting left the tab EMPTY forever, with no way to recover
  // except closing it by hand. So it reconnects.
  for (const [id, s] of termSessions) {
    if (((s.kind === 'local' ? 'local' : s.origin) + '|' + s.tmux_session) !== dupKey) continue;
    ensureTermWin();
    const dead = !s.ws && !s.proc;
    if (dead) reviveTermSession(id, s);
    sendTerm('term-tab-activated', { tabId: id });
    return;
  }
  ensureTermWin();
  const title = termTabTitle({ alias, label, cwd, tmux_session, origin, isLocal });
  const tabId = addTermSession({ title, kind: isLocal ? 'local' : 'remote', origin: isLocal ? null : origin, tmux_session, sessionKey: key, label, cwd });
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
    try { fs.unlinkSync(OLD_AUTOSTART); } catch {} // clears the pre-rename era .desktop
    if (on) {
      // Escapes each path per the .desktop spec (backslash on space/$/`/").
      // Without this, a HOME with a space breaks Exec at login.
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

// Safe send to the renderer. The window can exist while the RENDER FRAME has
// already been discarded (renderer crash, reload, devtools) — then
// webContents.send throws "Render frame was disposed before WebFrameMain could
// be accessed" on EVERY timer tick (5s/60s), spamming stderr nonstop. This
// guard checks that webContents is alive/not crashed and swallows any residual
// race error.
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return false;
  try { wc.send(channel, payload); return true; }
  catch { return false; }
}

function sendSessions() {
  const list = readSessions();
  sendToRenderer('sessions', list);
  pushDetails(list);   // details window open → LIVE data (on every refresh)
}

// ---- read marks (#56) ----
// Persistent state {sessionKey: readAt} in BASE_DIR. Solves two problems:
// (a) renderer readMarks were memory-only and died on restart; (b) marks
// posted by a PEER via POST /read need an owner in main to be applied
// (push to the renderer) and survive restart. Per-key LWW in
// read-marks.js (highest readAt wins — never "un-reads").
let readMarksState = readMarksLib.loadReadMarks(READ_MARKS_FILE);
function sendReadMarks() {
  sendToRenderer('read-marks', readMarksState);
}
// Sync server callback (net.startServer onReadMarks): LWW merge,
// persists and LIVE-pushes each applied mark to the renderer. Returns the
// applied count — the peer knows (applied=0 = nothing changed, e.g. an older mark).
function applyReadMarks(marks) {
  const { state, applied } = readMarksLib.applyMarks(readMarksState, marks);
  if (!applied.length) return 0;
  readMarksState = state;
  readMarksLib.saveReadMarks(READ_MARKS_FILE, readMarksState);
  for (const m of applied) sendToRenderer('remote-read', m);
  return applied.length;
}

// ---- DETACHED session details window (#59) ----
// Before: a BLOCKING panel inside the overlay (backdrop over the list, data
// frozen at open time). Now: its own frameless BrowserWindow (termWin
// pattern), the overlay stays clickable and main PUSHES the session on every
// 5s refresh — leaving it open = live monitoring. One window at a time
// (reopening with another session swaps the content); a session that dies →
// push with s=null and the page shows "session ended" instead of the last
// snapshot.
let detailsWin = null;
let detailsKey = null;                 // sessionKey being displayed (null = window closed)
let detailsBoundsTimer = null;
const DETAILS_BOUNDS_FILE = path.join(BASE_DIR, 'details-window.json');
function loadDetailsBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(DETAILS_BOUNDS_FILE, 'utf8'));
    if (b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number')) return b;
  } catch {}
  return null;
}
function saveDetailsBounds() {
  if (!detailsWin || detailsWin.isDestroyed() || detailsWin.isMaximized()) return;
  clearTimeout(detailsBoundsTimer);
  detailsBoundsTimer = setTimeout(() => {
    try {
      const b = detailsWin.getBounds();
      fs.writeFileSync(DETAILS_BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch {}
  }, 300);
}
// Push to the open window: the session matched by key + the current read mark
// (readMarksState lives here in main — the page holds no state of its own).
function pushDetails(list) {
  if (!detailsWin || detailsWin.isDestroyed() || !detailsKey) return;
  const s = (list || []).find((x) => sessionKey(x) === detailsKey) || null;
  const readAt = readMarksState[detailsKey] || 0;
  try { detailsWin.webContents.send('details-data', { s, readAt }); } catch {}
}
function ensureDetailsWin() {
  if (detailsWin && !detailsWin.isDestroyed()) return;
  const b = loadDetailsBounds() || {};
  // Off any screen (monitor disconnected) → undefined, Electron
  // centers on the primary one (same reason as termWin).
  const keep = boundsOnScreen(b, screen.getAllDisplays());
  detailsWin = new BrowserWindow({
    width: b.width || 420, height: b.height || 540, minWidth: 320, minHeight: 240,
    x: keep ? b.x : undefined, y: keep ? b.y : undefined,
    frame: false, transparent: true, resizable: true,
    hasShadow: false, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Same layer as the overlay (the panel was born INSIDE it): without this the
  // new window sits behind the overlay's always-on-top whenever they overlap.
  // macOS 'floating' for the same reason as the overlay (menu bar / 2nd tray click).
  detailsWin.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  // Same level as the overlay → whoever reasserts last stays on top: the
  // overlay's blur re-stacks it (Mutter quirk), so the details window reasserts
  // its top when it gains focus — clicking it brings it back to front.
  detailsWin.on('focus', () => { try { detailsWin.moveTop(); } catch {} });
  detailsWin.loadFile(path.join(__dirname, 'src/details.html'));
  detailsWin.webContents.once('did-finish-load', () => {
    try { pushDetails(readSessions()); } catch {}   // 1st push does not wait for the tick
  });
  detailsWin.on('resize', saveDetailsBounds);
  detailsWin.on('move', saveDetailsBounds);
  detailsWin.on('closed', () => { detailsWin = null; detailsKey = null; });
}
ipcMain.on('details-open', (_e, { key } = {}) => {
  if (!key) return;
  const existed = !!(detailsWin && !detailsWin.isDestroyed());
  detailsKey = key;
  ensureDetailsWin();
  if (existed) { try { detailsWin.moveTop(); detailsWin.focus(); pushDetails(readSessions()); } catch {} }
});
ipcMain.on('details-close', () => {
  if (detailsWin && !detailsWin.isDestroyed()) detailsWin.close();
});

// Cleanup: removes state files whose PID died (no SessionEnd — e.g. terminal
// crash/kill). process.kill(pid,0) only tests existence (not affected by ptrace).
// Also sweeps .tmp orphans (aborted atomic writes) older than 60s.
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
        // empty/corrupted (write race): has no pid for the normal reap.
        // A live session rewrites the file on the next event (hook uses try/fromjson);
        // if idle for >10min, it is dead-session garbage — remove it.
        try { if (Date.now() - fs.statSync(p).mtimeMs > 600_000) { fs.unlinkSync(p); changed = true; } } catch {}
        continue;
      }
      if (!s.pid) {
        // State without a pid (Kiro adapter legacy that became a zombie —
        // immune to process-based reap; the adapter has not written pid:null
        // since the PR-46 fix). A live session always rewrites the file (new
        // mtime); idle for >10min means dead-session garbage — remove it
        // (same semantics as the orphan .tmp).
        try { if (Date.now() - fs.statSync(p).mtimeMs > 600_000) { fs.unlinkSync(p); changed = true; } } catch {}
        continue;
      }
      try { process.kill(s.pid, 0); }         // alive? (does not throw)
      catch { try { fs.unlinkSync(p); changed = true; } catch {} }
    }
  } catch {}
  if (changed) sendSessions();
}

// ---- bounds persistence (only width + position; height is automatic) ----
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

// Applies _NET_WM_STATE_SKIP_TASKBAR + SKIP_PAGER via wmctrl on the window's
// X11 id. On Wayland wmctrl is a no-op (silent). Idempotent.
function applySkip() {
  if (!win || win.isDestroyed() || IS_WAYLAND || process.platform === 'darwin') return;
  try {
    const buf = win.getNativeWindowHandle(); // X11: little-endian XID
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
  // Clamp: if the saved position fell outside the active screens (e.g. an
  // external monitor was disconnected and the layout shrank), bring it back to
  // the primary's corner. Without this the WM may relocate the window
  // somewhere unexpected or it disappears.
  const onScreen = screen.getAllDisplays().some((d) =>
    x >= d.bounds.x && x + width <= d.bounds.x + d.bounds.width &&
    y >= d.bounds.y && y + 40 <= d.bounds.y + d.bounds.height);
  if (!onScreen) {
    x = display.workArea.x + display.workAreaSize.width - width - 12;
    y = display.workArea.y + 12;
  }

  win = new BrowserWindow({
    width, height: HEADER_H + 120, // placeholder; the renderer fixes it via auto-height
    x, y,
    // Clamp at the WM level: the gripper already limited it, but resizing via
    // the window BORDER (resizable) ignored MIN_W and let the header break.
    minWidth: MIN_W, minHeight: HEADER_H,
    frame: false,
    transparent: true,
    resizable: true,
    show: process.platform !== 'darwin', // darwin: born hidden (1st tray click REVEALS);
                               // Linux/Windows: born visible as in origin/main
    skipTaskbar: true,       // out of the taskbar and alt-tab (SKIP_TASKBAR/PAGER)
    maximizable: false,      // (not implemented on Linux; holds on the other platforms)
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
  // macOS: 'screen-saver' (NSScreenSaverWindowLevel=1000) covers EVEN the menu
  // bar (level 24) — the overlay in the top-right corner would cover the tray
  // icons and the 2nd click ("hide") would never reach it. 'floating' stays
  // above ordinary windows, but below the menu bar. Linux keeps 'screen-saver' (X11).
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  // macOS/Space: without this the overlay lives in a single Space — clicking
  // the tray (or the reveal) while in ANOTHER Space showed nothing (the window
  // exists, but outside the current Space). visibleOnAllWorkspaces makes the
  // window belong to every Space, so show() appears in the Space in use.
  // Trade-off: it also shows over fullscreen apps — acceptable for an overlay.
  if (process.platform === 'darwin') {
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  }
  // Linux/Mutter ignores `maximizable` → instantly reverts any maximize
  // (Super+↑, drag to the screen top, tiling). The overlay never goes fullscreen.
  win.on('maximize', () => { try { win.unmaximize(); } catch {} });
  // Mutter/XWayland: the _NET_WM_STATE_ABOVE state flickers on focus loss (see
  // CHANGELOG 0.6.7) — clicking another window/the desktop drops always-on-top
  // without going through toggleWin/revealIfHidden. Reasserts on blur, the same
  // way the toggle/reveal already does (setAlwaysOnTop + moveTop).
  // macOS: NSWindow.Level does not degrade on blur (persistent property, no X11
  // quirk). Reasserting moveTop() here would re-show the window after the
  // tray-toggle hide() (blur fires on hide → moveTop → overlay comes back alone).
  win.on('blur', () => {
    if (process.platform === 'darwin') return;
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
    try { win.moveTop(); } catch {}
  });
  // skipTaskbar FORCED via wmctrl: on Mutter, with frameless+transparent+
  // alwaysOnTop, neither the `skipTaskbar` option nor setSkipTaskbar() reliably
  // produces the X11 _NET_WM_STATE_SKIP_TASKBAR/PAGER hint (it is rebuilt and
  // dropped on every always-on-top call). `type: 'toolbar'` forced the hint —
  // but removed _NET_WM_ACTION_MOVE, freezing the window. wmctrl applies the
  // skip WITHOUT touching the allowed actions.
  // The IS_LINUX/X11 check guards this: on native Wayland wmctrl is a no-op.
  win.once('ready-to-show', () => { try { win.setSkipTaskbar(true); } catch {} applySkip(); });
  win.loadFile(path.join(__dirname, 'src/index.html'));
  win.webContents.on('did-finish-load', () => { sendSessions(); sendReadMarks(); });
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Renderer logging only with ATL_DEBUG=1 (debug off in production).
  win.webContents.on('console-message', (_e, level, message) => {
    if (process.env.ATL_DEBUG) {
      try { fs.appendFileSync('/tmp/atl-renderer.log', `[${level}] ${message}\n`); } catch {}
    }
  });
}

// Centralized show/hide. On show, reasserts skipTaskbar — some WMs reset the
// hint across the hide/show cycle (known Electron/X11 bug).
// The SOURCE OF TRUTH for the toggle is win.isVisible() (synchronous): if the
// window was hidden externally (Cmd+H on macOS, WM unmap), the next click
// REVEALS instead of hiding again — otherwise the overlay "disappears" for two
// clicks. There used to be a `_winState` mirror here, but once isVisible()
// started deciding, it was never read again: four writes, zero reads.

function toggleWin() {
  if (!win || win.isDestroyed()) return;

  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    try { applySkip(); } catch {}
    try { win.setSkipTaskbar(true); } catch {}
    try { win.moveTop(); } catch {}
    collectAndSendUsage({ claudeFetch: true });
  }
}

// Brings the overlay back to the screen if it is HIDDEN (hide). Does not steal
// keyboard focus — just re-applies show() + skipTaskbar (stays alwaysOnTop, out
// of the taskbar). Used by the "reveal when hidden" feature (configured under
// Notifications): fires when an agent goes red, the quota resets or there is an
// update — each only when its corresponding option is checked.
function revealIfHidden() {
  try {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      win.show();
      try { applySkip(); } catch {}
      try { win.setSkipTaskbar(true); } catch {}
      try { win.moveTop(); } catch {}
    }
  } catch { /* never crashes the flow that triggered the reveal */ }
}

// ---- tray ----
// Stable copy of the hook + registration in settings.json — the single path
// that works from source AND packaged (AppImage mounts at an ephemeral path).
function installHookFromApp() {
  try {
    const dest = hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR);
    const parts = [];
    for (const id of Object.keys(hookInstaller.TARGETS)) {
      const t = hookInstaller.TARGETS[id];
      if (!hookInstaller.available(id)) continue;      // agent not present on this machine
      const r = hookInstaller.install(id, dest);
      parts.push(`${t.label}: ${r.wrote ? T('ntf_installed', { a: r.added, u: r.updated }) : T('ntf_ok')}`);
    }
    if (hookInstaller.opencodeAvailable()) {
      hookInstaller.installOpencode(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
      parts.push('OpenCode: ' + T('ntf_plugin_ok'));
    }
    if (hookInstaller.kiroAvailable()) {
      hookInstaller.installKiro(path.join(__dirname, 'adapters/kiro/ai-traffic-lights.js'), BASE_DIR);
      kiroAdapter.start(chokidar, () => collect.invalidateDiscovery()); // invalidates the discovery cache on 1st write
      parts.push('Kiro: ' + T('ntf_plugin_ok'));
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
    // Stops the watcher whenever the user asks to remove hooks — before, anyone
    // who had never installed via the app had no copy in <BASE_DIR> (removed=0)
    // and stop() never ran: "Remove hooks" was silently a no-op.
    kiroAdapter.stop();
    if (hookInstaller.removeKiro(BASE_DIR).removed) parts.push('Kiro: ' + T('ntf_plugin_removed'));
    notifyUser(parts.length ? parts.join(' · ') : T('ntf_nothing_installed'));
  } catch (e) { notifyUser(T('ntf_remove_fail', { msg: e.message })); }
}
// notifyUser: implementation in src/ipc/tray.js (REF step 8). Stub reassigned
// at boot to trayIpc.notifyUser (DI for update/focus/launcher).
let notifyUser = () => {};
// Menu rebuildable outside createTray: the labels depend on the language, and
// changing it in Preferences re-renders the menu live (save-settings).
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: T('tray_show_hide'), accelerator: 'Ctrl+Alt+H', click: toggleWin },
    { type: 'checkbox', label: T('tray_autostart'), checked: autostartEnabled(),
      click: (it) => { setAutostart(it.checked); } },
    // Quick Launcher: submenu with each detected CLI (opens the terminal and starts it).
    ...(launcherIpc.detectLaunchers().length ? [{
      label: T('launch_section'),
      submenu: launcherIpc.detectLaunchers().map((l) => ({
        label: '+ ' + AGENTS[l.id].label,
        click: () => launcherIpc.launchAgent({ agent: l.id }),
      })),
    }] : []),
    { type: 'separator' },
    { label: T('tray_install_hooks'), click: installHookFromApp },
    { label: T('tray_remove_hooks'), click: removeHookFromApp },
    { type: 'separator' },
    { label: T('tray_preferences'), click: () => settingsIpc && settingsIpc.createSettingsWindow() },
    { label: T('tray_check_updates'), click: () => updateIpc && updateIpc.checkUpdatesManual() },
    { label: T('tray_quit'), click: () => app.quit() },
  ]);
}
// (notifyUser/setTrayLevel/createTray/tray icons + notify/set-tray-level handlers
//  moved to src/ipc/tray.js — REF step 8. buildTrayMenu stays here: it is the
//  menu composer, injected into createTray via callback.)

// ---- Preferences window (idle threshold + shortcut) ----
// (settingsWin/settingsBoundsTimer live in src/ipc/settings.js — REF step 9.
//  They were orphaned here when createSettingsWindow was extracted: the module
//  referenced them without seeing them, and opening Preferences threw
//  "ReferenceError: settingsWin is not defined" in the user's face.)
// FIXED size for the Preferences window (not resizable): locked to the tallest
// tab's height (Geral), measured on real content at 420px width.
// The shorter tabs (Integração) get empty space; none scrolls.
// useContentSize makes width/height apply to the WEB AREA (the .prefs fills it).
// 770px fits the tallest tab (Notificações: 3 sections ≈ 555px of content) with
// room to spare — header(tabs)+footer consume ~170px. The short tabs
// (Integração) get empty space; none scrolls. On short screens (768px) winH
// clamps to the work area and the tab scrolls (header/footer stay fixed).
const SETTINGS_W = 520, SETTINGS_H = 770;   // 520: 5 tabs (the 5th came with sync) do not fit in 420

// settings (loadSettingsBounds/saveSettingsBounds/createSettingsWindow): extracted to src/ipc/settings.js (REF step 9). save-settings stays (applier).
// ---- IPC ----
ipcMain.on('request-sessions', sendSessions);

ipcMain.on('set-expanded', (_e, { expanded, h } = {}) => {
  if (!win || win.isDestroyed()) return;
  // expanded = auto height (the renderer asks via auto-height); collapsed =
  // header only, or header + footer when there are launchers (h comes from the renderer).
  if (!expanded) {
    const [w] = win.getSize();
    const height = Math.round(h) || HEADER_H;
    // minimum BEFORE setSize: otherwise the WM refuses to shrink below the
    // minimum autosize left in the expanded state (the window would not shrink on collapse).
    win.setMinimumSize(MIN_W, height);
    win.setSize(w, height, false);
  } else {
    // Expanded: the user wants to SEE usage → fetch the Claude % now (lazy).
    // The 5-min cache prevents open/close spam; outside here the loop does not hit it.
    collectAndSendUsage({ claudeFetch: true });
  }
});

// Automatic height by content (n rows). Width and position preserved.
// The window MINIMUM tracks the content: you cannot drag it smaller and cut
// sessions off — the overlay always fits everything (up to the screen ceiling, where it scrolls).
ipcMain.on('auto-height', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const clamped = Math.max(MIN_H, Math.min(Math.round(h), maxOverlayH()));
  const [w] = win.getSize();
  // minimum BEFORE setSize: when shrinking, the WM honors the previous minimum
  // and would reject a setSize below it (the window would not shrink).
  win.setMinimumSize(MIN_W, clamped);
  win.setSize(w, clamped, false);
});

// Gripper: width only (height is automatic). Persists on release.
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

// Click-to-focus: activates the session's terminal ({pid, windowid}).
// ('focus' handler moved to src/ipc/focus.js — REF step 4)

// (get-aliases/set-alias handlers moved to src/ipc/aliases.js — REF step 7)

// Settings: read (Preferences), write (applies shortcut + notifies overlay),
// (get-settings/get-lang/get-version/open-external/get-repo-url handlers moved to src/ipc/settings.js — REF step 9)
ipcMain.on('save-settings', (_e, cfg) => {
  // With live-apply this fires on EVERY change in Preferences. Only redoes the
  // expensive work when the relevant value actually changed (avoids re-registering
  // the globalShortcut and rebuilding the tray on every slider-drag tick).
  const prevShortcut = settingsCfg.shortcut, prevLang = settingsCfg.lang;
  const prevChannel = settingsCfg.updateChannel;
  settingsCfg = persistSettings(cfg);
  applySync();                                                 // re-evaluates server/poller (sync)
  if (settingsCfg.shortcut !== prevShortcut) applyShortcut();   // re-registers only if the shortcut changed
  if (settingsCfg.updateChannel !== prevChannel && updateIpc) updateIpc.onChannelChanged();
  if (settingsCfg.lang !== prevLang) {                          // language only if it changed
    applyLang();
    if (trayIpc) trayIpc.refreshMenu();                          // tray labels in the new language (no-op on macOS: the menu is built on each right-click)
  }
  sendToRenderer('settings-changed', settingsCfg);
});
// ('open-settings' handler moved to src/ipc/settings.js — REF step 9)

// Multi-machine sync: reads/writes ONLY the sync sub-object (validated in persistSettings).
// Sync is a beta feature: get-sync returns null outside a beta build (the
// Preferences tab is hidden; nobody reads/writes sync in the stable build).
ipcMain.handle('get-sync', () => SYNC_AVAILABLE ? ((settingsCfg && settingsCfg.sync) || null) : null);
ipcMain.on('set-sync', (_e, syncCfg) => {
  if (!SYNC_AVAILABLE) return;
  settingsCfg = persistSettings({ sync: syncCfg });
  applySync();
  sendToRenderer('settings-changed', settingsCfg);
});
// View a session's prompt: local reads straight from disk; remote fetches /transcript from the peer.
ipcMain.handle('fetch-transcript', async (_e, { origin, key, n }) => {
  // NaN (non-numeric n coming from the renderer) would pass through
  // Math.min/max and bypass the 50 ceiling — same defensive clamp as the
  // /transcript handler in net.js.
  const p = parseInt(n || 20, 10);
  const N = Math.max(1, Math.min(50, Number.isFinite(p) ? p : 20));
  if (!origin || origin === 'local') {
    try { const tp = collect.findTranscript(key, namedConfigDirs()); return tp ? transcript.lastMessages(tp, N) : []; }
    catch { return []; }
  }
  const s = (settingsCfg && settingsCfg.sync) || {};
  const host = originToHost.get(origin);
  if (!host) return [];
  return net.fetchTranscriptFromPeer({ host, port: s.port, token: s.token, key, n: N, onlineSet });
});

// #56: "mark as read" click on the overlay. Always persists to read-marks
// (survives restart — the renderer already painted the optimistic gray at click
// time). If the session belongs to a PEER, also notifies the ORIGIN: posts the
// key rewritten into ITS namespace (rewriteKeyOrigin 'peer:1234' →
// 'local:1234') and the origin then exports readIdleSec to ALL peers in the
// next /sessions.
// The posted readAt carries NO slack: the (readAt, now) pair is self-correcting.
// readAt was anchored to the local clock by the SAME poll that anchored
// last_event_ts (both add D = latency+skew); the `localNow - now` drift computed at
// the origin removes exactly that D. The residue is the sum of the latencies
// (poll + POST), always ≥ 0 — it never pushes readAt below the origin's
// last_event_ts. Extra slack would mark as "read" an event arriving up to 2s
// AFTER the click.
ipcMain.on('mark-read', (_e, { key, readAt, origin } = {}) => {
  if (typeof key !== 'string' || !key || !(Number(readAt) > 0)) return;
  const at = Math.floor(Number(readAt));
  applyReadMarks([{ key, readAt: at }]);
  if (origin && origin !== 'local') {
    const host = originToHost.get(origin);
    const s = (settingsCfg && settingsCfg.sync) || {};
    if (host && s.enabled && s.token) {
      net.postReadToPeer({
        host, port: s.port, token: s.token,
        now: Math.floor(Date.now() / 1000),
        marks: [{ key: rewriteKeyOrigin(key, origin, 'local'), readAt: at }],
        onlineSet,   // bearer only to a host Tailscale confirms online (stale entry → no send)
      }).catch(() => {});   // fire-and-forget: a failure loses nothing (the local state is already persisted)
    }
  }
});

// Row context menu (renderer): copy key/cwd/attach command.
// 'send' (not invoke): the renderer expects no reply. Validates type and size —
// the clipboard is a global resource, the renderer must never flood it with garbage.
ipcMain.on('copy-text', (_e, text) => {
  if (typeof text !== 'string' || !text || text.length > 4096) return;
  clipboard.writeText(text);
});

// Preferences mirrors the tray: autostart + hooks. Show/hide and quit
// reuse the already-registered 'toggle-visibility' and 'quit' channels.
ipcMain.handle('get-autostart', () => autostartEnabled());
ipcMain.on('set-autostart', (_e, on) => setAutostart(!!on));
ipcMain.on('install-hooks', () => installHookFromApp());
ipcMain.on('remove-hooks', () => removeHookFromApp());

// Red notification.
// ('notify' handler moved to src/ipc/tray.js — REF step 8)

// (pick-sound-file/get-sound-bytes handlers moved to src/ipc/settings.js — REF step 9)

// Tray: show/hide, autostart, quit.
ipcMain.on('toggle-visibility', toggleWin);
// Overlay asks to come back to front (the renderer detected a transition to red).
ipcMain.on('reveal-overlay', () => { if (settingsCfg.revealOnRed) revealIfHidden(); });

// Dynamic tray: the renderer sends the worst color + count on every render.
// ('set-tray-level' handler moved to src/ipc/tray.js — REF step 8)

// Quick Launcher: list of detected agents + starts an agent in a terminal.
// (get-launchers/launch-agent handlers moved to src/ipc/launcher.js — REF step 5)
ipcMain.on('attach-remote', (_e, t) => attachRemote(t || {}));   // tmux attach (local or via peer)

// ---- multi-machine sync (P2P): server + poller, OPT-IN (phase 2) ----
// Remote peer sessions are merged in readSessions(); they arrive with `origin`
// = peer name → sessionKey (namespaced) keeps them apart from local ones.
// Idempotent: only tears down/starts the side whose wish/config changed. No
// effect with sync off (zero surface). Empty token => nothing is served (fail-safe).
let remoteSessions = new Map();   // peerHost -> sessions[] (already carrying origin)
let originToHost = new Map();     // peerNodeName -> peerHost (for remote fetch-transcript)
const livePeers = new Set();      // hosts that answered /sessions (ATL running) — the + menu only shows live ones
let syncServer = null, syncServerKey = null;
// Tears down the sync server AND the /pty shells ALREADY connected. server.close()
// alone only stops accepting new connections: turning sync off (or revoking the
// token) left an in-flight remote shell alive indefinitely — the opposite of
// what the toggle promises (PR-32 #07). closeAllPty only exists with allowAttach.
function closeSyncServer() {
  if (!syncServer) return;
  try { if (syncServer.closeAllPty) syncServer.closeAllPty(); } catch {}
  try { syncServer.close(); } catch {}
  syncServer = null; syncServerKey = null;
}
let stopPoll = null, pollKey = null;
let settingsIpc = null;   // settings window module (src/ipc/settings.js) — set at boot, read by the tray
let _kiroPrecisaInstalar = false;   // Kiro on the machine, adapter not installed
let trayIpc = null;   // tray+notify module (src/ipc/tray.js) — set at boot FIRST (provides notifyUser)
let updateIpc = null;   // auto-update module (src/ipc/update.js) — set at boot, read by the tray
let launcherIpc = null;   // launcher module (src/ipc/launcher.js) — set at boot, read by the tray
let onlineSet = null, onlineTimer = null;   // peers online per Tailscale (poller gate)
function syncNodeName() { return (settingsCfg.sync && settingsCfg.sync.node) || os.hostname() || 'local'; }
function applySync() {
  if (!SYNC_AVAILABLE) return;   // beta feature: stable/source never starts server/poller
  const s = (settingsCfg && settingsCfg.sync) || {};
  const tok = typeof s.token === 'string' ? s.token : '';
  // SERVER (share my sessions): binds to the tailnet IP
  // (detectTailnetIP) — peers reach it directly at http://<ip>:<port>; auth by
  // token + WireGuard E2E (tailscale not required). Restarts only if the config changed.
  // Shutdown goes through closeSyncServer, which also tears down the /pty
  // shells already connected (PR-32 #07).
  // bindHost IS PART of the key: while detection fails (tailscale still
  // coming up at boot), it binds to 127.0.0.1; the 30s re-check (below)
  // re-resolves and, when the 100.x appears, the key changes and the server
  // rebinds — the "next cycle" net.js promises (detectTailnetIP does not
  // cache null for that reason).
  const bindHost = process.env.ATL_SYNC_BIND || net.detectTailnetIP();
  const srvKey = (s.enabled && s.share && tok) ? `${s.port}|${tok}|${s.shareTranscripts ? 1 : 0}|${s.allowAttach ? 1 : 0}|${syncNodeName()}|${bindHost || ''}` : '';
  if (!srvKey && syncServer) { closeSyncServer(); }
  if (srvKey && srvKey !== syncServerKey) {
    if (syncServer) { closeSyncServer(); }
    try {
      syncServer = net.startServer({
        port: s.port, token: tok, nodeName: syncNodeName(), shareTranscripts: !!s.shareTranscripts, allowAttach: !!s.allowAttach, ptySpawn: createPty, bindHost,
        // Locals ANNOTATED with the Claude account (details modal on the peer) —
        // annotate is idempotent (per-pid cache) and skips remote ones. Do NOT
        // use the readSessions() wrapper here: it merges other peers' sessions,
        // and exportSession would overwrite `origin` with OUR name.
        getSessions: () => annotateClaudeAccounts(collect.readSessions()),
        getTranscript: (key, n) => {
          try { const tp = collect.findTranscript(key, namedConfigDirs()); return tp ? transcript.lastMessages(tp, n) : []; }
          catch { return []; }
        },
        onReadMarks: applyReadMarks,   // POST /read (#56): mark coming from a peer → merge+persist+push
        readAtFor: (s) => readMarksState[sessionKey(s)],   // #56: the current mark becomes readIdleSec in /sessions
      });
      syncServerKey = srvKey;
      try { console.log('[sync] server up ' + (bindHost || '127.0.0.1') + ':' + s.port + ' (' + syncNodeName() + (bindHost ? '' : ' — localhost só, sem tailscale?') + ')'); } catch {}
    } catch (e) { try { console.log('[sync] server falhou: ' + e.message); } catch {} syncServer = null; syncServerKey = null; }
  }
  // CLIENT (watch peers): polls /sessions every 5s.
  const pKey = (s.enabled && Array.isArray(s.peers) && s.peers.length && tok) ? `${s.port}|${tok}|${s.peers.map((p) => p.host).join(',')}` : '';
  if (!pKey && stopPoll) { stopPoll(); stopPoll = null; pollKey = null; clearInterval(onlineTimer); onlineTimer = null; remoteSessions.clear(); livePeers.clear(); sendSessions(); }
  if (pKey && pKey !== pollKey) {
    if (stopPoll) { stopPoll(); }
    // The peer LIST changed (someone joined or LEFT). Without this cleanup, a
    // removed peer's sessions stayed in remoteSessions forever: last_event_ts
    // never advances, the session escalates to red and fires a false alert —
    // the ghost via the REMOVAL path (same symptom as PR-32 #10, whose fix
    // covered peer drop and sync shutdown, but not list editing).
    remoteSessions.clear(); originToHost.clear(); livePeers.clear(); sendSessions();
    // Tailscale gate: only tries the network on peers Tailscale reports online.
    // Set refreshed every 10s (cheap, local); null => no tailscale => no gate (falls back to backoff).
    onlineSet = net.tailscaleOnlineSet();
    clearInterval(onlineTimer);
    onlineTimer = setInterval(() => { onlineSet = net.tailscaleOnlineSet(); }, 10000);
    stopPoll = net.pollPeers({
      peers: s.peers, port: s.port, token: tok,
      isOnline: (h) => net.peerOnline(onlineSet, h),   // PR-32 #16: matches short hostname / FQDN / host:port / IP
      onSessions: (host, sessions) => {
        remoteSessions.set(host, sessions);
        livePeers.add(host);   // ATL running on the peer → enables it in the + menu of termWin
        for (const s of sessions) if (s && s.origin) originToHost.set(s.origin, host); // for remote fetch-transcript
        // #56: a read marked AT THE ORIGIN (a click there, or a POST /read
        // from a 3rd party) arrives as readIdleSec — a relative age on the
        // PEER's clock. Re-anchors it to the LOCAL clock (now - readIdleSec),
        // the SAME pattern as the anchorRemote that rewrote these sessions'
        // last_event_ts: the state machine's `last_event_ts <= readAt`
        // comparison then runs between two timestamps of the SAME clock. Key
        // in the RECEIVER's namespace (sessionKey → 'peer:<pid>'), just like
        // the optimistic mark from a local click.
        const nowS = Math.floor(Date.now() / 1000);
        const marks = [];
        for (const s of sessions) {
          if (!s || s.readIdleSec == null) continue;
          const k = sessionKey(s);
          const at = nowS - Math.max(0, s.readIdleSec | 0);
          delete s.readIdleSec;   // consumed here: does not leak to the renderer
          if (k && at > 0) marks.push({ key: k, readAt: at });
        }
        if (marks.length) applyReadMarks(marks);
        sendSessions();
        // Peer mark re-seeding (#56 review finding): the renderer PRUNES the
        // marks of sessions that left the list (peer dropped →
        // remoteSessions.delete → render → liveKeys without the key). On
        // reconnect the re-anchored mark arrives EQUAL to the persisted one —
        // LWW skips it, `applied` comes back empty and nothing was pushed: the
        // session went red again despite being read (the full state only
        // re-arrived at did-finish-load). Re-sends the CURRENT state of the
        // live keys AFTER the session push — the render receiving the sessions
        // would run the prune first if the mark arrived before. The renderer's
        // handler is LWW-idempotent: an up-to-date key does not re-render, a
        // pruned key gets its gray back.
        const reseed = readMarksLib.reseedMarks(
          readMarksState,
          sessions.map((s) => (s ? sessionKey(s) : '')).filter(Boolean),
        );
        if (Object.keys(reseed).length) sendToRenderer('read-marks', reseed);
      },
      // Peer dropped → DISCARD its sessions. Before, it only left livePeers
      // (termWin menu) and remoteSessions stayed intact: the dead peer's
      // sessions stayed in the list indefinitely, with idle growing — they
      // became ghosts that escalate to red and fire false alerts.
      // remoteSessions was only cleaned in the global sync teardown (PR-32
      // #10; the previous fix covered only turning sync off, not a peer drop).
      onPeerState: (host, online) => {
        try { console.log('[sync] peer ' + host + ' ' + (online ? 'online' : 'offline (backoff)')); } catch {}
        if (online) { livePeers.add(host); return; }
        livePeers.delete(host);
        if (remoteSessions.delete(host)) sendSessions();   // gone from the list immediately
      },
    });
    pollKey = pKey;
  }
}

// Sync re-check every 30s (idempotent: each piece only touches state when the
// key changes). This is the cycle that makes the tailnet rebind real: at boot
// with Tailscale still coming up, the server sits on 127.0.0.1; here it
// re-resolves the IP and the srvKey — which includes bindHost — changes,
// rebinding on the 100.x.
setInterval(() => {
  try { if (settingsCfg && settingsCfg.sync && settingsCfg.sync.enabled) applySync(); } catch {}
}, 30000);

// ---- Terminal window (tabs) — separate from the overlay, maximizable ----
// The overlay NO LONGER hosts the terminal: the pty/ws state lives here
// (termSessions Map) and the renderer (src/term.html) only draws tabs + xterm,
// talking over IPC (tabId). This keeps the overlay light (does not grow, does
// not block clicks).
let ptyLib = null;
// Guaranteed PATH for the pty: electron/Chromium on Linux can inherit a
// restricted PATH (no /usr/bin) → tmux/bash not found → the tmux auto-wrap
// failed silently. Appends the base dirs at the end (does not overwrite what is already there).
function ptyEnv() {
  const env = Object.assign({}, process.env);
  const cur = String(env.PATH || '').split(':').filter(Boolean);
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) if (!cur.includes(d)) cur.push(d);
  env.PATH = cur.join(':');
  return env;
}
// true if the bin exists in main's PATH OR in the base dirs (robust fallback to scanPathBin).
function hasBin(bin) {
  if (scanPathBin(bin)) return true;
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) { try { if (fs.existsSync(d + '/' + bin)) return true; } catch {} }
  return false;
}
function ptyEnsure() { if (!ptyLib) { try { ptyLib = require('node-pty'); } catch (e) { try { console.log('[pty] node-pty indisponível: ' + e.message); } catch {} } } return ptyLib; }
// Factory for the /pty SERVER (DI in net.startServer): 1 node-pty per remote
// connection (a peer attaching to ME). Returns a handle {write,resize,pause,resume,kill}.
function createPty(cmd, cols, rows, { onData, onExit }) {
  const p = ptyEnsure(); if (!p) throw new Error('node-pty indisponível');
  const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: process.env.HOME, env: ptyEnv() });
  proc.onData(onData); proc.onExit(onExit);
  return {
    write: (d) => { try { proc.write(d); } catch {} },
    resize: (c, r) => { try { proc.resize(c, r); } catch {} },
    pause: () => { try { proc.pause(); } catch {} },
    resume: () => { try { proc.resume(); } catch {} },
    kill: () => { try { proc.kill(); } catch {} },
  };
}

let termWin = null;
const termSessions = new Map();   // tabId -> { title, kind, origin, tmux_session, proc, ws, cols, rows }
let tabSeq = 0;
let termWinReady = false;         // has term.html loaded? Queue of IPCs until did-finish-load — avoids losing term-tab-added/pty-out on the 1st open (the window came up empty).
const termQueue = [];
// termWin must be VISIBLE and STABLE (WM mapped) when the renderer creates the
// xterm (term.open). Opening the xterm during the hide→show transition (X11
// frameless remaps asynchronously) leaves the render broken: the tab came up
// black and not even resize recovered it. main only delivers term-tab-added
// when the window is stable; until then it holds it here.
// (document.hidden in the renderer does not detect BrowserWindow hide/show —
// hence the control lives here, where isVisible() is reliable.)
let termWinStable = false;
const pendingTermTabs = [];
function flushPendingTermTabs() {
  termWinStable = true;
  if (!termWinReady || !termWin || termWin.isDestroyed()) return;
  for (const p of pendingTermTabs.splice(0)) { try { termWin.webContents.send('term-tab-added', p); } catch {} }
}
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
  if (!termWin || termWin.isDestroyed() || termWin.isMaximized()) return;   // does not persist maximized (otherwise it reopens at screen size without being max)
  clearTimeout(termBoundsTimer);
  termBoundsTimer = setTimeout(() => {
    try {
      const b = termWin.getBounds();
      fs.writeFileSync(TERM_BOUNDS_FILE, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    } catch {}
  }, 300);
}
// Re-shows the Terminal window after a hide(). On Linux/X11 a
// `frame:false` + `transparent:true` window often gets stuck in
// WM_STATE=Withdrawn: Electron's show() requests mapping, but the WM ignores
// it and the window vanishes from the window list — the app seemed "not to
// reopen", or to reopen empty, when in fact the content was intact and it was
// the WINDOW that never came back. showInactive()+show() forces the remap;
// restore() covers the case of it having been minimized before hiding.
function revealTermWin() {
  if (!termWin || termWin.isDestroyed()) return;
  try {
    termWinStable = false;   // hide→show transition: do not create xterms until the WM maps
    if (termWin.isMinimized()) termWin.restore();
    termWin.showInactive();
    termWin.show();
    termWin.moveTop();
    termWin.focus();
    // Reopening termWin (hide→show): the WM on X11 frameless+transparent
    // remaps the window ASYNCHRONOUSLY. Creating/repainting the xterm before
    // the remap leaves the canvas black. With the delay the WM has already
    // mapped → the window is STABLE: release the queued term-tab-added events
    // and tell the renderer to repaint.
    setTimeout(() => {
      if (!termWin || termWin.isDestroyed() || !termWin.isVisible()) return;
      flushPendingTermTabs();
      sendTerm('term-shown');
    }, 120);
  } catch {}
}

function ensureTermWin() {
  if (termWin && !termWin.isDestroyed()) { revealTermWin(); return termWin; }
  const wa = screen.getPrimaryDisplay().workArea;
  const b = loadTermBounds();
  const w = (b && b.width) || Math.min(960, Math.max(640, Math.round(wa.width * 0.6)));
  const h = (b && b.height) || Math.min(680, Math.max(380, Math.round(wa.height * 0.7)));
  // Validates the saved position against ALL screens, not just the primary:
  // in a multi-monitor setup a window moved to the left monitor (smaller x) or
  // the right one (x beyond the primary's width) had its position silently
  // DISCARDED on every reopen, nullifying the persist (PR-32 #19). Off any
  // screen (monitor disconnected) → undefined, and Electron centers on the primary.
  const keep = boundsOnScreen(b, screen.getAllDisplays());
  const x = keep ? b.x : undefined;
  const y = keep ? b.y : undefined;
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
    sendTerm('term-maximized', !!termWin.isMaximized());   // initial state: the renderer drops the radius when maximized
    flushPendingTermTabs();   // 1st load: window is born visible/stable → release held tabs
  });
  // Window reappeared (show from ensureTermWin, WM restore): the renderer needs
  // to REPAINT the xterm — while hidden the canvas was discarded but the buffer
  // was not. Without this the tab reopens blank with tmux alive on the other side.
  termWin.on('restore', () => sendTerm('term-shown'));
  // (re)showing termWin (× = hide → clicking again = show): the xterm canvas is
  // discarded while the window is hidden and the renderer needs to repaint.
  // On Linux/X11 visibilitychange is unreliable for BrowserWindow hide/show,
  // so we notify via main's channel (same as restore) — without this the tab
  // would reopen blank, with tmux/pty alive on the other side.
  termWin.on('show', () => sendTerm('term-shown'));
  termWin.on('maximize', () => sendTerm('term-maximized', true));
  termWin.on('unmaximize', () => sendTerm('term-maximized', false));
  termWin.on('resize', saveTermBounds);   // persists size/position (debounced; skipped when maximized)
  termWin.on('move', saveTermBounds);
  // Closing the window (Alt+F4, WM X, tray "Quit") KILLS the ptys/WS before
  // clearing the Map. Without this, clear() erased the references and will-quit
  // had nothing left to kill → leaked one node-pty + tmux per tab, on every
  // open/close (PR-32 #08).
  termWin.on('closed', () => {
    for (const id of [...termSessions.keys()]) destroyTermSession(id);
    termWin = null; termWinReady = false; termWinStable = false; termQueue.length = 0; pendingTermTabs.length = 0; termSessions.clear();
  });
  return termWin;
}
function destroyTermSession(tabId) {
  const s = termSessions.get(tabId); if (!s) return;
  try { if (s.proc) s.proc.kill(); } catch {}
  if (s.ws) { try { s.ws.close(); } catch {} }
  termSessions.delete(tabId);
}
function addTermSession({ title, kind, origin, tmux_session, sessionKey, label, cwd }) {
  const tabId = ++tabSeq;
  // label/cwd are stored to REBUILD the title when the alias is removed
  // (rename to empty) — without them the tab would fall back to 'tmux: <session>'.
  const ownerId = termWin && !termWin.isDestroyed() ? termWin.webContents.id : null;
  termSessions.set(tabId, { title, kind, origin, tmux_session, sessionKey: sessionKey || null, label: label || null, cwd: cwd || null, ownerId, proc: null, ws: null, cols: 80, rows: 24 });
  // Only delivers term-tab-added with termWin STABLE; creating the xterm
  // earlier (during the hide→show transition) breaks the render. The renderer
  // buffers any pty-out arriving before (no term exists there yet).
  if (termWinStable && termWinReady) sendTerm('term-tab-added', { tabId, title });
  else pendingTermTabs.push({ tabId, title });
  return tabId;
}
function closeTermSession(tabId) {
  destroyTermSession(tabId);
  sendTerm('term-tab-removed', { tabId });
  if (!termSessions.size && termWin && !termWin.isDestroyed()) {
    // CLOSE (not hide) termWin when it empties. A REUSED termWin
    // (hide→show) does not go back to rendering a reopened tab's xterm (stays
    // black, even with ws sending output and write being called) — only a NEW
    // window, created on the next attach via did-finish-load, renders correctly
    // (it is the 1st-tab path, which always worked). close discards the page;
    // ensureTermWin recreates a fresh one.
    try { termWin.close(); } catch {}
  }
}
// Spawns a local node-pty for a tab (new shell or local tmux attach).
function spawnPtyLocal(tabId, cmd, cwd) {
  const p = ptyEnsure(); const s = termSessions.get(tabId);
  if (!p || !s) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mnode-pty indisponível\x1b[0m\r\n' }); return; }
  try { console.log('[term] spawn tabId=' + tabId + ' cmd=' + JSON.stringify(cmd));
    const proc = p.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: s.cols, rows: s.rows, cwd: cwd || process.env.HOME, env: ptyEnv() });
    proc.onData((d) => sendTerm('pty-out', { tabId, data: d }));
    // Nulls s.proc on exit: without this the tab keeps a reference to a DEAD
    // process and the "connection dropped" test (!ws && !proc) never fires —
    // the revive never happened and the tab reopened empty.
    proc.onExit(() => { const cur = termSessions.get(tabId); if (cur && cur.proc === proc) cur.proc = null; sendTerm('pty-exit', { tabId }); });
    s.proc = proc;
    // same reason as remote: the spawn used s.cols/s.rows; a re-fit picks up the real size.
    sendTerm('term-refit', { tabId });
  } catch (e) { console.log('[term] spawn FAIL tabId=' + tabId + ': ' + (e.message || e)); sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m' + (e.message || e) + '\x1b[0m\r\n' }); }
}
// WebSocket client for the remote /pty of a tab (live attach on the peer).
function openRemotePty(tabId, { host, port, token, tmux_session }) {
  const s = termSessions.get(tabId); if (!s) return;
  const authority = net.peerAuthority(host, port || 47474);
  if (!authority || !net.peerOnline(onlineSet, host)) {
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mpeer não confirmado pelo Tailscale\x1b[0m\r\n' });
    return;
  }
  const url = 'ws://' + authority + '/pty';
  let ws;
  try { ws = new (require('ws'))(url, { headers: { Authorization: 'Bearer ' + token } }); } catch (e) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31mWebSocket falhou: ' + e.message + '\x1b[0m\r\n' }); return; }
  s.ws = ws;
  ws.on('open', () => {
    try { ws.send(JSON.stringify({ type: 'start', tmux_session, cols: s.cols, rows: s.rows })); } catch {}
    // the `start` uses s.cols/s.rows (possibly stale). Asks the renderer for
    // the window's REAL size and re-sends → the remote tmux draws at the right size.
    sendTerm('term-refit', { tabId });
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'out') sendTerm('pty-out', { tabId, data: m.data });
    else if (m.type === 'exit') sendTerm('pty-exit', { tabId });
    else if (m.type === 'error') sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + m.msg + '\x1b[0m\r\n' });
  });
  ws.on('error', (e) => sendTerm('pty-out', { tabId, data: '\r\n\x1b[31m[remoto] ' + (e.message || 'erro de conexão') + '\x1b[0m\r\n' }));
  // Connection drop (peer sleeps, wifi falls, sync turned off on the other
  // side) is the MOST common failure mode and does not emit 'error' — only
  // 'close'. Unhandled, the tab became "haunted": it looked alive, did not
  // respond, with no warning (PR-32 #17). Notifies and ends the tab, like the
  // end of a local pty.
  ws.on('close', () => {
    const cur = termSessions.get(tabId);
    if (!cur || cur.ws !== ws) return;   // tab already closed/reconnected — do not pollute the new one
    cur.ws = null;
    sendTerm('pty-out', { tabId, data: '\r\n\x1b[33m[remoto] conexão encerrada\x1b[0m\r\n' });
    sendTerm('pty-exit', { tabId });
  });
}
// ---- Terminal window IPC handlers (tabs) ----
function isTermSender(e) {
  return !!(e && termWin && !termWin.isDestroyed() && e.sender === termWin.webContents);
}
function termSessionFor(e, tabId) {
  if (!isTermSender(e)) return null;
  const s = termSessions.get(tabId);
  return s && s.ownerId === e.sender.id ? s : null;
}
ipcMain.on('term-new-shell', (e, host) => {
  if (!isTermSender(e)) return;
  const local = host === undefined || host === 'local';
  const cfg = (settingsCfg && settingsCfg.sync) || {};
  const peer = !local && typeof host === 'string' && Array.isArray(cfg.peers)
    ? cfg.peers.find((p) => p && p.host === host && livePeers.has(p.host) && net.peerOnline(onlineSet, p.host))
    : null;
  if (!local && !peer) return;
  if (!local) {            // new shell on a remote peer (via /pty, no tmux_session)
    const tabId = addTermSession({ title: host + ' · shell', kind: 'remote', origin: host });
    if (!cfg.token) { sendTerm('pty-out', { tabId, data: '\r\n\x1b[31msem token sync configurado\x1b[0m\r\n' }); return; }
    openRemotePty(tabId, { host, port: cfg.port, token: cfg.token });   // no tmux_session → new shell on the peer
  } else {
    const tabId = addTermSession({ title: 'shell', kind: 'local' });
    const hasTmux = hasBin('tmux');
    const cmd = hasTmux ? launcher.tmuxWrap([process.env.SHELL || 'bash'], launcher.tmuxSessionName('shell') + '-' + Date.now().toString(36)) : [process.env.SHELL || 'bash'];
    spawnPtyLocal(tabId, cmd, process.env.HOME);
  }
});
ipcMain.handle('term-hosts', (e) => {
  if (!isTermSender(e)) return [];
  const peers = ((settingsCfg && settingsCfg.sync) || {}).peers || [];
  const live = peers.filter((p) => livePeers.has(p.host) && net.peerOnline(onlineSet, p.host));
  return [{ id: 'local', label: 'local' }, ...live.map((p) => ({ id: p.host, label: p.name || p.host }))];
});
ipcMain.on('term-win-control', (e, op) => {   // custom frameless chrome: min/max/close
  if (!isTermSender(e)) return;
  try {
    if (op === 'min') termWin.minimize();
    else if (op === 'max') termWin.isMaximized() ? termWin.unmaximize() : termWin.maximize();
    else if (op === 'close') termWin.hide();
  } catch {}
});
// ---- resize via grip (frameless+transparent has no native resize on Linux) ----
let termResizeStart = null;
ipcMain.on('resize-term-start', (e) => { if (isTermSender(e)) termResizeStart = termWin.getSize(); });
ipcMain.on('resize-term-move', (e, p) => {
  if (!isTermSender(e) || !termResizeStart || !p || !Number.isFinite(p.dw) || !Number.isFinite(p.dh)) return;
  const { dw, dh } = p;
  try { termWin.setSize(Math.max(560, Math.round(termResizeStart[0] + dw)), Math.max(320, Math.round(termResizeStart[1] + dh)), false); } catch {}
});
ipcMain.on('resize-term-end', (e) => { if (isTermSender(e)) termResizeStart = null; });
// Activation is visual in the renderer (routing is by tabId, which comes with
// input/resize), but we use it to RECONNECT the tab if its connection has died —
// whoever clicks an empty tab wants the content back, and without this the only
// path was closing and reopening from the list.
ipcMain.on('term-switch-tab', (e, tabId) => {
  const s = termSessionFor(e, tabId);
  if (s && !s.ws && !s.proc) reviveTermSession(tabId, s);
});
ipcMain.on('term-close-tab', (e, tabId) => { if (termSessionFor(e, tabId)) closeTermSession(tabId); });
ipcMain.on('term-input', (e, p) => {
  if (!p || typeof p.data !== 'string') return;
  const { tabId, data } = p;
  const s = termSessionFor(e, tabId); if (!s) return;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'in', data })); } catch {} }
  else if (s.proc) { try { s.proc.write(data); } catch {} }
});
ipcMain.on('term-resize', (e, p) => {
  if (!p || !Number.isInteger(p.cols) || !Number.isInteger(p.rows) || p.cols < 1 || p.rows < 1) return;
  const { tabId, cols, rows } = p;
  const s = termSessionFor(e, tabId); if (!s) return;
  if (cols > 0) s.cols = cols;
  if (rows > 0) s.rows = rows;
  if (s.ws) { try { s.ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {} }
  else if (s.proc) { try { s.proc.resize(cols, rows); } catch {} }
});

app.whenReady().then(() => {
  // No application menu: Electron's default menu registers global accelerators
  // (Ctrl+W closes the window, Ctrl+R reloads the renderer, Ctrl+Q kills the
  // app) that are ORDINARY keys inside a shell in the Terminal window — typing
  // them destroyed the window/session. autoHideMenuBar only HIDES the bar, the
  // accelerators stay active; removing the menu is what disables them (PR-32 #15).
  // NOT on macOS: there the menu belongs to the system and carries Cmd+C/V/Q/W —
  // removing it would break pasting into the Preferences token field (Cmd+W/R/Q
  // also do not collide with the shell, which uses Ctrl).
  if (process.platform !== 'darwin') { try { Menu.setApplicationMenu(null); } catch {} }
  migrateOldBase();                              // claude-traffic-light era data
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  // keeps the stable hook copy up to date (settings.json points to it)
  try { hookInstaller.syncHookCopy(path.join(__dirname, 'hooks/traffic-hook.sh'), BASE_DIR); } catch {}
  // same for the OpenCode plugin (only if the user already installed it)
  hookInstaller.syncOpencodeIfInstalled(path.join(__dirname, 'adapters/opencode/ai-traffic-lights.js'));
  // same for the Kiro adapter (watcher of ~/.kiro/sessions/cli/)
  hookInstaller.syncKiroIfInstalled(path.join(__dirname, 'adapters/kiro/ai-traffic-lights.js'), BASE_DIR);
  settingsCfg = loadSettings();                      // user threshold/shortcut/language
  applyLang();                                       // Preferences (lang) > system locale
  createWindow();
  // Kiro watcher AFTER the window: its bootstrap() is synchronous (readdir +
  // stat + tail read of each live session) and before createWindow it delayed
  // the overlay from appearing, to no benefit — the watcher does not need to
  // precede the UI.
  // The Kiro watcher requires BOTH: Kiro existing on the machine AND the
  // adapter having been installed (the copy in BASE_DIR). Before, the first
  // alone was enough, so "Remove hooks" turned nothing off — the watcher came
  // back on the next launch, with no opt-out at all (finding 11 of the
  // PR #46 review). As a bonus, the copy stops being dead weight: it IS the
  // marker for "the user opted into this", just like the OpenCode plugin.
  if (hookInstaller.kiroAvailable() && hookInstaller.kiroInstalled(BASE_DIR)) {
    kiroAdapter.start(chokidar, () => collect.invalidateDiscovery());
  } else if (hookInstaller.kiroAvailable()) {
    _kiroPrecisaInstalar = true;   // notified later, once notifyUser exists
  }
  applyShortcut();                                   // uses settingsCfg.shortcut (+ legacy)
  if (collect.backfillModels(namedConfigDirs())) sendSessions(); // fills in model on existing sessions right away (named profiles included)
  _stateWatcher = chokidar
    .watch(STATE_DIR, { ignoreInitial: false, awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 } })
    .on('all', () => sendSessions());
  reapDead();
  _sessionInterval = setInterval(() => { collect.invalidateDiscovery(); reapDead(); sendSessions(); saveBounds(); }, 5000); // discovers new + cleans dead + captures position (e.g. external drag)
  // Agent usage/reset: GLM (network, 30s cache) + Codex/Antigravity (disk).
  // Own cadence (60s) — decoupled from the sessions (which refresh every 5s).
  // Claude is LAZY: the background loop does NOT hit its API (aggregate 429
  // limit); only boot and UI triggers (open/reveal overlay, ⟳) fetch the %.
  trayIpc = require('./src/ipc/tray').setupTrayIpc({   // tray extracted (REF step 8) — FIRST: notifyUser for collectAndSendUsage and the rest
    ipcMain, APP_VERSION, toggleWin, assetsDir: path.join(__dirname, 'assets'),
    buildMenu: () => buildTrayMenu(),   // composer (main): launcherIpc/updateIpc refs resolved only at call time (createTray)
  });
  notifyUser = trayIpc.notifyUser;   // alias for update/focus/launcher (received via DI)

  // Kiro migration notice: ONLY HERE, because until the line above `notifyUser`
  // is main.js's no-op — calling it earlier swallowed the notification in
  // silence, and the marker written before the call meant it would never be
  // attempted again. A notice created to prevent a silent regression was,
  // itself, silent. Marks only after the notification actually went out.
  if (_kiroPrecisaInstalar) {
    try {
      const marca = path.join(BASE_DIR, '.kiro-aviso-instalar');
      if (!fs.existsSync(marca)) {
        notifyUser(T('ntf_kiro_needs_install'));
        fs.mkdirSync(BASE_DIR, { recursive: true });
        fs.writeFileSync(marca, String(Date.now()));
      }
    } catch {}
  }
  collectAndSendUsage({ claudeFetch: true });    // boot: 1 call to have the % right away (notifyUser already resolved)
  _usageInterval = setInterval(collectAndSendUsage, 60 * 1000);   // background: claudeFetch=false (does not hit it)
  updateIpc = require('./src/ipc/update').setupUpdateIpc({   // auto-update extracted (REF step 1)
    getMainWindow: () => win, getSettings: () => settingsCfg,
    T, revealIfHidden, REPO_URL, APP_VERSION, AUTOSTART_FILE,
  });
  require('./src/ipc/aliases').setupAliasesIpc({   // aliases extracted (REF step 7)
    ipcMain, ALIASES_FILE, sendSessions,
    onAliasSaved: (key, alias) => {   // updates the Terminal tab title (alias is the tab name)
      for (const [id, s] of termSessions) {
        if (s.sessionKey === key) {
          const t = termTabTitle({ alias, label: s.label, cwd: s.cwd, tmux_session: s.tmux_session, origin: s.origin, isLocal: s.kind === 'local' });
          s.title = t; sendTerm('term-tab-title', { tabId: id, title: t });
        }
      }
    },
  });
  require('./src/ipc/account-labels').setupAccountLabelsIpc({   // multi-account #58
    ipcMain, ACCOUNT_LABELS_FILE,
    getLastAccountIds: () => lastAccountIds,
    recollect: () => collectAndSendUsage({ claudeFetch: false }),
  });
  require('./src/ipc/focus').setupFocusIpc({   // focus extracted (REF step 4)
    ipcMain, getProcessEnviron, notifyUser, T, IS_WAYLAND,
  });
  launcherIpc = require('./src/ipc/launcher').setupLauncherIpc({   // launcher extracted (REF step 5)
    ipcMain, getSettings: () => settingsCfg, notifyUser, T, scanPathBin, hasBin, lastSessionCwd,
    ensureTermWin, addTermSession, spawnPtyLocal,
  });
  settingsIpc = require('./src/ipc/settings').setupSettingsIpc({   // settings extracted (REF step 9) — before createTray (tray references createSettingsWindow)
    ipcMain, getSettings: () => settingsCfg, getLang: () => LANG, T, APP_VERSION, REPO_URL,
    SETTINGS_BOUNDS_FILE, BASE_DIR, appDir: __dirname, SETTINGS_W, SETTINGS_H,
  });
  trayIpc.createTray();   // AFTER launcherIpc/updateIpc/settingsIpc: buildTrayMenu references them
  applySync();                                   // P2P sync: starts server/poller if enabled
});

// References for shutdown cleanup.
let _stateWatcher = null;
let _sessionInterval = null;
let _usageInterval = null;

app.on('window-all-closed', () => app.quit());
// macOS: reopen on clicking the app icon (makes sense in dev runs — in the
// packaged build LSUIElement removes the Dock icon; here it is a reveal, not a toggle).
app.on('activate', () => { if (win && !win.isDestroyed()) revealIfHidden(); });
app.on('will-quit', () => {
  for (const id of [...termSessions.keys()]) destroyTermSession(id);
  globalShortcut.unregisterAll();
  if (_sessionInterval) clearInterval(_sessionInterval);
  if (_usageInterval) clearInterval(_usageInterval);
  if (_stateWatcher) _stateWatcher.close().catch(() => {});
  kiroAdapter.stop();
});

// ---- agent usage/reset (Claude via ~/.claude.json, GLM via API) ----
// Async collector (GLM hits the network → never blocks the 5s session cycle).
// On error, keeps the last valid usage (the UI does not flicker on every failure).
//
// Persistence: the last known usage is written to usage.json and reloaded at
// boot — survives restart. The rows come back with the old fetchedAt, so
// mergeUsage already marks them stale (gray) right away; they either refresh
// (turn live color) or disappear after USAGE_DROP_MS. Never shows an old
// number as if it were current.
// Safe on disk: the usage object is only {plan,%,reset,...} — contains NO tokens.
function loadUsage() {
  try {
    const arr = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    // discards anything past the drop ceiling (does not resurrect old garbage).
    const now = Date.now();
    return arr.filter((e) => e && e.id && (now - (e.fetchedAt || 0)) < usage.USAGE_DROP_MS)
      .map((e) => ({ ...e, stale: true })); // always enters as stale until refreshed
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

// Claude usage-API 429 cooldown, PERSISTED to disk (with the failure counter
// for exponential backoff). Without this, running in dev (`bun start`/
// restarts) loses the state on every restart, hits again at boot and
// RE-ESCALATES the rate limit. Writes only {until, fails} per account — NEVER
// the token. Never throws.
function saveClaudeCooldown(key, { until, fails } = {}) {
  if (!key) return;
  claudeCooldowns[key] = { until: until || 0, fails: fails || 0 };
  // only live entries on disk — the file does not grow with dead accounts
  const live = {};
  for (const [k, v] of Object.entries(claudeCooldowns)) {
    if (v && v.until > Date.now()) live[k] = v;
  }
  try { fs.writeFileSync(CLAUDE_COOLDOWN_FILE, JSON.stringify(live)); } catch { /* ignore */ }
}
// Format: { "<accountKey>": { until, fails } } — PER-ACCOUNT cooldown (a 429
// on one account does not silence the others). Accepts the legacy root-level
// { until, fails } (global) as a 'default' entry so the live window is not
// lost on upgrade.
function loadClaudeCooldown() {
  let o;
  try { o = JSON.parse(fs.readFileSync(CLAUDE_COOLDOWN_FILE, 'utf8')); } catch { return {}; }
  if (!o || typeof o !== 'object') return {};
  if (typeof o.until === 'number' && o.until > Date.now()) {
    return { default: { until: o.until, fails: (typeof o.fails === 'number' && o.fails > 0) ? o.fails : 0 } };
  }
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v.until === 'number' && v.until > Date.now()) {
      out[k] = { until: v.until, fails: (typeof v.fails === 'number' && v.fails > 0) ? v.fails : 0 };
    }
  }
  return out;
}
const claudeCooldowns = loadClaudeCooldown();
// for the UI (⟳ tooltip): the LARGEST live cooldown across accounts
function activeCooldownMeta() {
  let best = { until: 0, fails: 0 };
  for (const c of Object.values(claudeCooldowns)) {
    if (c && c.until > Date.now() && c.until > best.until) best = c;
  }
  return best;
}

// GLM credentials live in EACH TERMINAL'S ENVIRONMENT (the user has
// Claude/Anthropic terminals and Claude/GLM — z.ai terminals), possibly with
// DIFFERENT z.ai accounts in different terminals. They are not in a dotfile or
// global. Strategy: sweep ALL live sessions whose model is GLM and read
// ANTHROPIC_BASE_URL/AUTH_TOKEN from each one's /proc/<pid>/environ. Dedup by
// token (same account in N terminals → 1 block). Each distinct credential
// becomes one entry; collectUsage fetches each one's usage with its own
// credential.
// Zero tokens on disk. No GLM session → empty list → row with Claude only.
function crypto_() { return require('crypto'); }
function glmCredsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const byToken = new Map(); // token → { env, label, suffix }
  for (const s of sessions) {
    // LOCAL session only: a remote session's pid is a process on the PEER —
    // probing it in the local /proc can collide with an unrelated local
    // process that has the GLM envs and fabricate a ghost credential
    // (review fix #7).
    if (!isLocalSession(s) || !s.pid || !/^glm/i.test(s.model || '')) continue;
    let env;
    try {
      const raw = getProcessEnviron(s.pid);
      env = usage.parseEnviron(raw, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
    } catch { continue; } // process died between readSessions and this read
    if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
    const token = env.ANTHROPIC_AUTH_TOKEN;
    if (byToken.has(token)) continue;      // same account already collected
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = String(byToken.size + 1); }
    // account label = endpoint host (z.ai / bigmodel) — distinguishes providers
    let label = '';
    try { label = new URL(env.ANTHROPIC_BASE_URL).host.replace(/^api\./, ''); } catch { /* invalid base */ }
    byToken.set(token, { env, label, suffix });
  }
  return [...byToken.values()];
}

// FALLBACK: the Claude Code MAIN process sometimes does not inherit the GLM
// env vars in its environ (launched via a wrapper/alias that does not pass
// them through), but its SUBPROCESSES do (MCP servers, child shells, etc.).
// If glmCredsFromSessions found nothing in the session pids, sweep the whole
// system looking for any process with ANTHROPIC_BASE_URL (z.ai/bigmodel) +
// token. The account is a single one — any process holding the credentials
// works to fetch the plan's %.
// Dedup by token. Never throws; reads only what the owner can (EACCES → skip).
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

// OpenCode stores provider credentials in auth.json. If the z.ai provider
// (zai-coding-plan) exists, its API key queries the SAME GLM quota API
// (/api/monitor/usage/quota/limit) → reuses readGlmUsage. That way
// OpenCode-via-z.ai usage shows up in the row even without a live GLM session
// in /proc.
// Zero tokens exposed beyond what is already in the local auth.json.
function opencodeGlmCreds() {
  const authFile = path.join(DATA_HOME, 'opencode', 'auth.json');
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return []; }
  const out = [];
  // zai-coding-plan provider (z.ai) — { type:'api', key:'...' }
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

// OpenCode Go: uses the 'opencode-go' provider to query the native API
function opencodeApiCreds() {
  const authFile = path.join(DATA_HOME, 'opencode', 'auth.json');
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; }

  const ocg = auth['opencode-go'];
  if (ocg && ocg.type === 'api' && ocg.key) {
    const token = ocg.key;
    let suffix;
    try { suffix = crypto_().createHash('sha256').update(token).digest('hex').slice(0, 6); }
    catch { suffix = 'oc'; }
    return {
      env: { OPENCODE_AUTH_TOKEN: token },
      label: 'OpenCode Go', suffix,
    };
  }
  return null;
}

// Merges two GLM credential lists, deduplicating by token (a z.ai account
// open in the terminal AND in OpenCode must not become 2 identical blocks).
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

// Codex is passive: usage lives in the session's rollout, keyed by cwd. Live
// Codex sessions are detected via /proc (no state file of its own) and the
// cwd is read from /proc/<pid>/cwd on Linux or via lsof on macOS. Dedup by cwd.
function codexCwdsFromSessions() {
  let sessions = [];
  try { sessions = readSessions(); } catch { return []; }
  const cwds = new Set();
  for (const s of sessions) {
    // LOCAL session only (review fix #7): a peer's pid in the local /proc is a ghost.
    if (!isLocalSession(s) || !s.pid || agentOf(s) !== 'codex') continue;
    try {
      const cwd = getProcessCwd(s.pid);
      if (cwd) cwds.add(cwd);
    } catch { /* process died or no permission */ }
  }
  return [...cwds];
}

// ---- Claude multi-account (#58): one bar per account with a live session ----
// Named profiles (dd-claude) launch claude with CLAUDE_CONFIG_DIR in the
// process environ; sessions WITHOUT the var belong to the default account
// (~/.claude → symlink of the active profile). Discovery = sweep the environ
// of live claude pids (same pattern as glmCredsFromSessions), dedup by the
// dir's REALPATH — the fine-grained dedup by identity (accountUuid) happens in
// collectUsage. The default account always enters (the bar never disappears)
// and first. Manual labels from account-labels.json are applied here by uuid;
// lastAccountIds (sfx→uuid) lets the rename IPC resolve the key from the
// accountId the renderer sends.
let lastAccountIds = {}; // accountId (bar sfx) → account's accountUuid|dir
function claudeAccountsFromSessions() {
  let sessionsList = [];
  try { sessionsList = readSessions(); } catch { return [{ dir: null }]; }
  const seenReal = new Set();
  const named = [];
  // realpath of the default config dir (~/.claude may be a dd-claude symlink).
  // ALWAYS the home's ~/.claude: plain configDir() would honor the ATL
  // ENVIRONMENT's CLAUDE_CONFIG_DIR — if the app was launched from inside a
  // profile session (npm start in a dd-claude terminal), the "default" would
  // become the shell's profile, its real account would be discarded as a
  // "disguised default" and ~/.claude would enter as named. The default of
  // the SESSIONS is the symlink.
  let defReal = null;
  try { defReal = fs.realpathSync(claudePaths.configDir({ home: app.getPath('home') })); } catch {}
  let hasDefault = false;
  for (const s of sessionsList) {
    // LOCAL session only (review fix #7): a remote session's pid is a process
    // on the PEER; probing it in the local /proc can collide with an unrelated
    // local process and create a ghost account (or flag the wrong default).
    if (!isLocalSession(s) || !s.pid || agentOf(s) !== 'claude') continue;
    let env;
    try { env = usage.parseEnviron(getProcessEnviron(s.pid), ['CLAUDE_CONFIG_DIR']); }
    catch { continue; } // process died between readSessions and this read
    const d = env.CLAUDE_CONFIG_DIR;
    if (d) {
      let real;
      try {
        if (!fs.statSync(d).isDirectory()) continue;
        real = fs.realpathSync(d);
      } catch { continue; }
      if (defReal && real === defReal) { hasDefault = true; continue; } // the disguised default
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      named.push({ dir: d });
    } else {
      hasDefault = true; // plain claude → default symlink account
    }
  }
  // The default enters when it has a live session (no var, or var pointing at
  // ~/.claude itself) OR when NO account was discovered — the bar always
  // exists. Named-sessions-only → named only (default account not in use).
  const accounts = (hasDefault || !named.length) ? [{ dir: null }, ...named] : named;
  // Manual aliases (#58): key = accountUuid (fallback dir) — same source as
  // the sfx, so the label survives a profile rename on disk.
  let labels = {};
  try { labels = JSON.parse(fs.readFileSync(ACCOUNT_LABELS_FILE, 'utf8')) || {}; } catch {}
  lastAccountIds = {};
  for (const a of accounts) {
    // injected home = the ~/.claude symlink account, not ATL's env var.
    // Without a readable .claude.json (hand-made proxy profile) the account
    // STILL has a tile — pc null does NOT discard it: the key falls back to
    // the dir and its rename works (review fix #9: the `if (!pc) continue`
    // left the sfx out of lastAccountIds and the alias was silently
    // discarded).
    const pc = usage.readClaudeConfig({ home: app.getPath('home'), dir: a.dir });
    // Identity key in ONE definition (usage.claudeAccountKey): org first
    // (limit/billing is per-org — #60), accountUuid for personal, dir for
    // non-oauth, 'default' for the symlink account. Fallback
    // labels[accountUuid]: an alias saved before the org key keeps working.
    const key = usage.claudeAccountKey(pc, a.dir);
    const sfx = usage.claudeAccountSfx(key);
    lastAccountIds[sfx] = key;
    const manual = labels[key] || (pc && pc.accountUuid && labels[pc.accountUuid]);
    if (manual) a.label = manual;
  }
  return accounts;
}
// Config dirs of the NAMED profiles with a live session (CodeRabbit PR #63):
// feeds findTranscript/backfillModels — claudePaths.projectsRoots() only knows
// THIS process's config dir, so a named-profile session's transcript would
// never be found (no model backfill, no prompt view). Called on rare paths
// (boot backfill, transcript view) — the environ sweep cost is fine there.
function namedConfigDirs() {
  try { return claudeAccountsFromSessions().map((a) => a.dir).filter(Boolean); }
  catch { return []; }
}

async function collectAndSendUsage({ claudeFetch = false } = {}) {
  try {
    let glmCreds = glmCredsFromSessions();
    // Fallback 1: the app itself was launched from a GLM terminal (vars already in env).
    if (!glmCreds.length && process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
      glmCreds = [{ env: process.env }];
    }
    // Fallback 2: the Claude Code main process sometimes does not inherit the
    // vars, but subprocesses do. Sweeps the whole /proc looking for any
    // process with z.ai credentials (the account is a single one). Fixes the
    // GLM "stops updating" bug when no monitored session has the vars in its
    // environ.
    if (!glmCreds.length) glmCreds = glmCredsFromProc();
    // OpenCode: if the z.ai provider (zai-coding-plan) exists in auth.json,
    // its credential queries the SAME quota API — merge (dedup by token).
    glmCreds = mergeGlmCreds(glmCreds, opencodeGlmCreds());

    // OpenCode Go: queries OpenCode's native API
    const ocCred = opencodeApiCreds();

    const codexCwds = codexCwdsFromSessions();
    const claudeAccounts = claudeAccountsFromSessions();   // Claude multi-account #58
    const entries = await usage.collectUsage({
      glmCreds, codexCwds, home: app.getPath('home'), claudeAccounts,
      opencodeEnv: ocCred ? ocCred.env : undefined,
      opencodeLabel: ocCred ? ocCred.label : undefined,
      opencodeSuffix: ocCred ? ocCred.suffix : undefined,
      // LAZY: the background loop (claudeFetch=false) does NOT hit the Claude
      // API — only UI triggers (opening/revealing the overlay, ⟳) and boot
      // pass true. Keeps the app out of the aggregate 429 limit (shared with
      // Claude Code's /status).
      claudeAllowFetch: claudeFetch,
      // PER-ACCOUNT persisted 429 cooldown: no re-hitting the API while live;
      // the collector calls back claudeSetCooldown(key, {until, fails}) when
      // it gets a new 429 (writes only that account's entry).
      claudeCooldowns,
      claudeSetCooldown: saveClaudeCooldown,
    });
    // Merges with the last state: keeps each row's last good value if the
    // current collection failed for it (avoids zeroing/disappearing); fades to
    // gray (stale) after a few minutes without an update instead of
    // flickering. See usage.mergeUsage.
    if (Array.isArray(entries)) { lastUsage = usage.mergeUsage(lastUsage, entries); saveUsage(); maybeNotifyReset(); }
  } catch { /* collectUsage already swallows errors internally; duplicate catch */ }
  sendToRenderer('usage', lastUsage);
  // meta for the UI: the 429 cooldown (if live) feeds the ⟳ button's tooltip.
  const _cdMeta = activeCooldownMeta();
  sendToRenderer('usage-meta', { claudeCooldownUntil: _cdMeta.until, claudeCooldownFails: _cdMeta.fails });
}

// State (by id) that detectReset uses across collections to find the
// "was exhausted → reset" transition. Lives only in process memory: if the app
// was closed at reset time, there is no prior state → no retroactive
// notification (intentional — the user already sees the bar freed on reopen).
let resetNotifyState = {};
// After each collection, checks whether any EXHAUSTED limit just reset and —
// if the user enabled it (settings.notifyOnReset) — fires a native
// notification WITH sound (silent:false; it is an event the user was waiting
// for).
// Never throws: reset detection must not take down the usage loop.
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
    if (toNotify.length && settingsCfg.revealOnReset) revealIfHidden(); // brings to front if hidden
  } catch { /* reset detection never takes down the collection */ }
}
ipcMain.on('request-usage', () => {
  sendToRenderer('usage', lastUsage);
  const _cdMeta = activeCooldownMeta();
  sendToRenderer('usage-meta', { claudeCooldownUntil: _cdMeta.until, claudeCooldownFails: _cdMeta.fails });
});

// Force (⟳ button): bypasses the CONVENIENCE cache (5min Claude / 30s GLM)
// and re-collects immediately. Does NOT bypass the 429 cooldown — that lives
// on disk and is injected into collectUsage, so even with the cache cleared
// the collector does not re-hit during the rate-limit window (avoids
// re-escalating). It is "refresh now", not "ignore the limit".
ipcMain.on('force-usage', () => {
  try {
    // While a cooldown is active, does NOT clear the Claude cache: it holds
    // the last good value readClaudeUsage uses as fallback. Clearing it would
    // make the tile regress to plan-only (lose the %) just because the user
    // clicked ⟳ during rate limiting. Outside a cooldown, clears normally to
    // force a real re-collection.
    if (!activeCooldownMeta().until) usage._clearClaudeCache();
    usage._clearGlmCache();
    usage._clearCodexCache();
  } catch { /* ignore */ }
  collectAndSendUsage({ claudeFetch: true });   // ⟳: UI trigger → fetch the % now
});
// ---- auto-update: extracted to src/ipc/update.js (REF step 1) ----
