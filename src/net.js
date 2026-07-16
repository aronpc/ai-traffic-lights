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

// Campos machine-local que NÃO atravessam a rede (só fazem sentido neste host).
const LOCAL_ONLY = ['windowid', 'focus_url', 'tilix_id', 'zellij_session'];

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
function startServer({ port, token, nodeName, shareTranscripts, getSessions, getTranscript }) {
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
  server.listen(port, '127.0.0.1');
  return server;
}

// Faz poll de /sessions de cada peer a cada intervalMs. Retorna um stop().
// As sessões recebidas já vêm com origin=<nome reportado pelo peer>; CONFIA no
// nome do peer (data.node) p/ o badge — se ausente, usa p.name (config local).
function pollPeers({ peers, port, token, intervalMs = 5000, onSessions, onError }) {
  if (!Array.isArray(peers) || !peers.length) return () => {};
  let stopped = false;
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  async function tick() {
    if (stopped) return;
    await Promise.all(peers.map(async (p) => {
      const hostPort = p.host.includes(':') ? p.host : `${p.host}:${port}`;
      try {
        const r = await fetch(`http://${hostPort}/sessions`, { headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const origin = data.node || p.name || p.host;
        const sessions = (data.sessions || []).map((s) => ({ ...s, origin }));
        onSessions(p.host, sessions);
      } catch (e) { if (onError) onError(p.host, e); }
    }));
  }
  tick();
  const id = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(id); };
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

if (typeof module !== 'undefined') module.exports = { startServer, pollPeers, tokenOk, exportSession, fetchTranscriptFromPeer };
