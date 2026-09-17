# thereallywow — Agnes AI Skill Reference

Android device control via 45 tools over MCP (stdio) or HTTP (`/tools` + `/execute`).
Full tool schemas: `GET /tools` or `GET /api/info` for live endpoints.

---

## Integration

**MCP (OpenClaw / Claude Desktop):** see `openclaw-config.json`

**HTTP (direct):**
```
GET  /tools          → OpenAI function schema for all 45 tools
POST /execute        → { "tool_name": "...", "parameters": { ... } }
GET  /api/info       → live endpoints, mesh IP, tunnel URL, this system prompt
GET  /stream?fps=2   → MJPEG live feed
```

Auth: `Authorization: Bearer <MCP_API_KEY>` when key is configured.

---

## Situational Awareness

**Fastest read — no image processing:**
```
get_ui_tree → full accessibility tree as XML text
find_element / wait_for_text → parse the tree without a screenshot
```

**When you need to see the screen:**
```
screenshot → base64 PNG (lossless, use for pixel work)
screen_region(x,y,w,h) → crop to area of interest (faster)
pixel_color(x,y) → single pixel RGBA (fastest)
```

**Rule:** always try `get_ui_tree` first. Only call `screenshot` when UI tree is insufficient (image content, game state, canvas rendering).

---

## Input Decision Tree

| Situation | Tool |
|---|---|
| Button/link with visible text | `tap_by_text` |
| Known coordinates | `tap_coords` |
| Double-tap | `double_tap` |
| Hold for context menu | `long_press` |
| Scroll a list | `scroll` |
| Swipe between screens | `swipe` |
| Enter text in a field | `type_text` |
| Hardware keys (Back, Home, Enter…) | `keyevent` |
| Wait for a screen to load | `wait_for_text` or `wait_for_element` |

---

## Gaming

All gaming tools require root (Magisk `su`). Use `sendevent` Type B multi-touch — bypasses Android input filtering that blocks macro apps.

```
multi_touch        → simultaneous fingers at exact coordinates
rapid_tap          → auto-clicker with configurable rate/count
joystick           → analog stick hold + direction
swipe_path         → multi-waypoint gesture (drag, draw)
hold_and_do        → hold finger A while tapping B (common attack pattern)
pinch              → zoom in/out
batch_actions      → sequence of mixed actions in one call
repeat(n, batch)   → repeat a batch N times with interval
```

**Game loop pattern:**
1. `screenshot` → read state
2. Decide action based on game state
3. Execute with gaming tool
4. `wait_for_text` or `screenshot` to confirm result
5. Repeat

---

## System Operations

```
root_shell(command)        → arbitrary root command via Magisk su
device_info                → model, Android version, battery, serial
get_current_app            → foreground package + activity
list_packages              → all installed packages
set_perf_mode(performance) → lock CPU to max frequency (gaming/benchmarks)
set_perf_mode(balanced)    → restore default governor
rotate_screen(0|90|180|270|auto)
reboot(normal|recovery|bootloader)
```

---

## App Management

```
launch_app(package)        → start app by package name
force_stop(package)        → kill app
clear_app_cache(package)   → wipe data + cache
install_apk(path)          → install from device path
uninstall_apk(package)
```

---

## Files

```
push_file(local, remote)   → send file to device
pull_file(remote, local)   → retrieve file from device
screen_record_start        → background MP4 recording
screen_record_stop         → stop + pull video to host
```

---

## Network & Notifications

```
start_network_capture(output) → tcpdump PCAP in background
stop_network_capture          → stop + pull PCAP
get_notifications             → all active notifications as text
```

---

## Fixing Devices

1. `get_ui_tree` — read what's on screen
2. `root_shell("dumpsys activity")` — get system state
3. `root_shell("logcat -d -t 50")` — last 50 log lines
4. `get_current_app` — confirm which app is foreground
5. `force_stop` / `clear_app_cache` — reset stuck app
6. `root_shell("pm disable-user --user 0 <pkg>")` — disable bloatware
7. `reboot` — last resort

---

## Key Packages (common targets)

| App | Package |
|---|---|
| Settings | `com.android.settings` |
| Chrome | `com.android.chrome` |
| Play Store | `com.android.vending` |
| Files | `com.google.android.documentsui` |
| Camera | `com.android.camera2` |
