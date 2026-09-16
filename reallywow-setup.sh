#!/usr/bin/env bash
# reallywow-setup.sh — one-time setup for thereallywow-project
set -e

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓ $*${RESET}"; }
info() { echo -e "${YELLOW}  → $*${RESET}"; }
err()  { echo -e "${RED}  ✗ $*${RESET}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "\n${BOLD}╔══════════════════════════════════════╗"
echo -e "║   Really Wow — Device Control Setup  ║"
echo -e "╚══════════════════════════════════════╝${RESET}\n"

# ── Detect platform ────────────────────────────────────────────────────────────
if [ -d /data/data/com.termux ]; then
  PLATFORM=termux
  PKG=pkg
  BIN_DIR="$PREFIX/bin"
  BOOT_DIR="$HOME/.termux/boot"
elif command -v apt-get &>/dev/null; then
  PLATFORM=linux
  PKG="sudo apt-get install -y"
  BIN_DIR="/usr/local/bin"
elif command -v brew &>/dev/null; then
  PLATFORM=macos
  PKG="brew install"
  BIN_DIR="/usr/local/bin"
else
  PLATFORM=unknown
  BIN_DIR="/usr/local/bin"
fi
info "Platform: $PLATFORM"

# ── Install system dependencies ────────────────────────────────────────────────
info "Checking dependencies..."

install_if_missing() {
  local cmd="$1" pkg="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    info "Installing $pkg..."
    if [ "$PLATFORM" = termux ]; then
      pkg install -y "$pkg"
    elif [ "$PLATFORM" = linux ]; then
      sudo apt-get install -y "$pkg"
    elif [ "$PLATFORM" = macos ]; then
      brew install "$pkg"
    else
      echo "  Please install $pkg manually"
    fi
  fi
}

install_if_missing node nodejs
install_if_missing adb android-tools
install_if_missing python3 python
install_if_missing magick imagemagick

ok "System dependencies ready"

# ── npm install ────────────────────────────────────────────────────────────────
info "Installing Node packages..."
npm install --silent
ok "Node packages installed"

# ── Configure ADB device ───────────────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
  info "Existing config: ADB_DEVICE=$ADB_DEVICE"
  read -r -p "  Keep this device? [Y/n]: " keep
  if [[ "$keep" =~ ^[Nn] ]]; then
    unset ADB_DEVICE
  fi
fi

if [ -z "$ADB_DEVICE" ]; then
  echo ""
  echo -e "${BOLD}  ADB Device Setup${RESET}"
  echo "  Find your device IP in: Settings → About → Status"
  echo "  Make sure 'Wireless Debugging' is enabled and port is noted."
  echo ""
  read -r -p "  Enter ADB device (IP:PORT, e.g. 192.168.1.5:5555): " ADB_DEVICE
  [ -z "$ADB_DEVICE" ] && err "Device address required"
fi

# Write .env
cat > "$ENV_FILE" <<EOF
ADB_DEVICE=$ADB_DEVICE
MCP_MODE=http
PORT=3456
EOF
ok "Config saved to .env"

# ── Test ADB connection ────────────────────────────────────────────────────────
info "Connecting to $ADB_DEVICE..."
adb connect "$ADB_DEVICE" 2>/dev/null || true
sleep 1

if adb -s "$ADB_DEVICE" get-state 2>/dev/null | grep -q device; then
  MODEL=$(adb -s "$ADB_DEVICE" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
  ANDROID=$(adb -s "$ADB_DEVICE" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
  ok "Connected: $MODEL (Android $ANDROID)"
else
  echo ""
  echo -e "${YELLOW}  ⚠ Could not connect to $ADB_DEVICE${RESET}"
  echo "  Make sure:"
  echo "    1. Wireless Debugging is ON in developer options"
  echo "    2. Device and this machine are on the same network"
  echo "    3. You've approved the pairing/connection on device"
  echo "  You can retry later with: python reallywow.py start"
fi

# ── Termux boot script (Android only) ─────────────────────────────────────────
if [ "$PLATFORM" = termux ]; then
  if ! pkg list-installed 2>/dev/null | grep -q termux-boot; then
    info "Installing Termux:Boot for auto-start on reboot..."
    pkg install -y termux-boot 2>/dev/null || true
  fi
  mkdir -p "$BOOT_DIR"
  BOOT_SCRIPT="$BOOT_DIR/01-thereallywow.sh"
  cat > "$BOOT_SCRIPT" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
sleep 10
cd "$SCRIPT_DIR"
source .env
for i in \$(seq 1 6); do
  adb connect "\$ADB_DEVICE" >/dev/null 2>&1
  adb -s "\$ADB_DEVICE" get-state 2>/dev/null | grep -q device && break
  sleep 5
done
MCP_MODE=http PORT=3456 node "$SCRIPT_DIR/server.mjs" >> "$SCRIPT_DIR/server.log" 2>&1 &
echo \$! > "$SCRIPT_DIR/server.pid"
BOOT
  chmod +x "$BOOT_SCRIPT"
  ok "Auto-start on boot: $BOOT_SCRIPT"
fi

# ── Install reallywow command ──────────────────────────────────────────────────
SYMLINK="$BIN_DIR/reallywow"
if [ -w "$BIN_DIR" ] || [ "$PLATFORM" = termux ]; then
  ln -sf "$SCRIPT_DIR/reallywow.py" "$SYMLINK" 2>/dev/null && \
    chmod +x "$SCRIPT_DIR/reallywow.py" && \
    ok "Command installed: reallywow" || \
    info "Could not install global command (run: python reallywow.py)"
else
  info "Run manually: python reallywow.py"
fi

# ── Start server ───────────────────────────────────────────────────────────────
info "Starting MCP server..."
python3 "$SCRIPT_DIR/reallywow.py" start

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════╗"
echo -e "║           Setup Complete! 🎉          ║"
echo -e "╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Usage:${RESET}"
echo -e "    python reallywow.py              ${YELLOW}# interactive mode${RESET}"
echo -e "    python reallywow.py screenshot   ${YELLOW}# capture screen${RESET}"
echo -e "    python reallywow.py shell whoami ${YELLOW}# root shell${RESET}"
echo -e "    python reallywow.py stream       ${YELLOW}# live video URL${RESET}"
echo -e "    python reallywow.py status       ${YELLOW}# server status${RESET}"
echo ""
