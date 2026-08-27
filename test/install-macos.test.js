// Teste de integração do install_macos.sh: roda o script REAL num sandbox com
// stubs de PATH (uname/curl/jq/npm + ferramentas do macOS), provando o contrato
// que o instalador tem com o usuário — sobretudo que ele NÃO declara sucesso
// quando não instalou nada.
//
// Regressão que originou o arquivo: sem .dmg no release, o script apenas avisava
// e seguia — gravava aliases apontando para um app inexistente, imprimia
// "✓ Concluído!" e sugeria xattr/codesign num caminho que não existe. O usuário
// seguia as dicas e batia em "Unable to find application" / "No such file".
//
// Por que stubs de PATH e não mock de função: o script é consumido via
// `curl | bash`, então o que importa é o comportamento de ponta a ponta (exit
// code, o que foi escrito no perfil, o que foi impresso). Recortar pedaços dele
// testaria uma reescrita, não o artefato que o usuário executa.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'install_macos.sh');
const APP_NAME = 'AI Traffic Lights.app';

// Release COM .dmg e SEM .dmg — o grep do script procura literalmente
// "browser_download_url": "....dmg", então o JSON precisa ter essa forma.
const JSON_COM_DMG = '{"tag_name":"v9.9.9","assets":[{"browser_download_url":"https://example.invalid/AI-Traffic-Lights.dmg"}]}';
const JSON_SEM_DMG = '{"tag_name":"v0.7.3","assets":[{"browser_download_url":"https://example.invalid/ai-traffic-lights.AppImage"}]}';

function stub(dir, nome, corpo) {
  const p = path.join(dir, nome);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${corpo}\n`, { mode: 0o755 });
}

// Monta um sandbox isolado: bin/ com os stubs, home/ como $HOME falso e o cwd
// de onde o script será chamado (dentro ou fora de um checkout do repo).
function sandbox({ temDmg, dentroDoRepo }) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-install-test-'));
  const bin = path.join(raiz, 'bin');
  const home = path.join(raiz, 'home');
  const cwd = path.join(raiz, dentroDoRepo ? 'repo' : 'outro-lugar');
  for (const d of [bin, home, cwd]) fs.mkdirSync(d, { recursive: true });

  // O script só roda em Darwin e avisa fora de arm64.
  stub(bin, 'uname', 'case "${1:-}" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac');

  // curl tem 3 papéis no script; o stub decide pelo formato dos argumentos.
  stub(bin, 'curl', `
alvo=""; saida=""
for ((i=1; i<=$#; i++)); do
  a="\${!i}"
  if [ "$a" = "-o" ]; then j=$((i+1)); saida="\${!j}"; fi
  case "$a" in http*) alvo="$a" ;; esac
done
if [ -n "$saida" ]; then echo "dmg-falso" > "$saida"; exit 0; fi        # download do .dmg
case "$alvo" in
  *api.github.com*) printf '%s' '${temDmg ? JSON_COM_DMG : JSON_SEM_DMG}'; exit 0 ;;
  *latest-mac.yml) exit 22 ;;   # sem yml → verify_checksum avisa e segue (best-effort)
esac
exit 22`);

  // jq presente encerra o ensure_jq no primeiro ramo (sem depender de brew).
  stub(bin, 'jq', 'echo jq-1.7');
  // Modo dev roda `npm install` — no-op para o teste ser hermético e rápido.
  stub(bin, 'npm', 'exit 0');

  // Ferramentas do macOS exercitadas só no caminho com .dmg.
  stub(bin, 'hdiutil', `
if [ "\${1:-}" = "attach" ]; then
  mp=""; for ((i=1; i<=$#; i++)); do [ "\${!i}" = "-mountpoint" ] && { j=$((i+1)); mp="\${!j}"; }; done
  mkdir -p "$mp/${APP_NAME}/Contents/MacOS" && : > "$mp/${APP_NAME}/Contents/MacOS/AI Traffic Lights"
fi
exit 0`);
  // /Applications exige admin no Mac de um usuário comum: o stub recusa esse
  // destino de propósito, exercitando o fallback documentado para ~/Applications
  // (e evitando que a suíte escreva em /Applications da máquina que roda o teste).
  stub(bin, 'ditto', 'case "$2" in /Applications/*) exit 1 ;; esac; cp -R "$1" "$2"');
  stub(bin, 'xattr', 'exit 0');
  stub(bin, 'codesign', 'exit 0');
  stub(bin, 'lipo', 'echo arm64');

  if (dentroDoRepo) {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{\n  "name": "ai-traffic-lights"\n}\n');
  }
  return { raiz, bin, home, cwd };
}

function rodar(opts) {
  const sb = sandbox(opts);
  const r = spawnSync('bash', [SCRIPT], {
    cwd: sb.cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: sb.home, PATH: `${sb.bin}:${process.env.PATH}` },
  });
  const zshrc = path.join(sb.home, '.zshrc');
  return {
    status: r.status,
    saida: `${r.stdout || ''}${r.stderr || ''}`,
    perfil: fs.existsSync(zshrc) ? fs.readFileSync(zshrc, 'utf8') : '',
    limpar: () => fs.rmSync(sb.raiz, { recursive: true, force: true }),
  };
}

// --- o bug reportado: curl|bash num release sem build de macOS ---
test('sem .dmg e fora do repo: aborta em vez de declarar sucesso', () => {
  const r = rodar({ temDmg: false, dentroDoRepo: false });
  try {
    assert.notEqual(r.status, 0, 'deve sair com erro — nada foi instalado');
    assert.match(r.saida, /não publica \.dmg/, 'deve dizer por que abortou');
    assert.doesNotMatch(r.saida, /Concluído/, 'não pode declarar "Concluído" sem instalar');
    // O que o usuário do report seguiu e quebrou: as dicas apontavam para um
    // /Applications/... inexistente.
    assert.doesNotMatch(r.saida, /xattr -dr com\.apple\.quarantine/, 'não pode sugerir xattr sem app no disco');
    assert.equal(r.perfil, '', 'não pode gravar alias apontando para um app inexistente');
  } finally { r.limpar(); }
});

// --- modo dev: sem .dmg ainda há plano B, o alias cai para `npx electron .` ---
test('sem .dmg mas dentro do repo: segue em modo dev e escreve o alias', () => {
  const r = rodar({ temDmg: false, dentroDoRepo: true });
  try {
    assert.equal(r.status, 0, 'dentro do repo o app roda pelo fonte — não deve abortar');
    assert.match(r.saida, /modo desenvolvimento/);
    assert.match(r.perfil, /alias atl=/, 'o alias é o entregável do modo dev');
    assert.match(r.perfil, /npx electron \./, 'sem .app instalado o alias precisa cair no fonte');
    assert.doesNotMatch(r.saida, /xattr -dr com\.apple\.quarantine/, 'sem app no disco, sem dicas de Gatekeeper');
  } finally { r.limpar(); }
});

// --- o outro lado do booleano: instalou de verdade → as dicas DEVEM aparecer ---
test('com .dmg: instala, e aí sim imprime as dicas de Gatekeeper', () => {
  const r = rodar({ temDmg: true, dentroDoRepo: false });
  try {
    assert.equal(r.status, 0);
    assert.match(r.saida, /app copiado para/, 'deve reportar onde instalou');
    assert.match(r.saida, /Concluído/);
    assert.match(r.saida, /xattr -dr com\.apple\.quarantine/, 'com app no disco as dicas são úteis');
    assert.match(r.perfil, /alias atl=/);
    assert.match(r.perfil, /open -a/, 'com o app instalado o alias abre o bundle');
  } finally { r.limpar(); }
});
