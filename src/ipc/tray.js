// src/ipc/tray.js — tray + notify IPC (extraído do main.js, REF passo 8).
// Ícone tray dinâmico (pinta com a pior cor) + notificações + handlers notify/
// set-tray-level. buildTrayMenu FICA no main (compositor — referencia launcherIpc/
// updateIpc/hooks/settings) e é injetado como callback `buildMenu`.
//
// notifyUser é a DI compartilhada (update/focus/launcher a recebem do main, que a
// obtém daqui). setupTrayIpc NÃO cria o tray — retorna createTray() p/ o boot
// chamar DEPOIS dos outros módulos (buildMenu referencia launcherIpc/updateIpc,
// que só existem após os respectivos setups).

function setupTrayIpc({ ipcMain, APP_VERSION, buildMenu, toggleWin, assetsDir }) {
  const path = require('path');
  const { Notification, nativeImage, Tray } = require('electron');

  function notifyUser(body) {
    try { new Notification({ title: 'AI Traffic Lights', body, silent: true }).show(); } catch {}
  }

  let tray = null;
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
    const img = nativeImage.createFromPath(path.join(assetsDir, file));
    trayIcons[lvl] = img.isEmpty() ? null : img;
  }
  const trayIconBase = nativeImage.createFromPath(path.join(assetsDir, 'tray-icon.png'));

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
    const icon = nativeImage.createFromPath(path.join(assetsDir, 'tray-icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip(`AI Traffic Lights v${APP_VERSION}`);
    tray.setContextMenu(buildMenu());   // compositor (main): referencia launcherIpc/updateIpc
    tray.on('click', toggleWin);
  }

  ipcMain.on('notify', (_e, { title, body }) => {
    try { new Notification({ title, body, silent: true }).show(); } catch {}
  });
  ipcMain.on('set-tray-level', (_e, info) => setTrayLevel(info || {}));

  return { notifyUser, setTrayLevel, createTray };
}

module.exports = { setupTrayIpc };
