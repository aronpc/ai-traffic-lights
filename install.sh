#!/usr/bin/env bash
#
# install.sh — instala e configura o AI Traffic Lights (AppImage) no Linux.
#
# Uso (1 linha):
#   curl -fsSL https://raw.githubusercontent.com/aronpc/ai-traffic-lights/main/install.sh | bash
#
# Ou baixe e rode:
#   bash install.sh                       # instala/atualiza para o latest
#   bash install.sh --uninstall           # remove tudo
#   INSTALL_DIR=~/bin bash install.sh     # diretório de destino custom
#   GITHUB_TOKEN=ghp_xxx bash install.sh  # evita rate-limit da API do GitHub
#
# Instala automaticamente as dependências de runtime que faltarem: libfuse2
# (FUSE 2, exigida pelo AppImage clássico) + libs do Electron (libgbm/nss/gtk)
# + wmctrl/xdotool/jq/tmux (foco de janela/aba/painel e integração).
#
set -euo pipefail

REPO="aronpc/ai-traffic-lights"
APP_TITLE="AI Traffic Lights"
BIN_NAME="ai-traffic-lights"          # base p/ Icon=, StartupWMClass, ícone hicolor e launcher
APPIMAGE_NAME="AI-Traffic-Lights.AppImage"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
APPS_DIR="$HOME/.local/share/applications"
ICON_SIZES="256 512"   # tamanhos hicolor instalados (alguns DEs querem 256, não só 512)
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "faltando dependência: $1 (instale e tente de novo)."; }

# Escapa um caminho pro campo Exec= do .desktop (backslash em espaço/$/`/").
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

# ---------- detecção do gerenciador de pacotes (p/ deps de runtime) ----------
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true          # ID / ID_LIKE / VERSION_ID
PM=""
for c in apt-get dnf yum pacman zypper; do
  command -v "$c" >/dev/null 2>&1 && { PM="$c"; break; }
done
SUDO=""
{ [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"; } || true
have_lib() { ldconfig -p 2>/dev/null | grep -q "$1"; }
# apt: ecoa o 1º pacote com candidato instalável — resolve a transição t64 do
# Ubuntu 24.04+/Debian 13 (libfuse2 -> libfuse2t64 etc.) sem hardcode de versão.
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

# Instala as dependências de runtime que faltarem (não-interativo, não-fatal).
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
      $SUDO pacman -Sy --noconfirm --needed fuse2 mesa nss alsa-lib gtk3 wmctrl xdotool jq tmux \
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

# Smoke test barato (só ldconfig, não abre a GUI): confirma FUSE + libs críticas
# do Chromium. Não é fatal — o launcher tem fallback sem FUSE.
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

# ----------------------------- uninstall -----------------------------
if [ "$ACTION" = "uninstall" ]; then
  info "removendo $APP_TITLE..."
  rm -f "$APPIMAGE_PATH" "$DESKTOP_PATH" "$LAUNCHER_PATH" "$VERSION_FILE"
  rm -f "$HOME/.config/autostart/$BIN_NAME.desktop"        # autostart criado pelo próprio app
  for sz in $ICON_SIZES; do rm -f "$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps/$BIN_NAME.png"; done
  if [ -f /etc/systemd/system/atl-agent.service ]; then     # agente headless (sync P2P), se instalado
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

# limpeza do arquivo temporário em qualquer saída (download interrompido não deixa lixo)
TMP_NEW=""
cleanup() { [ -n "$TMP_NEW" ] && rm -f "$TMP_NEW" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# --- consulta o release mais recente (token opcional, timeout, rate-limit claro) ---
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
[ -n "$download_url" ] || die "não encontrei o asset .AppImage no release latest do $REPO."
info "versão mais recente: v${version:-?}"

# idempotência: já na última versão e binário presente → nada a fazer
if [ -f "$VERSION_FILE" ] && [ "$(cat "$VERSION_FILE" 2>/dev/null)" = "$version" ] && [ -x "$APPIMAGE_PATH" ]; then
  ok "já na v$version — nada a atualizar."
  exit 0
fi

# --- preflight: instala as dependências de runtime que faltarem ---
ensure_runtime_deps

# --- download atômico ---
info "baixando AppImage -> $APPIMAGE_PATH"
TMP_NEW="$APPIMAGE_PATH.new"
curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$TMP_NEW" "$download_url"
mv -f "$TMP_NEW" "$APPIMAGE_PATH"; TMP_NEW=""
chmod +x "$APPIMAGE_PATH"
printf '%s' "$version" > "$VERSION_FILE"
ok "AppImage instalada"

# --- launcher resiliente: usa FUSE se houver; senão --appimage-extract-and-run ---
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

# --- smoke test (não abre a janela) ---
smoke_test

# --- ícone hicolor ---
info "ícone hicolor (${ICON_SIZES})"
icon_ok=0
for sz in $ICON_SIZES; do
  idir="$HOME/.local/share/icons/hicolor/${sz}x${sz}/apps"; mkdir -p "$idir"
  curl -fSL --retry 3 --connect-timeout 15 -o "$idir/$BIN_NAME.png" "$RAW_BASE/build/icon.png" 2>/dev/null && icon_ok=1 || rm -f "$idir/$BIN_NAME.png"
done
[ "$icon_ok" = 1 ] && ok "ícone instalado" || info "ícone não baixado (pode aparecer genérico no dock)"

# --- .desktop (Exec = launcher resiliente; TryExec deixa o DE esconder entrada quebrada) ---
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

  O app se AUTO-ATUALIZA (AppImage): avisa quando há versão nova e baixa +
  reinicia pela própria interface — sem refazer este install.

  Remover:  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash -s -- --uninstall
EOF
