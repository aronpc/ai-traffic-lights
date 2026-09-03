// preload.js — secure bridge (contextBridge) between the renderer and main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  requestSessions: () => ipcRenderer.send('request-sessions'),
  // Agent usage/reset (Claude via ~/.claude.json, GLM via API). Push from
  // main every 60s + on-demand load. entries: [{agent,title,usedPct,resetAt,...}]
  onUsage: (cb) => ipcRenderer.on('usage', (_e, entries) => cb(entries)),
  requestUsage: () => ipcRenderer.send('request-usage'),
  forceUsage: () => ipcRenderer.send('force-usage'), // bypasses the convenience cache and re-collects now (respects the 429 cooldown)
  onUsageMeta: (cb) => ipcRenderer.on('usage-meta', (_e, meta) => cb(meta)), // {claudeCooldownUntil} — for the force tooltip
  setExpanded: (expanded, h) => ipcRenderer.send('set-expanded', { expanded, h }),
  autoHeight: (h) => ipcRenderer.send('auto-height', h),
  resizeStart: () => ipcRenderer.send('resize-start'),
  resizeMove: (dw, dh) => ipcRenderer.send('resize-move', { dw, dh }),
  // Phase 3:
  focus: (target) => ipcRenderer.send('focus', target),       // click-to-focus {pid, windowid}
  getAliases: () => ipcRenderer.invoke('get-aliases'),        // rename in-place
  setAlias: (key, alias) => ipcRenderer.send('set-alias', { key, alias }),
  setAccountLabel: (accountId, label) => ipcRenderer.send('set-account-label', { accountId, label }), // nickname for the Claude ACCOUNT (multi-account #58)
  notify: (title, body) => ipcRenderer.send('notify', { title, body }), // red alert
  toggleVisibility: () => ipcRenderer.send('toggle-visibility'), // × hides (tray)
  revealOverlay: () => ipcRenderer.send('reveal-overlay'),       // brings to front (transition to red)
  setTrayLevel: (info) => ipcRenderer.send('set-tray-level', info), // dynamic tray: worst color + count
  getLaunchers: () => ipcRenderer.invoke('get-launchers'),          // Quick Launcher: detected agents
  launchAgent: (target) => ipcRenderer.send('launch-agent', target), // {agent, cwd}
  // Settings (idle threshold + shortcut) — read/written by the Preferences window
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getLang: () => ipcRenderer.invoke('get-lang'),              // UI language (en|pt)
  getVersion: () => ipcRenderer.invoke('get-version'),        // Preferences footer
  getRepoUrl: () => ipcRenderer.invoke('get-repo-url'),       // repo link in the footer
  getUpdate: () => ipcRenderer.invoke('get-update'),           // version + newest release (GitHub)
  checkUpdate: () => ipcRenderer.send('check-update'),         // "check now" (ignores the cache)
  downloadUpdate: () => ipcRenderer.send('download-update'),   // AppImage: downloads the new version
  installUpdate: () => ipcRenderer.send('install-update'),     // AppImage: restarts and installs
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)), // push of update state
  openExternal: (url) => ipcRenderer.send('open-external', url), // opens in the browser (http/s only)
  saveSettings: (cfg) => ipcRenderer.send('save-settings', cfg),
  openSettings: () => ipcRenderer.send('open-settings'),
  getSync: () => ipcRenderer.invoke('get-sync'),                 // sync config (P2P) — opt-in
  setSync: (sync) => ipcRenderer.send('set-sync', sync),         // writes only the sync sub-object
  syncAvailable: () => ipcRenderer.invoke('sync-available'),     // sync feature = beta build (Sync tab disappears on stable)
  fetchTranscript: (origin, key, n) => ipcRenderer.invoke('fetch-transcript', { origin, key, n }), // view prompt (local/remote)
  attachRemote: (origin, tmuxSession, cwd, alias, key, label) => ipcRenderer.send('attach-remote', { origin, tmux_session: tmuxSession, cwd, alias, key, label }), // opens in the Terminal window (title = the same label as the row)
  // Terminal window (tabs): pty/ws state lives in main; the renderer only draws.
  // Each method carries tabId to route input/output/resize to the right tab.
  newShell: (host) => ipcRenderer.send('term-new-shell', host),         // host=undefined|'local' → local; otherwise opens a shell on a peer
  termHosts: () => ipcRenderer.invoke('term-hosts'),                    // [{id,label}] local + peers for the + button menu
  termWinControl: (op) => ipcRenderer.send('term-win-control', op),     // 'min' | 'max' | 'close' (custom frameless chrome)
  resizeStartTerm: () => ipcRenderer.send('resize-term-start'),
  resizeMoveTerm: (dw, dh) => ipcRenderer.send('resize-term-move', { dw, dh }),
  resizeEndTerm: () => ipcRenderer.send('resize-term-end'),
  switchTab: (tabId) => ipcRenderer.send('term-switch-tab', tabId),
  closeTab: (tabId) => ipcRenderer.send('term-close-tab', tabId),
  ptyInput: (tabId, data) => ipcRenderer.send('term-input', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('term-resize', { tabId, cols, rows }),
  onPtyOut: (cb) => ipcRenderer.on('pty-out', (_e, p) => cb(p)),            // p = { tabId, data }
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, p) => cb(p)),          // p = { tabId }
  // Read marks (#56): boot sends the whole state; live, each applied mark
  // coming from a peer arrives (POST /read). LWW on the receiver: only applies
  // if readAt > current mark — never downgrades a more recent "read".
  onReadMarks: (cb) => ipcRenderer.on('read-marks', (_e, state) => cb(state)),
  onRemoteRead: (cb) => ipcRenderer.on('remote-read', (_e, m) => cb(m)),    // m = { key, readAt }
  // "Read" click (#56): the renderer paints the optimistic gray RIGHT AWAY and
  // notifies main, which persists and — if the session belongs to a PEER —
  // posts the mark to the origin (key rewritten into its namespace) to
  // propagate it to ALL peers via /sessions.
  markRead: (key, readAt, origin) => ipcRenderer.send('mark-read', { key, readAt, origin }),
  copyText: (text) => ipcRenderer.send('copy-text', text), // row context menu → clipboard (main validates the size)
  // DETACHED details window (#59): the overlay asks to open it by sessionKey;
  // main pushes { s, readAt } to the window on every refresh (s=null = ended);
  // the window's Esc/× request the close (main destroys the BrowserWindow).
  openDetails: (key) => ipcRenderer.send('details-open', { key }),
  onDetailsData: (cb) => ipcRenderer.on('details-data', (_e, p) => cb(p)),
  closeDetails: () => ipcRenderer.send('details-close'),
  onTermTabAdded: (cb) => ipcRenderer.on('term-tab-added', (_e, p) => cb(p)),   // { tabId, title }
  onTermTabRemoved: (cb) => ipcRenderer.on('term-tab-removed', (_e, p) => cb(p)), // { tabId }
  onTermTabActivated: (cb) => ipcRenderer.on('term-tab-activated', (_e, p) => cb(p)), // { tabId } — focuses an existing tab
  onTermMaximized: (cb) => ipcRenderer.on('term-maximized', (_e, v) => cb(v)),        // bool — toggles the .maximized class (removes the radius)
  onTermShown: (cb) => ipcRenderer.on('term-shown', () => cb()),                      // window reappeared → repaint (xterm's canvas was discarded)
  onTermRefit: (cb) => ipcRenderer.on('term-refit', (_e, p) => cb(p)),                // {tabId} — connection (re)established: re-fit + re-sends the size to the pty/ws
  onTermTabTitle: (cb) => ipcRenderer.on('term-tab-title', (_e, p) => cb(p)),        // { tabId, title } — tab rename (syncs with the alias)
  pickSoundFile: () => ipcRenderer.invoke('pick-sound-file'),          // custom sound: native dialog → copies to BASE_DIR/sounds
  getSoundBytes: (file) => ipcRenderer.invoke('get-sound-bytes', file), // custom sound bytes for decoding (Web Audio)
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, cfg) => cb(cfg)),
  // Tray mirror in the Preferences window
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.send('set-autostart', on),
  installHooks: () => ipcRenderer.send('install-hooks'),
  removeHooks: () => ipcRenderer.send('remove-hooks'),
  quit: () => ipcRenderer.send('quit'),
});
