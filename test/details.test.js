// Detached session details window (#59): the ctx "Session details" asks main
// (openDetails by sessionKey), main pushes { s, readAt } to the window on
// every refresh (live — no longer a frozen snapshot from the blocking modal).
// Here we test src/details.js directly in a vm: agents/identity/i18n +
// details.js (same technique as the other vm-tests, without the overlay
// renderer).
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
    parentNode: null,
    append(...e) { for (const x of e) { x.parentNode = this; this.children.push(x); } },
    appendChild(e) { e.removed = false; e.parentNode = this; this.children.push(e); return e; },
    insertBefore(el, ref) {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
      }
      const j = ref ? this.children.indexOf(ref) : -1;
      if (j >= 0) this.children.splice(j, 0, el); else this.children.push(el);
      el.parentNode = this;
      return el;
    },
    replaceChildren(...e) { this.children = e; for (const x of e) x.parentNode = this; },
    querySelector(s) { return this._q[s] || (this._q[s] = mkEl()); },
    querySelectorAll() { return []; },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.children.indexOf(this);
        if (i >= 0) this.parentNode.children.splice(i, 1);
        this.parentNode = null;
      }
      this.removed = true;
    },
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

async function setup(aliases = {}, { noDrain = false } = {}) {
  const card = mkEl();
  const closeBtn = mkEl();
  const document = {
    querySelector: (sel) => (sel === '.dt-card' ? card : sel === '.ts-close' ? closeBtn : mkEl()),
    createElement: () => mkEl(), querySelectorAll: () => [],
    documentElement: mkEl(),   // chrome i18n: <html lang> is set by details.js
    title: '',
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
  // drains getLang/getAliases (the race test holds this on purpose)
  const drain = async () => { await Promise.resolve(); await Promise.resolve(); };
  if (!noDrain) await drain();
  const fire = (t, ev) => (winListeners[t] || []).forEach((f) => f(ev || {}));
  const push = (s, readAt = 0) => dataCb({ s, readAt });
  // materialize .dt-body NOW: with noDrain the card hasn't mounted anything
  // yet, and the same lazy object must exist before and after the 1st push
  const body = card.querySelector('.dt-body');
  const kv = () => {                                        // Map label → value of .dt-row
    const m = new Map();
    for (const r of body.children) {
      if (r.className === 'dt-row') m.set(r.children[0].textContent, r.children[1].textContent);
    }
    return m;
  };
  const evsBox = () => body.children.find((c) => c.className === 'dt-evs');
  const timeline = () => (evsBox() ? evsBox().children : []);
  const timelineHead = () => body.children.find((c) => String(c.className).includes('dt-toggle'));
  return { card, body, closeBtn, document, calls, fire, push, kv, evsBox, timeline, timelineHead, drain };
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
  const { card, push } = await setup({ api: 'meu-robô' });   // aliasKey = pure session_id
  push(mkSess('api', null, {}));
  assert.equal(card._q['.dt-title'].textContent, 'meu-robô');
});

test('sessão local: contexto completo + conta + botão copiar session_id/cwd', async () => {
  const { kv, push, body, calls } = await setup();
  push(mkSess('api', null, {
    model: 'glm-5.2', term_program: 'tilix', tmux_session: 'atl-api', windowid: '1234567',
    account: 'ghost',   // label annotated in main (CLAUDE_CONFIG_DIR from environ)
  }));
  const m = kv();
  assert.equal(m.get('Conta'), 'ghost', 'conta Claude da sessão (perfil dd-claude)');
  assert.equal(m.get('Pasta'), '/home/dev/api');
  assert.equal(m.get('Terminal'), 'tilix');
  assert.equal(m.get('sessão tmux'), 'atl-api');
  assert.equal(m.get('Janela (X11)'), '1234567', 'windowid é LOCAL_ONLY — na local aparece');
  // copy buttons: session_id and cwd (the button now lives MOUNTED and
  // hidden — the filter is by visibility, not existence)
  const copyBtns = body.children
    .filter((c) => c.className === 'dt-row' && c.children.length > 2 && !c.children[2].hidden);
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

test('race do bootstrap: push antes do getLang resolver NÃO pinta "encerrada" sobre card vivo', async () => {
  // main pushes details-data on did-finish-load; getLang/getAliases are
  // invokes that can resolve AFTER — the "ended" placeholder from the then
  // must not overwrite a card that already mounted (bug measured in review).
  const t = await setup({}, { noDrain: true });
  t.push(mkSess('api', null, { model: 'glm-5.3' }));
  await t.drain();
  assert.equal(t.card._q['.dt-title'].textContent, 'api', 'card vivo segue montado');
  assert.ok(t.body.children.some((c) => c.className === 'dt-row'), 'rows presentes');
  // 1st push mounted with T=en (bootstrap default); the next refresh already
  // runs with getLang resolved and migrates the labels to pt IN THE SAME node
  t.push(mkSess('api', null, { model: 'glm-5.3' }));
  assert.equal(t.kv().get('Modelo'), 'glm-5.3');
});

test('refresh ao vivo é INCREMENTAL: mesmo node reusado e timeline expandida persiste', async () => {
  const { body, push, evsBox, timeline, timelineHead } = await setup();
  const ev = (ts, event, tool) => ({ ts, event, tool });
  const keyEl = (k) => body.children.find((c) => c.getAttribute && c.getAttribute('data-key') === k);
  push(mkSess('api', null, {
    model: 'glm-5.2',
    events: [ev(now - 60, 'SessionStart'), ev(now - 30, 'Stop')],
  }));
  timelineHead().dispatch('click', {});            // user expands the timeline
  assert.equal(evsBox().hidden, false, 'expandida');
  const modelBefore = keyEl('model');
  assert.ok(modelBefore, 'row do modelo existe');

  push(mkSess('api', null, {
    model: 'glm-5.3',
    events: [ev(now - 60, 'SessionStart'), ev(now - 30, 'Stop'), ev(now - 5, 'Notification')],
  }));
  assert.ok(keyEl('model') === modelBefore, 'row do modelo é o MESMO node (update in place)');
  assert.equal(keyEl('model').children[1].textContent, 'glm-5.3', 'valor atualizou');
  assert.equal(evsBox().hidden, false, 'timeline CONTINUA expandida após o refresh');
  assert.equal(evsBox() === body.children.find((c) => c.getAttribute && c.getAttribute('data-key') === 'evs'), true, 'box da timeline é o MESMO node');
  assert.equal(timeline().length, 3, '3 eventos após o refresh');
  assert.ok(timelineHead().children[0].textContent.includes('(3)'), 'contagem atualizou');
});

test('timeline: append de evento NOVO não recria as linhas existentes (chave estável)', async () => {
  // CodeRabbit PR #63: keying the rows by the REVERSED array index shifted
  // every key by 1 on each append — syncChildren evicted and recreated ALL
  // the rows on every refresh that brought a new event. The key is now
  // signature + chronological ordinal: an append reuses every existing node
  // and creates only the new one.
  const { push, timeline, timelineHead } = await setup();
  const ev = (ts, event, tool) => ({ ts, event, tool });
  push(mkSess('api', null, {
    events: [ev(now - 60, 'SessionStart'), ev(now - 30, 'PermissionRequest', 'Bash'), ev(now - 5, 'Stop')],
  }));
  timelineHead().dispatch('click', {});            // expande (para ver as linhas)
  const before = timeline().slice();               // mais recente primeiro
  assert.equal(before.length, 3);

  push(mkSess('api', null, {
    events: [ev(now - 60, 'SessionStart'), ev(now - 30, 'PermissionRequest', 'Bash'), ev(now - 5, 'Stop'), ev(now - 1, 'Notification')],
  }));
  const after = timeline();
  assert.equal(after.length, 4, '4 eventos → 4 linhas');
  assert.equal(after[0].children[1].textContent, 'Notification', 'novo evento no topo');
  assert.ok(after[1] === before[0] && after[2] === before[1] && after[3] === before[2],
    'os 3 nodes antigos são os MESMOS objetos — nenhum recriado pelo append');
  for (const el of before) assert.ok(!el.removed, 'nenhum node antigo saiu do DOM');
});

test('chrome da janela é localizado: <html lang>, <title> e aria-label do ×', async () => {
  // CodeRabbit PR #63: details.html shipped static lang="en" + hardcoded pt
  // title/aria-label. initDetailsWindow localizes the chrome with the
  // resolved language (same keys the overlay uses).
  const { document, closeBtn } = await setup();
  assert.equal(document.documentElement.lang, 'pt', '<html lang> no idioma resolvido');
  assert.equal(document.title, 'Detalhes da sessão', '<title> em pt');
  assert.equal(closeBtn.getAttribute('aria-label'), 'Fechar', 'aria-label do × em pt');
});
