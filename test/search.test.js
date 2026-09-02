// Regressão #55 (busca fuzzy): digitar no input do header filtra a lista sem
// reordenar (urgência preservada), o contador vira visíveis/total, zero match
// mostra o empty de busca, os grupos do #54 somem quando o host inteiro cai
// fora do filtro, `/` abre e Esc limpa. Mesma técnica do group-header.test.js:
// scripts REAIS do renderer num contexto vm com DOM mock.
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

async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'groupBtn',
    'searchInput', 'searchBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay']) els[id] = mkEl();
  // Estado inicial igual ao HTML real: busca fechada (hidden) e focável.
  els.searchInput.hidden = true;
  els.searchInput.focused = false;
  els.searchInput.focus = function () { this.focused = true; };
  const winListeners = {};
  let sessionsCb = null;
  const window = {
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
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
    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  await Promise.resolve();                  // drena getSettings().then
  const keydown = (ev) => (winListeners.keydown || []).forEach((f) => f(ev));
  return { els, keydown, pushSessions: (list) => sessionsCb(list) };
}

const now = Math.floor(Date.now() / 1000);
const mkSess = (id, origin, extra = {}) => ({
  session_id: id, pid: 1000 + id.length, cwd: `/home/dev/${id}`, agent: 'claude',
  last_event: 'Stop', last_event_ts: now, ...(origin && origin !== 'local' ? { origin } : {}), ...extra,
});
const rows = (els) => els.list.children.filter((k) => k.className === 'row');

test('#55 digitar filtra a lista e o contador vise "visíveis/total"', async () => {
  const { els, pushSessions } = await setup();
  pushSessions([mkSess('api'), mkSess('webapp'), mkSess('api-remota', 'notebook-hg')]);
  els.searchInput.hidden = false;             // abre a busca
  els.searchInput.value = 'web';
  els.searchInput.dispatch('input', {});
  const r = rows(els);
  assert.equal(r.length, 1, 'só a sessão webapp casa');
  assert.equal(els.counts.textContent, '1/3', 'contador mostra visíveis/total');
  // urgência preservada: sem reordenação, só ocultação
  assert.equal(els.list.children.some((k) => k.className === 'group-header'), false,
    '1 origem visível → sem header (host remoto caiu todo fora do filtro)');
});

test('#55 filtro casa nos dois hosts → headers continuam com contagem filtrada', async () => {
  const { els, pushSessions } = await setup();
  pushSessions([
    mkSess('api'), mkSess('webapp'),
    mkSess('api-peer', 'notebook-hg'), mkSess('web-peer', 'notebook-hg'),
  ]);
  els.searchInput.hidden = false;
  els.searchInput.value = 'api';
  els.searchInput.dispatch('input', {});
  const hdrs = els.list.children.filter((k) => k.className === 'group-header');
  assert.equal(hdrs.length, 2, 'os dois hosts têm match → 2 blocos');
  assert.equal(hdrs[0].textContent, 'local · 1 🟢', 'contagem do header reflete o FILTRO');
  assert.equal(hdrs[1].textContent, 'notebook-hg · 1 🟢');
  assert.equal(rows(els).length, 2, '1 match por host');
});

test('#55 zero match → empty de busca, lista oculta; sem buscar volta o total', async () => {
  const { els, pushSessions } = await setup();
  pushSessions([mkSess('api'), mkSess('webapp')]);
  els.searchInput.hidden = false;
  els.searchInput.value = 'zzz';
  els.searchInput.dispatch('input', {});
  assert.equal(els.list.children.length, 0, 'lista vazia');
  assert.equal(els.list.hidden, true, 'lista oculta (flex-grow não disputa o empty)');
  assert.equal(els.empty.hidden, false, 'empty visível');
  assert.equal(els.empty.textContent, 'Nenhuma sessão corresponde à busca.');
  // limpar restaura
  els.searchInput.value = '';
  els.searchInput.dispatch('input', {});
  assert.equal(rows(els).length, 2, 'sem query → todas as sessões voltam');
  assert.equal(els.counts.textContent, '🟢2', 'contador volta ao formato normal');
});

test('#55 "/" abre a busca focada; Esc limpa, fecha e restaura a lista', async () => {
  const { els, keydown, pushSessions } = await setup();
  pushSessions([mkSess('api'), mkSess('webapp')]);
  keydown({ key: '/', preventDefault() {}, target: {} });
  assert.equal(els.searchInput.hidden, false, 'input aberto');
  assert.equal(els.searchInput.focused, true, 'e focado');
  // digita e dá Esc
  els.searchInput.value = 'web';
  els.searchInput.dispatch('input', {});
  assert.equal(rows(els).length, 1);
  els.searchInput.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(els.searchInput.hidden, true, 'Esc fecha');
  assert.equal(els.searchInput.value, '', 'Esc limpa o valor');
  assert.equal(rows(els).length, 2, 'lista restaurada');
});

test('#55 Ctrl+F também abre; "/" digitado DENTRO de um input não reabre a busca', async () => {
  const { els, keydown, pushSessions } = await setup();
  pushSessions([mkSess('api')]);
  keydown({ key: 'f', ctrlKey: true, preventDefault() {}, target: {} });
  assert.equal(els.searchInput.hidden, false, 'Ctrl+F abre');
  // fecha e tenta "/" com target = input (ex.: rename): handler ignora
  els.searchInput.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  keydown({ key: '/', preventDefault() {}, target: { tagName: 'INPUT' } });
  assert.equal(els.searchInput.hidden, true, 'target input → "/" é texto, não atalho');
});
