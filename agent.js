#!/usr/bin/env node
// agent.js — HEADLESS mode of the sync (phase 4). PURE Node, NO require('electron').
//
// Lets a headless Linux server (e.g. loja-mqx) join the mesh as a SOURCE:
// starts the /sessions (/transcript) server binding DIRECTLY to the tailnet IP
// and exposes local sessions via the SAME core as the GUI
// (collect.js/net.js/identity.js/transcript.js) — no duplicated logic. Runs
// as a daemon (systemd); logs to stdout (journald).
//
// Network model EQUAL to the GUI: bind to the tailnet IP (detectTailnetIP),
// plain HTTP on the app port, token auth + WireGuard E2E — does NOT use
// `tailscale serve` (the client speaks HTTP on the app port; serve exposes
// HTTPS:443 and would break). Config comes from ATL's settings.json; env
// overrides (useful on a server without a GUI to edit the JSON):
// ATL_SYNC_TOKEN / ATL_SYNC_ENABLED=1 / ATL_SYNC_SHARE=1 /
// ATL_SYNC_SHARE_TR=1 / ATL_SYNC_PORT / ATL_SYNC_NODE.
//
// Deploy (systemd): see scripts/atl-agent.service. Quick (manual):
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

// Same beta gate as the GUI (main.js: SYNC_AVAILABLE = isPrerelease(APP_VERSION)).
// Sync is a pre-release feature: a headless agent installed from a STABLE
// build must not serve /sessions, /transcript and /pty when no stable GUI can
// act as a client — one policy on both sides.
// ATL_APP_VERSION overrides for tests and dev checkouts (the repo package can
// be at a stable version while the next beta is being developed).
const APP_VERSION = process.env.ATL_APP_VERSION || require('./package.json').version;
const SYNC_AVAILABLE = settingsLib.isPrerelease(APP_VERSION);

function loadSettings() {
  try { return settingsLib.mergeWithDefaults(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch { return settingsLib.mergeWithDefaults(null); }   // no file → defaults (sync OFF)
}

const ENV_BOOL = (v) => v === '1' || v === 'true';
// Env overrides (server without a GUI to edit settings.json). Only overrides
// when the var is DEFINED — settings.json remains valid for everything else.
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

// node-pty factory for the /pty endpoint (remote attach). Headless: loading
// may fail (node≠electron ABI) — then ptySpawn stays undefined and /pty never starts.
let ptyLib = null;
try { ptyLib = require('node-pty'); } catch (e) { log('node-pty indisponível: %s', e.message); }
function createPty(cmd, cols, rows, { onData, onExit }) {
  if (!ptyLib) throw new Error('node-pty indisponível');
  const p = ptyLib.spawn(cmd[0], cmd.slice(1), { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: process.env.HOME, env: process.env });
  p.onData(onData); p.onExit(onExit);
  return {
    write: (d) => { try { p.write(d); } catch {} },
    resize: (c, r) => { try { p.resize(c, r); } catch {} },
    pause: () => { try { p.pause(); } catch {} },
    resume: () => { try { p.resume(); } catch {} },
    kill: () => { try { p.kill(); } catch {} },
  };
}

const cfg = loadSettings();
const sync = applyEnvOverrides({ ...(cfg.sync || {}) });
const nodeName = sync.node || os.hostname() || 'local';

let server = null;
function start() {
  // Check order: config FIRST (the more specific "don't start" reason wins),
  // beta gate after — a disabled agent is disabled on any release channel.
  if (!sync.enabled) { log('sync desabilitado (settings/ATL_SYNC_ENABLED). Nada a fazer.'); return; }
  if (!sync.token) { log('sync habilitado MAS sem token — recusando (fail-safe).'); return; }
  if (!sync.share) { log('sync habilitado com token, mas share=0 — nada a servir.'); return; }
  if (!SYNC_AVAILABLE) { log('sync é feature beta: requer build pre-release (esta é v%s estável). Nada a fazer.', APP_VERSION); return; }
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
    // Keeps the /proc discovery cache fresh (same as the GUI's 5s loop).
    setInterval(() => collect.invalidateDiscovery(), 5000);
  } catch (e) { log('servidor falhou: %s', e.message); }
}

// SIGTERM/SIGINT: also tears down in-flight /pty shells (same order as the
// GUI's closeSyncServer, PR-32 #07) — close() alone only stops accepting new
// connections and would leave remote attaches alive until the socket timeout.
function stop() {
  try { if (server && server.closeAllPty) server.closeAllPty(); } catch {}
  try { if (server) server.close(); } catch {}
  log('encerrado.');
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
start();
