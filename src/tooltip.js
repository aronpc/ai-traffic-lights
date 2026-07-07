// tooltip.js — tooltips customizados (bolha estilizada, animada) que substituem
// os `title` nativos do SO (feios, ~1s de delay, sem estilo). Um só elemento
// #tooltip é reposicionado sob o alvo — o overlay tem overflow:hidden, então a
// posição é SEMPRE dentro da janela (clamp na viewport), nunca vaza.
//
// Lógica de posição é PURA (tipPosition) → testável sem DOM. O wiring de eventos
// (setupTooltips) é a casca de I/O, com delegação: um único par de listeners no
// contêiner cobre todos os alvos [data-tip], inclusive os criados depois.

// Calcula a posição da bolha dado o retângulo do alvo, o tamanho da bolha e os
// limites da viewport. Preferência: ABAIXO do alvo; se não couber, ACIMA. A
// posição horizontal é centralizada no alvo e clampada nas bordas (com margem),
// e a seta aponta pro centro do alvo mesmo quando a bolha foi deslocada.
//
//   target: {left, right, top, bottom, width}   (getBoundingClientRect)
//   tip:    {width, height}
//   vp:     {width, height}
//   opts:   {gap=8, margin=6}
// → {left, top, place:'bottom'|'top', arrowX}   (px relativos à viewport)
function tipPosition(target, tip, vp, opts = {}) {
  const gap = opts.gap != null ? opts.gap : 8;
  const margin = opts.margin != null ? opts.margin : 6;

  // vertical: cabe abaixo? senão acima. (se não couber em nenhum, fica abaixo
  // clampado — melhor cortar de leve que sumir.)
  const belowTop = target.bottom + gap;
  const fitsBelow = belowTop + tip.height + margin <= vp.height;
  const place = fitsBelow ? 'bottom' : 'top';
  let top = place === 'bottom' ? belowTop : target.top - gap - tip.height;
  top = clamp(top, margin, Math.max(margin, vp.height - tip.height - margin));

  // horizontal: centraliza no alvo, clampa nas bordas.
  const targetCenter = target.left + target.width / 2;
  let left = targetCenter - tip.width / 2;
  left = clamp(left, margin, Math.max(margin, vp.width - tip.width - margin));

  // seta: aponta pro centro do alvo, relativa à bolha; clampada pra não sair
  // das quinas arredondadas da bolha.
  let arrowX = targetCenter - left;
  arrowX = clamp(arrowX, 12, Math.max(12, tip.width - 12));

  return { left: Math.round(left), top: Math.round(top), place, arrowX: Math.round(arrowX) };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Instala a máquina de tooltip. `root` é o contêiner (delegação de eventos),
// `tipEl` é a bolha única (div#tooltip). Alvos são [data-tip] com texto no
// atributo. Retorna um handle { destroy } — útil em testes.
//
// Comportamento: hover/focus com data-tip → após `delay`ms mostra a bolha
// posicionada; mouseleave/blur/click/scroll → esconde na hora. Um só timer.
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
    // mede fora de tela: torna visível pra pegar dimensões, depois posiciona.
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
    // sobe até um elemento com data-tip (ícone SVG dentro do botão, etc.)
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
    // saiu do alvo (e não entrou num filho dele): esconde
    const to = e.relatedTarget;
    if (to && el.contains(to)) return;
    hide();
  }
  const onFocus = (e) => { const el = targetFrom(e.target); if (el) show(el); };
  const onBlur = () => hide();
  const onDown = () => hide();     // clicar age no botão → tooltip some
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
