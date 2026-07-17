// Testes do transporte P2P (src/net.js): auth por token (constante) + servidor
// localhost de verdade (porta efêmera, fetch real) cobrindo /sessions e /transcript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tokenOk, exportSession, pollPeers, tailscaleOnlineSet } = require('../src/net.js');

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

// ---- pollPeers: backoff por peer + loga só a transição ----
test('tailscaleOnlineSet: null (sem tailscale) ou Set de hosts online', () => {
  const s = tailscaleOnlineSet();   // CI sem tailscale => null; máquina c/ tailscale => Set
  assert.ok(s === null || s instanceof Set, 'null ou Set');
  if (s instanceof Set) {
    for (const h of s) assert.equal(typeof h, 'string');   // hostnames/IPs lowercase
  }
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
