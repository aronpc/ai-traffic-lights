#!/usr/bin/env bash
#
# scripts/release.sh — publica releases no GitHub em DOIS CANAIS ISOLADOS.
#
# Uso:
#   scripts/release.sh beta                     # publica X.Y.Z-beta.N como PRE-RELEASE
#   scripts/release.sh beta --base 0.8.0        # força a base (default: patch+1 do package.json)
#   scripts/release.sh promote                 # promove a última beta pra stable
#   scripts/release.sh promote --version 0.7.3
#   scripts/release.sh <modo> --dry-run        # mostra o que faria, não publica
#   scripts/release.sh <modo> --skip-tests     # pula o gate `npm test` (use com consciência)
#   scripts/release.sh <modo> --yes            # não pergunta nada (é o padrão em CI)
#
# ---------------------------------------------------------------------------
# POR QUE OS CANAIS FICAM ISOLADOS (sem nenhum código extra no app)
#
#   1. O GitHub OMITE pre-releases de /releases/latest.
#   2. Todo build estável roda com `allowPrerelease=false` e o GitHubProvider do
#      electron-updater resolve a tag EXATAMENTE por /releases/latest
#      (getLatestTagName) — logo, nunca enxerga uma pre-release.
#   3. O electron-updater LIGA `allowPrerelease` sozinho quando a versão do app
#      tem componente de pre-release (AppUpdater: hasPrereleaseComponents) —
#      então um build `-beta.N` varre o feed atom e só aceita tags do mesmo canal.
#   4. O fallback GitHub-API do app (src/ipc/update.js, usado por deb/npm/source)
#      também consulta /releases/latest → igualmente protegido.
#
#   O build em si é IDÊNTICO ao estável: só a versão muda. O electron-builder
#   grava `latest-linux.yml` nos dois casos, mas o do canal beta vive DENTRO da
#   tag da pre-release — inalcançável para quem resolve a tag por /releases/latest.
#
# Referência do fluxo manual estável: .omc/RELEASE_RULE.md (local) e docs/RELEASE.md.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="aronpc/ai-traffic-lights"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "faltando dependência: $1"; }

# ---------- argumentos ----------
MODE="${1:-}"; shift || true
BASE=""; VERSION=""; DRY=0; SKIP_TESTS=0; ASSUME_YES=0
if [ -n "${CI:-}" ]; then ASSUME_YES=1; fi   # em CI nada é interativo

while [ $# -gt 0 ]; do
  case "$1" in
    --base)       BASE="${2:-}"; shift;;
    --version)    VERSION="${2:-}"; shift;;
    --dry-run|-n) DRY=1;;
    --skip-tests) SKIP_TESTS=1;;
    --yes|-y)     ASSUME_YES=1;;
    --help|-h)    sed -n '3,12p' "$0"; exit 0;;
    *) die "opção desconhecida: $1 (use --help)";;
  esac
  shift
done

case "$MODE" in
  beta|promote) ;;
  *) die "modo inválido: '${MODE:-<vazio>}'. Use 'beta' ou 'promote' (--help)";;
esac

need gh; need jq; need git; need npx
gh auth status >/dev/null 2>&1 || die "gh não autenticado (rode: gh auth login)"

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '\033[1;33m?\033[0m %s [y/N] ' "$1"
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|s|S) return 0;; *) die "abortado pelo usuário";; esac
}

run() { # executa, ou só mostra em --dry-run
  if [ "$DRY" = 1 ]; then printf '\033[2m  [dry-run] %s\033[0m\n' "$*"; return 0; fi
  "$@"
}

PKG_VERSION="$(jq -r .version package.json)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"

# Tag estável atual — usada no fim pra PROVAR que o canal beta não a moveu.
stable_latest_tag() { gh api "repos/$REPO/releases/latest" -q .tag_name 2>/dev/null || echo ""; }
STABLE_BEFORE="$(stable_latest_tag)"

# ---------- gates comuns ----------
guard_tree() {
  if [ -n "$(git status --porcelain)" ]; then
    git status --short
    confirm "árvore de trabalho SUJA — publicar mesmo assim (o build usa os arquivos do disco)?"
  fi
}

guard_pushed() {
  git fetch origin --quiet 2>/dev/null || warn "git fetch falhou (offline?) — seguindo"
  if ! git branch -r --contains "$SHA" 2>/dev/null | grep -q .; then
    confirm "o commit $SHORT_SHA NÃO está em nenhum branch remoto — publicar assim mesmo?"
  fi
}

run_tests() {
  if [ "$SKIP_TESTS" = 1 ]; then warn "gate de testes PULADO (--skip-tests)"; return 0; fi
  info "rodando npm test…"
  npm test >/dev/null 2>&1 || { npm test || true; die "npm test FALHOU — release abortado"; }
  ok "npm test verde"
}

# Build. $1=versão  $2=alvos do electron-builder  $3=dir de saída
# NÃO apaga o diretório de saída: `dist/` guarda os artefatos históricos do
# projeto. Quem chama remove só os arquivos que vai (re)gerar.
build() {
  local version="$1" targets="$2" out="$3"
  info "buildando $version ($targets) → $out"
  # shellcheck disable=SC2086
  run npx electron-builder --linux $targets --publish never \
    -c.extraMetadata.version="$version" \
    -c.directories.output="$out"
}

# ===========================================================================
# MODO beta — pre-release X.Y.Z-beta.N
# ===========================================================================
release_beta() {
  # Base: patch+1 do package.json (0.7.2 → 0.7.3), ou --base.
  if [ -z "$BASE" ]; then
    BASE="$(printf '%s' "$PKG_VERSION" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"
  fi
  [[ "$BASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "base inválida: '$BASE' (esperado X.Y.Z)"

  # N = maior -beta.N já publicado nessa base, +1.
  local max=0 n
  while read -r t; do
    case "$t" in
      "v$BASE-beta."*)
        n="${t##*-beta.}"
        if [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt "$max" ]; then max="$n"; fi
        ;;
    esac
  done < <(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null || true)
  local version="$BASE-beta.$((max + 1))"
  local tag="v$version"

  info "canal beta → $tag  (branch $BRANCH @ $SHORT_SHA)"
  info "stable atual: ${STABLE_BEFORE:-<nenhum>} — não deve mudar"
  guard_tree; guard_pushed; run_tests

  local out="dist-beta"
  local appimage="$out/ai-traffic-lights-$version.AppImage"
  local yml="$out/latest-linux.yml"
  run rm -f "$appimage" "$yml"   # nada de artefato velho passando por novo
  # Só AppImage: o .deb não participa do canal beta (o updater do deb é
  # informativo e resolve por /releases/latest, que exclui pre-releases).
  build "$version" "AppImage" "$out"
  if [ "$DRY" = 0 ]; then
    [ -f "$appimage" ] || die "não encontrei $appimage"
    [ -f "$yml" ] || die "não encontrei $yml (o auto-update do canal beta depende dele)"
    grep -q "version: $version" "$yml" || die "$yml não bate com a versão $version"
  fi

  local notes; notes="$(mktemp)"
  {
    echo "**Build de teste do canal \`beta\`.** Não afeta quem está no canal estável:"
    echo "esta release é uma _pre-release_, e o GitHub a omite de \`/releases/latest\` —"
    echo "que é exatamente onde o app estável procura atualização."
    echo
    echo "| | |"
    echo "|---|---|"
    echo "| branch | \`$BRANCH\` |"
    echo "| commit | [\`$SHORT_SHA\`](https://github.com/$REPO/commit/$SHA) |"
    echo "| estável no momento | ${STABLE_BEFORE:-—} |"
    echo
    echo "### Como testar"
    echo "Em **Preferências → Atualizações**, ligue *\"Receber versões beta (teste)\"*."
    echo "O app baixa esta versão sozinho e segue recebendo as próximas do canal beta."
    echo "Desligar o toggle traz você de volta para a última estável."
    echo
    echo "<details><summary>Instalar à mão (app anterior à 0.7.3, sem o toggle)</summary>"
    echo
    echo '```bash'
    echo "curl -fsSL -o ~/Applications/AI-Traffic-Lights.AppImage \\"
    echo "  https://github.com/$REPO/releases/download/$tag/ai-traffic-lights-$version.AppImage"
    echo "chmod +x ~/Applications/AI-Traffic-Lights.AppImage"
    echo '```'
    echo "</details>"
    if [ -n "$STABLE_BEFORE" ]; then
      local total=0
      total="$(git log --no-merges --oneline "$STABLE_BEFORE..HEAD" 2>/dev/null | wc -l)"
      echo
      echo "### Commits desde \`$STABLE_BEFORE\` ($total)"
      git log --no-merges --pretty='- %s' "$STABLE_BEFORE..HEAD" 2>/dev/null | head -40 || true
      # Truncar em silêncio faria a lista PARECER completa. Diz quantos ficaram
      # de fora e aponta para o compare, que tem todos.
      if [ "$total" -gt 40 ]; then
        echo
        echo "_… e mais $((total - 40)). Lista completa: [\`$STABLE_BEFORE...$tag\`](https://github.com/$REPO/compare/$STABLE_BEFORE...$tag)_"
      fi
    fi
  } > "$notes"

  confirm "publicar $tag como PRE-RELEASE em $REPO?"
  run gh release create "$tag" \
    --repo "$REPO" \
    --prerelease \
    --target "$SHA" \
    --title "$tag — beta ($BRANCH @ $SHORT_SHA)" \
    --notes-file "$notes" \
    "$appimage" "$yml"
  rm -f "$notes"

  verify_stable_untouched
  if [ "$DRY" = 0 ]; then ok "publicado: https://github.com/$REPO/releases/tag/$tag"; fi
}

# O binário estável tem de ser CÓDIGO-IDÊNTICO ao que foi validado na beta.
#
# Não dá para exigir o mesmo SHA: o commit `chore(release)` (bump + CHANGELOG)
# fica necessariamente DEPOIS da última beta. O que dá para exigir é que o único
# delta entre a beta e o que será empacotado sejam esses arquivos editoriais —
# qualquer outro arquivo alterado é código que nunca rodou no canal beta
# entrando na estável por baixo do pano.
#
# `package.json` é empacotado, mas a versão vem de fora (-c.extraMetadata.version
# na beta, explícita aqui), e `CHANGELOG.md` nem entra no bundle.
guard_same_code_as_beta() {
  local base="$1" last_beta beta_sha extra
  last_beta="$(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null \
    | grep -E "^v${base//./\\.}-beta\.[0-9]+$" | head -1 || true)"
  if [ -z "$last_beta" ]; then
    confirm "nenhuma beta de $base foi publicada — promover código que não passou pelo canal beta?"
    return 0
  fi
  git fetch origin --tags --quiet 2>/dev/null || warn "git fetch --tags falhou — comparação pode usar tags locais defasadas"
  beta_sha="$(git rev-parse -q --verify "refs/tags/$last_beta^{commit}" 2>/dev/null || true)"
  if [ -z "$beta_sha" ]; then
    confirm "não consegui resolver a tag $last_beta localmente — seguir sem comparar o código?"
    return 0
  fi
  if [ "$beta_sha" = "$SHA" ]; then
    ok "código idêntico à $last_beta (mesmo commit)"
    return 0
  fi
  extra="$(git diff --name-only "$beta_sha" "$SHA" -- . \
    ':(exclude)package.json' ':(exclude)CHANGELOG.md' 2>/dev/null || true)"
  if [ -n "$extra" ]; then
    printf '%s\n' "$extra" | sed 's/^/    /' >&2
    die "estes arquivos mudaram desde $last_beta e NÃO foram testados no canal beta.
   Publique uma nova beta deste commit antes de promover, ou promova de um commit
   cujo único delta em relação à beta sejam package.json/CHANGELOG.md."
  fi
  ok "código idêntico à $last_beta (só package.json/CHANGELOG.md mudaram)"
}

# ===========================================================================
# MODO promote — X.Y.Z-beta.N  →  X.Y.Z estável
# ===========================================================================
release_promote() {
  # Versão alvo: --version, ou a última beta sem o sufixo.
  if [ -z "$VERSION" ]; then
    local last_beta
    last_beta="$(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
    [ -n "$last_beta" ] || die "nenhuma release -beta.N encontrada; passe --version X.Y.Z"
    VERSION="$(printf '%s' "$last_beta" | sed -E 's/^v//; s/-beta\.[0-9]+$//')"
    info "última beta: $last_beta → promovendo para $VERSION"
  fi
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "versão inválida: '$VERSION' (esperado X.Y.Z)"
  local tag="v$VERSION"

  # Pré-requisitos editoriais do runbook — o script NÃO os inventa.
  [ "$PKG_VERSION" = "$VERSION" ] \
    || die "package.json está em $PKG_VERSION, não $VERSION. Bumpe + commite 'chore(release): $tag' antes."
  grep -q "^## \[$VERSION\]" CHANGELOG.md \
    || die "CHANGELOG.md não tem a seção '## [$VERSION]'. Mova a [Unreleased] antes."
  ! gh release view "$tag" --repo "$REPO" >/dev/null 2>&1 \
    || die "a release $tag já existe em $REPO"

  info "promovendo → $tag  (branch $BRANCH @ $SHORT_SHA)"
  guard_same_code_as_beta "$VERSION"
  guard_tree; guard_pushed; run_tests

  local out="dist"
  local appimage="$out/ai-traffic-lights-$VERSION.AppImage"
  local deb="$out/ai-traffic-lights_${VERSION}_amd64.deb"
  local yml="$out/latest-linux.yml"
  run rm -f "$appimage" "$deb" "$yml"   # nada de artefato velho passando por novo
  build "$VERSION" "AppImage deb" "$out"
  if [ "$DRY" = 0 ]; then
    for f in "$appimage" "$deb" "$yml"; do [ -f "$f" ] || die "não encontrei $f"; done
  fi

  # Notas = a seção do CHANGELOG + link de comparação (convenção do projeto).
  local notes; notes="$(mktemp)"
  awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" { on = 1; next }
    on && /^## \[/         { exit }
    on                     { print }
  ' CHANGELOG.md > "$notes"
  if [ -n "$STABLE_BEFORE" ]; then
    printf '\n**Full Changelog**: https://github.com/%s/compare/%s...%s\n' \
      "$REPO" "$STABLE_BEFORE" "$tag" >> "$notes"
  fi

  confirm "publicar $tag como release ESTÁVEL (vira o Latest de todo mundo)?"
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    run git tag -a "$tag" -m "$tag"
  fi
  run git push origin "$tag"
  run gh release create "$tag" \
    --repo "$REPO" \
    --target "$SHA" \
    --title "$tag" \
    --notes-file "$notes" \
    "$appimage" "$deb" "$yml"
  rm -f "$notes"

  if [ "$DRY" = 0 ]; then ok "publicado: https://github.com/$REPO/releases/tag/$tag"; fi
}

# Prova de que o canal beta não mexeu no estável.
verify_stable_untouched() {
  if [ "$DRY" = 1 ]; then return 0; fi
  local after; after="$(stable_latest_tag)"
  if [ "$after" != "$STABLE_BEFORE" ]; then
    die "REGRESSÃO: /releases/latest mudou de '${STABLE_BEFORE:-<nenhum>}' para '${after:-<nenhum>}'. A release beta deveria ser pre-release."
  fi
  ok "estável intacto: /releases/latest continua ${after:-<nenhum>}"
}

case "$MODE" in
  beta)    release_beta;;
  promote) release_promote;;
esac
