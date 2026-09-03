// Regressão multi-conta Claude (#58): uma barra por conta, rótulo "Plano · conta"
// no usageLabel e rename de apelido da conta (dblclick na barra) sobrevivendo a
// re-renders. Mesma técnica do rename.test.js: scripts REAIS do renderer num
// contexto vm com DOM mock, exercitando os handlers reais de dblclick/blur.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const CODE = ['agents.js', 'identity.js', 'state-machine.js', 'i18n.js', 'renderer.js']
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

// Renderer isolado com o canal de uso (onUsage) capturável e o IPC de apelido
// de conta (setAccountLabel) gravando as chamadas.
async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay']) els[id] = mkEl();
  const calls = { setAccountLabel: [] };
  let usageCb = null;
  const window = {
    addEventListener() {},
    trafficLight: {
      onSessions() {}, requestSessions() {}, setExpanded() {}, autoHeight() {},
      onUsage: (cb) => { usageCb = cb; }, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias() {},
      setAccountLabel: (accountId, label) => calls.setAccountLabel.push([accountId, label]),
      notify() {}, toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve({ revealOnRed: false, soundEnabled: false }), onSettingsChanged() {},
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {},
      saveSettings() {}, openSettings() {},
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
  await Promise.resolve();
  return { ctx, els, calls, pushUsage: (u) => usageCb(u) };
}

// Duas contas Claude multi-conta (shape que o collectUsage produz: id sufixado,
// accountId = endereço do rename, account = rótulo). SEMPRE clonar ao usar: o
// commit do rename muta otimisticamente u.account (como o push real do main
// manda objetos frescos a cada coleta, objetos compartilhados entre testes
// vazariam estado — o blur do teste seguinte via "nada mudou").
const ACCT_A = { id: 'claude-plan:aa11bb', agent: 'claude', plan: 'Claude Max 5×', title: null,
  usedPct: null, resetAt: null, resetInMin: null, account: 'Alpha Org', accountId: 'aa11bb' };
const ACCT_B = { id: 'claude-plan:cc22dd', agent: 'claude', plan: 'Claude Max 5×', title: null,
  usedPct: null, resetAt: null, resetInMin: null, account: 'beta', accountId: 'cc22dd' };
const fresh = (...a) => a.map((x) => ({ ...x }));

test('#58 usageLabel: rótulo da conta compõe o nome — "Claude(Max 5× · conta)"', async () => {
  const { ctx } = await setup();
  assert.equal(ctx.usageLabel(ACCT_A), 'Claude(Max 5× · Alpha Org)');
  assert.equal(ctx.usageLabel(ACCT_B), 'Claude(Max 5× · beta)');
  // sem conta (conta única) → formato de hoje, sem " · "
  assert.equal(ctx.usageLabel({ agent: 'claude', plan: 'Claude Max 5×', title: null }), 'Claude(Max 5×)');
});

test('#58 renderUsage: 2 contas → 2 barras com rótulos distintos', async () => {
  const { els, pushUsage } = await setup();
  pushUsage(fresh(ACCT_A, ACCT_B));
  assert.equal(els.usage.children.length, 2, 'uma barra por conta');
  assert.equal(els.usage.children[0].children[1].textContent, 'Claude(Max 5× · Alpha Org)');
  assert.equal(els.usage.children[1].children[1].textContent, 'Claude(Max 5× · beta)');
});

test('#58 dblclick no nome da barra abre o rename; Enter persiste via set-account-label', async () => {
  const { els, calls, pushUsage } = await setup();
  pushUsage(fresh(ACCT_A, ACCT_B));
  const name = els.usage.children[0].children[1];   // .urow__name da conta A
  name.dispatch('dblclick', {});
  const input = name.children[0];
  assert.ok(input, 'input aberto no lugar do nome');
  input.value = 'Ghost';
  input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  input.dispatch('blur', {});                       // blur pós-remoção não re-salva
  assert.deepEqual(calls.setAccountLabel, [['aa11bb', 'Ghost']], 'salvou 1x, com o accountId da barra');
});

test('#58 rename da conta sobrevive a re-render (guard compartilhado com o de sessão)', async () => {
  const { ctx, els, calls, pushUsage } = await setup();
  pushUsage(fresh(ACCT_A, ACCT_B));
  const name = els.usage.children[0].children[1];
  name.dispatch('dblclick', {});
  const input = name.children[0];
  ctx.render();                                     // tick de 2s durante a edição
  assert.equal(name.children[0], input, 'input não foi destruído');
  input.value = 'Ghost';
  input.dispatch('blur', {});
  assert.equal(calls.setAccountLabel.length, 1);
});

test('#58 Escape cancela o rename sem persistir', async () => {
  const { els, calls, pushUsage } = await setup();
  pushUsage(fresh(ACCT_A));
  const name = els.usage.children[0].children[1];
  name.dispatch('dblclick', {});
  const input = name.children[0];
  input.value = 'NAO SALVA';
  input.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  input.dispatch('blur', {});
  assert.equal(calls.setAccountLabel.length, 0, 'Escape não salva');
});

test('#58 sem accountId (conta única) o dblclick NÃO abre rename', async () => {
  const { els, pushUsage } = await setup();
  pushUsage([{ id: 'claude-plan', agent: 'claude', plan: 'Claude Max 5×', title: null, usedPct: null }]);
  const name = els.usage.children[0].children[1];
  name.dispatch('dblclick', {});
  assert.equal(name.children.length, 0, 'nenhum input — barra de conta única não renomeia');
});

// ================= review fix #9: rename do tile PROXY descartado =================
// O main populava lastAccountIds com `if (!pc) continue`: conta proxy sem
// .claude.json legível tinha TILE (sfx do dir, via claudeAccountKey) mas não
// tinha entrada no mapa — o set-account-label dela caía no `if (!key) return`
// e o apelido sumia em silêncio. O handler real (setupAccountLabelsIpc) com
// getLastAccountIds mockado no formato novo: sfx → key=DIR da conta proxy.
const { setupAccountLabelsIpc } = require('../src/ipc/account-labels.js');
const usageMod = require('../src/usage.js');

function setupIpc(ids) {
  const handlers = {};
  const ipcMain = { on: (ch, f) => { handlers[ch] = f; } };
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-albl-'));
  const file = path.join(tmpdir, 'account-labels.json');
  let recollects = 0;
  setupAccountLabelsIpc({
    ipcMain, ACCOUNT_LABELS_FILE: file,
    getLastAccountIds: () => ids,
    recollect: () => { recollects++; },
  });
  return {
    call: (payload) => handlers['set-account-label'](null, payload),
    labels: () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } },
    recollects: () => recollects,
  };
}

test('#9 rename do tile PROXY persiste — lastAccountIds leva key=dir p/ conta sem oauth', () => {
  const dir = '/home/u/.gh-claude';
  const sfx = usageMod.claudeAccountSfx(usageMod.claudeAccountKey(null, dir)); // sfx do tile (sem .claude.json)
  const t = setupIpc({ [sfx]: dir });
  t.call({ accountId: sfx, label: 'Meu proxy' });
  assert.deepEqual(t.labels(), { [dir]: 'Meu proxy' }, 'apelido gravado sob a chave dir');
  assert.equal(t.recollects(), 1, 're-coleta disparou pra barra refletir na hora');
});

test('#9 sfx DESCONHECIDO (conta fechou desde o render) descarta sem gravar', () => {
  const t = setupIpc({ aa11bb: 'uuid-A' });
  t.call({ accountId: 'zz9999', label: 'X' });
  assert.deepEqual(t.labels(), {}, 'nada gravado');
  assert.equal(t.recollects(), 0);
});

test('#9 payload malformado é ignorado (nem lê o mapa)', () => {
  const t = setupIpc({});
  t.call({ accountId: '../../etc', label: 'X' });   // fora do hex — rejeitado
  t.call({ accountId: 'aa11bb' });                  // sem label (limpa) — ok abaixo
  t.call(null);
  assert.deepEqual(t.labels(), {});
});
