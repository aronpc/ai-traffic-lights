#!/usr/bin/env bash
#
# install.sh — instala e configura o AI Traffic Lights (AppImage) no Linux.
#
# Uso (1 linha):
#   curl -fsSL https://raw.githubusercontent.com/aronpc/ai-traffic-lights/main/install.sh | bash
#
# Ou baixe e rode:
#   bash install.sh                # instala/atualiza para o latest
#   bash install.sh --uninstall    # remove tudo
#   INSTALL_DIR=~/bin bash install.sh   # diretório de destino custom
#
set -euo pipefail

REPO="aronpc/ai-traffic-lights"
APP_TITLE="AI Traffic Lights"
BIN_NAME="ai-traffic-lights"          # base p/ Icon=, StartupWMClass e ícone hicolor
APPIMAGE_NAME="AI-Traffic-Lights.AppImage"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APPS_DIR="$HOME/.local/share/applications"
ICON_SIZE="512"
ICON_DIR="$HOME/.local/share/icons/hicolor/${ICON_SIZE}x${ICON_SIZE}/apps"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "faltando dependência: $1 (instale e tente de novo)."; }

# Escapa um caminho pro campo Exec= do .desktop (backslash em espaço/$/`/").
desktop_escape() { printf '%s' "$1" | sed 's/["$`]/\\&/g; s/ /\\ /g'; }

ACTION="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|-u) ACTION="uninstall";;
    --help|-h) sed -n '3,13p' "$0" 2>/dev/null || true; exit 0;;
    *) die "opção desconhecida: $1 (use --help)";;
  esac
  shift
done

need curl

APPIMAGE_PATH="$INSTALL_DIR/$APPIMAGE_NAME"
DESKTOP_PATH="$APPS_DIR/$BIN_NAME.desktop"
ICON_PATH="$ICON_DIR/$BIN_NAME.png"

# ----------------------------- uninstall -----------------------------
if [ "$ACTION" = "uninstall" ]; then
  info "removendo $APP_TITLE..."
  rm -f "$APPIMAGE_PATH" "$DESKTOP_PATH" "$ICON_PATH"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
  ok "removido. (autostart manual, se ativado, fica em ~/.config/autostart/$BIN_NAME.desktop)"
  exit 0
fi

# ----------------------------- install -------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) : ;;
  aarch64|arm64) die "ainda não há build arm64 publicado — use um host x86_64 ou 'npm run dist' local." ;;
  *) die "arquitetura não suportada: $ARCH" ;;
esac

info "consultando a versão mais recente..."
json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API_URL")"
download_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.AppImage"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
version="$(printf '%s\n' "$json" | grep -oE '"tag_name":[[:space:]]*"v[^"]+"' | head -1 | sed -E 's/.*"v([^"]+)"$/\1/')"
[ -n "$download_url" ] || die "não encontrei o asset .AppImage no release latest do $REPO."
info "versão mais recente: v${version:-?}"

mkdir -p "$INSTALL_DIR" "$APPS_DIR" "$ICON_DIR"

info "baixando AppImage -> $APPIMAGE_PATH"
curl -fSL --retry 3 -o "$APPIMAGE_PATH.new" "$download_url"
mv -f "$APPIMAGE_PATH.new" "$APPIMAGE_PATH"
chmod +x "$APPIMAGE_PATH"
ok "AppImage instalada"

info "ícone -> $ICON_PATH"
if curl -fSL --retry 3 -o "$ICON_PATH" "$RAW_BASE/build/icon.png" 2>/dev/null; then
  ok "ícone instalado"
else
  rm -f "$ICON_PATH"
  info "ícone não baixado (o app funciona; pode aparecer genérico no dock)"
fi

info ".desktop -> $DESKTOP_PATH"
cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_TITLE}
Exec=$(desktop_escape "$APPIMAGE_PATH")
Icon=${BIN_NAME}
Categories=Utility;System;
Terminal=false
StartupWMClass=${BIN_NAME}
Comment=Traffic light overlay for terminal AI agent sessions
EOF
ok ".desktop criado (Icon + StartupWMClass casando o WM_CLASS real)"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

printf '\n\033[1;32m✓ Instalado.\033[0m %s v%s\n\n' "$APP_TITLE" "${version:-?}"
cat <<EOF
  Abrir:  menu de aplicativos (busque "AI Traffic Lights"), ou diretamente:
          ${APPIMAGE_PATH}

  O app se AUTO-ATUALIZA (AppImage): ele avisa quando há versão nova e
  baixa + reinicia pela própria interface — sem refazer este install.

  Remover:  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall
EOF
