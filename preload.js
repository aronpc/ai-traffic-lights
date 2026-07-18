// preload.js — ponte segura (contextBridge) entre o renderer e o main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  requestSessions: () => ipcRenderer.send('request-sessions'),
  // Consumo/reset dos agentes (Claude via ~/.claude.json, GLM via API). Push do
  // main a cada 60s + carga sob demanda. entries: [{agent,title,usedPct,resetAt,...}]
  onUsage: (cb) => ipcRenderer.on('usage', (_e, entries) => cb(entries)),
  requestUsage: () => ipcRenderer.send('request-usage'),
  forceUsage: () => ipcRenderer.send('force-usage'), // fura o cache de conveniência e recoleta já (respeita o cooldown do 429)
  onUsageMeta: (cb) => ipcRenderer.on('usage-meta', (_e, meta) => cb(meta)), // {claudeCooldownUntil} — p/ o tooltip do force
  setExpanded: (expanded, h) => ipcRenderer.send('set-expanded', { expanded, h }),
  autoHeight: (h) => ipcRenderer.send('auto-height', h),
  resizeStart: () => ipcRenderer.send('resize-start'),
  resizeMove: (dw, dh) => ipcRenderer.send('resize-move', { dw, dh }),
  // Fase 3:
  focus: (target) => ipcRenderer.send('focus', target),       // click-to-focus {pid, windowid}
  getAliases: () => ipcRenderer.invoke('get-aliases'),        // rename in-place
  setAlias: (key, alias) => ipcRenderer.send('set-alias', { key, alias }),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }), // alerta vermelho
  toggleVisibility: () => ipcRenderer.send('toggle-visibility'), // × esconde (tray)
  revealOverlay: () => ipcRenderer.send('reveal-overlay'),       // traz à frente (transição p/ vermelho)
  setTrayLevel: (info) => ipcRenderer.send('set-tray-level', info), // tray dinâmico: pior cor + contagem
  getLaunchers: () => ipcRenderer.invoke('get-launchers'),          // Quick Launcher: agentes detectados
  launchAgent: (target) => ipcRenderer.send('launch-agent', target), // {agent, cwd}
  // Settings (threshold de idle + atalho) — lidos/gravados pela janela de Preferências
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getLang: () => ipcRenderer.invoke('get-lang'),              // idioma da UI (en|pt)
  getVersion: () => ipcRenderer.invoke('get-version'),        // rodapé das Preferências
  getRepoUrl: () => ipcRenderer.invoke('get-repo-url'),       // link do repo no rodapé
  getUpdate: () => ipcRenderer.invoke('get-update'),           // versão + release mais nova (GitHub)
  checkUpdate: () => ipcRenderer.send('check-update'),         // "verificar agora" (ignora o cache)
  downloadUpdate: () => ipcRenderer.send('download-update'),   // AppImage: baixa a nova versão
  installUpdate: () => ipcRenderer.send('install-update'),     // AppImage: reinicia e instala
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)), // push do estado de update
  openExternal: (url) => ipcRenderer.send('open-external', url), // abre no navegador (http/s só)
  saveSettings: (cfg) => ipcRenderer.send('save-settings', cfg),
  openSettings: () => ipcRenderer.send('open-settings'),
  getSync: () => ipcRenderer.invoke('get-sync'),                 // config sync (P2P) — opt-in
  setSync: (sync) => ipcRenderer.send('set-sync', sync),         // grava só o sub-objeto sync
  fetchTranscript: (origin, key, n) => ipcRenderer.invoke('fetch-transcript', { origin, key, n }), // ver prompt (local/remote)
  attachRemote: (origin, tmuxSession, cwd, alias, key) => ipcRenderer.send('attach-remote', { origin, tmux_session: tmuxSession, cwd, alias, key }), // abre na janela Terminal (título = alias)
  // janela Terminal (abas): o estado dos pty/ws vive no main; o renderer só desenha.
  // Cada método carrega tabId p/ rotear input/output/resize à aba certa.
  newShell: (host) => ipcRenderer.send('term-new-shell', host),         // host=undefined|'local' → local; senão abre shell num peer
  termHosts: () => ipcRenderer.invoke('term-hosts'),                    // [{id,label}] local + peers p/ o menu do botão +
  termWinControl: (op) => ipcRenderer.send('term-win-control', op),     // 'min' | 'max' | 'close' (chrome custom frameless)
  resizeStartTerm: () => ipcRenderer.send('resize-term-start'),
  resizeMoveTerm: (dw, dh) => ipcRenderer.send('resize-term-move', { dw, dh }),
  resizeEndTerm: () => ipcRenderer.send('resize-term-end'),
  switchTab: (tabId) => ipcRenderer.send('term-switch-tab', tabId),
  closeTab: (tabId) => ipcRenderer.send('term-close-tab', tabId),
  ptyInput: (tabId, data) => ipcRenderer.send('term-input', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('term-resize', { tabId, cols, rows }),
  onPtyOut: (cb) => ipcRenderer.on('pty-out', (_e, p) => cb(p)),            // p = { tabId, data }
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, p) => cb(p)),          // p = { tabId }
  onTermTabAdded: (cb) => ipcRenderer.on('term-tab-added', (_e, p) => cb(p)),   // { tabId, title }
  onTermTabRemoved: (cb) => ipcRenderer.on('term-tab-removed', (_e, p) => cb(p)), // { tabId }
  onTermTabActivated: (cb) => ipcRenderer.on('term-tab-activated', (_e, p) => cb(p)), // { tabId } — foca aba existente
  onTermMaximized: (cb) => ipcRenderer.on('term-maximized', (_e, v) => cb(v)),        // bool — alterna classe .maximized (tira o radius)
  onTermTabTitle: (cb) => ipcRenderer.on('term-tab-title', (_e, p) => cb(p)),        // { tabId, title } — rename da aba (sincroniza c/ o alias)
  pickSoundFile: () => ipcRenderer.invoke('pick-sound-file'),          // som custom: diálogo nativo → copia p/ BASE_DIR/sounds
  getSoundBytes: (file) => ipcRenderer.invoke('get-sound-bytes', file), // bytes do som custom p/ decodificar (Web Audio)
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, cfg) => cb(cfg)),
  // Espelho do tray na janela de Preferências
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.send('set-autostart', on),
  installHooks: () => ipcRenderer.send('install-hooks'),
  removeHooks: () => ipcRenderer.send('remove-hooks'),
  quit: () => ipcRenderer.send('quit'),
});
