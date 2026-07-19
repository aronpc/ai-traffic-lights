// src/ipc/aliases.js — aliases (apelido manual por sessão) IPC.
// Extraído do main.js (REF passo 7). Electron-bound (ipcMain); o main injeta
// ALIASES_FILE e os callbacks de side-effect (sendSessions, onAliasSaved).
//
// Chave = identidade da sessão (session_id, fallback pid) — a MESMA linha do
// overlay, calculada em renderer.aliasKey. Antes era o cwd, o que fazia dois
// terminais no mesmo diretório compartilharem o apelido. O módulo só persiste a
// chave opaca que o renderer manda (anti-path-traversal via validação de tamanho
// no limite IPC; ALIASES_FILE é path absoluto do main).

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

  // Aliases (apelido por sessão — chave = session_id|pid, ver renderer.aliasKey).
  ipcMain.handle('get-aliases', () => loadAliases());
  ipcMain.on('set-alias', (_e, { key, alias }) => {
    // valida no limite IPC: key é a identidade da sessão (session_id ou pid),
    // alias é string curta. Ignora payload malformado em vez de gravar lixo.
    if (typeof key !== 'string' || !key || key.length > 512) return;
    if (alias != null && (typeof alias !== 'string' || alias.length > 256)) return;
    saveAlias(key, alias);
    if (sendSessions) sendSessions();
    if (onAliasSaved) onAliasSaved(key, alias);   // ex.: atualizar título da aba Terminal
  });
}

module.exports = { setupAliasesIpc };
