// net.js — transporte do sync P2P (fase 2). Electron-free: só Node http + fetch.
//
// Cada nó é simétrico: sobe um SERVIDOR (se sync.share) que expõe /sessions
// (sempre) e /transcript (só se sync.shareTranscripts) na 127.0.0.1 — nunca na
// interface da tailnet. O ingress da tailnet é o `tailscale serve` (que injeta
// identity headers e STRIP spoofados); bindar direto em tailscale0 forjaria os
// headers. O CLIENTE (se houver sync.peers) faz poll de /sessions a cada 5s.
//
// Auth: bearer token comparado em tempo constante (hash dos dois lados p/ não
// vazar length — ver CVE fastify-bearer-auth). Sem token configurado => recusa
// tudo (fail-safe; o main nem deve subir o server sem token).
//
// Dependency injection: getSessions()/getTranscript() vêm por callback (do
// main/collect), mantendo este módulo puro e testável sem Electron.

const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// WebSocket p/ o endpoint /pty (attach remoto). try/catch: sem a dep (testes/CI),
// o módulo continua válido — só o /pty não sobe (graceful degradation).
let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch {}

// IP desta máquina na tailnet (100.64.0.0/10), p/ o servidor bindar DIRETO nele
// em vez de localhost — assim os peers alcançam http://<meu-ip-tailnet>:<porta>
// sem precisar de `tailscale serve`. Memoizado; null se tailscale ausente (cai
// p/ localhost: feature degrada p/ só-this-host, sem explodir).
let _tsIP;
function detectTailnetIP() {
  if (_tsIP !== undefined) return _tsIP;
  try { const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 }).trim(); _tsIP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) ? ip : null; }
  catch { _tsIP = null; }
  return _tsIP;
}

// Set de peers ONLINE segundo o Tailscale (HostName + IPs, lowercased). O poller
// usa p/ SÓ tentar rede quem tá online (zero fetch em offline; detecta "ficou
// online" assim que o Tailscale marca — ~cadência de refresh do main). null se
// tailscale ausente (aí o poller cai pro backoff puro, sem gate).
function tailscaleOnlineSet() {
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    const set = new Set();
    for (const peer of Object.values(j.Peer || {})) {
      if (peer && peer.Online) {
        if (peer.HostName) set.add(String(peer.HostName).toLowerCase());
        for (const ip of peer.TailscaleIPs || []) set.add(String(ip));
      }
    }
    return set;
  } catch { return null; }
}

// Campos machine-local que NÃO atravessam a rede (só fazem sentido neste host).
// tmux_pane foca o painel NESTE host → local-only; tmux_session (attach remoto)
// fica DE FORA de propósito — precisa cruzar a rede pro peer.
const LOCAL_ONLY = ['windowid', 'focus_url', 'tilix_id', 'zellij_session', 'tmux_pane'];

// Compara o token do request contra o esperado sem vazar timing/length:
// hasheia ambos (SHA-256 → 32 bytes fixos) e usa timingSafeEqual. Token vazio
// configurado => sempre false (nenhum acesso).
function tokenOk(reqToken, expected) {
  if (!expected || typeof expected !== 'string' || !reqToken || typeof reqToken !== 'string') return false;
  const a = crypto.createHash('sha256').update(reqToken).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
function bearerOf(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// Sanitiza uma sessão pra sair na rede: remove campos machine-local e marca
// `origin` com o nome DESTE nó (pra o overlay do peerBadge na máquina remota).
function exportSession(s, nodeName) {
  const out = { ...s };
  for (const k of LOCAL_ONLY) delete out[k];
  out.origin = nodeName;
  return out;
}

// Sobe o servidor em 127.0.0.1 (localhost-only). Retorna o http.Server.
//   getSessions()  → array local de sessões (de collect.readSessions)
//   getTranscript(key, n) → [{role,text,ts}] (stub em []; parser real é fase 3)
function startServer({ port, token, nodeName, shareTranscripts, allowAttach, ptySpawn, getSessions, getTranscript, bindHost }) {
  const server = http.createServer((req, res) => {
    const respond = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    res.setHeader('Content-Type', 'application/json');
    if (!tokenOk(bearerOf(req), token)) return respond(401, { error: 'unauthorized' });
    if (req.method !== 'GET') return respond(405, { error: 'method' });

    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/sessions') {
      let sessions = [];
      try { sessions = getSessions() || []; } catch {}
      return respond(200, { node: nodeName, sessions: sessions.map((s) => exportSession(s, nodeName)) });
    }
    if (url.pathname === '/transcript') {
      if (!shareTranscripts) return respond(403, { error: 'transcripts not shared' });
      const key = url.searchParams.get('key');
      const n = Math.max(1, Math.min(50, parseInt(url.searchParams.get('n') || '20', 10)));
      let msgs = [];
      if (key) { try { msgs = (getTranscript && getTranscript(key, n)) || []; } catch {} }
      return respond(200, { messages: msgs });
    }
    respond(404, { error: 'not found' });
  });
  server.listen(port, bindHost || '127.0.0.1');   // tailnet IP p/ peers alcançarem direto; default localhost

  // /pty — terminal remoto via WebSocket (attach remoto ao vivo). Opt-in
  // (allowAttach) + ptySpawn INJETADO (DI): net.js não conhece node-pty →
  // módulo puro/testável. Auth pelo mesmo token (query ?token=); tmux_session
  // sanitizado (anti-injeção no shell do peer). Protocolo JSON por frame:
  // c→s {start|in|resize} · s→c {out|exit|error}.
  if (allowAttach && typeof ptySpawn === 'function' && WebSocketServer) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/pty') return socket.destroy();
      if (!tokenOk(url.searchParams.get('token') || '', token)) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    wss.on('connection', (ws) => {
      let pty = null;
      const cleanup = () => { try { if (pty) pty.kill(); } catch {} pty = null; };
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'start') {
          if (!m.tmux_session || !/^[A-Za-z0-9._-]+$/.test(m.tmux_session)) return ws.close(4400, 'bad session');
          cleanup();
          try {
            pty = ptySpawn(['tmux', 'attach', '-t', m.tmux_session], m.cols | 0 || 80, m.rows | 0 || 24, {
              onData: (d) => { try { ws.send(JSON.stringify({ type: 'out', data: d })); } catch {} },
              onExit: () => { try { ws.send(JSON.stringify({ type: 'exit' })); } catch {} },
            });
          } catch (e) { try { ws.send(JSON.stringify({ type: 'error', msg: String((e && e.message) || e) })); } catch {} }
        } else if (pty && m.type === 'in') { try { pty.write(m.data); } catch {} }
        else if (pty && m.type === 'resize') { try { pty.resize(m.cols | 0 || 80, m.rows | 0 || 24); } catch {} }
      });
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  }
  return server;
}

// Faz poll de /sessions de cada peer. Cada peer tem o SEU timer com BACKOFF
// exponencial: offline => raro (até maxDelayMs, default 5min) e loga só a
// TRANSIÇÃO; online => cadência normal (intervalMs). Assim um peer offline não
// enche o log a cada 5s, e quando volta a ser alcançável o próximo ciclo pega,
// reseta o backoff e volta ao normal (próximo de "só começa quando online").
// onSessions no sucesso; onPeerState(host, online) só nas MUDANÇAS de estado.
function pollPeers({ peers, port, token, intervalMs = 5000, maxDelayMs = 5 * 60 * 1000, offlineRecheckMs = 3000, onSessions, onPeerState, isOnline }) {
  if (!Array.isArray(peers) || !peers.length) return () => {};
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const timers = new Map();   // host -> timeout id (cadência independente por peer)
  const state = new Map();    // host -> { delay, online:null|bool }
  let stopped = false;

  async function pollOne(p) {
    if (stopped) return;
    const st = state.get(p.host);
    // GATE (opcional): se há predicate isOnline (Tailscale) e o peer NÃO tá
    // online, NÃO gasta rede — só re-checa barato (offlineRecheckMs) e mantém
    // offline. Assim offline => zero fetch; quando o Tailscale marca online,
    // o próximo re-check pega e parte pra cadência normal.
    if (isOnline && !isOnline(p.host)) {
      if (st.online !== false && onPeerState) onPeerState(p.host, false);
      st.online = false;
      st.delay = offlineRecheckMs;
      if (!stopped) timers.set(p.host, setTimeout(() => pollOne(p), st.delay));
      return;
    }
    const hostPort = p.host.includes(':') ? p.host : `${p.host}:${port}`;
    let ok = false;
    try {
      const r = await fetch(`http://${hostPort}/sessions`, { headers });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const origin = data.node || p.name || p.host;
      onSessions(p.host, (data.sessions || []).map((s) => ({ ...s, origin })));
      ok = true;
    } catch { /* offline/erro — vira backoff abaixo */ }
    if (ok) {
      st.delay = intervalMs;                                              // online: cadência normal
      if (st.online === false && onPeerState) onPeerState(p.host, true);  // voltou
      st.online = true;
    } else {
      st.delay = Math.min(st.delay * 2, maxDelayMs);                      // backoff exponencial
      if (st.online !== false && onPeerState) onPeerState(p.host, false); // caiu (1ª vez)
      st.online = false;
    }
    if (!stopped) timers.set(p.host, setTimeout(() => pollOne(p), st.delay));
  }

  for (const p of peers) { state.set(p.host, { delay: intervalMs, online: null }); pollOne(p); }
  return () => { stopped = true; for (const id of timers.values()) clearTimeout(id); timers.clear(); };
}

// Busca /transcript de um peer (cliente). Devolve [] se host ausente/erro/403.
// Usado pelo IPC fetch-transcript do main quando o usuário abre o painel de uma
// sessão REMOTA (a local é lida direto do disco via collect+transcript).
async function fetchTranscriptFromPeer({ host, port, token, key, n = 20 }) {
  if (!host || !key) return [];
  const hostPort = host.includes(':') ? host : `${host}:${port}`;
  try {
    const r = await fetch(
      `http://${hostPort}/transcript?key=${encodeURIComponent(key)}&n=${n}`,
      token ? { headers: { Authorization: 'Bearer ' + token } } : {},
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch { return []; }
}

if (typeof module !== 'undefined') module.exports = { startServer, pollPeers, tokenOk, exportSession, fetchTranscriptFromPeer, detectTailnetIP, tailscaleOnlineSet };
