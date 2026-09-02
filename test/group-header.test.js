// Regressão #54 (agrupar por host): com sessões de >1 máquina, a lista ganha
// um li.group-header por bloco de origem e o badge de origem sai da linha; o
// toggle do header persiste em settings.groupByHost. Mesma técnica do
// rename.test.js: scripts REAIS do renderer num contexto vm com DOM mock.
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
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    offsetTop: 0, offsetHeight: 24, scrollHeight: 120,
  };
}

// Renderer isolado com o canal de sessões capturável, saveSettings gravando as
// chamadas e settings iniciais configuráveis (groupByHost on/off por teste).
async function setup(settings) {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'groupBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay']) els[id] = mkEl();
  const calls = { saveSettings: [] };
  let sessionsCb = null;
  const window = {
    addEventListener() {},
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; }, requestSessions() {},
      setExpanded() {}, autoHeight() {},
      onUsage() {}, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias() {}, setAccountLabel() {},
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve(settings || {}), onSettingsChanged() {},
      saveSettings: (cfg) => calls.saveSettings.push(cfg),
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {},
      openSettings() {},
      getLang: () => Promise.resolve('pt'),
      fetchTranscript: () => Promise.resolve(null),
      onPtyOut() {}, onPtyExit() {}, onTermTabAdded() {}, onTermTabRemoved() {},
      onTermTabActivated() {}, onTermMaximized() {}, onTermShown() {}, onTermRefit() {}, onTermTabTitle() {},
      openExternal() {}, revealOverlay() {},
    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  await Promise.resolve();                  // drena getSettings().then
  return { ctx, els, calls, pushSessions: (list) => sessionsCb(list) };
}

const now = Math.floor(Date.now() / 1000);
const mkSess = (id, origin, last_event = 'Stop') => ({
  session_id: id, pid: 1000 + id.length, cwd: `/home/dev/${id}`, agent: 'claude',
  last_event, last_event_ts: now, ...(origin && origin !== 'local' ? { origin } : {}),
});

test('#54 2 origens → headers "origem · N dot" por bloco e badge de origem some', async () => {
  const { els, pushSessions } = await setup();
  pushSessions([mkSess('l1'), mkSess('l2'), mkSess('r1', 'notebook-hg', 'PermissionRequest')]);
  const kids = els.list.children;
  // modo agrupado: origem é chave primária → bloco LOCAL primeiro (2 rows),
  // depois o peer — mesmo o peer sendo 🔴 (urgência ordena DENTRO do bloco).
  assert.equal(kids[0].className, 'group-header');
  assert.equal(kids[0].textContent, 'local · 2 🟢');
  assert.equal(kids[1].className, 'row', 'linha após o header local');
  assert.equal(kids[2].className, 'row', 'segunda linha local');
  assert.equal(kids[3].textContent, 'notebook-hg · 1 🔴', 'worst do bloco = awaiting');
  assert.equal(kids[4].className, 'row');
  // badge de origem saiu: main.children[0] é o label, não o badge
  const main = kids[4].children[3];
  assert.equal(main.children[0].className, 'row__label', 'sem badge — o header já diz a origem');
  // botão visível (há sessão remota)
  assert.equal(els.groupBtn.hidden, false);
});

test('#54 1 origem só → sem header (idêntico a hoje) e botão oculto', async () => {
  const { els, pushSessions } = await setup();
  pushSessions([mkSess('l1'), mkSess('l2')]);
  const kids = els.list.children;
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.className === 'row'), 'nenhum group-header');
  assert.equal(els.groupBtn.hidden, true, 'sem sessão remota o toggle não aparece');
});

test('#54 toggle desligado → sem headers e badge de origem volta na remota', async () => {
  const { els, pushSessions } = await setup({ groupByHost: false });
  pushSessions([mkSess('l1'), mkSess('r1', 'notebook-hg')]);
  const kids = els.list.children;
  assert.equal(kids.length, 2);
  assert.ok(kids.every((k) => k.className === 'row'), 'sem header com o toggle off');
  const main = kids[1].children[3];      // linha remota → main
  assert.equal(main.children[0].className, 'row__origin', 'badge presente (comportamento pré-#54)');
  assert.equal(main.children[0].textContent, 'notebook-hg');
});

test('#54 clique no toggle persiste groupByHost invertido via save-settings', async () => {
  const { els, calls, pushSessions } = await setup();             // default ON
  pushSessions([mkSess('l1'), mkSess('r1', 'notebook-hg')]);
  els.groupBtn.dispatch('click', {});
  assert.equal(calls.saveSettings.length, 1, 'gravou 1x');
  assert.equal(calls.saveSettings[0].groupByHost, false, 'ON por default → clique desliga');
  // e o re-render seguinte (sem header) já reflete o settings local mutado
  const kids = els.list.children;
  assert.ok(kids.every((k) => k.className === 'row'), 'lista volta ao formato plano');
});
