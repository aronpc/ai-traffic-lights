// Tests for the P2P transport (src/net.js): constant-time token auth + a
// real localhost server (ephemeral port, real fetch) covering /sessions and /transcript.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, tokenOk, exportSession, pollPeers, fetchTranscriptFromPeer, postReadToPeer, tailscaleOnlineSet, buildOnlineSet, peerOnline, peerAuthority, anchorRemote, forwardPtyOutput } = require('../src/net.js');

// ---- tokenOk: constant-time compare, fail-safe ----
test('tokenOk: token correto → true', () => {
  assert.equal(tokenOk('sekret', 'sekret'), true);
});

test('tokenOk: token errado → false', () => {
  assert.equal(tokenOk('wrong', 'sekret'), false);
  assert.equal(tokenOk('', 'sekret'), false);          // request without token
  assert.equal(tokenOk('sekret', ''), false);          // nothing configured => refuse
  assert.equal(tokenOk(null, 'sekret'), false);
  assert.equal(tokenOk('sekret', null), false);
});

test('tokenOk: não vaza length (tokens de tamanho diferente não estouram)', () => {
  // hashes have a fixed length; timingSafeEqual compares 32 bytes in both cases.
  assert.equal(tokenOk('a', 'longosecret'), false);
  assert.equal(tokenOk('longosecret', 'a'), false);
});

// ---- exportSession: strips machine-local fields + sets origin ----
// The fixture carries ALL focus hints on purpose: they identify a
// window/tab/pane of this kernel and point to nothing on a peer. Anyone who
// adds a new hint to ENV_HINTS (src/focus.js) and forgets the LOCAL_ONLY
// list (src/net.js) breaks this test.
test('exportSession: remove TODO campo machine-local e seta origin', () => {
  const out = exportSession(
    {
      session_id: 's1', pid: 1, cwd: '/x', model: 'glm-5.2',
      windowid: 99, focus_url: 'warp://x', tilix_id: 't', iterm_id: 'w0t0p0:u',
      zellij_session: 'z', tmux_pane: '%7',
    },
    'alienware',
  );
  assert.deepEqual(out, { session_id: 's1', pid: 1, cwd: '/x', model: 'glm-5.2', origin: 'alienware' });
});

// tmux_session is the deliberate exception: the remote attach needs it on
// the other side, so it is NOT local-only.
test('exportSession: tmux_session atravessa a rede (attach remoto depende dele)', () => {
  const out = exportSession({ session_id: 's1', tmux_session: 'home-8' }, 'alienware');
  assert.equal(out.tmux_session, 'home-8');
});

test('exportSession: com nowSec, inclui idleSec (idade relativa do servidor)', () => {
  const out = exportSession({ session_id: 's1', last_event_ts: 1000 }, 'peer', 1300);
  assert.equal(out.idleSec, 300, 'idleSec = nowSec - last_event_ts');
});

test('anchorRemote: reescreve last_event_ts no relógio local via idleSec (sem clock skew)', () => {
  const s = { session_id: 's1', origin: 'peer', last_event_ts: 999999, idleSec: 120 };
  const out = anchorRemote(s, 5000);   // receiver: now=5000 local, idle 120s on the peer
  assert.equal(out.last_event_ts, 4880, '4880 = 5000 - 120 (relógio LOCAL, skew-free)');
  assert.equal(out.idleSec, undefined, 'idleSec consumido (não vaza p/ o renderer)');
});

test('anchorRemote: sem idleSec (peer antigo) → sessão intacta', () => {
  const s = { session_id: 's1', origin: 'peer', last_event_ts: 999999 };
  assert.equal(anchorRemote(s, 5000), s, 'mesma ref, sem alteração');
});

// ---- exportSession with readAtFor (#56): the read mark travels as a relative
// AGE (readIdleSec), the same pattern as idleSec — never a raw epoch, or the
// origin's clock skew would re-enter through the `last_event_ts <= readAt` comparison.
test('exportSession: com readAtFor + nowSec, inclui readIdleSec (idade da marca)', () => {
  const out = exportSession({ session_id: 's1', pid: 42 }, 'me', 5000, () => 4200);
  assert.equal(out.readIdleSec, 800, 'readIdleSec = nowSec - readAt');
});

test('exportSession: sem marca vigente → sem readIdleSec (readAtFor undefined)', () => {
  const out = exportSession({ session_id: 's1', pid: 42 }, 'me', 5000, () => undefined);
  assert.equal(out.readIdleSec, undefined, 'sem marca, sem campo');
  const semCb = exportSession({ session_id: 's1', pid: 42 }, 'me', 5000);
  assert.equal(semCb.readIdleSec, undefined, 'sem readAtFor (peer legado), sem campo');
});

// The entire chain in a single test (executable documentation): the ORIGIN
// exports age; the RECEIVER re-anchors on its own clock and recovers the EXACT
// readAt the origin had — even with completely different clocks (5000 vs 999999).
test('cadeia #56: export(idade) → receptor re-ancora → readAt original recuperado', () => {
  // origin: the origin's clock reads 5000, the read mark was set at 4000
  const exported = exportSession({ session_id: 's1', pid: 42 }, 'me', 5000, () => 4000);
  assert.equal(exported.readIdleSec, 1000);
  // receiver: local clock 6000 when the poll arrives — re-anchors both
  // fields by the SAME now (anchorRemote already handles last_event_ts)
  const anchored = anchorRemote(exported, 6000);
  const readAt = 6000 - anchored.readIdleSec;
  assert.equal(readAt, 5000, 'readAt do receptor = nowLocal - readIdleSec (relógio local)');
  // last_event_ts and readAt now live on the SAME clock: the state-machine
  // comparison (`last_event_ts <= readAt`) is skew-free
});

// ---- startServer: localhost integration (ephemeral port, real fetch) ----
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
async function POST(port, path, token, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
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

// ---- POST /read (#56): writing the read mark AT THE ORIGIN ----
test('POST /read: sem/errado token → 401; certo → 200 com applied e marks saneadas', async () => {
  const received = [];
  const { server, port } = await up({ onReadMarks: (m) => { received.push(...m); return m.length; } });
  try {
    assert.equal((await POST(port, '/read', undefined, { marks: [] })).status, 401, 'sem token');
    assert.equal((await POST(port, '/read', 'wrong', { marks: [] })).status, 401, 'token errado');
    const { status, json } = await POST(port, '/read', 'tok', {
      marks: [
        { key: 'local:1234', readAt: 1730000000 },
        { key: '', readAt: 5 },            // empty key → discarded during sanitization
        { key: 'local:x', readAt: 'não' }, // invalid readAt → discarded
        null,                              // non-object item → discarded
      ],
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.applied, 1, 'callback viu só o item válido');
    assert.deepEqual(received, [{ key: 'local:1234', readAt: 1730000000 }]);
  } finally { server.close(); }
});

test('POST /read: payload inválido (não-JSON / sem marks) → 400', async () => {
  const { server, port } = await up({ onReadMarks: () => 0 });
  try {
    assert.equal((await POST(port, '/read', 'tok', '{isso não é json')).status, 400);
    assert.equal((await POST(port, '/read', 'tok', { nope: 1 })).status, 400, 'sem array marks');
    assert.equal((await POST(port, '/read', 'tok', '""')).status, 400, 'body não-objeto');
  } finally { server.close(); }
});

test('POST /read: sem callback onReadMarks → 200 com applied=0 (degrada, não quebra o peer)', async () => {
  const { server, port } = await up({});
  try {
    const { status, json } = await POST(port, '/read', 'tok', { marks: [{ key: 'local:1', readAt: 10 }] });
    assert.equal(status, 200);
    assert.deepEqual(json, { ok: true, applied: 0 });
  } finally { server.close(); }
});

test('POST /read: callback que lança → 200 applied=0 (marca nunca derruba o servidor)', async () => {
  const { server, port } = await up({ onReadMarks: () => { throw new Error('boom'); } });
  try {
    const { status, json } = await POST(port, '/read', 'tok', { marks: [{ key: 'local:1', readAt: 10 }] });
    assert.equal(status, 200);
    assert.equal(json.applied, 0);
  } finally { server.close(); }
});

test('POST em outra rota → 405 (gate method intacto p/ tudo que não é /read)', async () => {
  const { server, port } = await up({});
  try {
    assert.equal((await POST(port, '/sessions', 'tok', { marks: [] })).status, 405);
    assert.equal((await POST(port, '/nope', 'tok', {})).status, 405);
    // and the earlier gate still holds for non-GET/non-POST methods
    const r = await fetch(`http://127.0.0.1:${port}/sessions`, { method: 'DELETE', headers: { Authorization: 'Bearer tok' } });
    assert.equal(r.status, 405);
  } finally { server.close(); }
});

test('POST /read: body acima do teto (64 KiB) → 413', async () => {
  const { server, port } = await up({ onReadMarks: () => 0 });
  try {
    // marks of 100 keys of 256 chars ≈ 26 KB → 3x that blows past the cap.
    const big = { marks: [] };
    for (let i = 0; i < 900; i++) big.marks.push({ key: 'k'.repeat(256), readAt: 1 });
    assert.equal(big.marks.length, 900, 'sanidade do fixture (~230 KB)');
    const { status } = await POST(port, '/read', 'tok', big);
    assert.equal(status, 413);
  } finally { server.close(); }
});

// ---- POST drift (#56): the (readAt, now) pair converts readAt to the
// ORIGIN's clock — the poster is a receiver whose mark was re-anchored by the
// poll; without this, readAt would arrive on the wrong clock and the origin's
// internal comparison (last_event_ts <= readAt) would break with clock skew.
test('POST /read: now no passado distante → readAt chega MAIOR (drift aplicado)', async () => {
  let received = null;
  const { server, port } = await up({ onReadMarks: (m) => { received = m; return 1; } });
  try {
    const nowPeer = Math.floor(Date.now() / 1000) - 100;   // client clock 100s behind
    const { status, json } = await POST(port, '/read', 'tok', {
      now: nowPeer, marks: [{ key: 'local:1234', readAt: 1000 }],
    });
    assert.equal(status, 200);
    assert.equal(json.applied, 1);
    assert.ok(received, 'onReadMarks chamado');
    assert.equal(received[0].key, 'local:1234');
    // drift = originNow - nowPeer ≈ +100 (±5 tolerance for slow execution)
    assert.ok(received[0].readAt >= 1095 && received[0].readAt <= 1105,
      `readAt re-ancorado ao relógio da origem (veio ${received[0].readAt}, esperado ~1100)`);
  } finally { server.close(); }
});

test('POST /read: drift nunca derruba readAt abaixo de 1 (now no futuro)', async () => {
  let received = null;
  const { server, port } = await up({ onReadMarks: (m) => { received = m; return 1; } });
  try {
    const nowPeer = Math.floor(Date.now() / 1000) + 3600;   // client 1h ahead
    await POST(port, '/read', 'tok', { now: nowPeer, marks: [{ key: 'local:7', readAt: 500 }] });
    assert.equal(received[0].readAt, 1, 'clamp: readAt + drift negativo → mínimo 1, nunca 0/negativo');
  } finally { server.close(); }
});

// ---- /sessions exports readIdleSec when main feeds readAtFor ----
test('server: /sessions com readAtFor → payload inclui readIdleSec da marca vigente', async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const { server, port } = await up({
    readAtFor: (s) => (s.pid === 1 ? nowS - 240 : undefined),
  });
  try {
    const { status, json } = await GET(port, '/sessions', 'tok');
    assert.equal(status, 200);
    const sess = json.sessions[0];
    assert.ok(sess.readIdleSec >= 238 && sess.readIdleSec <= 242,
      `readIdleSec ≈ 240 (veio ${sess.readIdleSec})`);
  } finally { server.close(); }
});

// ---- postReadToPeer (#56): fire-and-forget client that posts the mark ----
test('postReadToPeer: servidor real recebe marks saneadas + now', async () => {
  let body = null;
  const { server, port } = await up({ onReadMarks: (m) => { body = m; return m.length; } });
  try {
    const ok = await postReadToPeer({
      host: '127.0.0.1', port, token: 'tok',
      now: 1730000000, marks: [{ key: 'local:1234', readAt: 1729999000 }],
    });
    assert.equal(ok, true, 'POST aceito');
    // drift = now - 1730000000 (huge), but the assert only checks the PAIR arrives:
    assert.ok(body, 'onReadMarks recebeu as marks');
    assert.equal(body[0].key, 'local:1234', 'chave já no namespace da origem');
  } finally { server.close(); }
});

test('postReadToPeer: token errado → false (sem throw)', async () => {
  const { server, port } = await up({ onReadMarks: () => 0 });
  try {
    const ok = await postReadToPeer({ host: '127.0.0.1', port, token: 'wrong', marks: [{ key: 'x', readAt: 1 }] });
    assert.equal(ok, false, '401 vira false, caller segue vivo');
  } finally { server.close(); }
});

test('postReadToPeer: host inalcançável → false rápido (timeout, sem throw)', async () => {
  const ok = await postReadToPeer({
    host: '127.0.0.1', port: 1, token: 'tok',   // port 1: nothing listening
    now: 1, marks: [{ key: 'x', readAt: 1 }],
  });
  assert.equal(ok, false, 'ECONNREFUSED vira false');
});

test('postReadToPeer: guard — sem host ou sem marks → false sem rede', async () => {
  assert.equal(await postReadToPeer({ port: 1, token: 't', marks: [{ key: 'x', readAt: 1 }] }), false, 'sem host');
  assert.equal(await postReadToPeer({ host: '127.0.0.1', port: 1, token: 't', marks: [] }), false, 'marks vazio');
  assert.equal(await postReadToPeer({ host: '127.0.0.1', port: 1, token: 't' }), false, 'sem marks');
});

test('server: EADDRINUSE (porta em uso) → chama onError, não crasha o processo', async () => {
  const { server: s1, port } = await up({});
  try {
    const errP = new Promise((res) => {
      startServer({ port, token: 'tok', nodeName: 'me', getSessions: () => [], getTranscript: () => [], onError: res });
    });
    const e = await errP;   // without the handler this would be an uncaughtException (process dies)
    assert.match(String((e && e.code) || e), /EADDRINUSE/);
  } finally { s1.close(); }
});

// ---- /pty: remote terminal via WebSocket (allowAttach + ptySpawn DI) ----
const WebSocket = require('ws');
function fakePty() { return { write() {}, resize() {}, kill() {} }; }
async function wsOpen(port, token) {
  // token via Authorization: Bearer header (same as the real client) — never in the URL.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/pty`, token != null ? { headers: { Authorization: 'Bearer ' + token } } : {});
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', rej); });
  return ws;
}

test('/pty: sem allowAttach → handshake recusado (upgrade não sobe)', async () => {
  const { server, port } = await up({});   // allowAttach absent
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

// PR-32 #07: turning sync off / rotating the token must TAKE DOWN the shells
// already connected. server.close() alone only stops accepting new
// connections — the in-flight attach survived, contradicting what the toggle
// promises.
test('/pty: closeAllPty derruba conexões ATIVAS e mata o pty (não só recusa novas)', async () => {
  let killed = 0;
  const { server, port } = await up({ allowAttach: true, ptySpawn: () => ({ write() {}, resize() {}, kill() { killed++; } }) });
  try {
    const ws = await wsOpen(port, 'tok');
    const closed = new Promise((res) => ws.once('close', res));
    ws.send(JSON.stringify({ type: 'start', tmux_session: 'work' }));
    await new Promise((r) => setTimeout(r, 30));

    server.closeAllPty();                       // = turning sync off in the toggle
    await closed;                               // the live connection DROPS
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(killed, 1, 'o pty do shell remoto foi morto');
  } finally { server.close(); }
});

test('/pty: closeAllPty só existe quando allowAttach está ligado', async () => {
  const { server } = await up({});              // no allowAttach → no /pty
  try { assert.equal(typeof server.closeAllPty, 'undefined'); }
  finally { server.close(); }
});

test('/pty: HIGH backpressure pausa o pty', () => {
  let payload = null;
  let paused = 0;
  const ws = { bufferedAmount: (1 << 20) + 1, _paused: false, send: (d) => { payload = JSON.parse(d); } };
  forwardPtyOutput(ws, { pause: () => { paused++; } }, 'chunk');
  assert.deepEqual(payload, { type: 'out', data: 'chunk' });
  assert.equal(paused, 1);
  assert.equal(ws._paused, true);
});

// ---- pollPeers: per-peer backoff + logs only the transition ----
test('tailscaleOnlineSet: null (sem tailscale) ou Set de hosts online', () => {
  const s = tailscaleOnlineSet();   // CI without tailscale => null; machine with tailscale => Set
  assert.ok(s === null || s instanceof Set, 'null ou Set');
  if (s instanceof Set) {
    for (const h of s) assert.equal(typeof h, 'string');   // hostnames/IPs lowercase
  }
});

// ---- buildOnlineSet: canonical forms (HostName + FQDN + IPs) ----
test('buildOnlineSet: inclui HostName curto + FQDN (DNSName sem dot) + IPs', () => {
  const set = buildOnlineSet({
    Peer: {
      p1: { Online: true, HostName: 'Alienware', DNSName: 'alienware.tailXXXX.ts.net.', TailscaleIPs: ['100.64.0.1', 'fd7a:115c::1'] },
      p2: { Online: false, HostName: 'offline', TailscaleIPs: ['100.64.0.2'] },   // offline → out
    },
  });
  assert.ok(set.has('alienware'), 'hostname curto lowercased');
  assert.ok(set.has('alienware.tailxxxx.ts.net'), 'FQDN lowercased sem trailing dot');
  assert.ok(set.has('100.64.0.1'), 'IPv4');
  assert.ok(set.has('fd7a:115c::1'), 'IPv6');
  assert.ok(!set.has('offline'), 'peer offline não entra');
  assert.ok(!set.has('alienware.tailXXXX.ts.net.'), 'trailing dot removido');
});

// ---- peerOnline: matches hostname / FQDN / host:port / IP (PR-32 #16) ----
test('peerOnline: hostname curto, FQDN, host:porta e IP casam; offline não', () => {
  const set = buildOnlineSet({ Peer: { p: { Online: true, HostName: 'notebook-hg', DNSName: 'notebook-hg.tailAB.ts.net.', TailscaleIPs: ['100.64.0.9'] } } });
  assert.equal(peerOnline(set, 'notebook-hg'), true);
  assert.equal(peerOnline(set, 'NOTEBOOK-HG'), true);                       // case-insensitive
  assert.equal(peerOnline(set, 'notebook-hg.tailab.ts.net'), true);         // FQDN (MagicDNS)
  assert.equal(peerOnline(set, 'notebook-hg:47474'), true);                 // host:port (what the UI suggests)
  assert.equal(peerOnline(set, '100.64.0.9'), true);                        // IP
  assert.equal(peerOnline(set, '100.64.0.9:47474'), true);                  // IP:port
  assert.equal(peerOnline(set, 'outro-host'), false);                       // not configured
  assert.equal(peerOnline(null, 'qualquer'), false);                        // status failed => fail closed
});

test('peerOnline: IPv6 não é tratado como porta (preserva o host)', () => {
  const set = buildOnlineSet({ Peer: { p: { Online: true, HostName: 'n6', TailscaleIPs: ['fd7a:115c:a1e0:b1a:0:0:0:1234'] } } });
  assert.equal(peerOnline(set, 'fd7a:115c:a1e0:b1a:0:0:0:1234'), true);    // IPv6 intact
});

test('peerAuthority: valida nomes/IPs e formata IPv6 com colchetes', () => {
  assert.equal(peerAuthority('notebook.tailab.ts.net', 47474), 'notebook.tailab.ts.net:47474');
  assert.equal(peerAuthority('100.64.0.9:4242', 47474), '100.64.0.9:4242');
  assert.equal(peerAuthority('fd7a:115c::1', 47474), '[fd7a:115c::1]:47474');
  for (const bad of ['https://evil.test', 'user@host', 'host/path', '999.999.1.1', ' host']) {
    assert.equal(peerAuthority(bad, 47474), null, bad);
  }
});

test('fetchTranscriptFromPeer não envia credencial sem identidade Tailscale confirmada', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('não deveria chamar'); };
  try {
    assert.deepEqual(await fetchTranscriptFromPeer({
      host: 'peer', port: 47474, token: 'segredo', key: 's1', onlineSet: null,
    }), []);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
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
