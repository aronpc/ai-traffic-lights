// src/ipc/update.js — auto-update IPC (extracted from main.js, REF step 1).
// Electron-bound (ipcMain/app/Notification/shell). Internal state lives here;
// main injects the dynamic state (window, settings, i18n, reveal) and the
// constants via DI, keeping this module as pure glue (no refs to globals).
//
// Returns { checkUpdatesManual } for the tray (manual check w/ notification).

function setupUpdateIpc({ getMainWindow, getSettings, T, revealIfHidden, REPO_URL, APP_VERSION, AUTOSTART_FILE }) {
  const path = require('path');
  const fs = require('fs');
  const { app, ipcMain, Notification, shell } = require('electron');
  const settingsLib = require('../settings');
  const { spawn } = require('child_process');   // updaterFlags (channel → flags), pure logic

  // ---- update checker (version + latest release from GitHub) ----
  // Detects HOW the app was installed to offer the right update path.
  //   appimage → AppImage type 2 (execPath in /tmp/.mount_<name>, or *.AppImage)
  //   deb      → installed in /opt (electronic-builder deb becomes /opt/AI Traffic Lights)
  //   npm      → running from node_modules (npm install / dev)
  //   source   → repo clone (direct dev)
  //
  // AppImage detection does NOT depend only on the APPIMAGE env: Electron 43
  // sometimes loses it on sandbox re-exec, so we also check execPath (mount
  // point /tmp/.mount_<name>). When we detect an AppImage without the env, we
  // recover the .AppImage path and re-export it in process.env.APPIMAGE —
  // electron-updater depends on it to (a) know it is an AppImage and (b) which
  // file to replace on install. Without this, auto-update never showed up
  // (it always fell to "open release").
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
    // Packaged macOS: the executable lives in <something>.app/Contents/MacOS/.
    // Before, this fell into 'source' and the app was left with NO update path.
    if (process.platform === 'darwin' && app.isPackaged && /\.app\/Contents\//.test(exe)) return 'dmg';
    return 'source';
  }

  // Recovers the absolute path of the running .AppImage when the runtime lost
  // the APPIMAGE env. Cascade: env → execPath (*.AppImage) → Exec= from the
  // app's .desktop (reliable source maintained by the app itself) → search by
  // mount basename in canonical locations (~/Applications, ~/.local/bin,
  // ~/Downloads, /opt).
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
  // Compares semver versions ('0.3.2' vs '0.4.0'); >0 if a>b, 0 if equal, <0 if a<b.
  function semverCmp(a, b) {
    const parse = (v) => {
      const s = String(v || '').replace(/^v/, '');
      const [core, pre] = s.split('-');
      return { n: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre || '' };
    };
    const pa = parse(a), pb = parse(b);
    for (let i = 0; i < 3; i++) if ((pa.n[i] || 0) !== (pb.n[i] || 0)) return (pa.n[i] || 0) - (pb.n[i] || 0);
    // Same core: the one WITHOUT a pre-release is greater (0.9.0 > 0.9.0-beta.1).
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre && !pb.pre) return -1;
    return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  }

  // ---- auto-updater (AppImage) + update state ----
  // electron-updater only auto-updates AppImage on Linux; deb/npm/source fall
  // to the GitHub-API fallback (informational only → opens the release in the
  // browser).
  let autoUpdater = null;
  let _manualCheck = false;   // manual check from the tray → notifies the result
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

  // A freshly built AppImage runs straight from the project's `dist/` — and
  // there it legitimately IS an "appimage". But electron-updater updates on
  // Linux by REPLACING the file pointed to by $APPIMAGE: with a newer release
  // published, it rewrites the build artifact itself on quit and the build you
  // just generated is gone. We detect it by neighborhood — electron-builder
  // leaves these files next to the .AppImage it produced.
  const BUILD_DIR_MARKERS = ['builder-effective-config.yaml', 'builder-debug.yml', 'linux-unpacked'];
  function isBuildArtifact(appImagePath) {
    if (!appImagePath) return false;
    const dir = path.dirname(appImagePath);
    return BUILD_DIR_MARKERS.some((f) => {
      try { return fs.existsSync(path.join(dir, f)); } catch { return false; }
    });
  }

  // Sets up the autoUpdater (events) and triggers the 1st check + 1h scheduler.
  function setupAutoUpdater() {
    const method = detectInstallMethod();
    updateState.method = method;
    // app.isPackaged: guard recommended by the official Electron docs — in dev
    // the updater must not exist. isBuildArtifact: don't auto-install on top of
    // a local build. In both cases the informational check (GitHub API)
    // continues and the UI falls on its own to "open the release", which is
    // already the canAutoInstall=false path.
    // Only AppImage gets auto-update via electron-updater — including on macOS
    // (decision from PR #46). The .dmg and .zip are not signed/notarized (no
    // Apple Developer ID): acquireSquirrelMac would download the zip, but the
    // code-sign check would fail and the install would break. DMG/deb/source
    // stay in the GitHub-API fallback (checks the release and opens the link) —
    // updating there means downloading the new file and swapping it.
    if (method === 'appimage' && app.isPackaged && !isBuildArtifact(process.env.APPIMAGE)) {
      try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { console.error('[auto-update] require electron-updater falhou:', e && e.message); autoUpdater = null; }
    } else if (method === 'appimage') {
      console.log('[auto-update] auto-instalação desligada: build local ou não empacotado (' + (process.env.APPIMAGE || process.execPath) + ')');
    }
    updateState.canAutoInstall = !!autoUpdater || method === 'dmg';
    if (autoUpdater) {
      autoUpdater.autoDownload = true;           // downloads by itself when detected (installs on "↻" click or on quit)
      autoUpdater.autoInstallOnAppQuit = true;
      applyUpdateChannel();                      // stable (default) or beta, per Preferences
      autoUpdater.on('update-available', (info) => {
        const v = ((info && info.version) || '').replace(/^v/, '');
        setUpdateState({ hasUpdate: true, latest: v, url: REPO_URL + '/releases/tag/v' + v, status: 'available', error: null });
        if (_manualCheck) _notifyManualResult(true, v, null);
        const s = getSettings();
        if (s && s.revealOnUpdate) revealIfHidden(); // brings to front if hidden
      });
      autoUpdater.on('update-not-available', () => { setUpdateState({ hasUpdate: false, status: 'idle' }); if (_manualCheck) _notifyManualResult(false, null, null); });
      autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', progress: Math.round((p && p.percent) || 0) }));
      autoUpdater.on('update-downloaded', () => setUpdateState({ status: 'ready', progress: 100 }));
      autoUpdater.on('error', (e) => { const msg = String((e && e.message) || e); setUpdateState({ status: 'error', error: msg }); if (_manualCheck) _notifyManualResult(false, null, msg); });
    }
    checkForUpdates();                            // 1st check on boot
    setInterval(checkForUpdates, 60 * 60 * 1000); // re-checks every 1h
  }

  // GitHub-API check cache (non-appimage fallback): 30min to avoid spamming.
  let _updateCache = null;
  async function checkUpdateGithub() {
    const now = Date.now();
    if (_updateCache && now - _updateCache.checkedAt < 30 * 60 * 1000) return _updateCache.info;
    const info = { current: APP_VERSION, method: updateState.method, latest: null, hasUpdate: false, url: null, error: null };
    try {
      // /releases/latest EXCLUDES pre-releases by API definition — anyone who
      // checked "Receive beta versions" would never see a beta through this
      // path (the channel was unreachable on macOS/deb, which lack
      // electron-updater). On the beta channel we fetch the LIST and pick the
      // highest version via semverCmp (which already understands pre-releases:
      // 0.9.0-beta.1 < 0.9.0).
      const f = settingsLib.updaterFlags((getSettings() || {}).updateChannel, APP_VERSION);
      const wantBeta = !!(f && f.allowPrerelease);
      const https = require('https');
      const body = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.github.com',
          path: wantBeta
            ? '/repos/aronpc/ai-traffic-lights/releases?per_page=20'
            : '/repos/aronpc/ai-traffic-lights/releases/latest',
          method: 'GET',
          headers: { 'User-Agent': 'ai-traffic-lights', Accept: 'application/vnd.github+json' },
          timeout: 5000,
        }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
      });
      let j = JSON.parse(body);
      if (Array.isArray(j)) {   // beta channel: list → highest version via semverCmp
        let best = null;
        for (const r of j) {
          const v = (r && r.tag_name || '').replace(/^v/, '');
          if (!v) continue;
          if (!best || semverCmp(v, (best.tag_name || '').replace(/^v/, '')) > 0) best = r;
        }
        j = best || {};
      }
      info.latest = (j.tag_name || '').replace(/^v/, '');
      info.url = j.html_url || (REPO_URL + '/releases/latest');
      info.hasUpdate = info.latest ? semverCmp(info.latest, APP_VERSION) > 0 : false;
      // .dmg for the arch in use — it's what the macOS updater installs. A name
      // without an arch marker serves both (universal build).
      if (process.platform === 'darwin') {
        const alvo = pickMacDmg(j.assets, process.arch);
        if (alvo) { info.dmgUrl = alvo.browser_download_url; info.dmgName = alvo.name; }
      }
    } catch (e) {
      info.error = String(e.message || e); // offline/timeout → no update, no crash
    }
    _updateCache = { checkedAt: now, info };
    return info;
  }

  // Triggers the check (AppImage → autoUpdater; others → GitHub-API). Never throws.
  async function checkForUpdates() {
    try {
      if (autoUpdater) { await autoUpdater.checkForUpdates(); return; }
      const info = await checkUpdateGithub();
      setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, dmgUrl: info.dmgUrl || null, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
      if (info.hasUpdate && updateState.method === 'dmg') baixarUpdateMac();   // autoDownload, as on Linux
    } catch (e) {
      setUpdateState({ status: 'error', error: String((e && e.message) || e) });
    }
  }

  // MANUAL check from the tray: ignores the cache and notifies the result.
  async function checkUpdatesManual() {
    _manualCheck = true;
    _updateCache = null;
    try {
      if (autoUpdater) { await autoUpdater.checkForUpdates(); return; } // result → events + _notifyManualResult
      const info = await checkUpdateGithub();
      setUpdateState({ hasUpdate: info.hasUpdate, latest: info.latest, url: info.url, dmgUrl: info.dmgUrl || null, status: info.hasUpdate ? 'available' : 'idle', error: info.error });
      _notifyManualResult(info.hasUpdate, info.latest, info.error);
      if (info.hasUpdate && updateState.method === 'dmg') baixarUpdateMac();   // autoDownload, as on Linux
    } catch (e) {
      _notifyManualResult(false, null, String((e && e.message) || e));
    } finally {
      if (!autoUpdater) _manualCheck = false; // AppImage: it's the event that clears the flag
    }
  }
  // End-of-manual-check notification (found / up to date / error).
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

  // ---- macOS update WITHOUT Developer ID (PR #46, finding 03) ----
  // electron-updater delegates to Squirrel.Mac, which REQUIRES a valid
  // signature: the installed app is signed ad-hoc by install_macos.sh (no Team
  // ID) and the CI artifact is unsigned, so the verification never matches.
  // There is no hook to turn it off (only NsisUpdater exposes
  // verifyUpdateCodeSignature; macOS resolves it in native code). Instead of a
  // signature, we replay the install_macos.sh steps — which already installs
  // for real — starting from the release .dmg.
  //
  // The script runs DETACHED because the app must exit before being replaced.
  // It waits for the pid to die, mounts the dmg, swaps the bundle with
  // rollback, strips the quarantine, re-signs ad-hoc and relaunches.
  function baixarArquivo(url, dest, saltos = 0) {
    return new Promise((resolve, reject) => {
      if (saltos > 5) return reject(new Error('redirecionamentos demais'));
      const https = require('https');
      const req = https.get(url, { headers: { 'User-Agent': 'ai-traffic-lights' } }, (res) => {
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
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    });
  }

  // Fetches a small resource (the checksum sidecar). Returns:
  //   string → body (may be empty)
  //   ''     → the resource DOES NOT EXIST (404): old release, no sidecar
  //   null   → couldn't tell (timeout, TLS, network, too many redirects)
  // The distinction matters: here the sidecar is the ONLY integrity control
  // before a script replaces the entire .app, with nobody watching. Treating a
  // network failure as "doesn't exist" would install with no verification at
  // all.
  function buscarSidecar(url, saltos = 0) {
    return new Promise((resolve) => {
      if (saltos > 5) return resolve({ estado: 'falha', corpo: '' });
      const https = require('https');
      https.get(url, { headers: { 'User-Agent': 'ai-traffic-lights' }, timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); return resolve(buscarSidecar(res.headers.location, saltos + 1));
        }
        if (res.statusCode === 404) { res.resume(); return resolve({ estado: 'ausente', corpo: '' }); }
        if (res.statusCode !== 200) { res.resume(); return resolve({ estado: 'falha', corpo: '' }); }
        let d = ''; res.on('data', (c) => { d += c; });
        // 200 with an EMPTY body is not absence: a transparent proxy or CDN
        // edge answering 200 with no content would disable the only control
        // that guards the .app swap. It comes back as 'ok' and the empty body
        // fails the format check — which is the right outcome.
        res.on('end', () => resolve({ estado: 'ok', corpo: d.trim() }));
      }).on('error', () => resolve({ estado: 'falha', corpo: '' }))
        .on('timeout', function () { this.destroy(); resolve({ estado: 'falha', corpo: '' }); });
    });
  }

  function sha512Base64(file) {
    return new Promise((resolve, reject) => {
      const h = require('crypto').createHash('sha512');
      const st = fs.createReadStream(file);
      st.on('data', (c) => h.update(c));
      st.on('end', () => resolve(h.digest('base64')));
      st.on('error', reject);
    });
  }

  // The running .app bundle, derived from execPath (…/X.app/Contents/MacOS/bin).
  function bundleEmUso() {
    const m = (process.execPath || '').match(/^(.*\.app)\/Contents\//);
    return m ? m[1] : null;
  }

  const SCRIPT_TROCA = `#!/bin/bash
# Gerado pelo AI Traffic Lights para trocar o próprio bundle. Roda destacado,
# depois que o app sai. Passos idênticos aos do install_macos.sh.
set -u
PID="$1"; DMG="$2"; DEST="$3"; RELAUNCH="\${4:-0}"
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
# Só reabre quando o pedido veio do botão "instalar" (RELAUNCH=1). O quit
# normal (tray "Sair", Cmd+Q) troca silenciosamente e NÃO relança — mesmo
# modelo do autoInstallOnAppQuit do electron-updater, que também não reabre.
[ "$RELAUNCH" = "1" ] && open "$DEST"
exit 0
`;

  // Same POLICY as AppImage on Linux, where electron-updater runs with
  // autoDownload=true and autoInstallOnAppQuit=true: the update downloads by
  // itself as soon as it appears, the UI shows progress through the same state
  // fields, and the swap happens when the app exits — via the "↻" button (which
  // only quits) or on normal quit. The only difference is who performs the
  // swap: there Squirrel, here the script.
  let _macStaged = null;      // { dmg, sh, dest } ready to swap on quit
  let _macBaixando = false;
  let _macRelaunch = false;   // true when quit came from the "install" button → reopens

  async function baixarUpdateMac() {
    if (_macStaged || _macBaixando) return;      // already staged, or in progress
    const dest = bundleEmUso();
    const url = updateState.dmgUrl;
    if (!dest || !url) return;                   // no target/asset: stays manual
    _macBaixando = true;
    let dmgTmp = null;                 // for the outer catch to clean up
    try {
      // Integrity: the same <artifact>.sha512 sidecar the shell installers
      // consume. This is the download that needs it MOST — nobody is
      // watching, and the result replaces the entire app.
      //
      // Fetched BEFORE the .dmg: a release whose sidecar never matches would
      // make the 1h cycle re-download ~100 MB indefinitely if the check came
      // after.
      const busca = await buscarSidecar(`${url}.sha512`);
      const releaseLegada = releaseSemSidecar(updateState.latest);
      const RECUSAS = {
        indisponivel: 'ntf_update_checksum_indisponivel',
        malformado:   'ntf_update_checksum_malformado',
        divergente:   'ntf_update_checksum_divergente',
      };
      const dmg = path.join(app.getPath('temp'), `atl-update-${Date.now()}.dmg`);
      dmgTmp = dmg;
      let resultado;
      try {
        resultado = await fluxoUpdateMac({
          busca,
          releaseLegada,
          baixar: async () => {
            setUpdateState({ status: 'downloading', progress: 0, error: null });
            await baixarArquivo(url, dmg);
          },
          obterHash: () => sha512Base64(dmg),
        });
      } catch (e) {
        try { fs.unlinkSync(dmg); } catch {}       // doesn't leave 100 MB in temp
        throw e;
      }
      const { veredito } = resultado;
      if (RECUSAS[veredito]) {
        if (resultado.baixou) { try { fs.unlinkSync(dmg); } catch {} }
        setUpdateState({ status: 'error', error: T(RECUSAS[veredito]) });
        return;
      }

      const sh = path.join(app.getPath('temp'), `atl-swap-${Date.now()}.sh`);
      fs.writeFileSync(sh, SCRIPT_TROCA, { mode: 0o755 });
      _macStaged = { dmg, sh, dest };
      setUpdateState({ status: 'ready', progress: 100 });
    } catch (e) {
      // Any failure after the download (swap script write, unreadable hash)
      // must not leave ~100 MB in temp — and the 1h cycle would repeat it.
      try { if (dmgTmp) fs.unlinkSync(dmgTmp); } catch {}
      setUpdateState({ status: 'error', error: String((e && e.message) || e) });
    } finally {
      _macBaixando = false;
    }
  }

  // Equivalent to autoInstallOnAppQuit: the swap fires on exit, whether via
  // "↻", the menu, or a normal close — but it only REOPENS when the quit came
  // from the "install" button (_macRelaunch). The script waits for this pid to
  // die before touching the bundle, so registering here is safe.
  function trocarNoQuit() {
    if (!_macStaged) return;
    const { dmg, sh, dest } = _macStaged;
    _macStaged = null;                           // doesn't fire twice
    try {
      spawn('/bin/bash', [sh, String(process.pid), dmg, dest, _macRelaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  if (process.platform === 'darwin') app.on('will-quit', trocarNoQuit);

  ipcMain.on('check-update', () => { _updateCache = null; checkForUpdates(); });   // "check now" ignores the cache
  ipcMain.on('download-update', () => {
    if (autoUpdater) { try { autoUpdater.downloadUpdate(); } catch {} return; }
    if (updateState.method === 'dmg') baixarUpdateMac();
  });
  ipcMain.on('install-update', () => {
    if (autoUpdater) { try { autoUpdater.quitAndInstall(); } catch {} return; }
    // macOS: just quits — the quit hook does the swap, like autoInstallOnAppQuit.
    // Here, unlike a normal quit, the app REOPENS after the swap (that's what
    // whoever clicked "install and restart" expects to see).
    if (updateState.method === 'dmg' && _macStaged) { _macRelaunch = true; try { app.quit(); } catch {} }
  });

  setupAutoUpdater();   // sets up events + 1st check + 1h scheduler (same as the old boot)

  // Applies the channel chosen in Preferences to the autoUpdater. Called on
  // setup and again on every change (Preferences apply live), because the
  // flags are read on every check — not just at construction.
  // The channel→flags translation is pure and lives in src/settings.js
  // (updaterFlags).
  function applyUpdateChannel() {
    if (!autoUpdater) return;                  // deb/npm/source: GitHub-API fallback, always stable
    const s = getSettings();
    const f = settingsLib.updaterFlags(s && s.updateChannel, APP_VERSION);
    autoUpdater.allowPrerelease = f.allowPrerelease;
    autoUpdater.allowDowngrade = f.allowDowngrade;
  }

  // Channel changed in Preferences → reflects it and re-checks immediately.
  // The detection itself is already hot (allowPrerelease + checkForUpdates
  // re-fetches the feed), but without visible feedback the user saw nothing
  // happen when checking beta and assumed the app needed a restart. The
  // 'checking' status shows the re-check happening right away; the result
  // (update available / up to date) transitions on its own through the
  // autoUpdater events.
  function onChannelChanged() {
    applyUpdateChannel();
    _updateCache = null;                       // the fallback cache is per-channel
    setUpdateState({ status: 'checking', error: null, hasUpdate: false, progress: 0 });
    checkForUpdates();
  }

  return { checkUpdatesManual, onChannelChanged };
}

// Picks the release .dmg for the arch in use. PURE and exported because
// getting this wrong installs the wrong-arch binary — and an Intel Mac running
// an arm64 bundle (or vice-versa) won't open. Preference: a name with the
// exact arch; then a name with no marker at all (universal build); then
// nothing.
// Decides what to do with the sidecar before staging the bundle swap. PURE
// and exported because it is the ONLY integrity control of the macOS
// auto-update — there is no electron-updater on this path, and the build no
// longer emits latest-mac.yml.
//   busca: { estado: 'ok'|'ausente'|'falha', corpo }  ·  obtido: hash of the file
//   releaseLegada: true only for a version from before the sidecar became mandatory
// Returns: 'ok' | 'sem-sidecar' | 'indisponivel' | 'malformado' | 'divergente'
// validarSidecar judges ONLY the sidecar: did it arrive? is it well-formed
// base64 sha512?
// It compares against nothing — comparing requires the downloaded file, which
// at this point does not exist yet.
//
// The separation exists because merging them broke the entire auto-update:
// the pre-validation called decidirIntegridade(busca, null), and the last
// `return` compared `b.corpo === null`, yielding 'divergente' for EVERY valid
// sidecar. The guard aborted before the download, and the only verdict that
// passed was 'sem-sidecar' — that is, the integrity check allowed exclusively
// the path WITHOUT integrity. The 314 tests passed because they exercised
// decidirIntegridade in isolation, never the baixarUpdateMac flow.
//
// 'pendente' names the state that was missing: intact sidecar, verdict still
// impossible. Whoever receives 'pendente' is obligated to compare later.
function validarSidecar(busca, releaseLegada = false) {
  const b = busca || {};
  if (b.estado === 'ausente') return releaseLegada ? 'sem-sidecar' : 'indisponivel';
  if (b.estado !== 'ok') return 'indisponivel';       // network/TLS/5xx: can't tell
  if (!/^[A-Za-z0-9+/]{86}==$/.test(b.corpo || '')) return 'malformado';
  return 'pendente';                                  // intact; missing the file hash
}

// decidirIntegridade is the FINAL verdict: requires the hash of the already
// downloaded file. Calling it with a null `obtido` is a usage error — for the
// stage before the download there is validarSidecar.
function decidirIntegridade(busca, obtido, releaseLegada = false) {
  const pre = validarSidecar(busca, releaseLegada);
  if (pre !== 'pendente') return pre;
  return busca.corpo === obtido ? 'ok' : 'divergente';
}

// The sidecar became mandatory starting at 0.8.0-beta.4. Only unambiguously
// earlier versions get the legacy fallback; a missing or off-format version
// fails closed.
function releaseSemSidecar(version) {
  const m = String(version || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
  if (!m) return false;
  const base = [+m[1], +m[2], +m[3]];
  const cutoff = [0, 8, 0];
  for (let i = 0; i < 3; i++) {
    if (base[i] < cutoff[i]) return true;
    if (base[i] > cutoff[i]) return false;
  }
  return m[4] != null && +m[4] < 4;
}

// Real composition used by baixarUpdateMac and by the tests: validates before
// downloading, computes the hash afterwards, and never lets 'pendente' escape
// through to installation.
async function fluxoUpdateMac({ busca, releaseLegada = false, baixar, obterHash }) {
  const pre = validarSidecar(busca, releaseLegada);
  if (pre !== 'pendente' && pre !== 'sem-sidecar') return { baixou: false, veredito: pre };
  if (typeof baixar !== 'function') throw new TypeError('baixar ausente');
  await baixar();
  let veredito = pre;
  if (pre === 'pendente') {
    if (typeof obterHash !== 'function') return { baixou: true, veredito: 'indisponivel' };
    veredito = decidirIntegridade(busca, await obterHash(), releaseLegada);
  }
  if (veredito === 'pendente') veredito = 'indisponivel';
  return { baixou: true, veredito };
}

function pickMacDmg(assets, arch) {
  if (!Array.isArray(assets)) return null;
  const alvo = arch === 'arm64' ? 'arm64' : 'x64';
  const dmgs = assets.filter((a) => a && typeof a.name === 'string' && /\.dmg$/i.test(a.name));
  const exato = dmgs.find((a) => a.name.includes(alvo));
  if (exato) return exato;
  return dmgs.find((a) => !/arm64|x64/i.test(a.name)) || null;
}

module.exports = { setupUpdateIpc, pickMacDmg, decidirIntegridade, validarSidecar, releaseSemSidecar, fluxoUpdateMac };
