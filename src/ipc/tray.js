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
  // No macOS usamos os ícones com sufixo -mac.png (PNG com alpha, fundo
  // transparente) que ficam bem na menu bar em qualquer tema. No Linux ficam os
  // originais coloridos, sem sufixo. (portado do PR #46)
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
    // macOS: o ícone de boot/zero-sessões vira template — a menu bar adapta o
    // traço sozinha (claro/escuro). O PNG base é cinza de alpha baixo: sem
    // template ele sumia na menu bar escura (a cor RGB é ignorada, só o alpha).
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
      // macOS: NÃO seta menu permanente — com ele o left-click abre o menu e o
      // toggle do overlay nunca acontece. Aqui o menu é manual no right-click.
      // E ignoreDoubleClickEvents: por padrão o 2º clique rápido é COALESCIDO em
      // double-click, o 'click' é suprimido e o "esconder" nunca dispara (clica
      // pra mostrar, mas não consegue esconder). É o método oficial p/ toggle.
      tray.setIgnoreDoubleClickEvents(true);
      tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
    } else {
      tray.setContextMenu(buildMenu());   // compositor (main): referencia launcherIpc/updateIpc
    }
    tray.on('click', toggleWin);
  }

  // O menu do tray no macOS é construído a cada right-click, então trocar de
  // idioma não precisa reconstruí-lo; no Linux ele é permanente e precisa.
  function refreshMenu() { if (!IS_MAC && tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu()); }

  ipcMain.on('notify', (_e, { title, body }) => {
    try { new Notification({ title, body, silent: true }).show(); } catch {}
  });
  ipcMain.on('set-tray-level', (_e, info) => setTrayLevel(info || {}));

  return { notifyUser, setTrayLevel, createTray, refreshMenu };
}

module.exports = { setupTrayIpc };
