const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

test('OpenCode preserva metadados e tmux quando o boot não os informa', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-opencode-'));
  const old = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  try {
    process.env.XDG_DATA_HOME = tmp;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const stateDir = path.join(tmp, 'ai-traffic-lights', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const sid = 'metadata1';
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      transcript_path: '/keep.jsonl', windowid: 'W', focus_url: 'F', tilix_id: 'T',
      tmux_session: 'work', tmux_pane: '%7', third_party: { keep: true }, events: [],
    }));
    const source = fs.readFileSync(path.join(ROOT, 'adapters', 'opencode', 'ai-traffic-lights.js'), 'utf8');
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const plugin = await mod.AiTrafficLights({ directory: '/workspace', $: null });
    await plugin['tool.execute.after']({ sessionID: sid, tool: 'read' });

    const st = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
    assert.equal(st.transcript_path, '/keep.jsonl');
    assert.equal(st.windowid, 'W');
    assert.equal(st.focus_url, 'F');
    assert.equal(st.tilix_id, 'T');
    assert.equal(st.tmux_session, 'work');
    assert.equal(st.tmux_pane, '%7');
    assert.deepEqual(st.third_party, { keep: true });
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('traffic-hook preserva metadados e tmux quando o evento não os informa', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-hook-'));
  try {
    const stateDir = path.join(tmp, 'ai-traffic-lights', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const sid = 'metadata2';
    fs.writeFileSync(path.join(stateDir, `${sid}.json`), JSON.stringify({
      transcript_path: '/keep.jsonl', windowid: 'W', focus_url: 'F', tilix_id: 'T',
      tmux_session: 'work', tmux_pane: '%7', third_party: { keep: true }, events: [],
    }));
    const r = spawnSync('bash', [path.join(ROOT, 'hooks', 'traffic-hook.sh')], {
      input: JSON.stringify({ session_id: sid, hook_event_name: 'Stop' }),
      encoding: 'utf8',
      env: { ...process.env, XDG_DATA_HOME: tmp, TMUX: '', TMUX_PANE: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    const st = JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8'));
    assert.equal(st.transcript_path, '/keep.jsonl');
    assert.equal(st.tmux_session, 'work');
    assert.equal(st.tmux_pane, '%7');
    assert.deepEqual(st.third_party, { keep: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
