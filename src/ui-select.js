// ui-select.js — custom dropdown that "enhances" a native <select>. The
// <select> stays in the DOM (hidden) as the SOURCE OF TRUTH: picking an option
// sets select.value and fires 'change', so all existing logic (change
// listeners: pushLive, syncSoundFileField, syncTerminalCmdField…) keeps working
// unchanged. The native <select> popup is not stylable (OS theme); this
// component draws the list in the app's dark theme.
//
// The list is INLINE (pushes the content), not absolute — .tab-body scrolls
// (overflow-y:auto) and would clip an absolute dropdown. Closes on pick, on
// outside click or with Esc; keyboard-navigable (arrows/Enter/Esc).

// Closes all open dropdowns (without depending on each one's closure).
function closeAllSelects() {
  for (const w of document.querySelectorAll('.sel.is-open')) {
    w.classList.remove('is-open');
    const l = w.querySelector('.sel__list'); if (l) l.hidden = true;
    const b = w.querySelector('.sel__btn'); if (b) b.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', closeAllSelects); // outside click closes any open one

// Re-syncs the label + marked item of a custom select from the real
// <select>. Use when the value changes programmatically (setting .value does
// NOT fire 'change') — e.g. the Preferences load populates selects after the enhance.
function refreshSelect(sel) {
  const wrap = sel.closest && sel.closest('.sel'); if (!wrap) return;
  const label = wrap.querySelector('.sel__label');
  const o = sel.options[sel.selectedIndex];
  if (label) label.textContent = o ? o.textContent : '';
  for (const el of wrap.querySelectorAll('.sel__opt')) el.classList.toggle('is-sel', el.dataset.value === sel.value);
}
function refreshAllSelects(root) { (root || document).querySelectorAll('.sel select').forEach(refreshSelect); }

// Re-copies the <option> texts to the custom options. Needed after i18n
// swaps the <option>s: the enhance captures the labels BEFORE applyI18n runs
// (it is synchronous, at top level; applyI18n comes from async getLang), so
// without this the dropdown would show labels in the HTML default language (pt), not the translated one.
function relabelSelect(sel) {
  const wrap = sel.closest && sel.closest('.sel'); if (!wrap) return;
  const opts = wrap.querySelectorAll('.sel__opt');
  Array.from(sel.options).forEach((o, i) => { if (opts[i]) opts[i].textContent = o.textContent; });
  refreshSelect(sel); // updates the button label from the selected option
}
function relabelAllSelects(root) { (root || document).querySelectorAll('.sel select').forEach(relabelSelect); }

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
      sel.dispatchEvent(new Event('change', { bubbles: true })); // fires the existing logic
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
    closeAllSelects();          // closes other dropdowns before opening this one
    setOpen(willOpen);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pick(Math.min(sel.selectedIndex + 1, sel.options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(sel.selectedIndex - 1, 0)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = list.hidden; closeAllSelects(); setOpen(o); }
    else if (e.key === 'Escape') setOpen(false);
  });
  sel.addEventListener('change', sync); // reflects external changes (e.g. the load populates the value)

  sel.parentNode.insertBefore(wrap, sel);
  wrap.append(sel, btn, list); // the <select> stays inside the wrapper (hidden via CSS)
  sync();
}

function enhanceAllSelects(root) {
  (root || document).querySelectorAll('select').forEach(enhanceSelect);
}

if (typeof module !== 'undefined') module.exports = { enhanceSelect, enhanceAllSelects, refreshSelect, refreshAllSelects, relabelSelect, relabelAllSelects, closeAllSelects };
