// src/ipc/devpit.js — devpit IPC (open a session's pane in the devpit desktop
// app). Same shape as the other src/ipc/* modules: Electron-bound glue with
// dependencies INJECTED (ipcMain, execFile, env), so the handler is testable
// without Electron (test/devpit.test.js).
//
// SECURITY: the leaf crosses the renderer→main boundary, so it is revalidated
// here against DEVPIT_LEAF_RE (validate.js) BEFORE any exec. execFile only,
// never a shell: the leaf travels as an argument, never concatenated.

const { DEVPIT_LEAF_RE } = require('../validate.js');
const { cleanEnv } = require('../appimage-env.js');

const DEVPIT_BIN = 'devpit-desktop';

// Opens the pane in devpit. NEVER throws — every failure is a value, so the
// renderer can fall back to the old click behavior (focus the session):
//   {ok:true}                     pane handed to devpit
//   {ok:false, motivo:'invalido'} leaf off the format — nothing was executed
//   {ok:false, motivo:'ausente'}  devpit-desktop not installed (ENOENT)
//   {ok:false, motivo:'erro'}     spawn failed for any other reason
function openDevpit(leaf, { execFile, env } = {}) {
  return new Promise((resolve) => {
    if (typeof leaf !== 'string' || !DEVPIT_LEAF_RE.test(leaf)) {
      resolve({ ok: false, motivo: 'invalido' });
      return;
    }
    if (typeof execFile !== 'function') {
      resolve({ ok: false, motivo: 'erro' });
      return;
    }
    // env scrubbed of the AppImage fingerprint (appimage-env.js): without it
    // a child born from the AppImage inherits PATH/LD_LIBRARY_PATH pointing
    // into the transient mount.
    execFile(DEVPIT_BIN, ['--open-pane', leaf], { env: cleanEnv(env) }, (err) => {
      if (!err) resolve({ ok: true });
      else if (err.code === 'ENOENT') resolve({ ok: false, motivo: 'ausente' });
      else resolve({ ok: false, motivo: 'erro' });
    });
  });
}

function setupDevpitIpc({ ipcMain, execFile, env }) {
  // handle (invoke), not send: the renderer NEEDS the outcome to decide
  // whether to fall back to focusing the session.
  ipcMain.handle('open-devpit', (_e, leaf) => openDevpit(leaf, { execFile, env }));
}

module.exports = { openDevpit, setupDevpitIpc };
