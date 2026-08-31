// Escolha do .dmg no updater do macOS (achado 03 do review da PR #46).
// Instalar o bundle da arquitetura errada não abre — um Mac Intel não roda um
// .app arm64 e vice-versa —, então a seleção precisa ser explícita e testada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickMacDmg, decidirIntegridade, validarSidecar } = require('../src/ipc/update.js');

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

// ---- integridade do auto-update (achado 03 + reviews do sidecar) ----
// Este é o ÚNICO controle antes de um script substituir o .app inteiro, sem
// ninguém olhando: não há electron-updater neste caminho e o build do macOS não
// emite mais latest-mac.yml. A busca devolve {estado, corpo} porque distinguir
// "não existe" de "não deu pra buscar" é o que impede instalar sem verificação.
const HASH = 'A'.repeat(86) + '==';
const achou = (corpo) => ({ estado: 'ok', corpo });

test('decidirIntegridade: hash confere → ok', () => {
  assert.equal(decidirIntegridade(achou(HASH), HASH), 'ok');
});

test('decidirIntegridade: hash diverge → recusa', () => {
  assert.equal(decidirIntegridade(achou(HASH), 'B'.repeat(86) + '=='), 'divergente');
});

test('decidirIntegridade: 404 é release antiga sem sidecar, não erro', () => {
  // instala: mesma política dos instaladores de shell, senão nenhuma release
  // anterior ao sidecar conseguiria atualizar.
  assert.equal(decidirIntegridade({ estado: 'ausente', corpo: '' }, null), 'sem-sidecar');
});

test('decidirIntegridade: falha de rede NÃO vira "sem sidecar"', () => {
  // o ponto do achado: timeout/TLS/5xx tratados como ausência instalariam sem
  // verificação nenhuma.
  assert.equal(decidirIntegridade({ estado: 'falha', corpo: '' }, null), 'indisponivel');
  assert.equal(decidirIntegridade(null, null), 'indisponivel');
  assert.equal(decidirIntegridade(undefined, null), 'indisponivel');
});

test('decidirIntegridade: 200 com corpo VAZIO não é ausência — reprova', () => {
  // um proxy transparente ou borda de CDN respondendo 200 sem conteúdo
  // desligaria o controle inteiro se isso passasse por "sem sidecar".
  assert.equal(decidirIntegridade(achou(''), HASH), 'malformado');
});

test('decidirIntegridade: corpo fora do formato → recusa (portal cativo, truncado)', () => {
  for (const lixo of ['truncado', '<html>502</html>', 'A'.repeat(87) + '==', HASH + 'x']) {
    assert.equal(decidirIntegridade(achou(lixo), HASH), 'malformado', `aceitou: ${lixo.slice(0, 20)}`);
  }
});

// ---- o FLUXO, não só a unidade (achado do 4º review) ----
// Os testes acima passavam com o auto-update do macOS 100% quebrado: a
// pré-validação chamava decidirIntegridade(busca, null) e todo sidecar válido
// virava 'divergente', abortando antes do download. Testar a função isolada
// não pega isso — o defeito estava na COMPOSIÇÃO das duas etapas.
//
// Estes testes simulam o encadeamento de baixarUpdateMac sem Electron:
// validarSidecar (antes do download) → decidirIntegridade (depois).

// Réplica exata dos dois guards de baixarUpdateMac. Se eles mudarem lá e não
// aqui, o teste deixa de valer — por isso o nome cita a função e a linha.
function fluxoUpdateMac(busca, hashDoArquivoBaixado) {
  const pre = validarSidecar(busca);
  if (pre !== 'pendente' && pre !== 'sem-sidecar') return { baixou: false, veredito: pre };

  let veredito = pre;                       // download acontece aqui
  if (pre === 'pendente') veredito = decidirIntegridade(busca, hashDoArquivoBaixado);
  if (veredito === 'pendente') return { baixou: true, veredito: 'indisponivel' };
  return { baixou: true, veredito };
}

test('fluxo: sidecar válido + arquivo íntegro → BAIXA e instala', () => {
  const r = fluxoUpdateMac(achou(HASH), HASH);
  assert.equal(r.baixou, true, 'abortou antes do download com sidecar válido');
  assert.equal(r.veredito, 'ok');
});

test('fluxo: sidecar válido + arquivo adulterado → baixa e RECUSA', () => {
  const r = fluxoUpdateMac(achou(HASH), 'B'.repeat(86) + '==');
  assert.equal(r.baixou, true);
  assert.equal(r.veredito, 'divergente');
});

test('fluxo: sidecar malformado NÃO chega a baixar 100 MB', () => {
  const r = fluxoUpdateMac(achou('<html>502</html>'), HASH);
  assert.equal(r.baixou, false, 'baixou o dmg mesmo com sidecar malformado');
  assert.equal(r.veredito, 'malformado');
});

test('fluxo: falha de rede no sidecar NÃO chega a baixar', () => {
  const r = fluxoUpdateMac({ estado: 'falha', corpo: '' }, HASH);
  assert.equal(r.baixou, false);
  assert.equal(r.veredito, 'indisponivel');
});

test('fluxo: release antiga sem sidecar baixa e instala sem comparar', () => {
  const r = fluxoUpdateMac({ estado: 'ausente', corpo: '' }, HASH);
  assert.equal(r.baixou, true);
  assert.equal(r.veredito, 'sem-sidecar');
});

test('fluxo: nenhum veredito "pendente" escapa para a instalação', () => {
  // 'pendente' chegando ao fim significaria hash nunca comparado. O guard de
  // baixarUpdateMac falha fechado; este teste garante que continue assim.
  for (const caso of [achou(HASH), achou(''), { estado: 'falha', corpo: '' }, { estado: 'ausente', corpo: '' }]) {
    assert.notEqual(fluxoUpdateMac(caso, HASH).veredito, 'pendente');
  }
});
