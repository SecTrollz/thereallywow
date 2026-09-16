#!/usr/bin/env node
/**
 * Moto Device Control MCP Server v3.0 — Gaming Edition
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
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import http from "http";

// Load .env from project directory (created by reallywow-setup.sh)
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  readFileSync(join(__dir, ".env"), "utf8").split("\n").forEach(line => {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const DEVICE       = process.env.ADB_DEVICE || "192.168.1.168:5556";
const API_KEY      = process.env.MCP_API_KEY || null;
const TOUCH_DEV    = "/dev/input/event7"; // DJN touchscreen, slots 0-9, 720x1600

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

function adbExec(args) {
  try { return execSync(`adb -s ${DEVICE} ${args}`, { encoding: "utf8", timeout: 30000 }).trim(); }
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

const server = new McpServer({ name: "moto-device-control", version: "3.0.0",
  description: "Full Android device control — UI, root, gaming input, multi-touch, network" });

// ── Navigation & UI tools ─────────────────────────────────────────────────────

server.tool("get_ui_tree", "Read current screen UI as text tree. No image needed for navigation.",
  { force_refresh: z.boolean().default(false) },
  async ({ force_refresh }) => ({ content: [{ type:"text", text: uiTree(uiDump(force_refresh)) }] })
);

server.tool("find_element", "Find a UI element and return coordinates without tapping.",
  { text: z.string().optional(), partial_text: z.string().optional(),
    resource_id: z.string().optional(), description: z.string().optional() },
  async ({ text, partial_text, resource_id, description }) => {
    const el = findElement(uiDump(), { text, partialText: partial_text, resourceId: resource_id, description });
    if (!el) return { content: [{ type:"text", text:"Not found" }] };
    return { content: [{ type:"text", text: JSON.stringify({ x:el._x, y:el._y, text:el.text, resourceId:el["resource-id"], bounds:el.bounds }) }] };
  }
);

server.tool("wait_for_element",
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

server.tool("tap_by_text", "Tap a UI element by visible text.",
  { text: z.string(), partial: z.boolean().default(false) },
  async ({ text, partial }) => {
    const el = findElement(uiDump(), partial ? { partialText:text } : { text });
    if (!el) return { content: [{ type:"text", text:`Not found: "${text}"` }] };
    await tap(el._x, el._y);
    return { content: [{ type:"text", text:`Tapped "${el.text}" at (${el._x},${el._y})` }] };
  }
);

// ── Basic input tools ─────────────────────────────────────────────────────────

server.tool("tap_coords", "Tap specific pixel coordinates.",
  { x: z.number(), y: z.number() },
  async ({ x, y }) => { await tap(x, y); return { content: [{ type:"text", text:`Tapped (${x},${y})` }] }; }
);

server.tool("long_press", "Long press at coordinates.",
  { x: z.number(), y: z.number(), duration_ms: z.number().default(800) },
  async ({ x, y, duration_ms }) => { await longPress(x,y,duration_ms); return { content: [{ type:"text", text:`Long pressed (${x},${y}) ${duration_ms}ms` }] }; }
);

server.tool("swipe", "Swipe between two points.",
  { x1:z.number(), y1:z.number(), x2:z.number(), y2:z.number(), duration_ms:z.number().default(300) },
  async ({ x1,y1,x2,y2,duration_ms }) => {
    await swipeCoords(x1,y1,x2,y2,duration_ms);
    return { content: [{ type:"text", text:`Swiped (${x1},${y1})→(${x2},${y2})` }] };
  }
);

server.tool("scroll", "Scroll in a direction.",
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

server.tool("type_text", "Type text into the focused field.",
  { text: z.string() },
  async ({ text }) => { await typeText(text); return { content: [{ type:"text", text:`Typed: ${text}` }] }; }
);

server.tool("keyevent", "Send Android key event (KEYCODE_BACK, KEYCODE_HOME, KEYCODE_ENTER, etc.).",
  { key: z.string() },
  async ({ key }) => { await keyeventCmd(key); return { content: [{ type:"text", text:`Sent: ${key}` }] }; }
);

// ── Gaming: batch & repeat ────────────────────────────────────────────────────

server.tool("batch_actions",
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

server.tool("repeat",
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

server.tool("rapid_tap",
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

server.tool("joystick",
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

server.tool("swipe_path",
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

server.tool("multi_touch",
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

server.tool("hold_and_do",
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

server.tool("pinch",
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

server.tool("pixel_color",
  "Read the color of a pixel at (x,y). Use to detect game state: HP bar color, button highlighted, cooldown ready, enemy visible.",
  { x: z.number(), y: z.number() },
  async ({ x, y }) => {
    const color = readPixelColor(x, y);
    return { content: [{ type:"text", text: JSON.stringify(color) }] };
  }
);

server.tool("screen_region",
  "Capture a sub-rectangle of the screen as PNG. Much faster than full screenshot for monitoring a specific game element (HP bar, minimap, cooldown timer).",
  { x: z.number(), y: z.number(), width: z.number(), height: z.number() },
  async ({ x, y, width, height }) => {
    const buf = captureRegion(x, y, width, height);
    return { content: [{ type:"image", data: buf.toString("base64"), mimeType:"image/png" }] };
  }
);

server.tool("screenshot", "Take a full screenshot. Returns base64 PNG.",
  {},
  async () => {
    const buf = takeScreenshot();
    return { content: [{ type:"image", data: buf.toString("base64"), mimeType:"image/png" }] };
  }
);

server.tool("get_stream_url", "Get the live MJPEG screen stream URL.",
  { fps: z.number().min(1).max(10).default(2) },
  async ({ fps }) => {
    const port = parseInt(process.env.PORT || "3456");
    return { content: [{ type:"text", text:`Viewer: http://localhost:${port}/view?fps=${fps}\nStream: http://localhost:${port}/stream?fps=${fps}` }] };
  }
);

// ── Performance ───────────────────────────────────────────────────────────────

server.tool("set_perf_mode",
  "Toggle high-performance CPU governor to reduce input latency for real-time games. Use 'performance' before gaming, 'balanced' when done.",
  { mode: z.enum(["performance","balanced","powersave"]) },
  async ({ mode }) => {
    const gov = mode === "performance" ? "performance" : mode === "powersave" ? "powersave" : "schedutil";
    const out = adbRoot(`for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo ${gov} > $f 2>/dev/null; done; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`);
    return { content: [{ type:"text", text:`CPU governor: ${out}` }] };
  }
);

server.tool("clipboard_set", "Copy text to device clipboard.",
  { text: z.string() },
  async ({ text }) => {
    adbRoot(`am broadcast -a clipper.SET -e text '${text.replace(/'/g,`'\\''`)}' 2>/dev/null; true`);
    return { content: [{ type:"text", text:"Clipboard set" }] };
  }
);

// ── File / App / System ───────────────────────────────────────────────────────

server.tool("push_file", "Push local file to device.",
  { local_path:z.string(), device_path:z.string() },
  async ({ local_path, device_path }) => ({ content: [{ type:"text", text: adbExec(`push "${local_path}" "${device_path}"`) }] })
);

server.tool("pull_file", "Pull file from device.",
  { device_path:z.string(), local_path:z.string().optional() },
  async ({ device_path, local_path }) => {
    const d = local_path || "/data/data/com.termux/files/home/pulled_file";
    return { content: [{ type:"text", text:`${adbExec(`pull "${device_path}" "${d}"`)}\nSaved: ${d}` }] };
  }
);

server.tool("install_apk", "Install APK onto device.",
  { apk_path:z.string() },
  async ({ apk_path }) => ({ content: [{ type:"text", text: adbExec(`install -r "${apk_path}"`) }] })
);

server.tool("launch_app", "Launch app by package name.",
  { package:z.string() },
  async ({ package: pkg }) => {
    const out = adb(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    invalidateUi();
    return { content: [{ type:"text", text: out }] };
  }
);

server.tool("root_shell", "Execute root shell command (Magisk su).",
  { command:z.string() },
  async ({ command }) => ({ content: [{ type:"text", text: adbRoot(command)||"(no output)" }] })
);

server.tool("list_packages", "List installed packages.",
  { filter:z.string().optional() },
  async ({ filter }) => ({ content: [{ type:"text", text: adb(`pm list packages${filter?" -e "+filter:""}`) }] })
);

server.tool("get_current_app", "Get foreground app/activity.",
  {},
  async () => {
    const out = execSync(`adb -s ${DEVICE} shell dumpsys activity activities`, { encoding:"utf8", timeout:10000 });
    const m = out.match(/topResumedActivity=.*?([a-z][a-z0-9_.]+\/[.\w]+)/i);
    return { content: [{ type:"text", text: m ? m[1] : "unknown" }] };
  }
);

server.tool("start_network_capture", "Start tcpdump packet capture.",
  { output:z.string().default("/sdcard/capture.pcap"), interface:z.string().default("any"), filter:z.string().default("") },
  async ({ output, interface:iface, filter }) => {
    const o=output.replace(/[^a-zA-Z0-9/_.-]/g,""), i=iface.replace(/[^a-zA-Z0-9_.-]/g,""), f=filter.replace(/[^a-zA-Z0-9 ._!&|()]/g,"");
    adbRoot(`tcpdump -i ${i} -w ${o}${f?` '${f}'`:""} &`);
    return { content: [{ type:"text", text:`tcpdump → ${o}` }] };
  }
);

server.tool("stop_network_capture", "Stop tcpdump and pull pcap.",
  { remote_path:z.string().default("/sdcard/capture.pcap") },
  async ({ remote_path }) => {
    adbRoot("pkill tcpdump");
    const local="/data/data/com.termux/files/home/capture.pcap";
    execSync(`adb -s ${DEVICE} pull "${remote_path}" "${local}"`, { timeout:30000 });
    return { content: [{ type:"text", text:`Saved to ${local}` }] };
  }
);

server.tool("get_notifications", "Read current device notifications.",
  {},
  async () => ({ content: [{ type:"text", text: adbRoot("dumpsys notification --noredact 2>/dev/null | grep -A3 NotificationRecord | head -60")||"(none)" }] })
);

server.tool("device_info", "Get device model, Android version, battery, serial.",
  {},
  async () => {
    const props=["ro.product.model","ro.product.manufacturer","ro.build.version.release","ro.build.version.sdk","ro.serialno"];
    const info={};
    for (const p of props) info[p]=adb(`getprop ${p}`);
    info.battery=adb("dumpsys battery | grep -E 'level|status'");
    return { content: [{ type:"text", text: JSON.stringify(info,null,2) }] };
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
    try { frame=takeScreenshot(); } catch { return; }
    const header=Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`);
    const chunk=Buffer.concat([header,frame,Buffer.from("\r\n")]);
    for (const res of streamClients.keys()) {
      try { res.write(chunk); } catch { streamClients.delete(res); }
    }
  }, ms);
}

const VIEWER_HTML = (port, fps) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Moto Live View</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;display:flex;flex-direction:column;
align-items:center;justify-content:center;min-height:100vh;font-family:monospace;color:#0f0}
img{max-width:100vw;max-height:92vh;object-fit:contain;border:1px solid #222;image-rendering:pixelated}
#bar{padding:6px 12px;font-size:11px;opacity:.6;display:flex;gap:16px}a{color:#0f0}</style>
</head><body>
<img src="/stream?fps=${fps}" id="feed" alt="Device screen">
<div id="bar"><span>moto-device-control v3.0</span>
<span>fps: <a href="/view?fps=1">1</a> <a href="/view?fps=2">2</a> <a href="/view?fps=3">3</a> <a href="/view?fps=5">5</a></span>
<span id="ts">${fps} fps</span></div></body></html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

function checkAuth(req, res) {
  if (!API_KEY) return true;
  if ((req.headers["authorization"]||"")===`Bearer ${API_KEY}`) return true;
  res.writeHead(401,{"Content-Type":"application/json"});
  res.end(JSON.stringify({error:"Unauthorized"}));
  return false;
}

function buildOpenAIToolList() {
  const T = (name, desc, props={}, req=[]) => ({ type:"function", function:{ name, description:desc, parameters:{type:"object",properties:props,required:req} } });
  const num = {type:"number"}, str = {type:"string"}, bool = {type:"boolean"};
  const point = {type:"object",properties:{x:num,y:num}};
  const action = {type:"object",properties:{type:str,x:num,y:num,x2:num,y2:num,duration:num,key:str,text:str,ms:num}};
  return [
    T("get_ui_tree",        "Read UI as text tree",           {force_refresh:bool}),
    T("find_element",       "Find element coords",            {text:str,partial_text:str,resource_id:str,description:str}),
    T("wait_for_element",   "Poll until element appears",     {text:str,partial_text:str,resource_id:str,description:str,timeout_ms:num,poll_ms:num}),
    T("tap_by_text",        "Tap element by text",            {text:str,partial:bool},["text"]),
    T("tap_coords",         "Tap x,y",                       {x:num,y:num},["x","y"]),
    T("long_press",         "Long press at x,y",             {x:num,y:num,duration_ms:num},["x","y"]),
    T("swipe",              "Swipe a→b",                     {x1:num,y1:num,x2:num,y2:num,duration_ms:num},["x1","y1","x2","y2"]),
    T("scroll",             "Scroll direction",              {direction:str,amount:num},["direction"]),
    T("type_text",          "Type text",                     {text:str},["text"]),
    T("keyevent",           "Android key event",             {key:str},["key"]),
    T("batch_actions",      "Multiple actions, one trip",    {actions:{type:"array",items:action}},["actions"]),
    T("repeat",             "Repeat actions N times",        {actions:{type:"array",items:action},count:num,interval_ms:num},["actions","count"]),
    T("rapid_tap",          "Auto-clicker",                  {x:num,y:num,times:num,interval_ms:num},["x","y"]),
    T("joystick",           "Analog stick simulation",       {center_x:num,center_y:num,angle_deg:num,distance_pct:num,radius:num,duration_ms:num},["center_x","center_y","angle_deg"]),
    T("swipe_path",         "Multi-waypoint gesture",        {points:{type:"array",items:point},duration_ms:num},["points"]),
    T("multi_touch",        "Simultaneous multi-finger",     {touches:{type:"array",items:point},duration_ms:num},["touches"]),
    T("hold_and_do",        "Hold finger + tap elsewhere",   {hold:point,actions:{type:"array",items:action},release_after_ms:num},["hold","actions"]),
    T("pinch",              "Pinch in or out",               {center_x:num,center_y:num,start_spread:num,end_spread:num,duration_ms:num},["center_x","center_y"]),
    T("pixel_color",        "Read pixel color",              {x:num,y:num},["x","y"]),
    T("screen_region",      "Crop screenshot",               {x:num,y:num,width:num,height:num},["x","y","width","height"]),
    T("screenshot",         "Full screenshot PNG",           {}),
    T("get_stream_url",     "Live MJPEG URL",                {fps:num}),
    T("set_perf_mode",      "CPU performance mode",          {mode:str},["mode"]),
    T("clipboard_set",      "Set device clipboard",          {text:str},["text"]),
    T("push_file",          "Push file to device",           {local_path:str,device_path:str},["local_path","device_path"]),
    T("pull_file",          "Pull file from device",         {device_path:str,local_path:str},["device_path"]),
    T("install_apk",        "Install APK",                   {apk_path:str},["apk_path"]),
    T("launch_app",         "Launch app by package",         {package:str},["package"]),
    T("root_shell",         "Root shell command",            {command:str},["command"]),
    T("list_packages",      "List packages",                 {filter:str}),
    T("get_current_app",    "Foreground app",                {}),
    T("start_network_capture","Start tcpdump",              {output:str,interface:str,filter:str}),
    T("stop_network_capture", "Stop tcpdump + pull pcap",   {remote_path:str}),
    T("get_notifications",  "Read notifications",            {}),
    T("device_info",        "Device model/OS/battery",       {}),
  ];
}

async function executeTool(name, p) {
  switch(name) {
    case "get_ui_tree":       return uiTree(uiDump(p.force_refresh));
    case "find_element": {
      const el=findElement(uiDump(),{text:p.text,partialText:p.partial_text,resourceId:p.resource_id,description:p.description});
      return el?JSON.stringify({x:el._x,y:el._y,text:el.text,resourceId:el["resource-id"],bounds:el.bounds}):"Not found";
    }
    case "wait_for_element": {
      const el=await pollUntil(xml=>findElement(xml,{text:p.text,partialText:p.partial_text,resourceId:p.resource_id,description:p.description}),p.timeout_ms||10000,p.poll_ms||500);
      return el?JSON.stringify({x:el._x,y:el._y,text:el.text,bounds:el.bounds}):`Not found within ${p.timeout_ms||10000}ms`;
    }
    case "tap_by_text": {
      const el=findElement(uiDump(),p.partial?{partialText:p.text}:{text:p.text});
      if(!el) return `Not found: "${p.text}"`;
      await tap(el._x,el._y); return `Tapped "${el.text}" at (${el._x},${el._y})`;
    }
    case "tap_coords":        await tap(p.x,p.y); return `Tapped (${p.x},${p.y})`;
    case "long_press":        await longPress(p.x,p.y,p.duration_ms||800); return `Long pressed`;
    case "swipe":             await swipeCoords(p.x1,p.y1,p.x2,p.y2,p.duration_ms||300); return "Swiped";
    case "scroll": {
      const xml=uiDump(),m=xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W=m?parseInt(m[1]):1080,H=m?parseInt(m[2]):1920,cx=W>>1,cy=H>>1,amt=p.amount||0.5;
      const c={up:[cx,cy+Math.round(H*amt),cx,cy-Math.round(H*amt)],down:[cx,cy-Math.round(H*amt),cx,cy+Math.round(H*amt)],left:[cx+Math.round(W*amt),cy,cx-Math.round(W*amt),cy],right:[cx-Math.round(W*amt),cy,cx+Math.round(W*amt),cy]}[p.direction];
      await swipeCoords(...c,400); return `Scrolled ${p.direction}`;
    }
    case "type_text":         await typeText(p.text); return "Typed";
    case "keyevent":          await keyeventCmd(p.key); return `Sent: ${p.key}`;
    case "batch_actions": {
      const cmds=[];
      for(const a of p.actions||[]) {
        if(a.type==="tap")      cmds.push(`input tap ${a.x} ${a.y}`);
        if(a.type==="swipe")    cmds.push(`input swipe ${a.x} ${a.y} ${a.x2} ${a.y2} ${a.duration||300}`);
        if(a.type==="keyevent") cmds.push(`input keyevent ${a.key}`);
        if(a.type==="type")     cmds.push(`input text '${(a.text||"").replace(/ /g,"%s").replace(/'/g,"''")}'`);
        if(a.type==="sleep")    cmds.push(`sleep ${((a.ms||500)/1000).toFixed(3)}`);
      }
      await shellExecQueued(cmds.join(" && ")); invalidateUi();
      return `Executed ${(p.actions||[]).length} actions`;
    }
    case "repeat": {
      const innerCmds=[];
      for(const a of p.actions||[]) {
        if(a.type==="tap")      innerCmds.push(`input tap ${a.x} ${a.y}`);
        if(a.type==="swipe")    innerCmds.push(`input swipe ${a.x} ${a.y} ${a.x2} ${a.y2} ${a.duration||300}`);
        if(a.type==="keyevent") innerCmds.push(`input keyevent ${a.key}`);
        if(a.type==="type")     innerCmds.push(`input text '${(a.text||"").replace(/ /g,"%s").replace(/'/g,"''")}'`);
        if(a.type==="sleep")    innerCmds.push(`sleep ${((a.ms||500)/1000).toFixed(3)}`);
      }
      const gap=p.interval_ms>0?`sleep ${(p.interval_ms/1000).toFixed(3)}`:"";
      const iter=innerCmds.join(" && ");
      const cmd=p.count<=20?Array(p.count).fill(iter).join(gap?` && ${gap} && `:" && ")
        :`for i in $(seq 1 ${p.count}); do ${iter}${gap?`; ${gap}`:""};  done`;
      await shellExecQueued(cmd,p.count*(innerCmds.length*200+(p.interval_ms||0))+10000);
      invalidateUi(); return `Repeated ${p.count}x`;
    }
    case "rapid_tap": {
      const s=(p.interval_ms/1000).toFixed(3),t=p.times||10,x=p.x,y=p.y;
      const cmd=t<=30?Array(t).fill(`input tap ${x} ${y}`).join(` && sleep ${s} && `)
        :`for i in $(seq 1 ${t}); do input tap ${x} ${y}; sleep ${s}; done`;
      await shellExecQueued(cmd,t*(p.interval_ms+300)+5000); invalidateUi();
      return `Tapped ${t}x at (${x},${y})`;
    }
    case "joystick": {
      const rad=(p.angle_deg*Math.PI)/180,dist=(p.radius||120)*(p.distance_pct||0.8);
      const tx=Math.round(p.center_x+Math.cos(rad)*dist),ty=Math.round(p.center_y-Math.sin(rad)*dist);
      await swipeCoords(p.center_x,p.center_y,tx,ty,p.duration_ms||500);
      return `Joystick ${p.angle_deg}° → (${tx},${ty})`;
    }
    case "swipe_path": {
      const pts=p.points,segMs=Math.floor((p.duration_ms||600)/(pts.length-1));
      const cmds=[se(EV_ABS,ABS_MT_SLOT,0),se(EV_ABS,ABS_MT_TRACKING_ID,1),se(EV_ABS,ABS_MT_POS_X,pts[0].x),se(EV_ABS,ABS_MT_POS_Y,pts[0].y),se(EV_SYN,SYN_REPORT,0)];
      for(let i=1;i<pts.length;i++){const steps=Math.max(1,Math.floor(segMs/16));const ip=interpolate(pts[i-1].x,pts[i-1].y,pts[i].x,pts[i].y,steps);for(const pp of ip.slice(1)){cmds.push("sleep 0.016",se(EV_ABS,ABS_MT_SLOT,0),se(EV_ABS,ABS_MT_POS_X,pp.x),se(EV_ABS,ABS_MT_POS_Y,pp.y),se(EV_SYN,SYN_REPORT,0));}}
      cmds.push(se(EV_ABS,ABS_MT_SLOT,0),se(EV_ABS,ABS_MT_TRACKING_ID,LIFT),se(EV_SYN,SYN_REPORT,0));
      await shellExecQueued(`su -c '${cmds.join(" && ")}'`,(p.duration_ms||600)+5000); invalidateUi();
      return `Swipe path: ${pts.length} waypoints`;
    }
    case "multi_touch": {
      await shellExecQueued(`su -c '${buildMultiTouchCmds(p.touches,p.duration_ms||200)}'`,(p.duration_ms||200)+3000);
      invalidateUi(); return `${p.touches.length}-finger touch`;
    }
    case "hold_and_do": {
      const cmds=[`su -c '${se(EV_ABS,ABS_MT_SLOT,0)} && ${se(EV_ABS,ABS_MT_TRACKING_ID,1)} && ${se(EV_ABS,ABS_MT_POS_X,p.hold.x)} && ${se(EV_ABS,ABS_MT_POS_Y,p.hold.y)} && ${se(EV_SYN,SYN_REPORT,0)}'`];
      for(const a of p.actions||[]){if(a.type==="tap")cmds.push(`input tap ${a.x} ${a.y}`);if(a.type==="sleep")cmds.push(`sleep ${((a.ms||100)/1000).toFixed(3)}`);}
      if(p.release_after_ms>0)cmds.push(`sleep ${(p.release_after_ms/1000).toFixed(3)}`);
      cmds.push(`su -c '${se(EV_ABS,ABS_MT_SLOT,0)} && ${se(EV_ABS,ABS_MT_TRACKING_ID,LIFT)} && ${se(EV_SYN,SYN_REPORT,0)}'`);
      await shellExecQueued(cmds.join(" && "),15000); invalidateUi();
      return `Held (${p.hold.x},${p.hold.y}) + ${(p.actions||[]).length} actions`;
    }
    case "pinch": {
      const steps=Math.max(4,Math.floor((p.duration_ms||400)/16));
      const ss=p.start_spread||300,es=p.end_spread||50,cx=p.center_x,cy=p.center_y;
      const tracks=[{points:interpolate(cx-ss/2,cy,cx-es/2,cy,steps)},{points:interpolate(cx+ss/2,cy,cx+es/2,cy,steps)}];
      await shellExecQueued(`su -c '${buildMultiTouchDragCmds(tracks,Math.floor((p.duration_ms||400)/steps))}'`,(p.duration_ms||400)+3000);
      invalidateUi(); return `Pinched ${es<ss?"in":"out"} ${ss}→${es}px`;
    }
    case "pixel_color":       return JSON.stringify(readPixelColor(p.x,p.y));
    case "screen_region":     return captureRegion(p.x,p.y,p.width,p.height).toString("base64");
    case "screenshot":        return takeScreenshot().toString("base64");
    case "get_stream_url":    { const port=parseInt(process.env.PORT||"3456"),fps=p.fps||2; return `Viewer: http://localhost:${port}/view?fps=${fps}\nStream: http://localhost:${port}/stream?fps=${fps}`; }
    case "set_perf_mode":     { const gov=p.mode==="performance"?"performance":p.mode==="powersave"?"powersave":"schedutil"; return adbRoot(`for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo ${gov} > $f 2>/dev/null; done; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`); }
    case "clipboard_set":     adbRoot(`am broadcast -a clipper.SET -e text '${p.text.replace(/'/g,`'\\''`)}' 2>/dev/null; true`); return "Set";
    case "push_file":         return adbExec(`push "${p.local_path}" "${p.device_path}"`);
    case "pull_file":         { const d=p.local_path||"/data/data/com.termux/files/home/pulled_file"; return adbExec(`pull "${p.device_path}" "${d}"`)+`\nSaved: ${d}`; }
    case "install_apk":       return adbExec(`install -r "${p.apk_path}"`);
    case "launch_app":        invalidateUi(); return adb(`monkey -p ${p.package} -c android.intent.category.LAUNCHER 1`);
    case "root_shell":        return adbRoot(p.command)||"(no output)";
    case "list_packages":     return adb(`pm list packages${p.filter?" -e "+p.filter:""}`);
    case "get_current_app":   { const out=execSync(`adb -s ${DEVICE} shell dumpsys activity activities`,{encoding:"utf8",timeout:10000}); const m=out.match(/topResumedActivity=.*?([a-z][a-z0-9_.]+\/[.\w]+)/i); return m?m[1]:"unknown"; }
    case "start_network_capture": { const o=(p.output||"/sdcard/capture.pcap").replace(/[^a-zA-Z0-9/_.-]/g,""),i=(p.interface||"any").replace(/[^a-zA-Z0-9_.-]/g,""),f=(p.filter||"").replace(/[^a-zA-Z0-9 ._!&|()]/g,""); adbRoot(`tcpdump -i ${i} -w ${o}${f?` '${f}'`:""} &`); return `Started → ${o}`; }
    case "stop_network_capture":  { adbRoot("pkill tcpdump"); const local="/data/data/com.termux/files/home/capture.pcap"; execSync(`adb -s ${DEVICE} pull "${p.remote_path||"/sdcard/capture.pcap"}" "${local}"`,{timeout:30000}); return `Saved to ${local}`; }
    case "get_notifications": return adbRoot("dumpsys notification --noredact 2>/dev/null | grep -A3 NotificationRecord | head -60")||"(none)";
    case "device_info":       { const props=["ro.product.model","ro.product.manufacturer","ro.build.version.release","ro.build.version.sdk","ro.serialno"]; return JSON.stringify(Object.fromEntries(props.map(p=>[p,adb(`getprop ${p}`)])),null,2); }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function startHttpServer(port = 3456) {
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/stream") {
      const fps = Math.min(10, Math.max(1, parseInt(url.searchParams.get("fps")||"2")));
      res.writeHead(200, {"Content-Type":"multipart/x-mixed-replace;boundary=frame","Cache-Control":"no-cache","Connection":"keep-alive","Access-Control-Allow-Origin":"*"});
      streamClients.set(res, fps); rescheduleStream();
      req.on("close", () => { streamClients.delete(res); rescheduleStream(); });
      return;
    }

    if (url.pathname === "/view") {
      const fps = Math.min(10, Math.max(1, parseInt(url.searchParams.get("fps")||"2")));
      res.writeHead(200, {"Content-Type":"text/html"});
      return res.end(VIEWER_HTML(port, fps));
    }

    if (!checkAuth(req, res)) return;

    const body = await new Promise(r => { let d=""; req.on("data",c=>d+=c); req.on("end",()=>r(d)); });

    if (url.pathname === "/health") {
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({status:"ok",server:"moto-device-control",version:"3.0.0",viewers:streamClients.size,stream:`http://localhost:${port}/view`}));
    }

    if (url.pathname === "/tools" && req.method === "GET") {
      res.writeHead(200, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({tools: buildOpenAIToolList()}));
    }

    if (url.pathname === "/execute" && req.method === "POST") {
      try {
        const {tool_name, parameters} = JSON.parse(body);
        const result = await executeTool(tool_name, parameters||{});
        res.writeHead(200, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({result}));
      } catch(e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        return res.end(JSON.stringify({error: e.message}));
      }
    }

    res.writeHead(404); res.end();
  });
  srv.listen(port, "0.0.0.0", () =>
    process.stderr.write(`[moto-mcp] HTTP :${port} — viewer: http://localhost:${port}/view\n`)
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

const mode = process.env.MCP_MODE || "stdio";
if (mode === "http") {
  startHttpServer(parseInt(process.env.PORT || "3456"));
  process.stderr.write("[moto-mcp] HTTP mode — Agnes AI / OpenAI compatible\n");
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[moto-mcp] stdio mode — OpenClaw / Claude Desktop\n");
}
