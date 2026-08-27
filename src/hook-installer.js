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

const { shellQuote } = require('./validate');
const HOOK_MARKER = 'traffic-hook.sh';       // identifica entradas nossas

// Alvos de instalação — cada agente com hooks nativos vira uma entrada aqui.
// O MESMO traffic-hook.sh serve todos; o AI_TL_AGENT diz o dialeto (o hook
// traduz eventos pro vocabulário canônico do contrato).
const TARGETS = {
  claude: {
    label: 'Claude Code',
    settings: path.join(os.homedir(), '.claude', 'settings.json'),
    detectDir: path.join(os.homedir(), '.claude'),
    events: [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
      'PostToolUseFailure', 'PermissionRequest', 'Notification',
      'Stop', 'SubagentStop', 'SessionEnd',
    ],
    command: (dest) => `bash ${shellQuote(dest)}`,
    // schema do Claude: {type, command} — sem campo name
    entry: (cmd) => ({ type: 'command', command: cmd }),
  },
  antigravity: {
    label: 'Antigravity CLI',
    settings: path.join(os.homedir(), '.gemini', 'config', 'hooks.json'),
    detectDir: path.join(os.homedir(), '.gemini', 'config'),
    events: ['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop'],
    command: (dest) => `AI_TL_AGENT=antigravity bash ${shellQuote(dest)}`,
  },
  codex: {
    // Codex usa o MESMO schema de hooks do Claude (hooks.json em JSON, mesmos
    // eventos, mesmo payload) — sem tradução de dialeto. Bônus: o campo
    // `model` vem direto no payload. Atenção: hooks do Codex precisam ser
    // confiados via `/hooks` no CLI antes de rodar (trust por hash).
    label: 'Codex',
    settings: path.join(os.homedir(), '.codex', 'hooks.json'),
    detectDir: path.join(os.homedir(), '.codex'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'],
    command: (dest) => `AI_TL_AGENT=codex bash ${shellQuote(dest)}`,
    entry: (cmd) => ({ type: 'command', command: cmd }),
  },
};

// Alvo está presente na máquina? (dir de config do agente existe)
function available(targetId) {
  try { return fs.existsSync(TARGETS[targetId].detectDir); } catch { return false; }
}

// ---- OpenCode: o adapter é um PLUGIN (arquivo JS em ~/.config/opencode/
// plugin/), não hooks em settings — mecânica própria de instalação. ----
const OPENCODE = {
  label: 'OpenCode',
  detectDir: path.join(os.homedir(), '.config', 'opencode'),
  pluginDir: path.join(os.homedir(), '.config', 'opencode', 'plugin'),
  pluginFile: 'ai-traffic-lights.js',
};
function opencodePluginPath() { return path.join(OPENCODE.pluginDir, OPENCODE.pluginFile); }
function opencodeAvailable() {
  try { return fs.existsSync(OPENCODE.detectDir); } catch { return false; }
}
function opencodeInstalled() {
  try { return fs.existsSync(opencodePluginPath()); } catch { return false; }
}
function installOpencode(srcPlugin) {
  const dest = opencodePluginPath();
  const updated = fs.existsSync(dest);
  fs.mkdirSync(OPENCODE.pluginDir, { recursive: true });
  fs.copyFileSync(srcPlugin, dest);
  return { dest, updated, wrote: true };
}
function removeOpencode() {
  try {
    if (fs.existsSync(opencodePluginPath())) { fs.unlinkSync(opencodePluginPath()); return { removed: 1, wrote: true }; }
  } catch {}
  return { removed: 0, wrote: false };
}
// Auto-atualização no boot do app: só re-copia se o usuário JÁ instalou.
function syncOpencodeIfInstalled(srcPlugin) {
  try { if (opencodeInstalled()) fs.copyFileSync(srcPlugin, opencodePluginPath()); } catch {}
}

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

function load(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${settingsPath} existe mas não é JSON válido — corrija-o antes.`);
  }
}

function backupAndWrite(settingsPath, settings) {
  try { fs.copyFileSync(settingsPath, `${settingsPath}.bak.${Date.now()}`); } catch {} // ENOENT: 1ª instalação
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function installAntigravityHooks(target, hookDest) {
  const settings = load(target.settings);
  const hookCmd = target.command(hookDest);
  settings['ai-traffic-lights'] = settings['ai-traffic-lights'] || {};
  const hookGroup = settings['ai-traffic-lights'];
  let added = 0, updated = 0;
  for (const evt of target.events) {
    hookGroup[evt] = hookGroup[evt] || [];
    let found = hookGroup[evt].find(h => h && h.type === 'command' && String(h.command).includes(HOOK_MARKER));
    if (found) {
      if (found.command !== hookCmd) { found.command = hookCmd; updated++; }
    } else {
      hookGroup[evt].push({ type: 'command', command: hookCmd });
      added++;
    }
  }
  const wrote = added > 0 || updated > 0;
  if (wrote) backupAndWrite(target.settings, settings);
  return { added, updated, wrote, skipped: [] };
}

function removeAntigravityHooks(target) {
  const settings = load(target.settings);
  if (!settings['ai-traffic-lights']) return { removed: 0, wrote: false };
  let removed = 0;
  const hookGroup = settings['ai-traffic-lights'];
  for (const evt of Object.keys(hookGroup)) {
    if (!Array.isArray(hookGroup[evt])) continue;
    const before = hookGroup[evt].length;
    hookGroup[evt] = hookGroup[evt].filter(h => !(h && h.type === 'command' && String(h.command).includes(HOOK_MARKER)));
    removed += before - hookGroup[evt].length;
    if (hookGroup[evt].length === 0) delete hookGroup[evt];
  }
  if (Object.keys(hookGroup).length === 0) {
    delete settings['ai-traffic-lights'];
  }
  const wrote = removed > 0;
  if (wrote) backupAndWrite(target.settings, settings);
  return { removed, wrote };
}

// Instala/atualiza o comando nos eventos do alvo. Retorna {added, updated, wrote}.
function install(targetId, hookDest) {
  const target = TARGETS[targetId];
  if (targetId === 'antigravity') {
    return installAntigravityHooks(target, hookDest);
  }
  const hookCmd = target.command(hookDest);
  const settings = load(target.settings);
  settings.hooks = settings.hooks || {};
  let added = 0, updated = 0;
  const skipped = [];

  for (const evt of target.events) {
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
    group.hooks.push(target.entry(hookCmd));
    added++;
  }

  const wrote = added > 0 || updated > 0;
  if (wrote) backupAndWrite(target.settings, settings);
  return { added, updated, wrote, skipped };
}

// Remove todas as entradas nossas do alvo. Retorna {removed, wrote}.
function remove(targetId) {
  const target = TARGETS[targetId];
  if (targetId === 'antigravity') {
    return removeAntigravityHooks(target);
  }
  const settings = load(target.settings);
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
  if (wrote) backupAndWrite(target.settings, settings);
  return { removed, wrote };
}

// ---- Kiro CLI: adapter de watcher (não usa hooks de shell) ----
// O Kiro não expõe hooks como o Claude Code. O adapter é um watcher JS que
// monitora ~/.kiro/sessions/cli/ — copiado para <baseDir>/adapters/kiro/.
const KIRO = {
  label: 'Kiro CLI',
  detectDir: path.join(os.homedir(), '.kiro'),
  sessionsDir: path.join(os.homedir(), '.kiro', 'sessions', 'cli'),
  adapterFile: 'ai-traffic-lights.js',
};
function kiroAdapterDir(baseDir) { return path.join(baseDir, 'adapters', 'kiro'); }
function kiroAdapterPath(baseDir) { return path.join(kiroAdapterDir(baseDir), KIRO.adapterFile); }
function kiroAvailable() {
  try { return fs.existsSync(KIRO.detectDir); } catch { return false; }
}
function kiroInstalled(baseDir) {
  try { return fs.existsSync(kiroAdapterPath(baseDir)); } catch { return false; }
}
function installKiro(srcAdapter, baseDir) {
  const dest = kiroAdapterPath(baseDir);
  const updated = fs.existsSync(dest);
  fs.mkdirSync(kiroAdapterDir(baseDir), { recursive: true });
  fs.copyFileSync(srcAdapter, dest);
  return { dest, updated, wrote: true };
}
function removeKiro(baseDir) {
  try {
    const p = kiroAdapterPath(baseDir);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return { removed: 1, wrote: true }; }
  } catch {}
  return { removed: 0, wrote: false };
}
function syncKiroIfInstalled(srcAdapter, baseDir) {
  try { if (kiroInstalled(baseDir)) fs.copyFileSync(srcAdapter, kiroAdapterPath(baseDir)); } catch {}
}

module.exports = {
  TARGETS, HOOK_MARKER, available, syncHookCopy, install, remove,
  OPENCODE, opencodeAvailable, opencodeInstalled, installOpencode, removeOpencode, syncOpencodeIfInstalled,
  KIRO, kiroAvailable, kiroInstalled, installKiro, removeKiro, syncKiroIfInstalled,
};
