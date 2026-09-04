// tooltip.js — custom tooltips (styled, animated bubble) that replace the
// OS-native `title` (ugly, ~1s delay, unstyled). A single #tooltip element
// is repositioned under the target — the overlay has overflow:hidden, so the
// position is ALWAYS inside the window (clamped to the viewport), never leaks out.
//
// Position logic is PURE (tipPosition) → testable without a DOM. Event wiring
// (setupTooltips) is the I/O shell, with delegation: a single pair of listeners
// on the container covers all [data-tip] targets, including ones created later.

// Computes the bubble position given the target rect, bubble size and
// viewport bounds. Preference: BELOW the target; if it does not fit, ABOVE.
// The horizontal position is centered on the target and clamped at the edges
// (with margin), and the arrow points at the target's center even when the
// bubble has been shifted.
//
//   target: {left, right, top, bottom, width}   (getBoundingClientRect)
//   tip:    {width, height}
//   vp:     {width, height}
//   opts:   {gap=8, margin=6}
// → {left, top, place:'bottom'|'top', arrowX}   (px relative to the viewport)
function tipPosition(target, tip, vp, opts = {}) {
  const gap = opts.gap != null ? opts.gap : 8;
  const margin = opts.margin != null ? opts.margin : 6;

  // vertical: does it fit below? otherwise above. (if it fits nowhere, stays
  // below clamped — better to clip slightly than to disappear.)
  const belowTop = target.bottom + gap;
  const fitsBelow = belowTop + tip.height + margin <= vp.height;
  const place = fitsBelow ? 'bottom' : 'top';
  let top = place === 'bottom' ? belowTop : target.top - gap - tip.height;
  top = clamp(top, margin, Math.max(margin, vp.height - tip.height - margin));

  // horizontal: centers on the target, clamps at the edges.
  const targetCenter = target.left + target.width / 2;
  let left = targetCenter - tip.width / 2;
  left = clamp(left, margin, Math.max(margin, vp.width - tip.width - margin));

  // arrow: points at the target's center, relative to the bubble; clamped so
  // it does not leave the bubble's rounded corners.
  let arrowX = targetCenter - left;
  arrowX = clamp(arrowX, 12, Math.max(12, tip.width - 12));

  return { left: Math.round(left), top: Math.round(top), place, arrowX: Math.round(arrowX) };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Installs the tooltip machine. `root` is the container (event delegation),
// `tipEl` is the single bubble (div#tooltip). Targets are [data-tip] with
// text in the attribute. Returns a { destroy } handle — useful in tests.
//
// Behavior: hover/focus with data-tip → after `delay`ms shows the positioned
// bubble; mouseleave/blur/click/scroll → hides immediately. A single timer.
function setupTooltips(root, tipEl, opts = {}) {
  if (!root || !tipEl) return { destroy() {} };
  const delay = opts.delay != null ? opts.delay : 400;
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || window;
  let timer = null;
  let current = null;

  const arrow = tipEl.querySelector('.tt__arrow');
  const label = tipEl.querySelector('.tt__label') || tipEl;

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    current = null;
    tipEl.classList.remove('is-shown');
  }

  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    current = el;
    label.textContent = text;
    // measures off-screen: makes it visible to grab dimensions, then positions.
    tipEl.classList.add('is-measuring');
    const tRect = el.getBoundingClientRect();
    const tip = { width: tipEl.offsetWidth, height: tipEl.offsetHeight };
    const vp = { width: win.innerWidth, height: win.innerHeight };
    const p = tipPosition(tRect, tip, vp, opts);
    tipEl.style.left = p.left + 'px';
    tipEl.style.top = p.top + 'px';
    tipEl.dataset.place = p.place;
    if (arrow) arrow.style.left = p.arrowX + 'px';
    tipEl.classList.remove('is-measuring');
    tipEl.classList.add('is-shown');
  }

  function targetFrom(node) {
    // walks up to an element with data-tip (SVG icon inside a button, etc.)
    while (node && node !== root) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-tip')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onOver(e) {
    const el = targetFrom(e.target);
    if (!el || el === current) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => show(el), delay);
  }
  function onOut(e) {
    const el = targetFrom(e.target);
    if (!el) return;
    // left the target (and did not enter one of its children): hide
    const to = e.relatedTarget;
    if (to && el.contains(to)) return;
    hide();
  }
  const onFocus = (e) => { const el = targetFrom(e.target); if (el) show(el); };
  const onBlur = () => hide();
  const onDown = () => hide();     // clicking acts on the button → tooltip goes away
  const onScroll = () => hide();

  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', onBlur);
  root.addEventListener('mousedown', onDown);
  win.addEventListener('scroll', onScroll, true);

  return {
    destroy() {
      hide();
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onBlur);
      root.removeEventListener('mousedown', onDown);
      win.removeEventListener('scroll', onScroll, true);
    },
  };
}

if (typeof module !== 'undefined') module.exports = { tipPosition, setupTooltips, clamp };
