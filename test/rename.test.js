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
const CODE = ['agents.js', 'state-machine.js', 'i18n.js', 'renderer.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

function mkEl() {
  return {
    _l: {}, children: [], className: '', textContent: '', hidden: false, value: '',
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    dispatch(t, ev) { (this._l[t] || []).forEach((f) => f(ev || {})); },
    append(...e) { this.children.push(...e); },
    replaceChildren(...e) { this.children = e; },
    focus() {}, select() {},
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    offsetTop: 0, offsetHeight: 24, scrollHeight: 120,
  };
}

// Monta um renderer isolado com uma sessão renomeável já na lista.
async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn']) els[id] = mkEl();
  const calls = { setAlias: [] };
  let sessionsCb = null;
  const window = {
    addEventListener() {},
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; },
      requestSessions() {}, setExpanded() {}, autoHeight() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias: (cwd, v) => calls.setAlias.push([cwd, v]),
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getSettings: () => Promise.resolve(null), onSettingsChanged() {}, // settings (não usados no teste)
      saveSettings() {}, openSettings() {},
      getLang: () => Promise.resolve('pt'),                             // i18n

    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '' };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);

  await Promise.resolve();                 // drena getAliases().then
  const now = Math.floor(Date.now() / 1000);
  sessionsCb([{ session_id: 's1', pid: 111, cwd: '/home/dev/projeto-x', agent: 'claude', last_event: 'Stop', last_event_ts: now }]);

  const noev = { preventDefault() {}, stopPropagation() {} };
  const labelEl = () => els.list.children[0].children[1].children[0]; // li → main → labelEl
  const openRename = () => { labelEl().dispatch('dblclick', noev); return labelEl().children[0]; };
  const key = (input, k) => input.dispatch('keydown', { key: k, ...noev });
  return { ctx, els, calls, noev, openRename, key };
}

test('#2 guard: render() durante a edição não destrói o input', async () => {
  const { ctx, els, openRename } = await setup();
  const li0 = els.list.children[0];
  const input = openRename();
  assert.equal(els.list.children[0].children[1].children[0].children[0], input, 'input aberto');
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
  assert.notEqual(els.list.children[0].children[1].children[0].children[0], input, 'lista re-renderizou');
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
  assert.deepEqual(calls.setAlias, [['/home/dev/projeto-x', 'Via Blur']]);
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
