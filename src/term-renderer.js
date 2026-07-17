// term-renderer.js — UI da janela Terminal (src/term.html). Renderer "burro":
// só desenha abas + xterm; TODO o estado (pty/ws) vive no main (Map termSessions).
// Um xterm por aba; só o holder da aba ativa é visível. IPC por tabId.
const terms = new Map();       // tabId -> { term, fit, holder }
let activeTabId = null;
const $tabs = document.getElementById('tabs');
const $area = document.getElementById('termArea');

function ensureTerm(tabId) {
  if (terms.has(tabId)) return terms.get(tabId);
  // FitAddon UMD pode ser a classe direta ou {FitAddon} (CJS) — robusto aos 2.
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
  if (t) { try { t.fit.fit(); } catch {} t.term.focus(); }
}

function fitActive() {
  if (activeTabId == null) return;
  const t = terms.get(activeTabId);
  if (!t) return;
  try { t.fit.fit(); } catch {}
  try { window.trafficLight.ptyResize(activeTabId, t.term.cols, t.term.rows); } catch {}
}

// ---- eventos do main ----
window.trafficLight.onPtyOut(({ tabId, data }) => { const t = terms.get(tabId); if (t) t.term.write(data); });
window.trafficLight.onPtyExit(({ tabId }) => {
  const t = terms.get(tabId);
  if (t) t.term.write('\r\n\x1b[90m[processo encerrou]\x1b[0m');
});
window.trafficLight.onTermTabAdded(({ tabId, title }) => {
  ensureTerm(tabId);
  const btn = document.createElement('button');
  btn.className = 'tab';
  btn.dataset.tab = String(tabId);
  btn.innerHTML = '<span class="tab-title"></span><span class="tab-close" title="fechar">×</span>';
  btn.querySelector('.tab-title').textContent = title;
  btn.addEventListener('click', (e) => { if (e.target.classList.contains('tab-close')) return; window.trafficLight.switchTab(tabId); });
  btn.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.closeTab(tabId); });
  $tabs.appendChild(btn);
  showTab(tabId);
});
window.trafficLight.onTermTabRemoved(({ tabId }) => {
  const t = terms.get(tabId);
  if (t) { try { t.term.dispose(); } catch {} }
  terms.delete(tabId);
  for (const b of $tabs.querySelectorAll('.tab[data-tab="' + tabId + '"]')) b.remove();
  if (activeTabId === tabId) {
    const next = terms.keys().next();
    activeTabId = next.done ? null : next.value;
    if (activeTabId != null) showTab(activeTabId);
  }
});
window.trafficLight.onTermTabActivated(({ tabId }) => showTab(tabId));

document.getElementById('newTabBtn').addEventListener('click', () => window.trafficLight.newShell());

// resize: refaz fit da aba ativa e avisa o main (pty/ws) do novo tamanho
if (typeof ResizeObserver !== 'undefined') (new ResizeObserver(fitActive)).observe($area);
window.addEventListener('resize', fitActive);
