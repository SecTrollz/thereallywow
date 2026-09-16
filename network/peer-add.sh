#!/usr/bin/env bash
# peer-add.sh — Add a device to the thereallywow mesh
#
# Usage:
#   bash peer-add.sh <name>              # interactive (asks for pubkey if spoke)
#   bash peer-add.sh <name> <pubkey>     # non-interactive
#   bash peer-add.sh --qr-config         # print QR code for THIS device's client config
#   bash peer-add.sh --android <name>    # generate Android WireGuard APK import QR
#
# The generated peer config QR is scanned by the WireGuard Android APK or
# pasted into any WireGuard client. No manual IP configuration needed.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_DIR="$SCRIPT_DIR/network/wireguard"
PEERS_DIR="$WG_DIR/peers"
CONF="$WG_DIR/wg0.conf"
ENV_FILE="$SCRIPT_DIR/.env"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"
DIM="\033[2m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }

[ -f "$CONF" ] || { echo "Run mesh-init.sh first"; exit 1; }

mkdir -p "$PEERS_DIR"

# ── QR for THIS device's client config (import into WireGuard APK) ──────────

if [ "${1:-}" = "--qr-config" ] || [ "${1:-}" = "--android" ]; then
  NAME="${2:-android-device}"
  # Generate a keypair for the new device
  NEW_PRIV=$(wg genkey)
  NEW_PUB=$(echo "$NEW_PRIV" | wg pubkey)
  PSK=$(wg genpsk)

  # Determine hub address
  HUB_IP=$(grep "^Address" "$CONF" | awk '{print $3}' | cut -d/ -f1)
  HUB_PUB=$(cat "$WG_DIR/public.key")
  HUB_PRIV=$(cat "$WG_DIR/private.key")

  # Assign mesh IP to new device
  OCTET=$(python3 -c "import base64,hashlib; b=base64.b64decode('$NEW_PUB'); print(int.from_bytes(hashlib.sha256(b).digest()[:2],'big') % 250 + 2)")
  NEW_IP="100.64.0.${OCTET}"

  # Detect hub's endpoint (public IP)
  PUBLIC_IP=$(curl -sf --max-time 3 https://ifconfig.me 2>/dev/null || \
              curl -sf --max-time 3 https://api.ipify.org 2>/dev/null || \
              echo "YOUR_PUBLIC_IP")
  LISTEN_PORT=$(grep "^ListenPort" "$CONF" | awk '{print $3}' || echo "51820")

  # Build the client config (goes on the phone)
  CLIENT_CONF="[Interface]
Address = ${NEW_IP}/32
PrivateKey = ${NEW_PRIV}
DNS = 1.1.1.1

[Peer]
# thereallywow hub — $(hostname 2>/dev/null || echo device)
PublicKey = ${HUB_PUB}
PresharedKey = ${PSK}
Endpoint = ${PUBLIC_IP}:${LISTEN_PORT}
AllowedIPs = 100.64.0.0/10
PersistentKeepalive = 25"

  # Save peer config for later
  PEER_FILE="$PEERS_DIR/${NAME}.conf"
  cat > "$PEER_FILE" <<EOF
# Peer: $NAME
# Mesh IP: $NEW_IP
# Public key: $NEW_PUB
# Added: $(date -u '+%Y-%m-%dT%H:%MZ')
$CLIENT_CONF
EOF

  # Add peer to hub's wg0.conf
  if ! grep -q "$NEW_PUB" "$CONF"; then
    cat >> "$CONF" <<EOF

[Peer]
# $NAME — mesh IP: $NEW_IP
PublicKey           = ${NEW_PUB}
PresharedKey        = ${PSK}
AllowedIPs          = ${NEW_IP}/32
EOF
    ok "Peer added to hub config"
    # Apply live if wg0 is up
    su -c "wg addconf wg0 <(wg-quick strip $CONF)" 2>/dev/null || true
  fi

  echo ""
  echo -e "${BOLD}  Peer: $NAME${RESET}  mesh IP: ${CYAN}${NEW_IP}${RESET}"
  echo ""
  echo -e "  ${BOLD}Scan with WireGuard Android APK (F-Droid):${RESET}"
  echo ""

  # Print QR code using Python qrcode
  python3 - <<PYEOF
import qrcode, sys
qr = qrcode.QRCode(border=1)
qr.add_data("""$CLIENT_CONF""")
qr.make(fit=True)
qr.print_ascii(invert=True)
PYEOF

  echo ""
  echo -e "  ${DIM}Or copy config from: $PEER_FILE${RESET}"
  echo ""
  echo -e "  After scanning: device ${CYAN}${NAME}${RESET} reachable at ${CYAN}${NEW_IP}${RESET}"
  echo -e "  ADB:  ${BOLD}adb connect ${NEW_IP}:5555${RESET}"
  echo -e "  Web:  ${BOLD}http://${NEW_IP}:3456/${RESET}"
  echo ""
  exit 0
fi

# ── Add an existing device's pubkey as a peer ────────────────────────────────

NAME="${1:-}"
[ -z "$NAME" ] && { echo "Usage: peer-add.sh <name> [pubkey]"; exit 1; }

PEER_PUB="${2:-}"
if [ -z "$PEER_PUB" ]; then
  echo -e "\n${BOLD}  Add peer: $NAME${RESET}"
  echo -e "  On the other device, run:  ${CYAN}cat network/wireguard/public.key${RESET}"
  echo -e "  Then paste the public key below:\n"
  read -rp "  Public key: " PEER_PUB
fi

[ -z "$PEER_PUB" ] && { warn "No public key provided"; exit 1; }

# Assign mesh IP
OCTET=$(python3 -c "import base64,hashlib; b=base64.b64decode('$PEER_PUB'); print(int.from_bytes(hashlib.sha256(b).digest()[:2],'big') % 250 + 2)")
PEER_IP="100.64.0.${OCTET}"

if grep -q "$PEER_PUB" "$CONF"; then
  warn "Peer already in config"
  exit 0
fi

cat >> "$CONF" <<EOF

[Peer]
# $NAME — mesh IP: $PEER_IP
PublicKey  = ${PEER_PUB}
AllowedIPs = ${PEER_IP}/32
PersistentKeepalive = 25
EOF

# Save record
echo "NAME=$NAME PUBKEY=$PEER_PUB MESH_IP=$PEER_IP ADDED=$(date -u)" >> "$PEERS_DIR/peers.txt"

# Apply live if wg0 is up
su -c "wg set wg0 peer $PEER_PUB allowed-ips ${PEER_IP}/32 persistent-keepalive 25" 2>/dev/null && \
  ok "Peer added live to wg0" || true

ok "Peer added: $NAME → $PEER_IP"
echo -e "  ADB:  ${CYAN}adb connect ${PEER_IP}:5555${RESET}"
echo ""
