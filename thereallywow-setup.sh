#!/usr/bin/env bash
# thereallywow-setup.sh — one-time setup for thereallywow-project
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

# ── Preserve existing .env extras, write new core values ──────────────────────
# Read any existing custom keys (AGNES_API_KEY, MCP_API_KEY, etc.) before overwriting
EXISTING_EXTRAS=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_EXTRAS=$(grep -vE "^(ADB_DEVICE|MCP_MODE|PORT)=" "$ENV_FILE" 2>/dev/null || true)
fi

# Auto-generate MCP_API_KEY if not already set
MCP_API_KEY_VAL=$(echo "$EXISTING_EXTRAS" | grep "^MCP_API_KEY=" | cut -d= -f2-)
if [ -z "$MCP_API_KEY_VAL" ]; then
  MCP_API_KEY_VAL=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  ok "Generated server key: $MCP_API_KEY_VAL"
  EXISTING_EXTRAS=$(echo "$EXISTING_EXTRAS" | grep -v "^MCP_API_KEY=")
  EXISTING_EXTRAS="${EXISTING_EXTRAS}
MCP_API_KEY=${MCP_API_KEY_VAL}"
else
  ok "Kept existing server key"
fi

cat > "$ENV_FILE" <<EOF
ADB_DEVICE=$ADB_DEVICE
MCP_MODE=http
PORT=3456
EOF
# Append preserved extras (non-empty lines only)
echo "$EXISTING_EXTRAS" | grep -v "^$" >> "$ENV_FILE" || true
chmod 600 "$ENV_FILE"
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
  echo "  You can retry later with: python thereallywow.py start"
fi

# ── Termux:Boot scripts (Android only) ────────────────────────────────────────
if [ "$PLATFORM" = termux ]; then
  if ! pkg list-installed 2>/dev/null | grep -q termux-boot; then
    info "Installing Termux:Boot for auto-start on reboot..."
    pkg install -y termux-boot 2>/dev/null || true
  fi
  mkdir -p "$BOOT_DIR"

  cat > "$BOOT_DIR/01-adb-connect.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
sleep 5
set -a
source "$SCRIPT_DIR/.env" 2>/dev/null
set +a
adb connect "\${ADB_DEVICE:-localhost:5555}"
BOOT

  # If Ollama is installed, start it with a context window big enough for this
  # project's 45-tool schema (~3.4k tokens alone — the compiled-in 4096 default
  # leaves almost no room for actual conversation and gets silently truncated,
  # since num_ctx/keep_alive aren't settable per-request through the OpenAI-
  # compatible endpoint this server talks to) and keep it resident in RAM so a
  # paused chat doesn't pay a full model reload off phone storage on the next message.
  if command -v ollama &>/dev/null; then
    cat > "$BOOT_DIR/02-ollama-serve.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
sleep 5
export OLLAMA_CONTEXT_LENGTH="\${OLLAMA_CONTEXT_LENGTH:-8192}"
export OLLAMA_KEEP_ALIVE="\${OLLAMA_KEEP_ALIVE:-30m}"
ollama serve >> "$SCRIPT_DIR/ollama.log" 2>&1 &
BOOT
    chmod +x "$BOOT_DIR/02-ollama-serve.sh"
  fi

  cat > "$BOOT_DIR/03-mcp-server.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
sleep 10
set -a
source "$SCRIPT_DIR/.env" 2>/dev/null
set +a
export MCP_MODE="\${MCP_MODE:-http}"
export PORT="\${PORT:-3456}"
for i in \$(seq 1 6); do
  adb connect "\$ADB_DEVICE" >/dev/null 2>&1
  adb -s "\$ADB_DEVICE" get-state 2>/dev/null | grep -q device && break
  sleep 5
done
node "$SCRIPT_DIR/server.mjs" >> "$SCRIPT_DIR/server.log" 2>&1 &
echo \$! > "$SCRIPT_DIR/server.pid"
BOOT

  cat > "$BOOT_DIR/04-tunnel.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
sleep 15
set -a
source "$SCRIPT_DIR/.env" 2>/dev/null
set +a
bash "$SCRIPT_DIR/network/tunnel-start.sh" \
  --host "\${BORE_HOST:-bore.pub}" \
  --local "\${PORT:-3456}" \
  >> "$SCRIPT_DIR/network/tunnel.log" 2>&1 &
BOOT

  chmod +x "$BOOT_DIR/01-adb-connect.sh" "$BOOT_DIR/03-mcp-server.sh" "$BOOT_DIR/04-tunnel.sh"
  ok "Boot persistence installed ($(command -v ollama &>/dev/null && echo 4 || echo 3) scripts)"
fi

# ── Install thereallywow command ───────────────────────────────────────────────
SYMLINK="$BIN_DIR/thereallywow"
if [ -w "$BIN_DIR" ] || [ "$PLATFORM" = termux ]; then
  ln -sf "$SCRIPT_DIR/thereallywow.py" "$SYMLINK" 2>/dev/null && \
    chmod +x "$SCRIPT_DIR/thereallywow.py" && \
    ok "Command installed: thereallywow" || \
    info "Could not install global command (run: python3 thereallywow.py)"
else
  info "Run manually: python3 thereallywow.py"
fi

# ── Start server ───────────────────────────────────────────────────────────────
info "Starting MCP server..."
python3 "$SCRIPT_DIR/thereallywow.py" start

PORT_VAL=$(grep "^PORT=" "$ENV_FILE" | cut -d= -f2-)
PORT_VAL="${PORT_VAL:-3456}"
MCP_KEY_DISPLAY=$(grep "^MCP_API_KEY=" "$ENV_FILE" | cut -d= -f2- | cut -c1-16)

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════╗"
echo -e "║         thereallywow — ready          ║"
echo -e "╚══════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Open the control panel:${RESET}"
echo -e "    ${CYAN}http://localhost:${PORT_VAL}${RESET}"
echo ""
echo -e "  ${BOLD}Open Agnes chat:${RESET}"
echo -e "    ${CYAN}http://localhost:${PORT_VAL}/chat${RESET}"
echo -e "    ${YELLOW}(Enter your OpenClaw API key in the chat settings to connect Agnes)${RESET}"
echo ""
echo -e "  ${BOLD}Your server key${RESET} (copy this into OpenClaw):"
echo -e "    ${CYAN}${MCP_KEY_DISPLAY}...${RESET}  ${YELLOW}(full key in .env)${RESET}"
echo ""
echo -e "  ${BOLD}OpenClaw MCP config:${RESET}"
echo -e "    ${CYAN}http://localhost:${PORT_VAL}/api/openclaw-config${RESET}"
echo -e "    ${YELLOW}(Live config JSON — copy into your OpenClaw settings)${RESET}"
echo ""
