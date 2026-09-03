// Regression for issue #2: in-place rename must survive re-renders.
// Loads the renderer's REAL scripts (agents + state-machine + i18n +
// renderer, in the same order as index.html) into a vm context with a mock
// DOM and exercises the real dblclick/keydown/blur handlers. No browser, no deps.
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

// Builds an isolated renderer with a renameable session already in the list.
async function setup() {
  const els = {};
  for (const id of ['list', 'empty', 'counts', 'usage', 'launcher', 'verBtn', 'summaryLed', 'expandBtn', 'quitBtn', 'grip', 'settingsBtn', 'overlay', 'ctxMenu']) els[id] = mkEl();
  const calls = { setAlias: [], notify: [], transcriptResolvers: [] };
  let sessionsCb = null;
  let marksCb = null;                        // onReadMarks (#56 re-seeding)
  const window = {
    addEventListener() {}, removeEventListener() {},
    trafficLight: {
      onSessions: (cb) => { sessionsCb = cb; },
      onReadMarks: (cb) => { marksCb = cb; },
      requestSessions() {}, setExpanded() {}, autoHeight() {},
      onUsage() {}, requestUsage() {}, onUsageMeta() {}, forceUsage() {},
      resizeStart() {}, resizeMove() {}, focus() {},
      getAliases: () => Promise.resolve({}), setAlias: (cwd, v) => calls.setAlias.push([cwd, v]),
      notify: (...args) => calls.notify.push(args), toggleVisibility() {}, setTrayLevel() {},
      getLaunchers: () => Promise.resolve([]), launchAgent() {},
      getSettings: () => Promise.resolve({ revealOnRed: false, soundEnabled: false }), onSettingsChanged() {},
      getVersion: () => Promise.resolve('0.0.0'), getUpdate: () => Promise.resolve(null),
      onUpdateState() {}, checkUpdate() {}, downloadUpdate() {}, installUpdate() {}, // auto-updater
      saveSettings() {}, openSettings() {},
      getLang: () => Promise.resolve('pt'),                             // i18n
      fetchTranscript: () => new Promise((resolve, reject) => calls.transcriptResolvers.push({ resolve, reject })),

    },
  };
  const document = { getElementById: (id) => els[id], createElement: () => mkEl(), querySelectorAll: () => [], title: '', documentElement: { style: { setProperty() {} } } };
  const ctx = { document, window, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, console };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);

  await Promise.resolve();                 // drains getAliases().then
  const now = Math.floor(Date.now() / 1000);
  sessionsCb([{ session_id: 's1', pid: 111, cwd: '/home/dev/projeto-x', agent: 'claude', last_event: 'Stop', last_event_ts: now }]);

  const noev = { preventDefault() {}, stopPropagation() {} };
  const labelEl = () => els.list.children[0].children[3].children[0]; // li → main (4th: led,reason,llm,main) → labelEl
  const openRename = () => { labelEl().dispatch('dblclick', noev); return labelEl().children[0]; };
  const key = (input, k) => input.dispatch('keydown', { key: k, ...noev });
  const marks = (state) => marksCb(state);
  return { ctx, els, calls, noev, openRename, key, marks, sessionsCb: (list) => sessionsCb(list) };
}

test('#2 guard: render() durante a edição não destrói o input', async () => {
  const { ctx, els, openRename } = await setup();
  const li0 = els.list.children[0];
  const input = openRename();
  assert.equal(els.list.children[0].children[3].children[0].children[0], input, 'input aberto');
  ctx.render();                            // setInterval(2s) tick / session event
  ctx.render();
  assert.equal(els.list.children[0], li0, 'lista intocada (render foi no-op)');
});

test('#2 Enter commita exatamente uma vez (blur pós-remoção não re-salva)', async () => {
  const { els, calls, openRename, key, noev } = await setup();
  const input = openRename();
  input.value = 'Meu Alias';
  key(input, 'Enter');
  input.dispatch('blur', noev);            // the browser fires blur when removed from the DOM
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
  // Key = the row's session_id ('s1'), NOT the cwd (that was the bug: label keyed by directory).
  assert.deepEqual(calls.setAlias, [['s1', 'Via Blur']]);
});

test('rename por sessão: mesmo cwd → apelido não vaza p/ os irmãos', async () => {
  const { els, calls, noev, sessionsCb } = await setup();
  const now = Math.floor(Date.now() / 1000);
  // Two terminals in the SAME directory, distinct sessions — the bug's case.
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
  first.dispatch('blur', noev);            // closes the 1st
  const second = openRename();             // 2nd must open (renaming didn't get stuck)
  assert.ok(second && second !== first, 'novo input abre normalmente');
  key(second, 'Escape');
});

test('nova sessão local awaiting alerta depois que a origin local reaparece', async () => {
  const { calls, sessionsCb } = await setup();
  const now = Math.floor(Date.now() / 1000);
  sessionsCb([]); // local origin disappears and is pruned from seenOrigins
  sessionsCb([{ session_id: 's2', pid: 222, agent: 'claude', last_event: 'PermissionRequest', last_event_ts: now }]);
  assert.equal(calls.notify.length, 1, 'origem local nova passa pela comparação de transição');
});

test('resposta antiga de transcript não sobrescreve a sessão mais recente', async () => {
  const { ctx, els, calls } = await setup();
  ctx.openTranscriptPanel({ session_id: 'old', pid: 1, agent: 'claude', cwd: '/old' });
  ctx.openTranscriptPanel({ session_id: 'new', pid: 2, agent: 'claude', cwd: '/new' });
  const body = els.overlay.children.at(-1).querySelector('.ts-body');

  calls.transcriptResolvers[1].resolve([{ role: 'user', text: 'mais novo' }]);
  await Promise.resolve();
  assert.equal(body.innerHTML, '', 'resposta atual substituiu o loading');

  calls.transcriptResolvers[0].resolve([]);
  await Promise.resolve();
  assert.equal(body.innerHTML, '', 'resposta antiga vazia foi descartada');
});

test('menu de contexto: rename usa o label VIVO mesmo com re-render no meio', async () => {
  // The menu survives render ticks; the labelEl captured when the menu OPENS
  // is detached by render's replaceChildren. The click must resolve the node
  // of the CURRENT list — otherwise the input mounts outside the DOM,
  // `renaming` stays on forever, and render() freezes (code review finding).
  const { ctx, els, calls, noev } = await setup();
  const li0 = els.list.children[0];
  li0.dispatch('contextmenu', noev);
  assert.equal(els.ctxMenu.hidden, false, 'menu aberto');

  ctx.render();                                // session/idle tick with the menu open
  assert.notEqual(els.list.children[0], li0, 'lista re-renderizou (node antigo morreu)');

  const item = els.ctxMenu.children.find(
    (c) => c.className === 'ctx__item' && c.textContent === ctx.makeT('pt')('ctx_rename'),
  );
  assert.ok(item, 'item Renomear presente');
  item.dispatch('click', noev);

  const labelEl = els.list.children[0].children[3].children[0];
  const input = labelEl.children[0];
  assert.ok(input && input.className === 'row-input', 'input montou no label VIVO da lista atual');

  ctx.render();                                // guard still holds during editing
  assert.equal(els.list.children[0].children[3].children[0].children[0], input, 'render no-op');
  input.value = 'Do Menu';
  input.dispatch('blur', noev);
  assert.deepEqual(calls.setAlias, [['s1', 'Do Menu']], 'commit salvou');
  ctx.render();
  assert.notEqual(els.list.children[0].children[3].children[0].children[0], input, 'render retomou após o commit');
});

test('menu aberto + sessão morre: rename aborta limpo sem travar o render', async () => {
  const { ctx, els, noev, sessionsCb } = await setup();
  els.list.children[0].dispatch('contextmenu', noev);
  const item = els.ctxMenu.children.find(
    (c) => c.className === 'ctx__item' && c.textContent === ctx.makeT('pt')('ctx_rename'),
  );

  sessionsCb([]);                              // session vanished → empty list, no live label
  item.dispatch('click', noev);                // the click must not turn on `renaming` without a target

  const now = Math.floor(Date.now() / 1000);
  sessionsCb([{ session_id: 's2', pid: 2, cwd: '/outro', agent: 'claude', last_event: 'Stop', last_event_ts: now }]);
  assert.equal(els.list.children.length, 1, 'render segue vivo (não congelou)');
  const input = els.list.children[0].children[3].children[0].children[0];
  assert.ok(!input || input.className !== 'row-input', 'nenhum input fantasma montado');
});

test('#56 reconexão: marca do peer re-hidratada com o MESMO valor após a poda', async () => {
  // Cycle measured in the review: peer goes down → sessions vanish → render
  // prunes readMarks (liveKeys without the key); peer comes back → the
  // re-anchored mark arrives EQUAL to the persisted one → main's LWW skips
  // it → nothing was pushed → session red despite being read. main now
  // re-sends the standing state of live keys after the session push — this
  // test documents the channel contract: the handler accepts an EQUAL value
  // and re-hydrates the pruned key.
  const { els, sessionsCb, marks } = await setup();
  const now = Math.floor(Date.now() / 1000);
  const peerSess = {
    session_id: 'rp1', pid: 1234, cwd: '/home/peer/proj', agent: 'claude',
    origin: 'peerhost', last_event: 'PermissionRequest', last_event_ts: now - 60,
  };
  const ledOf = () => els.list.children[0].children[0].className;   // li → led

  sessionsCb([peerSess]);                       // peer connected: red
  assert.equal(ledOf(), 'led led--awaiting');

  marks({ 'peerhost:1234': now });              // mark arrives (boot/poll) → gray
  assert.equal(ledOf(), 'led led--read');

  sessionsCb([]);                               // peer WENT DOWN: render prunes the mark
  sessionsCb([peerSess]);                       // peer CAME BACK: red again
  assert.equal(ledOf(), 'led led--awaiting', 'sem a re-semeadura a sessão reacende');

  marks({ 'peerhost:1234': now });              // reseed with the SAME value
  assert.equal(ledOf(), 'led led--read', 'valor igual re-hidrata a chave podada');
});
