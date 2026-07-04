// preload.js — ponte segura (contextBridge) entre o renderer e o main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  onSessions: (cb) => ipcRenderer.on('sessions', (_e, sessions) => cb(sessions)),
  requestSessions: () => ipcRenderer.send('request-sessions'),
  setExpanded: (expanded) => ipcRenderer.send('set-expanded', expanded),
  autoHeight: (h) => ipcRenderer.send('auto-height', h),
  resizeStart: () => ipcRenderer.send('resize-start'),
  resizeMove: (dw, dh) => ipcRenderer.send('resize-move', { dw, dh }),
  // Fase 3:
  focus: (target) => ipcRenderer.send('focus', target),       // click-to-focus {pid, windowid}
  getAliases: () => ipcRenderer.invoke('get-aliases'),        // rename in-place
  setAlias: (cwd, alias) => ipcRenderer.send('set-alias', { cwd, alias }),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }), // alerta vermelho
  toggleVisibility: () => ipcRenderer.send('toggle-visibility'), // × esconde (tray)
});
