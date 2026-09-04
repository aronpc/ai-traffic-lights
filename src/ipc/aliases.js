// src/ipc/aliases.js — aliases (manual per-session alias) IPC.
// Extracted from main.js (REF step 7). Electron-bound (ipcMain); main injects
// ALIASES_FILE and the side-effect callbacks (sendSessions, onAliasSaved).
//
// Key = session identity (session_id, pid fallback) — the SAME row of the
// overlay, computed in renderer.aliasKey. It used to be the cwd, which made
// two terminals in the same directory share the alias. The module only
// persists the opaque key the renderer sends (anti-path-traversal via length
// validation at the IPC boundary; ALIASES_FILE is an absolute path from main).

function setupAliasesIpc({ ipcMain, ALIASES_FILE, sendSessions, onAliasSaved }) {
  const fs = require('fs');

  function loadAliases() {
    try { return JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')) || {}; } catch { return {}; }
  }
  function saveAlias(key, alias) {
    const a = loadAliases();
    if (alias && alias.trim()) a[key] = alias.trim();
    else delete a[key];
    try { fs.writeFileSync(ALIASES_FILE, JSON.stringify(a)); } catch {}
  }

  // Aliases (per-session alias — key = session_id|pid, see renderer.aliasKey).
  ipcMain.handle('get-aliases', () => loadAliases());
  ipcMain.on('set-alias', (_e, { key, alias }) => {
    // Validates at the IPC boundary: key is the session identity (session_id
    // or pid), alias is a short string. Ignores a malformed payload instead of
    // writing garbage.
    if (typeof key !== 'string' || !key || key.length > 512) return;
    if (alias != null && (typeof alias !== 'string' || alias.length > 256)) return;
    saveAlias(key, alias);
    if (sendSessions) sendSessions();
    if (onAliasSaved) onAliasSaved(key, alias);   // e.g., update the Terminal tab title
  });
}

module.exports = { setupAliasesIpc };
