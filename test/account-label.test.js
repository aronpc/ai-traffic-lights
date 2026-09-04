// Claude multi-account regression (#58): one bar per account, "Plan · account"
// label in usageLabel, and account label rename (dblclick on the bar) surviving
// re-renders. Same technique as rename.test.js: REAL renderer scripts in a vm
// context with mock DOM, exercising the real dblclick/blur handlers.
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

// Isolated renderer with the usage channel (onUsage) capturable and the account
// label IPC (setAccountLabel) recording calls.
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

// Two Claude multi-account accounts (the shape collectUsage produces: suffixed
// id, accountId = rename address, account = label). ALWAYS clone when using:
// the rename commit optimistically mutates u.account (since the real push from
// main sends fresh objects on every collection, objects shared across tests
// would leak state — the next test's blur would see "nothing changed").
const ACCT_A = { id: 'claude-plan:aa11bb', agent: 'claude', plan: 'Claude Max 5×', title: null,
  usedPct: null, resetAt: null, resetInMin: null, account: 'Alpha Org', accountId: 'aa11bb' };
const ACCT_B = { id: 'claude-plan:cc22dd', agent: 'claude', plan: 'Claude Max 5×', title: null,
  usedPct: null, resetAt: null, resetInMin: null, account: 'beta', accountId: 'cc22dd' };
const fresh = (...a) => a.map((x) => ({ ...x }));

test('#58 usageLabel: rótulo da conta compõe o nome — "Claude(Max 5× · conta)"', async () => {
  const { ctx } = await setup();
  assert.equal(ctx.usageLabel(ACCT_A), 'Claude(Max 5× · Alpha Org)');
  assert.equal(ctx.usageLabel(ACCT_B), 'Claude(Max 5× · beta)');
  // no account (single account) → today's format, without " · "
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
  const name = els.usage.children[0].children[1];   // account A's .urow__name
  name.dispatch('dblclick', {});
  const input = name.children[0];
  assert.ok(input, 'input aberto no lugar do nome');
  input.value = 'Ghost';
  input.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  input.dispatch('blur', {});                       // post-removal blur does not re-save
  assert.deepEqual(calls.setAccountLabel, [['aa11bb', 'Ghost']], 'salvou 1x, com o accountId da barra');
});

test('#58 rename da conta sobrevive a re-render (guard compartilhado com o de sessão)', async () => {
  const { ctx, els, calls, pushUsage } = await setup();
  pushUsage(fresh(ACCT_A, ACCT_B));
  const name = els.usage.children[0].children[1];
  name.dispatch('dblclick', {});
  const input = name.children[0];
  ctx.render();                                     // 2s tick during editing
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

// ================= review fix #9: discarded PROXY tile rename =================
// main populated lastAccountIds with `if (!pc) continue`: a proxy account
// without a readable .claude.json had a TILE (dir sfx, via claudeAccountKey)
// but no entry in the map — its set-account-label fell into `if (!key) return`
// and the label silently vanished. The real handler (setupAccountLabelsIpc)
// with getLastAccountIds mocked in the new format: sfx → key=DIR of the proxy
// account.
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
  const sfx = usageMod.claudeAccountSfx(usageMod.claudeAccountKey(null, dir)); // tile's sfx (no .claude.json)
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
  t.call({ accountId: '../../etc', label: 'X' });   // outside hex — rejected
  t.call({ accountId: 'aa11bb' });                  // no label (clears) — ok below
  t.call(null);
  assert.deepEqual(t.labels(), {});
});
