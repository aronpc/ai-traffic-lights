#!/usr/bin/env bash
#
# install_macos.sh — instala o AI Traffic Lights (.app) no macOS.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/aronpc/ai-traffic-lights/main/install_macos.sh | bash
#   GITHUB_TOKEN=ghp_xxx bash install_macos.sh   # evita rate-limit da API do GitHub
#
# O app não é notarizado; este instalador remove a quarantine e re-assina
# ad-hoc localmente (xattr + codesign) para o Gatekeeper não bloquear.
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

OS="$(uname -s)"
ARCH="$(uname -m)"
[ "$OS" = "Darwin" ] || die "Este instalador é exclusivo do macOS. SO atual: $OS"
need curl   # hdiutil/ditto/xattr/codesign/lipo/sed são nativos do macOS; jq/brew NÃO são exigidos

# O build publicado é Apple Silicon (arm64). Em Intel, o .dmg arm64 não abre
# (Rosetta não traduz arm64→x86). Avisamos forte; a verificação pós-install
# mostra a arch real do binário.
if [ "$ARCH" != "arm64" ]; then
  warn "Seu Mac é $ARCH (Intel). O build publicado é Apple Silicon (arm64) e provavelmente NÃO abrirá."
  warn "Compile do fonte: git clone https://github.com/$REPO && cd ai-traffic-lights && npm install && npx electron-builder --mac"
fi

# --- consulta o release (token opcional, timeout, rate-limit claro; sem brew/jq) ---
info "consultando a versão mais recente..."
GH_ERR="$(mktemp)"
gh_auth=()
[ -n "${GITHUB_TOKEN:-}" ] && gh_auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
if ! json="$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
      -H 'Accept: application/vnd.github+json' "${gh_auth[@]}" "$API_URL" 2>"$GH_ERR")"; then
  rate=0; grep -qi 'rate limit\|API rate' "$GH_ERR" 2>/dev/null && rate=1
  rm -f "$GH_ERR"
  [ "$rate" = 1 ] && die "rate-limit da API do GitHub (60/h sem token). Rode: GITHUB_TOKEN=ghp_xxx bash install_macos.sh"
  die "falha ao consultar o GitHub (rede/API indisponível). Tente novamente em instantes."
fi
rm -f "$GH_ERR"

download_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.dmg"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
version="$(printf '%s\n' "$json" | grep -oE '"tag_name":[[:space:]]*"v?[^"]+"' | head -1 | sed -E 's/.*"v?([^"]+)"$/\1/')" || true

# --- diretório temporário com limpeza garantida (detach do dmg + rm) ---
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atl-install.XXXXXX")"
MOUNT_POINT="$TMP_DIR/mount"
cleanup() {
  [ -d "$MOUNT_POINT" ] && hdiutil detach -force "$MOUNT_POINT" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
DMG_PATH="$TMP_DIR/$DMG_NAME"

DEST="/Applications/$APP_NAME"
if [ -n "$download_url" ] && [ "$download_url" != "null" ]; then
  info "baixando v${version:-?}..."
  curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$DMG_PATH" "$download_url"
  ok "download completo"

  info "montando e copiando para /Applications..."
  mkdir -p "$MOUNT_POINT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH" >/dev/null

  # ditto preserva symlinks de frameworks, flags e metadados do bundle (cp -R não).
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

  # --- destrava o Gatekeeper: remove quarantine + re-assina ad-hoc LOCALMENTE ---
  # Sem isto, um app não-notarizado baixado via curl é bloqueado com
  # "app está danificado / não pôde ser aberto". O usuário já consentiu ao rodar.
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  if codesign --force --deep --sign - "$DEST" 2>/dev/null; then
    ok "quarantine removida + assinatura ad-hoc aplicada"
  else
    warn "não consegui re-assinar. Se o app não abrir, rode:"
    warn "  xattr -dr com.apple.quarantine \"$DEST\" && codesign --force --deep --sign - \"$DEST\""
  fi

  # --- verificação pós-install: arch real do binário (não abre a GUI) ---
  BIN="$DEST/Contents/MacOS/$APP_TITLE"
  if [ -f "$BIN" ]; then
    archs="$(lipo -archs "$BIN" 2>/dev/null || file -b "$BIN" 2>/dev/null || echo '?')"
    info "arquiteturas do binário: $archs"
    case "$archs" in
      *"$ARCH"*|*arm64e*) : ;;
      *) warn "o binário ($archs) não casa com seu Mac ($ARCH) — pode não abrir. Compile do fonte se necessário." ;;
    esac
  fi
else
  warn "nenhum .dmg encontrado no release do GitHub ainda."
  warn "Se estiver compilando local, rode 'npm run dist:mac' e copie o app para /Applications."
fi

# --- modo dev: rodando dentro do repo → instala deps Node ---
LOCAL_REPO=""
if [ -f "package.json" ] && grep -q '"name": "ai-traffic-lights"' package.json 2>/dev/null; then
  LOCAL_REPO="$(pwd)"
fi
if [ -n "$LOCAL_REPO" ]; then
  need node; need npm
  info "modo desenvolvimento — instalando dependências Node..."
  (cd "$LOCAL_REPO" && npm install)
  ok "dependências Node instaladas"
fi

# --- aliases idempotentes (bloco marcado; sem as flags x11 do Linux) ---
if [ -n "$LOCAL_REPO" ]; then
  ALIAS_CMD="[ -d '/Applications/$APP_NAME' ] && open -a '$APP_TITLE' || (cd '$LOCAL_REPO' && npx electron .)"
else
  ALIAS_CMD="open -a '$APP_TITLE'"
fi
setup_profile_aliases() {
  local p="$1"
  touch "$p" 2>/dev/null || return 0
  sed -i '' '/# >>> atl >>>/,/# <<< atl <<</d' "$p" 2>/dev/null || true    # bloco atual
  sed -i '' '/alias atl=/d;/alias ai-traffic-lights=/d' "$p" 2>/dev/null || true  # formato legado
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

printf '\n\033[1;32m✓ Concluído!\033[0m\n\n'
cat <<EOF
  Abra um novo terminal (ou rode: source ~/.zshrc) e inicie com:
    atl

  Se o macOS disser que o app "não pôde ser aberto" ou está "danificado":
    xattr -dr com.apple.quarantine "$DEST"
    codesign --force --deep --sign - "$DEST"

  Monitorar Claude Code, Antigravity, etc.: abra o app → engrenagem
  (Preferências) → "Install/update hooks".
EOF
