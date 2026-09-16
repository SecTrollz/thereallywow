# thereallywow

Android device control server — 44 tools over MCP and HTTP. Tap, swipe, type, read the screen, run root shell commands, stream live video, and automate complex multi-touch gestures. Built to be driven by Agnes AI via OpenClaw.

```
Local:   http://localhost:3456
Tunnel:  http://bore.pub:<assigned-port>   (punches through CGNAT, no port forwarding)
Mesh:    http://100.64.0.1:3456            (WireGuard, device-to-device)
```

---

## Requirements

| Dependency | Install |
|---|---|
| Node.js ≥ 18 | `pkg install nodejs` |
| Python 3 | `pkg install python` |
| ADB | `pkg install android-tools` |
| ImageMagick | `pkg install imagemagick` |
| bore (tunnel) | `cargo install bore-cli` or download binary |
| wireproxy (mesh) | `pkg install wireproxy` |
| proxychains-ng (mesh ADB) | `pkg install proxychains-ng` |
| qrcode (mesh QR) | `pip install qrcode` |

Root is required for: `multi_touch`, `rapid_tap`, `joystick`, `swipe_path`, `hold_and_do`, `pinch`, `screen_record_start`, `fix-adb-port.sh`. All other tools work without root.

---

## Setup

```bash
bash reallywow-setup.sh
```

The setup script installs dependencies, prompts for `ADB_DEVICE`, tests the connection, writes `.env`, installs Termux:Boot scripts, and starts the server.

To set up ADB on an **unrooted carrier-locked device** (no bootloader unlock needed):

```bash
bash network/unrooted-device-setup.sh
```

This runs `adb tcpip 5555` from within the device's own Termux and installs a Termux:Boot script so the port survives reboots.

To lock ADB to a **static port 5555** on a rooted device:

```bash
bash fix-adb-port.sh
```

---

## Running

```bash
python reallywow.py start       # start server in background
python reallywow.py stop        # stop server
python reallywow.py status      # check if running
python reallywow.py             # interactive REPL
```

REPL commands:

```
screenshot [file]                capture screen to PNG
tap <x> <y>                      tap coordinates
type <text>                      type text on device
key <name>                       key event (BACK HOME ENTER VOLUME_UP …)
swipe <x1 y1 x2 y2> [ms]        swipe gesture
shell <cmd>                      root shell command
launch <pkg>                     launch app by package name
stream [fps]                     open live MJPEG stream
connect <IP:PORT>                switch to a new ADB device (live, no restart)
tunnel [start|stop|status|url]   public bore tunnel
mesh [init|start|discover|peer|relay|status]  WireGuard mesh
qr [name]                        print QR to pair a device into the mesh
discover                         find ADB devices on local network and mesh
ui                               dump UI tree
device                           device info
tool <name> [k=v …]              call any of the 44 tools directly
start / stop / restart / status  server lifecycle
log                              tail server log

Aliases: click=tap  input=type  keyevent=key  open=launch  sh=shell
```

---

## Web GUI

Open `http://localhost:3456` in a browser.

- **Click** the screen feed → tap
- **Drag** → swipe
- **Hold 600ms** → long press
- Sidebar: navigate, transmit text, root shell, ADB reconnect, screenshot, screen record, app launch/stop, rotate, network capture

---

## HTTP API

All endpoints accept and return JSON. Set `Authorization: Bearer <key>` if `MCP_API_KEY` is configured.

```
GET  /tools          OpenAI-compatible function schema for all 44 tools
POST /execute        { "tool_name": "...", "parameters": { ... } }
GET  /stream?fps=N   MJPEG live stream
GET  /screenshot.png live screenshot
GET  /api/info       device status, mesh IP, tunnel URL, Agnes endpoints
POST /reconnect      { "device": "IP:PORT" }  live-switch ADB target
GET  /health         server health + tool count
GET  /               web control panel
```

Example:

```bash
curl -s -X POST http://localhost:3456/execute \
  -H 'Content-Type: application/json' \
  -d '{"tool_name":"tap_coords","parameters":{"x":540,"y":960}}'
```

---

## Tools

### Vision
| Tool | Description |
|---|---|
| `screenshot` | Full screen PNG as base64 |
| `screen_region` | Crop to sub-rectangle |
| `pixel_color` | RGBA value at a coordinate |
| `get_ui_tree` | Full accessibility UI tree as XML |
| `get_stream_url` | MJPEG stream URL |

### Input
| Tool | Description |
|---|---|
| `tap_coords` | Tap at x,y |
| `tap_by_text` | Tap first element matching text |
| `long_press` | Hold at x,y for duration_ms |
| `double_tap` | Double-tap at x,y |
| `swipe` | Swipe from (x1,y1) to (x2,y2) |
| `scroll` | Scroll up/down/left/right |
| `type_text` | Type text via input method |
| `keyevent` | Send key event (BACK, HOME, ENTER, etc.) |

### Gaming (root required)
| Tool | Description |
|---|---|
| `multi_touch` | True simultaneous multi-finger via sendevent |
| `rapid_tap` | Auto-clicker at configurable rate |
| `joystick` | Analog stick simulation |
| `swipe_path` | Multi-waypoint gesture |
| `hold_and_do` | Hold one finger while tapping elsewhere |
| `pinch` | Pinch in/out gesture |
| `batch_actions` | Execute a sequence of actions |
| `repeat` | Repeat a batch sequence N times |

### System
| Tool | Description |
|---|---|
| `root_shell` | Run arbitrary root shell command |
| `launch_app` | Launch app by package name |
| `force_stop` | Force-stop an app |
| `device_info` | Model, Android version, battery, serial |
| `rotate_screen` | Set rotation (0/90/180/270/auto) |
| `set_perf_mode` | Toggle CPU performance governor |
| `reboot` | Reboot (normal/recovery/bootloader) |
| `get_current_app` | Package name of foreground app |
| `list_packages` | List installed packages |
| `clipboard_set` | Set clipboard contents |

### Files
| Tool | Description |
|---|---|
| `push_file` | Push file to device |
| `pull_file` | Pull file from device |
| `install_apk` | Install APK |
| `uninstall_apk` | Uninstall app |
| `clear_app_cache` | Clear app data and cache |
| `screen_record_start` | Start screen recording |
| `screen_record_stop` | Stop recording and pull video |

### Network & Wait
| Tool | Description |
|---|---|
| `start_network_capture` | Start tcpdump packet capture |
| `stop_network_capture` | Stop capture and pull PCAP |
| `get_notifications` | Read active notifications |
| `wait_for_element` | Poll until UI element appears |
| `wait_for_text` | Poll until text appears on screen |
| `find_element` | Find element in current UI tree |

---

## Network

### Bore Tunnel (CGNAT bypass, no port forwarding)

```bash
python reallywow.py tunnel start   # opens bore.pub tunnel, writes URL to network/tunnel.url
python reallywow.py tunnel url     # print current tunnel URL
python reallywow.py tunnel stop
```

The server reads `network/tunnel.url` live — no restart needed after opening a tunnel. Agnes gets the tunnel URL from `/api/info`.

### WireGuard Mesh (device-to-device, no internet required)

```bash
# On the hub device (or VPS)
bash network/mesh-init.sh hub

# On spoke devices
bash network/mesh-init.sh spoke <hub-public-ip>

# Pair an Android device via QR code
python reallywow.py qr my-phone

# Start the mesh (uses wireproxy — no kernel module required)
python reallywow.py mesh start

# Discover all reachable devices
python reallywow.py discover
```

Mesh IPs are in `100.64.0.0/10`. Device identity (keypair) is stored in `network/wireguard/`.

To set up a VPS as a hub relay:

```bash
bash network/relay-setup.sh   # run on the VPS
```

---

## Agnes / OpenClaw Integration

Copy the `mcpServers` block from `openclaw-config.json` into your Claude Desktop or OpenClaw config:

```json
{
  "mcpServers": {
    "thereallywow": {
      "command": "node",
      "args": ["/data/data/com.termux/files/home/moto-mcp/server.mjs"],
      "env": { "MCP_MODE": "stdio" }
    }
  }
}
```

For HTTP mode (Agnes via API):

```
GET  <tunnel-url>/tools      → tool list
POST <tunnel-url>/execute    → run tool
GET  <tunnel-url>/stream     → live feed
GET  <tunnel-url>/api/info   → endpoints + system prompt
```

Agnes system prompt is embedded in `/api/info` under `agnes.system_prompt`.

---

## Environment Variables

All values are read from `.env` in the project root. Boot scripts source `.env` at startup.

| Variable | Default | Description |
|---|---|---|
| `ADB_DEVICE` | `192.168.1.168:5556` | ADB target address |
| `MCP_MODE` | `stdio` | `stdio` for MCP clients, `http` for HTTP/browser |
| `PORT` | `3456` | HTTP server port |
| `MCP_API_KEY` | *(none)* | Bearer token for auth-gated routes |
| `TOUCH_DEV` | `/dev/input/event7` | sendevent input device path |
| `WG_MESH_IP` | *(none)* | WireGuard mesh IP (set by mesh-init.sh) |
| `WG_PUBKEY` | *(none)* | WireGuard public key (set by mesh-init.sh) |
| `TUNNEL_URL` | *(none)* | Last known bore tunnel URL |
| `BORE_HOST` | `bore.pub` | Bore relay host |

---

## Boot Persistence (Termux:Boot)

After setup, three scripts run automatically on device boot:

| Script | Delay | Action |
|---|---|---|
| `01-adb-connect.sh` | 5s | `adb connect $ADB_DEVICE` |
| `02-mcp-server.sh` | 10s | Start node server, wait for ADB |
| `03-tunnel.sh` | 15s | Open bore tunnel |

All scripts source `.env` dynamically — changing `ADB_DEVICE` in `.env` takes effect on next reboot with no further changes.

---

## Security Note

`MCP_API_KEY` is not set by default. When unset, all endpoints including root shell execution are open to anyone who can reach the server. If the bore tunnel is active, this means the open internet.

To restrict access:

```bash
echo "MCP_API_KEY=$(openssl rand -hex 32)" >> .env
python reallywow.py restart
```

Note: the web GUI and stream endpoint (`/`, `/stream`, `/screenshot.png`) are intentionally kept public even when a key is set, to allow browser access without configuring headers. Set a firewall or disable the tunnel if the stream must be private.
