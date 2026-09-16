#!/usr/bin/env bash
# unrooted-device-setup.sh
#
# Makes a carrier-locked, unrooted Android device permanently accessible
# via ADB on a fixed port — using only FOSS Android apps and the native
# Android Wireless Debugging API.
#
# HOW IT WORKS (the non-obvious insight):
#   Android runs adbd locally. Termux on the SAME device can run
#   `adb tcpip 5555` which instructs the local adbd to open TCP port 5555.
#   Termux:Boot reruns this on every reboot → persistent, no root needed.
#   WireGuard APK (no root) gives the device a stable mesh IP.
#   Agnes reaches it at <mesh-ip>:5555 from anywhere on the mesh.
#
# REQUIREMENTS (all FOSS, all from F-Droid):
#   • F-Droid           https://f-droid.org
#   • Termux            https://f-droid.org/packages/com.termux/
#   • Termux:Boot       https://f-droid.org/packages/com.termux.boot/
#   • WireGuard APK     https://f-droid.org/packages/com.wireguard.android/
#
# STEPS (run in Termux on the target unrooted device):
#   1. Enable Developer Options (tap Build Number 7 times)
#   2. Enable USB Debugging in Developer Options
#   3. Install F-Droid, then Termux + Termux:Boot from F-Droid
#   4. In Termux: bash unrooted-device-setup.sh
#   5. Scan the WireGuard QR (generated on Moto) with WireGuard APK

set -euo pipefail

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }
step() { echo -e "\n${BOLD}  Step $1: $2${RESET}"; }

echo -e "\n${BOLD}  thereallywow — Unrooted Device Setup${RESET}\n"
echo -e "  Device: $(getprop ro.product.model 2>/dev/null || echo unknown)"
echo -e "  OS:     Android $(getprop ro.build.version.release 2>/dev/null || echo ?)\n"

# ── Step 1: Install required packages ───────────────────────────────────────

step 1 "Install Termux packages"
pkg update -y -q 2>/dev/null || true
pkg install -y android-tools 2>/dev/null || \
  apt-get install -y android-tools 2>/dev/null || \
  { warn "Could not install android-tools. Install manually: pkg install android-tools"; }
ok "android-tools installed"

# ── Step 2: Verify ADB can talk to local adbd ───────────────────────────────

step 2 "Connect to local ADB daemon"

# Start ADB server — it will connect to local adbd automatically
adb start-server 2>/dev/null || true
sleep 2

if adb devices 2>/dev/null | grep -q "emulator\|localhost\|127.0.0"; then
  ok "ADB connected to local device"
elif adb devices 2>/dev/null | grep -q "device$"; then
  ok "ADB connected"
else
  warn "ADB not connected to local adbd yet"
  warn "Check: Developer Options → USB Debugging is ON"
  warn "If prompted, tap 'Allow' for ADB access"
  echo ""
  read -rp "  Press Enter after enabling USB Debugging…"
  adb start-server 2>/dev/null || true
  sleep 2
fi

# ── Step 3: Set ADB TCP mode on port 5555 ───────────────────────────────────

step 3 "Enable ADB over TCP on port 5555"

adb tcpip 5555 2>&1 && ok "ADB TCP enabled on port 5555" || \
  warn "adb tcpip failed — try enabling USB Debugging first"

sleep 1

# Confirm it's listening
if adb connect 127.0.0.1:5555 2>/dev/null | grep -q "connected"; then
  ok "Verified: ADB listening on 127.0.0.1:5555"
else
  warn "Could not verify — may still work; continue setup"
fi

# ── Step 4: Termux:Boot persistence ─────────────────────────────────────────

step 4 "Make ADB TCP persistent across reboots (Termux:Boot)"

BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"

cat > "$BOOT_DIR/01-adb-tcpip.sh" <<'BOOTSCRIPT'
#!/data/data/com.termux/files/usr/bin/bash
# thereallywow: keep ADB available on port 5555 after every reboot
sleep 10
adb start-server 2>/dev/null || true
sleep 2
adb tcpip 5555 2>/dev/null || true
BOOTSCRIPT
chmod +x "$BOOT_DIR/01-adb-tcpip.sh"
ok "Boot script installed: $BOOT_DIR/01-adb-tcpip.sh"

# Check if Termux:Boot app is installed
if pm list packages 2>/dev/null | grep -q "com.termux.boot"; then
  ok "Termux:Boot app detected"
else
  warn "Termux:Boot not installed!"
  warn "Install from F-Droid: https://f-droid.org/packages/com.termux.boot/"
  warn "Then open the app once to activate boot triggers"
fi

# ── Step 5: Get this device's IP ─────────────────────────────────────────────

step 5 "Device network info"

WIFI_IP=$(ip addr show wlan0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | head -1)
CELL_IP=$(ip addr show rmnet_data0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | head -1 || \
          ip addr show ccmni0   2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 | head -1 || echo "")

[ -n "$WIFI_IP" ] && ok "WiFi IP: $WIFI_IP" || warn "Not on WiFi"
[ -n "$CELL_IP" ] && ok "Cell IP: $CELL_IP (likely behind CGNAT)"

echo ""
echo -e "  ${BOLD}For WireGuard mesh access (anywhere):${RESET}"
echo -e "  1. On the Moto, run:  ${CYAN}bash network/peer-add.sh --android $(getprop ro.product.model 2>/dev/null | tr ' ' '-')${RESET}"
echo -e "  2. Scan the QR code with the WireGuard APK (from F-Droid)"
echo -e "  3. Enable the VPN in WireGuard APK"
echo -e "  4. Moto connects to this device at: ${CYAN}<mesh-ip>:5555${RESET}"
echo ""
echo -e "  ${BOLD}For same-LAN access right now:${RESET}"
[ -n "$WIFI_IP" ] && \
  echo -e "  ${CYAN}python reallywow.py connect ${WIFI_IP}:5555${RESET}" || \
  echo -e "  Connect to WiFi first"

echo ""
echo -e "${GREEN}${BOLD}  Setup complete.${RESET} This device is now:"
echo -e "  • ADB accessible on port 5555 (survives reboots)"
echo -e "  • Ready for WireGuard mesh peering"
echo -e "  • Controllable by Agnes via thereallywow"
echo ""
