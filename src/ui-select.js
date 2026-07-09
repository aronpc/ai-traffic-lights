// ui-select.js — dropdown custom que "aprimora" um <select> nativo. O <select>
// continua no DOM (escondido) como FONTE DE VERDADE: escolher uma opção seta
// select.value e dispara 'change', então toda a lógica existente (listeners de
// change: pushLive, syncSoundFileField, syncTerminalCmdField…) segue funcionando
// sem alteração. O popup nativo do <select> não é estilizável (tema do SO); este
// componente desenha a lista no tema dark do app.
//
// A lista é INLINE (empurra o conteúdo), não absolute — o .tab-body rola
// (overflow-y:auto) e cortaria um dropdown absolute. Fecha ao escolher, ao
// clicar fora ou com Esc; navegável por teclado (setas/Enter/Esc).

// Fecha todos os dropdowns abertos (sem depender do closure de cada um).
function closeAllSelects() {
  for (const w of document.querySelectorAll('.sel.is-open')) {
    w.classList.remove('is-open');
    const l = w.querySelector('.sel__list'); if (l) l.hidden = true;
    const b = w.querySelector('.sel__btn'); if (b) b.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', closeAllSelects); // clique fora fecha qualquer aberto

// Re-sincroniza rótulo + item marcado de um custom select a partir do <select>
// real. Usar quando o value muda programaticamente (setar .value NÃO dispara
// 'change') — ex.: o load das Preferências popula os selects após o enhance.
function refreshSelect(sel) {
  const wrap = sel.closest && sel.closest('.sel'); if (!wrap) return;
  const label = wrap.querySelector('.sel__label');
  const o = sel.options[sel.selectedIndex];
  if (label) label.textContent = o ? o.textContent : '';
  for (const el of wrap.querySelectorAll('.sel__opt')) el.classList.toggle('is-sel', el.dataset.value === sel.value);
}
function refreshAllSelects(root) { (root || document).querySelectorAll('.sel select').forEach(refreshSelect); }

function enhanceSelect(sel) {
  if (!sel || sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';

  const wrap = document.createElement('div');
  wrap.className = 'sel';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel__btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'sel__label';
  btn.appendChild(label);
  const list = document.createElement('div');
  list.className = 'sel__list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  Array.from(sel.options).forEach((o, i) => {
    const item = document.createElement('div');
    item.className = 'sel__opt';
    item.setAttribute('role', 'option');
    item.textContent = o.textContent;
    item.dataset.value = o.value;
    item.addEventListener('click', (e) => { e.stopPropagation(); pick(i); setOpen(false); btn.focus(); });
    list.appendChild(item);
  });

  const sync = () => refreshSelect(sel);
  function pick(i) {
    if (i < 0 || i >= sel.options.length) return;
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('change', { bubbles: true })); // dispara a lógica existente
    }
    sync();
  }
  function setOpen(open) {
    list.hidden = !open;
    wrap.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = list.hidden;
    closeAllSelects();          // fecha outros dropdowns antes de abrir este
    setOpen(willOpen);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(Math.min(sel.selectedIndex + 1, sel.options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(sel.selectedIndex - 1, 0)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = list.hidden; closeAllSelects(); setOpen(o); }
    else if (e.key === 'Escape') setOpen(false);
  });
  sel.addEventListener('change', sync); // reflete mudanças externas (ex.: o load popula o value)

  sel.parentNode.insertBefore(wrap, sel);
  wrap.append(sel, btn, list); // o <select> fica dentro do wrapper (escondido via CSS)
  sync();
}

function enhanceAllSelects(root) {
  (root || document).querySelectorAll('select').forEach(enhanceSelect);
}

if (typeof module !== 'undefined') module.exports = { enhanceSelect, enhanceAllSelects, refreshSelect, refreshAllSelects, closeAllSelects };
