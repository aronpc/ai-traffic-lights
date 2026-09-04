// Integration test for install_macos.sh: runs the REAL script in a sandbox
// with PATH stubs (uname/curl/jq/npm + macOS tools), proving the contract the
// installer has with the user — above all that it does NOT claim success when
// nothing was installed.
//
// Regression that originated this file: with no .dmg in the release, the
// script just warned and moved on — wrote aliases pointing to a nonexistent
// app, printed "✓ Concluído!" and suggested xattr/codesign on a path that
// doesn't exist. The user followed the tips and hit "Unable to find
// application" / "No such file".
//
// Why PATH stubs instead of function mocks: the script is consumed via
// `curl | bash`, so what matters is end-to-end behavior (exit code, what was
// written to the profile, what was printed). Cutting pieces out of it would
// test a rewrite, not the artifact the user runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// The curl stub writes exactly this content in place of the .dmg; the "valid"
// sidecar must be the sha512 OF IT, otherwise the happy path test would
// exercise the refusal instead of the installation.
const DMG_FALSO = 'dmg-falso\n';
const SHA512_DO_DMG = crypto.createHash('sha512').update(DMG_FALSO).digest('base64');

const SCRIPT = path.join(__dirname, '..', 'install_macos.sh');
const APP_NAME = 'AI Traffic Lights.app';

// Release WITH .dmg and WITHOUT .dmg — the script's grep looks literally for
// "browser_download_url": "....dmg", so the JSON must have this shape.
const JSON_COM_DMG = '{"tag_name":"v9.9.9","assets":[{"browser_download_url":"https://example.invalid/AI-Traffic-Lights.dmg"}]}';
const JSON_SEM_DMG = '{"tag_name":"v0.7.3","assets":[{"browser_download_url":"https://example.invalid/ai-traffic-lights.AppImage"}]}';

function stub(dir, nome, corpo) {
  const p = path.join(dir, nome);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${corpo}\n`, { mode: 0o755 });
}

// Builds an isolated sandbox: bin/ with the stubs, home/ as the fake $HOME,
// and the cwd from which the script will be called (inside or outside a repo
// checkout).
// sidecar: how the server answers <artifact>.sha512.
//   'valido'  200 + the real sha512 of the fake .dmg -> installs and VERIFIES
//   'lixo'    200 + body that isn't a sha512         -> aborts (proxy/captive portal)
//   'ausente' 404                                     -> old release, proceeds without verifying
//   'rede'    curl doesn't complete                   -> aborts (can't tell)
function sandbox({ temDmg, dentroDoRepo, sidecar = 'valido' }) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-install-test-'));
  const bin = path.join(raiz, 'bin');
  const home = path.join(raiz, 'home');
  const cwd = path.join(raiz, dentroDoRepo ? 'repo' : 'outro-lugar');
  for (const d of [bin, home, cwd]) fs.mkdirSync(d, { recursive: true });

  // The script only runs on Darwin and warns off arm64.
  stub(bin, 'uname', 'case "${1:-}" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac');

  // curl plays 3 roles in the script; the stub decides by argument format.
  // The stub picks the role by the shape of the arguments. The sidecar is
  // fetched with `-o <file> -w %{http_code}`: the BODY goes to the file and
  // the HTTP CODE to stdout. Emulating the two separately is what allows
  // distinguishing "404 = old release" from "200 with garbage = someone in the
  // middle" — exactly the decision the installer started making.
  stub(bin, 'curl', `
alvo=""; saida=""; quer_code=0
for ((i=1; i<=$#; i++)); do
  a="\${!i}"
  if [ "$a" = "-o" ]; then j=$((i+1)); saida="\${!j}"; fi
  if [ "$a" = "-w" ]; then quer_code=1; fi
  case "$a" in http*) alvo="$a" ;; esac
done

case "$alvo" in
  *.sha512)
    ${sidecar === 'rede' ? 'exit 7' : ''}
    ${sidecar === 'ausente'
      ? 'if [ -n "$saida" ]; then : > "$saida"; fi; [ "$quer_code" = 1 ] && printf 404; exit 0'
      : `if [ -n "$saida" ]; then printf '%s' '${sidecar === 'lixo' ? '<html>502 Bad Gateway</html>' : SHA512_DO_DMG}' > "$saida"; fi; [ "$quer_code" = 1 ] && printf 200; exit 0`}
    ;;
esac

if [ -n "$saida" ]; then printf '%s' '${DMG_FALSO}' > "$saida"; exit 0; fi   # download do .dmg
case "$alvo" in
  *api.github.com*) printf '%s' '${temDmg ? JSON_COM_DMG : JSON_SEM_DMG}'; exit 0 ;;
  *latest-mac.yml) exit 22 ;;   # sem yml → verify_checksum avisa e segue (best-effort)
esac
exit 22`);

  // jq present ends ensure_jq on the first branch (no brew dependency).
  stub(bin, 'jq', 'echo jq-1.7');
  // Dev mode runs `npm install` — no-op so the test stays hermetic and fast.
  stub(bin, 'npm', 'exit 0');

  // macOS tools exercised only on the .dmg path.
  stub(bin, 'hdiutil', `
if [ "\${1:-}" = "attach" ]; then
  mp=""; for ((i=1; i<=$#; i++)); do [ "\${!i}" = "-mountpoint" ] && { j=$((i+1)); mp="\${!j}"; }; done
  mkdir -p "$mp/${APP_NAME}/Contents/MacOS" && : > "$mp/${APP_NAME}/Contents/MacOS/AI Traffic Lights"
fi
exit 0`);
  // /Applications requires admin on a regular user's Mac: the stub refuses
  // that destination on purpose, exercising the documented fallback to
  // ~/Applications (and keeping the suite from writing to the test machine's
  // /Applications).
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

// --- the reported bug: curl|bash on a release with no macOS build ---
test('sem .dmg e fora do repo: aborta em vez de declarar sucesso', () => {
  const r = rodar({ temDmg: false, dentroDoRepo: false });
  try {
    assert.notEqual(r.status, 0, 'deve sair com erro — nada foi instalado');
    assert.match(r.saida, /não publica \.dmg/, 'deve dizer por que abortou');
    assert.doesNotMatch(r.saida, /Concluído/, 'não pode declarar "Concluído" sem instalar');
    // What the report's user followed and broke on: the tips pointed to a
    // nonexistent /Applications/...
    assert.doesNotMatch(r.saida, /xattr -dr com\.apple\.quarantine/, 'não pode sugerir xattr sem app no disco');
    assert.equal(r.perfil, '', 'não pode gravar alias apontando para um app inexistente');
  } finally { r.limpar(); }
});

// --- dev mode: no .dmg still has plan B, the alias falls back to `npx electron .` ---
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

// --- the other side of the boolean: actually installed → the tips MUST appear ---
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

// --- .sha512 sidecar: the four outcomes (4th review, finding P1 #2) ---
// The hole: `expected=""` collapsed "404", "network failure" and "200 with
// garbage" into a single case. Since the macOS build stopped emitting
// latest-mac.yml, tier 1 never finds anything and the script ended up at
// "skipped verification" + install. A proxy or captive portal answering 200
// turned the whole control off.

test('sidecar válido: instala E verifica o sha512', () => {
  const r = rodar({ temDmg: true, dentroDoRepo: false, sidecar: 'valido' });
  try {
    assert.equal(r.status, 0);
    assert.match(r.saida, /integridade verificada \(sha512\)/,
      'com sidecar válido a verificação tem que RODAR, não ser pulada');
    assert.match(r.saida, /Concluído/);
  } finally { r.limpar(); }
});

test('sidecar 200 com lixo: ABORTA, não trata como release sem checksum', () => {
  const r = rodar({ temDmg: true, dentroDoRepo: false, sidecar: 'lixo' });
  try {
    assert.notEqual(r.status, 0, 'instalou apesar do sidecar interceptado');
    assert.match(r.saida, /conteúdo inválido/);
    assert.doesNotMatch(r.saida, /pulei a verificação/,
      '200 com corpo inválido não é "sem sidecar" — é sinal de origem não confiável');
    assert.doesNotMatch(r.saida, /Concluído/);
  } finally { r.limpar(); }
});

test('sidecar inalcançável (rede): ABORTA em vez de instalar sem verificar', () => {
  const r = rodar({ temDmg: true, dentroDoRepo: false, sidecar: 'rede' });
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.saida, /não foi possível buscar o sidecar/);
    assert.doesNotMatch(r.saida, /Concluído/);
  } finally { r.limpar(); }
});

test('sidecar 404: release antiga segue instalando (senão nada atualiza)', () => {
  // The counterweight to the two above: hardening 404 would prevent any
  // release older than the sidecar from being installed. 404 is a legitimate
  // absence.
  const r = rodar({ temDmg: true, dentroDoRepo: false, sidecar: 'ausente' });
  try {
    assert.equal(r.status, 0, '404 não pode abortar — é release antiga, não ataque');
    assert.match(r.saida, /pulei a verificação/);
    assert.match(r.saida, /Concluído/);
  } finally { r.limpar(); }
});
