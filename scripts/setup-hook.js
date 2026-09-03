#!/usr/bin/env node
// setup-hook.js — CLI installer for the Claude Code adapter.
//
//   npm run setup-hook    → installs (idempotent; updates the path if it changed)
//   npm run remove-hook   → removes only this project's entries
//
// The logic lives in src/hook-installer.js (shared with the tray menu).
// The registered command points to the stable hook copy in
// ~/.local/share/ai-traffic-lights/bin/ — moving the project breaks nothing.

const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const installer = require('../src/hook-installer');

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
const BASE_DIR = path.join(DATA_HOME, 'ai-traffic-lights');

function preflight() {
  const missing = [];
  for (const bin of ['jq', 'wmctrl', 'xdotool']) {
    try { execFileSync('which', [bin], { stdio: 'ignore' }); }
    catch { missing.push(bin); }
  }
  if (missing.length) {
    console.warn(`⚠ dependências ausentes: ${missing.join(', ')}`);
    console.warn(`  Ubuntu/Debian: sudo apt install ${missing.join(' ')}`);
    if (missing.includes('jq')) {
      console.error('✗ jq é obrigatório — o hook não grava state files sem ele.');
      process.exit(1);
    }
  }
}

const OPENCODE_PLUGIN_SRC = path.resolve(__dirname, '..', 'adapters', 'opencode', 'ai-traffic-lights.js');
const KIRO_ADAPTER_SRC = path.resolve(__dirname, '..', 'adapters', 'kiro', 'ai-traffic-lights.js');

try {
  if (process.argv.includes('--remove')) {
    for (const id of Object.keys(installer.TARGETS)) {
      const t = installer.TARGETS[id];
      const r = installer.remove(id);
      console.log(r.removed
        ? `✓ ${t.label}: hook removido (${r.removed} entradas).`
        : `✓ ${t.label}: nada instalado.`);
    }
    const ro = installer.removeOpencode();
    console.log(ro.removed ? '✓ OpenCode: plugin removido.' : '✓ OpenCode: nada instalado.');
    const rk = installer.removeKiro(BASE_DIR);
    console.log(rk.removed ? '✓ Kiro: adapter removido.' : '✓ Kiro: nada instalado.');
    console.log('  State files antigos são limpos pelo próprio overlay.');
  } else {
    preflight();
    const dest = installer.syncHookCopy(path.resolve(__dirname, '..', 'hooks', 'traffic-hook.sh'), BASE_DIR);
    for (const id of Object.keys(installer.TARGETS)) {
      const t = installer.TARGETS[id];
      if (!installer.available(id)) {
        console.log(`- ${t.label}: ${t.detectDir} não existe — pulado.`);
        continue;
      }
      const r = installer.install(id, dest);
      if (r.skipped.length) console.warn(`⚠ ${t.label}: eventos com formato inesperado, pulados: ${r.skipped.join(', ')}`);
      console.log(!r.wrote
        ? `✓ ${t.label}: já instalado e atualizado.`
        : `✓ ${t.label}: instalado (${r.added} eventos, ${r.updated} caminhos atualizados).`);
    }
    // OpenCode: the adapter is a plugin (JS file), not hooks in settings
    if (installer.opencodeAvailable()) {
      const ro = installer.installOpencode(OPENCODE_PLUGIN_SRC);
      console.log(`✓ OpenCode: plugin ${ro.updated ? 'atualizado' : 'instalado'} em ${ro.dest}`);
      console.log('  (sessões OpenCode já abertas precisam reiniciar para carregar o plugin)');
    } else {
      console.log(`- OpenCode: ${installer.OPENCODE.detectDir} não existe — pulado.`);
    }
    // Kiro: the adapter is a file watcher loaded by the overlay itself.
    // The gate is ~/.kiro/sessions/cli (parity with the adapter's start()):
    // without that directory there is nothing to watch, and saying "installed"
    // would be a lie.
    if (installer.kiroAvailable()) {
      const rk = installer.installKiro(KIRO_ADAPTER_SRC, BASE_DIR);
      console.log(`✓ Kiro: adapter ${rk.updated ? 'atualizado' : 'instalado'} em ${rk.dest}`);
      console.log('  (o watcher sobe junto com o overlay — reinicie-o para começar a observar)');
    } else {
      console.log(`- Kiro: ${installer.KIRO.sessionsDir} não existe — pulado.`);
    }
    console.log(`  Cópia do hook: ${dest}`);
    console.log('  Sessões novas aparecem no semáforo imediatamente; as já abertas, no próximo evento.');
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
