// Regressão da issue #2: o rename in-place deve sobreviver a re-renders.
// Carrega os scripts REAIS do renderer (agents + state-machine + i18n +
// renderer, na mesma ordem do index.html) num contexto vm com um DOM mock e
// exercita os handlers reais de dblclick/keydown/blur. Sem browser, sem deps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const CODE = ['agents.js', 'identity.js', 'state-machine.js', 'i18n.js', 'renderer.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

function mkEl() {
  return {
    _l: {}, _attr: {}, children: [], className: '', textContent: '', innerHTML: '', hidden: false, value: '',
    style: { setProperty() {}, removeProperty() {} },
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    dispatch(t, ev) { (this._l[t] || []).forEach((f) => f(ev || {})); },
    append(...e) { this.children.push(...e); },
    replaceChildren(...e) { this.children = e; },
    setAttribute(k, v) { this._attr[k] = String(v); },
    removeAttribute(k) { delete this._attr[k]; },
    getAttribute(k) { return this._attr[k] != null ? this._attr[k] : null; },
    hasAttribute(k) { return this._attr[k] != null; },
    focus() {}, select() {},
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    offsetTop: 0, offsetHeight: 24, scrollHeight: 120,
  };
}

// Monta um renderer isolado com uma sessão renomeável já na lista.
async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'toggleListBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay']) els[id] = mkEl();
  const calls = { setAlias: [] };
  let sessionsCb = null;
  const window = {
    addEventListener() {},
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; },
      requestSessions() {}, setExpanded() {}, autoHeight() {},
      onUsage() {}, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias: (cwd, v) => calls.setAlias.push([cwd, v]),
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve(null), onSettingsChanged() {}, // settings (não usados no teste)
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {}, // auto-updater
      saveSettings() {}, openSettings() {},
      getLang: () => Promise.resolve('pt'),                             // i18n

    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);

  await Promise.resolve();                 // drena getAliases().then
  const now = Math.floor(Date.now() / 1000);
  sessionsCb([{ session_id: 's1', pid: 111, cwd: '/home/dev/projeto-x', agent: 'claude', last_event: 'Stop', last_event_ts: now }]);

  const noev = { preventDefault() {}, stopPropagation() {} };
  const labelEl = () => els.list.children[0].children[3].children[0]; // li → main(4º: led,reason,llm,main) → labelEl
  const openRename = () => { labelEl().dispatch('dblclick', noev); return labelEl().children[0]; };
  const key = (input, k) => input.dispatch('keydown', { key: k, ...noev });
  return { ctx, els, calls, noev, openRename, key, sessionsCb: (list) => sessionsCb(list) };
}

test('#2 guard: render() durante a edição não destrói o input', async () => {
  const { ctx, els, openRename } = await setup();
  const li0 = els.list.children[0];
  const input = openRename();
  assert.equal(els.list.children[0].children[3].children[0].children[0], input, 'input aberto');
  ctx.render();                            // tick do setInterval(2s) / evento de sessão
  ctx.render();
  assert.equal(els.list.children[0], li0, 'lista intocada (render foi no-op)');
});

test('#2 Enter commita exatamente uma vez (blur pós-remoção não re-salva)', async () => {
  const { els, calls, openRename, key, noev } = await setup();
  const input = openRename();
  input.value = 'Meu Alias';
  key(input, 'Enter');
  input.dispatch('blur', noev);            // navegador dispara blur ao remover do DOM
  assert.equal(calls.setAlias.length, 1, 'salvou só 1x');
  assert.equal(calls.setAlias[0][1], 'Meu Alias', 'salvou o valor digitado');
  assert.notEqual(els.list.children[0].children[3].children[0].children[0], input, 'lista re-renderizou');
});

test('#2 Escape cancela sem salvar (nem no blur seguinte)', async () => {
  const { openRename, key, calls, noev } = await setup();
  const input = openRename();
  input.value = 'NAO DEVE SALVAR';
  key(input, 'Escape');
  input.dispatch('blur', noev);
  assert.equal(calls.setAlias.length, 0, 'Escape não salva');
});

test('#2 blur sozinho (clicar fora) commita', async () => {
  const { openRename, calls, noev } = await setup();
  const input = openRename();
  input.value = 'Via Blur';
  input.dispatch('blur', noev);
  // Chave = session_id da linha ('s1'), NÃO o cwd (era o bug: apelido por diretório).
  assert.deepEqual(calls.setAlias, [['s1', 'Via Blur']]);
});

test('rename por sessão: mesmo cwd → apelido não vaza p/ os irmãos', async () => {
  const { els, calls, noev, sessionsCb } = await setup();
  const now = Math.floor(Date.now() / 1000);
  // Dois terminais no MESMO diretório, sessões distintas — o caso do bug.
  sessionsCb([
    { session_id: 'sA', pid: 11, cwd: '/home/dev/dir', agent: 'claude', last_event: 'Stop', last_event_ts: now },
    { session_id: 'sB', pid: 22, cwd: '/home/dev/dir', agent: 'claude', last_event: 'Stop', last_event_ts: now },
  ]);
  const label0 = els.list.children[0].children[3].children[0];
  label0.dispatch('dblclick', noev);
  const input = label0.children[0];
  input.value = 'Alpha';
  input.dispatch('blur', noev);
  assert.equal(calls.setAlias.length, 1, 'salvou só a linha renomeada');
  const savedKey = calls.setAlias[0][0];
  assert.ok(savedKey === 'sA' || savedKey === 'sB', `chave é a sessão, não o cwd (foi ${savedKey})`);
  assert.notEqual(savedKey, '/home/dev/dir', 'nunca indexa pelo diretório');
});

test('#2 guard reseta: novo rename abre após um anterior', async () => {
  const { openRename, key, noev } = await setup();
  const first = openRename();
  first.value = 'x';
  first.dispatch('blur', noev);            // fecha o 1º
  const second = openRename();             // 2º deve abrir (renaming não travou)
  assert.ok(second && second !== first, 'novo input abre normalmente');
  key(second, 'Escape');
});
