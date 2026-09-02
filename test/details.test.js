// Modal de detalhes da sessão (ctx "Detalhes da sessão"): abre a partir do
// menu de contexto, mostra os dados crus do state file (local E remota — a
// remota sem os campos LOCAL_ONLY), timeline events[] em ordem recente
// primeiro, botão copiar por campo, Esc fecha. Mesma técnica do
// context-menu.test.js: scripts REAIS do renderer num vm com DOM mock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const CODE = ['agents.js', 'identity.js', 'state-machine.js', 'fuzzy.js', 'i18n.js', 'renderer.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

function mkEl() {
  return {
    _l: {}, _attr: {}, _q: {}, children: [], className: '', textContent: '', innerHTML: '', hidden: false, value: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    dispatch(t, ev) { (this._l[t] || []).forEach((f) => f(ev || {})); },
    append(...e) { this.children.push(...e); },
    appendChild(e) { e.removed = false; this.children.push(e); return e; },
    replaceChildren(...e) { this.children = e; },
    querySelector(s) { return this._q[s] || (this._q[s] = mkEl()); },
    querySelectorAll() { return []; },
    remove() { this.removed = true; },
    setAttribute(k, v) { this._attr[k] = String(v); },
    removeAttribute(k) { delete this._attr[k]; },
    getAttribute(k) { return this._attr[k] != null ? this._attr[k] : null; },
    hasAttribute(k) { return this._attr[k] != null; },
    focus() {}, select() {},
    contains(node) { return node === this || this.children.includes(node); },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    offsetWidth: 170, offsetHeight: 90, offsetTop: 0, scrollHeight: 120,
  };
}

async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'groupBtn',
    'searchInput', 'searchBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn',
    'overlay', 'ctxMenu', 'tooltip']) els[id] = mkEl();
  els.bar = mkEl();
  els.searchInput.closest = () => els.bar;
  const winListeners = {};
  const addEventListener = (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); };
  const removeEventListener = (t, f) => {
    const arr = winListeners[t];
    const i = arr ? arr.indexOf(f) : -1;
    if (i >= 0) arr.splice(i, 1);
  };
  const calls = { copy: [] };
  let sessionsCb = null;
  const window = {
    addEventListener, removeEventListener,
    innerWidth: 400, innerHeight: 600,
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; }, requestSessions() {},
      setExpanded() {}, autoHeight() {},
      onUsage() {}, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias() {}, setAccountLabel() {},
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve({}), onSettingsChanged() {},
      saveSettings() {},
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {},
      openSettings() {},
      getLang: () => Promise.resolve('pt'),
      fetchTranscript: () => Promise.resolve(null),
      onPtyOut() {}, onPtyExit() {}, onTermTabAdded() {}, onTermTabRemoved() {},
      onTermTabActivated() {}, onTermMaximized() {}, onTermShown() {}, onTermRefit() {}, onTermTabTitle() {},
      openExternal() {}, revealOverlay() {},
      copyText: (t) => calls.copy.push(t),
      markRead() {},
    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  await Promise.resolve();                  // drena getSettings().then
  const fire = (t, ev) => (winListeners[t] || []).forEach((f) => f(ev || {}));
  const rows = () => els.list.children.filter((k) => k.className === 'row');
  const panel = () => els.overlay.children.find((c) => c.className === 'dt-panel' && !c.removed) || null;
  const body = () => (panel() ? panel()._q['.dt-body'] : null);
  const kv = () => {                        // Map label → value das .dt-row
    const m = new Map();
    for (const r of (body() ? body().children : [])) {
      if (r.className === 'dt-row') m.set(r.children[0].textContent, r.children[1].textContent);
    }
    return m;
  };
  const timeline = () => (body() ? body().children.filter((c) => c.className === 'dt-ev') : []);
  // abre via menu de contexto da 1ª linha
  const openViaMenu = (i = 0) => {
    rows()[i].dispatch('contextmenu', { clientX: 50, clientY: 50, preventDefault() {} });
    els.ctxMenu.children.filter((k) => k.textContent === 'Detalhes da sessão')
      .forEach((k) => k.dispatch('click', { stopPropagation() {} }));
  };
  return { els, calls, fire, rows, panel, body, kv, timeline, openViaMenu, pushSessions: (list) => sessionsCb(list) };
}

const now = Math.floor(Date.now() / 1000);
const mkSess = (id, origin, extra = {}) => ({
  session_id: id, pid: 1000 + id.length, cwd: `/home/dev/${id}`, agent: 'claude',
  last_event: 'Stop', last_event_ts: now, ...(origin && origin !== 'local' ? { origin } : {}), ...extra,
});

test('menu → "Detalhes da sessão" abre o painel com título da sessão', async () => {
  const { pushSessions, panel, openViaMenu } = await setup();
  pushSessions([mkSess('api', null, { model: 'glm-5.2' })]);
  openViaMenu(0);
  assert.ok(panel(), 'painel anexado ao overlay');
  assert.equal(panel()._q['.dt-title'].textContent, 'api', 'título = label da linha');
});

test('sessão local: campos de identidade + contexto + botão copiar session_id', async () => {
  const { pushSessions, panel, kv, openViaMenu, calls } = await setup();
  pushSessions([mkSess('api', null, {
    model: 'glm-5.2', term_program: 'tilix', tmux_session: 'atl-api', windowid: '1234567',
  })]);
  openViaMenu(0);
  const m = kv();
  assert.equal(m.get('Session ID'), 'api');
  assert.equal(m.get('Modelo'), 'glm-5.2');
  assert.equal(m.get('Pasta'), '/home/dev/api');
  assert.equal(m.get('Terminal'), 'tilix');
  assert.equal(m.get('sessão tmux'), 'atl-api');
  assert.equal(m.get('Origem'), 'local');
  assert.equal(m.get('Janela (X11)'), '1234567', 'windowid é LOCAL_ONLY — na local aparece');
  // botões copiar: session_id e cwd
  const copyBtns = panel()._q['.dt-body'].children
    .filter((c) => c.className === 'dt-row' && c.children.length > 2);
  assert.equal(copyBtns.length, 2, 'session_id e cwd têm botão copiar');
  copyBtns[0].children[2].dispatch('click', { stopPropagation() {} });
  assert.deepEqual(calls.copy, ['api'], 'copiou o session_id');
});

test('sessão remota: Origem = peer, SEM campos LOCAL_ONLY (windowid)', async () => {
  const { pushSessions, kv, openViaMenu } = await setup();
  // shape pós-exportSession: o export stripa os LOCAL_ONLY (net.js:120) — a
  // sessão remota chega SEM windowid; o modal não deve inventar a linha
  pushSessions([mkSess('rmt', 'alienware', { term_program: 'tilix' })]);
  openViaMenu(0);
  const m = kv();
  assert.equal(m.get('Origem'), 'alienware');
  assert.equal(m.has('Janela (X11)'), false, 'remota não tem windowid');
});

test('timeline: events[] em ordem recente primeiro, com tool quando houver', async () => {
  const { pushSessions, timeline, openViaMenu } = await setup();
  pushSessions([mkSess('api', null, {
    events: [
      { ts: now - 60, event: 'SessionStart', tool: null },
      { ts: now - 30, event: 'PermissionRequest', tool: 'Bash' },
      { ts: now - 5, event: 'Stop', tool: null },
    ],
  })]);
  openViaMenu(0);
  const evs = timeline();
  assert.equal(evs.length, 3, '3 eventos → 3 linhas');
  assert.equal(evs[0].children[1].textContent, 'Stop', 'mais recente primeiro');
  assert.equal(evs[1].children[1].textContent, 'PermissionRequest · Bash', 'evento + tool');
  assert.equal(evs[2].children[1].textContent, 'SessionStart');
  assert.ok(evs[0].children[0].textContent.match(/^\d{2}:\d{2}/), 'hora local no time');
});

test('Esc fecha o painel; reabrir reconstrói o corpo', async () => {
  const { pushSessions, panel, fire, openViaMenu } = await setup();
  pushSessions([mkSess('api')]);
  openViaMenu(0);
  assert.ok(panel());
  fire('keydown', { key: 'Escape' });
  assert.equal(panel(), null, 'painel removido');
  openViaMenu(0);
  assert.ok(panel(), 'reabrir reconstrói');
});
