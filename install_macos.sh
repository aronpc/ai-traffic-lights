#!/usr/bin/env bash

set -euo pipefail

REPO="aronpc/ai-traffic-lights"
APP_TITLE="AI Traffic Lights"
APP_NAME="AI Traffic Lights.app"
DMG_NAME="AI-Traffic-Lights.dmg"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$OS" != "Darwin" ]; then
  die "This installer is exclusive to macOS. Current OS: $OS"
fi

if [ "$ARCH" != "arm64" ]; then
  warn "Your architecture is $ARCH. This build is optimized for Apple Silicon (M1, M2, M3, M4, M5)."
fi

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew not found. Please install Homebrew at https://brew.sh and try again."
fi

if ! command -v jq >/dev/null 2>&1; then
  info "Installing dependency 'jq' via Homebrew..."
  brew install jq
  ok "'jq' successfully installed."
else
  ok "'jq' is already installed."
fi

info "Checking for the latest macOS release on GitHub..."
json=""
if ! json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API_URL")"; then
  warn "Could not connect to the GitHub API."
fi

download_url=""
if [ -n "$json" ]; then
  download_url="$(printf '%s\n' "$json" | jq -r '.assets[] | select(.name | endswith(".dmg")) | .browser_download_url' | head -1 || true)"
  version="$(printf '%s\n' "$json" | jq -r '.tag_name | sub("^v"; "")' || true)"
fi

TMP_DIR="/tmp/ai-traffic-lights-install"
rm -rf "$TMP_DIR" && mkdir -p "$TMP_DIR"
DMG_PATH="$TMP_DIR/$DMG_NAME"

if [ -n "$download_url" ] && [ "$download_url" != "null" ]; then
  info "Downloading version v${version} from: $download_url"
  curl -fSL --retry 3 -o "$DMG_PATH" "$download_url"
  ok "Download complete."
  
  info "Mounting installer and copying application to /Applications..."
  MOUNT_POINT="$TMP_DIR/mount"
  mkdir -p "$MOUNT_POINT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH"
  
  rm -rf "/Applications/${APP_NAME}.tmp"
  if cp -R "$MOUNT_POINT/$APP_NAME" "/Applications/${APP_NAME}.tmp"; then
    rm -rf "/Applications/$APP_NAME"
    mv "/Applications/${APP_NAME}.tmp" "/Applications/$APP_NAME"
    hdiutil detach "$MOUNT_POINT"
    ok "Application copied to /Applications/$APP_NAME"
  else
    hdiutil detach "$MOUNT_POINT"
    die "Failed to copy the application to /Applications."
  fi
else
  warn "No official .dmg release found on GitHub repository yet."
  warn "If compiling locally, run 'npm run dist' and copy the app to /Applications."
fi

LOCAL_REPO=""
if [ -f "package.json" ] && grep -q '"name": "ai-traffic-lights"' package.json; then
  LOCAL_REPO="$(pwd)"
fi

if [ -n "$LOCAL_REPO" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    die "Development installation detected, but 'npm' was not found. Please install Node.js and try again."
  fi
  info "Running in development mode. Installing Node.js dependencies..."
  (cd "$LOCAL_REPO" && npm install)
  ok "Node.js dependencies installed."
fi

info "Configuring aliases for quick start..."

if [ -n "$LOCAL_REPO" ]; then
  ALIAS_LINE_1="alias atl=\"[ -d '/Applications/AI Traffic Lights.app' ] && open -a '$APP_TITLE' || npm start --prefix '$LOCAL_REPO'\""
  ALIAS_LINE_2="alias ai-traffic-lights=\"[ -d '/Applications/AI Traffic Lights.app' ] && open -a '$APP_TITLE' || npm start --prefix '$LOCAL_REPO'\""
else
  ALIAS_LINE_1="alias atl=\"open -a '$APP_TITLE'\""
  ALIAS_LINE_2="alias ai-traffic-lights=\"open -a '$APP_TITLE'\""
fi

setup_profile_aliases() {
  local profile="$1"
  if [ -f "$profile" ]; then
    sed -i '' '/alias atl=/d' "$profile" 2>/dev/null || true
    sed -i '' '/alias ai-traffic-lights=/d' "$profile" 2>/dev/null || true
    
    echo "" >> "$profile"
    echo "$ALIAS_LINE_1" >> "$profile"
    echo "$ALIAS_LINE_2" >> "$profile"
    ok "Aliases added to: $profile"
  fi
}

setup_profile_aliases "$HOME/.zshrc"
setup_profile_aliases "$HOME/.bash_profile"

printf '\n\033[1;32m✓ Configuration complete!\033[0m\n\n'
cat <<EOF
  To launch the app from the terminal, open a new tab or run:
    source ~/.zshrc
  
  Then, you can start it by running:
    atl

  To enable session monitoring for Claude Code, Antigravity, etc:
    Open the application, click the gear icon (Preferences) and choose "Install/update hooks".
EOF
