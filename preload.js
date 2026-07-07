// preload.js — ponte segura (contextBridge) entre o renderer e o main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  requestSessions: () => ipcRenderer.send('request-sessions'),
  // Consumo/reset dos agentes (Claude via ~/.claude.json, GLM via API). Push do
  // main a cada 60s + carga sob demanda. entries: [{agent,title,usedPct,resetAt,...}]
  onUsage: (cb) => ipcRenderer.on('usage', (_e, entries) => cb(entries)),
  requestUsage: () => ipcRenderer.send('request-usage'),
  setExpanded: (expanded, h) => ipcRenderer.send('set-expanded', { expanded, h }),
  autoHeight: (h) => ipcRenderer.send('auto-height', h),
  resizeStart: () => ipcRenderer.send('resize-start'),
  resizeMove: (dw, dh) => ipcRenderer.send('resize-move', { dw, dh }),
  // Fase 3:
  focus: (target) => ipcRenderer.send('focus', target),       // click-to-focus {pid, windowid}
  getAliases: () => ipcRenderer.invoke('get-aliases'),        // rename in-place
  setAlias: (cwd, alias) => ipcRenderer.send('set-alias', { cwd, alias }),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }), // alerta vermelho
  toggleVisibility: () => ipcRenderer.send('toggle-visibility'), // × esconde (tray)
  setTrayLevel: (info) => ipcRenderer.send('set-tray-level', info), // tray dinâmico: pior cor + contagem
  getLaunchers: () => ipcRenderer.invoke('get-launchers'),          // Quick Launcher: agentes detectados
  launchAgent: (target) => ipcRenderer.send('launch-agent', target), // {agent, cwd}
  // Settings (threshold de idle + atalho) — lidos/gravados pela janela de Preferências
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getLang: () => ipcRenderer.invoke('get-lang'),              // idioma da UI (en|pt)
  getVersion: () => ipcRenderer.invoke('get-version'),        // rodapé das Preferências
  getRepoUrl: () => ipcRenderer.invoke('get-repo-url'),       // link do repo no rodapé
  getUpdate: () => ipcRenderer.invoke('get-update'),           // versão + release mais nova (GitHub)
  openExternal: (url) => ipcRenderer.send('open-external', url), // abre no navegador (http/s só)
  saveSettings: (cfg) => ipcRenderer.send('save-settings', cfg),
  openSettings: () => ipcRenderer.send('open-settings'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, cfg) => cb(cfg)),
  // Espelho do tray na janela de Preferências
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.send('set-autostart', on),
  installHooks: () => ipcRenderer.send('install-hooks'),
  removeHooks: () => ipcRenderer.send('remove-hooks'),
  quit: () => ipcRenderer.send('quit'),
});
