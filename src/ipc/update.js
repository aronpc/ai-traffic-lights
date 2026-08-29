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
  const settingsLib = require('../settings');
  const { spawn } = require('child_process');   // updaterFlags (canal → flags), lógica pura

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
    // macOS empacotado: o executável vive em <algo>.app/Contents/MacOS/. Antes isto
    // caía em 'source' e o app ficava sem NENHUM caminho de atualização.
    if (process.platform === 'darwin' && app.isPackaged && /\.app\/Contents\//.test(exe)) return 'dmg';
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

  // Um AppImage recém-buildado roda direto do `dist/` do projeto — e ali ele é,
  // legitimamente, um "appimage". Só que o electron-updater atualiza no Linux
  // SUBSTITUINDO o arquivo apontado por $APPIMAGE: com uma release mais nova
  // publicada, ele reescreve o próprio artefato de build no quit e o build que
  // você acabou de gerar some. Detectamos pela vizinhança — o electron-builder
  // deixa estes arquivos ao lado do .AppImage que produziu.
  const BUILD_DIR_MARKERS = ['builder-effective-config.yaml', 'builder-debug.yml', 'linux-unpacked'];
  function isBuildArtifact(appImagePath) {
    if (!appImagePath) return false;
    const dir = path.dirname(appImagePath);
    return BUILD_DIR_MARKERS.some((f) => {
      try { return fs.existsSync(path.join(dir, f)); } catch { return false; }
    });
  }

  // Configura o autoUpdater (eventos) e dispara a 1ª checagem + scheduler 1h.
  function setupAutoUpdater() {
    const method = detectInstallMethod();
    updateState.method = method;
    // app.isPackaged: guarda recomendada pela doc oficial do Electron — em dev o
    // updater não deve existir. isBuildArtifact: não auto-instalar por cima de um
    // build local. Nos dois casos a checagem informativa (GitHub API) continua e a
    // UI cai sozinha no "abrir a release", que já é o caminho de canAutoInstall=false.
    // Só AppImage recebe auto-update pelo electron-updater — inclusive no macOS
    // (decisão do PR #46). O .dmg e o .zip não são assinados/notarizados (sem
    // Apple Developer ID): o acquireSquirrelMac baixaria o zip, mas o code-sign
    // check falharia e a instalação quebraria. DMG/deb/source ficam no fallback
    // GitHub-API (checa a release e abre o link) — atualizar lá é baixar o novo
    // arquivo e trocar.
    if (method === 'appimage' && app.isPackaged && !isBuildArtifact(process.env.APPIMAGE)) {
      try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { console.error('[auto-update] require electron-updater falhou:', e && e.message); autoUpdater = null; }
    } else if (method === 'appimage') {
      console.log('[auto-update] auto-instalação desligada: build local ou não empacotado (' + (process.env.APPIMAGE || process.execPath) + ')');
    }
    updateState.canAutoInstall = !!autoUpdater || method === 'dmg';
    if (autoUpdater) {
      autoUpdater.autoDownload = true;           // baixa sozinho ao detectar (instala no clique "↻" ou no quit)
      autoUpdater.autoInstallOnAppQuit = true;
      applyUpdateChannel();                      // stable (default) ou beta, conforme as Preferências
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
      // .dmg da arquitetura em uso — é o que o updater do macOS instala. Um nome
      // sem marca de arquitetura serve às duas (build universal).
      if (process.platform === 'darwin') {
        const alvo = pickMacDmg(j.assets, process.arch);
        if (alvo) { info.dmgUrl = alvo.browser_download_url; info.dmgName = alvo.name; }
      }
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
      setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, dmgUrl: info.dmgUrl || null, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
      if (info.hasUpdate && updateState.method === 'dmg') baixarUpdateMac();   // autoDownload, como no Linux
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
      setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, dmgUrl: info.dmgUrl || null, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
      _notifyManualResult(info.hasUpdate, info.latest, info.error);
      if (info.hasUpdate && updateState.method === 'dmg') baixarUpdateMac();   // autoDownload, como no Linux
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

  // ---- atualização no macOS SEM Developer ID (PR #46, achado 03) ----
  // O electron-updater delega ao Squirrel.Mac, que EXIGE assinatura válida: o app
  // instalado é assinado ad-hoc pelo install_macos.sh (sem Team ID) e o artefato
  // do CI não é assinado, então a verificação nunca casa. Não há gancho para
  // desligá-la (só o NsisUpdater expõe verifyUpdateCodeSignature; o macOS
  // resolve no nativo). Em vez de assinatura, reproduzimos os passos do
  // install_macos.sh — que já instala de verdade — a partir do .dmg da release.
  //
  // O script roda DESTACADO porque o app precisa sair antes de ser substituído.
  // Ele espera o pid morrer, monta o dmg, troca o bundle com rollback, tira a
  // quarentena, re-assina ad-hoc e relança.
  function baixarArquivo(url, dest, saltos = 0) {
    return new Promise((resolve, reject) => {
      if (saltos > 5) return reject(new Error('redirecionamentos demais'));
      const https = require('https');
      https.get(url, { headers: { 'User-Agent': 'ai-traffic-lights' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(baixarArquivo(res.headers.location, dest, saltos + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let lidos = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          lidos += c.length;
          if (total) setUpdateState({ status: 'downloading', progress: Math.round((lidos / total) * 100) });
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      }).on('error', reject);
    });
  }

  // O bundle .app em execução, a partir do execPath (…/X.app/Contents/MacOS/bin).
  function bundleEmUso() {
    const m = (process.execPath || '').match(/^(.*\.app)\/Contents\//);
    return m ? m[1] : null;
  }

  const SCRIPT_TROCA = `#!/bin/bash
# Gerado pelo AI Traffic Lights para trocar o próprio bundle. Roda destacado,
# depois que o app sai. Passos idênticos aos do install_macos.sh.
set -u
PID="$1"; DMG="$2"; DEST="$3"
# espera o app sair (máx. 30 s) — não dá pra substituir um bundle em uso
for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
MNT="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$MNT" "$DMG" || exit 1
SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"
if [ -z "$SRC" ]; then hdiutil detach -force "$MNT" >/dev/null 2>&1; exit 1; fi
# rollback: só apaga o antigo depois que o novo estiver inteiro no lugar
rm -rf "$DEST.old"
mv "$DEST" "$DEST.old" 2>/dev/null || true
if ! ditto "$SRC" "$DEST" 2>/dev/null; then
  rm -rf "$DEST"
  mv "$DEST.old" "$DEST" 2>/dev/null || true
  hdiutil detach -force "$MNT" >/dev/null 2>&1
  exit 1
fi
hdiutil detach -force "$MNT" >/dev/null 2>&1
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" 2>/dev/null || true
rm -rf "$DEST.old" "$DMG"
open "$DEST"
`;

  // Mesma POLÍTICA do AppImage no Linux, onde o electron-updater roda com
  // autoDownload=true e autoInstallOnAppQuit=true: o update baixa sozinho assim
  // que aparece, a UI mostra o progresso pelos mesmos campos de estado, e a
  // troca acontece ao sair do app — pelo botão "↻" (que só encerra) ou no quit
  // normal. A diferença é só quem executa a troca: lá o Squirrel, aqui o script.
  let _macStaged = null;      // { dmg, sh, dest } pronto para trocar no quit
  let _macBaixando = false;

  async function baixarUpdateMac() {
    if (_macStaged || _macBaixando) return;      // já pronto, ou em andamento
    const dest = bundleEmUso();
    const url = updateState.dmgUrl;
    if (!dest || !url) return;                   // sem alvo/asset: fica no manual
    _macBaixando = true;
    try {
      const dmg = path.join(app.getPath('temp'), `atl-update-${Date.now()}.dmg`);
      setUpdateState({ status: 'downloading', progress: 0, error: null });
      await baixarArquivo(url, dmg);
      const sh = path.join(app.getPath('temp'), `atl-swap-${Date.now()}.sh`);
      fs.writeFileSync(sh, SCRIPT_TROCA, { mode: 0o755 });
      _macStaged = { dmg, sh, dest };
      setUpdateState({ status: 'ready', progress: 100 });
    } catch (e) {
      setUpdateState({ status: 'error', error: String((e && e.message) || e) });
    } finally {
      _macBaixando = false;
    }
  }

  // Equivalente ao autoInstallOnAppQuit: a troca dispara no encerramento, seja
  // ele pelo "↻", pelo menu ou pelo fechamento normal. O script espera este pid
  // morrer antes de tocar no bundle, então registrar aqui é seguro.
  function trocarNoQuit() {
    if (!_macStaged) return;
    const { dmg, sh, dest } = _macStaged;
    _macStaged = null;                           // não dispara duas vezes
    try {
      spawn('/bin/bash', [sh, String(process.pid), dmg, dest], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  if (process.platform === 'darwin') app.on('will-quit', trocarNoQuit);

  ipcMain.on('check-update', () => { _updateCache = null; checkForUpdates(); });   // "verificar agora" ignora o cache
  ipcMain.on('download-update', () => {
    if (autoUpdater) { try { autoUpdater.downloadUpdate(); } catch {} return; }
    if (updateState.method === 'dmg') baixarUpdateMac();
  });
  ipcMain.on('install-update', () => {
    if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch {} return; }
    // macOS: só encerra — o hook de quit faz a troca, como o autoInstallOnAppQuit.
    if (updateState.method === 'dmg' && _macStaged) { try { app.quit(); } catch {} }
  });

  setupAutoUpdater();   // configura eventos + 1ª checagem + scheduler 1h (igual ao boot antigo)

  // Aplica o canal escolhido nas Preferências ao autoUpdater. Chamado no setup e
  // de novo a cada troca (as Preferências aplicam ao vivo), porque as flags são
  // lidas a cada checagem — não só na construção.
  // A tradução canal→flags é pura e vive em src/settings.js (updaterFlags).
  function applyUpdateChannel() {
    if (!autoUpdater) return;                  // deb/npm/source: fallback GitHub-API, sempre estável
    const s = getSettings();
    const f = settingsLib.updaterFlags(s && s.updateChannel, APP_VERSION);
    autoUpdater.allowPrerelease = f.allowPrerelease;
    autoUpdater.allowDowngrade = f.allowDowngrade;
  }

  // Trocou de canal nas Preferências → reflete e re-checa na hora. A detecção
  // em si já é a quente (allowPrerelease + checkForUpdates re-busca o feed), mas
  // sem feedback visível o usuário não via nada acontecer ao marcar beta e achava
  // que precisava reiniciar o app. O status 'checking' mostra a re-verificação na
  // hora; o resultado (update disponível / em dia) transiciona sozinho pelos
  // eventos do autoUpdater.
  function onChannelChanged() {
    applyUpdateChannel();
    _updateCache = null;                       // o cache do fallback é por canal
    setUpdateState({ status: 'checking', error: null, hasUpdate: false, progress: 0 });
    checkForUpdates();
  }

  return { checkUpdatesManual, onChannelChanged };
}

// Escolhe o .dmg da release para a arquitetura em uso. PURA e exportada porque
// errar aqui instala o binário da arquitetura errada — e um Mac Intel rodando um
// bundle arm64 (ou vice-versa) não abre. Preferência: nome com a arquitetura
// exata; senão um nome sem marca nenhuma (build universal); senão nada.
function pickMacDmg(assets, arch) {
  if (!Array.isArray(assets)) return null;
  const alvo = arch === 'arm64' ? 'arm64' : 'x64';
  const dmgs = assets.filter((a) => a && typeof a.name === 'string' && /\.dmg$/i.test(a.name));
  const exato = dmgs.find((a) => a.name.includes(alvo));
  if (exato) return exato;
  return dmgs.find((a) => !/arm64|x64/i.test(a.name)) || null;
}

module.exports = { setupUpdateIpc, pickMacDmg };
