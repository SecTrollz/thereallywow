#!/usr/bin/env bash
# mesh-init.sh — Initialize the thereallywow WireGuard mesh on THIS device
#
# Architecture (Apple Back-to-My-Mac inspired):
#   • Every device = a keypair identity, never an IP address
#   • Mesh IP: 100.64.0.0/10 (IANA shared space, same range Tailscale uses)
#   • Hub-and-spoke: relay node routes between devices behind CGNAT
#   • Spoke-to-spoke: direct WireGuard when path allows
#   • Discovery: mDNS on the mesh, Agnes sees all devices by name
#
# Usage:
#   bash mesh-init.sh hub   [port]     # this device IS the relay (needs public IP)
#   bash mesh-init.sh spoke <hub_addr> # connect to existing relay
#   bash mesh-init.sh solo             # local-only (no CGNAT bypass, same LAN)
#
# After init, add devices with:  bash network/peer-add.sh
# Agnes sees the server at:      http://100.64.0.1:3456

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WG_DIR="$SCRIPT_DIR/network/wireguard"
ENV_FILE="$SCRIPT_DIR/.env"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"
CYAN="\033[36m"; DIM="\033[2m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }
err()  { echo -e "${RED}  ✗${RESET} $*" >&2; exit 1; }
dim()  { echo -e "${DIM}    $*${RESET}"; }

MODE="${1:-spoke}"
shift || true

echo -e "\n${BOLD}  thereallywow mesh — WireGuard Setup${RESET}"
echo -e "  ${DIM}Identity = keypair  |  CGNAT-proof  |  Zero config${RESET}\n"

mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

# ── Generate identity keypair ────────────────────────────────────────────────

PRIVKEY_FILE="$WG_DIR/private.key"
PUBKEY_FILE="$WG_DIR/public.key"

if [ -f "$PRIVKEY_FILE" ]; then
  warn "Keypair exists — reusing identity"
  PRIVKEY=$(cat "$PRIVKEY_FILE")
  PUBKEY=$(cat "$PUBKEY_FILE")
else
  info "Generating WireGuard keypair (your device identity)…"
  PRIVKEY=$(wg genkey)
  PUBKEY=$(echo "$PRIVKEY" | wg pubkey)
  echo "$PRIVKEY" > "$PRIVKEY_FILE"
  echo "$PUBKEY"  > "$PUBKEY_FILE"
  chmod 600 "$PRIVKEY_FILE"
  ok "Keypair generated"
fi

dim "Public key: $PUBKEY"

# ── Assign mesh IP ───────────────────────────────────────────────────────────

# Hub always gets .1, spokes get .2+ based on hash of pubkey
case "$MODE" in
  hub)  MESH_IP="100.64.0.1" ;;
  solo) MESH_IP="100.64.0.1" ;;
  spoke)
    # Derive a stable IP from the public key (deterministic)
    OCTET=$(python3 -c "import base64,hashlib; b=base64.b64decode('$PUBKEY'); print(int.from_bytes(hashlib.sha256(b).digest()[:2],'big') % 250 + 2)")
    MESH_IP="100.64.0.${OCTET}"
    ;;
esac

info "Mesh IP: ${MESH_IP}/10"

# ── Build wg0.conf ───────────────────────────────────────────────────────────

LISTEN_PORT="${1:-51820}"
CONF_FILE="$WG_DIR/wg0.conf"

case "$MODE" in
# ────────────────────── HUB (relay node) ─────────────────────────────────────
hub)
  cat > "$CONF_FILE" <<EOF
# thereallywow mesh — hub/relay node
# Generated: $(date -u '+%Y-%m-%dT%H:%MZ')
# Public key: $PUBKEY

[Interface]
Address    = ${MESH_IP}/10
ListenPort = ${LISTEN_PORT}
PrivateKey = ${PRIVKEY}

# PostUp/PostDown: enable IP forwarding so spokes reach each other
PostUp   = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o wlan+ -j MASQUERADE; iptables -t nat -A POSTROUTING -o eth+ -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o wlan+ -j MASQUERADE; iptables -t nat -D POSTROUTING -o eth+ -j MASQUERADE

# Peers added with: bash network/peer-add.sh
EOF
  ok "Hub config written"
  echo ""
  echo -e "${BOLD}  → Next steps for hub:${RESET}"
  dim "1. Make sure UDP port ${LISTEN_PORT} is open on this machine's firewall"
  dim "2. Note your public IP: $(curl -sf https://ifconfig.me 2>/dev/null || echo 'run: curl ifconfig.me')"
  dim "3. Start mesh:  bash network/mesh-start.sh"
  dim "4. Add devices: bash network/peer-add.sh <device-name>"
  ;;

# ────────────────────── SPOKE (client) ───────────────────────────────────────
spoke)
  HUB_ADDR="${1:-}"
  [ -z "$HUB_ADDR" ] && err "Usage: mesh-init.sh spoke <hub_public_ip:port> <hub_public_key>"
  HUB_PUBKEY="${2:-}"
  [ -z "$HUB_PUBKEY" ] && err "Need hub public key as 3rd argument. Get it from hub with: cat network/wireguard/public.key"

  cat > "$CONF_FILE" <<EOF
# thereallywow mesh — spoke (client) node
# Generated: $(date -u '+%Y-%m-%dT%H:%MZ')
# Public key: $PUBKEY

[Interface]
Address    = ${MESH_IP}/32
PrivateKey = ${PRIVKEY}
DNS        = 1.1.1.1

[Peer]
# Hub / relay
PublicKey           = ${HUB_PUBKEY}
Endpoint            = ${HUB_ADDR}
AllowedIPs          = 100.64.0.0/10
PersistentKeepalive = 25
EOF
  ok "Spoke config written → relay: $HUB_ADDR"
  ;;

# ────────────────────── SOLO (no relay, LAN only) ─────────────────────────────
solo)
  cat > "$CONF_FILE" <<EOF
# thereallywow mesh — solo node (same-LAN only)
# Generated: $(date -u '+%Y-%m-%dT%H:%MZ')
# Public key: $PUBKEY

[Interface]
Address    = ${MESH_IP}/10
ListenPort = ${LISTEN_PORT}
PrivateKey = ${PRIVKEY}
EOF
  warn "Solo mode: devices must be on the same LAN/WiFi network"
  ;;
esac

chmod 600 "$CONF_FILE"

# ── Update .env ──────────────────────────────────────────────────────────────

update_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

update_env "WG_MESH_IP"   "$MESH_IP"
update_env "WG_PUBKEY"    "$PUBKEY"
update_env "WG_CONF"      "$CONF_FILE"
ok ".env updated (WG_MESH_IP, WG_PUBKEY)"

# ── Save identity card ───────────────────────────────────────────────────────

IDENTITY_FILE="$WG_DIR/identity.txt"
cat > "$IDENTITY_FILE" <<EOF
# thereallywow device identity
NAME=$(hostname 2>/dev/null || echo android-device)
PUBKEY=${PUBKEY}
MESH_IP=${MESH_IP}
MODE=${MODE}
CREATED=$(date -u '+%Y-%m-%dT%H:%MZ')
EOF

echo ""
echo -e "${BOLD}${GREEN}  Mesh initialized${RESET}"
echo -e "  Identity : ${CYAN}${PUBKEY}${RESET}"
echo -e "  Mesh IP  : ${CYAN}${MESH_IP}${RESET}"
echo -e "  Config   : ${DIM}${CONF_FILE}${RESET}"
echo ""
echo -e "  Start the mesh:  ${BOLD}bash network/mesh-start.sh${RESET}"
echo -e "  Add a device:    ${BOLD}bash network/peer-add.sh <name>${RESET}"
echo ""
