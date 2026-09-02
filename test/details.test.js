// Janela SOLTA de detalhes da sessão (#59): o ctx "Detalhes da sessão" pede
// ao main (openDetails por sessionKey), o main empurra { s, readAt } à janela
// a cada refresh (live — não mais snapshot congelado do modal bloqueante).
// Aqui testamos o módulo src/details.js direto num vm: agents/identity/i18n +
// details.js (mesma técnica dos outros vm-tests, sem o renderer do overlay).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const CODE = ['agents.js', 'identity.js', 'i18n.js', 'details.js']
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

async function setup(aliases = {}) {
  const card = mkEl();
  const closeBtn = mkEl();
  const document = {
    querySelector: (sel) => (sel === '.dt-card' ? card : sel === '.ts-close' ? closeBtn : mkEl()),
    createElement: () => mkEl(), querySelectorAll: () => [],
  };
  const winListeners = {};
  const window = {
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    removeEventListener() {},
  };
  const calls = { copy: [], close: 0 };
  let dataCb = null;
  const api = {
    getLang: () => Promise.resolve('pt'),
    getAliases: () => Promise.resolve(aliases),
    copyText: (t) => calls.copy.push(t),
    closeDetails: () => { calls.close++; },
    onDetailsData: (cb) => { dataCb = cb; },
  };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console, Promise };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  ctx.api = api;
  vm.runInContext('initDetailsWindow(api);', ctx);
  await Promise.resolve(); await Promise.resolve();          // drena getLang/getAliases
  const fire = (t, ev) => (winListeners[t] || []).forEach((f) => f(ev || {}));
  const push = (s, readAt = 0) => dataCb({ s, readAt });
  const body = card._q['.dt-body'];
  const kv = () => {                                        // Map label → valor das .dt-row
    const m = new Map();
    for (const r of body.children) {
      if (r.className === 'dt-row') m.set(r.children[0].textContent, r.children[1].textContent);
    }
    return m;
  };
  const evsBox = () => body.children.find((c) => c.className === 'dt-evs');
  const timeline = () => (evsBox() ? evsBox().children : []);
  const timelineHead = () => body.children.find((c) => String(c.className).includes('dt-toggle'));
  return { card, body, closeBtn, calls, fire, push, kv, evsBox, timeline, timelineHead };
}

const now = Math.floor(Date.now() / 1000);
const mkSess = (id, origin, extra = {}) => ({
  session_id: id, pid: 1000 + id.length, cwd: `/home/dev/${id}`, agent: 'claude',
  last_event: 'Stop', last_event_ts: now, ...(origin && origin !== 'local' ? { origin } : {}), ...extra,
});

test('1º push monta o card: título = pasta (sem alias), campos de identidade', async () => {
  const { card, kv, push } = await setup();
  push(mkSess('api', null, { model: 'glm-5.2' }));
  assert.equal(card._q['.dt-title'].textContent, 'api', 'título = basename do cwd');
  const m = kv();
  assert.equal(m.get('Session ID'), 'api');
  assert.equal(m.get('Modelo'), 'glm-5.2');
  assert.equal(m.get('Origem'), 'local');
});

test('alias vence o cwd no título', async () => {
  const { card, push } = await setup({ api: 'meu-robô' });   // aliasKey = session_id puro
  push(mkSess('api', null, {}));
  assert.equal(card._q['.dt-title'].textContent, 'meu-robô');
});

test('sessão local: contexto completo + conta + botão copiar session_id/cwd', async () => {
  const { kv, push, body, calls } = await setup();
  push(mkSess('api', null, {
    model: 'glm-5.2', term_program: 'tilix', tmux_session: 'atl-api', windowid: '1234567',
    account: 'ghost',   // rótulo anotado no main (CLAUDE_CONFIG_DIR do environ)
  }));
  const m = kv();
  assert.equal(m.get('Conta'), 'ghost', 'conta Claude da sessão (perfil dd-claude)');
  assert.equal(m.get('Pasta'), '/home/dev/api');
  assert.equal(m.get('Terminal'), 'tilix');
  assert.equal(m.get('sessão tmux'), 'atl-api');
  assert.equal(m.get('Janela (X11)'), '1234567', 'windowid é LOCAL_ONLY — na local aparece');
  // botões copiar: session_id e cwd
  const copyBtns = body.children
    .filter((c) => c.className === 'dt-row' && c.children.length > 2);
  assert.equal(copyBtns.length, 2, 'session_id e cwd têm botão copiar');
  copyBtns[0].children[2].dispatch('click', { stopPropagation() {} });
  assert.deepEqual(calls.copy, ['api'], 'copiou o session_id');
});

test('sessão remota: Origem = peer, SEM campos LOCAL_ONLY (windowid/conta)', async () => {
  const { kv, push } = await setup();
  push(mkSess('rmt', 'alienware', { term_program: 'tilix' }));
  const m = kv();
  assert.equal(m.get('Origem'), 'alienware');
  assert.equal(m.has('Janela (X11)'), false, 'remota não tem windowid');
  assert.equal(m.has('Conta'), false, 'sem rótulo resolvido → linha ausente');
});

test('timeline: colapsada por padrão; clique no header expande em ordem recente primeiro', async () => {
  const { timeline, timelineHead, evsBox, push } = await setup();
  push(mkSess('api', null, {
    events: [
      { ts: now - 60, event: 'SessionStart', tool: null },
      { ts: now - 30, event: 'PermissionRequest', tool: 'Bash' },
      { ts: now - 5, event: 'Stop', tool: null },
    ],
  }));
  assert.ok(evsBox(), 'container da timeline existe');
  assert.equal(evsBox().hidden, true, 'colapsada por padrão');
  assert.equal(timelineHead().children[0].textContent, 'Linha do tempo (3)', 'contagem no header');
  timelineHead().dispatch('click', {});
  assert.equal(evsBox().hidden, false, 'clique no header expande');
  const evs = timeline();
  assert.equal(evs.length, 3, '3 eventos → 3 linhas');
  assert.equal(evs[0].children[1].textContent, 'Stop', 'mais recente primeiro');
  assert.equal(evs[1].children[1].textContent, 'PermissionRequest · Bash', 'evento + tool');
  assert.equal(evs[2].children[1].textContent, 'SessionStart');
  assert.ok(evs[0].children[0].textContent.match(/^\d{2}:\d{2}/), 'hora local no time');
  timelineHead().dispatch('click', {});
  assert.equal(evsBox().hidden, true, 'segundo clique recolapsa');
});

test('live update (#59): 2º push RE-substitui o corpo — não é mais snapshot congelado', async () => {
  const { kv, push } = await setup();
  push(mkSess('api', null, { model: 'glm-5.2', last_event: 'Stop' }));
  assert.equal(kv().get('Modelo'), 'glm-5.2');
  push(mkSess('api', null, { model: 'glm-5.3', last_event: 'PermissionRequest', last_tool: 'Bash' }));
  const m = kv();
  assert.equal(m.get('Modelo'), 'glm-5.3', 'modelo atualizou no 2º push');
  assert.equal(m.get('Última ferramenta'), 'Bash');
});

test('marca de leitura vigente vira linha "Lida até" (readAt vem do main)', async () => {
  const { kv, push } = await setup();
  push(mkSess('api'), now - 120);
  assert.ok(kv().get('Lida até'), 'linha presente com readAt > 0');
});

test('sessão encerrou (s=null): corpo vira o aviso, não o último snapshot', async () => {
  const { body, push } = await setup();
  push(mkSess('api'));
  assert.ok(body.children.some((c) => c.className === 'dt-row'));
  push(null);
  assert.ok(!body.children.some((c) => c.className === 'dt-row'), 'rows sumiram');
  assert.equal(body.children[0].textContent, 'Sessão encerrada — pode fechar esta janela.');
});

test('Esc e × pedem o close (main destrói a janela)', async () => {
  const { fire, closeBtn, calls } = await setup();
  fire('keydown', { key: 'Escape' });
  closeBtn.dispatch('click', { stopPropagation() {} });
  assert.equal(calls.close, 2, 'Esc + botão ×');
});
