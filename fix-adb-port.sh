#!/usr/bin/env bash
# fix-adb-port.sh — one-time root setup: locks ADB to a fixed TCP port forever
#
# Usage:
#   bash fix-adb-port.sh                        # uses ADB_DEVICE from .env
#   bash fix-adb-port.sh 172.18.71.77:38143     # specify current (temporary) address
#   bash fix-adb-port.sh 172.18.71.77:38143 5555  # specify current addr + desired fixed port
#
# After this runs:
#   adb connect <DEVICE_IP>:5555  works forever (survives reboots)
#   thereallywow.py connect <DEVICE_IP>:5555  updates .env + tells server

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; CYAN="\033[36m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓ $*${RESET}"; }
info() { echo -e "${CYAN}  → $*${RESET}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${RESET}"; }
err()  { echo -e "${RED}  ✗ $*${RESET}"; exit 1; }

# Load .env
[ -f "$SCRIPT_DIR/.env" ] && source "$SCRIPT_DIR/.env"

CURRENT="${1:-$ADB_DEVICE}"
FIXED_PORT="${2:-5555}"

[ -z "$CURRENT" ] && err "No device address. Run: bash fix-adb-port.sh <IP:PORT>"

DEVICE_IP="${CURRENT%%:*}"
[ -z "$DEVICE_IP" ] && err "Could not parse IP from: $CURRENT"

echo -e "\n${BOLD}  Fix ADB Port — Set It and Forget It${RESET}"
echo -e "  Current : ${CYAN}$CURRENT${RESET}"
echo -e "  Fixed   : ${CYAN}${DEVICE_IP}:${FIXED_PORT}${RESET}\n"

# Step 1: Connect to current address
info "Connecting to $CURRENT…"
adb connect "$CURRENT" 2>/dev/null || true
sleep 1

adb -s "$CURRENT" get-state 2>/dev/null | grep -q device || {
  warn "Could not connect to $CURRENT"
  warn "Enable Wireless Debugging, get current IP:PORT, and re-run:"
  warn "  bash fix-adb-port.sh <IP:PORT>"
  exit 1
}
ok "Connected: $CURRENT"

# Step 2: Set fixed TCP port via root
info "Setting fixed ADB port $FIXED_PORT via root…"
adb -s "$CURRENT" shell "su -c 'setprop service.adb.tcp.port $FIXED_PORT; stop adbd; start adbd'" 2>/dev/null || \
adb -s "$CURRENT" shell "su 0 setprop service.adb.tcp.port $FIXED_PORT" 2>/dev/null || true
sleep 2
ok "adbd restarted on port $FIXED_PORT"

# Step 3: Install Magisk service.d boot script (survives reboot)
info "Installing Magisk boot script for persistence…"
BOOT_SCRIPT='#!/system/bin/sh\n# Auto-start ADB on fixed port\nsetprop service.adb.tcp.port '"$FIXED_PORT"'\nstop adbd\nstart adbd'
adb -s "$CURRENT" shell "su -c 'mkdir -p /data/adb/service.d; printf \"$BOOT_SCRIPT\" > /data/adb/service.d/99-adb-tcp.sh; chmod 755 /data/adb/service.d/99-adb-tcp.sh'" 2>/dev/null || \
  warn "Magisk service.d write failed (may need to create manually)"

# Verify script was written
VERIFY=$(adb -s "$CURRENT" shell "su -c 'cat /data/adb/service.d/99-adb-tcp.sh 2>/dev/null || echo MISSING'" 2>/dev/null || echo "")
if echo "$VERIFY" | grep -q "MISSING\|error"; then
  warn "Boot script not confirmed. Try manually:"
  warn "  adb shell su -c 'cat > /data/adb/service.d/99-adb-tcp.sh <<EOF"
  warn "  #!/system/bin/sh"
  warn "  setprop service.adb.tcp.port $FIXED_PORT"
  warn "  stop adbd && start adbd"
  warn "  EOF'"
else
  ok "Boot script installed: /data/adb/service.d/99-adb-tcp.sh"
fi

# Step 4: Connect to fixed port
NEW_ADDR="${DEVICE_IP}:${FIXED_PORT}"
info "Connecting to fixed address $NEW_ADDR…"
sleep 1
adb connect "$NEW_ADDR" 2>/dev/null || true
sleep 1

if adb -s "$NEW_ADDR" get-state 2>/dev/null | grep -q device; then
  ok "Connected to fixed port: $NEW_ADDR"
else
  warn "Not yet reachable on $NEW_ADDR — try: adb connect $NEW_ADDR"
  warn "Or reboot device and it will listen on $FIXED_PORT automatically"
fi

# Step 5: Update .env
sed -i "s|^ADB_DEVICE=.*|ADB_DEVICE=$NEW_ADDR|" "$SCRIPT_DIR/.env"
ok ".env updated: ADB_DEVICE=$NEW_ADDR"

# Step 6: Tell running server to switch
if curl -sf "http://localhost:3456/health" >/dev/null 2>&1; then
  info "Telling server to reconnect to $NEW_ADDR…"
  RESULT=$(curl -sf -X POST "http://localhost:3456/reconnect" \
    -H "Content-Type: application/json" \
    -d "{\"device\":\"$NEW_ADDR\"}" 2>/dev/null || echo '{"ok":false}')
  echo "$RESULT" | grep -q '"ok":true' && ok "Server live-switched to $NEW_ADDR" || warn "Server reconnect: $RESULT"
fi

echo ""
echo -e "${BOLD}${GREEN}  Done!${RESET}"
echo -e "  From now on, always connect with:"
echo -e "    ${CYAN}adb connect ${NEW_ADDR}${RESET}"
echo -e "  Or if IP changes:"
echo -e "    ${CYAN}python thereallywow.py connect <NEW_IP>:${FIXED_PORT}${RESET}"
echo -e "  The port ${FIXED_PORT} is now locked permanently."
echo ""
