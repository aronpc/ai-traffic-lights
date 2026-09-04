#!/usr/bin/env bash
#
# install_macos.sh — installs AI Traffic Lights (.app) on macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aronpc/ai-traffic-lights/main/install_macos.sh | bash
#   GITHUB_TOKEN=ghp_xxx bash install_macos.sh   # avoids GitHub API rate-limit
#
# The app is not notarized; this installer removes the quarantine and
# re-signs ad-hoc locally (xattr + codesign) so Gatekeeper doesn't block it.
#
set -euo pipefail

REPO="aronpc/ai-traffic-lights"
APP_TITLE="AI Traffic Lights"
APP_NAME="AI Traffic Lights.app"
DMG_NAME="AI-Traffic-Lights.dmg"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "faltando dependência: $1"; }

# Verifies the integrity (sha512) of the .dmg against the latest-mac.yml that
# electron-builder publishes on the release (parity with the Linux install.sh —
# PR-32 #07: it previously downloaded the .dmg with no verification at all).
# Best-effort: without yml/sha512 or openssl, it proceeds with a warning
# (doesn't block installation).
# Compares a file's sha512 (base64) against the expected one. Separate because
# the two tiers — sidecar and yml — end up in the same place.
compara_checksum() {
  local file="$1" expected="$2" base="$3" actual
  if command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha512 -binary "$file" 2>/dev/null | openssl base64 -A)"
  elif command -v shasum >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
    actual="$(shasum -a 512 "$file" | awk '{print $1}' | xxd -r -p | base64 | tr -d '\n')"
  else
    warn "sem openssl/shasum — pulei a verificação de integridade"; return 0
  fi
  if [ "$actual" = "$expected" ]; then
    ok "integridade verificada (sha512)"
  else
    die "checksum NÃO confere ($base) — download corrompido ou adulterado. Abortei."
  fi
}

verify_checksum() {
  local file="$1" asset_url="$2" yml yml_url base base_decoded expected actual
  base="$(basename "${asset_url%%\?*}")"
  # GitHub encodes spaces in the URL as %20, but electron-builder writes the
  # yml with hyphens (e.g. AI-Traffic-Lights-0.7.3-arm64.dmg). Decodes %20→space
  # and also tries the spaces→hyphens variant to locate the correct sha512.
  base_decoded="$(printf '%s' "$base" | sed 's/%20/ /g')"

  # Tier 0: the <file>.sha512 sidecar published by release.sh. It's the
  # preferred path and the SAME one in both installers: it doesn't depend on
  # the electron-builder format, nor the file name inside the yml, nor which
  # target was built. It matters here because the macOS build stopped
  # generating the zip, and latest-mac.yml only ships with it
  # (ArchiveTarget: isWriteUpdateInfo && zip).
  # URL WITHOUT query string: the `base` right below already anticipates one,
  # and "…AppImage?token=x.sha512" would 404 — silently skipping tier 0.
  # Three DIFFERENT outcomes, and treating them alike was the hole:
  # `expected=""` collapsed everything into "no sidecar", falling to tier 1
  # and, since latest-mac.yml is no longer published (see above), ending in
  # "pulei a verificação" + install.
  #
  #   404            old release, predating the sidecar  -> fallback (tier 1)
  #   network fail   can't tell                          -> ABORTS
  #   200 malformed  someone in the middle               -> ABORTS
  #
  # A malformed 200 is the most dangerous one: a proxy, captive portal or CDN
  # edge returning its own body with status 200 would turn the whole check off
  # if it became "no sidecar". An artifact that arrives with an unreadable
  # sidecar is not an old release — it's a sign the origin can't be trusted.
  local sc_body sc_code
  sc_body="$(mktemp)"
  sc_code="$(curl -sSL --connect-timeout 15 --max-time 30 \
    -o "$sc_body" -w '%{http_code}' "${asset_url%%\?*}.sha512" 2>/dev/null)" || sc_code="000"

  if [ "$sc_code" = "200" ]; then
    expected="$(tr -d '\r\n' < "$sc_body")"
    rm -f "$sc_body"
    # 88 base64 chars ending in '==' is the fixed size of a sha512.
    if [[ ! "$expected" =~ ^[A-Za-z0-9+/]{86}==$ ]]; then
      die "sidecar .sha512 chegou com conteúdo inválido (HTTP 200, ${#expected} bytes).
   Isso não é uma release sem checksum — é um corpo adulterado ou interceptado.
   Abortando em vez de instalar sem verificação."
    fi
    compara_checksum "$file" "$expected" "$base"; return $?
  fi
  rm -f "$sc_body"

  if [ "$sc_code" != "404" ]; then
    die "não foi possível buscar o sidecar .sha512 (HTTP ${sc_code}).
   Sem ele não há como verificar a integridade do download.
   Tente de novo em instantes; se persistir, baixe o .dmg manualmente pelo GitHub Releases."
  fi

  # From here down: HTTP 404 confirmed. A release predating the sidecar, and
  # the fallback policy applies — that's what allows upgrading from an old
  # release.

  yml_url="${asset_url%/*}/latest-mac.yml"
  yml="$(curl -fsSL --connect-timeout 15 --max-time 60 "$yml_url" 2>/dev/null)" \
    || { warn "sem sidecar .sha512 nem latest-mac.yml — pulei a verificação de integridade"; return 0; }
  # Tries: decoded name, then spaces→hyphens name, then any .dmg in the yml.
  # `|| :` on each attempt: under `set -euo pipefail` a grep with no match would
  # kill the script BEFORE reaching the fallback — the best-effort the function
  # promises could never trigger (PR-46 review #2). The failure becomes an empty
  # expected → falls to the next tier or to the "sha512 não encontrado" warning.
  local base_hyphens; base_hyphens="$(printf '%s' "$base_decoded" | tr ' ' '-')"
  expected="$(printf '%s\n' "$yml" | grep -F -A3 "url: $base_hyphens" | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  if [ -z "$expected" ]; then
    expected="$(printf '%s\n' "$yml" | grep -F -A3 "url: $base_decoded" | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  fi
  if [ -z "$expected" ]; then
    # Fallback: takes the sha512 associated with any .dmg entry in the yml
    expected="$(printf '%s\n' "$yml" | grep -A3 'url:.*\.dmg' | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  fi
  [ -n "$expected" ] || { warn "sha512 não encontrado no yml p/ $base — pulei a verificação"; return 0; }
  if command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha512 -binary "$file" 2>/dev/null | base64 | tr -d '\n')"
  else
    warn "sem openssl — pulei a verificação de integridade"; return 0
  fi
  if [ "$actual" = "$expected" ]; then
    ok "integridade verificada (sha512)"
  else
    die "checksum NÃO confere ($base) — download corrompido ou adulterado. Abortei."
  fi
}

OS="$(uname -s)"
ARCH="$(uname -m)"
[ "$OS" = "Darwin" ] || die "Este instalador é exclusivo do macOS. SO atual: $OS"
need curl   # hdiutil/ditto/xattr/codesign/lipo/sed are native to macOS; jq is checked below

# The event hook the app installs (traffic-hook.sh) REQUIRES jq to persist
# each session's state — and jq doesn't ship with macOS. Without it the hook
# runs on every tool call, fails the write, and the overlay stays silently
# empty. We install via Homebrew when possible; without brew, a loud warning
# with the manual command.
ensure_jq() {
  # command -v approves a broken jq (corrupted shim): probe executability.
  if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1; then
    ok "jq presente (o hook de eventos exige)"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    info "instalando jq via Homebrew (o hook de eventos exige)..."
    # Re-checks PATH post-install: brew via wrapper may link outside PATH.
    if brew install jq && command -v jq >/dev/null 2>&1; then
      ok "jq instalado"
    else
      warn "jq não ficou utilizável após o brew — reabra o terminal ou instale manualmente."
      warn "Sem jq o app NÃO monitora nenhuma sessão (overlay vazio)."
    fi
  else
    warn "jq AUSENTE e Homebrew não encontrado."
    warn "O hook de eventos exige jq — sem ele o app abre vazio (nenhuma sessão no overlay). Instale:"
    warn '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install jq'
  fi
}
ensure_jq

# The published build is Apple Silicon (arm64). On Intel, the arm64 .dmg won't
# open (Rosetta doesn't translate arm64→x86). We warn loudly; the post-install
# check shows the binary's real arch.
if [ "$ARCH" != "arm64" ]; then
  warn "Seu Mac é $ARCH (Intel). O build publicado é Apple Silicon (arm64) e provavelmente NÃO abrirá."
  warn "Compile do fonte: git clone https://github.com/$REPO && cd ai-traffic-lights && npm install && npx electron-builder --mac"
fi

# --- query the release (optional token, timeout, clear rate-limit error; no brew/jq) ---
info "consultando a versão mais recente..."
GH_ERR="$(mktemp)"
gh_auth=()
[ -n "${GITHUB_TOKEN:-}" ] && gh_auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
if ! json="$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
      -H 'Accept: application/vnd.github+json' "${gh_auth[@]+"${gh_auth[@]}"}" "$API_URL" 2>"$GH_ERR")"; then
  rate=0; grep -qi 'rate limit\|API rate' "$GH_ERR" 2>/dev/null && rate=1
  rm -f "$GH_ERR"
  [ "$rate" = 1 ] && die "rate-limit da API do GitHub (60/h sem token). Rode: GITHUB_TOKEN=ghp_xxx bash install_macos.sh"
  die "falha ao consultar o GitHub (rede/API indisponível). Tente novamente em instantes."
fi
rm -f "$GH_ERR"

download_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.dmg"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
version="$(printf '%s\n' "$json" | grep -oE '"tag_name":[[:space:]]*"v?[^"]+"' | head -1 | sed -E 's/.*"v?([^"]+)"$/\1/')" || true

# Detects dev mode BEFORE deciding what to do without a .dmg: inside the repo
# a missing build is tolerable (the alias falls back to 'npx electron .');
# via curl|bash it isn't — with no app installed the alias points at nothing.
LOCAL_REPO=""
if [ -f "package.json" ] && grep -q '"name": "ai-traffic-lights"' package.json 2>/dev/null; then
  LOCAL_REPO="$(pwd)"
fi

# --- temp directory with guaranteed cleanup (dmg detach + rm) ---
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atl-install.XXXXXX")"
MOUNT_POINT="$TMP_DIR/mount"
cleanup() {
  [ -d "$MOUNT_POINT" ] && hdiutil detach -force "$MOUNT_POINT" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
DMG_PATH="$TMP_DIR/$DMG_NAME"

DEST="/Applications/$APP_NAME"
APP_INSTALLED=0
if [ -n "$download_url" ] && [ "$download_url" != "null" ]; then
  info "baixando v${version:-?}..."
  curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$DMG_PATH" "$download_url"
  verify_checksum "$DMG_PATH" "$download_url"
  ok "download completo"

  info "montando e copiando para /Applications..."
  mkdir -p "$MOUNT_POINT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH" >/dev/null

  # ditto preserves framework symlinks, flags and bundle metadata (cp -R doesn't).
  if ditto "$MOUNT_POINT/$APP_NAME" "$DEST.tmp" 2>/dev/null; then
    rm -rf "$DEST"; mv "$DEST.tmp" "$DEST"
  else
    warn "/Applications exige admin — instalando em ~/Applications"
    mkdir -p "$HOME/Applications"
    DEST="$HOME/Applications/$APP_NAME"
    rm -rf "$DEST"
    ditto "$MOUNT_POINT/$APP_NAME" "$DEST" || die "falha ao copiar o app."
  fi
  hdiutil detach -force "$MOUNT_POINT" >/dev/null 2>&1 || true
  ok "app copiado para $DEST"
  APP_INSTALLED=1

  # --- unlocks Gatekeeper: removes quarantine + re-signs ad-hoc LOCALLY ---
  # Without this, a non-notarized app downloaded via curl is blocked with
  # "app está danificado / não pôde ser aberto". The user already consented by running it.
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  if codesign --force --deep --sign - "$DEST" 2>/dev/null; then
    ok "quarantine removida + assinatura ad-hoc aplicada"
  else
    warn "não consegui re-assinar. Se o app não abrir, rode:"
    warn "  xattr -dr com.apple.quarantine \"$DEST\" && codesign --force --deep --sign - \"$DEST\""
  fi

  # --- post-install check: the binary's real arch (doesn't open the GUI) ---
  BIN="$DEST/Contents/MacOS/$APP_TITLE"
  if [ -f "$BIN" ]; then
    archs="$(lipo -archs "$BIN" 2>/dev/null || file -b "$BIN" 2>/dev/null || echo '?')"
    info "arquiteturas do binário: $archs"
    case "$archs" in
      *"$ARCH"*|*arm64e*) : ;;
      *) warn "o binário ($archs) não casa com seu Mac ($ARCH) — pode não abrir. Compile do fonte se necessário." ;;
    esac
  fi
elif [ -n "$LOCAL_REPO" ]; then
  # Inside the repo there's a plan B: the alias falls back to 'npx electron .',
  # which runs without the .app. We go on to install deps and write the aliases.
  warn "nenhum .dmg no release ${version:+v$version }do GitHub — seguindo em modo desenvolvimento."
  warn "Para gerar o .app: npm run dist:mac (o bundle sai em dist/)."
else
  # Via curl|bash there is NO plan B: without a .dmg nothing was installed.
  # Failing here is what stops the script from writing orphan aliases and
  # printing "✓ Concluído!" — the user would follow the xattr/codesign tips
  # and hit "No such file".
  # Parity with the Linux install.sh, which already dies without the .AppImage asset.
  printf '\n' >&2
  warn "o release ${version:+v$version }de $REPO não publica .dmg para macOS."
  warn "NADA foi instalado. Para rodar no seu Mac, compile do fonte:"
  warn "  git clone https://github.com/$REPO"
  warn "  cd ai-traffic-lights && npm install && npm run dist:mac"
  warn "  cp -R dist/mac*/\"$APP_NAME\" /Applications/"   # arm64: dist/mac-arm64/
  warn "  bash install_macos.sh   # rode de novo AQUI DENTRO para os aliases"
  die "instalação abortada — sem build macOS publicado."
fi

# --- dev mode: running inside the repo → installs Node deps ---
if [ -n "$LOCAL_REPO" ]; then
  need node; need npm
  info "modo desenvolvimento — instalando dependências Node..."
  (cd "$LOCAL_REPO" && npm install)
  ok "dependências Node instaladas"
fi

# --- idempotent aliases (marked block; without the Linux x11 flags) ---
if [ -n "$LOCAL_REPO" ]; then
  ALIAS_CMD="[ -d '/Applications/$APP_NAME' ] && open -a '$APP_TITLE' || (cd '$LOCAL_REPO' && npx electron .)"
else
  ALIAS_CMD="open -a '$APP_TITLE'"
fi
setup_profile_aliases() {
  local p="$1"
  touch "$p" 2>/dev/null || return 0
  sed -i '' '/# >>> atl >>>/,/# <<< atl <<</d' "$p" 2>/dev/null || true    # current block
  sed -i '' '/alias atl=/d;/alias ai-traffic-lights=/d' "$p" 2>/dev/null || true  # legacy format
  {
    echo '# >>> atl >>>'
    echo "alias atl=\"$ALIAS_CMD\""
    echo "alias ai-traffic-lights=\"$ALIAS_CMD\""
    echo '# <<< atl <<<'
  } >> "$p"
  ok "aliases em: $p"
}
setup_profile_aliases "$HOME/.zshrc"
[ -f "$HOME/.bash_profile" ] && setup_profile_aliases "$HOME/.bash_profile"

# The Gatekeeper tips only make sense with the .app on disk: printing them
# without an installation led the user to run xattr/codesign on a missing path.
GATEKEEPER_TIP=""
[ "$APP_INSTALLED" = 1 ] && GATEKEEPER_TIP="
  Se o macOS disser que o app \"não pôde ser aberto\" ou está \"danificado\":
    xattr -dr com.apple.quarantine \"$DEST\"
    codesign --force --deep --sign - \"$DEST\"
"

printf '\n\033[1;32m✓ Concluído!\033[0m\n\n'
cat <<EOF
  Abra um novo terminal (ou rode: source ~/.zshrc) e inicie com:
    atl
$GATEKEEPER_TIP
  Monitorar Claude Code, Antigravity, etc.: abra o app → engrenagem
  (Preferências) → "Install/update hooks".

  Opcional — melhor foco e multi-máquina:
    • tmux      — brew install tmux · o clique no semáforo foca o PAINEL exato
                  do agente (dentro do tmux), além da aba do terminal
    • Tailscale — https://tailscale.com · sincronize o overlay entre máquinas
                  (aba "Sincronização" nas Preferências, builds beta)
EOF
