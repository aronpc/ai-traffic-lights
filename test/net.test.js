// Testes do transporte P2P (src/net.js): auth por token (constante) + servidor
// localhost de verdade (porta efêmera, fetch real) cobrindo /sessions e /transcript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tokenOk, exportSession, pollPeers, tailscaleOnlineSet, buildOnlineSet, peerOnline, anchorRemote } = require('../src/net.js');

// ---- tokenOk: compare constante, fail-safe ----
test('tokenOk: token correto → true', () => {
  assert.equal(tokenOk('sekret', 'sekret'), true);
});

test('tokenOk: token errado → false', () => {
  assert.equal(tokenOk('wrong', 'sekret'), false);
  assert.equal(tokenOk('', 'sekret'), false);          // request sem token
  assert.equal(tokenOk('sekret', ''), false);          // nada configurado => recusa
  assert.equal(tokenOk(null, 'sekret'), false);
  assert.equal(tokenOk('sekret', null), false);
});

test('tokenOk: não vaza length (tokens de tamanho diferente não estouram)', () => {
  // hashes têm tamanho fixo; timingSafeEqual compara 32 bytes nos dois casos.
  assert.equal(tokenOk('a', 'longosecret'), false);
  assert.equal(tokenOk('longosecret', 'a'), false);
});

// ---- exportSession: strips machine-local + marca origin ----
test('exportSession: remove campos machine-local e seta origin', () => {
  const out = exportSession(
    { session_id: 's1', pid: 1, cwd: '/x', windowid: 99, focus_url: 'warp://x', tilix_id: 't', zellij_session: 'z', model: 'glm-5.2' },
    'alienware',
  );
  assert.deepEqual(out, { session_id: 's1', pid: 1, cwd: '/x', model: 'glm-5.2', origin: 'alienware' });
});

test('exportSession: com nowSec, inclui idleSec (idade relativa do servidor)', () => {
  const out = exportSession({ session_id: 's1', last_event_ts: 1000 }, 'peer', 1300);
  assert.equal(out.idleSec, 300, 'idleSec = nowSec - last_event_ts');
});

test('anchorRemote: reescreve last_event_ts no relógio local via idleSec (sem clock skew)', () => {
  const s = { session_id: 's1', origin: 'peer', last_event_ts: 999999, idleSec: 120 };
  const out = anchorRemote(s, 5000);   // receptor: agora=5000 local, idle 120s no peer
  assert.equal(out.last_event_ts, 4880, '4880 = 5000 - 120 (relógio LOCAL, skew-free)');
  assert.equal(out.idleSec, undefined, 'idleSec consumido (não vaza p/ o renderer)');
});

test('anchorRemote: sem idleSec (peer antigo) → sessão intacta', () => {
  const s = { session_id: 's1', origin: 'peer', last_event_ts: 999999 };
  assert.equal(anchorRemote(s, 5000), s, 'mesma ref, sem alteração');
});

// ---- startServer: integração localhost (porta efêmera, fetch real) ----
async function up(opts) {
  const server = startServer({ port: 0, token: 'tok', nodeName: 'me', shareTranscripts: false, getSessions: () => [{ session_id: 's1', pid: 1, windowid: 7 }], getTranscript: () => [], ...opts });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  return { server, port };
}
async function GET(port, path, token) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
  return { status: r.status, json: await r.json() };
}

test('server: /sessions sem token → 401', async () => {
  const { server, port } = await up({});
  try { assert.equal((await GET(port, '/sessions')).status, 401); }
  finally { server.close(); }
});

test('server: /sessions token errado → 401; certo → 200 sem campos locais', async () => {
  const { server, port } = await up({});
  try {
    assert.equal((await GET(port, '/sessions', 'wrong')).status, 401);
    const { status, json } = await GET(port, '/sessions', 'tok');
    assert.equal(status, 200);
    assert.equal(json.node, 'me');
    assert.equal(json.sessions.length, 1);
    assert.equal(json.sessions[0].session_id, 's1');
    assert.equal(json.sessions[0].windowid, undefined, 'windowid não atravessa');
    assert.equal(json.sessions[0].origin, 'me');
  } finally { server.close(); }
});

test('server: /transcript 403 se shareTranscripts=false; 200 (msgs) se true', async () => {
  const { server, port } = await up({});   // shareTranscripts false
  try { assert.equal((await GET(port, '/transcript?key=s1&n=5', 'tok')).status, 403); }
  finally { server.close(); }

  const s2 = await up({ shareTranscripts: true, getTranscript: (k, n) => [{ role: 'user', text: 'oi ' + k, ts: 1 }] });
  try {
    const { status, json } = await GET(s2.port, '/transcript?key=s1&n=5', 'tok');
    assert.equal(status, 200);
    assert.deepEqual(json.messages, [{ role: 'user', text: 'oi s1', ts: 1 }]);
  } finally { s2.server.close(); }
});

test('server: rota desconhecida → 404', async () => {
  const { server, port } = await up({});
  try { assert.equal((await GET(port, '/nope', 'tok')).status, 404); }
  finally { server.close(); }
});

test('server: EADDRINUSE (porta em uso) → chama onError, não crasha o processo', async () => {
  const { server: s1, port } = await up({});
  try {
    const errP = new Promise((res) => {
      startServer({ port, token: 'tok', nodeName: 'me', getSessions: () => [], getTranscript: () => [], onError: res });
    });
    const e = await errP;   // sem o handler, isso seria uncaughtException (processo morre)
    assert.match(String((e && e.code) || e), /EADDRINUSE/);
  } finally { s1.close(); }
});

// ---- /pty: terminal remoto via WebSocket (allowAttach + ptySpawn DI) ----
const WebSocket = require('ws');
function fakePty() { return { write() {}, resize() {}, kill() {} }; }
async function wsOpen(port, token) {
  // token via header Authorization: Bearer (igual ao cliente real) — nunca na URL.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty`, token != null ? { headers: { Authorization: 'Bearer ' + token } } : {});
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', rej); });
  return ws;
}

test('/pty: sem allowAttach → handshake recusado (upgrade não sobe)', async () => {
  const { server, port } = await up({});   // allowAttach ausente
  try { await assert.rejects(() => wsOpen(port, 'tok')); }
  finally { server.close(); }
});

test('/pty: token errado/ausente → handshake rejeitado', async () => {
  const { server, port } = await up({ allowAttach: true, ptySpawn: fakePty });
  try {
    await assert.rejects(() => wsOpen(port, 'wrong'));
    await assert.rejects(() => wsOpen(port, null));
  } finally { server.close(); }
});

test('/pty: start c/ session inválido → close 4400; válido → ptySpawn recebe argv do attach', async () => {
  const calls = [];
  const { server, port } = await up({ allowAttach: true, ptySpawn: (cmd, c, r) => { calls.push(cmd); return fakePty(); } });
  try {
    const ws1 = await wsOpen(port, 'tok');
    const code = new Promise((res) => ws1.once('close', res));
    ws1.send(JSON.stringify({ type: 'start', tmux_session: '../evil; rm -rf /' }));
    assert.equal(await code, 4400, 'session malicioso → close 4400');

    const ws2 = await wsOpen(port, 'tok');
    ws2.send(JSON.stringify({ type: 'start', tmux_session: 'work', cols: 90, rows: 20 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(calls[calls.length - 1], ['tmux', 'attach', '-t', 'work'], 'ptySpawn recebeu o argv do attach');
    ws2.close();
  } finally { server.close(); }
});

// ---- pollPeers: backoff por peer + loga só a transição ----
test('tailscaleOnlineSet: null (sem tailscale) ou Set de hosts online', () => {
  const s = tailscaleOnlineSet();   // CI sem tailscale => null; máquina c/ tailscale => Set
  assert.ok(s === null || s instanceof Set, 'null ou Set');
  if (s instanceof Set) {
    for (const h of s) assert.equal(typeof h, 'string');   // hostnames/IPs lowercase
  }
});

// ---- buildOnlineSet: formas canônicas (HostName + FQDN + IPs) ----
test('buildOnlineSet: inclui HostName curto + FQDN (DNSName sem dot) + IPs', () => {
  const set = buildOnlineSet({
    Peer: {
      p1: { Online: true, HostName: 'Alienware', DNSName: 'alienware.tailXXXX.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c::1'] },
      p2: { Online: false, HostName: 'offline', TailscaleIPs: ['100.64.0.2'] },   // offline → fora
    },
  });
  assert.ok(set.has('alienware'), 'hostname curto lowercased');
  assert.ok(set.has('alienware.tailxxxx.ts.net'), 'FQDN lowercased sem trailing dot');
  assert.ok(set.has('100.64.0.1'), 'IPv4');
  assert.ok(set.has('fd7a:115c::1'), 'IPv6');
  assert.ok(!set.has('offline'), 'peer offline não entra');
  assert.ok(!set.has('alienware.tailXXXX.ts.net.'), 'trailing dot removido');
});

// ---- peerOnline: casa hostname / FQDN / host:porta / IP (PR-32 #16) ----
test('peerOnline: hostname curto, FQDN, host:porta e IP casam; offline não', () => {
  const set = buildOnlineSet({ Peer: { p: { Online: true, HostName: 'notebook-hg', DNSName: 'notebook-hg.tailAB.ts.net.', TailscaleIPs: ['100.64.0.9'] } } });
  assert.equal(peerOnline(set, 'notebook-hg'), true);
  assert.equal(peerOnline(set, 'NOTEBOOK-HG'), true);                       // case-insensitive
  assert.equal(peerOnline(set, 'notebook-hg.tailab.ts.net'), true);         // FQDN (MagicDNS)
  assert.equal(peerOnline(set, 'notebook-hg:47474'), true);                 // host:porta (UI sugere)
  assert.equal(peerOnline(set, '100.64.0.9'), true);                        // IP
  assert.equal(peerOnline(set, '100.64.0.9:47474'), true);                  // IP:porta
  assert.equal(peerOnline(set, 'outro-host'), false);                       // não configurado
  assert.equal(peerOnline(null, 'qualquer'), true);                         // sem gate => online
});

test('peerOnline: IPv6 não é tratado como porta (preserva o host)', () => {
  const set = buildOnlineSet({ Peer: { p: { Online: true, HostName: 'n6', TailscaleIPs: ['fd7a:115c:a1e0:b1a:0:0:0:1234'] } } });
  assert.equal(peerOnline(set, 'fd7a:115c:a1e0:b1a:0:0:0:1234'), true);    // IPv6 intacto
});

test('pollPeers: peer offline → onPeerState(false) UMA vez (backoff, sem spam)', async () => {
  const calls = { online: 0, offline: 0, sessions: 0 };
  const stop = pollPeers({
    peers: [{ host: '127.0.0.1', name: 'x' }], port: 1, token: 't',  // porta 1 fechada → recusa
    intervalMs: 30, maxDelayMs: 60,
    onSessions: () => calls.sessions++,
    onPeerState: (_h, on) => { if (on) calls.online++; else calls.offline++; },
  });
  await new Promise((r) => setTimeout(r, 400));
  stop();
  assert.equal(calls.offline, 1, 'loga offline só 1 vez (transição), não a cada tentativa');
  assert.equal(calls.online, 0);
  assert.equal(calls.sessions, 0);
});
