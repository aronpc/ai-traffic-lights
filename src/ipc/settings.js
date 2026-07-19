// src/ipc/settings.js — janela de Preferências + handlers de leitura/I/O (REF passo 9).
// createSettingsWindow (chrome custom, bounds persistidos) + handlers get-settings/
// get-lang/get-version/get-repo-url/open-external/open-settings/pick-sound-file/
// get-sound-bytes. save-settings FICA no main (é o "aplicador": persiste config e
// re-aplica atalho/sync/idioma — como buildTrayMenu, é compositor). settingsCfg/
// LANG/T continuam no main como shared state (entram por DI: getSettings/getLang/T).
//
// Retorna { createSettingsWindow } p/ o tray (item "Preferências") e o handler
// open-settings.

function setupSettingsIpc({ ipcMain, getSettings, getLang, T, APP_VERSION, REPO_URL, SETTINGS_BOUNDS_FILE, BASE_DIR, appDir }) {
  const fs = require('fs');
  const path = require('path');
  const { BrowserWindow, screen, dialog, shell } = require('electron');

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
      icon: path.join(appDir, 'build/icon.png'),
      // Mesmo chrome custom do overlay (ver createWindow acima): sem moldura
      // nativa + fundo transparente — o .prefs (settings.css) desenha o painel
      // arredondado com borda e sombra, e o header .bar é arrastável.
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(appDir, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    // O overlay é always-on-top nível 'screen-saver' — sem elevar as Preferências
    // ao MESMO nível, elas abrem ATRÁS dele quando as janelas se sobrepõem.
    // Mesmo nível + criada depois = fica na frente.
    settingsWin.setAlwaysOnTop(true, 'screen-saver');
    settingsWin.loadFile(path.join(appDir, 'src/settings.html'));
    settingsWin.on('move', saveSettingsBounds);          // só posição (tamanho é fixo)
    settingsWin.on('closed', () => { settingsWin = null; });
  }
  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('get-lang', () => getLang());
  ipcMain.handle('get-version', () => APP_VERSION);              // rodapé das Preferências
  ipcMain.on('open-external', (_e, url) => {
    // Só aceita http(s) — guarda: qualquer string não vira comando/protocolo.
    if (typeof url === 'string' && /^https?:\/\//.test(url)) { try { shell.openExternal(url); } catch {} }
  });
  ipcMain.handle('get-repo-url', () => REPO_URL);
  ipcMain.on('open-settings', () => createSettingsWindow());

  // ---- som de alerta customizado ----
  // Escolher um arquivo de áudio: abre o diálogo nativo e COPIA o arquivo pra
  // BASE_DIR/sounds/alert.<ext> (sobrevive a mover/apagar o original).
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
  // Ler os bytes do som custom pro renderer decodificar (Web Audio). TRAVA DE
  // SEGURANÇA: só lê de dentro de BASE_DIR/sounds (nunca caminho arbitrário).
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

