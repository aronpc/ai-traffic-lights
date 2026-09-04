// src/ipc/settings.js — Preferences window + read/I-O handlers (REF step 9).
// createSettingsWindow (custom chrome, persisted bounds) + handlers get-settings/
// get-lang/get-version/get-repo-url/open-external/open-settings/pick-sound-file/
// get-sound-bytes. save-settings STAYS in main (it's the "applier": persists
// config and re-applies shortcut/sync/language — like buildTrayMenu, it's a
// composer). settingsCfg/LANG/T stay in main as shared state (enter via DI:
// getSettings/getLang/T).
//
// Returns { createSettingsWindow } for the tray ("Preferences" item) and the
// open-settings handler.

function setupSettingsIpc({ ipcMain, getSettings, getLang, T, APP_VERSION, REPO_URL, SETTINGS_BOUNDS_FILE, BASE_DIR, appDir, SETTINGS_W, SETTINGS_H }) {
  const fs = require('fs');
  const path = require('path');
  const settingsLib = require('../settings');   // isPrerelease (beta feature gate)
  const { BrowserWindow, screen, dialog, shell } = require('electron');

  // Window state — private to the module. It used to be declared in main.js
  // and the module referenced it out of scope (ReferenceError when opening
  // Preferences).
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
        // Only the position: the size is fixed (SETTINGS_W/H) and ignored on
        // load — saving it would only persist dead data and confuse future
        // versions.
        fs.writeFileSync(SETTINGS_BOUNDS_FILE, JSON.stringify({ x, y }));
      } catch {}
    }, 300);
  }

  function createSettingsWindow() {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
    const b = loadSettingsBounds() || {};
    // Clamps to the display work area height: on short screens (e.g. 1366×768,
    // work area ~728px) the ideal height (761) doesn't fit and, with
    // resizable:false, the footer/Close + the end of the General tab would
    // end up below the screen, unreachable.
    // The .tab-body (overflow-y:auto) scrolls; header/tabs/.actions
    // (flex:0 0 auto) stay fixed — "Close" never disappears. The display
    // nearest to the saved position covers multi-monitor; with no position,
    // falls to the primary.
    const disp = (typeof b.x === 'number' && typeof b.y === 'number')
      ? screen.getDisplayNearestPoint({ x: b.x, y: b.y })
      : screen.getPrimaryDisplay();
    const winH = Math.min(SETTINGS_H, disp.workAreaSize.height - 24); // 24 = breathing room
    settingsWin = new BrowserWindow({
      width: SETTINGS_W, height: winH,
      useContentSize: true,               // width/height = web area (the .prefs fills it)
      resizable: false,                   // size locked to the largest tab (user request)
      maximizable: false, fullscreenable: false,
      x: typeof b.x === 'number' ? b.x : undefined,   // position is remembered; size is not
      y: typeof b.y === 'number' ? b.y : undefined,
      title: T('prefs_title'),
      icon: path.join(appDir, 'build/icon.png'),
      // Same custom chrome as the overlay (see createWindow above): no
      // native frame + transparent background — the .prefs (settings.css)
      // draws the rounded panel with border and shadow, and the .bar header
      // is draggable.
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(appDir, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    // The overlay is always-on-top at 'screen-saver' level — without raising
    // Preferences to the SAME level, they open BEHIND it when the windows
    // overlap. Same level + created later = in front.
    settingsWin.setAlwaysOnTop(true, 'screen-saver');
    settingsWin.loadFile(path.join(appDir, 'src/settings.html'));
    settingsWin.on('move', saveSettingsBounds);          // position only (size is fixed)
    settingsWin.on('closed', () => { settingsWin = null; });
  }
  ipcMain.handle('get-settings', () => getSettings());
  // Sync feature = beta build. The renderer asks to know whether to show the
  // Synchronization tab (gone in stable/source — only exists in a -beta.N
  // version).
  ipcMain.handle('sync-available', () => settingsLib.isPrerelease(APP_VERSION));
  ipcMain.handle('get-lang', () => getLang());
  ipcMain.handle('get-version', () => APP_VERSION);              // Preferences footer
  ipcMain.on('open-external', (_e, url) => {
    // Only accepts http(s) — guard: any random string doesn't become a
    // command/protocol.
    if (typeof url === 'string' && /^https?:\/\//.test(url)) { try { shell.openExternal(url); } catch {} }
  });
  ipcMain.handle('get-repo-url', () => REPO_URL);
  ipcMain.on('open-settings', () => createSettingsWindow());

  // ---- custom alert sound ----
  // Picking an audio file: opens the native dialog and COPIES the file to
  // BASE_DIR/sounds/alert.<ext> (survives moving/deleting the original).
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
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (/^alert\./.test(f) && p !== dest) { try { fs.unlinkSync(p); } catch {} }
      }
      fs.copyFileSync(src, dest);
      return dest;
    } catch { return null; }
  });
  // Reads the custom sound bytes for the renderer to decode (Web Audio).
  // SECURITY LOCK: only reads from inside BASE_DIR/sounds (never an arbitrary
  // path).
  ipcMain.handle('get-sound-bytes', (_e, file) => {
    try {
      if (typeof file !== 'string') return null;
      const soundsDir = path.join(BASE_DIR, 'sounds');
      const resolved = path.resolve(file);
      if (resolved !== soundsDir && !resolved.startsWith(soundsDir + path.sep)) return null;
      return new Uint8Array(fs.readFileSync(resolved));
    } catch { return null; }
  });

  return { createSettingsWindow };
}

module.exports = { setupSettingsIpc };

