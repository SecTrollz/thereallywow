#!/usr/bin/env bash
# mesh-start.sh — Start the WireGuard mesh using wireproxy (no root, no kernel module)
#
# wireproxy runs WireGuard entirely in userspace. On Android/Termux this means:
#  - No root required for the VPN client side
#  - Routes mesh traffic through a local SOCKS5 proxy (127.0.0.1:25344)
#  - ADB connects through that proxy OR uses direct routing if tun is available
#
# For the hub/relay (Linux VPS), wg-quick is used normally.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_DIR="$SCRIPT_DIR/network/wireguard"
CONF="$WG_DIR/wg0.conf"
PROXY_CONF="$WG_DIR/wireproxy.conf"
ENV_FILE="$SCRIPT_DIR/.env"
PID_FILE="$WG_DIR/wireproxy.pid"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }

[ -f "$CONF" ] || { echo "Run network/mesh-init.sh first"; exit 1; }

# Kill existing wireproxy
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE"
fi

MESH_IP=$(grep "^Address" "$CONF" | awk '{print $3}' | cut -d/ -f1)
PRIVKEY=$(grep "^PrivateKey" "$CONF" | awk '{print $3}')
MODE=$(grep "^# Mode:" "$CONF" | awk '{print $3}' || echo "hub")

# ── Build wireproxy config ──────────────────────────────────────────────────

SOCKS5_PORT=25344

cat > "$PROXY_CONF" <<WPCFG
[Interface]
Address    = ${MESH_IP}/10
PrivateKey = ${PRIVKEY}
ListenPort = 51820

[Socks5]
BindAddress = 127.0.0.1:${SOCKS5_PORT}

WPCFG

# Copy peers from wg0.conf
awk '/^\[Peer\]/,0' "$CONF" >> "$PROXY_CONF"

chmod 600 "$PROXY_CONF"

info "Starting wireproxy mesh (SOCKS5 on :${SOCKS5_PORT})…"
nohup wireproxy -c "$PROXY_CONF" -d >> "$WG_DIR/wireproxy.log" 2>&1 &
echo $! > "$PID_FILE"
sleep 2

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  ok "wireproxy running (PID $(cat "$PID_FILE"))"
else
  warn "wireproxy failed to start — check $WG_DIR/wireproxy.log"
  exit 1
fi

# ── Write proxychains config so ADB can route through the SOCKS5 proxy ───────
#
# ADB has no native SOCKS5 support. proxychains-ng wraps any process so its
# TCP connections go through the proxy — same mechanism curl/wget use for
# corporate proxy tunneling. Install with: pkg install proxychains-ng

PROXYCHAINS_CONF="$WG_DIR/proxychains.conf"
cat > "$PROXYCHAINS_CONF" <<PCCFG
strict_chain
proxy_dns
quiet_mode
[ProxyList]
socks5 127.0.0.1 ${SOCKS5_PORT}
PCCFG

if command -v proxychains4 >/dev/null 2>&1; then
  ok "proxychains4 ready — mesh ADB routing enabled"
else
  warn "proxychains-ng not installed — install with: pkg install proxychains-ng"
  info "Without it, adb connect to mesh IPs will fail"
fi

grep -q "^WG_SOCKS5=" "$ENV_FILE" 2>/dev/null && \
  sed -i "s|^WG_SOCKS5=.*|WG_SOCKS5=127.0.0.1:${SOCKS5_PORT}|" "$ENV_FILE" || \
  echo "WG_SOCKS5=127.0.0.1:${SOCKS5_PORT}" >> "$ENV_FILE"
grep -q "^WG_PROXYCHAINS=" "$ENV_FILE" 2>/dev/null && \
  sed -i "s|^WG_PROXYCHAINS=.*|WG_PROXYCHAINS=${PROXYCHAINS_CONF}|" "$ENV_FILE" || \
  echo "WG_PROXYCHAINS=${PROXYCHAINS_CONF}" >> "$ENV_FILE"

# ── Termux:Boot persistence ─────────────────────────────────────────────────

BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"
cat > "$BOOT_DIR/02-wireproxy.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
sleep 12
wireproxy -c $PROXY_CONF -d >> $WG_DIR/wireproxy.log 2>&1 &
echo \$! > $PID_FILE
EOF
chmod +x "$BOOT_DIR/02-wireproxy.sh"
ok "Boot persistence installed"

# ── Tell server about mesh ──────────────────────────────────────────────────

curl -sf -X POST http://localhost:3456/reconnect \
  -H "Content-Type: application/json" -d "{}" >/dev/null 2>&1 && \
  ok "Server updated" || true

echo ""
echo -e "  Mesh IP  : ${CYAN}${MESH_IP}${RESET}"
echo -e "  SOCKS5   : ${CYAN}127.0.0.1:${SOCKS5_PORT}${RESET}"
echo -e "  Agnes    : ${CYAN}http://${MESH_IP}:3456/${RESET}  (from other mesh nodes)"
echo ""
echo -e "  Connect to a mesh peer:"
echo -e "    ${BOLD}proxychains4 -f ${PROXYCHAINS_CONF} adb connect <peer-mesh-ip>:5555${RESET}"
echo -e "  Or discover all peers:"
echo -e "    ${BOLD}bash network/mesh-discover.sh${RESET}"
echo ""
echo -e "  Add a device: ${BOLD}bash network/peer-add.sh --android <name>${RESET}"
echo ""
