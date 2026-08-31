// Testes de regressão do adapter Kiro (PR #46). Carregam o arquivo REAL num vm
// Nota: AssistantMessage → PreToolUse e ToolResults → PostToolUse. O adapter
// nasceu com esse mapeamento invertido (s5 do review da PR-46) e estes testes
// codificavam a inversão; a cor não muda (ambos são PROCESSING), mas o
// `last_event` aparece na linha do overlay e precisa descrever o que houve.
// com fs mock in-memory e cobrem os achados 6-11 do review: crash-safety das
// escritas, truncate/compactação do .jsonl, merge-preserve, cwd via .json,
// zumbi pid:null e a síntese de Stop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fsCode = require('node:fs').readFileSync(
  path.join(__dirname, '..', 'adapters', 'kiro', 'ai-traffic-lights.js'), 'utf8'
);

const HOME = '/home/test';
const KDIR = `${HOME}/.kiro/sessions/cli`;
const STATE = '/data/ai-traffic-lights/state';

function makeFs() {
  const store = new Map();
  const dirs = new Set([KDIR, STATE]);
  let failTmp = false;
  const mk = (code, msg) => Object.assign(new Error(msg), { code });
  const mfs = {
    existsSync: (p) => store.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    writeFileSync: (p, data) => {
      if (!dirs.has(path.dirname(p))) throw mk('ENOENT', `no dir ${path.dirname(p)}`);
      if (failTmp && p.endsWith('.tmp')) throw mk('EACCES', 'failTmp on');
      store.set(p, String(data));
    },
    renameSync: (from, to) => {
      if (!store.has(from)) throw mk('ENOENT', from);
      store.set(to, store.get(from));
      store.delete(from);
    },
    readFileSync: (p) => {
      if (!store.has(p)) throw mk('ENOENT', p);
      return store.get(p);
    },
    readdirSync: (p) => {
      if (!dirs.has(p) && !store.has(p)) throw mk('ENOENT', p);
      const out = new Set();
      for (const k of store.keys()) if (k.startsWith(`${p}/`)) out.add(path.basename(k));
      return [...out];
    },
    statSync: (p) => {
      if (!store.has(p)) throw mk('ENOENT', p);
      return { size: Buffer.byteLength(store.get(p), 'utf8'), mtimeMs: Date.now() };
    },
    unlinkSync: (p) => { store.delete(p); },
    // lastJsonlEvent lê o TAIL do .jsonl via fd (s8) — espelha o readSync real.
    _fds: new Map(),
    _nextFd: 1,
    openSync: (p) => { const fd = mfs._nextFd++; mfs._fds.set(fd, p); return fd; },
    closeSync: (fd) => { mfs._fds.delete(fd); },
    readSync: (fd, buf, offset, len, pos) => {
      const p = mfs._fds.get(fd);
      if (!store.has(p) || pos >= store.get(p).length) return 0;
      const bytes = Buffer.from(store.get(p), 'utf8');
      const end = Math.min(pos + len, bytes.length);
      bytes.copy(buf, offset, pos, end);
      return end - pos;
    },
    _read: (p) => JSON.parse(store.get(p)),
    _list: () => [...store.keys()],
    _failTmp: (on) => { failTmp = on; },
  };
  return mfs;
}

function loadAdapter(mfs, clock = { now: 0 }) {
  const sandbox = {
    fs: mfs,
    path,
    os: { homedir: () => HOME },
    // Relógio controlável: a síntese de Stop (scanForStops) compara Date.now()
    // contra o _lastSeen gravado pelo handleJsonl — avançar o clock simula o
    // silêncio do .jsonl sem precisar acessar o Map interno (é um const).
    Date: class extends Date {
      static now() { return clock.now; }
    },
    // O adapter usa o validate.js compartilhado (em vez de uma 4ª cópia da regex
    // de id), então o stub precisa entregar o módulo REAL — validar id é parte
    // do comportamento sob teste, não algo a mockar.
    require: (name) => ({
      fs: mfs, path, os: { homedir: () => HOME },
      '../../src/validate.js': require('../src/validate.js'),
      '../../src/state-writer.js': require('../src/state-writer.js'),
    }[name]),
    process: { env: { XDG_DATA_HOME: '/data' } },
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    // Buffer: o lastJsonlEvent agora lê só o tail do .jsonl (s8) — o Buffer
    // não vem no contexto do vm por padrão.
    Buffer,
    module: { exports: {} },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fsCode, sandbox, { filename: 'ai-traffic-lights.js' });
  return sandbox;
}

function watchStub() {
  const handlers = {};
  return {
    watch: () => {
      const api = {
        on: (evt, cb) => { handlers[evt] = cb; return api; },
        close: () => Promise.resolve(),
      };
      return api;
    },
    emit: (event, fp) => handlers.all && handlers.all(event, fp),
  };
}

function seedJsonl(mfs, sid, kind) {
  mfs.writeFileSync(`${KDIR}/${sid}.jsonl`, JSON.stringify({ kind, data: {} }) + '\n');
}
function seedLock(mfs, sid, pid) {
  mfs.writeFileSync(`${KDIR}/${sid}.lock`, JSON.stringify({ pid, started_at: 'x' }));
}
function seedJson(mfs, sid, meta) {
  mfs.writeFileSync(`${KDIR}/${sid}.json`, JSON.stringify(meta));
}

test('writeState preserva foco/transcript/terceiros e atualiza last_event', () => {
  const sandbox = loadAdapter(makeFs());
  const sid = 's1';
  sandbox.fs.writeFileSync(`${STATE}/${sid}.json`, JSON.stringify({
    schema_version: 2, agent: 'kiro', session_id: sid, pid: 4242,
    cwd: '/w', model: 'm', transcript_path: '/t.jsonl',
    term_program: 'TP', windowid: 'W', focus_url: 'F', tilix_id: 'T', zellij_session: 'Z',
    notification_type: 'NT', last_event: 'Stop', last_event_ts: 1,
    events: [{ ts: 1, event: 'Stop', tool: null }], third_party: 'keep',
  }));
  sandbox.writeState(sid, 'UserPromptSubmit', null);
  const st = sandbox.fs._read(`${STATE}/${sid}.json`);
  assert.equal(st.transcript_path, '/t.jsonl');
  assert.equal(st.windowid, 'W');
  assert.equal(st.focus_url, 'F');
  assert.equal(st.tilix_id, 'T');
  assert.equal(st.zellij_session, 'Z');
  assert.equal(st.term_program, 'TP');
  assert.equal(st.third_party, 'keep');
  // notification_type NÃO é preservado: o contrato (docs/ARCHITECTURE.md) manda
  // ser null a menos que last_event == 'Notification', e o hook o reescreve a
  // cada evento. Preservá-lo faria o computeState classificar a PRÓXIMA
  // notificação sem tipo pelo discriminador da anterior.
  assert.equal(st.notification_type, null, 'evento não-Notification limpa o tipo');
  assert.equal(st.pid, 4242);
  assert.equal(st.cwd, '/w');
  assert.equal(st.last_event, 'UserPromptSubmit');
  assert.equal(st.events.length, 2);
  assert.equal(st.schema_version, 2);
});

test('events mantém no máximo 50 (tail) sem zerar o transcript_path', () => {
  const sandbox = loadAdapter(makeFs());
  const sid = 's2';
  sandbox.fs.writeFileSync(`${STATE}/${sid}.json`, JSON.stringify({
    last_event: 'Stop', last_event_ts: 1, transcript_path: '/t.jsonl',
    events: Array.from({ length: 50 }, (_, i) => ({ ts: i, event: 'Stop' })),
  }));
  sandbox.writeState(sid, 'PostToolUse', null);
  const st = sandbox.fs._read(`${STATE}/${sid}.json`);
  assert.equal(st.events.length, 50);
  assert.equal(st.events.at(-1).event, 'PostToolUse');
  assert.equal(st.transcript_path, '/t.jsonl');
});

test('compactação do .jsonl (encolheu) volta a ser lida — não fica surda', () => {
  const sandbox = loadAdapter(makeFs());
  const mfs = sandbox.fs;
  const sid = 't3';
  seedLock(mfs, sid, 1);
  seedJsonl(mfs, sid, 'Prompt');
  sandbox.handleJsonl(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'UserPromptSubmit');

  mfs.writeFileSync(`${KDIR}/${sid}.jsonl`, JSON.stringify({ kind: 'AssistantMessage', data: { content: 'a longer assistant turn inside the session stream' } }) + '\n');
  sandbox.handleJsonl(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'PreToolUse');

  const shrunk = JSON.stringify({ kind: 'ToolResults', data: {} }) + '\n';
  assert.ok(shrunk.length < mfs.statSync(`${KDIR}/${sid}.jsonl`).size, 'cenário: /clear encolheu o arquivo');
  mfs.writeFileSync(`${KDIR}/${sid}.jsonl`, shrunk);
  sandbox.handleJsonl(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'PostToolUse', 're-leu após encolhimento');
});

test('jsonl sem .lock não grava state pid:null (zumbi) e add do lock cria a linha', () => {
  const sandbox = loadAdapter(makeFs());
  const mfs = sandbox.fs;
  const sid = 'z1';
  seedJsonl(mfs, sid, 'Prompt');
  sandbox.handleJsonl(sid);
  assert.equal(mfs._list().filter((p) => p === `${STATE}/${sid}.json`).length, 0, 'state não existe sem pid');

  seedLock(mfs, sid, 777);
  sandbox.handleLock(sid, true);
  const st0 = mfs._read(`${STATE}/${sid}.json`);
  assert.equal(st0.last_event, 'SessionStart');
  assert.equal(st0.pid, 777);

  mfs.writeFileSync(`${KDIR}/${sid}.jsonl`,
    mfs.readFileSync(`${KDIR}/${sid}.jsonl`) +
    JSON.stringify({ kind: 'ToolResults', data: {} }) + '\n');
  sandbox.handleJsonl(sid);
  const st = mfs._read(`${STATE}/${sid}.json`);
  assert.equal(st.pid, 777);
  assert.equal(st.agent, 'kiro');
  assert.equal(st.last_event, 'PostToolUse');
});

test('EACCES/ENOSPC no .tmp não derruba o handler (crash-safety)', () => {
  const sandbox = loadAdapter(makeFs());
  const mfs = sandbox.fs;
  const sid = 'c1';
  seedLock(mfs, sid, 5);
  seedJsonl(mfs, sid, 'Prompt');
  sandbox.handleLock(sid, true);
  const before = mfs._read(`${STATE}/${sid}.json`);

  mfs._failTmp(true);
  assert.doesNotThrow(() => sandbox.handleJsonl(sid));
  mfs._failTmp(false);

  const after = mfs._read(`${STATE}/${sid}.json`);
  assert.equal(after.last_event, before.last_event, 'estado intacto após escrita falhada');
  assert.equal(mfs._list().filter((p) => p.endsWith('.tmp')).length, 0, 'sem .tmp órfão');
});

test('.json consolidado preenche cwd e é preservado pelo writeState seguinte', () => {
  const sandbox = loadAdapter(makeFs());
  const mfs = sandbox.fs;
  const sid = 'e1';
  seedLock(mfs, sid, 9);
  seedJsonl(mfs, sid, 'AssistantMessage');
  sandbox.handleJsonl(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).cwd, null);

  seedJson(mfs, sid, { cwd: '/projects/ai', session_id: sid });
  sandbox.enrichFromSessionJson(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).cwd, '/projects/ai');

  sandbox.enrichFromSessionJson(sid);
  assert.equal(mfs._list().filter((p) => p.endsWith('.tmp')).length, 0, 'idempotente: sem mudança não re-escreve');

  sandbox.writeState(sid, 'UserPromptSubmit', null);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).cwd, '/projects/ai', 'writeState não regride cwd enriquecido');
});

test('síntese de Stop: jsonl parado há STOP_AFTER_MS → Stop, sem loop', () => {
  const clock = { now: 1000 };
  const sandbox = loadAdapter(makeFs(), clock);
  const mfs = sandbox.fs;
  const sid = 't1';
  seedLock(mfs, sid, 3);
  seedJsonl(mfs, sid, 'Prompt');
  sandbox.handleJsonl(sid);
  assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'UserPromptSubmit');

  clock.now += 121 * 1000;
  sandbox.scanForStops();
  assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'Stop', 'turno quieto sintetiza Stop');

  const eventsBefore = mfs._read(`${STATE}/${sid}.json`).events.length;
  sandbox.scanForStops();
  assert.equal(mfs._read(`${STATE}/${sid}.json`).events.length, eventsBefore, 're-âncora impede loop');
});

test('dispatcher do watcher: add/.json enriquece e unlink do .lock encerra a sessão', () => {
  const sandbox = loadAdapter(makeFs());
  const mfs = sandbox.fs;
  const sid = 'w1';
  const stub = watchStub();
  sandbox.start(stub, null);
  try {
    seedJsonl(mfs, sid, 'Prompt');
    stub.emit('add', `${KDIR}/${sid}.jsonl`);
    assert.ok(!mfs.existsSync(`${STATE}/${sid}.json`), 'sem lock, jsonl sozinho não cria zumbi');

    seedLock(mfs, sid, 4);
    stub.emit('add', `${KDIR}/${sid}.lock`);
    assert.equal(mfs._read(`${STATE}/${sid}.json`).pid, 4);

    mfs.writeFileSync(`${KDIR}/${sid}.jsonl`,
      mfs.readFileSync(`${KDIR}/${sid}.jsonl`) +
      JSON.stringify({ kind: 'AssistantMessage', data: { content: 'resposta em produção' } }) + '\n');
    stub.emit('change', `${KDIR}/${sid}.jsonl`);
    assert.equal(mfs._read(`${STATE}/${sid}.json`).last_event, 'PreToolUse');

    seedJson(mfs, sid, { cwd: '/w', session_id: sid });
    stub.emit('add', `${KDIR}/${sid}.json`);
    assert.equal(mfs._read(`${STATE}/${sid}.json`).cwd, '/w', 'dispatcher trata .json add/change');

    stub.emit('unlink', `${KDIR}/${sid}.lock`);
    assert.ok(!mfs.existsSync(`${STATE}/${sid}.json`), 'lock removido encerra a sessão');

    mfs._failTmp(true);
    assert.doesNotThrow(() => stub.emit('change', `${KDIR}/${sid}.jsonl`), 'handler não derruba com I/O falhando');
    mfs._failTmp(false);
    assert.ok(!mfs.existsSync(`${STATE}/${sid}.json`), 'zumbi não recriado após lock sumir');
  } finally {
    sandbox.stop();
  }
});