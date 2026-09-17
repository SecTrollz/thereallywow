# thereallywow

Android device control server — 45 tools over MCP and HTTP, with Agnes AI chat built in. Tap, swipe, type, read the screen, run root shell commands, stream live video, get GPS coordinates, and automate complex multi-touch gestures. Driven by Agnes AI via OpenClaw, with a web UI that works on mobile.

```
Control panel:  http://localhost:3456
Agnes chat:     http://localhost:3456/chat
Tunnel:         http://bore.pub:<port>   (punches through CGNAT, no port forwarding)
Mesh:           http://100.64.0.1:3456  (WireGuard, device-to-device)
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
git clone https://github.com/SecTrollz/thereallywow
cd thereallywow
bash thereallywow-setup.sh
```

The setup script:
- Installs all dependencies
- Prompts for your `ADB_DEVICE` (IP:PORT)
- Tests the ADB connection
- Auto-generates a random `MCP_API_KEY`
- Writes `.env` with correct permissions (600)
- Installs Termux:Boot scripts for auto-start on reboot
- Starts the server

To set up ADB on an **unrooted carrier-locked device** (no bootloader unlock needed):

```bash
bash network/unrooted-device-setup.sh
```

To lock ADB to a **static port 5555** on a rooted device:

```bash
bash fix-adb-port.sh
```

---

## Running

```bash
python3 thereallywow.py start      # start server in background
python3 thereallywow.py stop       # stop server
python3 thereallywow.py restart    # restart server
python3 thereallywow.py status     # check if running
python3 thereallywow.py            # interactive REPL
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
tool <name> [k=v …]              call any of the 45 tools directly
start / stop / restart / status  server lifecycle
log                              tail server log

Aliases: click=tap  input=type  keyevent=key  open=launch  sh=shell
```

---

## Web GUI

Open `http://localhost:3456` in a browser — works on mobile too.

- **Click** the screen feed → tap
- **Drag** → swipe
- **Hold 600ms** → long press
- Sidebar: navigate, transmit text, root shell, ADB reconnect, screenshot, screen record, app launch/stop, rotate, network capture
- **Settings panel**: enter your Agnes API key and server key directly in the UI — stored securely in `.env`

Open `http://localhost:3456/chat` for the Agnes AI chat interface.

---

## Agnes AI Chat

The `/chat` page talks directly to an OpenAI-compatible `/chat/completions` endpoint and loops tool calls automatically. By default that's the cloud service at `apihub.agnes-ai.com` — open `http://localhost:3456/chat`, click **⚙ Settings**, and paste a free API key from there.

### Running fully offline (Ollama, no cloud, no rate limits)

The chat endpoint is just OpenAI-compatible HTTP, so it works unmodified against a local [Ollama](https://ollama.com) instance — including one running **on the device itself** via Termux, for a fully offline setup with no API key and no rate limits.

```bash
pkg install ollama        # or: curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull qwen2.5:1.5b  # ~1GB — for the weakest phones (≲2GB free RAM)
# or, if the phone can spare it — meaningfully more reliable at tool calling:
ollama pull qwen2.5:3b    # ~2GB — recommended when ≥3GB free RAM is available
```

Then in the chat page's Settings, click **⚡ Use a local Ollama model instead** (or set these by hand):

| Field | Value |
|---|---|
| API Base URL | `http://127.0.0.1:11434/v1` |
| Model | `qwen2.5:1.5b` (or `qwen2.5:3b`) |
| API Key | anything — Ollama ignores it, e.g. `ollama` |

Every model gets the same full 45-tool list as the cloud API — nothing is trimmed or excluded based on model choice.

**Model choice — what we actually found testing this against the server, not just spec sheets:**
- We looked hard for something fine-tuned *specifically* for function-calling rather than a generic chat model — [Hammer2.1](https://huggingface.co/MadeAgents/Hammer2.1-1.5b) is exactly that, and benchmarks ahead of much larger general models on BFCL. It doesn't ship Ollama tool support out of the box (a [known open issue](https://huggingface.co/eaddario/Hammer2.1-7b-GGUF/discussions/1)) — we built a custom `Modelfile` to fix that and confirmed real tool calls (`device_info`, correct empty-args) come through. But it turned out unusable *for this chat UI*: it's trained purely as a function router, so any turn that isn't a tool call — small talk, a follow-up explanation, a command it decides doesn't need a tool — comes back as literally `[]` instead of a sentence, and in our testing it also missed a plain "open Chrome" request outright. Great at the narrow BFCL task, not fit for a conversational control interface.
- **`qwen2.5:1.5b`** (general instruct model, not tool-specialized) handled battery/status questions and chit-chat correctly, but was inconsistent on multi-step app-launch commands against the full 45-tool list. Runs on very constrained hardware (~1GB).
- **`qwen2.5:3b`** was the more reliable of the two in our testing and still runs on a mid-low-end phone (~2GB). **Recommended whenever the device has the RAM for it** — tool-selection accuracy generally improves with model size when the full tool list is in play.

The `/api/chat` handler also has a fallback parser for local models (like Hammer2.1's Modelfile above) that emit a raw `[{"name":...,"arguments":{...}}]` JSON array as plain text instead of populating the standard `tool_calls` field — useful if you experiment with other GGUF imports that hit the same Ollama template gap.

---

## HTTP API

All endpoints accept and return JSON. Set `Authorization: Bearer <key>` if `MCP_API_KEY` is configured.

```
GET  /tools                  OpenAI-compatible function schema for all 45 tools
POST /execute                { "tool_name": "...", "parameters": { ... } }
GET  /stream?fps=N           MJPEG live stream
GET  /screenshot.png         live screenshot
GET  /api/info               device status, mesh IP, tunnel URL, Agnes endpoints
GET  /api/openclaw-config    one-paste OpenClaw MCP config JSON
POST /api/chat               Agnes chat proxy (loops tool calls automatically)
POST /api/setenv             update AGNES_API_KEY, MCP_API_KEY, AGNES_BASE_URL, AGNES_MODEL
POST /reconnect              { "device": "IP:PORT" }  live-switch ADB target
GET  /health                 server health + tool count
GET  /                       web control panel
GET  /chat                   Agnes AI chat UI
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
| `get_location` | GPS coordinates (lat, lon, accuracy) |
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
python3 thereallywow.py tunnel start   # opens bore.pub tunnel, writes URL to network/tunnel.url
python3 thereallywow.py tunnel url     # print current tunnel URL
python3 thereallywow.py tunnel stop
```

The server reads `network/tunnel.url` live — no restart needed after opening a tunnel.

### WireGuard Mesh (device-to-device, no internet required)

```bash
# On the hub device (or VPS)
bash network/mesh-init.sh hub

# On spoke devices
bash network/mesh-init.sh spoke <hub-public-ip>

# Pair an Android device via QR code
python3 thereallywow.py qr my-phone

# Start the mesh (uses wireproxy — no kernel module required)
python3 thereallywow.py mesh start

# Discover all reachable devices
python3 thereallywow.py discover
```

Mesh IPs are in `100.64.0.0/10`. To set up a VPS as a hub relay:

```bash
bash network/relay-setup.sh   # run on the VPS
```

---

## OpenClaw / MCP Integration

Get the auto-generated config from the server:

```bash
curl http://localhost:3456/api/openclaw-config
```

Or open `http://localhost:3456/chat` — the onboarding wizard generates it for you.

For manual MCP setup, paste into your OpenClaw config:

```json
{
  "mcpServers": {
    "thereallywow": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "env": { "MCP_MODE": "stdio", "MCP_API_KEY": "<your-key>" }
    }
  }
}
```

---

## Environment Variables

All values are read from `.env` in the project root. The setup script generates this file automatically.

| Variable | Default | Description |
|---|---|---|
| `ADB_DEVICE` | *(required)* | ADB target address (IP:PORT) |
| `MCP_MODE` | `http` | `stdio` for MCP clients, `http` for browser |
| `PORT` | `3456` | HTTP server port |
| `MCP_API_KEY` | *(auto-generated)* | Bearer token for HTTP auth |
| `AGNES_API_KEY` | *(none)* | API key for the Agnes chat backend (any value works for local Ollama) |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.com/v1` | OpenAI-compatible chat API base URL — point at `http://127.0.0.1:11434/v1` for local Ollama |
| `AGNES_MODEL` | `agnes-2.0-flash` | Model identifier to send to the chat API |
| `TOUCH_DEV` | `/dev/input/event7` | sendevent input device path |
| `BORE_HOST` | `bore.pub` | Bore relay host |

---

## Boot Persistence (Termux:Boot)

After setup, three scripts run automatically on device boot:

| Script | Delay | Action |
|---|---|---|
| `01-adb-connect.sh` | 5s | `adb connect $ADB_DEVICE` |
| `02-mcp-server.sh` | 10s | Start node server, wait for ADB |
| `03-tunnel.sh` | 15s | Open bore tunnel |

All scripts source `.env` dynamically.

---

## Security

`MCP_API_KEY` is auto-generated during setup (64 hex chars). Find it in `.env` or the settings panel at `http://localhost:3456`.

The web GUI (`/`, `/stream`, `/screenshot.png`, `/chat`) is kept accessible without the key to allow browser access. Set a firewall or disable the tunnel if the stream must be private.
