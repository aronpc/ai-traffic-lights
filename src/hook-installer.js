// hook-installer.js — registers/removes the Claude Code adapter in
// ~/.claude/settings.json. Used by the CLI (scripts/setup-hook.js) and by
// the app itself (tray menu) — both when running from source and packaged.
//
// Guarantees:
//  - NEVER touches hooks from other tools (removal is marker-based).
//  - Backs up ~/.claude/settings.json before any write.
//  - Invalid settings.json → throws without writing (never corrupts).
//
// The registered command points to a STABLE COPY of the hook in
// <baseDir>/bin/traffic-hook.sh (see syncHookCopy) — so moving the project
// breaks nothing, and the AppImage (mounted on an ephemeral path) works.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { shellQuote } = require('./validate');
const HOOK_MARKER = 'traffic-hook.sh';       // identifies our entries

// Install targets — each agent with native hooks becomes an entry here.
// The SAME traffic-hook.sh serves them all; AI_TL_AGENT tells the dialect
// (the hook translates events to the contract's canonical vocabulary).
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
    // Claude schema: {type, command} — no name field
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
    // Codex uses the SAME hooks schema as Claude (hooks.json in JSON, same
    // events, same payload) — no dialect translation. Bonus: the `model` field
    // comes straight in the payload. Note: Codex hooks must be trusted via
    // `/hooks` in the CLI before running (trust by hash).
    label: 'Codex',
    settings: path.join(os.homedir(), '.codex', 'hooks.json'),
    detectDir: path.join(os.homedir(), '.codex'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop'],
    command: (dest) => `AI_TL_AGENT=codex bash ${shellQuote(dest)}`,
    entry: (cmd) => ({ type: 'command', command: cmd }),
  },
};

// Is the target present on this machine? (agent's config dir exists)
function available(targetId) {
  try { return fs.existsSync(TARGETS[targetId].detectDir); } catch { return false; }
}

// ---- OpenCode: the adapter is a PLUGIN (JS file in ~/.config/opencode/
// plugin/), not hooks in settings — its own installation mechanics. ----
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
// Auto-update on app boot: only re-copies if the user ALREADY installed.
function syncOpencodeIfInstalled(srcPlugin) {
  try { if (opencodeInstalled()) fs.copyFileSync(srcPlugin, opencodePluginPath()); } catch {}
}

// Copies the packaged/repo hook to <baseDir>/bin and returns the destination.
// Running again updates the copy (idempotent). Works from inside the asar
// (Electron's fs reads asar transparently).
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
  try { fs.copyFileSync(settingsPath, `${settingsPath}.bak.${Date.now()}`); } catch {} // ENOENT: first install
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

// Installs/updates the command in the target's events. Returns {added, updated, wrote}.
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

    // already installed? (in any group) — updates the path if it changed
    let found = null;
    for (const g of groups) for (const h of g.hooks || []) {
      if (h && h.type === 'command' && String(h.command).includes(HOOK_MARKER)) found = h;
    }
    if (found) {
      if (found.command !== hookCmd) { found.command = hookCmd; updated++; }
      continue;
    }

    // adds to the first group without a matcher (does not invade groups with a tool matcher)
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

// Removes all our entries from the target. Returns {removed, wrote}.
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
    // prunes groups left empty (only the ones WE emptied)
    settings.hooks[evt] = settings.hooks[evt].filter((g) => (g.hooks || []).length > 0);
    if (settings.hooks[evt].length === 0) delete settings.hooks[evt];
  }

  const wrote = removed > 0;
  if (wrote) backupAndWrite(target.settings, settings);
  return { removed, wrote };
}

// ---- Kiro CLI: watcher adapter (does not use shell hooks) ----
// Kiro does not expose hooks like Claude Code. The adapter is a JS watcher
// that monitors ~/.kiro/sessions/cli/ — copied to <baseDir>/adapters/kiro/.
const KIRO = {
  label: 'Kiro CLI',
  detectDir: path.join(os.homedir(), '.kiro'),
  sessionsDir: path.join(os.homedir(), '.kiro', 'sessions', 'cli'),
  adapterFile: 'ai-traffic-lights.js',
};
function kiroAdapterDir(baseDir) { return path.join(baseDir, 'adapters', 'kiro'); }
function kiroAdapterPath(baseDir) { return path.join(kiroAdapterDir(baseDir), KIRO.adapterFile); }
function kiroAvailable() {
  // Parity with the adapter's start() guard (~/.kiro/sessions/cli): it used
  // to check only ~/.kiro and the tray reported "Kiro installed/success" even
  // with the watcher unable to observe anything (fresh install with no chat
  // opened yet).
  try { return fs.existsSync(KIRO.sessionsDir); } catch { return false; }
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
