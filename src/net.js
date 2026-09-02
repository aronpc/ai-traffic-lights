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
const nodeNet = require('net');
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
    for (const ip of peer.TailscaleIPs || []) set.add(String(ip).toLowerCase());
    if (peer.DNSName) set.add(String(peer.DNSName).toLowerCase().replace(/\.$/, ''));
  }
  return set;
}
// Set de peers ONLINE segundo o Tailscale, p/ o poller SÓ tentar rede quem tá
// online (zero fetch em offline; detecta "ficou online" ~cadência de refresh do
// main). null se o status não pôde ser confirmado; consumidores falham fechado.
function tailscaleOnlineSet() {
  try {
    const j = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    return buildOnlineSet(j);
  } catch { return null; }
}
function parsePeerHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  let host = value;
  let port = null;
  if (value.startsWith('[')) {
    const m = value.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!m || nodeNet.isIP(m[1]) !== 6) return null;
    host = m[1]; port = m[2] || null;
  } else if (nodeNet.isIP(value) !== 6) {
    const m = value.match(/^([^:]+?)(?::(\d{1,5}))?$/);
    if (!m) return null;
    host = m[1]; port = m[2] || null;
  }
  if (port != null && (+port < 1 || +port > 65535)) return null;
  const ip = nodeNet.isIP(host);
  if (!ip) {
    if (/^[\d.]+$/.test(host) || host.length > 253) return null;
    const labels = host.split('.');
    if (labels.some((x) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(x))) return null;
  }
  return { host: host.toLowerCase(), port: port == null ? null : +port, ipv6: ip === 6 };
}

// Autoridade URL segura para IPv4, IPv6 (com colchetes) e nomes Tailscale.
function peerAuthority(host, defaultPort) {
  const p = parsePeerHost(host);
  const port = p && (p.port || +defaultPort);
  if (!p || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${p.ipv6 ? `[${p.host}]` : p.host}:${port}`;
}

// Diz se um host configurado está no set de identidades ONLINE confirmado pelo
// Tailscale. Falha de `tailscale status` (set null) falha fechado: bearer token
// e credenciais de PTY nunca são enviados a um destino não confirmado.
function peerOnline(set, host) {
  if (!(set instanceof Set)) return false;
  const p = parsePeerHost(host);
  return !!p && set.has(p.host);
}

// Campos machine-local que NÃO atravessam a rede (só fazem sentido neste host).
// tmux_pane foca o painel NESTE host → local-only; tmux_session (attach remoto)
// fica DE FORA de propósito — precisa cruzar a rede pro peer.
//
// TODO HINT DE FOCO NOVO ENTRA AQUI. Os campos de ENV_HINTS (src/focus.js)
// identificam uma janela/aba/painel DESTE kernel; num peer eles não apontam pra
// nada. test/net.test.js cobre a lista inteira justamente pra falhar quando
// alguém adicionar um hint e esquecer desta linha.
const LOCAL_ONLY = ['windowid', 'focus_url', 'tilix_id', 'iterm_id', 'zellij_session', 'tmux_pane'];

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

// Encaminha output e aplica o lado HIGH da histerese de backpressure. Separado
// para cobrir deterministicamente o caso sem depender do buffer do kernel.
function forwardPtyOutput(ws, pty, data, high = 1 << 20) {
  ws.send(JSON.stringify({ type: 'out', data }));
  if (pty && !ws._paused && ws.bufferedAmount > high) {
    ws._paused = true;
    pty.pause();
  }
}

// Sanitiza uma sessão pra sair na rede: remove campos machine-local e marca
// `origin` com o nome DESTE nó (pra o overlay do peerBadge na máquina remota).
// readAtFor (opcional, #56): (sessãoLocal) → epoch da marca de lido vigente
// ou undefined. Recebe a sessão ANTES do override de origin — a chave da
// marca é o namespace local (sessionKey → 'local:<pid>').
function exportSession(s, nodeName, nowSec, readAtFor) {
  const out = { ...s };
  for (const k of LOCAL_ONLY) delete out[k];
  out.origin = nodeName;
  // Idade RELATIVA (segundos desde last_event) computada no SERVIDOR, no relógio
  // DELE. O receptor re-ancora no relógio local via anchorRemote → elimina clock
  // skew na escalada idle de sessões remotas (PR-32 #18).
  if (typeof nowSec === 'number' && typeof out.last_event_ts === 'number') {
    out.idleSec = Math.max(0, Math.floor(nowSec) - out.last_event_ts);
  }
  // #56: a marca de lido viaja como IDADE RELATIVA (readIdleSec) pelo MESMO
  // motivo do idleSec acima — o receptor re-ancora (now - readIdleSec) e a
  // comparação `last_event_ts <= readAt` (state-machine) corre entre dois
  // timestamps do MESMO relógio. Epoch cru (relógio da origem) misturaria
  // relógios justamente com o last_event_ts que o anchorRemote reescreveu.
  const at = (typeof readAtFor === 'function') ? readAtFor(s) : undefined;
  if (typeof nowSec === 'number' && Number.isFinite(at) && at > 0) {
    out.readIdleSec = Math.max(0, Math.floor(nowSec) - at);
  }
  return out;
}

// Reescreve last_event_ts de uma sessão REMOTA p/ o relógio LOCAL do receptor,
// usando o idleSec (idade relativa computada no peer). Elimina clock skew entre
// peer e receptor (PR-32 #18): antes, ageSec = nowLocal - last_event_ts_peer
// misturava relógios → alarme falso (peer atrasado ≥ threshold) ou idle real
// silenciado (peer adiantado). Sessão sem idleSec (peer antigo) fica intacta.
function anchorRemote(s, nowSec) {
  if (!s || s.idleSec == null) return s;
  const ts = Math.floor(nowSec) - Math.max(0, s.idleSec | 0);
  const out = { ...s };
  out.last_event_ts = ts;
  delete out.idleSec;
  return out;
}

// Lê o body do POST /read com TETO (default 64 KiB): um peer bugado (ou um
// atacante com o token) não aloca memória sem limite. cb(code|null, buf) —
// code preenchido = erro (413 estourou / 400 vazio); flag `done` porque
// 'data'+'end'+'error' podem concorrer e o cb é de resposta única. No 413 a
// resposta sai IMEDIATAMENTE (early response — HTTP/1.1 permite responder
// antes do fim do body) e o resto do stream é DESCARTADO pelo guard `done`:
// memória O(limit) sem destruir o socket (destroy mataria o flush da própria
// resposta — o peer veria reset em vez de 413).
function readBody(req, cb, limit = 65536) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (code, buf) => { if (done) return; done = true; cb(code, buf); };
  req.on('data', (c) => {
    if (done) return;                 // pós-resposta: resto do body flui e é descartado
    size += c.length;
    if (size > limit) return finish(413);
    chunks.push(c);
  });
  req.on('end', () => { if (!done) finish(chunks.length ? null : 400, Buffer.concat(chunks)); });
  req.on('error', () => finish(400));
}

// Saneia o payload do POST /read: { now?, marks: [{key, readAt}] }. Retorna
// { now, marks } (now = epoch do CLIENTE, ou 0 se ausente/inválido) ou null
// se o body não é JSON/payload válido. Tetos: 100 marks por request, key
// 1-256 chars, readAt inteiro > 0 (epoch s). Itens inválidos são DESCARTADOS
// individualmente — um item ruim não derruba o lote inteiro.
function parseReadMarks(buf) {
  let body = null;
  try { body = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!body || typeof body !== 'object' || !Array.isArray(body.marks)) return null;
  const now = Math.floor(Number(body.now));
  const marks = [];
  for (const m of body.marks.slice(0, 100)) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.key !== 'string' || m.key.length < 1 || m.key.length > 256) continue;
    const at = Math.floor(Number(m.readAt));
    if (!Number.isFinite(at) || at <= 0) continue;
    marks.push({ key: m.key, readAt: at });
  }
  return { now: Number.isFinite(now) && now > 0 ? now : 0, marks };
}

// Sobe o servidor. Retorna o http.Server. Binda em bindHost (default: IP da
// tailnet via detectTailnetIP — peers alcançam direto; fallback 127.0.0.1).
//   getSessions()  → array local de sessões (de collect.readSessions)
//   getTranscript(key, n) → [{role,text,ts}] (stub em []; parser real é fase 3)
//   onReadMarks(marks) → aplica marcas de leitura vindas de peer (#56) e
//     devolve qtd aplicada (0 = nada mudou). Opcional: sem callback a rota
//     POST /read responde 200 com applied=0 (degrada, não quebra o peer).
//   readAtFor(sessãoLocal) → epoch da marca de lido vigente da sessão (#56)
//     ou undefined; vira readIdleSec no payload de /sessions. Opcional.
function startServer({ port, token, nodeName, shareTranscripts, allowAttach, ptySpawn, getSessions, getTranscript, onReadMarks, readAtFor, bindHost, onError }) {
  const server = http.createServer((req, res) => {
    const respond = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    res.setHeader('Content-Type', 'application/json');
    if (!tokenOk(bearerOf(req), token)) return respond(401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://127.0.0.1');
    // POST /read (#56): escrita da marca de lido NA ORIGEM da sessão. Única
    // rota de escrita — entra antes do gate GET abaixo. Mesma auth Bearer:
    // quem tem o token já pode attachar shell via /pty; marcar leitura é
    // escrita muito menor.
    if (req.method === 'POST') {
      if (url.pathname !== '/read') return respond(405, { error: 'method' });
      return readBody(req, (code, buf) => {
        if (code) return respond(code, { error: 'payload' });
        const parsed = parseReadMarks(buf);
        if (!parsed) return respond(400, { error: 'payload' });
        const marks = parsed.marks;
        // RELÓGIOS: readAt chega no relógio DO CLIENTE; `now` (epoch dele no
        // momento do POST) converte pro relógio DESTA origem: drift = agora
        // - now. O par (readAt ancorado, now) do cliente faz as latências
        // poll→clique se cancelarem — sobra só o skew real. Sem `now` (peer
        // antigo) fica cru: degrada ao comportamento sem correção.
        if (parsed.now > 0) {
          const drift = Math.floor(Date.now() / 1000) - parsed.now;
          for (const m of marks) m.readAt = Math.max(1, m.readAt + drift);
        }
        let applied = 0;
        if (typeof onReadMarks === 'function') {
          try { applied = onReadMarks(marks) || 0; } catch {}
        }
        return respond(200, { ok: true, applied });
      });
    }
    if (req.method !== 'GET') return respond(405, { error: 'method' });

    if (url.pathname === '/sessions') {
      let sessions = [];
      try { sessions = getSessions() || []; } catch {}
      return respond(200, { node: nodeName, sessions: sessions.map((s) => exportSession(s, nodeName, Math.floor(Date.now() / 1000), readAtFor)) });
    }
    if (url.pathname === '/transcript') {
      if (!shareTranscripts) return respond(403, { error: 'transcripts not shared' });
      const key = url.searchParams.get('key');
      // parseInt inválido ('?n=abc') dá NaN — e NaN atravessa Math.min/max,
      // burlando o teto de 50 (slice(-NaN) devolve TUDO). Fallback explícito.
      const p = parseInt(url.searchParams.get('n') || '20', 10);
      const n = Math.max(1, Math.min(50, Number.isFinite(p) ? p : 20));
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
                  forwardPtyOutput(ws, pty, d, HIGH);
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
    // Exposto pro caller poder DERRUBAR os shells em curso ao desligar o sync /
    // trocar o token: server.close() só para de ACEITAR conexões novas, as já
    // estabelecidas seguem vivas (PR-32 #07). Ver closeSyncServer no main.
    server.closeAllPty = () => {
      try { wss.clients.forEach((ws) => { try { ws.terminate(); } catch {} }); } catch {}
      try { wss.close(); } catch {}   // dispara o wss 'close' → limpa hb/bp
    };
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
    // GATE obrigatório: o caller confirma a identidade online via Tailscale.
    // Sem predicate, host inválido ou peer offline, não envia nem o Bearer token.
    const hostPort = peerAuthority(p.host, port);
    if (!hostPort || !isOnline || !isOnline(p.host)) {
      if (st.online !== false && onPeerState) onPeerState(p.host, false);
      st.online = false;
      st.delay = offlineRecheckMs;
      if (!stopped) timers.set(p.host, setTimeout(() => pollOne(p), st.delay));
      return;
    }
    let ok = false;
    try {
      const r = await fetch(`http://${hostPort}/sessions`, { headers, signal: AbortSignal.timeout(3000) });   // PR-32 #05: peer em blackhole não trava o ciclo de poll
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (stopped) return;   // teardown durante o fetch: não repopula o Map já limpo pelo caller
      const origin = data.node || p.name || p.host;
      onSessions(p.host, (data.sessions || []).map((s) => anchorRemote({ ...s, origin }, Math.floor(Date.now() / 1000))));   // PR-32 #18: âncora last_event_ts no relógio local (idleSec do peer)
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
async function fetchTranscriptFromPeer({ host, port, token, key, n = 20, onlineSet }) {
  if (!host || !key) return [];
  const hostPort = peerAuthority(host, port);
  if (!hostPort || !peerOnline(onlineSet, host)) return [];
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

// Posta marcas de leitura à ORIGEM de sessões remotas (#56 — cliente do POST
// /read). A chave já deve estar REESCRITA no namespace da origem
// (rewriteKeyOrigin: 'peer:1234' → 'local:1234') e o `now` é o epoch DESTE
// cliente, pra a origem converter o readAt pro relógio dela (ver drift no
// handler do POST). Caller trata como fire-and-forget: numa falha a marca
// local otimista segue válida e o poll re-exporta readIdleSec no próximo
// ciclo — convergência via /sessions, não via retry.
async function postReadToPeer({ host, port, token, marks, now }) {
  if (!host || !Array.isArray(marks) || !marks.length) return false;
  const hostPort = peerAuthority(host, port);
  if (!hostPort) return false;
  try {
    const r = await fetch(`http://${hostPort}/read`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),   // blackhole não pendura o clique
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ now, marks }),
    });
    return r.ok;
  } catch { return false; }
}

if (typeof module !== 'undefined') module.exports = { startServer, pollPeers, tokenOk, exportSession, fetchTranscriptFromPeer, postReadToPeer, detectTailnetIP, tailscaleOnlineSet, buildOnlineSet, peerOnline, peerAuthority, anchorRemote, forwardPtyOutput };
