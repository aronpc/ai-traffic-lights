// src/ipc/account-labels.js — manual label per Claude ACCOUNT (multi-account,
// #58).
// Extracted following the aliases.js pattern (REF step 7): the renderer sends
// the accountId (the bar's stable sfx — sha256-6 of the uuid) and the label;
// main resolves the persistence key (accountUuid, dir fallback) via
// lastAccountIds — filled on every collect by claudeAccountsFromSessions —
// writes to account-labels.json and re-collects so the bar reflects the new
// label immediately. The renderer NEVER sees the uuid or the email; the
// opaque key is resolved only here.
//
// The per-uuid key (not per-dir) lets the label survive a profile rename on
// disk (dd-claude renames dirs); the dir fallback covers accounts whose
// .claude.json has no accountUuid (legacy).

function setupAccountLabelsIpc({ ipcMain, ACCOUNT_LABELS_FILE, getLastAccountIds, recollect }) {
  const fs = require('fs');
  // tmp+rename (state-writer pattern): an interrupted writeFileSync leaves a
  // half-written JSON and every reader silently falls back to {} — ALL
  // nicknames gone. atomicWrite already cleans up its .tmp on failure.
  const { atomicWrite } = require('../state-writer.js');

  function loadLabels() {
    try { return JSON.parse(fs.readFileSync(ACCOUNT_LABELS_FILE, 'utf8')) || {}; } catch { return {}; }
  }
  function saveLabel(key, label) {
    const all = loadLabels();
    if (label && label.trim()) all[key] = label.trim();
    else delete all[key];
    atomicWrite(ACCOUNT_LABELS_FILE, all, fs);
  }

  // Label of the ACCOUNT (multi-account #58 — dblclick on the bar's name).
  // `payload || {}`: a destructuring default doesn't cover null (only
  // undefined) — a null payload from a malformed renderer is ignored, not an
  // exception.
  ipcMain.on('set-account-label', (_e, payload) => {
    const { accountId, label } = payload || {};
    // Validates at the IPC boundary: accountId is the bar's sfx (hex-6),
    // label is a short string. A malformed payload is ignored, not saved.
    if (typeof accountId !== 'string' || !/^[0-9a-f]{1,64}$/.test(accountId)) return;
    if (label != null && (typeof label !== 'string' || label.length > 64)) return;
    const ids = getLastAccountIds() || {};
    const key = ids[accountId];
    if (!key) return;   // unknown sfx: account vanished/closed since the last render — ignore
    saveLabel(key, label);
    if (recollect) recollect();
  });
}

module.exports = { setupAccountLabelsIpc };
