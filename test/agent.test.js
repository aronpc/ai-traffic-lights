// Headless mode integration test (agent.js): starts the real process (pure
// Node, no Electron) and hits /sessions. Proves the Electron-free core
// (collect+net+transcript) chains together outside the GUI — ready for systemd
// on a headless server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const AGENT = path.join(__dirname, '..', 'agent.js');

// agent.js must NOT import Electron (that's the point of running without a
// display). Strips comments before checking (the agent's header mentions
// 'require(electron)' explaining it does NOT use it — the raw regex would match
// the comment).
test('agent.js é Electron-free (nenhum require do electron)', () => {
  const src = fs.readFileSync(AGENT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')    // /* */ blocks
    .replace(/\/\/.*$/gm, '');            // // lines
  assert.equal(src.match(/require\(['"]electron['"]\)/g), null, 'agent.js não pode require(electron)');
});

function startAgent(extraEnv, port) {
  return spawn(process.execPath, [AGENT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ATL_SYNC_ENABLED: '1', ATL_SYNC_SHARE: '1', ATL_SYNC_TOKEN: 'tok',
      ATL_SYNC_PORT: String(port),
      ATL_SYNC_BIND: '127.0.0.1',   // test on localhost (otherwise the agent binds to the tailnet IP)
      ...extraEnv,
    },
  });
}
async function waitForUp(port, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Authorization: 'Bearer tok' } });
      if (r.ok) return true;
    } catch {}
    await new Promise((rr) => setTimeout(rr, 80));
  }
  return false;
}

test('agent headless: sobe /sessions e atende com token (sem Electron)', async () => {
  const port = 47500 + Math.floor(Math.random() * 500);
  // ATL_APP_VERSION: the agent's beta gate refuses stable builds — the repo's
  // package.json stays on a stable version between betas, so the test declares
  // itself beta.
  const child = startAgent({ ATL_SYNC_NODE: 'test-srv', ATL_APP_VERSION: '999.0.0-beta.9' }, port);
  try {
    assert.ok(await waitForUp(port), 'servidor respondeu em /sessions');
    const r = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Authorization: 'Bearer tok' } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.node, 'test-srv', 'nodeName vem de ATL_SYNC_NODE');
    assert.ok(Array.isArray(data.sessions));
    const r2 = await fetch(`http://127.0.0.1:${port}/sessions`);  // no token
    assert.equal(r2.status, 401);
  } finally { child.kill('SIGTERM'); }
});

test('agent headless: desabilitado loga e sai (exit 0) sem pending handles', async () => {
  const child = spawn(process.execPath, [AGENT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ATL_SYNC_ENABLED: '0' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, 'processo termina sozinho (não fica pendurado)');
  assert.match(out, /desabilitado/);
});

// Read marks in headless mode (#56 + CodeRabbit PR #63): without
// onReadMarks/readAtFor the agent answered POST /read with applied=0 and
// never exported readIdleSec — a session read on another machine came back
// red on the next poll. XDG_DATA_HOME isolates the agent's STATE_DIR and
// read-marks.json (same DATA_HOME the settings/state files use).
test('agent headless: POST /read aplica a marca (LWW) e /sessions exporta readIdleSec', async () => {
  const dataHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'atl-agent-rm-'));
  const port = 47900 + Math.floor(Math.random() * 500);
  // a local session the agent can serve: state file in ITS (isolated) STATE_DIR
  const stateDir = path.join(dataHome, 'ai-traffic-lights', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '3f6d8c52-9a41-4b0e-8f2a-5c6d7e8f9a01.json'), JSON.stringify({
    schema_version: 2, agent: 'claude',
    session_id: '3f6d8c52-9a41-4b0e-8f2a-5c6d7e8f9a01', pid: 3999999,
    cwd: '/srv/app', last_event: 'Stop', last_event_ts: Math.floor(Date.now() / 1000) - 300,
  }));
  const child = startAgent({ ATL_APP_VERSION: '999.0.0-beta.9', XDG_DATA_HOME: dataHome }, port);
  try {
    assert.ok(await waitForUp(port), 'servidor respondeu em /sessions');
    // 1. mark the session as read AT THE ORIGIN (key already in 'local:' namespace)
    const at = Math.floor(Date.now() / 1000) - 60;
    const r = await fetch(`http://127.0.0.1:${port}/read`, {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ now: Math.floor(Date.now() / 1000), marks: [{ key: 'local:3999999', readAt: at }] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).applied, 1, 'marca aplicada (não mais applied=0)');
    // 2. persisted in read-marks.json (survives agent restart, LWW state)
    const persisted = JSON.parse(fs.readFileSync(path.join(dataHome, 'ai-traffic-lights', 'read-marks.json'), 'utf8'));
    assert.ok(persisted['local:3999999'] > 0, 'marca persistida em read-marks.json');
    // 3. /sessions exports readIdleSec ≈ 60 → the receiver paints it gray
    const r2 = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { Authorization: 'Bearer tok' } });
    const sess = (await r2.json()).sessions.find((s) => s.pid === 3999999);
    assert.ok(sess, 'sessão fake aparece em /sessions');
    assert.ok(sess.readIdleSec >= 50 && sess.readIdleSec <= 70,
      `readIdleSec ≈ 60 (veio ${sess.readIdleSec})`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
});
