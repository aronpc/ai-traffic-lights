// term-renderer.js — UI for the Terminal window (src/term.html). "Dumb" renderer:
// only draws tabs + xterm; ALL state (pty/ws) lives in main (Map termSessions).
// One xterm per tab; only the active tab's holder is visible. IPC keyed by tabId.
const terms = new Map();       // tabId -> { term, fit, holder }
let activeTabId = null;
const $tabs = document.getElementById('tabs');
const $area = document.getElementById('termArea');

function ensureTerm(tabId) {
  if (terms.has(tabId)) return terms.get(tabId);
  // FitAddon UMD may be the class itself or {FitAddon} (CJS) — robust to both.
  const FitCls = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
  if (!window.Terminal || !FitCls) return null;
  const term = new window.Terminal({ fontSize: 12, fontFamily: 'monospace', cursorBlink: true,
    theme: { background: '#12151c', foreground: '#f4f6f9', cursor: '#f4f6f9' } });
  const fit = new FitCls();
  term.loadAddon(fit);
  const holder = document.createElement('div');
  holder.className = 'term-holder';
  holder.dataset.tab = String(tabId);
  holder.hidden = true;
  $area.appendChild(holder);
  term.open(holder);
  term.onData((d) => window.trafficLight.ptyInput(tabId, d));
  terms.set(tabId, { term, fit, holder });
  return terms.get(tabId);
}

function showTab(tabId) {
  activeTabId = tabId;
  for (const [id, t] of terms) t.holder.hidden = (id !== tabId);
  for (const b of $tabs.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === String(tabId));
  const t = terms.get(tabId);
  if (t) {
    if (areaVisible()) { try { t.fit.fit(); } catch {} }
    t.term.focus();
    // 2nd fit after paint: the holder has just become visible, the final layout
    // only settles after the frame; re-fit + forward the size to the pty/tmux
    // (otherwise tmux kept the old size and did not fill the window). Only when
    // there is a real area — with the window hidden the fit would collapse to 2x1.
    requestAnimationFrame(() => {
      if (activeTabId !== tabId) return;
      try { t.term.focus(); } catch {}
      if (!areaVisible()) return;
      try { t.fit.fit(); } catch {}
      if (t.term.cols > 2 && t.term.rows > 1) {
        try { window.trafficLight.ptyResize(tabId, t.term.cols, t.term.rows); } catch {}
      }
      repaint(t);   // reexibir a janela apaga o canvas; o buffer sobrevive → repinta
    });
  }
}

// Guard against fit/resize with a zeroed layout (hidden/minimized window):
// FitAddon clamps to the MINIMUM (2 cols x 1 row) and we would send that size
// to tmux. Measured: hiding termWin does not always zero the layout, but
// minimizing and switching workspaces do — so the check stays.
function areaVisible() {
  const r = $area.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

// Forces xterm to REDRAW what is already in the buffer. Hiding and reopening
// the window (termWin.hide()/show()) discards the xterm canvas textures, but
// NOT the buffer — measured: all lines are still there, only the screen goes
// blank. With nothing invalidating the render, xterm does not repaint on its
// own: it only draws what CHANGES, and nothing changed. refresh() marks all
// lines as dirty.
function repaint(t) {
  if (!t) return;
  // clearTextureAtlas() BEFORE refresh: refresh alone re-marks the lines as
  // dirty, but the renderer redraws using the cached GLYPH ATLAS — and that is
  // what gets corrupted when the window is hidden/re-shown (xterm itself
  // documents this method as a workaround for corrupted textures, e.g.
  // Chromium/Nvidia on resume from suspend). Without clearing the atlas the
  // text comes back "erased"/ghosted instead of crisp. Discarding the atlas
  // forces each glyph to be redrawn from scratch.
  try { t.term.clearTextureAtlas(); } catch {}
  try { t.term.refresh(0, t.term.rows - 1); } catch {}
}

function fitActive() {
  if (activeTabId == null || !areaVisible()) return;
  const t = terms.get(activeTabId);
  if (!t) return;
  try { t.fit.fit(); } catch {}
  if (t.term.cols > 2 && t.term.rows > 1) {
    try { window.trafficLight.ptyResize(activeTabId, t.term.cols, t.term.rows); } catch {}
  }
}

// Re-fit a specific tab and re-send the size to the pty/ws. Used when the
// CONNECTION is (re)established (revive): `start` was sent with the size that
// was in s.cols/s.rows, which may be stale relative to the current xterm —
// the remote tmux then drew at the wrong size and the content came in
// "mispositioned". Re-fit takes the actual window size and re-sends it.
function refitTab(tabId) {
  const t = terms.get(tabId);
  if (!t) return;
  const previousActiveTabId = activeTabId;
  const hidden = new Map([...terms].map(([id, x]) => [id, x.holder.hidden]));
  try {
    // ensure this tab's holder is visible only during the measurement
    if (t.holder.hidden) { for (const [id, x] of terms) x.holder.hidden = (id !== tabId); }
    if (!areaVisible()) return;
    try { t.fit.fit(); } catch {}
    if (t.term.cols > 2 && t.term.rows > 1) {
      try { window.trafficLight.ptyResize(tabId, t.term.cols, t.term.rows); } catch {}
    }
  } finally {
    activeTabId = previousActiveTabId;
    for (const [id, wasHidden] of hidden) {
      const x = terms.get(id);
      if (x) x.holder.hidden = wasHidden;
    }
  }
}

// ---- main events ----
// Main only delivers term-tab-added once termWin is STABLE (otherwise the
// xterm opened during the hide→show transition and the render broke — black
// tab). Until term-tab-added arrives, pty-out is buffered here and written
// upon tab creation.
const pendingOut = new Map();
function doTermTabAdded(tabId, title) {
  ensureTerm(tabId);
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.tab = String(tabId);
  btn.innerHTML = '<span class="tab-title"></span><span class="tab-close" title="fechar">×</span>';
  btn.querySelector('.tab-title').textContent = title;
  btn.addEventListener('click', (e) => { if (e.target.classList.contains('tab-close')) return; showTab(tabId); window.trafficLight.switchTab(tabId); });
  btn.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.closeTab(tabId); });
  $tabs.appendChild(btn);
  showTab(tabId);
  // Output that arrived before term-tab-added: the xterm now exists → write it.
  const arr = pendingOut.get(tabId);
  if (arr) { pendingOut.delete(tabId); const t = terms.get(tabId); if (t) for (const d of arr) t.term.write(d); }
}
window.trafficLight.onPtyOut(({ tabId, data }) => {
  const t = terms.get(tabId);
  if (!t) {                                       // term not yet created (main holds the tab-added) → buffer
    const a = pendingOut.get(tabId) || []; a.push(data); pendingOut.set(tabId, a);
    return;
  }
  t.term.write(data);
});
window.trafficLight.onPtyExit(({ tabId }) => {
  const t = terms.get(tabId);
  if (t) t.term.write('\r\n\x1b[90m[processo encerrou]\x1b[0m');
});
window.trafficLight.onTermTabAdded(({ tabId, title }) => doTermTabAdded(tabId, title));
window.trafficLight.onTermTabRemoved(({ tabId }) => {
  const t = terms.get(tabId);
  if (t) { try { t.term.dispose(); } catch {} }
  terms.delete(tabId);
  pendingOut.delete(tabId);   // late output from a removed session does not recreate an orphan buffer
  for (const b of $tabs.querySelectorAll('.tab[data-tab="' + tabId + '"]')) b.remove();
  if (activeTabId === tabId) {
    const next = terms.keys().next();
    activeTabId = next.done ? null : next.value;
    if (activeTabId != null) showTab(activeTabId);
  }
});
window.trafficLight.onTermTabActivated(({ tabId }) => showTab(tabId));
window.trafficLight.onTermTabTitle(({ tabId, title }) => {
  const el = $tabs.querySelector('.tab[data-tab="' + tabId + '"] .tab-title');
  if (el) el.textContent = title;
});

const $hostMenu = document.getElementById('hostMenu');
async function toggleHostMenu() {
  if (!$hostMenu.hidden) { $hostMenu.hidden = true; return; }
  let hosts = [];
  try { hosts = await window.trafficLight.termHosts(); } catch {}
  if (!hosts.length) hosts = [{ id: 'local', label: 'local' }];
  $hostMenu.innerHTML = '';
  for (const h of hosts) {
    const b = document.createElement('button');
    b.className = 'host-item';
    b.textContent = h.label;
    b.addEventListener('click', () => { $hostMenu.hidden = true; window.trafficLight.newShell(h.id); });
    $hostMenu.appendChild(b);
  }
  $hostMenu.hidden = false;
}
document.getElementById('newTabBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleHostMenu(); });
document.addEventListener('click', (e) => { if (!$hostMenu.hidden && !$hostMenu.contains(e.target)) $hostMenu.hidden = true; });
// ---- custom chrome (frameless): window buttons + maximized state ----
document.getElementById('winMinBtn').addEventListener('click', () => window.trafficLight.termWinControl('min'));
document.getElementById('winMaxBtn').addEventListener('click', () => window.trafficLight.termWinControl('max'));
document.getElementById('winCloseBtn').addEventListener('click', () => window.trafficLight.termWinControl('close'));
window.trafficLight.onTermMaximized((max) => document.getElementById('termApp').classList.toggle('maximized', !!max));
// Signal from main (window show/restore) — more reliable than visibilitychange,
// which does not always fire on hide/show of a BrowserWindow on Linux.
window.trafficLight.onTermShown(() => {
  // Reopening termWin (hide→show): the xterm canvas was discarded while the
  // window was hidden. Repaint on rAF and again ~260ms later — on X11
  // frameless+transparent the WM remap is asynchronous, and the 1st repaint
  // may run BEFORE the canvas re-attaches (the tab would reopen black). The
  // 2nd catches the window already stable.
  const t = terms.get(activeTabId);
  const once = () => { fitActive(); repaint(t); };
  requestAnimationFrame(once);
  setTimeout(() => requestAnimationFrame(once), 260);
});
// Connection (re)established (revive): re-fit + re-send the size for the right
// tab, otherwise the remote tmux draws at the stale size and content is mispositioned.
window.trafficLight.onTermRefit(({ tabId }) => {
  requestAnimationFrame(() => { refitTab(tabId); });
});

// resize: re-fit the active tab and notify main (pty/ws) of the new size
if (typeof ResizeObserver !== 'undefined') (new ResizeObserver(fitActive)).observe($area);
window.addEventListener('resize', fitActive);
// The window CAME BACK into view (× hides, ⧉ shows again; minimize/restore;
// workspace switch). The xterm canvas was discarded while it was hidden, but
// the buffer was not — without repainting, the tab reopens BLANK even with
// tmux alive on the other side. 'visibilitychange' covers BrowserWindow
// hide/show; 'focus' covers the WM restore.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestAnimationFrame(() => { fitActive(); repaint(terms.get(activeTabId)); });
});
window.addEventListener('focus', () => {
  requestAnimationFrame(() => repaint(terms.get(activeTabId)));
});
// ---- resize grip (bottom-right corner) — a frameless window has no native resize ----
const $grip = document.getElementById('termGrip');
let resizing = null;
if ($grip) {
  $grip.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); resizing = { sx: e.screenX, sy: e.screenY }; window.trafficLight.resizeStartTerm(); });
  window.addEventListener('mousemove', (e) => { if (!resizing) return; window.trafficLight.resizeMoveTerm(e.screenX - resizing.sx, e.screenY - resizing.sy); });
  window.addEventListener('mouseup', () => { resizing = null; });
}
