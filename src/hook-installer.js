// hook-installer.js — registra/remove o adapter do Claude Code no
// ~/.claude/settings.json. Usado pelo CLI (scripts/setup-hook.js) e pelo
// próprio app (menu do tray) — tanto rodando do fonte quanto empacotado.
//
// Garantias:
//  - NUNCA toca em hooks de outras ferramentas (remoção é por marcador).
//  - Backup de ~/.claude/settings.json antes de qualquer escrita.
//  - settings.json inválido → lança erro sem escrever (nunca corrompe).
//
// O comando registrado aponta para uma CÓPIA estável do hook em
// <baseDir>/bin/traffic-hook.sh (ver syncHookCopy) — assim mover o projeto
// não quebra nada, e o AppImage (montado em path efêmero) funciona.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_MARKER = 'traffic-hook.sh';       // identifica entradas nossas
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Eventos que alimentam o semáforo (mapeamento em src/state-machine.js).
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Notification',
  'Stop', 'SubagentStop', 'SessionEnd',
];

// Copia o hook empacotado/do repo para <baseDir>/bin e retorna o destino.
// Rodar de novo atualiza a cópia (idempotente). Funciona de dentro do asar
// (o fs do Electron lê asar transparentemente).
function syncHookCopy(srcHook, baseDir) {
  const dir = path.join(baseDir, 'bin');
  const dest = path.join(dir, 'traffic-hook.sh');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(srcHook, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function load() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${SETTINGS} existe mas não é JSON válido — corrija-o antes.`);
  }
}

function backupAndWrite(settings) {
  try { fs.copyFileSync(SETTINGS, `${SETTINGS}.bak.${Date.now()}`); } catch {} // ENOENT: 1ª instalação
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

// Instala/atualiza o comando em todos os EVENTS. Retorna {added, updated, wrote}.
function install(hookCmd) {
  const settings = load();
  settings.hooks = settings.hooks || {};
  let added = 0, updated = 0;
  const skipped = [];

  for (const evt of EVENTS) {
    if (settings.hooks[evt] && !Array.isArray(settings.hooks[evt])) {
      skipped.push(evt);
      continue;
    }
    const groups = (settings.hooks[evt] = settings.hooks[evt] || []);

    // já instalado? (em qualquer grupo) — atualiza o caminho se mudou
    let found = null;
    for (const g of groups) for (const h of g.hooks || []) {
      if (h && h.type === 'command' && String(h.command).includes(HOOK_MARKER)) found = h;
    }
    if (found) {
      if (found.command !== hookCmd) { found.command = hookCmd; updated++; }
      continue;
    }

    // adiciona no primeiro grupo sem matcher (não invade grupos com matcher de tool)
    let group = groups.find((g) => !g.matcher);
    if (!group) { group = { matcher: '', hooks: [] }; groups.push(group); }
    group.hooks = group.hooks || [];
    group.hooks.push({ type: 'command', command: hookCmd });
    added++;
  }

  const wrote = added > 0 || updated > 0;
  if (wrote) backupAndWrite(settings);
  return { added, updated, wrote, skipped };
}

// Remove todas as entradas nossas. Retorna {removed, wrote}.
function remove() {
  const settings = load();
  if (!settings.hooks) return { removed: 0, wrote: false };
  let removed = 0;

  for (const evt of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[evt])) continue;
    for (const g of settings.hooks[evt]) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !(h && h.type === 'command' && String(h.command).includes(HOOK_MARKER)));
      removed += before - g.hooks.length;
    }
    // poda grupos que ficaram vazios (só os que NÓS esvaziamos)
    settings.hooks[evt] = settings.hooks[evt].filter((g) => (g.hooks || []).length > 0);
    if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }

  const wrote = removed > 0;
  if (wrote) backupAndWrite(settings);
  return { removed, wrote };
}

module.exports = { EVENTS, HOOK_MARKER, SETTINGS, syncHookCopy, install, remove };
