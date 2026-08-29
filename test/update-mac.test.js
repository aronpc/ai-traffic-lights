// Escolha do .dmg no updater do macOS (achado 03 do review da PR #46).
// Instalar o bundle da arquitetura errada não abre — um Mac Intel não roda um
// .app arm64 e vice-versa —, então a seleção precisa ser explícita e testada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickMacDmg } = require('../src/ipc/update.js');

const dmg = (name) => ({ name, browser_download_url: `https://x/${name}` });

test('pickMacDmg: escolhe o .dmg da arquitetura em uso', () => {
  const assets = [dmg('atl-0.9.0-arm64.dmg'), dmg('atl-0.9.0-x64.dmg')];
  assert.equal(pickMacDmg(assets, 'arm64').name, 'atl-0.9.0-arm64.dmg');
  assert.equal(pickMacDmg(assets, 'x64').name, 'atl-0.9.0-x64.dmg');
});

test('pickMacDmg: arquitetura desconhecida cai em x64, não em arm64', () => {
  const assets = [dmg('atl-arm64.dmg'), dmg('atl-x64.dmg')];
  assert.equal(pickMacDmg(assets, 'ia32').name, 'atl-x64.dmg');
});

test('pickMacDmg: sem o exato, usa o .dmg sem marca de arquitetura (universal)', () => {
  const assets = [dmg('atl-0.9.0.dmg'), dmg('atl-0.9.0-arm64.dmg')];
  assert.equal(pickMacDmg(assets, 'x64').name, 'atl-0.9.0.dmg');
});

test('pickMacDmg: NÃO devolve o .dmg de outra arquitetura como consolo', () => {
  // era o risco de um `|| dmgs[0]`: instalaria um bundle que não abre.
  assert.equal(pickMacDmg([dmg('atl-arm64.dmg')], 'x64'), null);
});

test('pickMacDmg: ignora assets que não são .dmg', () => {
  const assets = [dmg('atl.AppImage'), { name: 'latest-mac.yml' }, dmg('atl-x64.dmg')];
  assert.equal(pickMacDmg(assets, 'x64').name, 'atl-x64.dmg');
  assert.equal(pickMacDmg([dmg('atl.AppImage'), { name: 'x.zip' }], 'x64'), null);
});

test('pickMacDmg: entrada degenerada → null, nunca lança', () => {
  for (const e of [null, undefined, [], 'lixo', [null, {}, { name: 42 }]]) {
    assert.equal(pickMacDmg(e, 'arm64'), null);
  }
});
