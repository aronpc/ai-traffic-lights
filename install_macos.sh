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

# Verifica a integridade (sha512) do .dmg contra o latest-mac.yml que o
# electron-builder publica no release (paridade com o install.sh Linux — PR-32
# #07: antes baixava o .dmg sem nenhuma verificação). Best-effort: sem yml/sha512
# ou openssl, prossegue com aviso (não bloqueia a instalação).
# Compara o sha512 (base64) de um arquivo com o esperado. Separada porque os
# dois tiers — sidecar e yml — terminam no mesmo lugar.
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
  # O GitHub codifica espaços na URL como %20, mas o electron-builder grava o
  # yml com hífens (ex: AI-Traffic-Lights-0.7.3-arm64.dmg). Decodifica %20→espaço
  # e também tenta a versão com espaços→hífens para localizar o sha512 correto.
  base_decoded="$(printf '%s' "$base" | sed 's/%20/ /g')"

  # Tier 0: o sidecar <arquivo>.sha512 publicado pelo release.sh. É o caminho
  # preferido e o MESMO nos dois instaladores: não depende do formato do
  # electron-builder, nem do nome do arquivo dentro do yml, nem de qual target
  # foi construído. Importa aqui porque o build do macOS deixou de gerar o zip,
  # e o latest-mac.yml só sai com ele (ArchiveTarget: isWriteUpdateInfo && zip).
  # URL SEM query string: o `base` logo abaixo já antecipa que ela pode ter uma,
  # e "…AppImage?token=x.sha512" daria 404 — pulando o tier 0 em silêncio.
  expected="$(curl -fsSL --connect-timeout 15 --max-time 30 "${asset_url%%\?*}.sha512" 2>/dev/null | tr -d '\r\n')" || expected=""
  # Só aceita a forma exata de um sha512 em base64 (88 chars, termina em '=='):
  # um sidecar truncado, uma página de portal cativo ou um erro de proxy viraria
  # `expected` com lixo — e como o tier 0 curto-circuita o tier 1, o instalador
  # mataria a instalação de um artefato íntegro com "adulterado".
  [[ "$expected" =~ ^[A-Za-z0-9+/]{86}==$ ]] || expected=""
  if [ -n "$expected" ]; then
    compara_checksum "$file" "$expected" "$base"; return $?
  fi

  yml_url="${asset_url%/*}/latest-mac.yml"
  yml="$(curl -fsSL --connect-timeout 15 --max-time 60 "$yml_url" 2>/dev/null)" \
    || { warn "sem sidecar .sha512 nem latest-mac.yml — pulei a verificação de integridade"; return 0; }
  # Tenta: nome decodificado, depois nome com espaços→hífens, depois qualquer .dmg no yml.
  # `|| :` em cada tentativa: sob `set -euo pipefail` um grep sem match derrubaria o
  # script ANTES de atingir o fallback — o best-effort prometido pela função não
  # poderia nunca disparar (PR-46 review #2). A falha vira expected vazio → cai p/ o
  # próximo tier ou p/ o aviso "sha512 não encontrado".
  local base_hyphens; base_hyphens="$(printf '%s' "$base_decoded" | tr ' ' '-')"
  expected="$(printf '%s\n' "$yml" | grep -F -A3 "url: $base_hyphens" | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  if [ -z "$expected" ]; then
    expected="$(printf '%s\n' "$yml" | grep -F -A3 "url: $base_decoded" | grep -oE 'sha512:[[:space:]]*[A-Za-z0-9+/=]+' | head -1 | sed -E 's/^sha512:[[:space:]]*//')" || :
  fi
  if [ -z "$expected" ]; then
    # Fallback: pega o sha512 associado a qualquer entrada .dmg no yml
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
need curl   # hdiutil/ditto/xattr/codesign/lipo/sed são nativos do macOS; jq é verificado abaixo

# O hook de eventos que o app instala (traffic-hook.sh) REQUER jq para gravar o
# state de cada sessão — e jq não vem de fábrica no macOS. Sem ele o hook roda
# em todo tool call, falha na escrita e o overlay fica silenciosamente vazio.
# Instalamos via Homebrew quando dá; sem brew, aviso forte com o comando manual.
ensure_jq() {
  # command -v aprova um jq quebrado (shim corrompido): sonda executabilidade.
  if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1; then
    ok "jq presente (o hook de eventos exige)"
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    info "instalando jq via Homebrew (o hook de eventos exige)..."
    # Re-checa o PATH pós-install: brew via wrapper pode linkar fora do PATH.
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
      -H 'Accept: application/vnd.github+json' "${gh_auth[@]+"${gh_auth[@]}"}" "$API_URL" 2>"$GH_ERR")"; then
  rate=0; grep -qi 'rate limit\|API rate' "$GH_ERR" 2>/dev/null && rate=1
  rm -f "$GH_ERR"
  [ "$rate" = 1 ] && die "rate-limit da API do GitHub (60/h sem token). Rode: GITHUB_TOKEN=ghp_xxx bash install_macos.sh"
  die "falha ao consultar o GitHub (rede/API indisponível). Tente novamente em instantes."
fi
rm -f "$GH_ERR"

download_url="$(printf '%s\n' "$json" | grep -oE '"browser_download_url":[[:space:]]*"[^"]+\.dmg"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')" || true
version="$(printf '%s\n' "$json" | grep -oE '"tag_name":[[:space:]]*"v?[^"]+"' | head -1 | sed -E 's/.*"v?([^"]+)"$/\1/')" || true

# Detecta o modo dev ANTES de decidir o que fazer sem .dmg: dentro do repo a
# ausência do build é tolerável (o alias cai para 'npx electron .'); via
# curl|bash não é — sem app instalado o alias aponta para o vazio.
LOCAL_REPO=""
if [ -f "package.json" ] && grep -q '"name": "ai-traffic-lights"' package.json 2>/dev/null; then
  LOCAL_REPO="$(pwd)"
fi

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
APP_INSTALLED=0
if [ -n "$download_url" ] && [ "$download_url" != "null" ]; then
  info "baixando v${version:-?}..."
  curl -fSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -o "$DMG_PATH" "$download_url"
  verify_checksum "$DMG_PATH" "$download_url"
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
  APP_INSTALLED=1

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
elif [ -n "$LOCAL_REPO" ]; then
  # Dentro do repo há plano B: o alias cai para 'npx electron .', que roda sem
  # o .app. Seguimos para instalar deps e escrever os aliases.
  warn "nenhum .dmg no release ${version:+v$version }do GitHub — seguindo em modo desenvolvimento."
  warn "Para gerar o .app: npm run dist:mac (o bundle sai em dist/)."
else
  # Via curl|bash NÃO há plano B: sem .dmg nada foi instalado. Falhar aqui é o
  # que impede o script de gravar aliases órfãos e imprimir "✓ Concluído!" —
  # o usuário seguia as dicas de xattr/codesign e batia em "No such file".
  # Paridade com o install.sh do Linux, que já morre sem o asset .AppImage.
  printf '\n' >&2
  warn "o release ${version:+v$version }de $REPO não publica .dmg para macOS."
  warn "NADA foi instalado. Para rodar no seu Mac, compile do fonte:"
  warn "  git clone https://github.com/$REPO"
  warn "  cd ai-traffic-lights && npm install && npm run dist:mac"
  warn "  cp -R dist/mac*/\"$APP_NAME\" /Applications/"   # arm64: dist/mac-arm64/
  warn "  bash install_macos.sh   # rode de novo AQUI DENTRO para os aliases"
  die "instalação abortada — sem build macOS publicado."
fi

# --- modo dev: rodando dentro do repo → instala deps Node ---
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

# As dicas de Gatekeeper só fazem sentido com o .app no disco: imprimi-las sem
# instalação levava o usuário a rodar xattr/codesign num path inexistente.
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
