const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STRINGS, pickLang, translate, makeT } = require('../src/i18n.js');

test('pickLang: pt* vira pt, resto vira en', () => {
  assert.equal(pickLang('pt-BR'), 'pt');
  assert.equal(pickLang('pt-PT'), 'pt');
  assert.equal(pickLang('pt'), 'pt');
  assert.equal(pickLang('en-US'), 'en');
  assert.equal(pickLang('de'), 'en');
  assert.equal(pickLang(''), 'en');
  assert.equal(pickLang(null), 'en');
});

test('translate: resolve nos dois idiomas', () => {
  assert.equal(translate('pt', 'btn_close'), 'Fechar');
  assert.equal(translate('en', 'btn_close'), 'Close');
});

test('translate: interpola placeholders', () => {
  assert.equal(translate('pt', 'needs_you', { agent: 'Claude' }), 'Claude precisa de você');
  assert.equal(translate('en', 'ntf_installed', { a: 2, u: 1 }), 'installed (2+1)');
});

test('translate: chave ausente cai no en; ausente no en devolve a chave', () => {
  assert.equal(translate('xx', 'btn_close'), 'Close');      // unknown language → en
  assert.equal(translate('pt', 'nao_existe'), 'nao_existe'); // fail-soft
});

test('makeT: parcial por idioma', () => {
  const T = makeT('pt');
  assert.equal(T('tab_general'), 'Geral');
});

test('paridade de chaves: en e pt têm exatamente o mesmo conjunto', () => {
  assert.deepEqual(Object.keys(STRINGS.en).sort(), Object.keys(STRINGS.pt).sort());
});

// HTML ↔ i18n integration: every data-i18n (and data-i18n-tip) used by the
// i18n-ized windows must exist in STRINGS — without this, an HTML referencing
// a missing key shows the raw key name in the UI and nobody notices in CI.
// (term.html — embedded terminal — doesn't use the i18n system.)
const fs = require('node:fs');
const path = require('node:path');
for (const page of ['settings.html', 'index.html']) {
  test(`data-i18n de ${page} resolve em STRINGS`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', page), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-tip)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, 'nenhum data-i18n encontrado — regex quebrou?');
    const missing = keys.filter((k) => !(k in STRINGS.en) || !(k in STRINGS.pt));
    assert.deepEqual(missing, []);
  });
}
