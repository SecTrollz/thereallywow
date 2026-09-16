#!/usr/bin/env bash
# mesh-discover.sh — Discover all ADB-capable devices on the thereallywow mesh
#
# Uses mDNS on the WireGuard mesh to find devices announcing ADB services,
# plus scans known mesh peers from the WireGuard config.
# Apple Bonjour equivalent — "it just works" device discovery.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_DIR="$SCRIPT_DIR/network/wireguard"
CONF="$WG_DIR/wg0.conf"
PROXYCHAINS_CONF="$WG_DIR/proxychains.conf"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"
DIM="\033[2m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }

# Use proxychains for mesh IPs if available — ADB has no native SOCKS5 support
if command -v proxychains4 >/dev/null 2>&1 && [ -f "$PROXYCHAINS_CONF" ]; then
  PADB="proxychains4 -f $PROXYCHAINS_CONF -q adb"
else
  PADB="adb"
  [ -f "$PROXYCHAINS_CONF" ] && \
    echo -e "  ${YELLOW}  ⚠${RESET} proxychains-ng not installed — mesh peers may be unreachable (pkg install proxychains-ng)"
fi

echo -e "\n${BOLD}  thereallywow mesh — Device Discovery${RESET}\n"

FOUND=0

# ── 1. ADB mDNS (Android 11+ Wireless Debugging on local LAN) ───────────────

info "Scanning for ADB wireless debugging (mDNS)…"
if adb mdns services 2>/dev/null | grep -q "adb-tls"; then
  while IFS= read -r line; do
    [[ "$line" =~ adb-tls ]] || continue
    NAME=$(echo "$line" | awk '{print $1}')
    ADDR=$(echo "$line" | awk '{print $NF}')
    ok "mDNS: $NAME → $ADDR"
    FOUND=$((FOUND + 1))
  done < <(adb mdns services 2>/dev/null)
else
  echo -e "  ${DIM}No mDNS devices found (works on same LAN only)${RESET}"
fi

# ── 2. WireGuard mesh peers ─────────────────────────────────────────────────

if [ -f "$CONF" ]; then
  info "Scanning WireGuard mesh peers…"
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*mesh\ IP:\ (100\.[0-9.]+) ]] || continue
    PEER_IP="${BASH_REMATCH[1]}"
    PEER_NAME=$(echo "$line" | sed 's/.*# //' | cut -d' ' -f1)

    # Test ADB connectivity through proxychains → wireproxy SOCKS5 → WireGuard
    if timeout 5 $PADB connect "${PEER_IP}:5555" 2>/dev/null | grep -q "connected\|already"; then
      STATE=$($PADB -s "${PEER_IP}:5555" get-state 2>/dev/null || echo "offline")
      if [ "$STATE" = "device" ]; then
        MODEL=$($PADB -s "${PEER_IP}:5555" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
        ok "Mesh: $PEER_NAME ($MODEL) → ${PEER_IP}:5555"
        FOUND=$((FOUND + 1))
      else
        echo -e "  ${DIM}Mesh: $PEER_NAME → ${PEER_IP}:5555 [${STATE}]${RESET}"
      fi
    else
      echo -e "  ${DIM}Mesh: $PEER_NAME → ${PEER_IP}:5555 [unreachable]${RESET}"
    fi
  done < "$CONF"
fi

# ── 3. Current ADB devices ──────────────────────────────────────────────────

info "Current ADB device list:"
while IFS= read -r line; do
  [[ "$line" =~ ^List ]] && continue
  [[ -z "$line" ]] && continue
  ADDR=$(echo "$line" | awk '{print $1}')
  STATE=$(echo "$line" | awk '{print $2}')
  if [ "$STATE" = "device" ]; then
    MODEL=$(adb -s "$ADDR" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
    ROOT=$(adb -s "$ADDR" shell "su -c id" 2>/dev/null | grep -q "root" && echo " [root]" || echo "")
    ok "${ADDR}  ${MODEL}${ROOT}"
    FOUND=$((FOUND + 1))
  else
    echo -e "  ${DIM}${ADDR} [${STATE}]${RESET}"
  fi
done < <(adb devices 2>/dev/null)

echo ""
if [ "$FOUND" -gt 0 ]; then
  echo -e "  ${GREEN}${FOUND} device(s) reachable${RESET}"
else
  echo -e "  ${YELLOW}No devices found${RESET}"
  echo -e "  ${DIM}Try: bash network/mesh-start.sh${RESET}"
fi
echo ""
