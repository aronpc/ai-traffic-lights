// Menu de contexto da linha (botão direito): abre com os itens de copiar
// (chave/cwd/attach), Renomear e Marcar como lida conforme o tipo da sessão;
// item clica → copia via IPC e fecha; Esc e mousedown fora fecham. Mesma
// técnica do search.test.js: scripts REAIS do renderer num vm com DOM mock.
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
    // DOM: contains(node) — o "mousedown fora fecha o menu" depende dele
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
  const calls = { copy: [], markRead: [] };
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
      copyText: (t) => calls.copy.push(t),                       // menu de contexto
      markRead: (key, at, origin) => calls.markRead.push({ key, at, origin }),
    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  await Promise.resolve();                  // drena getSettings().then
  const fire = (t, ev) => (winListeners[t] || []).forEach((f) => f(ev || {}));
  const rows = () => els.list.children.filter((k) => k.className === 'row');
  // botão direito na i-ésima linha
  const rightClick = (i, x = 100, y = 200) => {
    const li = rows()[i];
    li.dispatch('contextmenu', { clientX: x, clientY: y, preventDefault() {} });
  };
  const items = () => els.ctxMenu.children.filter((k) => k.className === 'ctx__item');
  const itemByText = (txt) => items().find((k) => k.textContent === txt);
  return { els, calls, fire, rows, rightClick, items, itemByText, pushSessions: (list) => sessionsCb(list) };
}

const now = Math.floor(Date.now() / 1000);
const mkSess = (id, origin, extra = {}) => ({
  session_id: id, pid: 1000 + id.length, cwd: `/home/dev/${id}`, agent: 'claude',
  last_event: 'Stop', last_event_ts: now, ...(origin && origin !== 'local' ? { origin } : {}), ...extra,
});

test('botão direito na linha local com tmux → itens pt e divisor', async () => {
  const { pushSessions, rightClick, items, itemByText, els } = await setup();
  pushSessions([mkSess('api', null, { tmux_session: 'atl-api' })]);
  rightClick(0);
  assert.equal(els.ctxMenu.hidden, false, 'menu visível');
  assert.ok(itemByText('Copiar chave da sessão'), 'item copiar chave');
  assert.ok(itemByText('Copiar pasta (cwd)'), 'item copiar cwd');
  assert.ok(itemByText('Copiar comando de attach'), 'item attach (local com tmux)');
  assert.ok(itemByText('Renomear…'), 'item renomear (sessão local)');
  assert.ok(!itemByText('Marcar como lida'), 'sessão sem awaiting → sem marcar como lida');
  assert.ok(els.ctxMenu.children.some((k) => k.className === 'ctx__sep'), 'divisor antes do Renomear');
  assert.ok(items().length >= 4, 'ao menos 4 itens');
});

test('clicar em Copiar chave → copyText com a key e o menu fecha', async () => {
  const { pushSessions, rightClick, itemByText, els, calls } = await setup();
  pushSessions([mkSess('api')]);
  rightClick(0);
  itemByText('Copiar chave da sessão').dispatch('click', { stopPropagation() {} });
  // sessionKey prefere pid (identity.js:25): 'api' → pid 1003
  assert.deepEqual(calls.copy, ['local:1003'], 'copiou a chave da sessão');
  assert.equal(els.ctxMenu.hidden, true, 'menu fechou após o clique');
  assert.equal(els.ctxMenu.textContent, '', 'closures da sessão soltas');
});

test('sessão remota: sem Renomear e sem attach (mesmo com tmux)', async () => {
  const { pushSessions, rightClick, itemByText } = await setup();
  pushSessions([mkSess('rmt', 'alienware', { tmux_session: 'atl-rmt' })]);
  rightClick(0);
  assert.ok(itemByText('Copiar chave da sessão'), 'copiar chave existe');
  assert.ok(!itemByText('Copiar comando de attach'), 'attach é local-only');
  assert.ok(!itemByText('Renomear…'), 'rename é local-only');
});

test('Esc fecha; mousedown fora fecha; mousedown no item não fecha antes do clique', async () => {
  const { pushSessions, rightClick, fire, els } = await setup();
  pushSessions([mkSess('api')]);
  rightClick(0);
  assert.equal(els.ctxMenu.hidden, false);
  fire('keydown', { key: 'Escape' });
  assert.equal(els.ctxMenu.hidden, true, 'Esc fecha o menu');
  // reabre e testa mousedown fora
  rightClick(0);
  fire('mousedown', { target: {} });        // alvo fora do menu (mock não é child)
  assert.equal(els.ctxMenu.hidden, true, 'mousedown fora fecha');
  // reabre: mousedown DENTRO do menu não fecha
  rightClick(0);
  fire('mousedown', { target: els.ctxMenu });
  assert.equal(els.ctxMenu.hidden, false, 'mousedown dentro mantém o menu aberto');
});

test('awaiting → Marcar como lida presente; clica → markRead IPC + vira cinza', async () => {
  const { pushSessions, rightClick, itemByText, calls, rows } = await setup();
  pushSessions([mkSess('perm', null, { last_event: 'PermissionRequest', last_event_ts: now })]);
  rightClick(0);
  const it = itemByText('Marcar como lida');
  assert.ok(it, 'sessão awaiting tem o item');
  it.dispatch('click', { stopPropagation() {} });
  assert.equal(calls.markRead.length, 1, 'markRead foi pro main');
  assert.equal(calls.markRead[0].key, 'local:1004', 'sessionKey prefere pid (identity.js:25)');
  assert.ok(calls.markRead[0].at > 0, 'readAt epoch');
  // re-render pós-marca: nível da linha rebaixado (read)
  const li = rows()[0];
  assert.match(li.children[0].className, /led--read/, 'led da linha ficou read (cinza)');
});
