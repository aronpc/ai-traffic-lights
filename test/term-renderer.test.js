const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'src', 'term-renderer.js'), 'utf8');

function element() {
  return {
    children: [], hidden: false, dataset: {}, className: '', innerHTML: '', textContent: '', _q: {},
    classList: { toggle() {}, contains() { return false; } },
    addEventListener() {}, remove() {}, contains() { return false; },
    appendChild(x) { this.children.push(x); return x; },
    querySelector(s) { return this._q[s] || (this._q[s] = element()); },
    querySelectorAll(s) { return s === '.tab' ? this.children : []; },
    getBoundingClientRect() { return { width: 800, height: 500 }; },
  };
}

function setup() {
  const els = {};
  for (const id of ['tabs', 'termArea', 'hostMenu', 'newTabBtn', 'winMinBtn', 'winMaxBtn', 'winCloseBtn', 'termApp', 'termGrip']) els[id] = element();
  const raf = [];
  const calls = { resize: [], terms: [] };
  const handlers = {};
  class Terminal {
    constructor() { this.cols = 80; this.rows = 24; this.focuses = 0; this.refreshes = 0; calls.terms.push(this); }
    loadAddon() {} open() {} onData() {} write() {} dispose() {}
    focus() { this.focuses++; }
    clearTextureAtlas() {}
    refresh() { this.refreshes++; }
  }
  class FitAddon { constructor() { this.fits = 0; } fit() { this.fits++; } }
  const trafficLight = {
    ptyInput() {}, ptyResize: (...x) => calls.resize.push(x), switchTab() {}, closeTab() {},
    termHosts: async () => [], newShell() {}, termWinControl() {}, resizeStartTerm() {}, resizeMoveTerm() {},
  };
  for (const name of ['onPtyOut', 'onPtyExit', 'onTermTabAdded', 'onTermTabRemoved', 'onTermTabActivated', 'onTermTabTitle', 'onTermMaximized', 'onTermShown', 'onTermRefit']) {
    trafficLight[name] = (cb) => { handlers[name] = cb; };
  }
  const window = { Terminal, FitAddon, trafficLight, addEventListener() {} };
  const document = {
    visibilityState: 'visible',
    getElementById: (id) => els[id],
    createElement: () => element(),
    addEventListener() {},
  };
  const ctx = {
    window, document, console,
    requestAnimationFrame: (cb) => { raf.push(cb); },
    setTimeout: () => 0,
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, els, raf, calls, handlers };
}

test('showTab descarta o frame atrasado de uma aba que deixou de ser ativa', () => {
  const { raf, calls, handlers } = setup();
  handlers.onTermTabAdded({ tabId: 1, title: 'one' });
  const first = raf.shift();
  handlers.onTermTabAdded({ tabId: 2, title: 'two' });
  const before = { focuses: calls.terms[0].focuses, refreshes: calls.terms[0].refreshes, resizes: calls.resize.length };

  first();

  assert.equal(calls.terms[0].focuses, before.focuses);
  assert.equal(calls.terms[0].refreshes, before.refreshes);
  assert.equal(calls.resize.length, before.resizes);
});

test('refitTab restaura visibilidade e mantém a aba ativa', () => {
  const { ctx, els, calls, handlers } = setup();
  handlers.onTermTabAdded({ tabId: 1, title: 'one' });
  handlers.onTermTabAdded({ tabId: 2, title: 'two' });
  const [one, two] = els.termArea.children;
  assert.equal(one.hidden, true);
  assert.equal(two.hidden, false);

  ctx.refitTab(1);

  assert.equal(one.hidden, true);
  assert.equal(two.hidden, false);
  ctx.fitActive();
  assert.equal(calls.resize.at(-1)[0], 2, 'aba 2 continua ativa após medir a aba 1');
});
