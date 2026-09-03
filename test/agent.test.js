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
