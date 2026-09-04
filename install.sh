#!/usr/bin/env bash
#
# install.sh — installs and configures AI Traffic Lights (AppImage) on Linux.
#
# Usage (1 line):
#   curl -fsSL https://raw.githubusercontent.com/aronpc/ai-traffic-lights/main/install.sh | bash
#
# Or download and run:
#   bash install.sh                       # installs/upgrades to latest
#   bash install.sh --uninstall           # removes everything
#   INSTALL_DIR=~/bin bash install.sh     # custom destination directory
#   GITHUB_TOKEN=ghp_xxx bash install.sh  # avoids GitHub API rate-limit
#   ATL_PKG=deb bash install.sh           # (Debian/Ubuntu) via .deb: apt resolves deps
#
# Automatically installs missing runtime dependencies: libfuse2
# (FUSE 2, required by the classic AppImage) + Electron libs (libgbm/nss/gtk)
# + wmctrl/xdotool/jq/tmux (window/tab/pane focus and integration).
#
set -euo pipefail

REPO="aronpc/ai-traffic-lights"
APP_TITLE="AI Traffic Lights"
BIN_NAME="ai-traffic-lights"          # base for Icon=, StartupWMClass, hicolor icon and launcher
APPIMAGE_NAME="AI-Traffic-Lights.AppImage"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APPS_DIR="$HOME/.local/share/applications"
ICON_SIZES="256 512"   # hicolor sizes installed (some DEs want 256, not just 512)
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "faltando dependência: $1 (instale e tente de novo)."; }

# Escapes a path for the .desktop Exec= field (backslash on space/$/`/").
desktop_escape() { printf '%s' "$1" | sed 's/["$`]/\\&/g; s/ /\\ /g'; }

ACTION="install"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|-u) ACTION="uninstall";;
    --help|-h) sed -n '3,18p' "$0" 2>/dev/null || true; exit 0;;
    *) die "opção desconhecida: $1 (use --help)";;
  esac
  shift
done

need curl

APPIMAGE_PATH="$INSTALL_DIR/$APPIMAGE_NAME"
DESKTOP_PATH="$APPS_DIR/$BIN_NAME.desktop"
LAUNCHER_PATH="$INSTALL_DIR/$BIN_NAME"
VERSION_FILE="$INSTALL_DIR/.$BIN_NAME.version"

# ---------- package manager detection (for runtime deps) ----------
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true          # ID / ID_LIKE / VERSION_ID
PM=""
for c in apt-get dnf yum pacman zypper; do
  command -v "$c" >/dev/null 2>&1 && { PM="$c"; break; }
done
SUDO=""
{ [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"; } || true
have_lib() { ldconfig -p 2>/dev/null | grep -q "$1"; }
# apt: echoes the 1st package with an installable candidate — handles the
# t64 transition on Ubuntu 24.04+/Debian 13 (libfuse2 -> libfuse2t64 etc.)
# without hardcoding versions.
apt_pick() {
  local p out
  for p in "$@"; do
    [ -n "$p" ] || continue
    out="$(apt-cache policy "$p" 2>/dev/null)"
    case "$out" in
      *"Candidate: (none)"*) : ;;
      *"Candidate:"*) printf '%s' "$p"; return 0 ;;
    esac
  done
  return 1
}

# Installs missing runtime dependencies (non-interactive, non-fatal).
ensure_runtime_deps() {
  info "verificando dependências de runtime..."
  case "$PM" in
    apt-get)
      $SUDO apt-get update -qq 2>/dev/null || true
      local want=() p probe c1 c2 spec t
      for spec in \
        "libfuse.so.2:libfuse2t64:libfuse2" \
        "libgbm.so.1:libgbm1:" \
        "libnss3.so:libnss3:" \
        "libasound.so.2:libasound2t64:libasound2" \
        "libgtk-3.so.0:libgtk-3-0t64:libgtk-3-0"; do
        IFS=: read -r probe c1 c2 <<< "$spec"
        have_lib "$probe" && continue
        p="$(apt_pick "$c1" "$c2" || true)"
        [ -n "$p" ] && want+=("$p")
      done
      for t in wmctrl xdotool jq tmux; do command -v "$t" >/dev/null 2>&1 || want+=("$t"); done
      if [ "${#want[@]}" -gt 0 ]; then
        info "instalando: ${want[*]}"
        DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y "${want[@]}" \
          || warn "algumas dependências não instalaram — se o app não abrir, veja o smoke test."
      else
        ok "dependências de runtime já presentes"
      fi
      ;;
    dnf|yum)
      $SUDO "$PM" install -y fuse-libs mesa-libgbm nss alsa-lib gtk3 wmctrl xdotool jq tmux \
        || warn "não instalei tudo — instale fuse-libs/mesa-libgbm/nss/gtk3 se o app não abrir."
      ;;
    pacman)
      # -S --needed (no -Sy): -Sy alone is a partial upgrade (syncs the index
      # without updating the system), an anti-pattern documented by Arch itself
      # as able to install incompatible libs. We assume the index is already
      # updated (PR-32 #31).
      $SUDO pacman -S --noconfirm --needed fuse2 mesa nss alsa-lib gtk3 wmctrl xdotool jq tmux \
        || warn "não instalei tudo — instale fuse2/mesa/nss/gtk3 se o app não abrir."
      ;;
    zypper)
      $SUDO zypper --non-interactive install libfuse2 Mesa-libgbm1 mozilla-nss libasound2 gtk3 wmctrl xdotool jq tmux \
        || warn "não instalei tudo — instale libfuse2/Mesa-libgbm1/mozilla-nss se o app não abrir."
      ;;
    *)
      warn "gerenciador de pacotes não reconhecido. Se o app não abrir, instale manualmente a lib FUSE 2 (libfuse2) e as libs do Electron (libgbm, nss, gtk3)."
      ;;
  esac
}

# Cheap smoke test (ldconfig only, doesn't open the GUI): checks FUSE + the
# Chromium critical libs. Not fatal — the launcher has a FUSE-less fallback.
smoke_test() {
  if have_lib 'libfuse\.so\.2'; then
    ok "smoke test: FUSE 2 presente"
  else
    info "libfuse2 ausente — o launcher usa --appimage-extract-and-run (roda sem FUSE; 1º start mais lento)"
  fi
  local l miss=""
  for l in libgbm.so.1 libnss3.so libasound.so.2 libgtk-3.so.0; do
    have_lib "$l" || miss+="$l "
  done
  [ -n "$miss" ] && warn "libs do Electron possivelmente ausentes: ${miss}— o app pode não abrir; instale-as pelo gerenciador da sua distro."
  return 0
}

# Verifies the integrity (sha512) of the downloaded file. Only a confirmed 404
# on the sidecar enables the legacy fallback via latest-linux.yml; network/TLS
# failure, unexpected HTTP status or malformed body abort.
verify_checksum() {
  local file="$1" asset_url="$2" yml yml_url base expected actual
  base="$(basename "${asset_url%%\?*}")"
  # Tier 0: the <file>.sha512 sidecar published by release.sh. It's the
  # preferred path because it doesn't depend on the electron-builder format
  # nor on which target was built — macOS lost latest-mac.yml when the build
  # stopped generating the zip (ArchiveTarget only emits update info for `zip`).
  # URL WITHOUT query string: the `base` right below already anticipates one,
  # and "…AppImage?token=x.sha512" would 404 — silently skipping tier 0.
  local sc_body sc_code
  sc_body="$(mktemp)"
  sc_code="$(curl -sSL --connect-timeout 15 --max-time 30 \
    -o "$sc_body" -w '%{http_code}' "${asset_url%%\?*}.sha512" 2>/dev/null)" || sc_code="000"
  if [ "$sc_code" = "200" ]; then
    expected="$(tr -d '\r\n' < "$sc_body")"
    rm -f "$sc_body"
    [[ "$expected" =~ ^[A-Za-z0-9+/]{86}==$ ]] \
      || die "sidecar .sha512 chegou com conteúdo inválido (HTTP 200, ${#expected} bytes). Abortando em vez de instalar sem verificação."
  elif [ "$sc_code" = "404" ]; then
    rm -f "$sc_body"
    yml_url="${asset_url%/*}/latest-linux.yml"
    yml="$(curl -fsSL --connect-timeout 15 --max-time 60 "$yml_url" 2>/dev/null)" \
      || { info "sem sidecar .sha512 nem latest-linux.yml — pulei a verificação de integridade"; return 0; }
    # `|| :` on each attempt: under set -euo pipefail a grep with no match kills
    # the script HERE, without a message, and the tiers below become dead code.
    # Same danger install_macos.sh already handled (finding #2 of the PR-46 review).
    expected="$(printf '%s\n' "$yml" | grep -F -A3 "url: $base" | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
    [ -n "$expected" ] || expected="$(printf '%s\n' "$yml" | grep -oE '^sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  else
    rm -f "$sc_body"
    die "não foi possível buscar o sidecar .sha512 (HTTP ${sc_code}). Abortando em vez de instalar sem verificação."
  fi
  [ -n "$expected" ] || { info "sha512 não encontrado p/ $base — pulei a verificação"; return 0; }
  if command -v openssl >/dev/null 2>&1; then
    actual="$(openssl dgst -sha512 -binary "$file" 2>/dev/null | base64 | tr -d '\n')"
  elif command -v sha512sum >/dev/null 2>&1 && command -v xxd >/dev/null 2>&1; then
    actual="$(sha512sum "$file" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')"
  else
    info "sem openssl/xxd — pulei a verificação de integridade"; return 0
  fi
  if [ "$actual" = "$expected" ]; then
    ok "integridade verificada (sha512)"
  else
    die "checksum NÃO confere ($base) — download corrompido ou adulterado. Abortei."
  fi
}

# Installs via .deb (Debian/Ubuntu, opt-in ATL_PKG=deb): apt resolves the
# Depends automatically and the app runs from /opt WITHOUT FUSE. Does NOT
# auto-update via electron-updater — updates now happen via apt / re-running
# this script.
install_via_deb() {
  local f; f="$(mktemp "${TMPDIR:-/tmp}/atl-XXXXXX.deb")"
  info "baixando .deb e instalando via apt (resolve dependências automaticamente)..."
  curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$f" "$deb_url" \
    || { rm -f "$f"; die "falha ao baixar o .deb."; }
  verify_checksum "$f" "$deb_url"
  if $SUDO apt-get install -y "$f"; then
    rm -f "$f"
    ok "instalado via .deb — apt resolveu as dependências (abre pelo menu, roda sem FUSE)."
  else
    rm -f "$f"
    die "apt-get install do .deb falhou."
  fi
}

# ----------------------------- uninstall -----------------------------
if [ "$ACTION" = "uninstall" ]; then
  info "removendo $APP_TITLE..."
  # Installed via .deb (ATL_PKG=deb)? The deb package is NOT covered by the
  # removal of the AppImage artifacts below — without this, --uninstall left
  # the dpkg package installed while still printing "removido" (PR-32 #32).
  if command -v dpkg >/dev/null 2>&1; then
    DEB_PKG="$(dpkg-query -W -f='${Package}\n' 2>/dev/null | grep -iE 'ai-traffic-lights|aitrafficlights' | head -1 || true)"
    if [ -n "$DEB_PKG" ]; then
      info "instalação via .deb detectada (pacote $DEB_PKG) — removendo via apt..."
      $SUDO apt-get remove --purge -y "$DEB_PKG" 2>/dev/null || $SUDO dpkg -r "$DEB_PKG" 2>/dev/null \
        || warn "não consegui remover o pacote deb $DEB_PKG (faça: sudo apt-get remove $DEB_PKG)"
    fi
  fi
  rm -f "$APPIMAGE_PATH" "$DESKTOP_PATH" "$LAUNCHER_PATH" "$VERSION_FILE"
  rm -f "$HOME/.config/autostart/$BIN_NAME.desktop"        # autostart created by the app itself
  for sz in $ICON_SIZES; do rm -f "$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps/$BIN_NAME.png"; done
  if [ -f /etc/systemd/system/atl-agent.service ]; then     # headless agent (P2P sync), if installed
    $SUDO systemctl disable --now atl-agent 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/atl-agent.service
    $SUDO systemctl daemon-reload 2>/dev/null || true
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache  >/dev/null 2>&1 && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
  ok "removido (app + autostart + agente). Dados em ~/.local/share/ai-traffic-lights foram preservados."
  exit 0
fi

# ----------------------------- install -------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) : ;;
  aarch64|arm64) die "ainda não há build arm64 publicado — use um host x86_64 ou 'npm run dist' local." ;;
  *) die "arquitetura não suportada: $ARCH" ;;
esac

umask 022
mkdir -p "$INSTALL_DIR" "$APPS_DIR" || die "não consegui criar $INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR não é gravável (rode sem sudo, ou ajuste INSTALL_DIR)."

# temp file cleanup on any exit (an interrupted download leaves no garbage)
TMP_NEW=""
cleanup() { [ -n "$TMP_NEW" ] && rm -f "$TMP_NEW" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# --- query the latest release (optional token, timeout, clear rate-limit error) ---
info "consultando a versão mais recente..."
GH_ERR="$(mktemp)"; TMP_NEW="$GH_ERR"
gh_auth=()
[ -n "${GITHUB_TOKEN:-}" ] && gh_auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
if ! json="$(curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 60 \
      -H 'Accept: application/vnd.github+json' "${gh_auth[@]}" "$API_URL" 2>"$GH_ERR")"; then
  rate=0; grep -qi 'rate limit\|API rate' "$GH_ERR" 2>/dev/null && rate=1
  rm -f "$GH_ERR"; TMP_NEW=""
  [ "$rate" = 1 ] && die "rate-limit da API do GitHub (60/h sem token). Rode: GITHUB_TOKEN=ghp_xxx bash install.sh"
  die "falha ao consultar o GitHub (rede/API indisponível). Tente novamente em instantes."
fi
rm -f "$GH_ERR"; TMP_NEW=""

if command -v jq >/dev/null 2>&1; then
  download_url="$(printf '%s' "$json" | jq -r '.assets[].browser_download_url | select(endswith(".AppImage"))' | head -1)" || true
  version="$(printf '%s' "$json" | jq -r '.tag_name // ""' | sed 's/^v//')" || true
else
  download_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.AppImage"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
  version="$(printf '%s\n' "$json" | grep -oE '"tag_name":[[:space:]]*"v[^"]+"' | head -1 | sed -E 's/.*"v([^"]+)"$/\1/')" || true
fi

# .deb asset (for the opt-in ATL_PKG=deb path)
if command -v jq >/dev/null 2>&1; then
  deb_url="$(printf '%s' "$json" | jq -r '.assets[].browser_download_url | select(endswith(".deb"))' | head -1)" || true
else
  deb_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.deb"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
fi
info "versão mais recente: v${version:-?}"

# opt-in .deb path: on Debian/Ubuntu apt resolves dependencies natively
# and the app runs without FUSE. The default remains the AppImage
# (auto-updatable).
if [ "${ATL_PKG:-}" = "deb" ]; then
  [ "$PM" = "apt-get" ] || die "ATL_PKG=deb requer apt (Debian/Ubuntu). Gerenciador detectado: ${PM:-nenhum}."
  [ -n "$deb_url" ] || die "não encontrei o asset .deb no release latest do $REPO."
  install_via_deb
  exit 0
fi

[ -n "$download_url" ] || die "não encontrei o asset .AppImage no release latest do $REPO."

# idempotency: already on the latest version and binary present → nothing to do
if [ -f "$VERSION_FILE" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$version" ] && [ -x "$APPIMAGE_PATH" ]; then
  ok "já na v$version — nada a atualizar."
  exit 0
fi

# --- preflight: install missing runtime dependencies ---
ensure_runtime_deps

# --- atomic download ---
info "baixando AppImage -> $APPIMAGE_PATH"
TMP_NEW="$APPIMAGE_PATH.new"
curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$TMP_NEW" "$download_url"
verify_checksum "$TMP_NEW" "$download_url"
mv -f "$TMP_NEW" "$APPIMAGE_PATH"; TMP_NEW=""
chmod +x "$APPIMAGE_PATH"
printf '%s' "$version" > "$VERSION_FILE"
ok "AppImage instalada"

# --- resilient launcher: uses FUSE if available; else --appimage-extract-and-run ---
cat > "$LAUNCHER_PATH" <<EOF
#!/usr/bin/env bash
# launcher do AI Traffic Lights — usa FUSE 2 se disponível; senão cai para
# --appimage-extract-and-run (roda sem FUSE; 1º start um pouco mais lento).
APP="$APPIMAGE_PATH"
if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec "\$APP" "\$@"
else
  exec env APPIMAGE_EXTRACT_AND_RUN=1 "\$APP" "\$@"
fi
EOF
chmod +x "$LAUNCHER_PATH"
ok "launcher criado (fallback sem FUSE embutido)"

# --- smoke test (doesn't open the window) ---
smoke_test

# --- hicolor icon ---
info "ícone hicolor (${ICON_SIZES})"
icon_ok=0
for sz in $ICON_SIZES; do
  idir="$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps"; mkdir -p "$idir"
  curl -fSL --retry 3 --connect-timeout 15 -o "$idir/$BIN_NAME.png" "$RAW_BASE/build/icon.png" 2>/dev/null && icon_ok=1 || rm -f "$idir/$BIN_NAME.png"
done
[ "$icon_ok" = 1 ] && ok "ícone instalado" || info "ícone não baixado (pode aparecer genérico no dock)"

# --- .desktop (Exec = resilient launcher; TryExec lets the DE hide a broken entry) ---
info ".desktop -> $DESKTOP_PATH"
cat > "$DESKTOP_PATH" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=${APP_TITLE}
Exec=$(desktop_escape "$LAUNCHER_PATH")
TryExec=$(desktop_escape "$LAUNCHER_PATH")
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
  Abrir:  menu de aplicativos (busque "AI Traffic Lights"), ou rode:
          ${LAUNCHER_PATH}

  Melhor foco (clicar no semáforo → pular pro terminal certo):
    • Warp   — foca a ABA exata (recomendado; funciona em Linux e macOS)
    • Tilix  — foca a aba via D-Bus
    • tmux   — foca o PAINEL do agente (já instalado por este script)
    (GNOME Terminal no Wayland não é alcançável por apps de terceiros.)

  Monitorar Claude Code, Antigravity, etc.: abra o app → engrenagem
  (Preferências) → "Install/update hooks". Sem o hook, nenhuma sessão
  aparece no overlay.

  Opcional — sincronizar o overlay entre máquinas:
    • Tailscale (https://tailscale.com): conecte as máquinas na mesma
      tailnet e ative a aba "Sincronização" nas Preferências (builds beta).

  O app se AUTO-ATUALIZA (AppImage): avisa quando há versão nova e baixa +
  reinicia pela própria interface — sem refazer este install.

  Debian/Ubuntu: se preferir o pacote nativo (apt resolve as deps, roda sem
  FUSE — porém sem auto-update), rode:  ATL_PKG=deb bash install.sh

  Remover:  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall
EOF
