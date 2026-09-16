# Moto Device Control Skill

Control a rooted Android device (Moto G 5G 2022) over ADB via WiFi.
Capabilities: UI navigation, tap/swipe/type input, root shell, app launching, network traffic capture, screenshots.

## Setup

```bash
# Set the ADB device address
export ADB_DEVICE="192.168.1.168:5556"

# Start HTTP server for Agnes AI tool calling
MCP_MODE=http PORT=3456 node ~/moto-mcp/server.mjs &
```

## Tool Endpoint

- **Base URL:** `http://localhost:3456`
- **Tool list:** `GET /tools` → returns OpenAI-compatible tool definitions
- **Execute:** `POST /execute` → `{ "tool_name": "...", "parameters": { ... } }`
- **Health:** `GET /health`

## Tools Available

| Tool | Description |
|------|-------------|
| `get_ui_tree` | Read current screen UI layout as text (no image needed) |
| `tap_by_text` | Tap any visible UI element by its text label |
| `tap_coords` | Tap specific pixel coordinates |
| `swipe` | Swipe gesture between two points |
| `type_text` | Type text into the focused field |
| `keyevent` | Send key events (BACK, HOME, ENTER, VOLUME_UP, etc.) |
| `screenshot` | Capture screen as base64 PNG |
| `launch_app` | Launch any installed app by package name |
| `root_shell` | Execute arbitrary root shell commands via Magisk |
| `list_packages` | List installed app packages |
| `get_current_app` | Get currently active app/activity |
| `start_network_capture` | Start tcpdump packet capture (root) |
| `stop_network_capture` | Stop capture and retrieve pcap file |
| `get_notifications` | Read all current device notifications |
| `device_info` | Device model, Android version, battery, network |

## Agnes AI Integration

Use this skill with Agnes AI's tool calling by pointing the model to the HTTP server.
Set `AGNES_API_KEY` and call `https://apihub.agnes-ai.com/v1/chat/completions` with
the tool list from `GET /tools` injected into the `tools` array.

## Smart Navigation Strategy

1. Always call `get_ui_tree` first — it returns full UI as text, no image processing
2. Use `tap_by_text` to tap buttons by label — no coordinate guessing
3. Only call `screenshot` when you need to visually verify something
4. Use `root_shell` for system-level operations (file access, network, processes)
