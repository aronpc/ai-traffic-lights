// net.js — transporte do sync P2P (fase 2). Electron-free: só Node http + fetch.
//
// Cada nó é simétrico: sobe um SERVIDOR (se sync.share) que expõe /sessions
// (sempre) e /transcript (só se sync.shareTranscripts) bindando DIRETO no IP da
// tailnet (100.x via detectTailnetIP — ver abaixo). Os peers alcançam
// http://<meu-ip-tailnet>:<porta> na MESMA porta, em HTTP puro. NÃO usa
// `tailscale serve`: o client fala HTTP na porta do app, e o `serve` expõe
// HTTPS:443 por default (URL não casaria → connection refused). A segurança vem
// do WireGuard E2E do Tailscale + bearer token (tempo constante). Sem tailscale
// disponível, o bind cai p/ 127.0.0.1 (degrada p/ só-this-host, sem explodir).
// O CLIENTE (se houver sync.peers) faz poll de /sessions a cada 5s.
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
  // Só cacheia o SUCESSO (IP 100.x válido). Em falha (tailscale ainda subindo
  // no boot, PATH restrito do Electron) NÃO cacheia null — re-tenta no próximo
  // ciclo. Antes, cacheava null pra sempre e o server caía p/ 127.0.0.1 até
  // reiniciar o app (PR-32 #17).
  if (_tsIP !== undefined) return _tsIP;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) _tsIP = ip;
  } catch { /* tailscale ausente/subindo — re-tenta depois (não cacheia null) */ }
  return _tsIP || null;
}

// Constrói o set de hosts online a partir do JSON de `tailscale status --json`.
// PURA (sem I/O) → testável. Formas canônicas no set: HostName curto + FQDN
// (DNSName sem trailing dot) + IPs — assim o gate casa peer configurado como
// hostname curto, MagicDNS FQDN ou host:porta (PR-32 #16: antes só HostName+IP,
// e o FQDN nunca casava → peer tratado como offline pra sempre).
function buildOnlineSet(j) {
  const set = new Set();
  for (const peer of Object.values((j && j.Peer) || {})) {
    if (!peer || !peer.Online) continue;
    if (peer.HostName) set.add(String(peer.HostName).toLowerCase());
    for (const ip of peer.TailscaleIPs || []) set.add(String(ip));
    if (peer.DNSName) set.add(String(peer.DNSName).toLowerCase().replace(/\.$/, ''));
  }
  return set;
}
// Set de peers ONLINE segundo o Tailscale, p/ o poller SÓ tentar rede quem tá
// online (zero fetch em offline; detecta "ficou online" ~cadência de refresh do
// main). null se tailscale ausente (aí o poller cai pro backoff puro, sem gate).
function tailscaleOnlineSet() {
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    return buildOnlineSet(j);
  } catch { return null; }
}
// Diz se um host configurado (hostname curto, FQDN, host:porta ou IP) está no
// set de online. Normaliza (tira :porta do fim — não IPv6 — e lowercase) e checa
// as formas canônicas do set (PR-32 #16). set null => assume online (sem gate).
function peerOnline(set, host) {
  if (!set) return true;
  if (!host) return false;
  const m = String(host).toLowerCase().match(/^([^:]+):(\d{1,5})$/);   // host:porta → host (IPv6 intacto)
  return set.has(m ? m[1] : String(host).toLowerCase());
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

// Sobe o servidor. Retorna o http.Server. Binda em bindHost (default: IP da
// tailnet via detectTailnetIP — peers alcançam direto; fallback 127.0.0.1).
//   getSessions()  → array local de sessões (de collect.readSessions)
//   getTranscript(key, n) → [{role,text,ts}] (stub em []; parser real é fase 3)
function startServer({ port, token, nodeName, shareTranscripts, allowAttach, ptySpawn, getSessions, getTranscript, bindHost, onError }) {
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
  // Sem error handler, EADDRINUSE (2ª instância, porta em uso, GUI+agent no
  // mesmo host) vira uncaughtException e mata o processo (PR-32 #09). Degradar:
  // loga + avisa o caller via onError (DI); o server fica inerte (só-this-host).
  server.on('error', (e) => { console.error('[net] server error', (e && e.code) || e); if (typeof onError === 'function') onError(e); });
  server.listen(port, bindHost || '127.0.0.1');   // tailnet IP p/ peers alcançarem direto; default localhost

  // /pty — terminal remoto via WebSocket (attach remoto ao vivo). Opt-in
  // (allowAttach) + ptySpawn INJETADO (DI): net.js não conhece node-pty →
  // módulo puro/testável. Auth pelo mesmo token via header Authorization: Bearer
  // (igual a /sessions e /transcript) — token NUNCA na URL, p/ não vazar em
  // access-logs do tailscale. tmux_session sanitizado (anti-injeção no shell do
  // peer). Protocolo JSON por frame:
  // c→s {start|in|resize} · s→c {out|exit|error}.
  if (allowAttach && typeof ptySpawn === 'function' && WebSocketServer) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/pty') return socket.destroy();
      if (!tokenOk(bearerOf(req), token)) {
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    // HEARTBEAT (PR-32 #12): conexão meio-aberta (peer sumiu sem FIN) nunca
    // dispara 'close' → o pty/tmux ficava vivo indefinidamente. ping/pong a cada
    // 30s; quem não responde é terminate() (libera o pty via cleanup).
    const hb = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      });
    }, 30000);
    hb.unref();
    // BACKPRESSURE (PR-32 #25): output massivo (cat/yes/tail -f) sem checar
    // bufferedAmount derrubava o main por OOM — cada chunk virava ws.send na
    // hora. Histerese: pausa o pty em HIGH (1 MiB), retoma em LOW (256 KiB).
    const HIGH = 1 << 20, LOW = 1 << 18;
    const bp = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (ws._pty && ws._paused && ws.bufferedAmount < LOW) { ws._paused = false; try { ws._pty.resume(); } catch {} }
      });
    }, 250);
    bp.unref();
    wss.on('close', () => { clearInterval(hb); clearInterval(bp); });
    wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      let pty = null;
      const cleanup = () => { try { if (pty) pty.kill(); } catch {} pty = null; ws._pty = null; };
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type === 'start') {
          const sess = (typeof m.tmux_session === 'string') ? m.tmux_session : null;
          if (sess && !/^[A-Za-z0-9._-]+$/.test(sess)) return ws.close(4400, 'bad session');  // inválido rejeita; ausente = shell novo
          cleanup();
          try {
            const cmd = sess ? ['tmux', 'attach', '-t', sess] : ['tmux', 'new-session', '-s', 'atl-shell-' + Date.now().toString(36), process.env.SHELL || 'bash'];   // sem sess → novo shell DENTRO de um tmux (attachável, igual ao local)
            pty = ptySpawn(cmd, m.cols | 0 || 80, m.rows | 0 || 24, {
              onData: (d) => {
                try {
                  ws.send(JSON.stringify({ type: 'out', data: d }));
                  if (pty && !ws._paused && ws.bufferedAmount > HIGH) { ws._paused = true; try { pty.pause(); } catch {} }   // WS entupindo → pausa o pty (bp retoma ao drenar)
                } catch {}
              },
              onExit: () => { try { ws.send(JSON.stringify({ type: 'exit' })); } catch {} },
            });
            ws._pty = pty;
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
      const r = await fetch(`http://${hostPort}/sessions`, { headers, signal: AbortSignal.timeout(3000) });   // PR-32 #05: peer em blackhole não trava o ciclo de poll
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
      { signal: AbortSignal.timeout(3000), ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) },   // PR-32 #05: blackhole não pendura o painel ver-prompt
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch { return []; }
}

if (typeof module !== 'undefined') module.exports = { startServer, pollPeers, tokenOk, exportSession, fetchTranscriptFromPeer, detectTailnetIP, tailscaleOnlineSet, buildOnlineSet, peerOnline };
