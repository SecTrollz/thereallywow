#!/usr/bin/env node
/**
 * thereallywow v1.0.0 — Android Device Control MCP Server
 *
 * Env vars:
 *   ADB_DEVICE   — target device (default 192.168.1.168:5556)
 *   MCP_MODE     — "stdio" | "http" (default stdio)
 *   PORT         — HTTP port (default 3456)
 *   MCP_API_KEY  — optional Bearer token
 *
 * Gaming additions over v2.1:
 *   multi_touch   — true simultaneous multi-finger via sendevent (root)
 *   rapid_tap     — auto-clicker with configurable rate
 *   joystick      — analog stick simulation (hold + direction)
 *   swipe_path    — multi-waypoint gesture for complex motions
 *   hold_and_do   — hold one finger while tapping elsewhere (multi-touch pattern)
 *   pixel_color   — read pixel RGBA at any coordinate
 *   screen_region — crop screenshot to a sub-rectangle (faster)
 *   wait_for_element — poll until UI element appears (turn-based state machine)
 *   repeat        — repeat a batch sequence N times with interval
 *   set_perf_mode — toggle high-performance CPU governor for lower latency
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, execFileSync, spawn } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import http from "http";

// Load .env from project directory (created by thereallywow-setup.sh)
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  readFileSync(join(__dir, ".env"), "utf8").split("\n").forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

function readEnvKey(key) {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const line = readFileSync(join(__dir, ".env"), "utf8").split("\n").find(l => l.startsWith(key+"="));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch { return null; }
}

let DEVICE         = process.env.ADB_DEVICE || "192.168.1.168:5556";
// Hot-reloadable like AGNES_*/OLLAMA_* below: reads .env fresh on every call so a key
// saved via /api/setenv takes effect immediately, with the boot-time env var as fallback
// for a key that was never written to .env in the first place.
function currentApiKey() { return readEnvKey("MCP_API_KEY") || process.env.MCP_API_KEY || null; }
const TOUCH_DEV    = process.env.TOUCH_DEV || "/dev/input/event7";
const MESH_IP      = process.env.WG_MESH_IP  || null;

// Read tunnel URL written by tunnel-start.sh (live, no server restart needed)
function getTunnelUrl() {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(__dir, "network/tunnel.url"), "utf8").trim() || null;
  } catch { return process.env.TUNNEL_URL || null; }
}

// Device screen dimensions — queried once at startup, used for scroll/stream scaling
let DEVICE_W = 720, DEVICE_H = 1600;
function initDeviceDims() {
  try {
    const out = adb("wm size");
    const m = out.match(/(\d+)x(\d+)/);
    if (m) { DEVICE_W = parseInt(m[1]); DEVICE_H = parseInt(m[2]); }
  } catch {}
}
// ── ADB connection watchdog ───────────────────────────────────────────────────

let _adbAliveCache = { ok: false, at: 0, dev: "" };
function adbIsAlive() {
  const now = Date.now();
  if (_adbAliveCache.dev === DEVICE && now - _adbAliveCache.at < 2000) return _adbAliveCache.ok;
  try {
    const s = execFileSync("adb", ["-s", DEVICE, "get-state"], { encoding:"utf8", timeout:3000 }).trim();
    _adbAliveCache = { ok: s === "device", at: now, dev: DEVICE };
  } catch { _adbAliveCache = { ok: false, at: now, dev: DEVICE }; }
  return _adbAliveCache.ok;
}

// Every real ADB device identifier (IP:port, USB serial, emulator-NNNN) matches this;
// only a value crafted to break out of a shell string does not. Validating it once here,
// before it can ever be assigned to DEVICE, closes the injection for every call site that
// interpolates DEVICE into a shell command.
function isValidDeviceId(s) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,63}$/.test(s);
}

function adbReconnect(newDevice) {
  if (newDevice) DEVICE = newDevice;
  _adbAliveCache.at = 0; // invalidate cache so adbIsAlive re-checks after connect
  try {
    execFileSync("adb", ["connect", DEVICE], { encoding:"utf8", timeout:8000 });
    if (adbIsAlive()) {
      process.stderr.write(`[thereallywow] ADB connected: ${DEVICE}\n`);
      initDeviceDims();
      return true;
    }
  } catch {}
  process.stderr.write(`[thereallywow] ADB connect failed: ${DEVICE}\n`);
  return false;
}

// ── Persistent ADB shell ─────────────────────────────────────────────────────

let _shell = null;
let _shellBusy = false;
const _shellQueue = [];

function getShell() {
  if (_shell && _shell.exitCode === null) return _shell;
  _shell = spawn("adb", ["-s", DEVICE, "shell"]);
  _shell.on("exit", () => { _shell = null; _shellBusy = false; });
  _shell.stderr.resume();
  return _shell;
}

function shellExec(cmd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const sentinel = `__DONE_${Date.now().toString(36)}__`;
    const sh = getShell();
    let out = "";
    const onData = (d) => {
      out += d.toString();
      if (out.includes(sentinel)) {
        sh.stdout.off("data", onData);
        clearTimeout(timer);
        resolve(out.slice(0, out.indexOf(sentinel)).trim());
        _shellBusy = false;
        drainQueue();
      }
    };
    const timer = setTimeout(() => {
      sh.stdout.off("data", onData);
      resolve("(timeout)");
      _shellBusy = false;
      drainQueue();
    }, timeoutMs);
    sh.stdout.on("data", onData);
    sh.stdin.write(`${cmd}; echo ${sentinel}\n`);
  });
}

function drainQueue() {
  if (_shellBusy || _shellQueue.length === 0) return;
  _shellBusy = true;
  const { cmd, resolve } = _shellQueue.shift();
  shellExec(cmd).then(resolve);
}

function shellExecQueued(cmd, timeout) {
  if (!_shellBusy) { _shellBusy = true; return shellExec(cmd, timeout); }
  return new Promise(r => _shellQueue.push({ cmd, resolve: r }));
}

function shellInput(cmd) { return shellExecQueued(`input ${cmd}`); }

// ── Standard ADB helpers ─────────────────────────────────────────────────────

function adb(cmd) {
  try { return execFileSync("adb", ["-s", DEVICE, "shell", cmd], { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (e) { return (e.stderr || e.message || "").trim(); }
}

function adbRoot(cmd) { return adb(`su -c '${cmd.replace(/'/g, `'\\''`)}'`); }

// Single-quote-escapes a value for safe interpolation into a shell command string
// (the `adb shell`/`su -c` string is parsed by the device's shell, so untrusted
// values like package names or filter text must never be spliced in raw).
function sq(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }

function adbExec(argv) {
  try { return execFileSync("adb", ["-s", DEVICE, ...argv], { encoding: "utf8", timeout: 30000 }).trim(); }
  catch (e) { return (e.stderr || e.message || "").trim(); }
}

// ── UI XML cache (2s TTL) ─────────────────────────────────────────────────────

let _uiCache = null, _uiCacheTime = 0;
const UI_CACHE_TTL = 2000;

function uiDump(force = false) {
  const now = Date.now();
  if (!force && _uiCache && (now - _uiCacheTime) < UI_CACHE_TTL) return _uiCache;
  try {
    const xml = execSync(`adb -s ${DEVICE} exec-out uiautomator dump /dev/stdout`,
      { timeout: 12000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (!xml.startsWith("<?xml")) throw new Error("bad dump");
    _uiCache = xml; _uiCacheTime = Date.now();
    return _uiCache;
  } catch (e) {
    if (_uiCache) return _uiCache;
    throw new Error(`UI dump failed: ${e.message}`);
  }
}

function invalidateUi() { _uiCache = null; _uiCacheTime = 0; }

// ── XML helpers ───────────────────────────────────────────────────────────────

function parseXml(xml) {
  const results = [];
  const re = /<node([^>]*)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = {};
    const attrRe = /(\w[\w-]*)="([^"]*)"/g;
    let a;
    while ((a = attrRe.exec(m[1])) !== null) attrs[a[1]] = a[2];
    const nums = (attrs.bounds || "").match(/\d+/g);
    if (nums?.length === 4) {
      attrs._x = (parseInt(nums[0]) + parseInt(nums[2])) >> 1;
      attrs._y = (parseInt(nums[1]) + parseInt(nums[3])) >> 1;
    }
    results.push(attrs);
  }
  return results;
}

function findElement(xml, { text, partialText, resourceId, cls, description } = {}) {
  for (const el of parseXml(xml)) {
    const t = (el.text || "").trim();
    if (text        && t.toLowerCase() !== text.trim().toLowerCase())                    continue;
    if (partialText && !t.toLowerCase().includes(partialText.trim().toLowerCase()))       continue;
    if (resourceId  && !(el["resource-id"] || "").includes(resourceId))                  continue;
    if (cls         && !(el.class || "").includes(cls))                                   continue;
    if (description && !(el["content-desc"] || "").toLowerCase().includes(description.toLowerCase())) continue;
    if (el._x !== undefined) return el;
  }
  return null;
}

function uiTree(xml, maxDepth = 6) {
  const lines = [];
  let depth = 0;
  xml.replace(/<(\/?)node([^>]*)>/g, (_, close, attrs) => {
    if (close) { depth = Math.max(0, depth - 1); return; }
    if (depth > maxDepth) { depth++; return; }
    const a = {};
    attrs.replace(/(\w[\w-]*)="([^"]*)"/g, (__, k, v) => { a[k] = v; });
    const cls  = (a.class || "").split(".").pop();
    const rid  = (a["resource-id"] || "").split("/").pop();
    const text = a.text  ? ` "${a.text}"` : "";
    const desc = a["content-desc"] && !a.text ? ` [${a["content-desc"]}]` : "";
    const chk  = a.checked === "true" ? " ✓" : "";
    lines.push("  ".repeat(depth) + cls + (rid ? `#${rid}` : "") + text + desc + chk + " " + (a.bounds||""));
    depth++;
  });
  return lines.join("\n");
}

// ── Screenshot helpers ────────────────────────────────────────────────────────

function takeScreenshot() {
  return execSync(`adb -s ${DEVICE} exec-out screencap -p`,
    { timeout: 12000, maxBuffer: 8 * 1024 * 1024 });
}

function takeScreenshotJpeg(quality = 82) {
  return execSync(
    `adb -s ${DEVICE} exec-out screencap -p | magick - -quality ${quality} jpg:-`,
    { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
}

// Read pixel color using ImageMagick — returns {r,g,b,a,hex}
function readPixelColor(x, y) {
  const out = execSync(
    `adb -s ${DEVICE} exec-out screencap -p | magick - -format "%[fx:p{${x},${y}}.r*255],%[fx:p{${x},${y}}.g*255],%[fx:p{${x},${y}}.b*255],%[fx:p{${x},${y}}.a*255]" info:`,
    { encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024 }
  ).trim();
  const [r, g, b, a] = out.split(",").map(v => Math.round(parseFloat(v)));
  const hex = `#${[r,g,b].map(v => v.toString(16).padStart(2,"0")).join("")}`;
  return { r, g, b, a, hex };
}

// Crop screenshot region using ImageMagick — returns PNG Buffer
function captureRegion(x, y, w, h) {
  return execSync(
    `adb -s ${DEVICE} exec-out screencap -p | magick - -crop ${w}x${h}+${x}+${y} +repage png:-`,
    { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }
  );
}

// ── Input helpers ─────────────────────────────────────────────────────────────

async function tap(x, y)                    { await shellInput(`tap ${x} ${y}`);                            invalidateUi(); }
async function longPress(x, y, ms)          { await shellInput(`swipe ${x} ${y} ${x} ${y} ${ms}`);          invalidateUi(); }
async function swipeCoords(x1,y1,x2,y2,ms) { await shellInput(`swipe ${x1} ${y1} ${x2} ${y2} ${ms||300}`); invalidateUi(); }
async function keyeventCmd(key)             { await shellInput(`keyevent ${key}`);                            invalidateUi(); }

async function typeText(text) {
  const safe = text
    .replace(/\\/g,"\\\\").replace(/ /g,"%s").replace(/'/g,"\\'")
    .replace(/"/g,'\\"').replace(/&/g,"\\&").replace(/;/g,"\\;")
    .replace(/\|/g,"\\|").replace(/`/g,"\\`").replace(/\$/g,"\\$");
  await shellInput(`text '${safe}'`);
}

// ── sendevent multi-touch builder ─────────────────────────────────────────────
// Generates shell commands for Type B multi-touch protocol on TOUCH_DEV.
// SE(type, code, val) -> "sendevent DEVICE type code val"

function se(type, code, val) { return `sendevent ${TOUCH_DEV} ${type} ${code} ${val}`; }
const EV_SYN=0, EV_ABS=3, SYN_REPORT=0, ABS_MT_SLOT=47, ABS_MT_TRACKING_ID=57, ABS_MT_POS_X=53, ABS_MT_POS_Y=54;
const LIFT = 4294967295; // -1 as uint32 = finger lift

// Build a press+hold+release sequence for N simultaneous touches
function buildMultiTouchCmds(touches, holdMs) {
  const cmds = [];
  // Press all fingers
  for (const [i, {x, y}] of touches.entries()) {
    cmds.push(se(EV_ABS, ABS_MT_SLOT,       i));
    cmds.push(se(EV_ABS, ABS_MT_TRACKING_ID, i + 1));
    cmds.push(se(EV_ABS, ABS_MT_POS_X,      x));
    cmds.push(se(EV_ABS, ABS_MT_POS_Y,      y));
  }
  cmds.push(se(EV_SYN, SYN_REPORT, 0));
  // Hold
  cmds.push(`sleep ${(holdMs / 1000).toFixed(3)}`);
  // Lift all fingers
  for (const [i] of touches.entries()) {
    cmds.push(se(EV_ABS, ABS_MT_SLOT,       i));
    cmds.push(se(EV_ABS, ABS_MT_TRACKING_ID, LIFT));
  }
  cmds.push(se(EV_SYN, SYN_REPORT, 0));
  return cmds.join(" && ");
}

// Multi-touch drag: press, move through waypoints per touch, release
function buildMultiTouchDragCmds(tracks, stepMs) {
  // tracks: [{start:{x,y}, end:{x,y}}] or [{points:[{x,y}]}]
  const cmds = [];
  const maxSteps = Math.max(...tracks.map(t => (t.points||[t.start,t.end]).length));
  // Press initial positions
  for (const [i, t] of tracks.entries()) {
    const p = (t.points||[t.start,t.end])[0];
    cmds.push(se(EV_ABS, ABS_MT_SLOT,       i));
    cmds.push(se(EV_ABS, ABS_MT_TRACKING_ID, i + 1));
    cmds.push(se(EV_ABS, ABS_MT_POS_X,      p.x));
    cmds.push(se(EV_ABS, ABS_MT_POS_Y,      p.y));
  }
  cmds.push(se(EV_SYN, SYN_REPORT, 0));
  // Move through steps
  for (let step = 1; step < maxSteps; step++) {
    cmds.push(`sleep ${(stepMs / 1000).toFixed(3)}`);
    for (const [i, t] of tracks.entries()) {
      const pts = t.points || [t.start, t.end];
      const p = pts[Math.min(step, pts.length - 1)];
      cmds.push(se(EV_ABS, ABS_MT_SLOT,  i));
      cmds.push(se(EV_ABS, ABS_MT_POS_X, p.x));
      cmds.push(se(EV_ABS, ABS_MT_POS_Y, p.y));
    }
    cmds.push(se(EV_SYN, SYN_REPORT, 0));
  }
  // Lift
  for (const [i] of tracks.entries()) {
    cmds.push(se(EV_ABS, ABS_MT_SLOT,       i));
    cmds.push(se(EV_ABS, ABS_MT_TRACKING_ID, LIFT));
  }
  cmds.push(se(EV_SYN, SYN_REPORT, 0));
  return cmds.join(" && ");
}

// Generate intermediate points between start and end
function interpolate(x1, y1, x2, y2, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: Math.round(x1 + (x2-x1)*t), y: Math.round(y1 + (y2-y1)*t) });
  }
  return pts;
}

// ── Poll helper ───────────────────────────────────────────────────────────────

async function pollUntil(predicate, timeoutMs, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    invalidateUi();
    const xml = uiDump(true);
    const result = predicate(xml);
    if (result) return result;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return null;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "thereallywow", version: "1.0.0",
  description: "Full Android device control — UI, root, gaming input, multi-touch, network" });

// One JSON line per tool call, recording what ran and whether it succeeded — a plain
// paper trail across all three call surfaces (MCP, HTTP /execute, /api/chat), useful
// after the fact for "what did the model actually do" without slowing anything down or
// changing behavior on failure. Opt out with DISABLE_TOOL_AUDIT_LOG=1.
function auditLog(toolName, source, ok) {
  if (process.env.DISABLE_TOOL_AUDIT_LOG === "1") return;
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const logsDir = join(__dir, "logs");
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), tool: toolName, source, ok }) + "\n";
    appendFileSync(join(logsDir, "tool-audit.jsonl"), line);
  } catch {}
}

// Single source of truth for every tool definition. `tool()` registers with the MCP SDK
// exactly as `server.tool()` always did (same name/description/shape/handler, so MCP
// behavior is byte-identical) and additionally records the definition in `TOOLS`, which
// `buildOpenAIToolList()` and `executeTool()` below both derive from. This is what keeps
// the tool count and each tool's validation identical across the MCP, HTTP `/execute`,
// and `/api/chat` surfaces — previously each surface hand-maintained its own copy, which
// is how those copies drifted out of sync with each other.
const TOOLS = {};
function tool(name, description, shape, handler) {
  TOOLS[name] = { name, description, shape, schema: z.object(shape), handler };
  server.tool(name, description, shape, async (params) => {
    try {
      const result = await handler(params);
      auditLog(name, "mcp", true);
      return result;
    } catch (e) {
      auditLog(name, "mcp", false);
      throw e;
    }
  });
}

// ── Navigation & UI tools ─────────────────────────────────────────────────────

tool("get_ui_tree", "Read current screen UI as text tree. No image needed for navigation.",
  { force_refresh: z.boolean().default(false) },
  async ({ force_refresh }) => ({ content: [{ type:"text", text: uiTree(uiDump(force_refresh)) }] })
);

tool("find_element", "Find a UI element and return coordinates without tapping.",
  { text: z.string().optional(), partial_text: z.string().optional(),
    resource_id: z.string().optional(), description: z.string().optional() },
  async ({ text, partial_text, resource_id, description }) => {
    const el = findElement(uiDump(), { text, partialText: partial_text, resourceId: resource_id, description });
    if (!el) return { content: [{ type:"text", text:"Not found" }] };
    return { content: [{ type:"text", text: JSON.stringify({ x:el._x, y:el._y, text:el.text, resourceId:el["resource-id"], bounds:el.bounds }) }] };
  }
);

tool("wait_for_element",
  "Poll until a UI element appears (great for turn-based games waiting for opponent, loading screens, dialogs).",
  { text: z.string().optional(), partial_text: z.string().optional(),
    resource_id: z.string().optional(), description: z.string().optional(),
    timeout_ms: z.number().default(10000), poll_ms: z.number().default(500) },
  async ({ text, partial_text, resource_id, description, timeout_ms, poll_ms }) => {
    const el = await pollUntil(
      xml => findElement(xml, { text, partialText: partial_text, resourceId: resource_id, description }),
      timeout_ms, poll_ms
    );
    if (!el) return { content: [{ type:"text", text:`Not found within ${timeout_ms}ms` }] };
    return { content: [{ type:"text", text: JSON.stringify({ x:el._x, y:el._y, text:el.text, bounds:el.bounds }) }] };
  }
);

tool("tap_by_text", "Tap a UI element by visible text.",
  { text: z.string(), partial: z.boolean().default(false) },
  async ({ text, partial }) => {
    const el = findElement(uiDump(), partial ? { partialText:text } : { text });
    if (!el) return { content: [{ type:"text", text:`Not found: "${text}"` }] };
    await tap(el._x, el._y);
    return { content: [{ type:"text", text:`Tapped "${el.text}" at (${el._x},${el._y})` }] };
  }
);

// ── Basic input tools ─────────────────────────────────────────────────────────

tool("tap_coords", "Tap specific pixel coordinates.",
  { x: z.number(), y: z.number() },
  async ({ x, y }) => { await tap(x, y); return { content: [{ type:"text", text:`Tapped (${x},${y})` }] }; }
);

tool("long_press", "Long press at coordinates.",
  { x: z.number(), y: z.number(), duration_ms: z.number().default(800) },
  async ({ x, y, duration_ms }) => { await longPress(x,y,duration_ms); return { content: [{ type:"text", text:`Long pressed (${x},${y}) ${duration_ms}ms` }] }; }
);

tool("swipe", "Swipe between two points.",
  { x1:z.number(), y1:z.number(), x2:z.number(), y2:z.number(), duration_ms:z.number().default(300) },
  async ({ x1,y1,x2,y2,duration_ms }) => {
    await swipeCoords(x1,y1,x2,y2,duration_ms);
    return { content: [{ type:"text", text:`Swiped (${x1},${y1})→(${x2},${y2})` }] };
  }
);

tool("scroll", "Scroll in a direction.",
  { direction: z.enum(["up","down","left","right"]), amount: z.number().min(0.1).max(1.0).default(0.5) },
  async ({ direction, amount }) => {
    const xml = uiDump();
    const m = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
    const W = m ? parseInt(m[1]) : 1080, H = m ? parseInt(m[2]) : 1920;
    const cx=W>>1, cy=H>>1, dx=Math.round(W*amount), dy=Math.round(H*amount);
    const c = { up:[cx,cy+dy,cx,cy-dy], down:[cx,cy-dy,cx,cy+dy], left:[cx+dx,cy,cx-dx,cy], right:[cx-dx,cy,cx+dx,cy] }[direction];
    await swipeCoords(...c, 400);
    return { content: [{ type:"text", text:`Scrolled ${direction}` }] };
  }
);

tool("type_text", "Type text into the focused field.",
  { text: z.string() },
  async ({ text }) => { await typeText(text); return { content: [{ type:"text", text:`Typed: ${text}` }] }; }
);

tool("keyevent", "Send Android key event (KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER, etc.).",
  { key: z.string() },
  async ({ key }) => { await keyeventCmd(key); return { content: [{ type:"text", text:`Sent: ${key}` }] }; }
);

// ── Gaming: batch & repeat ────────────────────────────────────────────────────

tool("batch_actions",
  "Execute multiple actions in one ADB round-trip (~80ms/action saved). Best for turn-based sequences.",
  { actions: z.array(z.object({
      type:     z.enum(["tap","swipe","keyevent","type","sleep"]),
      x:        z.number().optional(), y: z.number().optional(),
      x2:       z.number().optional(), y2: z.number().optional(),
      duration: z.number().optional(), key: z.string().optional(),
      text:     z.string().optional(), ms: z.number().optional(),
    })) },
  async ({ actions }) => {
    const cmds = [];
    for (const a of actions) {
      switch (a.type) {
        case "tap":      cmds.push(`input tap ${a.x} ${a.y}`); break;
        case "swipe":    cmds.push(`input swipe ${a.x} ${a.y} ${a.x2} ${a.y2} ${a.duration||300}`); break;
        case "keyevent": cmds.push(`input keyevent ${a.key}`); break;
        case "type":     cmds.push(`input text '${(a.text||"").replace(/ /g,"%s").replace(/'/g,"''")}'`); break;
        case "sleep":    cmds.push(`sleep ${((a.ms||500)/1000).toFixed(3)}`); break;
      }
    }
    await shellExecQueued(cmds.join(" && "));
    invalidateUi();
    return { content: [{ type:"text", text:`Executed ${actions.length} actions` }] };
  }
);

tool("repeat",
  "Repeat a batch_actions sequence N times with a delay between each iteration. Perfect for idle games, grinding, or repeated turn actions.",
  { actions: z.array(z.object({
      type:z.enum(["tap","swipe","keyevent","type","sleep"]),
      x:z.number().optional(), y:z.number().optional(),
      x2:z.number().optional(), y2:z.number().optional(),
      duration:z.number().optional(), key:z.string().optional(),
      text:z.string().optional(), ms:z.number().optional(),
    })),
    count:       z.number().min(1).max(1000).describe("Number of repetitions"),
    interval_ms: z.number().default(0).describe("Delay between reps in ms"),
  },
  async ({ actions, count, interval_ms }) => {
    const innerCmds = [];
    for (const a of actions) {
      switch (a.type) {
        case "tap":      innerCmds.push(`input tap ${a.x} ${a.y}`); break;
        case "swipe":    innerCmds.push(`input swipe ${a.x} ${a.y} ${a.x2} ${a.y2} ${a.duration||300}`); break;
        case "keyevent": innerCmds.push(`input keyevent ${a.key}`); break;
        case "type":     innerCmds.push(`input text '${(a.text||"").replace(/ /g,"%s").replace(/'/g,"''")}'`); break;
        case "sleep":    innerCmds.push(`sleep ${((a.ms||500)/1000).toFixed(3)}`); break;
      }
    }
    const iteration = innerCmds.join(" && ");
    const gap = interval_ms > 0 ? ` && sleep ${(interval_ms/1000).toFixed(3)}` : "";
    // Chain N iterations — for large counts use a shell loop
    let cmd;
    if (count <= 20) {
      cmd = Array(count).fill(iteration).join(` && ${gap ? gap.slice(4) + " && " : ""}`);
    } else {
      cmd = `for i in $(seq 1 ${count}); do ${iteration}${gap ? "; sleep " + (interval_ms/1000).toFixed(3) : ""}; done`;
    }
    await shellExecQueued(cmd, count * (actions.length * 200 + interval_ms) + 10000);
    invalidateUi();
    return { content: [{ type:"text", text:`Repeated ${count}x` }] };
  }
);

// ── Gaming: real-time input ───────────────────────────────────────────────────

tool("rapid_tap",
  "Auto-clicker: tap rapidly at a position. For clicker games, spam attacks, or fast-paced tap mechanics.",
  { x: z.number(), y: z.number(),
    times:       z.number().min(1).max(500).default(10).describe("Number of taps"),
    interval_ms: z.number().min(16).max(2000).default(100).describe("Ms between taps (min 16ms = ~60fps)"),
  },
  async ({ x, y, times, interval_ms }) => {
    const sleepSec = (interval_ms / 1000).toFixed(3);
    const cmd = times <= 30
      ? Array(times).fill(`input tap ${x} ${y}`).join(` && sleep ${sleepSec} && `)
      : `for i in $(seq 1 ${times}); do input tap ${x} ${y}; sleep ${sleepSec}; done`;
    await shellExecQueued(cmd, times * (interval_ms + 300) + 5000);
    invalidateUi();
    return { content: [{ type:"text", text:`Tapped ${times}x at (${x},${y}) every ${interval_ms}ms` }] };
  }
);

tool("joystick",
  "Simulate analog joystick: hold finger at offset from center for duration. For movement in action/shooter/racing games.",
  { center_x:    z.number().describe("Virtual joystick center X"),
    center_y:    z.number().describe("Virtual joystick center Y"),
    angle_deg:   z.number().min(0).max(360).describe("Direction: 0=right 90=up 180=left 270=down"),
    distance_pct: z.number().min(0.1).max(1.0).default(0.8).describe("How far from center (1.0=full deflection)"),
    radius:      z.number().default(120).describe("Max joystick radius in pixels"),
    duration_ms: z.number().default(500).describe("How long to hold the direction"),
  },
  async ({ center_x, center_y, angle_deg, distance_pct, radius, duration_ms }) => {
    const rad = (angle_deg * Math.PI) / 180;
    const dist = radius * distance_pct;
    const tx = Math.round(center_x + Math.cos(rad) * dist);
    const ty = Math.round(center_y - Math.sin(rad) * dist); // screen Y is inverted
    await swipeCoords(center_x, center_y, tx, ty, duration_ms);
    return { content: [{ type:"text", text:`Joystick: ${angle_deg}° ${Math.round(distance_pct*100)}% for ${duration_ms}ms → (${tx},${ty})` }] };
  }
);

tool("swipe_path",
  "Swipe through multiple waypoints in sequence. For drawing, complex gestures, steering, or spell casting.",
  { points: z.array(z.object({ x:z.number(), y:z.number() })).min(2)
      .describe("Ordered list of (x,y) waypoints to pass through"),
    duration_ms: z.number().default(600).describe("Total gesture duration"),
  },
  async ({ points, duration_ms }) => {
    // Build a sequence of intermediate moves using sendevent
    // Each segment proportional to its length
    const totalPts = points.length;
    const segMs = Math.floor(duration_ms / (totalPts - 1));
    // Start touch
    const cmds = [
      se(EV_ABS, ABS_MT_SLOT, 0), se(EV_ABS, ABS_MT_TRACKING_ID, 1),
      se(EV_ABS, ABS_MT_POS_X, points[0].x), se(EV_ABS, ABS_MT_POS_Y, points[0].y),
      se(EV_SYN, SYN_REPORT, 0),
    ];
    for (let i = 1; i < totalPts; i++) {
      // Interpolate between current and next point
      const steps = Math.max(1, Math.floor(segMs / 16)); // ~60fps steps
      const pts = interpolate(points[i-1].x, points[i-1].y, points[i].x, points[i].y, steps);
      for (const p of pts.slice(1)) {
        cmds.push(`sleep 0.016`);
        cmds.push(se(EV_ABS, ABS_MT_SLOT, 0));
        cmds.push(se(EV_ABS, ABS_MT_POS_X, p.x));
        cmds.push(se(EV_ABS, ABS_MT_POS_Y, p.y));
        cmds.push(se(EV_SYN, SYN_REPORT, 0));
      }
    }
    // Lift
    cmds.push(se(EV_ABS, ABS_MT_SLOT, 0), se(EV_ABS, ABS_MT_TRACKING_ID, LIFT), se(EV_SYN, SYN_REPORT, 0));
    await shellExecQueued(`su -c '${cmds.join(" && ")}'`, duration_ms + 5000);
    invalidateUi();
    return { content: [{ type:"text", text:`Swiped path: ${totalPts} waypoints over ${duration_ms}ms` }] };
  }
);

tool("multi_touch",
  "Simultaneous multi-finger touch via low-level sendevent (requires root). For pinch/zoom, two-thumb controls, two-player touch, or any game needing multiple simultaneous fingers.",
  { touches: z.array(z.object({ x:z.number(), y:z.number() })).min(2).max(10)
      .describe("List of simultaneous touch positions (2-10 fingers)"),
    duration_ms: z.number().default(200).describe("How long to hold all fingers"),
  },
  async ({ touches, duration_ms }) => {
    const cmd = `su -c '${buildMultiTouchCmds(touches, duration_ms)}'`;
    await shellExecQueued(cmd, duration_ms + 3000);
    invalidateUi();
    return { content: [{ type:"text", text:`${touches.length}-finger touch for ${duration_ms}ms` }] };
  }
);

tool("hold_and_do",
  "Hold one finger steady while performing other taps elsewhere. Essential for games where you hold move/aim while tapping fire, or hold a button while swiping.",
  { hold: z.object({ x:z.number(), y:z.number() }).describe("Position to hold continuously"),
    actions: z.array(z.object({
      type: z.enum(["tap","sleep"]),
      x:z.number().optional(), y:z.number().optional(), ms:z.number().optional(),
    })).describe("Sequence of taps/sleeps to perform while holding"),
    release_after_ms: z.number().default(0).describe("Extra hold time after all actions (0=release immediately after last action)"),
  },
  async ({ hold, actions, release_after_ms }) => {
    // Build sendevent for the held finger + input commands for the tap actions
    const cmds = [
      // Press hold finger (slot 0)
      `su -c '${se(EV_ABS,ABS_MT_SLOT,0)} && ${se(EV_ABS,ABS_MT_TRACKING_ID,1)} && ${se(EV_ABS,ABS_MT_POS_X,hold.x)} && ${se(EV_ABS,ABS_MT_POS_Y,hold.y)} && ${se(EV_SYN,SYN_REPORT,0)}'`,
    ];
    for (const a of actions) {
      if (a.type === "tap")   cmds.push(`input tap ${a.x} ${a.y}`);
      if (a.type === "sleep") cmds.push(`sleep ${((a.ms||100)/1000).toFixed(3)}`);
    }
    if (release_after_ms > 0) cmds.push(`sleep ${(release_after_ms/1000).toFixed(3)}`);
    // Lift hold finger
    cmds.push(`su -c '${se(EV_ABS,ABS_MT_SLOT,0)} && ${se(EV_ABS,ABS_MT_TRACKING_ID,LIFT)} && ${se(EV_SYN,SYN_REPORT,0)}'`);
    await shellExecQueued(cmds.join(" && "), 15000);
    invalidateUi();
    return { content: [{ type:"text", text:`Held (${hold.x},${hold.y}) while executing ${actions.length} actions` }] };
  }
);

tool("pinch",
  "Pinch in or out (zoom gesture) between two finger positions.",
  { center_x: z.number(), center_y: z.number(),
    start_spread: z.number().default(300).describe("Initial finger distance in pixels"),
    end_spread:   z.number().default(50).describe("Final finger distance (smaller=pinch in, larger=pinch out)"),
    duration_ms:  z.number().default(400),
  },
  async ({ center_x, center_y, start_spread, end_spread, duration_ms }) => {
    const steps = Math.max(4, Math.floor(duration_ms / 16));
    const tracks = [
      { points: interpolate(center_x - start_spread/2, center_y, center_x - end_spread/2, center_y, steps) },
      { points: interpolate(center_x + start_spread/2, center_y, center_x + end_spread/2, center_y, steps) },
    ];
    const stepMs = Math.floor(duration_ms / steps);
    const cmd = `su -c '${buildMultiTouchDragCmds(tracks, stepMs)}'`;
    await shellExecQueued(cmd, duration_ms + 3000);
    invalidateUi();
    const dir = end_spread < start_spread ? "in" : "out";
    return { content: [{ type:"text", text:`Pinched ${dir}: ${start_spread}px→${end_spread}px around (${center_x},${center_y})` }] };
  }
);

// ── Gaming: vision / state detection ─────────────────────────────────────────

tool("pixel_color",
  "Read the color of a pixel at (x,y). Use to detect game state: HP bar color, button highlighted, cooldown ready, enemy visible.",
  { x: z.number(), y: z.number() },
  async ({ x, y }) => {
    const color = readPixelColor(x, y);
    return { content: [{ type:"text", text: JSON.stringify(color) }] };
  }
);

tool("screen_region",
  "Capture a sub-rectangle of the screen as PNG. Much faster than full screenshot for monitoring a specific game element (HP bar, minimap, cooldown timer).",
  { x: z.number(), y: z.number(), width: z.number(), height: z.number() },
  async ({ x, y, width, height }) => {
    const buf = captureRegion(x, y, width, height);
    return { content: [{ type:"image", data: buf.toString("base64"), mimeType:"image/png" }] };
  }
);

tool("screenshot", "Take a full screenshot. Returns base64 PNG.",
  {},
  async () => {
    const buf = takeScreenshot();
    return { content: [{ type:"image", data: buf.toString("base64"), mimeType:"image/png" }] };
  }
);

tool("get_stream_url", "Get the live MJPEG screen stream URL.",
  { fps: z.number().min(1).max(10).default(2) },
  async ({ fps }) => {
    const port = parseInt(process.env.PORT || "3456");
    return { content: [{ type:"text", text:`Viewer: http://localhost:${port}/view?fps=${fps}\nStream: http://localhost:${port}/stream?fps=${fps}` }] };
  }
);

// ── Performance ───────────────────────────────────────────────────────────────

tool("set_perf_mode",
  "Toggle high-performance CPU governor to reduce input latency for real-time games. Use 'performance' before gaming, 'balanced' when done.",
  { mode: z.enum(["performance","balanced","powersave"]) },
  async ({ mode }) => {
    const gov = mode === "performance" ? "performance" : mode === "powersave" ? "powersave" : "schedutil";
    const out = adbRoot(`for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo ${gov} > $f 2>/dev/null; done; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`);
    return { content: [{ type:"text", text:`CPU governor: ${out}` }] };
  }
);

tool("clipboard_set", "Copy text to device clipboard.",
  { text: z.string() },
  async ({ text }) => {
    adbRoot(`am broadcast -a clipper.SET -e text '${text.replace(/'/g,`'\\''`)}' 2>/dev/null; true`);
    return { content: [{ type:"text", text:"Clipboard set" }] };
  }
);

// ── File / App / System ───────────────────────────────────────────────────────

tool("push_file", "Push local file to device.",
  { local_path:z.string(), device_path:z.string() },
  async ({ local_path, device_path }) => ({ content: [{ type:"text", text: adbExec(["push", local_path, device_path]) }] })
);

tool("pull_file", "Pull file from device.",
  { device_path:z.string(), local_path:z.string().optional() },
  async ({ device_path, local_path }) => {
    const d = local_path || "/data/data/com.termux/files/home/pulled_file";
    return { content: [{ type:"text", text:`${adbExec(["pull", device_path, d])}\nSaved: ${d}` }] };
  }
);

tool("install_apk", "Install APK onto device.",
  { apk_path:z.string() },
  async ({ apk_path }) => ({ content: [{ type:"text", text: adbExec(["install", "-r", apk_path]) }] })
);

tool("launch_app", "Launch app by package name.",
  { package:z.string() },
  async ({ package: pkg }) => {
    const out = adb(`monkey -p ${sq(pkg)} -c android.intent.category.LAUNCHER 1`);
    invalidateUi();
    return { content: [{ type:"text", text: out }] };
  }
);

tool("root_shell", "Execute root shell command (Magisk su).",
  { command:z.string() },
  async ({ command }) => ({ content: [{ type:"text", text: adbRoot(command)||"(no output)" }] })
);

tool("list_packages", "List installed packages.",
  { filter:z.string().optional() },
  async ({ filter }) => ({ content: [{ type:"text", text: adb(`pm list packages${filter?" -e "+sq(filter):""}`) }] })
);

tool("get_current_app", "Get foreground app/activity.",
  {},
  async () => {
    const out = execSync(`adb -s ${DEVICE} shell dumpsys activity activities`, { encoding:"utf8", timeout:10000 });
    const m = out.match(/topResumedActivity=.*?([a-z][a-z0-9_.]+\/[.\w]+)/i);
    return { content: [{ type:"text", text: m ? m[1] : "unknown" }] };
  }
);

tool("start_network_capture", "Start tcpdump packet capture.",
  { output:z.string().default("/sdcard/capture.pcap"), interface:z.string().default("any"), filter:z.string().default("") },
  async ({ output, interface:iface, filter }) => {
    const o=output.replace(/[^a-zA-Z0-9/_.-]/g,""), i=iface.replace(/[^a-zA-Z0-9_.-]/g,""), f=filter.replace(/[^a-zA-Z0-9 ._!&|()]/g,"");
    adbRoot(`tcpdump -i ${i} -w ${o}${f?` '${f}'`:""} &`);
    return { content: [{ type:"text", text:`tcpdump → ${o}` }] };
  }
);

tool("stop_network_capture", "Stop tcpdump and pull pcap.",
  { remote_path:z.string().default("/sdcard/capture.pcap") },
  async ({ remote_path }) => {
    adbRoot("pkill tcpdump");
    const local="/data/data/com.termux/files/home/capture.pcap";
    adbExec(["pull", remote_path, local]);
    return { content: [{ type:"text", text:`Saved to ${local}` }] };
  }
);

tool("get_notifications", "Read current device notifications.",
  {},
  async () => ({ content: [{ type:"text", text: adbRoot("dumpsys notification --noredact 2>/dev/null | grep -A3 NotificationRecord | head -60")||"(none)" }] })
);

tool("device_info", "Get device model, Android version, battery, serial.",
  {},
  async () => {
    const props=["ro.product.model","ro.product.manufacturer","ro.build.version.release","ro.build.version.sdk","ro.serialno"];
    const info={};
    for (const p of props) info[p]=adb(`getprop ${p}`);
    info.battery=adb("dumpsys battery | grep -E 'level|status'");
    return { content: [{ type:"text", text: JSON.stringify(info,null,2) }] };
  }
);

tool("double_tap", "Double-tap at coordinates.",
  { x: z.number(), y: z.number(), delay_ms: z.number().default(100) },
  async ({ x, y, delay_ms }) => {
    await shellExecQueued(`input tap ${x} ${y} && sleep ${(delay_ms/1000).toFixed(3)} && input tap ${x} ${y}`);
    invalidateUi();
    return { content: [{ type:"text", text:`Double tapped (${x},${y})` }] };
  }
);

tool("force_stop", "Force-stop an app by package name.",
  { package: z.string() },
  async ({ package: pkg }) => {
    const out = adb(`am force-stop ${sq(pkg)}`);
    invalidateUi();
    return { content: [{ type:"text", text: out || `Force stopped ${pkg}` }] };
  }
);

tool("uninstall_apk", "Uninstall an app by package name.",
  { package: z.string(), keep_data: z.boolean().default(false) },
  async ({ package: pkg, keep_data }) => ({
    content: [{ type:"text", text: adbExec(keep_data ? ["uninstall","-k",pkg] : ["uninstall",pkg]) }]
  })
);

tool("clear_app_cache", "Clear an app's data and cache.",
  { package: z.string() },
  async ({ package: pkg }) => ({
    content: [{ type:"text", text: adb(`pm clear ${sq(pkg)}`) }]
  })
);

tool("reboot", "Reboot the device.",
  { mode: z.enum(["normal","recovery","bootloader"]).default("normal") },
  async ({ mode }) => {
    adbExec(mode !== "normal" ? ["reboot", mode] : ["reboot"]);
    return { content: [{ type:"text", text:`Rebooting (${mode})…` }] };
  }
);

tool("get_location",
  "Get current GPS coordinates from device location services.",
  {},
  async () => {
    const out = adb("dumpsys location 2>/dev/null | grep -F 'Location['");
    // Try fused (most accurate) then gps then network
    for (const provider of ["fused", "gps", "network", "passive"]) {
      const re = new RegExp(`Location\\[${provider}\\s+([\\-\\d.]+),([\\-\\d.]+)(?:\\s+hAcc=([\\d.]+))?`);
      const m = out.match(re);
      if (m) {
        const [, lat, lon, acc] = m;
        const accStr = acc ? ` \u00b1${Math.round(parseFloat(acc))}m` : "";
        return { content: [{ type:"text", text:`${parseFloat(lat).toFixed(6)}, ${parseFloat(lon).toFixed(6)}${accStr} (${provider})` }] };
      }
    }
    // Fallback: any Location[ line
    const m2 = out.match(/Location\[\w+ ([\-\d.]+),([\-\d.]+)/);
    if (m2) return { content: [{ type:"text", text:`${parseFloat(m2[1]).toFixed(6)}, ${parseFloat(m2[2]).toFixed(6)}` }] };
    return { content: [{ type:"text", text:"unavailable — ensure location is enabled" }] };
  }
);

tool("screen_record_start", "Start screen recording in background.",
  { output: z.string().default("/sdcard/screenrecord.mp4"), time_limit: z.number().default(180) },
  async ({ output, time_limit }) => {
    const safe = output.replace(/[^a-zA-Z0-9/_.-]/g, "");
    adbRoot(`screenrecord --time-limit ${time_limit} ${safe} &`);
    return { content: [{ type:"text", text:`Recording → ${safe} (max ${time_limit}s)` }] };
  }
);

tool("screen_record_stop", "Stop screen recording and pull the video.",
  { remote_path: z.string().default("/sdcard/screenrecord.mp4"), local_path: z.string().optional() },
  async ({ remote_path, local_path }) => {
    adbRoot("pkill screenrecord 2>/dev/null; true");
    await new Promise(r => setTimeout(r, 1200));
    const dest = local_path || "/data/data/com.termux/files/home/screenrecord.mp4";
    adbExec(["pull", remote_path, dest]);
    return { content: [{ type:"text", text:`Saved: ${dest}` }] };
  }
);

tool("wait_for_text", "Wait until specified text appears on screen.",
  { text: z.string(), timeout_ms: z.number().default(15000), poll_ms: z.number().default(500) },
  async ({ text, timeout_ms, poll_ms }) => {
    const el = await pollUntil(xml => findElement(xml, { partialText: text }), timeout_ms, poll_ms);
    if (!el) return { content: [{ type:"text", text:`"${text}" not found within ${timeout_ms}ms` }] };
    return { content: [{ type:"text", text:`Found "${text}" at (${el._x},${el._y})` }] };
  }
);

tool("rotate_screen", "Set screen rotation (0/90/180/270 degrees or auto).",
  { rotation: z.enum(["0","90","180","270","auto"]) },
  async ({ rotation }) => {
    if (rotation === "auto") {
      adb("settings put system accelerometer_rotation 1");
    } else {
      const val = { "0":0, "90":1, "180":2, "270":3 }[rotation] ?? 0;
      adb("settings put system accelerometer_rotation 0");
      adb(`settings put system user_rotation ${val}`);
    }
    return { content: [{ type:"text", text:`Rotation: ${rotation}` }] };
  }
);

// ── MJPEG stream ──────────────────────────────────────────────────────────────

const streamClients = new Map();
let streamTimer = null;

function rescheduleStream() {
  if (streamTimer) { clearInterval(streamTimer); streamTimer=null; }
  if (streamClients.size===0) return;
  const maxFps = Math.max(...streamClients.values());
  const ms = Math.floor(1000/maxFps);
  streamTimer = setInterval(() => {
    if (streamClients.size===0) { clearInterval(streamTimer); streamTimer=null; return; }
    let frame;
    try { frame=takeScreenshotJpeg(); } catch { return; }
    const header=Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
    const chunk=Buffer.concat([header,frame,Buffer.from("\r\n")]);
    for (const res of streamClients.keys()) {
      try { res.write(chunk); } catch { streamClients.delete(res); }
    }
  }, ms);
}

const CHAT_HTML = (apiKey) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<title>Agnes — thereallywow</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0e0e14;--surface:rgba(255,255,255,.05);--surface-2:rgba(255,255,255,.09);
  --border:rgba(255,255,255,.1);--border-focus:rgba(99,179,237,.6);
  --accent:#63b3ed;--accent-dim:rgba(99,179,237,.15);
  --text:#e2e8f0;--text-dim:#718096;--text-muted:#4a5568;
  --ok:#68d391;--err:#fc8181;--user-bg:rgba(99,179,237,.18);--agent-bg:rgba(255,255,255,.05);
  --r:12px;--r-sm:8px;
}
body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  height:100dvh;display:flex;flex-direction:column;overflow:hidden}
header{
  background:rgba(14,14,22,.95);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);padding:0 16px;height:52px;
  display:flex;align-items:center;gap:12px;flex-shrink:0;
}
.back{background:var(--surface);color:var(--text-dim);border:1px solid var(--border);
  border-radius:var(--r-sm);font:inherit;font-size:12px;padding:0 12px;height:32px;
  cursor:pointer;text-decoration:none;display:flex;align-items:center;gap:5px;transition:background .12s,color .12s}
.back:hover{background:var(--surface-2);color:var(--text)}
.title{font-weight:700;font-size:16px;letter-spacing:-.3px;
  background:linear-gradient(135deg,#e2e8f0,var(--accent));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.subtitle{color:var(--text-muted);font-size:11px}
#settingsbtn{margin-left:auto;background:var(--surface);color:var(--text-dim);border:1px solid var(--border);
  border-radius:var(--r-sm);font:inherit;font-size:12px;padding:0 12px;height:32px;cursor:pointer;transition:background .12s,color .12s}
#settingsbtn:hover{background:var(--surface-2);color:var(--text)}

#messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
#messages::-webkit-scrollbar{width:3px}
#messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}

.msg{display:flex;flex-direction:column;gap:4px;max-width:82%}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.agent{align-self:flex-start;align-items:flex-start}
.bubble{padding:10px 14px;border-radius:var(--r);line-height:1.55;font-size:13px;word-break:break-word;white-space:pre-wrap}
.msg.user .bubble{background:var(--user-bg);border:1px solid rgba(99,179,237,.3);border-bottom-right-radius:3px;color:var(--text)}
.msg.agent .bubble{background:var(--agent-bg);border:1px solid var(--border);border-bottom-left-radius:3px;color:var(--text)}
.msg.agent.err .bubble{background:rgba(252,129,129,.08);border-color:rgba(252,129,129,.3);color:var(--err)}
.who{font-size:10px;color:var(--text-muted);padding:0 4px;letter-spacing:.3px;font-weight:600;text-transform:uppercase}

.actions{display:flex;flex-direction:column;gap:3px;margin-top:2px;max-width:340px}
.action{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:var(--r-sm);overflow:hidden}
.action-hd{padding:7px 10px;font-size:11px;color:var(--accent);cursor:pointer;
  display:flex;align-items:center;gap:6px;user-select:none;font-family:'SF Mono','Cascadia Code',monospace}
.action-hd::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--ok);flex-shrink:0}
.action-body{display:none;padding:0 10px 8px;font-size:10px;font-family:'SF Mono','Cascadia Code',monospace;color:var(--text-dim);white-space:pre-wrap;word-break:break-all}
.action.open .action-body{display:block}
.action-hd .chevron{margin-left:auto;color:var(--text-muted);transition:transform .15s;font-size:10px}
.action.open .action-hd .chevron{transform:rotate(180deg)}

.typing{display:flex;align-items:center;gap:5px;padding:10px 14px;
  background:var(--agent-bg);border:1px solid var(--border);border-radius:var(--r);border-bottom-left-radius:3px}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--text-muted);animation:bounce .9s infinite}
.typing span:nth-child(2){animation-delay:.15s}
.typing span:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}

#empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-muted);text-align:center;padding:24px}
#empty .icon{font-size:36px;opacity:.4}
#empty h3{font-size:15px;font-weight:600;color:var(--text-dim)}
#empty p{font-size:12px;max-width:260px;line-height:1.5}
.suggestion{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);
  padding:8px 14px;font-size:12px;color:var(--text-dim);cursor:pointer;transition:background .12s,color .12s;
  text-align:left;margin-top:2px}
.suggestion:hover{background:var(--surface-2);color:var(--text)}

#compose{
  background:rgba(14,14,22,.95);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid var(--border);padding:12px 14px;
  display:flex;gap:8px;align-items:flex-end;flex-shrink:0;
}
#input{
  flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:var(--r);font:inherit;font-size:14px;padding:10px 14px;
  resize:none;max-height:120px;line-height:1.5;min-height:44px;
  transition:border-color .12s;
}
#input:focus{outline:none;border-color:var(--border-focus);background:var(--surface-2)}
#input::placeholder{color:var(--text-muted)}
#send{
  background:var(--accent);color:#0e0e14;border:none;border-radius:var(--r-sm);
  font:inherit;font-weight:600;font-size:13px;padding:0 18px;height:44px;
  cursor:pointer;flex-shrink:0;transition:opacity .12s;
}
#send:hover{opacity:.9}
#send:disabled{opacity:.35;cursor:not-allowed}

/* Overlay / modal shared */
.overlay{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.75);
  align-items:center;justify-content:center;padding:20px}
.overlay.show{display:flex}
.modal-box{background:#15151f;border:1px solid var(--border);border-radius:var(--r);
  padding:24px;width:100%;max-width:420px;display:flex;flex-direction:column;gap:16px}
.modal-box h3{font-size:16px;font-weight:700}
.modal-box h3 small{font-size:12px;color:var(--text-muted);font-weight:400;margin-left:6px}
.modal-box p{font-size:13px;color:var(--text-dim);line-height:1.55}
.modal-box label{font-size:11px;color:var(--text-dim);display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
.modal-box input,.modal-box textarea,.modal-box select{background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:var(--r-sm);font:inherit;font-size:13px;padding:8px 10px;width:100%}
.modal-box input,.modal-box select{height:42px;padding:0 10px}
.modal-box textarea{resize:none;font-family:'SF Mono','Cascadia Code',monospace;font-size:11px;line-height:1.5}
.modal-box input:focus,.modal-box textarea:focus,.modal-box select:focus{outline:none;border-color:var(--border-focus);background:var(--surface-2)}
.modal-box .hint-btn{width:100%;margin-top:2px;background:var(--surface);color:var(--accent);border:1px dashed rgba(99,179,237,.4);
  border-radius:var(--r-sm);font:inherit;font-size:12px;padding:8px;cursor:pointer;transition:background .12s}
.modal-box .hint-btn:hover{background:var(--accent-dim)}
.modal-row{display:flex;gap:8px}
.modal-row button{flex:1;background:var(--surface);color:var(--text);border:1px solid var(--border);
  border-radius:var(--r-sm);font:inherit;font-size:13px;height:42px;cursor:pointer;transition:background .12s,color .12s}
.modal-row button:hover{background:var(--surface-2);color:#fff}
.modal-row button.primary{background:var(--accent);color:#0e0e14;border:none;font-weight:700}
.modal-row button.primary:hover{opacity:.88}
.modal-note{font-size:11px;color:var(--text-muted);line-height:1.5}
.copy-row{display:flex;gap:6px;align-items:stretch}
.copy-row textarea{flex:1;min-height:90px}
.copy-row button{flex-shrink:0;width:52px;background:var(--surface);color:var(--text-dim);
  border:1px solid var(--border);border-radius:var(--r-sm);font:inherit;font-size:11px;cursor:pointer;transition:background .12s}
.copy-row button:hover{background:var(--surface-2);color:#fff}
.step-dots{display:flex;gap:6px;justify-content:center}
.step-dots span{width:7px;height:7px;border-radius:50%;background:var(--border)}
.step-dots span.active{background:var(--accent)}
.check{color:var(--ok);font-size:18px}

@media(max-width:480px){
  .msg{max-width:94%}
  #compose{padding:10px}
}
</style>
</head>
<body>
<header>
  <a class="back" href="/">&#8592; Control</a>
  <div>
    <div class="title">Agnes</div>
    <div class="subtitle">AI device control</div>
  </div>
  <button id="settingsbtn" onclick="openSettings()">&#9881; Settings</button>
</header>
<div id="messages">
  <div id="empty">
    <div class="icon">&#129302;</div>
    <h3>Agnes is ready</h3>
    <p>Tell Agnes what to do with the device. It can see the screen, tap, type, run commands, and more.</p>
    <button class="suggestion" onclick="suggest(this)">Take a screenshot and describe what you see</button>
    <button class="suggestion" onclick="suggest(this)">What app is currently open?</button>
    <button class="suggestion" onclick="suggest(this)">Go to the home screen</button>
    <button class="suggestion" onclick="suggest(this)">What is the battery level?</button>
  </div>
</div>
<div id="compose">
  <textarea id="input" placeholder="Tell Agnes what to do…" rows="1"></textarea>
  <button id="send" onclick="send()">Send</button>
</div>
<!-- Onboarding wizard -->
<div id="onboard" class="overlay">
  <div class="modal-box">

    <!-- Step 0: Enter Agnes API key -->
    <div id="step0">
      <h3>Connect Agnes AI</h3>
      <p>Enter your Agnes AI API key to start controlling the device with AI.</p>
      <p class="modal-note">Get a free key at <strong>apihub.agnes-ai.com</strong></p>
      <div>
        <label>Agnes API Key</label>
        <input id="ob-key" type="password" placeholder="Paste your Agnes API key…" autocomplete="new-password">
      </div>
      <div class="modal-row" style="margin-top:4px">
        <button onclick="closeOnboard()">Cancel</button>
        <button class="primary" onclick="onboardStep1()">Save &amp; Chat</button>
      </div>
    </div>
  </div>
</div>

<!-- Settings modal -->
<div id="modal" class="overlay">
  <div class="modal-box">
    <h3>Agnes Settings</h3>
    <div>
      <label>Agnes API Key</label>
      <input id="cfg-key" type="password" placeholder="(set — paste to change)" autocomplete="new-password">
    </div>
    <p class="modal-note">Get a free key at <strong>apihub.agnes-ai.com</strong> — saved to .env, persists across restarts.</p>
    <div>
      <label>API Base URL</label>
      <input id="cfg-url" type="url" placeholder="https://apihub.agnes-ai.com/v1" autocorrect="off" autocapitalize="off">
    </div>
    <div>
      <label>Model</label>
      <input id="cfg-model" type="text" placeholder="agnes-2.0-flash">
    </div>
    <button class="hint-btn" onclick="fillOllama()">⚡ Use a local Ollama model instead</button>
    <p class="modal-note">Runs fully offline on-device via <strong>Termux + Ollama</strong> (no cloud, no rate limits). Uses the same full tool list as any other model. No API key required — any value works. See README for setup.</p>
    <div class="modal-row">
      <button onclick="closeSettings()">Cancel</button>
      <button class="primary" onclick="saveSettings()">Save</button>
    </div>
  </div>
</div>
<script>
var _auth=${apiKey ? JSON.stringify('Bearer '+apiKey) : 'null'};
function _hdr(e){var h=e||{};if(_auth)h['Authorization']=_auth;return h;}
var chatHistory=[];
var busy=false;

function scrollBottom(){var m=document.getElementById('messages');m.scrollTop=m.scrollHeight;}

function suggest(btn){
  document.getElementById('input').value=btn.textContent;
  send();
}

function addMsg(role,text,actions,isErr,viaLocal){
  var empty=document.getElementById('empty');
  if(empty)empty.remove();
  var wrap=document.getElementById('messages');
  var div=document.createElement('div');
  div.className='msg '+role+(isErr?' err':'');
  var who=document.createElement('div');
  who.className='who';
  who.textContent=role==='user'?'You':(viaLocal?'Agnes · local model':'Agnes');
  div.appendChild(who);
  if(text){
    var b=document.createElement('div');
    b.className='bubble';
    b.textContent=text;
    div.appendChild(b);
  }
  if(actions&&actions.length){
    var ac=document.createElement('div');
    ac.className='actions';
    actions.forEach(function(a){
      var el=document.createElement('div');
      el.className='action';
      var hd=document.createElement('div');
      hd.className='action-hd';
      hd.innerHTML=a.tool+'<span class="chevron">&#9660;</span>';
      hd.onclick=function(){el.classList.toggle('open');};
      var bd=document.createElement('div');
      bd.className='action-body';
      bd.textContent=(a.args&&a.args!=='{}'?'Args: '+a.args+'\\n':'')+'\u2192 '+a.result.slice(0,400);
      el.appendChild(hd);el.appendChild(bd);
      ac.appendChild(el);
    });
    div.appendChild(ac);
  }
  wrap.appendChild(div);
  scrollBottom();
  return div;
}

function showTyping(){
  var empty=document.getElementById('empty');
  if(empty)empty.remove();
  var wrap=document.getElementById('messages');
  var div=document.createElement('div');
  div.className='msg agent';
  div.id='typing-indicator';
  var who=document.createElement('div');who.className='who';who.textContent='Agnes';
  var t=document.createElement('div');t.className='typing';
  t.innerHTML='<span></span><span></span><span></span>';
  div.appendChild(who);div.appendChild(t);
  wrap.appendChild(div);scrollBottom();
}
function hideTyping(){var t=document.getElementById('typing-indicator');if(t)t.remove();}

function autoResize(){
  var el=document.getElementById('input');
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight,120)+'px';
}

function send(){
  if(busy)return;
  var inp=document.getElementById('input');
  var text=inp.value.trim();
  if(!text)return;
  inp.value='';inp.style.height='';
  busy=true;
  document.getElementById('send').disabled=true;
  chatHistory.push({role:'user',content:text});
  addMsg('user',text);
  showTyping();
  fetch('/api/chat',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({history:chatHistory})
  }).then(function(r){return r.json();}).then(function(j){
    hideTyping();
    if(j.error){
      addMsg('agent',j.error,j.actions||[],true);
    } else {
      chatHistory.push({role:'assistant',content:j.reply});
      addMsg('agent',j.reply,j.actions||[],false,j.viaLocal);
    }
  }).catch(function(e){
    hideTyping();
    addMsg('agent','Network error: '+e.message,[],true);
  }).finally(function(){
    busy=false;
    document.getElementById('send').disabled=false;
    document.getElementById('input').focus();
  });
}

document.getElementById('input').addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
});
document.getElementById('input').addEventListener('input',autoResize);

function setEnv(k,v){
  return fetch('/api/setenv',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({key:k,value:v})
  }).then(function(r){return r.json();}).then(function(j){if(!j.ok)throw new Error(j.error);});
}

/* Onboarding wizard */
function showOnboard(){document.getElementById('onboard').classList.add('show');}
function closeOnboard(){document.getElementById('onboard').classList.remove('show');}
function onboardStep1(){
  var key=document.getElementById('ob-key').value.trim();
  if(!key){document.getElementById('ob-key').focus();return;}
  setEnv('AGNES_API_KEY',key).then(function(){
    closeOnboard();
  }).catch(function(e){alert('Could not save: '+e.message);});
}
document.getElementById('onboard').addEventListener('click',function(e){if(e.target===this)closeOnboard();});

/* Check on load — show connect banner if Agnes key not set */
fetch('/api/info',{headers:_hdr()}).then(function(r){return r.json();}).then(function(d){
  if(d.keys&&!d.keys.agnes_key_set){
    var empty=document.getElementById('empty');
    if(empty){
      var banner=document.createElement('button');
      banner.className='suggestion';
      banner.style.cssText='background:rgba(99,179,237,.12);border-color:rgba(99,179,237,.4);color:var(--accent);margin-top:8px;font-weight:600';
      banner.textContent='⚙ Connect Agnes AI (OpenClaw setup)';
      banner.onclick=function(){showOnboard();};
      empty.appendChild(banner);
    }
  }
}).catch(function(){});

/* Settings modal */
function openSettings(){
  fetch('/api/info',{headers:_hdr()}).then(function(r){return r.json();}).then(function(d){
    if(!d.keys)return;
    document.getElementById('cfg-key').placeholder=d.keys.agnes_key_set?'(set — paste to change)':'Paste Agnes API key…';
    document.getElementById('cfg-url').value=d.keys.agnes_base_url||'';
    document.getElementById('cfg-model').value=d.keys.agnes_model||'';
  }).catch(function(){});
  document.getElementById('modal').classList.add('show');
}
function closeSettings(){document.getElementById('modal').classList.remove('show');}
function fillOllama(){
  document.getElementById('cfg-key').value='ollama';
  document.getElementById('cfg-url').value='http://127.0.0.1:11434/v1';
  document.getElementById('cfg-model').value='hf.co/Salesforce/xLAM-2-3b-fc-r-gguf:Q4_K_M';
}
function saveSettings(){
  var key=document.getElementById('cfg-key').value.trim();
  var url=document.getElementById('cfg-url').value.trim();
  var model=document.getElementById('cfg-model').value.trim();
  var saves=[];
  if(key)saves.push(setEnv('AGNES_API_KEY',key));
  saves.push(setEnv('AGNES_BASE_URL',url));
  saves.push(setEnv('AGNES_MODEL',model));
  Promise.all(saves).then(function(){closeSettings();}).catch(function(e){alert('Save failed: '+e.message);});
}
document.getElementById('modal').addEventListener('click',function(e){if(e.target===this)closeSettings();});
</script>
</body>
</html>`;

const VIEWER_HTML = (port, fps, apiKey) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>thereallywow</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#0e0e14;
  --surface:rgba(255,255,255,.05);
  --surface-2:rgba(255,255,255,.08);
  --border:rgba(255,255,255,.1);
  --border-focus:rgba(99,179,237,.6);
  --accent:#63b3ed;
  --accent-dim:rgba(99,179,237,.15);
  --accent-press:rgba(99,179,237,.25);
  --text:#e2e8f0;
  --text-dim:#718096;
  --text-muted:#4a5568;
  --ok:#68d391;
  --err:#fc8181;
  --btn-h:38px;
  --radius:8px;
  --radius-sm:6px;
}
body{
  background:var(--bg);color:var(--text);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  height:100dvh;display:flex;flex-direction:column;overflow:hidden;
}
header,main,#statusbar{position:relative;z-index:1}
header{
  background:rgba(14,14,22,.9);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-bottom:1px solid var(--border);
  padding:0 14px;height:52px;display:flex;align-items:center;gap:10px;flex-shrink:0;
}
.logo{
  font-weight:700;font-size:15px;letter-spacing:-.3px;white-space:nowrap;
  background:linear-gradient(135deg,#e2e8f0 0%,var(--accent) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
#devinfo{color:var(--text-dim);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbtn{
  background:var(--surface);color:var(--text-dim);border:1px solid var(--border);
  border-radius:var(--radius-sm);font:inherit;font-size:11px;
  padding:0 10px;height:32px;cursor:pointer;white-space:nowrap;flex-shrink:0;
  transition:background .12s,color .12s,border-color .12s;
}
.hbtn:hover{background:var(--surface-2);color:var(--text);border-color:rgba(255,255,255,.18)}
.hbtn:active,.hbtn.on{background:var(--accent-press);color:var(--accent);border-color:var(--border-focus)}
#fpswrap{display:flex;align-items:center;gap:5px;flex-shrink:0}
#fpswrap label{color:var(--text-dim);font-size:11px}
select{
  background:var(--surface);color:var(--text);border:1px solid var(--border);
  font:inherit;font-size:12px;border-radius:var(--radius-sm);padding:0 8px;
  height:32px;cursor:pointer;outline:none;
}
select:focus{border-color:var(--border-focus)}

main{flex:1;display:flex;overflow:hidden;min-height:0}

#wrap{
  flex:1;display:flex;align-items:center;justify-content:center;
  background:#000;overflow:hidden;position:relative;
  cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:none;
  min-width:0;
}
#feed{max-width:100%;max-height:100%;object-fit:contain;display:block;pointer-events:none;border-radius:0}
#paused-overlay{
  display:none;position:absolute;inset:0;z-index:10;
  background:rgba(0,0,0,.7);align-items:center;justify-content:center;
  flex-direction:column;gap:10px;
}
#paused-overlay.show{display:flex}
#paused-overlay span{font-size:13px;color:var(--text-dim);letter-spacing:.5px}

aside{
  width:240px;flex-shrink:0;
  background:rgba(12,12,20,.95);
  border-left:1px solid var(--border);
  display:flex;flex-direction:column;overflow-y:auto;
}
aside::-webkit-scrollbar{width:3px}
aside::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:2px}

.sec{border-bottom:1px solid var(--border)}
.sec h4{
  font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;
  color:var(--text-dim);display:flex;align-items:center;justify-content:space-between;
  cursor:pointer;padding:11px 14px;
  user-select:none;-webkit-user-select:none;
  transition:color .12s;
}
.sec h4:hover{color:var(--text)}
.sec h4::after{content:'−';font-size:14px;font-weight:300;color:var(--text-muted);letter-spacing:0}
.sec.collapsed h4::after{content:'+'}
.sec-body{padding:0 10px 10px;overflow:hidden}
.sec.collapsed .sec-body{display:none}

.row{display:flex;gap:4px;margin-bottom:4px}
.row:last-child{margin-bottom:0}
.row button{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.full{width:100%;margin-bottom:5px;display:block}

button{
  background:var(--surface);color:var(--text);
  border:1px solid var(--border);font:inherit;font-size:12px;
  border-radius:var(--radius-sm);
  padding:0 10px;height:var(--btn-h);cursor:pointer;
  transition:background .12s,border-color .12s,color .12s;
}
button:hover{background:var(--surface-2);border-color:rgba(255,255,255,.18);color:#fff}
button:active{background:var(--accent-dim);border-color:var(--border-focus);color:var(--accent)}
input{
  background:var(--surface);color:var(--text);
  border:1px solid var(--border);font:inherit;font-size:13px;
  border-radius:var(--radius-sm);
  padding:0 10px;height:var(--btn-h);width:100%;
}
input:focus{outline:none;border-color:var(--border-focus);background:var(--surface-2)}
input::placeholder{color:var(--text-muted)}

#log{
  flex:1;overflow-y:auto;padding:8px 10px;
  font-size:11px;font-family:'SF Mono','Cascadia Code',monospace;
  color:var(--text-dim);min-height:50px;
  background:rgba(0,0,0,.2);
}
#log::-webkit-scrollbar{width:3px}
#log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:2px}
.ll{margin-bottom:3px;word-break:break-all;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:11px}
.ll.ok{color:#a0aec0}.ll.er{color:var(--err)}

#statusbar{
  background:rgba(10,10,18,.95);
  border-top:1px solid var(--border);
  padding:0 14px;height:30px;font-size:11px;color:var(--text-dim);
  flex-shrink:0;display:flex;align-items:center;gap:7px;
}
#dot{
  width:7px;height:7px;border-radius:50%;flex-shrink:0;
  background:var(--text-muted);
  transition:background .3s;
}
#dot.live{background:var(--ok);box-shadow:0 0 6px var(--ok)}
#dot.err{background:var(--err)}
#stmsg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Mobile ── */
@media (max-width:640px){
  :root{--btn-h:44px;--radius:10px;--radius-sm:8px}
  header{height:54px;padding:0 10px;gap:6px}
  .logo{font-size:16px}
  #devinfo{display:none}
  #gpsinfo{display:none!important}
  #fpswrap{display:none}
  #pausebtn{display:none}
  main{flex-direction:column}
  #wrap{flex:0 0 auto;height:calc(100vw * 16 / 9);max-height:52dvh;width:100%}
  aside{width:100%;flex:1;border-left:none;border-top:1px solid var(--border);overflow-y:auto}
  .sec h4{font-size:11px;padding:13px 14px}
  button{font-size:13px}
  input,select{font-size:15px}
  .hbtn{height:36px;font-size:12px;padding:0 10px}
}
@media (max-width:360px){
  .logo{font-size:14px}
}
</style>
</head>
<body>
<header>
  <span class="logo">thereallywow</span>
  <span id="devinfo">connecting…</span>
  <span id="gpsinfo" style="color:var(--ash-dim);font-size:10px;letter-spacing:.4px;white-space:nowrap;flex-shrink:0;display:none"></span>
  <div id="fpswrap">
    <label>fps</label>
    <select id="fps"><option>0.5</option><option>1</option><option>2</option><option>3</option><option>5</option><option>10</option></select>
  </div>
  <a href="/chat" class="hbtn" style="text-decoration:none;display:flex;align-items:center">&#129302; Agnes</a>
  <button id="pausebtn" class="hbtn" onclick="togglePause()">&#9646;&#9646; Pause</button>
  <button class="hbtn" onclick="snap()">&#9673; Snap</button>
</header>
<main>
<div id="wrap">
  <img id="feed" src="/stream?fps=${fps}${apiKey ? '&token='+encodeURIComponent(apiKey) : ''}" alt="screen">
  <div id="paused-overlay"><span>Stream paused</span></div>
</div>
<aside id="aside">
  <div class="sec" id="sec-nav">
    <h4 onclick="toggleSec('nav')">Navigate</h4>
    <div class="sec-body">
      <div class="row">
        <button data-k="KEYCODE_BACK">&#9664; Back</button>
        <button data-k="KEYCODE_HOME">&#8962; Home</button>
        <button data-k="KEYCODE_APP_SWITCH">&#8862; Recent</button>
      </div>
      <div class="row">
        <button data-k="KEYCODE_VOLUME_DOWN">Vol −</button>
        <button data-k="KEYCODE_VOLUME_UP">Vol +</button>
        <button data-k="KEYCODE_POWER">Power</button>
      </div>
    </div>
  </div>
  <div class="sec" id="sec-tx">
    <h4 onclick="toggleSec('tx')">Transmit</h4>
    <div class="sec-body">
      <input id="tin" type="text" class="full" placeholder="text to device…" autocorrect="off" autocapitalize="off">
      <div class="row">
        <button onclick="sendType()">&#9654; Send</button>
        <button data-k="KEYCODE_ENTER">&#8629; Enter</button>
        <button data-k="KEYCODE_DEL">&#9003; Del</button>
      </div>
    </div>
  </div>
  <div class="sec" id="sec-sh">
    <h4 onclick="toggleSec('sh')">Shell</h4>
    <div class="sec-body">
      <input id="shin" type="text" class="full" placeholder="# root command…" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button class="full" onclick="sendShell()">&#9654; Execute</button>
    </div>
  </div>
  <div class="sec collapsed" id="sec-lnk">
    <h4 onclick="toggleSec('lnk')">Link</h4>
    <div class="sec-body">
      <input id="adbin" type="text" class="full" placeholder="IP:PORT" autocorrect="off">
      <div class="row">
        <button onclick="reconnect()">&#10227; Reconnect</button>
        <button onclick="fixPort()"># Fix :5555</button>
      </div>
      <div id="adbst" style="font-size:9px;color:var(--ash-dim);margin-top:5px;letter-spacing:.4px">probing…</div>
    </div>
  </div>
  <div class="sec collapsed" id="sec-keys">
    <h4 onclick="toggleSec('keys')">Keys</h4>
    <div class="sec-body">
      <div style="font-size:9px;color:var(--ash-dim);margin-bottom:6px;letter-spacing:.4px">Values written to .env — never echoed back</div>
      <label style="font-size:9px;color:var(--ash-dim);letter-spacing:.5px;display:block;margin-bottom:3px">Agnes API Key <span id="agnes-key-status"></span></label>
      <input id="agnes-key-in" type="password" class="full" placeholder="OpenClaw gateway token" autocomplete="new-password">
      <div class="row" style="margin-bottom:8px">
        <button onclick="saveKey('AGNES_API_KEY','agnes-key-in','agnes-key-status')">Save</button>
        <button onclick="clearKey('AGNES_API_KEY','agnes-key-status')">Clear</button>
      </div>
      <label style="font-size:9px;color:var(--ash-dim);letter-spacing:.5px;display:block;margin-bottom:3px">Server Key (MCP_API_KEY) <span id="server-key-status"></span></label>
      <input id="server-key-in" type="password" class="full" placeholder="protects this server…" autocomplete="new-password">
      <div class="row">
        <button onclick="saveKey('MCP_API_KEY','server-key-in','server-key-status')">Save</button>
        <button onclick="clearKey('MCP_API_KEY','server-key-status')">Clear</button>
      </div>
      <div style="font-size:9px;color:var(--text-muted);margin-top:5px;letter-spacing:.3px">Server key change requires restart</div>
      <label style="font-size:9px;color:var(--text-dim);letter-spacing:.5px;display:block;margin-top:8px;margin-bottom:3px">OpenClaw Base URL</label>
      <input id="url-in" type="url" class="full" placeholder="http://localhost:18789/v1" autocorrect="off" autocapitalize="off" spellcheck="false">
      <button onclick="saveKey('AGNES_BASE_URL','url-in','')" class="full">Save URL</button>
    </div>
  </div>
  <div class="sec collapsed" id="sec-ars">
    <h4 onclick="toggleSec('ars')">Arsenal</h4>
    <div class="sec-body">
      <div class="row">
        <button onclick="c('device_info',{})">Device</button>
        <button onclick="c('get_ui_tree',{})">UI Tree</button>
        <button onclick="c('get_notifications',{})">Notifs</button>
      </div>
      <div class="row">
        <button onclick="pollGpsOnce()">&#9711; GPS</button>
        <button onclick="toggleGpsLog()" id="gpstoggle">GPS Auto</button>
      </div>
      <div class="row">
        <button onclick="c('set_perf_mode',{mode:'performance'})">Perf &#9650;</button>
        <button onclick="c('set_perf_mode',{mode:'balanced'})">Perf &#9660;</button>
        <button onclick="c('get_current_app',{})">App?</button>
      </div>
      <div class="row">
        <button onclick="c('screen_record_start',{})">&#9679; Rec</button>
        <button onclick="c('screen_record_stop',{})">&#9632; Stop</button>
        <button onclick="c('reboot',{mode:'normal'})">Reboot</button>
      </div>
      <div class="row">
        <button onclick="c('rotate_screen',{rotation:'90'})">&#8634; 90</button>
        <button onclick="c('rotate_screen',{rotation:'auto'})">&#8635; Auto</button>
        <button onclick="c('list_packages',{})">Packages</button>
      </div>
      <div class="row">
        <button onclick="c('start_network_capture',{})">&#9654; Net</button>
        <button onclick="c('stop_network_capture',{})">&#9632; Net</button>
      </div>
    </div>
  </div>
  <div class="sec collapsed" id="sec-inv">
    <h4 onclick="toggleSec('inv')">Invoke</h4>
    <div class="sec-body">
      <input id="pkgin" type="text" class="full" placeholder="com.package.name" autocorrect="off" autocapitalize="off" spellcheck="false">
      <div class="row">
        <button onclick="sendLaunch()">&#9654; Launch</button>
        <button onclick="sendForceStop()">&#9632; Stop</button>
      </div>
    </div>
  </div>
  <div class="sec" id="sec-log" style="border-bottom:none;flex:1;display:flex;flex-direction:column;min-height:120px">
    <h4 onclick="toggleSec('log')">Dispatch</h4>
    <div class="sec-body" style="padding:0;flex:1;display:flex;flex-direction:column">
      <div id="log"></div>
    </div>
  </div>
</aside>
</main>
<div id="statusbar"><span id="dot"></span><span id="stmsg">tap=touch · drag=swipe · hold 600ms=long-press</span></div>
<script>
var devW=720,devH=1600;
var _streamPaused=false;
var _streamSrc='';
var _auth=${apiKey ? JSON.stringify('Bearer '+apiKey) : 'null'};
function _hdr(e){var h=e||{};if(_auth)h['Authorization']=_auth;return h;}
function _get(p){return fetch(p,{headers:_hdr()});}

_get('/api/info').then(function(r){return r.json();}).then(function(d){
  devW=d.device_w||720;devH=d.device_h||1600;
  var txt=d.device+' \u00b7 '+devW+'x'+devH;
  if(d.tunnel_url)txt+=' \u00b7 '+d.tunnel_url;
  else if(d.mesh_ip)txt+=' \u00b7 mesh:'+d.mesh_ip;
  document.getElementById('devinfo').textContent=txt;
  if(d.keys){
    setKeyStatus('agnes-key-status', d.keys.agnes_key_set);
    setKeyStatus('server-key-status', d.keys.server_key_set);
  }
}).catch(function(){document.getElementById('devinfo').textContent='offline';});

function setStatus(msg){document.getElementById('stmsg').textContent=msg;}

function c(tool,params){
  setStatus('\u2192 '+tool+'\u2026');
  return fetch('/execute',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({tool_name:tool,parameters:params||{}})
  }).then(function(r){return r.json();}).then(function(j){
    var msg=String(j.result||j.error||'ok').slice(0,300);
    addLog(tool+': '+msg,!!j.error);
    setStatus(msg.slice(0,120));
    return j.result;
  }).catch(function(e){addLog('Error: '+e.message,true);});
}

function addLog(msg,isErr){
  var el=document.getElementById('log');
  var d=document.createElement('div');
  d.className='ll '+(isErr?'er':'ok');
  d.textContent=new Date().toTimeString().slice(0,8)+' '+msg;
  el.insertBefore(d,el.firstChild);
  while(el.children.length>100)el.removeChild(el.lastChild);
}

/* stream controls */
var feed=document.getElementById('feed');
var tok=${apiKey ? "'&token='+encodeURIComponent("+JSON.stringify(apiKey)+")" : "''"};
var fpsSel=document.getElementById('fps');
fpsSel.value='${fps}';
function streamUrl(){return '/stream?fps='+fpsSel.value+tok;}
_streamSrc=streamUrl();
feed.src=_streamSrc;

fpsSel.addEventListener('change',function(){
  if(!_streamPaused){_streamSrc=streamUrl();feed.src=_streamSrc;}
  else{_streamSrc=streamUrl();}
});

function togglePause(){
  _streamPaused=!_streamPaused;
  var btn=document.getElementById('pausebtn');
  var ov=document.getElementById('paused-overlay');
  if(_streamPaused){
    feed.src='';
    btn.textContent='\u25b6 Resume';btn.classList.add('on');
    ov.classList.add('show');
  } else {
    feed.src=_streamSrc=streamUrl();
    btn.textContent='\u23f8 Pause';btn.classList.remove('on');
    ov.classList.remove('show');
  }
}

/* auto-pause when tab hidden */
document.addEventListener('visibilitychange',function(){
  if(document.hidden&&!_streamPaused)togglePause();
  else if(!document.hidden&&_streamPaused)togglePause();
});

/* collapsible sections */
function toggleSec(id){
  var el=document.getElementById('sec-'+id);
  if(el)el.classList.toggle('collapsed');
}

/* key buttons */
document.querySelectorAll('[data-k]').forEach(function(b){
  b.addEventListener('click',function(){c('keyevent',{key:b.dataset.k});});
});

function sendType(){
  var v=document.getElementById('tin').value;
  if(v.trim()){c('type_text',{text:v});document.getElementById('tin').value='';}
}
document.getElementById('tin').addEventListener('keydown',function(e){if(e.key==='Enter')sendType();});

function sendShell(){
  var v=document.getElementById('shin').value.trim();
  if(v)c('root_shell',{command:v});
}
document.getElementById('shin').addEventListener('keydown',function(e){if(e.key==='Enter')sendShell();});

function sendLaunch(){
  var v=document.getElementById('pkgin').value.trim();
  if(v)c('launch_app',{package:v});
}
function sendForceStop(){
  var v=document.getElementById('pkgin').value.trim();
  if(v)c('force_stop',{package:v});
}
document.getElementById('pkgin').addEventListener('keydown',function(e){if(e.key==='Enter')sendLaunch();});

function reconnect(){
  var dev=document.getElementById('adbin').value.trim()||undefined;
  var st=document.getElementById('adbst');
  st.textContent='connecting\u2026';
  fetch('/reconnect',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify(dev?{device:dev}:{})
  }).then(function(r){return r.json();}).then(function(j){
    st.textContent=(j.ok?'connected: ':'failed: ')+j.device;
    st.style.color=j.ok?'var(--ok)':'var(--err)';
    addLog('reconnect: '+(j.ok?'ok':'fail')+' '+j.device,!j.ok);
  }).catch(function(e){st.textContent='error: '+e.message;st.style.color='var(--err)';});
}

function fixPort(){
  if(!confirm('Lock ADB to port 5555 via root?'))return;
  c('root_shell',{command:'setprop service.adb.tcp.port 5555; stop adbd; start adbd; sleep 1; mkdir -p /data/adb/service.d; printf "#!/system/bin/sh\\nsetprop service.adb.tcp.port 5555\\nstop adbd\\nstart adbd\\n" > /data/adb/service.d/99-adb-tcp.sh; chmod 755 /data/adb/service.d/99-adb-tcp.sh; getprop service.adb.tcp.port'}).then(function(res){
    setTimeout(function(){
      var ip=document.getElementById('adbin').value.trim().split(':')[0];
      var nd=ip+':5555';
      if(!nd.startsWith(':'))document.getElementById('adbin').value=nd;
    },2000);
  });
}

function pollAdb(){
  _get('/api/info').then(function(r){return r.json();}).then(function(d){
    var st=document.getElementById('adbst');
    st.textContent=(d.adb_alive?'Connected: ':'Disconnected: ')+d.device;
    st.style.color=d.adb_alive?'var(--ok)':'var(--err)';
    var dot=document.getElementById('dot');
    dot.className=d.adb_alive?'live':'err';
  }).catch(function(){});
}
pollAdb();setInterval(pollAdb,15000);

function snap(){
  c('screenshot',{}).then(function(b64){
    if(!b64)return;
    var a=document.createElement('a');
    a.href='data:image/png;base64,'+b64;
    a.download='screen_'+Date.now()+'.png';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
  });
}

/* touch/mouse input on feed */
var wrap=document.getElementById('wrap');
var ds=null;
function imgXY(ex,ey){
  var r=feed.getBoundingClientRect();
  if(!r.width||!r.height)return{x:0,y:0};
  return{
    x:Math.max(0,Math.min(devW,Math.round((ex-r.left)/r.width*devW))),
    y:Math.max(0,Math.min(devH,Math.round((ey-r.top)/r.height*devH)))
  };
}
function pstart(ex,ey){ds={t:Date.now(),p:imgXY(ex,ey)};}
function pend(ex,ey){
  if(!ds)return;
  var e2=imgXY(ex,ey),dt=Date.now()-ds.t;
  var dx=Math.abs(e2.x-ds.p.x),dy=Math.abs(e2.y-ds.p.y);
  if(dx<20&&dy<20){
    if(dt>600)c('long_press',{x:ds.p.x,y:ds.p.y,duration_ms:dt});
    else c('tap_coords',{x:ds.p.x,y:ds.p.y});
  }else{
    c('swipe',{x1:ds.p.x,y1:ds.p.y,x2:e2.x,y2:e2.y,duration_ms:Math.min(Math.max(dt,50),1200)});
  }
  ds=null;
}
/* GPS */
var _gpsTimer=null;
function _fetchGps(log){
  return fetch('/execute',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({tool_name:'get_location',parameters:{}})
  }).then(function(r){return r.json();}).then(function(j){
    var coords=String(j.result||'').trim();
    if(!coords)return;
    var el=document.getElementById('gpsinfo');
    el.textContent='\u25ce '+coords;
    el.style.display='';
    if(log)addLog('gps: '+coords,false);
  }).catch(function(){});
}
function pollGpsOnce(){_fetchGps(true);}
function toggleGpsLog(){
  var btn=document.getElementById('gpstoggle');
  if(_gpsTimer){
    clearInterval(_gpsTimer);_gpsTimer=null;
    btn.classList.remove('on');btn.textContent='GPS Auto';
    addLog('gps logging stopped',false);
  } else {
    _fetchGps(true);
    _gpsTimer=setInterval(function(){_fetchGps(true);},60000);
    btn.classList.add('on');btn.textContent='GPS Auto \u25cf';
    addLog('gps logging every 60s',false);
  }
}
_fetchGps(false);

function setKeyStatus(elId, isSet){
  var el=document.getElementById(elId);
  if(!el)return;
  el.textContent=isSet?'\u2014 set':'\u2014 not set';
  el.style.color=isSet?'var(--ok)':'var(--ash-dim)';
}
function saveKey(envKey, inputId, statusId){
  var val=document.getElementById(inputId).value.trim();
  if(!val){addLog('Key value empty — use Clear to remove',true);return;}
  fetch('/api/setenv',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({key:envKey,value:val})
  }).then(function(r){return r.json();}).then(function(j){
    if(j.ok){
      document.getElementById(inputId).value='';
      setKeyStatus(statusId,true);
      addLog(envKey+' saved'+(j.restart_required?' — restart to apply':''),false);
    } else {
      addLog('Save failed: '+(j.error||'unknown'),true);
    }
  }).catch(function(e){addLog('Save error: '+e.message,true);});
}
function clearKey(envKey, statusId){
  fetch('/api/setenv',{method:'POST',headers:_hdr({'Content-Type':'application/json'}),
    body:JSON.stringify({key:envKey,value:''})
  }).then(function(r){return r.json();}).then(function(j){
    if(j.ok){
      setKeyStatus(statusId,false);
      addLog(envKey+' cleared'+(j.restart_required?' — restart to apply':''),false);
    } else {
      addLog('Clear failed: '+(j.error||'unknown'),true);
    }
  }).catch(function(e){addLog('Clear error: '+e.message,true);});
}

wrap.addEventListener('mousedown',function(e){e.preventDefault();pstart(e.clientX,e.clientY);});
wrap.addEventListener('mouseup',function(e){pend(e.clientX,e.clientY);});
wrap.addEventListener('mouseleave',function(){ds=null;});
wrap.addEventListener('touchstart',function(e){e.preventDefault();pstart(e.touches[0].clientX,e.touches[0].clientY);},{passive:false});
wrap.addEventListener('touchend',function(e){pend(e.changedTouches[0].clientX,e.changedTouches[0].clientY);},{passive:false});
wrap.addEventListener('touchcancel',function(){ds=null;},{passive:false});
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

function checkAuth(req, res, url) {
  if (!currentApiKey()) return true;
  if ((req.headers["authorization"]||"") === `Bearer ${currentApiKey()}`) return true;
  if (url && url.searchParams.get("token") === currentApiKey()) return true;
  res.writeHead(401, {"Content-Type":"application/json","WWW-Authenticate":`Bearer realm="thereallywow"`});
  res.end(JSON.stringify({error:"Unauthorized"}));
  return false;
}

// Converts one zod type (as used across the tool shapes: number/string/boolean/enum/
// object/array, optionally wrapped in .optional()/.default()/.describe()) into its JSON
// Schema equivalent. This replaces a hand-typed, independently-maintained JSON schema
// that had drifted from the zod shapes actually enforced elsewhere -- deriving it here
// instead makes drift structurally impossible.
function zodTypeToJsonSchema(zt) {
  const def = zt._def;
  let schema;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      schema = zodTypeToJsonSchema(def.innerType);
      break;
    case "ZodNumber":  schema = { type: "number" }; break;
    case "ZodBoolean": schema = { type: "boolean" }; break;
    case "ZodEnum":    schema = { type: "string", enum: def.values }; break;
    case "ZodObject": {
      const { properties, required } = shapeToJsonSchema(zt.shape);
      schema = { type: "object", properties, ...(required.length ? { required } : {}) };
      break;
    }
    case "ZodArray":
      schema = { type: "array", items: zodTypeToJsonSchema(def.type) };
      break;
    case "ZodString":
    default:
      schema = { type: "string" };
      break;
  }
  if (def.description && !schema.description) schema.description = def.description;
  return schema;
}

function shapeToJsonSchema(shape) {
  const properties = {}, required = [];
  for (const [key, zt] of Object.entries(shape)) {
    properties[key] = zodTypeToJsonSchema(zt);
    if (!zt.isOptional()) required.push(key);
  }
  return { properties, required };
}

function buildOpenAIToolList() {
  return Object.values(TOOLS).map(t => {
    const { properties, required } = shapeToJsonSchema(t.shape);
    return { type:"function", function:{ name:t.name, description:t.description, parameters:{type:"object",properties,required} } };
  });
}

// Some tool-calling-specialist local models (e.g. Hammer2.1 via a hand-rolled Ollama
// Modelfile) emit a bare `[{"name":...,"arguments":{...}}]` JSON array as plain message
// content instead of populating the OpenAI `tool_calls` field — Ollama's generic
// extractor only recognizes the more common <tool_call> tag convention. Recover the
// calls from content so those models still work through the same execution loop.
function parseFallbackToolCalls(content) {
  if (typeof content !== "string") return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : content).trim();
  if (!raw.startsWith("[")) return null;
  let arr;
  try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr) || arr.length === 0 || !arr.every(c => c && typeof c.name === "string")) return null;
  return arr.map((c, i) => ({ id: `fallback_${i}`, function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
}

// Runs the tool-calling round loop against one OpenAI-compatible endpoint. Mutates the
// given `messages`/`actions` arrays in place (rather than working on copies) so that if
// this throws partway through — e.g. the cloud API rate-limits on round 2 after already
// running a tool call — whatever real progress was made survives and can be handed
// straight to a fallback endpoint instead of being silently discarded and re-run.
// `timeoutMs` bounds each individual request: without it, a stalled backend (a cold
// model load on weak hardware, Android Doze throttling a background Termux process, a
// half-dead connection to a crashed server) hangs the whole /api/chat call forever with
// no error — indistinguishable from the chat UI just spinning. A timeout turns that into
// a clear error, which for the cloud attempt also means it fails over to the local
// fallback promptly instead of blocking on a request that was never going to complete.
async function runChatCompletion(baseUrl, model, apiKey, messages, tools, actions, timeoutMs) {
  for (let round = 0; round < 12; round++) {
    let r;
    try {
      r = await fetch(`${baseUrl}/chat/completions`, {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},
        body: JSON.stringify({model, messages, tools, tool_choice:"auto", max_tokens:4096}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch(e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") throw new Error(`timed out after ${Math.round(timeoutMs/1000)}s waiting for ${baseUrl}`);
      throw new Error(`${baseUrl} unreachable: ${e.message}`);
    }
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${r.status}: ${txt.slice(0,300)}`);
    }
    const data = await r.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("Empty response");
    messages.push(msg);
    const toolCalls = msg.tool_calls?.length ? msg.tool_calls : parseFallbackToolCalls(msg.content);
    if (!toolCalls?.length) return msg.content || "";
    for (const call of toolCalls) {
      let result;
      try {
        result = String(await executeTool(call.function.name, JSON.parse(call.function.arguments||"{}"), "chat"));
      } catch(e) { result = "Error: "+e.message; }
      actions.push({tool:call.function.name, args:call.function.arguments, result});
      messages.push({role:"tool", tool_call_id:call.id, content:result});
    }
  }
  throw new Error("Too many tool rounds — may be looping");
}

async function executeTool(name, p, source = "http") {
  const t = TOOLS[name];
  if (!t) { auditLog(name, source, false); throw new Error(`Unknown tool: ${name}`); }
  const parsed = t.schema.safeParse(p || {});
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    auditLog(name, source, false);
    throw new Error(`Invalid parameters for ${name}: ${msg}`);
  }
  try {
    const result = await t.handler(parsed.data);
    auditLog(name, source, true);
    const item = result?.content?.[0];
    if (!item) return "";
    return item.type === "image" ? item.data : (item.text ?? String(item.data ?? ""));
  } catch (e) {
    auditLog(name, source, false);
    throw e;
  }
}

function startHttpServer(port = 3456) {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  const srv = http.createServer(async (req, res) => {
    Object.entries(CORS).forEach(([k,v]) => res.setHeader(k, v));

    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, "http://localhost");

    // ── Public routes (no auth) ────────────────────────────────────────────────

    if (url.pathname === "/" || url.pathname === "/view") {
      const fps = Math.min(10, Math.max(1, parseInt(url.searchParams.get("fps")||"2")));
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      return res.end(VIEWER_HTML(port, fps, currentApiKey()));
    }

    if (url.pathname === "/chat") {
      res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
      return res.end(CHAT_HTML(currentApiKey()));
    }

    // ── Auth-gated routes (token= accepted for browser <img> sources) ──────────

    if (!checkAuth(req, res, url)) return;

    if (url.pathname === "/stream") {
      const fps = Math.min(10, Math.max(1, parseInt(url.searchParams.get("fps")||"2")));
      res.writeHead(200, {"Content-Type":"multipart/x-mixed-replace;boundary=frame","Cache-Control":"no-cache","Connection":"keep-alive"});
      streamClients.set(res, fps); rescheduleStream();
      const cleanup = () => { streamClients.delete(res); rescheduleStream(); };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return;
    }

    if (url.pathname === "/screenshot.png" && req.method === "GET") {
      try {
        const buf = takeScreenshot();
        res.writeHead(200, {"Content-Type":"image/png","Cache-Control":"no-cache"});
        return res.end(buf);
      } catch(e) {
        res.writeHead(500); return res.end(e.message);
      }
    }

    // Body reader with 1 MB limit
    const body = await new Promise((resolve, reject) => {
      let d = "", size = 0;
      req.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(); return reject(new Error("Request body too large")); }
        d += chunk;
      });
      req.on("end", () => resolve(d));
      req.on("error", reject);
    }).catch(e => { res.writeHead(413, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:e.message})); return null; });
    if (body === null) return;

    if (url.pathname === "/health") {
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({status:"ok",server:"thereallywow",version:"1.0.0",device:DEVICE,device_w:DEVICE_W,device_h:DEVICE_H,adb_alive:adbIsAlive(),viewers:streamClients.size,tools:buildOpenAIToolList().length,tunnel:getTunnelUrl()}));
    }

    if (url.pathname === "/api/info") {
      const PORT = process.env.PORT || 3456;
      const tunnel = getTunnelUrl();
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({
        device:DEVICE, device_w:DEVICE_W, device_h:DEVICE_H,
        adb_alive:adbIsAlive(),
        mesh_ip:MESH_IP,
        tunnel_url:tunnel,
        stream:`/stream?fps=2`, viewer:`/`,
        tools:buildOpenAIToolList().length, version:"1.0.0",
        keys:{ server_key_set:!!currentApiKey(), agnes_key_set:!!readEnvKey("AGNES_API_KEY"),
               agnes_base_url:readEnvKey("AGNES_BASE_URL")||"", agnes_model:readEnvKey("AGNES_MODEL")||"",
               ollama_base_url:readEnvKey("OLLAMA_BASE_URL")||"http://127.0.0.1:11434/v1",
               ollama_model:readEnvKey("OLLAMA_MODEL")||"hf.co/Salesforce/xLAM-2-3b-fc-r-gguf:Q4_K_M" },
        agnes:{
          local:`http://localhost:${PORT}`,
          mesh: MESH_IP ? `http://${MESH_IP}:${PORT}` : null,
          public: tunnel || null,
          tools_path:`/tools`,
          execute_path:`/execute`,
          openai_compatible:true,
          system_prompt:"You control a rooted Android device via 44 thereallywow tools. screenshot/stream to see screen. tap_coords/multi_touch/swipe for input. root_shell for root commands. All tool calls POST to /execute with {tool_name, parameters}."
        }
      }));
    }

    if (url.pathname === "/api/setenv" && req.method === "POST") {
      if (!checkAuth(req, res, url)) return;
      const ALLOWED_KEYS = ["MCP_API_KEY", "AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "AGNES_TIMEOUT_MS", "OLLAMA_TIMEOUT_MS"];
      let key, value;
      try { ({key, value} = JSON.parse(body)); } catch {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error:"Invalid JSON"}));
      }
      if (!ALLOWED_KEYS.includes(key)) {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error:"Key not permitted"}));
      }
      try {
        const __dir = dirname(fileURLToPath(import.meta.url));
        const envPath = join(__dir, ".env");
        let lines = [];
        try { lines = readFileSync(envPath, "utf8").split("\n").filter(l => l.trim()); } catch {}
        const exists = lines.some(l => l.startsWith(key + "="));
        let updated;
        if (value) {
          updated = exists ? lines.map(l => l.startsWith(key+"=") ? `${key}=${value}` : l) : [...lines, `${key}=${value}`];
        } else {
          updated = lines.filter(l => !l.startsWith(key+"="));
        }
        writeFileSync(envPath, updated.join("\n") + "\n", {mode: 0o600});
        res.writeHead(200, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({ok:true, key, set:!!value, restart_required: false}));
      } catch(e) {
        res.writeHead(500, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error:e.message}));
      }
    }

    if (url.pathname === "/reconnect" && req.method === "POST") {
      let newDev = null;
      try { newDev = JSON.parse(body).device || null; } catch {}
      if (newDev && !isValidDeviceId(newDev)) {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error:"Invalid device id"}));
      }
      const ok = adbReconnect(newDev || undefined);
      // Persist new device to .env if changed
      if (newDev && newDev !== DEVICE) {
        try {
          const __dir = dirname(fileURLToPath(import.meta.url));
          const envPath = join(__dir, ".env");
          const lines = readFileSync(envPath, "utf8").split("\n");
          const updated = lines.map(l => l.startsWith("ADB_DEVICE=") ? `ADB_DEVICE=${DEVICE}` : l).join("\n");
          writeFileSync(envPath, updated);
        } catch {}
      }
      res.writeHead(ok ? 200 : 503, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok, device:DEVICE, adb_alive:adbIsAlive()}));
    }

    if (url.pathname === "/tools" && req.method === "GET") {
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({tools: buildOpenAIToolList()}));
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      try {
        const {tool_name, parameters} = JSON.parse(body);
        const result = await executeTool(tool_name, parameters||{}, "http");
        res.writeHead(200, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({result}));
      } catch(e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error: e.message}));
      }
    }

    if (url.pathname === "/api/openclaw-config") {
      if (!checkAuth(req, res, url)) return;
      const PORT = process.env.PORT || 3456;
      const tunnel = getTunnelUrl();
      const __dir = dirname(fileURLToPath(import.meta.url));
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({
        mcpServers: {
          thereallywow: {
            command: "node",
            args: [join(__dir, "server.mjs")],
            env: {
              MCP_MODE: "stdio",
              ...(currentApiKey() ? {MCP_API_KEY: currentApiKey()} : {})
            }
          }
        },
        http: {
          base_url: tunnel || `http://localhost:${PORT}`,
          local_url: `http://localhost:${PORT}`,
          tools: `GET /tools`,
          execute: `POST /execute`,
          chat: `GET /chat`,
          ...(currentApiKey() ? {api_key: currentApiKey()} : {})
        },
        system_prompt: "You control a rooted Android device via thereallywow tools. Use screenshot to see the screen, tap_coords/swipe for touch input, type_text to type, root_shell for root commands. Be concise and action-oriented."
      }, null, 2));
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      if (!checkAuth(req, res, url)) return;
      let history;
      try { ({history} = JSON.parse(body)); } catch {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error:"Expected {history:[...]}"}));
      }
      const cloudKey   = readEnvKey("AGNES_API_KEY");
      const cloudUrl   = (readEnvKey("AGNES_BASE_URL") || "https://apihub.agnes-ai.com/v1").replace(/\/+$/,"");
      const cloudModel = readEnvKey("AGNES_MODEL") || "agnes-2.0-flash";
      const localUrl   = (readEnvKey("OLLAMA_BASE_URL") || "http://127.0.0.1:11434/v1").replace(/\/+$/,"");
      const localModel = readEnvKey("OLLAMA_MODEL") || "hf.co/Salesforce/xLAM-2-3b-fc-r-gguf:Q4_K_M";
      // Local inference on weak/throttled hardware (cold model load, Android Doze
      // deprioritizing a background Termux process) can legitimately take a while, so it
      // gets a much longer budget than the cloud call before being treated as unreachable.
      const cloudTimeoutMs = parseInt(readEnvKey("AGNES_TIMEOUT_MS"))  || 45000;
      const localTimeoutMs = parseInt(readEnvKey("OLLAMA_TIMEOUT_MS")) || 180000;
      const sysprompt = "You control a rooted Android device via thereallywow tools. Use screenshot to see the screen, tap_coords/swipe for touch input, type_text to type, root_shell for root commands. Be concise and action-oriented. When asked to do something on the device, just do it.";
      const messages = [{role:"system",content:sysprompt}, ...history];
      const tools = buildOpenAIToolList();
      const actions = [];

      // Cloud Agnes AI is tried first when a key is configured. Any failure — out of
      // API calls (429), network refused/blocked, wrong/expired key, DNS failure, cloud
      // outage — falls through to a local Ollama instance automatically, no user action
      // needed. `messages`/`actions` are shared, so if the cloud got partway through a
      // multi-step tool call before failing, the fallback picks up from there instead of
      // re-running device actions that already happened.
      let cloudError = cloudKey ? null : new Error("AGNES_API_KEY not set");
      if (cloudKey) {
        try {
          const reply = await runChatCompletion(cloudUrl, cloudModel, cloudKey, messages, tools, actions, cloudTimeoutMs);
          res.writeHead(200, {"Content-Type":"application/json"});
          return res.end(JSON.stringify({reply, actions}));
        } catch(e) { cloudError = e; }
      }

      try {
        const reply = await runChatCompletion(localUrl, localModel, "ollama", messages, tools, actions, localTimeoutMs);
        res.writeHead(200, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({reply, actions, viaLocal:true, cloudError: cloudError.message}));
      } catch(localError) {
        res.writeHead(502, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({
          error: `Agnes cloud unavailable (${cloudError.message}) and local Ollama fallback also failed (${localError.message}). Add a cloud key in Settings, or run "ollama serve" and "ollama pull ${localModel}" for offline use.`,
          actions,
        }));
      }
    }


    res.writeHead(404, {"Content-Type":"application/json"});
    res.end(JSON.stringify({error:"Not found"}));
  });
  srv.listen(port, "0.0.0.0", () =>
    process.stderr.write(`[thereallywow] HTTP :${port} → http://localhost:${port}/\n`)
  );
  return srv;
}

// ── Entry point ───────────────────────────────────────────────────────────────
// Guarded so importing this file (e.g. from a test) only defines TOOLS/executeTool/
// startHttpServer etc. without also connecting to a real device, binding a real port,
// or opening a stdio transport — none of that should happen except when this file is
// actually run directly, exactly as it always ran before this guard existed.

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  // Reconnect once at startup, then check every 30s
  adbReconnect();
  setInterval(() => { if (!adbIsAlive()) adbReconnect(); }, 30000);

  const mode = process.env.MCP_MODE || "stdio";
  if (mode === "http") {
    startHttpServer(parseInt(process.env.PORT || "3456"));
    process.stderr.write("[thereallywow] HTTP mode — OpenAI/Agnes compatible\n");
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("[thereallywow] stdio mode — Claude Desktop / OpenClaw\n");
  }
}

export { TOOLS, executeTool, buildOpenAIToolList, startHttpServer, sq, isValidDeviceId };
