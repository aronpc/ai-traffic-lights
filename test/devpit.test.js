// lp#1261 · T2 — ícone do devpit e clique da linha abrem o terminal no devpit.
// Parte 1 (unidade, sem DOM): openDevpit (src/ipc/devpit.js, deps injetadas),
// cleanEnv (src/appimage-env.js) e rowAction (src/devpit.js).
// Parte 2 (regressão do renderer): os scripts REAIS em vm com mock DOM (mesma
// técnica de rename.test.js) — o clique da linha roteia por rowAction, o
// fallback ENOENT volta ao foco de antes e o dblclick (rename) segue
// cancelando o clique simples. Sem browser, sem Electron, sem deps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

// Formato DEVPIT_LEAF_RE (src/validate.js): `leaf_` + 26 chars de [0-9A-Z].
const LEAF = 'leaf_' + 'A'.repeat(26);
const BAD_LEAF = 'leaf_x';

// ================= #3948 openDevpit =================
const { openDevpit } = require('../src/ipc/devpit.js');

// execFile fake no formato de child_process: (cmd, args, opts, cb).
function mkExecFile(log, err) {
  return (cmd, args, opts, cb) => { log.push({ cmd, args, opts }); cb(err || null); };
}

test('#3948 leaf válido: execFile devpit-desktop --open-pane <leaf>, args em array (sem shell)', async () => {
  const calls = [];
  const env = { APPDIR: '/tmp/appdir', APPIMAGE: '/i.AppImage', OWD: '/old', PATH: '/tmp/appdir/usr/bin:/usr/bin' };
  const res = await openDevpit(LEAF, { execFile: mkExecFile(calls), env });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, 'execFile chamado 1x');
  assert.equal(calls[0].cmd, 'devpit-desktop', 'comando é o binário, sem shell');
  assert.ok(Array.isArray(calls[0].args), 'args é array — nunca string concatenada');
  assert.deepEqual(calls[0].args, ['--open-pane', LEAF]);
  assert.equal(calls[0].opts.env.PATH, '/usr/bin', 'env do filho já limpo (entrada do APPDIR fora do PATH)');
  assert.equal(calls[0].opts.env.APPDIR, undefined, 'APPDIR não atravessa');
});

test('#3948 leaf inválido: não executa nada', async () => {
  const calls = [];
  const res = await openDevpit(BAD_LEAF, { execFile: mkExecFile(calls), env: {} });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0, 'nada executado');
});

// ================= #3949 cleanEnv =================
const { cleanEnv } = require('../src/appimage-env.js');

test('#3949 cleanEnv: remove as 4 vars do AppImage, filtra $APPDIR dos paths, resto igual', () => {
  const env = {
    APPIMAGE: '/opt/ATL.AppImage',
    APPDIR: '/tmp/.mount_ATL123',
    ARGV0: 'ai-traffic-lights',
    OWD: '/old/cwd',
    PATH: '/tmp/.mount_ATL123/usr/bin:/usr/local/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/tmp/.mount_ATL123/usr/lib:/lib/x86_64-linux-gnu',
    XDG_DATA_DIRS: '/usr/share:/tmp/.mount_ATL123/usr/share',
    HOME: '/home/dev',
    TERM: 'xterm-256color',
    ELECTRON_RUN_AS_NODE: '1',
  };
  assert.deepEqual(cleanEnv(env), {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LD_LIBRARY_PATH: '/lib/x86_64-linux-gnu',
    XDG_DATA_DIRS: '/usr/share',
    HOME: '/home/dev',
    TERM: 'xterm-256color',
    ELECTRON_RUN_AS_NODE: '1',
  });
  // puro: o objeto de entrada sai intacto
  assert.equal(env.PATH, '/tmp/.mount_ATL123/usr/bin:/usr/local/bin:/usr/bin:/bin');
  assert.equal(env.APPDIR, '/tmp/.mount_ATL123');
});

test('#3949 sem APPDIR (dev via npm start): só as 4 vars saem, paths intactos', () => {
  const env = { PATH: '/usr/bin:/bin', HOME: '/home/dev', APPIMAGE: '/i.AppImage', OWD: '/o' };
  assert.deepEqual(cleanEnv(env), { PATH: '/usr/bin:/bin', HOME: '/home/dev' });
});

test('#3949 path que esvazia sai inteiro (não herda LD_LIBRARY_PATH="")', () => {
  const env = { APPDIR: '/a', LD_LIBRARY_PATH: '/a/usr/lib', PATH: '/a/usr/bin:/usr/bin' };
  const out = cleanEnv(env);
  assert.equal(out.LD_LIBRARY_PATH, undefined, 'filtro consumiu tudo → chave removida');
  assert.equal(out.PATH, '/usr/bin');
});

// ================= #3950 ENOENT =================
test('#3950 ENOENT (devpit ausente) não lança: resolve {ok:false, motivo:"ausente"}', async () => {
  const err = new Error('spawn devpit-desktop ENOENT');
  err.code = 'ENOENT';
  const res = await openDevpit(LEAF, { execFile: mkExecFile([], err), env: {} });
  assert.deepEqual(res, { ok: false, motivo: 'ausente' });
});

// ================= #3951 rowAction =================
const { rowAction } = require('../src/devpit.js');

test('#3951 rowAction: devpit (local com devpit_pane) · focus (local) · remote (nunca devpit)', () => {
  assert.equal(rowAction({ devpit_pane: LEAF }), 'devpit', 'local sem origin + pane');
  assert.equal(rowAction({ origin: 'local', devpit_pane: LEAF }), 'devpit');
  assert.equal(rowAction({}), 'focus', 'local sem pane');
  assert.equal(rowAction({ devpit_pane: null }), 'focus', 'pane null = sem devpit');
  assert.equal(rowAction({ origin: 'peer', devpit_pane: LEAF }), 'remote', 'remota NUNCA devpit');
  assert.equal(rowAction(null), 'remote');
});

// ============ renderer (vm): clique, fallback, dblclick, botão hover ============
// Mesma ordem do index.html (+ devpit.js antes do renderer).
const CODE = ['agents.js', 'identity.js', 'state-machine.js', 'i18n.js', 'devpit.js', 'renderer.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

function mkEl() {
  return {
    _l: {}, _attr: {}, _q: {}, children: [], className: '', textContent: '', innerHTML: '', hidden: false, value: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    dispatch(t, ev) { (this._l[t] || []).forEach((f) => f(ev || {})); },
    append(...e) { this.children.push(...e); },
    appendChild(e) { this.children.push(e); return e; },
    replaceChildren(...e) { this.children = e; },
    querySelector(s) { return this._q[s] || (this._q[s] = mkEl()); },
    querySelectorAll() { return []; },
    remove() { this.removed = true; },
    setAttribute(k, v) { this._attr[k] = String(v); },
    removeAttribute(k) { delete this._attr[k]; },
    getAttribute(k) { return this._attr[k] != null ? this._attr[k] : null; },
    hasAttribute(k) { return this._attr[k] != null; },
    focus() {}, select() {},
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    offsetTop: 0, offsetHeight: 24, scrollHeight: 120,
  };
}

// Renderer isolado com o IPC do devpit capturável. setTimeout/clearTimeout de
// VERDADE (Map com marca de morto): provar que o dblclick cancela o clique
// exige um clearTimeout que funcione — stub no-op esconde exatamente isso.
async function setup({ devpitResult } = {}) {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay', 'ctxMenu']) els[id] = mkEl();
  const calls = { openDevpit: [], focus: [] };
  let sessionsCb = null;
  const timers = new Map();
  const window = {
    addEventListener() {}, removeEventListener() {},
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; },
      onReadMarks() {}, requestSessions() {}, setExpanded() {}, autoHeight() {},
      onUsage() {}, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus: (p) => calls.focus.push(p),
      getAliases: () => Promise.resolve({}), setAlias() {},
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve({ revealOnRed: false, soundEnabled: false }), onSettingsChanged() {},
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {},
      saveSettings() {}, openSettings() {},
      getLang: () => Promise.resolve('pt'),
      fetchTranscript: () => Promise.resolve(null),
      openDevpit: (leaf) => { calls.openDevpit.push(leaf); return Promise.resolve(devpitResult || { ok: true }); },
    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = {
    document, window, setInterval: () => 0,
    setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms, dead: false }); return id; },
    clearTimeout: (id) => { const t = timers.get(id); if (t) t.dead = true; },
    Date, Math, console,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  await Promise.resolve();
  const now = Math.floor(Date.now() / 1000);
  const noev = { preventDefault() {}, stopPropagation() {} };
  const push = (list) => sessionsCb(list);
  const rows = () => els.list.children.filter((li) => li.className === 'row');
  const flush = () => { for (const t of timers.values()) if (!t.dead) { t.dead = true; t.fn(); } };
  return { ctx, els, calls, noev, push, rows, flush, now };
}

const devSess = (now, extra) => ({
  session_id: 'd1', pid: 42, cwd: '/home/dev/proj', agent: 'claude',
  last_event: 'Stop', last_event_ts: now, devpit_pane: LEAF, ...extra,
});

// Drena o await do openInDevpit (async na VM): a retomada só chega num tick de
// MACROTASK do host — microtasks do teste não alcançam a continuação da VM.
const drain = () => new Promise((r) => setImmediate(r));

test('#3951 clique na linha devpit chama openDevpit(leaf) — e NÃO foca', async () => {
  const { rows, calls, noev, push, flush, now } = await setup();
  push([devSess(now)]);
  rows()[0].dispatch('click', noev);
  flush();                                   // debounce de 220ms
  await drain();
  assert.deepEqual(calls.openDevpit, [LEAF], 'abriu o pane no devpit');
  assert.equal(calls.focus.length, 0, 'devpit ok → sem foco');
});

test('#3950 devpit ausente ({ok:false,motivo:"ausente"}) → clique cai no foco de antes', async () => {
  const { rows, calls, noev, push, flush, now } = await setup({ devpitResult: { ok: false, motivo: 'ausente' } });
  push([devSess(now)]);
  rows()[0].dispatch('click', noev);
  flush();
  await drain();                             // drena o fallback síncrono pós-await
  assert.deepEqual(calls.openDevpit, [LEAF], 'tentou o devpit primeiro');
  assert.equal(calls.focus.length, 1, 'fallback: focou a sessão como antes');
  assert.equal(calls.focus[0].pid, 42);
});

test('#3951 dblclick (rename) continua cancelando o clique simples', async () => {
  const { rows, calls, noev, push, flush, now } = await setup();
  push([devSess(now)]);
  const li = rows()[0];
  li.dispatch('click', noev);                              // 1º clique agenda o debounce
  li.children[4].children[0].dispatch('dblclick', noev);   // dblclick no label cancela
  flush();
  assert.equal(calls.openDevpit.length, 0, 'clique cancelado — nada abriu');
  assert.equal(calls.focus.length, 0);
});

test('#3951 ação de hover: botão devpit (SVG) só em local com devpit_pane, ao lado da ⧉', async () => {
  const { rows, push, now, ctx } = await setup();
  // sortByUrgency reordena as rows — cada uma leva um cwd (→ label) distinto
  // para ancorar a row PELO LABEL, não pela posição do push.
  push([
    devSess(now, { cwd: '/p/dev' }),
    devSess(now, { session_id: 'r1', pid: 43, origin: 'peer', cwd: '/p/rem' }),   // remota
    devSess(now, { session_id: 'l1', pid: 44, devpit_pane: null, cwd: '/p/loc' }), // local sem devpit
    devSess(now, { session_id: 't1', pid: 45, tmux_session: 'work', cwd: '/p/tmx' }), // local com tmux E devpit
  ]);
  const rowByLabel = (label) => rows().find((li) => li.children[4].children[0].textContent === label);
  const actBtns = (li) => li.children[5].children;   // coluna .row__actions
  const dev = actBtns(rowByLabel('dev'));
  assert.equal(dev.length, 1, 'local com pane: 1 botão (devpit)');
  assert.ok(String(dev[0].innerHTML).includes('<svg'), 'SVG inline');
  assert.equal(dev[0].getAttribute('data-tip'), ctx.makeT('pt')('row_open_devpit'));
  assert.equal(actBtns(rowByLabel('rem')).length, 0, 'remota: nenhum botão');
  assert.equal(actBtns(rowByLabel('loc')).length, 0, 'local sem pane: nenhum botão');
  const tmx = actBtns(rowByLabel('tmx'));
  assert.equal(tmx.length, 2, 'tmux + devpit: ⧉ e devpit lado a lado');
  assert.equal(tmx[0].getAttribute('data-tip'), ctx.makeT('pt')('row_open_embedded'), '⧉ continua primeiro');
  assert.equal(tmx[1].getAttribute('data-tip'), ctx.makeT('pt')('row_open_devpit'), 'devpit entra ao lado');
});

test('#3951 clique no BOTÃO devpit abre sem esperar o debounce da linha', async () => {
  const { rows, calls, noev, push, now } = await setup();
  push([devSess(now)]);
  rows()[0].children[5].children[0].dispatch('click', noev);
  assert.deepEqual(calls.openDevpit, [LEAF], 'imediato — sem flush de timer');
});
