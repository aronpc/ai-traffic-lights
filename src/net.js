// net.js — transport for the P2P sync (phase 2). Electron-free: Node http + fetch only.
//
// Every node is symmetric: it starts a SERVER (if sync.share) that exposes /sessions
// (always) and /transcript (only if sync.shareTranscripts), binding DIRECTLY to the
// tailnet IP (100.x via detectTailnetIP — see below). Peers reach
// http://<my-tailnet-ip>:<port> on the SAME port, over plain HTTP. Does NOT use
// `tailscale serve`: the client speaks HTTP on the app's port, while `serve` exposes
// HTTPS:443 by default (the URL wouldn't match → connection refused). Security comes from
// Tailscale's E2E WireGuard + bearer token (constant time). Without tailscale
// available, the bind falls back to 127.0.0.1 (degrades to this-host-only, without blowing up).
// The CLIENT (when sync.peers is set) polls /sessions every 5s.
//
// Auth: bearer token compared in constant time (both sides hashed so the length
// doesn't leak — see the fastify-bearer-auth CVE). No token configured => refuse
// everything (fail-safe; main shouldn't even bring up the server without a token).
//
// Dependency injection: getSessions()/getTranscript() arrive via callbacks (from
// main/collect), keeping this module pure and testable without Electron.

const http = require('http');
const crypto = require('crypto');
const nodeNet = require('net');
const { execFileSync } = require('child_process');

// WebSocket for the /pty endpoint (remote attach). try/catch: without the dep (tests/CI),
// the module remains valid — only /pty doesn't come up (graceful degradation).
let WebSocketServer = null;
try { ({ WebSocketServer } = require('ws')); } catch {}

// This machine's IP on the tailnet (100.64.0.0/10), for the server to bind DIRECTLY to it
// instead of localhost — this way peers reach http://<my-tailnet-ip>:<port>
// without needing `tailscale serve`. Memoized; null if tailscale is absent (falls
// back to localhost: the feature degrades to this-host-only, without blowing up).
let _tsIP;
function detectTailnetIP() {
  // Only cache SUCCESS (a valid 100.x IP). On failure (tailscale still coming up
  // at boot, restricted Electron PATH) do NOT cache null — retry on the next
  // cycle. Before, it cached null forever and the server fell back to 127.0.0.1 until
  // the app was restarted (PR-32 #17).
  if (_tsIP !== undefined) return _tsIP;
  try {
    const ip = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 2000 }).trim();
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) _tsIP = ip;
  } catch { /* tailscale absent/starting up — retries later (doesn't cache null) */ }
  return _tsIP || null;
}

// Builds the set of online hosts from the JSON of `tailscale status --json`.
// PURE (no I/O) → testable. Canonical forms in the set: short HostName + FQDN
// (DNSName without trailing dot) + IPs — this way the gate matches a peer configured as a
// short hostname, MagicDNS FQDN or host:port (PR-32 #16: before it was HostName+IP only,
// and the FQDN never matched → peer treated as offline forever).
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
// Set of peers ONLINE per Tailscale, so the poller only hits the network for whoever is
// online (zero fetches while offline; detects "came online" at ~the main's refresh
// cadence). null if the status could not be confirmed; consumers fail closed.
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

// Safe URL authority for IPv4, IPv6 (with brackets) and Tailscale names.
function peerAuthority(host, defaultPort) {
  const p = parsePeerHost(host);
  const port = p && (p.port || +defaultPort);
  if (!p || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${p.ipv6 ? `[${p.host}]` : p.host}:${port}`;
}

// Tells whether a configured host is in the set of ONLINE identities confirmed by
// Tailscale. A `tailscale status` failure (null set) fails closed: the bearer token
// and PTY credentials are never sent to an unconfirmed destination.
function peerOnline(set, host) {
  if (!(set instanceof Set)) return false;
  const p = parsePeerHost(host);
  return !!p && set.has(p.host);
}

// Machine-local fields that do NOT cross the network (they only make sense on this host).
// tmux_pane focuses the pane on THIS host → local-only; tmux_session (remote attach)
// is deliberately LEFT OUT — it needs to cross the network to the peer.
//
// TODO NEW FOCUS HINT GOES HERE. The ENV_HINTS fields (src/focus.js)
// identify a window/tab/pane of THIS kernel; on a peer they point at
// nothing. test/net.test.js covers the whole list precisely so it fails when
// someone adds a hint and forgets this line.
const LOCAL_ONLY = ['windowid', 'focus_url', 'tilix_id', 'iterm_id', 'zellij_session', 'tmux_pane'];

// Compares the request token against the expected one without leaking timing/length:
// hashes both (SHA-256 → fixed 32 bytes) and uses timingSafeEqual. Empty token
// configured => always false (no access at all).
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

// Forwards output and applies the HIGH side of the backpressure hysteresis. Kept separate
// so the case can be covered deterministically without depending on the kernel buffer.
function forwardPtyOutput(ws, pty, data, high = 1 << 20) {
  ws.send(JSON.stringify({ type: 'out', data }));
  if (pty && !ws._paused && ws.bufferedAmount > high) {
    ws._paused = true;
    pty.pause();
  }
}

// Sanitizes a session before it goes on the wire: removes machine-local fields and stamps
// `origin` with THIS node's name (for the peerBadge overlay on the remote machine).
// readAtFor (optional, #56): (localSession) → epoch of the current read mark
// or undefined. Receives the session BEFORE the origin override — the read
// mark's key is in the local namespace (sessionKey → 'local:<pid>').
function exportSession(s, nodeName, nowSec, readAtFor) {
  const out = { ...s };
  for (const k of LOCAL_ONLY) delete out[k];
  out.origin = nodeName;
  // RELATIVE age (seconds since last_event) computed on the SERVER, on ITS
  // clock. The receiver re-anchors to the local clock via anchorRemote → eliminates clock
  // skew in the idle escalation of remote sessions (PR-32 #18).
  if (typeof nowSec === 'number' && typeof out.last_event_ts === 'number') {
    out.idleSec = Math.max(0, Math.floor(nowSec) - out.last_event_ts);
  }
  // #56: the read mark travels as a RELATIVE AGE (readIdleSec) for the SAME
  // reason as idleSec above — the receiver re-anchors (now - readIdleSec) and the
  // `last_event_ts <= readAt` comparison (state-machine) runs between two
  // timestamps on the SAME clock. A raw epoch (the origin's clock) would mix
  // clocks precisely with the last_event_ts that anchorRemote rewrote.
  const at = (typeof readAtFor === 'function') ? readAtFor(s) : undefined;
  if (typeof nowSec === 'number' && Number.isFinite(at) && at > 0) {
    out.readIdleSec = Math.max(0, Math.floor(nowSec) - at);
  }
  return out;
}

// Rewrites last_event_ts of a REMOTE session to the receiver's LOCAL clock,
// using idleSec (the relative age computed on the peer). Eliminates clock skew between
// peer and receiver (PR-32 #18): before, ageSec = nowLocal - last_event_ts_peer
// mixed clocks → false alarm (peer behind ≥ threshold) or real idle
// silenced (peer ahead). A session without idleSec (old peer) stays intact.
function anchorRemote(s, nowSec) {
  if (!s || s.idleSec == null) return s;
  const ts = Math.floor(nowSec) - Math.max(0, s.idleSec | 0);
  const out = { ...s };
  out.last_event_ts = ts;
  delete out.idleSec;
  return out;
}

// Reads the POST /read body with a CAP (default 64 KiB): a buggy peer (or an
// attacker holding the token) cannot allocate unbounded memory. cb(code|null, buf) —
// code set = error (413 over the cap / 400 empty); the `done` flag exists because
// 'data'+'end'+'error' can race and the cb is single-response. On 413 the
// response goes out IMMEDIATELY (early response — HTTP/1.1 allows answering
// before the body ends) and the rest of the stream is DISCARDED by the `done` guard:
// O(limit) memory without destroying the socket (destroy would kill the flush of the very
// response — the peer would see a reset instead of 413).
function readBody(req, cb, limit = 65536) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (code, buf) => { if (done) return; done = true; cb(code, buf); };
  req.on('data', (c) => {
    if (done) return;                 // post-response: the rest of the body flows and is discarded
    size += c.length;
    if (size > limit) return finish(413);
    chunks.push(c);
  });
  req.on('end', () => { if (!done) finish(chunks.length ? null : 400, Buffer.concat(chunks)); });
  req.on('error', () => finish(400));
}

// Sanitizes the POST /read payload: { now?, marks: [{key, readAt}] }. Returns
// { now, marks } (now = CLIENT epoch, or 0 if absent/invalid) or null
// if the body is not valid JSON/payload. Caps: 100 marks per request, key
// 1-256 chars, readAt integer > 0 (epoch s). Invalid items are DISCARDED
// individually — one bad item doesn't take down the whole batch.
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

// Brings up the server. Returns the http.Server. Binds to bindHost (default: the
// tailnet IP via detectTailnetIP — peers reach it directly; fallback 127.0.0.1).
//   getSessions()  → local array of sessions (from collect.readSessions)
//   getTranscript(key, n) → [{role,text,ts}] (stubbed to []; the real parser is phase 3)
//   onReadMarks(marks) → applies read marks coming from a peer (#56) and
//     returns how many were applied (0 = nothing changed). Optional: without the callback the
//     POST /read route responds 200 with applied=0 (degrades, doesn't break the peer).
//   readAtFor(localSession) → epoch of the session's current read mark (#56)
//     or undefined; becomes readIdleSec in the /sessions payload. Optional.
function startServer({ port, token, nodeName, shareTranscripts, allowAttach, ptySpawn, getSessions, getTranscript, onReadMarks, readAtFor, bindHost, onError }) {
  const server = http.createServer((req, res) => {
    const respond = (code, body) => { res.statusCode = code; res.end(JSON.stringify(body)); };
    res.setHeader('Content-Type', 'application/json');
    if (!tokenOk(bearerOf(req), token)) return respond(401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://127.0.0.1');
    // POST /read (#56): writes the read mark AT THE SESSION'S ORIGIN. The only
    // write route — comes before the GET gate below. Same Bearer auth:
    // whoever holds the token can already attach a shell via /pty; marking as read is
    // a much smaller write.
    if (req.method === 'POST') {
      if (url.pathname !== '/read') return respond(405, { error: 'method' });
      return readBody(req, (code, buf) => {
        if (code) return respond(code, { error: 'payload' });
        const parsed = parseReadMarks(buf);
        if (!parsed) return respond(400, { error: 'payload' });
        const marks = parsed.marks;
        // CLOCKS: readAt arrives on the CLIENT's clock; `now` (its epoch at
        // the moment of the POST) converts to THIS origin's clock: drift = current
        // epoch - now. The client's (anchored readAt, now) pair makes the poll→click
        // latencies cancel out — only the real skew remains. Without `now` (old
        // peer) it stays raw: degrades to the no-correction behavior.
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
      // Invalid parseInt ('?n=abc') yields NaN — and NaN passes through Math.min/max,
      // bypassing the cap of 50 (slice(-NaN) returns EVERYTHING). Explicit fallback.
      const p = parseInt(url.searchParams.get('n') || '20', 10);
      const n = Math.max(1, Math.min(50, Number.isFinite(p) ? p : 20));
      let msgs = [];
      if (key) { try { msgs = (getTranscript && getTranscript(key, n)) || []; } catch {} }
      return respond(200, { messages: msgs });
    }
    respond(404, { error: 'not found' });
  });
  // Without an error handler, EADDRINUSE (2nd instance, port in use, GUI+agent on the
  // same host) becomes an uncaughtException and kills the process (PR-32 #09). Degrade:
  // log + notify the caller via onError (DI); the server stays inert (this-host-only).
  server.on('error', (e) => { console.error('[net] server error', (e && e.code) || e); if (typeof onError === 'function') onError(e); });
  server.listen(port, bindHost || '127.0.0.1');   // tailnet IP for peers to reach directly; default localhost

  // /pty — remote terminal over WebSocket (live remote attach). Opt-in
  // (allowAttach) + INJECTED ptySpawn (DI): net.js doesn't know node-pty →
  // pure/testable module. Auth with the same token via the Authorization: Bearer header
  // (same as /sessions and /transcript) — the token is NEVER in the URL, so it doesn't leak into
  // tailscale access logs. tmux_session sanitized (anti-injection into the peer's
  // shell). JSON protocol per frame:
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
    // HEARTBEAT (PR-32 #12): a half-open connection (peer vanished without FIN) never
    // fires 'close' → the pty/tmux stayed alive indefinitely. ping/pong every
    // 30s; whoever doesn't answer gets terminate() (releases the pty via cleanup).
    const hb = setInterval(() => {
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      });
    }, 30000);
    hb.unref();
    // BACKPRESSURE (PR-32 #25): massive output (cat/yes/tail -f) without checking
    // bufferedAmount took down the main process with OOM — every chunk became an immediate
    // ws.send. Hysteresis: pause the pty at HIGH (1 MiB), resume at LOW (256 KiB).
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
          if (sess && !/^[A-Za-z0-9._-]+$/.test(sess)) return ws.close(4400, 'bad session');  // invalid gets rejected; absent = new shell
          cleanup();
          try {
            const cmd = sess ? ['tmux', 'attach', '-t', sess] : ['tmux', 'new-session', '-s', 'atl-shell-' + Date.now().toString(36), process.env.SHELL || 'bash'];   // no sess → new shell INSIDE a tmux (attachable, same as local)
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
    // Exposed so the caller can TEAR DOWN the in-flight shells when sync is turned off /
    // or the token changes: server.close() only stops ACCEPTING new connections; already
    // established ones stay alive (PR-32 #07). See closeSyncServer in main.
    server.closeAllPty = () => {
      try { wss.clients.forEach((ws) => { try { ws.terminate(); } catch {} }); } catch {}
      try { wss.close(); } catch {}   // fires wss 'close' → cleans up hb/bp
    };
  }
  return server;
}

// Polls /sessions on each peer. Each peer has its OWN timer with exponential
// BACKOFF: offline => rare (up to maxDelayMs, default 5min) and logs only the
// TRANSITION; online => normal cadence (intervalMs). This way an offline peer
// doesn't flood the log every 5s, and once it becomes reachable again the next cycle picks it up,
// resets the backoff and returns to normal (close to "only starts when online").
// onSessions on success; onPeerState(host, online) only on state CHANGES.
function pollPeers({ peers, port, token, intervalMs = 5000, maxDelayMs = 5 * 60 * 1000, offlineRecheckMs = 3000, onSessions, onPeerState, isOnline }) {
  if (!Array.isArray(peers) || !peers.length) return () => {};
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const timers = new Map();   // host -> timeout id (independent cadence per peer)
  const state = new Map();    // host -> { delay, online:null|bool }
  let stopped = false;

  async function pollOne(p) {
    if (stopped) return;
    const st = state.get(p.host);
    // Mandatory GATE: the caller confirms the online identity via Tailscale.
    // Without the predicate, invalid host or offline peer, not even the Bearer token is sent.
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
      const r = await fetch(`http://${hostPort}/sessions`, { headers, signal: AbortSignal.timeout(3000) });   // PR-32 #05: a blackholed peer doesn't hang the poll cycle
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      if (stopped) return;   // teardown during the fetch: don't repopulate the Map already cleared by the caller
      const origin = data.node || p.name || p.host;
      onSessions(p.host, (data.sessions || []).map((s) => anchorRemote({ ...s, origin }, Math.floor(Date.now() / 1000))));   // PR-32 #18: anchors last_event_ts to the local clock (peer's idleSec)
      ok = true;
    } catch { /* offline/error — becomes backoff below */ }
    if (ok) {
      st.delay = intervalMs;                                              // online: normal cadence
      if (st.online === false && onPeerState) onPeerState(p.host, true);  // came back
      st.online = true;
    } else {
      st.delay = Math.min(st.delay * 2, maxDelayMs);                      // exponential backoff
      if (st.online !== false && onPeerState) onPeerState(p.host, false); // went down (1st time)
      st.online = false;
    }
    if (!stopped) timers.set(p.host, setTimeout(() => pollOne(p), st.delay));
  }

  for (const p of peers) { state.set(p.host, { delay: intervalMs, online: null }); pollOne(p); }
  return () => { stopped = true; for (const id of timers.values()) clearTimeout(id); timers.clear(); };
}

// Fetches /transcript from a peer (client). Returns [] if host missing/error/403.
// Used by the main's fetch-transcript IPC when the user opens the panel of a
// REMOTE session (the local one is read straight from disk via collect+transcript).
async function fetchTranscriptFromPeer({ host, port, token, key, n = 20, onlineSet }) {
  if (!host || !key) return [];
  const hostPort = peerAuthority(host, port);
  if (!hostPort || !peerOnline(onlineSet, host)) return [];
  try {
    const r = await fetch(
      `http://${hostPort}/transcript?key=${encodeURIComponent(key)}&n=${n}`,
      { signal: AbortSignal.timeout(3000), ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) },   // PR-32 #05: a blackhole doesn't hang the view-prompt panel
    );
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data.messages) ? data.messages : [];
  } catch { return []; }
}

// Posts read marks to the ORIGIN of remote sessions (#56 — the POST /read
// client). The key must already be REWRITTEN into the origin's namespace
// (rewriteKeyOrigin: 'peer:1234' → 'local:1234') and `now` is THIS
// client's epoch, so the origin can convert readAt to its own clock (see drift in the
// POST handler). The caller treats it as fire-and-forget: on failure the
// optimistic local mark stays valid and the poll re-exports readIdleSec on the next
// cycle — convergence via /sessions, not via retry.
async function postReadToPeer({ host, port, token, marks, now }) {
  if (!host || !Array.isArray(marks) || !marks.length) return false;
  const hostPort = peerAuthority(host, port);
  if (!hostPort) return false;
  try {
    const r = await fetch(`http://${hostPort}/read`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),   // a blackhole doesn't hang the click
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ now, marks }),
    });
    return r.ok;
  } catch { return false; }
}

if (typeof module !== 'undefined') module.exports = { startServer, pollPeers, tokenOk, exportSession, fetchTranscriptFromPeer, postReadToPeer, detectTailnetIP, tailscaleOnlineSet, buildOnlineSet, peerOnline, peerAuthority, anchorRemote, forwardPtyOutput };
