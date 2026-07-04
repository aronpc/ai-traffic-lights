#!/usr/bin/env node
// setup-hook.js — CLI do instalador do adapter Claude Code.
//
//   npm run setup-hook    → instala (idempotente; atualiza caminho se mudou)
//   npm run remove-hook   → remove só as entradas deste projeto
//
// A lógica vive em src/hook-installer.js (compartilhada com o menu do tray).
// O comando registrado aponta para a cópia estável do hook em
// ~/.local/share/ai-traffic-lights/bin/ — mover o projeto não quebra nada.

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

try {
  if (process.argv.includes('--remove')) {
    for (const id of Object.keys(installer.TARGETS)) {
      const t = installer.TARGETS[id];
      const r = installer.remove(id);
      console.log(r.removed
        ? `✓ ${t.label}: hook removido (${r.removed} entradas).`
        : `✓ ${t.label}: nada instalado.`);
    }
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
    console.log(`  Cópia do hook: ${dest}`);
    console.log('  Sessões novas aparecem no semáforo imediatamente; as já abertas, no próximo evento.');
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
