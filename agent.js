#!/usr/bin/env node
// agent.js — modo HEADLESS do sync (fase 4). Node PURO, SEM require('electron').
//
// Para um servidor Linux sem display (ex.: loja-mqx) participar do mesh como
// FONTE: sobe o servidor /sessions (/transcript) na localhost e expõe as sessões
// locais via o MESMO core da GUI (collect.js/net.js/identity.js/transcript.js) —
// sem duplicar lógica. Roda como daemon (systemd); logs em stdout (journald).
//
// O servidor escuta em 127.0.0.1 — o ingress da tailnet é o `tailscale serve`
// (igual à GUI). Config vem do settings.json do ATL; overrides por env (útil num
// servidor sem GUI pra editar o JSON): ATL_SYNC_TOKEN / ATL_SYNC_ENABLED=1 /
// ATL_SYNC_SHARE=1 / ATL_SYNC_SHARE_TR=1 / ATL_SYNC_PORT / ATL_SYNC_NODE.
//
// Deploy (systemd): ver scripts/atl-agent.service. Rápido (manual):
//   ATL_SYNC_TOKEN=xxx ATL_SYNC_ENABLED=1 ATL_SYNC_SHARE=1 node agent.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const collect = require('./src/collect');
const net = require('./src/net');
const transcript = require('./src/transcript');
const settingsLib = require('./src/settings');

const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
const SETTINGS_FILE = path.join(DATA_HOME, 'ai-traffic-lights', 'settings.json');

function loadSettings() {
  try { return settingsLib.mergeWithDefaults(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch { return settingsLib.mergeWithDefaults(null); }   // sem arquivo → defaults (sync OFF)
}

const ENV_BOOL = (v) => v === '1' || v === 'true';
// Overrides por env (servidor sem GUI p/ editar settings.json). Só sobrescreve
// se a var estiver DEFINIDA — settings.json continua válido no resto.
function applyEnvOverrides(s) {
  if (process.env.ATL_SYNC_TOKEN != null) s.token = String(process.env.ATL_SYNC_TOKEN);
  if (process.env.ATL_SYNC_ENABLED != null) s.enabled = ENV_BOOL(process.env.ATL_SYNC_ENABLED);
  if (process.env.ATL_SYNC_SHARE != null) s.share = ENV_BOOL(process.env.ATL_SYNC_SHARE);
  if (process.env.ATL_SYNC_SHARE_TR != null) s.shareTranscripts = ENV_BOOL(process.env.ATL_SYNC_SHARE_TR);
  if (process.env.ATL_SYNC_ALLOW_ATTACH != null) s.allowAttach = ENV_BOOL(process.env.ATL_SYNC_ALLOW_ATTACH);
  if (process.env.ATL_SYNC_PORT != null) { const p = parseInt(process.env.ATL_SYNC_PORT, 10); if (p > 0) s.port = p; }
  if (process.env.ATL_SYNC_NODE != null) s.node = String(process.env.ATL_SYNC_NODE);
  return s;
}

function log(fmt, ...a) { try { console.log('[agent] ' + fmt, ...a); } catch {} }

// factory node-pty p/ o endpoint /pty (attach remoto). Headless: pode falhar ao
// carregar (ABI node≠electron) — aí ptySpawn fica undefined e o /pty não sobe.
let ptyLib = null;
try { ptyLib = require('node-pty'); } catch (e) { log('node-pty indisponível: %s', e.message); }
function createPty(cmd, cols, rows, { onData, onExit }) {
  if (!ptyLib) throw new Error('node-pty indisponível');
  const p = ptyLib.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: process.env.HOME, env: process.env });
  p.onData(onData); p.onExit(onExit);
  return { write: (d) => { try { p.write(d); } catch {} }, resize: (c, r) => { try { p.resize(c, r); } catch {} }, kill: () => { try { p.kill(); } catch {} } };
}

const cfg = loadSettings();
const sync = applyEnvOverrides({ ...(cfg.sync || {}) });
const nodeName = sync.node || os.hostname() || 'local';

let server = null;
function start() {
  if (!sync.enabled) { log('sync desabilitado (settings/ATL_SYNC_ENABLED). Nada a fazer.'); return; }
  if (!sync.token) { log('sync habilitado MAS sem token — recusando (fail-safe).'); return; }
  if (!sync.share) { log('sync habilitado com token, mas share=0 — nada a servir.'); return; }
  const bindHost = process.env.ATL_SYNC_BIND || net.detectTailnetIP();
  try {
    server = net.startServer({
      port: sync.port, token: sync.token, nodeName, shareTranscripts: !!sync.shareTranscripts, allowAttach: !!sync.allowAttach, ptySpawn: ptyLib ? createPty : undefined, bindHost,
      getSessions: () => collect.readSessions(),
      getTranscript: (key, n) => {
        try { const tp = collect.findTranscript(key); return tp ? transcript.lastMessages(tp, n) : []; }
        catch { return []; }
      },
    });
    log('servidor UP %s:%d (%s) shareTranscripts=%s', bindHost || '127.0.0.1', sync.port, nodeName, !!sync.shareTranscripts);
    // Mantém o cache de descoberta /proc fresco (igual ao loop de 5s da GUI).
    setInterval(() => collect.invalidateDiscovery(), 5000);
  } catch (e) { log('servidor falhou: %s', e.message); }
}

function stop() { try { if (server) server.close(); } catch {} log('encerrado.'); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
