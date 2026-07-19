// src/ipc/update.js — auto-update IPC (extraído do main.js, REF passo 1).
// Electron-bound (ipcMain/app/Notification/shell). O estado interno vive aqui;
// o main injeta o estado dinâmico (janela, settings, i18n, reveal) e as
// constantes por DI, mantendo este módulo como glue puro (sem refs a globals).
//
// Retorna { checkUpdatesManual } para o tray (verificação manual c/ notificação).

function setupUpdateIpc({ getMainWindow, getSettings, T, revealIfHidden, REPO_URL, APP_VERSION, AUTOSTART_FILE }) {
  const path = require('path');
  const fs = require('fs');
  const { app, ipcMain, Notification, shell } = require('electron');

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
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update-state', updateState);
  }
  function setUpdateState(patch) { updateState = { ...updateState, ...patch }; emitUpdateState(); }

  // Configura o autoUpdater (eventos) e dispara a 1ª checagem + scheduler 1h.
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
        const s = getSettings();
        if (s && s.revealOnUpdate) revealIfHidden(); // traz à frente se oculto
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

  setupAutoUpdater();   // configura eventos + 1ª checagem + scheduler 1h (igual ao boot antigo)

  return { checkUpdatesManual };
}

module.exports = { setupUpdateIpc };
