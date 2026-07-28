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
  if (t) {
    if (areaVisible()) { try { t.fit.fit(); } catch {} }
    t.term.focus();
    // 2º fit após o paint: o holder acabou de ficar visível, o layout final só
    // vem depois do frame; refaz fit + repassa o tamanho ao pty/tmux (senão o
    // tmux ficava com o tamanho antigo e não preenchia a janela). Só quando há
    // área de verdade — com a janela oculta o fit colapsaria pra 2x1.
    requestAnimationFrame(() => {
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

// Guarda contra fit/resize com o layout zerado (janela oculta/minimizada): o
// FitAddon clampa no MÍNIMO (2 cols x 1 row) e mandaríamos esse tamanho pro
// tmux. Medido: esconder a termWin nem sempre zera o layout, mas minimizar e
// trocar de workspace zeram — então a checagem fica.
function areaVisible() {
  const r = $area.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

// Força o xterm a REDESENHAR o que já está no buffer. Esconder e reabrir a
// janela (termWin.hide()/show()) descarta as texturas do canvas do xterm, mas
// NÃO o buffer — medido: as linhas continuam todas lá, a tela é que fica em
// branco. Sem nada que invalide o render, o xterm não repinta sozinho: ele só
// desenha o que MUDA, e nada mudou. refresh() marca todas as linhas como sujas.
function repaint(t) {
  if (!t) return;
  // clearTextureAtlas() ANTES do refresh: o refresh sozinho remarca as linhas
  // como sujas, mas o renderer redesenha usando o ATLAS DE GLIFOS em cache —
  // e é ele que se corrompe quando a janela é ocultada/reexibida (o próprio
  // xterm documenta esse método como workaround pra textura corrompida, ex.
  // Chromium/Nvidia ao retomar da suspensão). Sem limpar o atlas o texto volta
  // "apagado"/fantasma em vez de nítido. Descartar o atlas força o redesenho
  // de cada glifo do zero.
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

// Re-fit uma aba específica e re-envia o tamanho ao pty/ws. Usado quando a
// CONEXÃO (re)estabelece (revive): o `start` foi mandado com o tamanho que
// estava em s.cols/s.rows, que pode estar defasado do xterm atual — o tmux
// remoto então desenhava no tamanho errado e o conteúdo vinha "mal
// posicionado". Re-fit pega o tamanho real da janela e re-envia.
function refitTab(tabId) {
  const t = terms.get(tabId);
  if (!t) return;
  // garante que o holder dessa aba está visível antes de medir
  if (t.holder.hidden) { for (const [id, x] of terms) x.holder.hidden = (id !== tabId); }
  if (!areaVisible()) return;
  try { t.fit.fit(); } catch {}
  if (t.term.cols > 2 && t.term.rows > 1) {
    try { window.trafficLight.ptyResize(tabId, t.term.cols, t.term.rows); } catch {}
  }
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
  btn.addEventListener('click', (e) => { if (e.target.classList.contains('tab-close')) return; showTab(tabId); window.trafficLight.switchTab(tabId); });
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
// ---- chrome custom (frameless): botões de janela + estado maximizado ----
document.getElementById('winMinBtn').addEventListener('click', () => window.trafficLight.termWinControl('min'));
document.getElementById('winMaxBtn').addEventListener('click', () => window.trafficLight.termWinControl('max'));
document.getElementById('winCloseBtn').addEventListener('click', () => window.trafficLight.termWinControl('close'));
window.trafficLight.onTermMaximized((max) => document.getElementById('termApp').classList.toggle('maximized', !!max));
// Sinal do main (show/restore da janela) — mais confiável que visibilitychange,
// que nem sempre dispara no hide/show de uma BrowserWindow no Linux.
window.trafficLight.onTermShown(() => {
  requestAnimationFrame(() => { fitActive(); repaint(terms.get(activeTabId)); });
});
// Conexão (re)estabelecida (revive): re-fit + re-envia o tamanho p/ a aba certa,
// senão o tmux remoto desenha no tamanho defasado e o conteúdo fica mal posicionado.
window.trafficLight.onTermRefit(({ tabId }) => {
  requestAnimationFrame(() => { refitTab(tabId); });
});

// resize: refaz fit da aba ativa e avisa o main (pty/ws) do novo tamanho
if (typeof ResizeObserver !== 'undefined') (new ResizeObserver(fitActive)).observe($area);
window.addEventListener('resize', fitActive);
// A janela VOLTOU a aparecer (× esconde, ⧉ mostra de novo; minimizar/restaurar;
// troca de workspace). O canvas do xterm foi descartado enquanto ela estava
// oculta, mas o buffer não — sem repintar, a aba reabre em BRANCO mesmo com o
// tmux vivo do outro lado. 'visibilitychange' cobre o hide/show da BrowserWindow;
// 'focus' cobre o restore do WM.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestAnimationFrame(() => { fitActive(); repaint(terms.get(activeTabId)); });
});
window.addEventListener('focus', () => {
  requestAnimationFrame(() => repaint(terms.get(activeTabId)));
});
// ---- grip de resize (canto inferior direito) — janela frameless não tem resize nativo ----
const $grip = document.getElementById('termGrip');
let resizing = null;
if ($grip) {
  $grip.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); resizing = { sx: e.screenX, sy: e.screenY }; window.trafficLight.resizeStartTerm(); });
  window.addEventListener('mousemove', (e) => { if (!resizing) return; window.trafficLight.resizeMoveTerm(e.screenX - resizing.sx, e.screenY - resizing.sy); });
  window.addEventListener('mouseup', () => { resizing = null; });
}
