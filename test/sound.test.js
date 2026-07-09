// Testes dos PARÂMETROS de som (src/sound.js) — parte pura/testável em node.
// O playback (playPreset/playBuffer) usa Web Audio e não é exercitado aqui.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SOUND_PRESETS, SOUND_TYPES, clampVolume } = require('../src/sound');

test('SOUND_TYPES = presets + custom (nesta ordem, custom por último)', () => {
  assert.ok(SOUND_TYPES.includes('beep'));
  assert.ok(SOUND_TYPES.includes('custom'));
  for (const k of Object.keys(SOUND_PRESETS)) assert.ok(SOUND_TYPES.includes(k), `${k} ausente em SOUND_TYPES`);
  assert.equal(SOUND_TYPES[SOUND_TYPES.length - 1], 'custom');
});

test('cada preset tem wave válida e tons com f>0, d>0, t>=0', () => {
  const WAVES = new Set(['sine', 'square', 'triangle', 'sawtooth']);
  for (const [name, p] of Object.entries(SOUND_PRESETS)) {
    assert.ok(WAVES.has(p.wave), `${name}: wave inválida (${p.wave})`);
    assert.ok(Array.isArray(p.tones) && p.tones.length >= 1, `${name}: sem tons`);
    for (const tone of p.tones) {
      assert.ok(tone.f > 0 && tone.d > 0 && tone.t >= 0, `${name}: tom inválido ${JSON.stringify(tone)}`);
    }
  }
});

test('clampVolume: faixa [0,1] com fallback 0.18 para não-número', () => {
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(1), 1);
  assert.equal(clampVolume(-1), 0);   // abaixo → clampa
  assert.equal(clampVolume(2), 1);    // acima → clampa
  assert.equal(clampVolume('x'), 0.18);
  assert.equal(clampVolume(NaN), 0.18);
  assert.equal(clampVolume(undefined), 0.18);
});
