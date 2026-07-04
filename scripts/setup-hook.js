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
    const r = installer.remove();
    console.log(r.removed
      ? `✓ hook removido (${r.removed} entradas). State files antigos são limpos pelo próprio overlay.`
      : '✓ nada instalado.');
  } else {
    preflight();
    const dest = installer.syncHookCopy(path.resolve(__dirname, '..', 'hooks', 'traffic-hook.sh'), BASE_DIR);
    const r = installer.install(`bash ${dest}`);
    if (r.skipped.length) console.warn(`⚠ eventos com formato inesperado, pulados: ${r.skipped.join(', ')}`);
    if (!r.wrote) {
      console.log('✓ hook já instalado e atualizado — nada a fazer.');
    } else {
      console.log(`✓ hook instalado (${r.added} eventos adicionados, ${r.updated} caminhos atualizados).`);
      console.log(`  Comando registrado: bash ${dest}`);
      console.log('  Sessões novas do Claude Code aparecem no semáforo imediatamente;');
      console.log('  sessões já abertas, a partir do próximo evento delas.');
    }
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
