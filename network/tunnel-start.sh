#!/usr/bin/env bash
# tunnel-start.sh — Open a public tunnel to the thereallywow server
#
# Uses bore (FOSS, MIT license) to punch through CGNAT and corporate firewalls.
# The device makes an outbound TCP connection to the relay — same principle
# Apple uses for FaceTime/AirPlay TURN relays. No port forwarding needed.
#
# Default: uses bore.pub (free, no account, no rate limits for reasonable use)
# Self-host: bash tunnel-start.sh --host <your-vps-ip> [--port 7835]
#            Run on VPS: bore server --min-port 10000
#
# After starting: Agnes uses the printed URL to reach thereallywow from anywhere.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
PID_FILE="$SCRIPT_DIR/network/tunnel.pid"
LOG_FILE="$SCRIPT_DIR/network/tunnel.log"
URL_FILE="$SCRIPT_DIR/network/tunnel.url"

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RESET="\033[0m"
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET} $*"; }

# ── Parse args ───────────────────────────────────────────────────────────────

BORE_HOST="bore.pub"
BORE_PORT=7835
LOCAL_PORT=3456

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)  BORE_HOST="$2"; shift 2 ;;
    --port)  BORE_PORT="$2"; shift 2 ;;
    --local) LOCAL_PORT="$2"; shift 2 ;;
    stop)
      if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null && ok "Tunnel stopped" || warn "Already stopped"
        rm -f "$PID_FILE" "$URL_FILE"
      else
        warn "No tunnel running"
      fi
      exit 0
      ;;
    status)
      if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        URL=$(cat "$URL_FILE" 2>/dev/null || echo "unknown")
        ok "Tunnel running → $URL"
      else
        warn "No tunnel running"
      fi
      exit 0
      ;;
    *) shift ;;
  esac
done

# ── Kill existing tunnel ─────────────────────────────────────────────────────

if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null || true
  rm -f "$PID_FILE" "$URL_FILE"
  sleep 1
fi

# ── Start bore tunnel ────────────────────────────────────────────────────────

info "Opening tunnel: localhost:${LOCAL_PORT} → ${BORE_HOST}…"

# bore prints the assigned URL to stdout, then stays running
bore local "$LOCAL_PORT" --to "$BORE_HOST" > "$LOG_FILE" 2>&1 &
BORE_PID=$!
echo "$BORE_PID" > "$PID_FILE"

# Wait for bore to report the URL (it prints something like:
# "listening at bore.pub:NNNNN")
URL=""
for i in $(seq 1 20); do
  sleep 0.5
  LINE=$(grep -oE '[a-z0-9._-]+\.[a-z]+:[0-9]+' "$LOG_FILE" 2>/dev/null | head -1 || true)
  if [ -n "$LINE" ]; then
    URL="http://${LINE}"
    break
  fi
  # Also check if bore died
  kill -0 "$BORE_PID" 2>/dev/null || { warn "bore exited — check $LOG_FILE"; cat "$LOG_FILE"; exit 1; }
done

if [ -z "$URL" ]; then
  warn "Could not parse tunnel URL from bore output"
  cat "$LOG_FILE"
  # Try to construct it from log
  PORT_NUM=$(grep -oE 'port [0-9]+|:[0-9]+' "$LOG_FILE" 2>/dev/null | grep -oE '[0-9]+' | tail -1 || echo "")
  [ -n "$PORT_NUM" ] && URL="http://${BORE_HOST}:${PORT_NUM}" || URL="http://${BORE_HOST}:?"
fi

echo "$URL" > "$URL_FILE"

# ── Update .env ──────────────────────────────────────────────────────────────

grep -q "^TUNNEL_URL=" "$ENV_FILE" 2>/dev/null && \
  sed -i "s|^TUNNEL_URL=.*|TUNNEL_URL=${URL}|" "$ENV_FILE" || \
  echo "TUNNEL_URL=${URL}" >> "$ENV_FILE"

# ── Tell running server ──────────────────────────────────────────────────────

curl -sf -X POST "http://localhost:${LOCAL_PORT}/reconnect" \
  -H "Content-Type: application/json" -d "{}" >/dev/null 2>&1 || true

# ── Termux:Boot persistence ──────────────────────────────────────────────────

BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"
cat > "$BOOT_DIR/03-tunnel.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
sleep 15
bash $SCRIPT_DIR/network/tunnel-start.sh --host $BORE_HOST --port $BORE_PORT --local $LOCAL_PORT >> $LOG_FILE 2>&1 &
EOF
chmod +x "$BOOT_DIR/03-tunnel.sh"

# ── Print result ─────────────────────────────────────────────────────────────

ok "Tunnel open (PID ${BORE_PID})"
echo ""
echo -e "  ${BOLD}Public URL:${RESET}  ${CYAN}${URL}${RESET}"
echo ""
echo -e "  Agnes connects to:"
echo -e "    Tools:   ${CYAN}${URL}/tools${RESET}"
echo -e "    Execute: ${CYAN}${URL}/execute${RESET}"
echo -e "    Stream:  ${CYAN}${URL}/stream?fps=2${RESET}"
echo -e "    GUI:     ${CYAN}${URL}/${RESET}"
echo ""
echo -e "  Stop with: ${BOLD}bash network/tunnel-start.sh stop${RESET}"
echo ""
