#!/usr/bin/env bash
#
# scripts/release.sh — publishes GitHub releases in TWO ISOLATED CHANNELS.
#
# Usage:
#   scripts/release.sh beta                     # publishes X.Y.Z-beta.N as a PRE-RELEASE
#   scripts/release.sh beta --base 0.8.0        # forces the base (default: patch+1 from package.json)
#   scripts/release.sh promote                 # promotes the latest beta to stable
#   scripts/release.sh promote --version 0.7.3
#   scripts/release.sh upload-mac --version 0.7.3        # macOS build + upload to an already-created release
#   scripts/release.sh upload-mac --version 0.8.0-beta.3 # same, on a pre-release
#   scripts/release.sh upload-mac                  # same, version resolved from the latest -beta.N
#   scripts/release.sh <mode> --dry-run        # shows what it would do, doesn't publish
#   scripts/release.sh <mode> --skip-tests     # skips the `npm test` gate (use responsibly)
#   scripts/release.sh <mode> --yes            # asks nothing (the default in CI)
#
# ---------------------------------------------------------------------------
# WHY THE CHANNELS STAY ISOLATED (with no extra code in the app)
#
#   1. GitHub OMITS pre-releases from /releases/latest.
#   2. Every stable build runs with `allowPrerelease=false` and electron-updater's
#      GitHubProvider resolves the tag EXACTLY through /releases/latest
#      (getLatestTagName) — so it never sees a pre-release.
#   3. electron-updater turns ON `allowPrerelease` by itself when the app version
#      has a pre-release component (AppUpdater: hasPrereleaseComponents) —
#      so a `-beta.N` build scans the atom feed and only accepts tags from the same channel.
#   4. The app's GitHub-API fallback (src/ipc/update.js, used by deb/npm/source)
#      also queries /releases/latest → equally protected.
#
#   The build itself is IDENTICAL to stable: only the version changes. electron-builder
#   writes `latest-linux.yml` in both cases, but the beta channel's lives INSIDE the
#   pre-release tag — unreachable for anyone resolving the tag through /releases/latest.
#
# Reference for the manual stable flow: .omc/RELEASE_RULE.md (local) and docs/RELEASE.md.
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

# ---------- arguments ----------
MODE="${1:-}"; shift || true
BASE=""; VERSION=""; DRY=0; SKIP_TESTS=0; ASSUME_YES=0
if [ -n "${CI:-}" ]; then ASSUME_YES=1; fi   # in CI nothing is interactive

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
  beta|promote|upload-mac) ;;
  *) die "modo inválido: '${MODE:-<vazio>}'. Use 'beta', 'promote' ou 'upload-mac' (--help)";;
esac

need gh; need jq; need git; need npx
gh auth status >/dev/null 2>&1 || die "gh não autenticado (rode: gh auth login)"

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '\033[1;33m?\033[0m %s [y/N] ' "$1"
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|s|S) return 0;; *) die "abortado pelo usuário";; esac
}

run() { # executes, or only prints on --dry-run
  if [ "$DRY" = 1 ]; then printf '\033[2m  [dry-run] %s\033[0m\n' "$*"; return 0; fi
  "$@"
}

PKG_VERSION="$(jq -r .version package.json)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"

# Current stable tag — used at the end to PROVE the beta channel didn't move it.
stable_latest_tag() { gh api "repos/$REPO/releases/latest" -q .tag_name 2>/dev/null || echo ""; }
STABLE_BEFORE="$(stable_latest_tag)"

# ---------- common gates ----------
# Generates a <file>.sha512 sidecar with the hash in base64 — the same encoding
# electron-builder uses in its yml files, so the installers compare the same way.
# It exists because latest-mac.yml is only emitted by the `zip` target (see
# ArchiveTarget.js: `isWriteUpdateInfo && format === "zip"`), and publishing ~100 MB
# of zip just to carry a 1 KB hash doesn't pay off. Linux gets the same sidecar
# for symmetry: a single format, read identically by both installers.
sha512_sidecar() {
  local f="$1" out="$1.sha512" tmp
  tmp="$(mktemp)"
  # Writes to a TEMP file and only moves on success. Redirecting straight to $out
  # truncates the file BEFORE the pipeline runs: a mid-way failure (under
  # set -o pipefail) would leave an empty or partial sidecar in place of a valid
  # one — and empty publishes without verification, partial makes EVERY installer
  # abort with "adulterado".
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha512 -binary "$f" | openssl base64 -A > "$tmp"
  elif command -v shasum >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
    shasum -a 512 "$f" | awk '{print $1}' | xxd -r -p | base64 | tr -d '\n' > "$tmp"
  else
    rm -f "$tmp"
    warn "sem openssl (nem shasum+xxd) — sem sidecar de checksum para $(basename "$f")"
    return 1
  fi
  # 88 base64 chars is the fixed size of a sha512; anything else is a silent
  # pipeline failure and must not become a published artifact.
  if [ "$(wc -c < "$tmp" | tr -d ' ')" != "88" ]; then
    rm -f "$tmp"
    warn "sidecar de $(basename "$f") saiu malformado — descartado"
    return 1
  fi
  # A failing `mv` (read-only dir, cross-device, permission) must not report
  # success: the caller would attach a nonexistent file and `gh` would abort —
  # in promote, AFTER the tag push, leaving a published tag with no release.
  mv "$tmp" "$out" || { rm -f "$tmp"; warn "não consegui mover o sidecar de $(basename "$f")"; return 1; }
  printf '%s' "$out"
}

# sidecars_ou_morra generates the sidecar for each artifact and ABORTS if any
# fails, echoing the generated paths.
#
# Before, the three flows did `sha512_sidecar "$x" && extras+=(...)`: any
# failure (no openssl, output != 88 chars, `mv` denied, broken pipeline)
# published the release WITHOUT a checksum, silently. On the other side, a 404
# on the sidecar is read by the installers as "old release" and installs without
# verifying — so failing open here turns the whole check off there.
#
# The conditional existed for a real reason: passing the path unconditionally
# made `gh` abort with "no matches found" AFTER the entire build. The way out
# is not accepting a release without a checksum — it's generating and validating
# BEFORE creating tag/release, which is what the callers now do.
# Fills the GLOBAL SIDECARS array instead of echoing the paths.
#
# Echoing and capturing with `mapfile -t x < <(sidecars_ou_morra ...)` looks
# cleaner and is a trap: process substitution runs in a SUBSHELL, so `die`
# only kills the subshell. The script continues, `extras` stays empty, and the
# release ships without a checksum — precisely the fail-open this function
# exists to eliminate. Verified on bash 5.x: the script continues and exits 0.
#
# `local -n`/nameref would avoid the global but requires bash 4.3+; the global
# array is what works everywhere this script runs.
SIDECARS=()
sidecars_ou_morra() {
  SIDECARS=()
  local f
  for f in "$@"; do
    sha512_sidecar "$f" >/dev/null \
      || die "não consegui gerar o sidecar .sha512 de $(basename "$f").
   Publicar sem checksum faria todo instalador tratar a release como 'antiga'
   e instalar sem verificação nenhuma. Abortando antes de criar a release."
    [ -s "$f.sha512" ] || die "sidecar de $(basename "$f") ficou vazio — abortando."
    SIDECARS+=("$f.sha512")
  done
}

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

# Linux build. $1=version  $2=electron-builder targets  $3=output dir
# Does NOT delete the output directory: `dist/` holds the project's historical
# artifacts. Callers remove only the files they will (re)generate.
build() {
  local version="$1" targets="$2" out="$3"
  info "buildando $version ($targets) → $out"
  # shellcheck disable=SC2086
  run npx electron-builder --linux $targets --publish never \
    -c.extraMetadata.version="$version" \
    -c.directories.output="$out"
}

# macOS build. $1=version  $2=output dir
# Generates ONLY the .dmg. The -mac.zip and latest-mac.yml existed for
# Squirrel.Mac, which is never instantiated here: it requires Developer ID
# signing and the app is signed ad-hoc. They were ~100 MB per release that
# nobody read (finding 03 of the PR #46 review). The macOS updater downloads
# the .dmg and replays the install_macos.sh steps — see src/ipc/update.js.
# Can only run on a macOS runner (darwin) — in CI it uses macos-latest.
build_mac() {
  local version="$1" out="$2"
  [ "$(uname -s)" = "Darwin" ] || die "build_mac só pode rodar no macOS (uname: $(uname -s))"
  info "buildando $version (macOS dmg) → $out"
  run npx electron-builder --mac dmg --publish never \
    -c.extraMetadata.version="$version" \
    -c.directories.output="$out"
}

# ===========================================================================
# MODE beta — pre-release X.Y.Z-beta.N
# ===========================================================================
release_beta() {
  # Base: package.json. No suffix → patch+1 (0.7.2 → 0.7.3). WITH a -beta.N
  # suffix (the post-promote bump, e.g. 0.9.1-beta.0) the base was already
  # decided by that bump → the X.Y.Z itself. Plain awk coerces "1-beta"→1 and
  # adds +1, turning 0.9.1-beta.0 into base 0.9.2 mid-cycle (measured when
  # shipping 0.9.1-beta.1, which needed an explicit --base to escape it).
  if [ -z "$BASE" ]; then
    if [[ "$PKG_VERSION" == *-* ]]; then
      BASE="${PKG_VERSION%%-*}"
    else
      BASE="$(printf '%s' "$PKG_VERSION" | awk -F. '{printf "%d.%d.%d", $1, $2, $3 + 1}')"
    fi
  fi
  [[ "$BASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "base inválida: '$BASE' (esperado X.Y.Z)"

  # N = highest -beta.N already published on this base, +1.
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
  run rm -f "$appimage" "$yml" "$appimage.sha512"   # no old artifact passing as new
  # AppImage only: the .deb doesn't take part in the beta channel (the deb's
  # updater is informational and resolves through /releases/latest, which excludes pre-releases).
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
      # Truncating silently would make the list LOOK complete. It says how many
      # were left out and points to the compare view, which has them all.
      if [ "$total" -gt 40 ]; then
        echo
        echo "_… e mais $((total - 40)). Lista completa: [\`$STABLE_BEFORE...$tag\`](https://github.com/$REPO/compare/$STABLE_BEFORE...$tag)_"
      fi
    fi
  } > "$notes"

  confirm "publicar $tag como PRE-RELEASE em $REPO?"
  # Sidecars BEFORE `gh release create`: if the checksum doesn't come out,
  # nothing is published — instead of publishing an artifact nobody can verify.
  local extras=()
  if [ "$DRY" = 0 ]; then
    sidecars_ou_morra "$appimage"
    extras=("${SIDECARS[@]}")
  fi
  run gh release create "$tag" \
    --repo "$REPO" \
    --prerelease \
    --target "$SHA" \
    --title "$tag — beta ($BRANCH @ $SHORT_SHA)" \
    --notes-file "$notes" \
    "$appimage" "$yml" ${extras[@]+"${extras[@]}"}
  rm -f "$notes"

  verify_stable_untouched
  if [ "$DRY" = 0 ]; then ok "publicado: https://github.com/$REPO/releases/tag/$tag"; fi
}

# The stable binary must be CODE-IDENTICAL to what was validated on beta.
#
# Requiring the same SHA isn't possible: the `chore(release)` commit (bump +
# CHANGELOG) necessarily lands AFTER the last beta. What can be required is
# that the only delta between the beta and what will be packaged be these
# editorial files — any other changed file is code that never ran on the beta
# channel sneaking into stable through the back door.
#
# `package.json` is packaged, but the version comes from outside
# (-c.extraMetadata.version on beta, explicit here), and `CHANGELOG.md` isn't
# even in the bundle.
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
# MODE promote — X.Y.Z-beta.N  →  stable X.Y.Z
# ===========================================================================
release_promote() {
  # Target version: --version, or the latest beta without the suffix.
  if [ -z "$VERSION" ]; then
    local last_beta
    last_beta="$(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
    [ -n "$last_beta" ] || die "nenhuma release -beta.N encontrada; passe --version X.Y.Z"
    VERSION="$(printf '%s' "$last_beta" | sed -E 's/^v//; s/-beta\.[0-9]+$//')"
    info "última beta: $last_beta → promovendo para $VERSION"
  fi
  # X.Y.Z only: promote publishes WITHOUT --prerelease and moves
  # /releases/latest, so a -beta.N tag here would deliver a beta to the whole
  # stable channel. The beta's macOS artifact ships via the `upload-mac` mode,
  # which accepts -beta.N.
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "versão inválida: '$VERSION' (esperado X.Y.Z)"
  local tag="v$VERSION"

  # Editorial prerequisites from the runbook — the script does NOT invent them.
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
  run rm -f "$appimage" "$deb" "$yml" "$appimage.sha512" "$deb.sha512"   # no old artifact passing as new
  build "$VERSION" "AppImage deb" "$out"
  if [ "$DRY" = 0 ]; then
    for f in "$appimage" "$deb" "$yml"; do [ -f "$f" ] || die "não encontrei $f"; done
  fi

  # Notes = the CHANGELOG section + compare link (project convention).
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

  # Sidecars BEFORE the tag, not after. Order matters: `git push origin
  # "$tag"` is irreversible in practice (the world may already have fetched
  # the tag), and generating them after left a window where the tag exists
  # but the checksum doesn't.
  local extras=()
  if [ "$DRY" = 0 ]; then
    sidecars_ou_morra "$appimage" "$deb"
    extras=("${SIDECARS[@]}")
  fi

  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    run git tag -a "$tag" -m "$tag"
  fi
  run git push origin "$tag"
  run gh release create "$tag" \
    --repo "$REPO" \
    --target "$SHA" \
    --title "$tag" \
    --notes-file "$notes" \
    "$appimage" "$deb" "$yml" ${extras[@]+"${extras[@]}"}
  rm -f "$notes"

  if [ "$DRY" = 0 ]; then ok "publicado: https://github.com/$REPO/releases/tag/$tag"; fi
}

# ===========================================================================
# MODE upload-mac — builds macOS and uploads the artifacts to an
# already-created release. Called by the CI build-mac job (macos-latest) AFTER
# the Linux job has already created the release with `gh release create`.
# Usage: scripts/release.sh upload-mac --version X.Y.Z [--dry-run]
# ===========================================================================
release_upload_mac() {
  # Target version: --version, or the latest beta WITH the suffix. Unlike
  # promote, which resolves `vX.Y.Z-beta.N` → `X.Y.Z` because its target is
  # stable: here the target is the pre-release itself. Stripping `-beta.N` made
  # the default point at the STABLE release and upload the beta's .dmg on top of it.
  if [ -z "$VERSION" ]; then
    local last_beta
    last_beta="$(gh release list --repo "$REPO" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null \
      | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' | head -1 || true)"
    [ -n "$last_beta" ] || die "nenhuma release -beta.N encontrada; passe --version X.Y.Z"
    VERSION="${last_beta#v}"
    info "última beta: $last_beta → upload-mac para $VERSION"
  fi
  # Accepts X.Y.Z (stable) AND X.Y.Z-beta.N — same rule as promote. With an
  # X.Y.Z-only regex, the documented `upload-mac --version X.Y.Z-beta.N` mode
  # died with "versão inválida" and the beta channel never got a .dmg: macOS
  # under test had no artifact, including to validate the macOS updater itself.
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]] \
    || die "versão inválida: '$VERSION' (esperado X.Y.Z ou X.Y.Z-beta.N)"
  local tag="v$VERSION"

  # Same gates as beta and promote. This mode publishes an artifact to a real
  # release (with --clobber), so there's no reason for it to be the only
  # publishing path without a clean tree, a pushed commit and a green suite.
  guard_tree; guard_pushed; run_tests

  # Waits for the release to exist (the Linux job may still be finishing).
  # In dry-run skips the wait — the release may not exist yet.
  if [ "$DRY" = 0 ]; then
    local tries=0
    until gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -ge 20 ] && die "release $tag não encontrada após $tries tentativas — o job Linux falhou?"
      info "aguardando release $tag... ($tries/20)"
      sleep 15
    done
  fi

  local out="dist-mac"
  local dmg=""

  # No old artifact passing as new (same rule as the Linux flow): an older
  # version or architecture .dmg/.zip in $out would skew the `ls` below and
  # upload the wrong binary to the right release.
  run rm -f "$out"/*.dmg "$out"/*.dmg.sha512 || true

  build_mac "$VERSION" "$out"

  if [ "$DRY" = 0 ]; then
    # Selection ANCHORED to the build version (not just "any .dmg"):
    # `ls *.dmg | head -1` would pick the first in alphabetical order.
    dmg="$(ls "$out"/*"-$VERSION".dmg "$out"/*"-$VERSION-"*.dmg 2>/dev/null | head -1 || true)"
    [ -n "$dmg" ]     || die "não encontrei .dmg da versão $VERSION em $out/"


  fi

  info "enviando artefatos macOS para $tag..."
  # This is the artifact the macOS auto-update downloads on its own and uses
  # to replace the whole app. Without a sidecar, `validarSidecar` returns
  # 'sem-sidecar' and the update installs WITHOUT comparing any hash.
  local extras=()
  if [ "$DRY" = 0 ]; then
    sidecars_ou_morra "$dmg"
    extras=("${SIDECARS[@]}")
  fi
  run gh release upload "$tag" \
    --repo "$REPO" \
    --clobber \
    "$dmg" ${extras[@]+"${extras[@]}"}

  if [ "$DRY" = 0 ]; then
    ok "artefato macOS enviado: $(basename "$dmg")"
  fi
}

# Proof that the beta channel didn't touch stable.
verify_stable_untouched() {
  if [ "$DRY" = 1 ]; then return 0; fi
  local after; after="$(stable_latest_tag)"
  if [ "$after" != "$STABLE_BEFORE" ]; then
    die "REGRESSÃO: /releases/latest mudou de '${STABLE_BEFORE:-<nenhum>}' para '${after:-<nenhum>}'. A release beta deveria ser pre-release."
  fi
  ok "estável intacto: /releases/latest continua ${after:-<nenhum>}"
}

case "$MODE" in
  beta)        release_beta;;
  promote)     release_promote;;
  upload-mac)  release_upload_mac;;
esac
