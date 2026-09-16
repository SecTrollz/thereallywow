#!/usr/bin/env python3
"""
Really Wow — Android Device Control
  python thereallywow.py                   interactive REPL
  python thereallywow.py start/stop/status server lifecycle
  python thereallywow.py screenshot        capture screen → screen.png
  python thereallywow.py tap <x> <y>      tap coordinates
  python thereallywow.py type <text>       type text
  python thereallywow.py key <keyname>     key event (BACK, HOME, ENTER…)
  python thereallywow.py swipe <x1 y1 x2 y2> [ms]
  python thereallywow.py shell <command>   root shell
  python thereallywow.py launch <pkg>      launch app
  python thereallywow.py stream            print live stream URL
  python thereallywow.py tool <name> [k=v …]  any MCP tool with params
"""

import sys, os, json, subprocess, signal, time, base64, shlex, re, readline
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── Config ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
ENV_FILE   = SCRIPT_DIR / ".env"
PID_FILE   = SCRIPT_DIR / "server.pid"
LOG_FILE   = SCRIPT_DIR / "server.log"
SERVER_URL = f"http://localhost:{int(ENV.get('PORT', 3456))}"
NODE_SCRIPT = SCRIPT_DIR / "server.mjs"

def load_env():
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            m = re.match(r'^([A-Z_]+)=(.*)$', line)
            if m:
                env[m.group(1)] = m.group(2).strip()
    return env

def set_env_var(key, value):
    lines = ENV_FILE.read_text().splitlines() if ENV_FILE.exists() else []
    found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}"); found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(new_lines) + "\n")

ENV     = load_env()
DEVICE  = ENV.get("ADB_DEVICE", os.environ.get("ADB_DEVICE", ""))
PORT    = int(ENV.get("PORT", 3456))
API_KEY = ENV.get("MCP_API_KEY", os.environ.get("MCP_API_KEY", ""))

# ── Colours ────────────────────────────────────────────────────────────────────
def c(code): return f"\033[{code}m" if sys.stdout.isatty() else ""
BOLD=c(1); DIM=c(2); GREEN=c(32); YELLOW=c(33); RED=c(31); CYAN=c(36); RESET=c(0)

def ok(s):   print(f"{GREEN}✓{RESET} {s}")
def warn(s): print(f"{YELLOW}⚠{RESET} {s}")
def err(s):  print(f"{RED}✗{RESET} {s}", file=sys.stderr)
def info(s): print(f"{CYAN}→{RESET} {s}")

# ── HTTP helpers ───────────────────────────────────────────────────────────────
def _auth_headers(extra=None):
    h = {"Content-Type": "application/json"}
    if API_KEY:
        h["Authorization"] = f"Bearer {API_KEY}"
    if extra:
        h.update(extra)
    return h

def _post(path, body):
    data = json.dumps(body).encode()
    req  = Request(f"{SERVER_URL}{path}", data=data, headers=_auth_headers())
    with urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def health():
    try:
        req = Request(f"{SERVER_URL}/health", headers=_auth_headers())
        with urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except Exception:
        return None

def call(tool, **params):
    try:
        resp = _post("/execute", {"tool_name": tool, "parameters": params})
        if "error" in resp:
            raise RuntimeError(resp["error"])
        return resp.get("result", "")
    except URLError:
        raise RuntimeError("Server not running — try: python thereallywow.py start")

# ── Server lifecycle ───────────────────────────────────────────────────────────
def server_pid():
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, 0)
            return pid
        except (ValueError, ProcessLookupError, PermissionError):
            pass
    return None

def cmd_start():
    if server_pid():
        ok(f"Already running (PID {server_pid()})")
        return
    env = {**os.environ, **{k: v for k, v in ENV.items()}}
    env["MCP_MODE"] = "http"
    env["PORT"] = str(PORT)
    # connect ADB first
    if DEVICE:
        subprocess.run(["adb", "connect", DEVICE], capture_output=True)
    with open(LOG_FILE, "a") as log:
        proc = subprocess.Popen(
            ["node", str(NODE_SCRIPT)], env=env,
            stdout=log, stderr=log,
            start_new_session=True
        )
    for _ in range(16):
        time.sleep(0.5)
        if proc.poll() is not None:
            err(f"Server exited immediately (code {proc.returncode}) — check: python thereallywow.py log")
            return
        if health():
            PID_FILE.write_text(str(proc.pid))
            ok(f"Server started (PID {proc.pid}) — {SERVER_URL}")
            return
    proc.terminate()
    err("Server failed to become healthy — killed. Check: python thereallywow.py log")

def cmd_stop():
    pid = server_pid()
    if not pid:
        warn("Not running")
        return
    os.kill(pid, signal.SIGTERM)
    PID_FILE.unlink(missing_ok=True)
    ok("Stopped")

def cmd_status():
    pid = server_pid()
    h   = health()
    print(f"  Process : {GREEN}running (PID {pid}){RESET}" if pid else f"  Process : {RED}not running{RESET}")
    print(f"  HTTP    : {GREEN}{h}{RESET}" if h else f"  HTTP    : {RED}not responding{RESET}")
    if DEVICE:
        try:
            out = subprocess.run(["adb", "-s", DEVICE, "get-state"],
                                 capture_output=True, text=True, timeout=3).stdout.strip()
            print(f"  ADB     : {GREEN}{out} — {DEVICE}{RESET}" if "device" in out
                  else f"  ADB     : {RED}disconnected{RESET}")
        except Exception:
            print(f"  ADB     : {RED}unavailable{RESET}")

def cmd_log():
    os.execvp("tail", ["tail", "-f", str(LOG_FILE)])

# ── Ensure server running ──────────────────────────────────────────────────────
def ensure_server():
    if not health():
        info("Server not running — starting...")
        cmd_start()
        if not health():
            sys.exit(1)

# ── Tool commands ──────────────────────────────────────────────────────────────
def cmd_screenshot(args):
    ensure_server()
    path = Path(args[0]) if args else Path("screen.png")
    raw  = call("screenshot")
    data = raw.split(",", 1)[1] if "," in raw else raw
    path.write_bytes(base64.b64decode(data))
    ok(f"Saved → {path} ({path.stat().st_size // 1024}KB)")

def cmd_tap(args):
    if len(args) < 2:
        err("Usage: tap <x> <y>"); return
    ensure_server()
    r = call("tap_coords", x=int(args[0]), y=int(args[1]))
    ok(r)

def cmd_type(args):
    if not args:
        err("Usage: type <text>"); return
    ensure_server()
    ok(call("type_text", text=" ".join(args)))

def cmd_key(args):
    if not args:
        err("Usage: key <keyname>"); return
    ensure_server()
    ok(call("keyevent", key=args[0].upper()))

def cmd_swipe(args):
    if len(args) < 4:
        err("Usage: swipe <x1> <y1> <x2> <y2> [duration_ms]"); return
    ensure_server()
    params = dict(x1=int(args[0]), y1=int(args[1]), x2=int(args[2]), y2=int(args[3]))
    if len(args) > 4:
        params["duration_ms"] = int(args[4])
    ok(call("swipe", **params))

def cmd_shell(args):
    if not args:
        err("Usage: shell <command>"); return
    ensure_server()
    result = call("root_shell", command=" ".join(args))
    print(result)

def cmd_launch(args):
    if not args:
        err("Usage: launch <package>"); return
    ensure_server()
    ok(call("launch_app", package=args[0]))

def cmd_connect(args):
    """Connect to a new ADB address, update .env, and live-switch the running server."""
    if not args:
        err("Usage: connect <IP:PORT>"); return
    addr = args[0]
    set_env_var("ADB_DEVICE", addr)
    ok(f".env updated → {addr}")
    subprocess.run(["adb", "connect", addr], capture_output=False)
    if health():
        try:
            resp = _post("/reconnect", {"device": addr})
            ok(f"Server live-switched to {addr}") if resp.get("ok") else warn(str(resp))
        except Exception as e:
            warn(f"Server reconnect failed: {e}")

def cmd_stream(args):
    ensure_server()
    fps = int(args[0]) if args else 10
    r   = call("get_stream_url", fps=fps)
    print(r)
    # Try to open in browser
    url = f"{SERVER_URL}/view?fps={fps}"
    for opener in ("termux-open-url", "xdg-open", "open"):
        if subprocess.run(["which", opener], capture_output=True).returncode == 0:
            subprocess.Popen([opener, url])
            break

def cmd_tool(args):
    if not args:
        err("Usage: tool <name> [key=value …]"); return
    ensure_server()
    name   = args[0]
    params = {}
    for kv in args[1:]:
        if "=" in kv:
            k, v = kv.split("=", 1)
            try: v = json.loads(v)
            except Exception: pass
            params[k] = v
    result = call(name, **params)
    if isinstance(result, str) and len(result) > 200:
        print(result[:200] + "…")
    else:
        print(result)

def cmd_ui(args):
    ensure_server()
    print(call("get_ui_tree"))

def cmd_device(args):
    ensure_server()
    print(call("device_info"))

def cmd_tunnel(args):
    """Open or manage the public bore tunnel for Agnes remote access."""
    sub = args[0] if args else "start"
    script = SCRIPT_DIR / "network" / "tunnel-start.sh"
    extra = args[1:] if len(args) > 1 else []
    if sub in ("stop", "status"):
        subprocess.run(["bash", str(script), sub])
    elif sub == "url":
        url_file = SCRIPT_DIR / "network" / "tunnel.url"
        if url_file.exists():
            ok(url_file.read_text().strip())
        else:
            warn("No tunnel running. Start with: tunnel start")
    else:
        subprocess.run(["bash", str(script)] + extra)

def cmd_mesh(args):
    """Manage the WireGuard device mesh."""
    sub = args[0] if args else "status"
    rest = args[1:]
    net_dir = SCRIPT_DIR / "network"
    scripts = {
        "init":     net_dir / "mesh-init.sh",
        "start":    net_dir / "mesh-start.sh",
        "discover": net_dir / "mesh-discover.sh",
        "peer":     net_dir / "peer-add.sh",
        "relay":    net_dir / "relay-setup.sh",
        "status":   None,
    }
    if sub == "status":
        # Show WireGuard interface status
        result = subprocess.run(["wg", "show"], capture_output=True, text=True)
        if result.returncode == 0 and result.stdout:
            print(result.stdout)
        else:
            # Try via root (Android needs root for kernel WG)
            result = subprocess.run(["su", "-c", "wg show"], capture_output=True, text=True)
            print(result.stdout or "WireGuard not running. Start with: reallywow mesh start")
        return
    if sub in scripts and scripts[sub]:
        cmd = ["bash", str(scripts[sub])] + rest
        subprocess.run(cmd)
    else:
        err(f"Unknown mesh subcommand: {sub}")
        info("Usage: mesh [init|start|discover|peer|relay|status]")

def cmd_qr(args):
    """Print a QR code for pairing a new device into the mesh."""
    name = args[0] if args else "new-device"
    net_dir = SCRIPT_DIR / "network"
    subprocess.run(["bash", str(net_dir / "peer-add.sh"), "--android", name])

# ── Interactive REPL ───────────────────────────────────────────────────────────
REPL_HELP = f"""
{BOLD}Commands:{RESET}
  screenshot [file]         capture screen
  tap <x> <y>               tap coordinates
  type <text>               type text
  key <name>                key event (BACK HOME ENTER VOLUME_UP …)
  swipe <x1 y1 x2 y2> [ms] swipe gesture
  shell <cmd>               root shell command
  launch <pkg>              launch app by package name
  stream [fps]              live MJPEG stream URL
  connect <IP:PORT>         switch to a new ADB device
  tunnel [start|stop|status|url]  public bore tunnel
  mesh [init|start|discover|peer|relay|status]  WireGuard mesh
  qr [name]                 QR code to pair a new device into mesh
  discover                  find ADB devices on local network + mesh
  ui                        dump UI tree
  device                    device info
  tool <name> [k=v …]       any MCP tool directly
  start / stop / restart / status  server control
  log                       tail server log
  help                      show this help
  quit / exit               exit

  Aliases: click=tap  input=type  keyevent=key  open=launch  sh=shell
"""

def repl():
    ensure_server()
    h = health()
    model = "?"
    try:
        raw = call("device_info")
        m = re.search(r'"ro\.product\.model":\s*"([^"]+)"', raw)
        if m: model = m.group(1)
    except Exception:
        pass

    print(f"\n{BOLD}Really Wow — Device Control{RESET}")
    print(f"  Device  : {CYAN}{DEVICE or 'unknown'}{RESET}  Model: {model}")
    print(f"  Server  : {GREEN}{SERVER_URL}{RESET}")
    print(f"  Stream  : {SERVER_URL}/view")
    print(f"\nType {BOLD}help{RESET} for commands, {BOLD}quit{RESET} to exit\n")

    DISPATCH = {
        "screenshot": cmd_screenshot, "screen": cmd_screenshot,
        "tap": cmd_tap, "click": cmd_tap,
        "type": cmd_type, "input": cmd_type,
        "key": cmd_key, "keyevent": cmd_key,
        "swipe": cmd_swipe,
        "shell": cmd_shell, "sh": cmd_shell,
        "launch": cmd_launch, "open": cmd_launch,
        "stream": cmd_stream,
        "connect": cmd_connect,
        "ui": lambda a: cmd_ui(a),
        "device": lambda a: cmd_device(a),
        "tool": cmd_tool,
        "start": lambda a: cmd_start(),
        "stop": lambda a: cmd_stop(),
        "restart": lambda a: (cmd_stop(), time.sleep(1), cmd_start()),
        "status": lambda a: cmd_status(),
        "log": lambda a: cmd_log(),
        "tunnel": cmd_tunnel,
        "mesh": cmd_mesh,
        "qr": cmd_qr,
        "discover": lambda a: cmd_mesh(["discover"]),
        "help": lambda a: print(REPL_HELP),
    }

    while True:
        try:
            line = input(f"{BOLD}wow>{RESET} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nbye")
            break
        if not line:
            continue
        if line in ("quit", "exit", "q"):
            break
        parts = shlex.split(line)
        cmd, rest = parts[0].lower(), parts[1:]
        if cmd in DISPATCH:
            try:
                DISPATCH[cmd](rest)
            except RuntimeError as e:
                err(str(e))
            except Exception as e:
                err(f"{type(e).__name__}: {e}")
        else:
            # Try as tool name directly
            try:
                cmd_tool([cmd] + rest)
            except Exception as e:
                err(f"Unknown command '{cmd}' — type help")

# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    args = sys.argv[1:]
    if not args:
        repl()
        return

    cmd  = args[0].lower()
    rest = args[1:]

    CMDS = {
        "start":      lambda: cmd_start(),
        "stop":       lambda: cmd_stop(),
        "restart":    lambda: (cmd_stop(), time.sleep(1), cmd_start()),
        "status":     lambda: cmd_status(),
        "log":        lambda: cmd_log(),
        "screenshot": lambda: cmd_screenshot(rest),
        "screen":     lambda: cmd_screenshot(rest),
        "tap":        lambda: cmd_tap(rest),
        "type":       lambda: cmd_type(rest),
        "key":        lambda: cmd_key(rest),
        "swipe":      lambda: cmd_swipe(rest),
        "shell":      lambda: cmd_shell(rest),
        "sh":         lambda: cmd_shell(rest),
        "launch":     lambda: cmd_launch(rest),
        "stream":     lambda: cmd_stream(rest),
        "connect":    lambda: cmd_connect(rest),
        "tunnel":     lambda: cmd_tunnel(rest),
        "mesh":       lambda: cmd_mesh(rest),
        "qr":         lambda: cmd_qr(rest),
        "discover":   lambda: cmd_mesh(["discover"]),
        "ui":         lambda: cmd_ui(rest),
        "device":     lambda: cmd_device(rest),
        "tool":       lambda: cmd_tool(rest),
        "help":       lambda: print(__doc__),
    }

    if cmd in CMDS:
        CMDS[cmd]()
    else:
        # Try treating first arg as tool name
        try:
            cmd_tool(args)
        except Exception as e:
            err(f"Unknown command '{cmd}' — try: python thereallywow.py help")
            sys.exit(1)

if __name__ == "__main__":
    main()
