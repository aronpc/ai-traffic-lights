// src/ipc/account-labels.js — apelido manual por CONTA Claude (multi-conta, #58).
// Extraído no padrão do aliases.js (REF passo 7): o renderer manda o accountId
// (sfx estável da barra — sha256-6 do uuid) e o label; o main resolve a chave
// de persistência (accountUuid, fallback dir) via lastAccountIds — preenchido a
// cada coleta por claudeAccountsFromSessions — grava em account-labels.json e
// re-coleta para a barra refletir o rótulo novo na hora. O renderer NUNCA vê o
// uuid nem o email; a chave opaca é resolvida só aqui.
//
// A chave por uuid (não por dir) faz o apelido sobreviver à troca de nome do
// perfil no disco (dd-claude renomeia dirs); o fallback dir cobre contas cujo
// .claude.json não tem accountUuid (legado).

function setupAccountLabelsIpc({ ipcMain, ACCOUNT_LABELS_FILE, getLastAccountIds, recollect }) {
  const fs = require('fs');

  function loadLabels() {
    try { return JSON.parse(fs.readFileSync(ACCOUNT_LABELS_FILE, 'utf8')) || {}; } catch { return {}; }
  }
  function saveLabel(key, label) {
    const all = loadLabels();
    if (label && label.trim()) all[key] = label.trim();
    else delete all[key];
    try { fs.writeFileSync(ACCOUNT_LABELS_FILE, JSON.stringify(all)); } catch {}
  }

  // Apelido da CONTA (multi-conta #58 — dblclick no nome da barra).
  // `payload || {}`: default de desestructuring não cobre null (só undefined)
  // — payload nulo do renderer malformado é ignorado, não exceção.
  ipcMain.on('set-account-label', (_e, payload) => {
    const { accountId, label } = payload || {};
    // Valida no limite IPC: accountId é o sfx da barra (hex-6), label é string
    // curta. Payload malformado é ignorado, não gravado.
    if (typeof accountId !== 'string' || !/^[0-9a-f]{1,64}$/.test(accountId)) return;
    if (label != null && (typeof label !== 'string' || label.length > 64)) return;
    const ids = getLastAccountIds() || {};
    const key = ids[accountId];
    if (!key) return;   // sfx desconhecido: conta sumiu/fechou desde o último render — ignora
    saveLabel(key, label);
    if (recollect) recollect();
  });
}

module.exports = { setupAccountLabelsIpc };
