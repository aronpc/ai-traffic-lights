// Tests for the pure tooltip positioning logic (src/tooltip.js).
// No DOM: geometry only (target rect, bubble size, viewport).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tipPosition, clamp } = require('../src/tooltip.js');

// typical overlay viewport (width ~360, variable height).
const VP = { width: 360, height: 200 };
const TIP = { width: 120, height: 26 };

test('clamp: limita nos extremos', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
});

test('tipPosition: botão no header → bolha ABAIXO, centralizada', () => {
  // 28×28 button at the top, x ~200
  const target = { left: 200, right: 228, top: 15, bottom: 43, width: 28 };
  const p = tipPosition(target, TIP, VP, { gap: 8 });
  assert.equal(p.place, 'bottom');
  assert.equal(p.top, 51);                 // bottom(43) + gap(8)
  // centered: target center (214) - half the bubble (60) = 154
  assert.equal(p.left, 154);
  // arrow points at the target center, relative to the bubble: 214 - 154 = 60
  assert.equal(p.arrowX, 60);
});

test('tipPosition: sem espaço abaixo → vira pra CIMA', () => {
  // target near the bottom of the viewport (grip in the bottom corner)
  const target = { left: 330, right: 350, top: 180, bottom: 196, width: 20 };
  const p = tipPosition(target, TIP, VP, { gap: 8 });
  assert.equal(p.place, 'top');
  // top = target.top(180) - gap(8) - tip.height(26) = 146
  assert.equal(p.top, 146);
});

test('tipPosition: alvo na borda direita → bolha clampada, seta reaponta', () => {
  // close button in the right corner (x ~345)
  const target = { left: 340, right: 356, top: 15, bottom: 43, width: 16 };
  const p = tipPosition(target, TIP, VP, { gap: 8, margin: 6 });
  // target center = 348; the centered bubble would go to 288, but clamps at
  // vp.width(360) - tip.width(120) - margin(6) = 234
  assert.equal(p.left, 234);
  // arrow still points at the target center: 348 - 234 = 114, clamped at tip-12=108
  assert.equal(p.arrowX, 108);
});

test('tipPosition: alvo na borda esquerda → left respeita a margem', () => {
  const target = { left: 4, right: 24, top: 15, bottom: 43, width: 20 };
  const p = tipPosition(target, TIP, VP, { margin: 6 });
  assert.equal(p.left, 6);                 // does not go past the left margin
  // target center = 14; arrowX = 14 - 6 = 8 → clamps at the minimum 12
  assert.equal(p.arrowX, 12);
});

test('tipPosition: arrowX nunca sai das quinas (clamp 12 .. width-12)', () => {
  const target = { left: 0, right: 8, top: 15, bottom: 43, width: 8 };
  const p = tipPosition(target, TIP, VP, {});
  assert.ok(p.arrowX >= 12 && p.arrowX <= TIP.width - 12);
});
