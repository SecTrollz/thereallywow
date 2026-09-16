#!/usr/bin/env bash
# relay-setup.sh — Set up a WireGuard relay hub on any Linux VPS
#
# Run this ON the VPS (not on the phone). Tested on Ubuntu/Debian.
# Free VPS options: Oracle Always Free | Fly.io | Hetzner CAX11 €3.29/mo
#
# Usage (on VPS):
#   bash relay-setup.sh [listen_port]   # default port 51820
#
# After setup:
#   1. VPS gives you: public IP + public key
#   2. Run on Moto:   bash network/mesh-init.sh spoke <VPS_IP>:<PORT> <VPS_PUBKEY>
#   3. Run on others: bash network/peer-add.sh --android <device-name>

set -euo pipefail

PORT="${1:-51820}"
MESH_SUBNET="100.64.0.0/10"
HUB_IP="100.64.0.1"

BOLD="\033[1m"; GREEN="\033[32m"; CYAN="\033[36m"; DIM="\033[2m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }

echo -e "\n${BOLD}  thereallywow relay — WireGuard Hub Setup${RESET}\n"

command -v wg &>/dev/null || {
  info "Installing WireGuard…"
  apt-get update -qq && apt-get install -y wireguard-tools iptables
}

WG_DIR="/etc/wireguard"
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

PRIVKEY=$(wg genkey)
PUBKEY=$(echo "$PRIVKEY" | wg pubkey)
PUBLIC_IP=$(curl -sf https://ifconfig.me || curl -sf https://api.ipify.org)

echo "$PRIVKEY" > "$WG_DIR/private.key"
echo "$PUBKEY"  > "$WG_DIR/public.key"
chmod 600 "$WG_DIR/private.key"

cat > "$WG_DIR/wg0.conf" <<EOF
# thereallywow relay hub
[Interface]
Address    = ${HUB_IP}/10
ListenPort = ${PORT}
PrivateKey = ${PRIVKEY}
SaveConfig = true

PostUp   = sysctl -w net.ipv4.ip_forward=1; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
EOF
chmod 600 "$WG_DIR/wg0.conf"

# Enable and start
systemctl enable wg-quick@wg0
systemctl start  wg-quick@wg0

# Open firewall
ufw allow "${PORT}/udp"  2>/dev/null || iptables -A INPUT -p udp --dport "$PORT" -j ACCEPT

ok "Relay running"
echo ""
echo -e "${BOLD}  ╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}  ║   Copy these values to your devices      ║${RESET}"
echo -e "${BOLD}  ╚══════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}VPS endpoint:${RESET}   ${CYAN}${PUBLIC_IP}:${PORT}${RESET}"
echo -e "  ${BOLD}Hub public key:${RESET} ${CYAN}${PUBKEY}${RESET}"
echo -e "  ${BOLD}Hub mesh IP:${RESET}    ${CYAN}${HUB_IP}${RESET}"
echo ""
echo -e "  ${DIM}On the Moto (Termux):${RESET}"
echo -e "  bash network/mesh-init.sh spoke ${PUBLIC_IP}:${PORT} ${PUBKEY}"
echo ""
echo -e "  ${DIM}To add devices from Moto:${RESET}"
echo -e "  bash network/peer-add.sh --android <device-name>"
echo ""
echo -e "  ${DIM}Add peers to this relay with:${RESET}"
echo -e "  wg set wg0 peer <PUBKEY> allowed-ips <MESH_IP>/32 persistent-keepalive 25"
echo ""
