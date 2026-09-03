// .dmg selection in the macOS updater (finding 03 of the PR #46 review).
// Installing the wrong architecture's bundle won't open — an Intel Mac can't
// run an arm64 .app and vice-versa — so the selection must be explicit and tested.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickMacDmg, decidirIntegridade, releaseSemSidecar, fluxoUpdateMac } = require('../src/ipc/update.js');

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
  // this was the risk of a `|| dmgs[0]`: it would install a bundle that doesn't open.
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

// ---- auto-update integrity (finding 03 + sidecar reviews) ----
// This is the ONLY check before a script replaces the entire .app with nobody
// watching: there is no electron-updater on this path and the macOS build no
// longer emits latest-mac.yml. The fetch returns {estado, corpo} because
// distinguishing "doesn't exist" from "couldn't fetch" is what prevents
// installing without verification.
const HASH = 'A'.repeat(86) + '==';
const achou = (corpo) => ({ estado: 'ok', corpo });

test('decidirIntegridade: hash confere → ok', () => {
  assert.equal(decidirIntegridade(achou(HASH), HASH), 'ok');
});

test('decidirIntegridade: hash diverge → recusa', () => {
  assert.equal(decidirIntegridade(achou(HASH), 'B'.repeat(86) + '=='), 'divergente');
});

test('decidirIntegridade: 404 só é aceito para release explicitamente legada', () => {
  const ausente = { estado: 'ausente', corpo: '' };
  assert.equal(decidirIntegridade(ausente, null, true), 'sem-sidecar');
  assert.equal(decidirIntegridade(ausente, null, false), 'indisponivel');
  assert.equal(decidirIntegridade(ausente, null), 'indisponivel');
  assert.equal(releaseSemSidecar('0.7.3'), true);
  assert.equal(releaseSemSidecar('0.8.0-beta.3'), true);
  assert.equal(releaseSemSidecar('0.8.0-beta.4'), false);
  assert.equal(releaseSemSidecar('0.9.0'), false);
  assert.equal(releaseSemSidecar(null), false);
});

test('decidirIntegridade: falha de rede NÃO vira "sem sidecar"', () => {
  // the point of the finding: timeout/TLS/5xx treated as absence would install
  // with no verification at all.
  assert.equal(decidirIntegridade({ estado: 'falha', corpo: '' }, null), 'indisponivel');
  assert.equal(decidirIntegridade(null, null), 'indisponivel');
  assert.equal(decidirIntegridade(undefined, null), 'indisponivel');
});

test('decidirIntegridade: 200 com corpo VAZIO não é ausência — reprova', () => {
  // a transparent proxy or CDN edge answering 200 with no content would turn
  // the whole check off if that passed as "no sidecar".
  assert.equal(decidirIntegridade(achou(''), HASH), 'malformado');
});

test('decidirIntegridade: corpo fora do formato → recusa (portal cativo, truncado)', () => {
  for (const lixo of ['truncado', '<html>502</html>', 'A'.repeat(87) + '==', HASH + 'x']) {
    assert.equal(decidirIntegridade(achou(lixo), HASH), 'malformado', `aceitou: ${lixo.slice(0, 20)}`);
  }
});

// ---- the FLOW, not just the unit (finding of the 4th review) ----
// The tests above passed with the macOS auto-update 100% broken: the
// pre-validation called decidirIntegridade(busca, null) and every valid sidecar
// became 'divergente', aborting before the download. Testing the isolated
// function doesn't catch this — the defect was in the COMPOSITION of the two steps.
//
// The tests below call the helper shared with the real baixarUpdateMac,
// injecting only download and hash to avoid depending on Electron/network.
const rodarFluxo = (busca, hashDoArquivoBaixado, releaseLegada = false) => fluxoUpdateMac({
  busca,
  releaseLegada,
  baixar: async () => {},
  obterHash: async () => hashDoArquivoBaixado,
});

test('fluxo: sidecar válido + arquivo íntegro → BAIXA e instala', async () => {
  const r = await rodarFluxo(achou(HASH), HASH);
  assert.equal(r.baixou, true, 'abortou antes do download com sidecar válido');
  assert.equal(r.veredito, 'ok');
});

test('fluxo: sidecar válido + arquivo adulterado → baixa e RECUSA', async () => {
  const r = await rodarFluxo(achou(HASH), 'B'.repeat(86) + '==');
  assert.equal(r.baixou, true);
  assert.equal(r.veredito, 'divergente');
});

test('fluxo: sidecar malformado NÃO chega a baixar 100 MB', async () => {
  const r = await rodarFluxo(achou('<html>502</html>'), HASH);
  assert.equal(r.baixou, false, 'baixou o dmg mesmo com sidecar malformado');
  assert.equal(r.veredito, 'malformado');
});

test('fluxo: falha de rede no sidecar NÃO chega a baixar', async () => {
  const r = await rodarFluxo({ estado: 'falha', corpo: '' }, HASH);
  assert.equal(r.baixou, false);
  assert.equal(r.veredito, 'indisponivel');
});

test('fluxo: release antiga sem sidecar baixa e instala sem comparar', async () => {
  const r = await rodarFluxo({ estado: 'ausente', corpo: '' }, HASH, true);
  assert.equal(r.baixou, true);
  assert.equal(r.veredito, 'sem-sidecar');
});

test('fluxo: release atual sem sidecar não baixa', async () => {
  const r = await rodarFluxo({ estado: 'ausente', corpo: '' }, HASH, false);
  assert.equal(r.baixou, false);
  assert.equal(r.veredito, 'indisponivel');
});

test('fluxo: nenhum veredito "pendente" escapa para a instalação', async () => {
  // 'pendente' reaching the end would mean the hash was never compared. The
  // baixarUpdateMac guard fails closed; this test ensures it stays that way.
  for (const caso of [achou(HASH), achou(''), { estado: 'falha', corpo: '' }, { estado: 'ausente', corpo: '' }]) {
    assert.notEqual((await rodarFluxo(caso, HASH)).veredito, 'pendente');
  }
});
