// src/ipc/tray.js — tray + notify IPC (extracted from main.js, REF step 8).
// Dynamic tray icon (painted with the worst color) + notifications + notify/
// set-tray-level handlers. buildTrayMenu STAYS in main (composer — references
// launcherIpc/updateIpc/hooks/settings) and is injected as the `buildMenu`
// callback.
//
// notifyUser is the shared DI (update/focus/launcher receive it from main,
// which gets it from here). setupTrayIpc does NOT create the tray — it returns
// createTray() for boot to call AFTER the other modules (buildMenu references
// launcherIpc/updateIpc, which only exist after their respective setups).

function setupTrayIpc({ ipcMain, APP_VERSION, buildMenu, toggleWin, assetsDir }) {
  const path = require('path');
  const { Notification, nativeImage, Tray } = require('electron');

  function notifyUser(body) {
    try { new Notification({ title: 'AI Traffic Lights', body, silent: true }).show(); } catch {}
  }

  let tray = null;
  // ---- dynamic tray: icon painted with the worst color + tooltip with the count ----
  // Variant per level (colored dot on the corner of the base icon). With no
  // sessions, falls to the neutral icon (doesn't show "all green" with nothing
  // running).
  // On macOS we use the icons with the -mac.png suffix (PNG with alpha,
  // transparent background) which look good in the menu bar on any theme. On
  // Linux the original colored ones stay, no suffix. (ported from PR #46)
  const IS_MAC = process.platform === 'darwin';
  const trayIconFile = (name) => (IS_MAC ? name.replace('.png', '-mac.png') : name);
  const TRAY_ICON_FILE = {
    awaiting: trayIconFile('tray-icon-r.png'),
    processing: trayIconFile('tray-icon-y.png'),
    done: trayIconFile('tray-icon-g.png'),
  };
  const trayIcons = {};
  for (const [lvl, file] of Object.entries(TRAY_ICON_FILE)) {
    const img = nativeImage.createFromPath(path.join(assetsDir, file));
    trayIcons[lvl] = img.isEmpty() ? null : img;
  }
  const trayIconBase = (() => {
    const img = nativeImage.createFromPath(path.join(assetsDir, trayIconFile('tray-icon.png')));
    // macOS: the boot/zero-sessions icon becomes a template — the menu bar
    // adapts the stroke by itself (light/dark). The base PNG is low-alpha
    // gray: without template it would vanish in the dark menu bar (RGB color
    // is ignored, only alpha counts).
    if (IS_MAC) img.setTemplateImage(true);
    return img;
  })();

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
    tray = new Tray(trayIconBase.isEmpty() ? nativeImage.createEmpty() : trayIconBase);
    tray.setToolTip(`AI Traffic Lights v${APP_VERSION}`);
    if (IS_MAC) {
      // macOS: does NOT set a permanent menu — with one, left-click opens the
      // menu and the overlay toggle never happens. Here the menu is manual on
      // right-click.
      // And ignoreDoubleClickEvents: by default the fast 2nd click is
      // COALESCED into a double-click, 'click' is suppressed and "hide" never
      // fires (clicks to show, but can't hide). It's the official method for
      // a toggle.
      tray.setIgnoreDoubleClickEvents(true);
      tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    } else {
      tray.setContextMenu(buildMenu());   // composer (main): references launcherIpc/updateIpc
    }
    tray.on('click', toggleWin);
  }

  // The macOS tray menu is rebuilt on every right-click, so switching
  // language doesn't need to rebuild it; on Linux it's permanent and does.
  function refreshMenu() { if (!IS_MAC && tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu()); }

  ipcMain.on('notify', (_e, { title, body }) => {
    try { new Notification({ title, body, silent: true }).show(); } catch {}
  });
  ipcMain.on('set-tray-level', (_e, info) => setTrayLevel(info || {}));

  return { notifyUser, setTrayLevel, createTray, refreshMenu };
}

module.exports = { setupTrayIpc };
