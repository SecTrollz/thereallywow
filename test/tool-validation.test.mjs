import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, executeTool, buildOpenAIToolList } from "../server.mjs";

test("TOOLS registry has exactly one entry per tool, matching MCP/HTTP tool counts", () => {
  const names = Object.keys(TOOLS);
  assert.equal(new Set(names).size, names.length, "duplicate tool names in TOOLS");
  assert.equal(buildOpenAIToolList().length, names.length, "buildOpenAIToolList() drifted from TOOLS");
});

test("executeTool: rejects a call missing a required parameter", async () => {
  await assert.rejects(
    () => executeTool("tap_coords", { x: 10 }),
    /Invalid parameters for tap_coords/,
  );
});

test("executeTool: rejects a call with the wrong parameter type", async () => {
  await assert.rejects(
    () => executeTool("tap_coords", { x: "not-a-number", y: 20 }),
    /Invalid parameters for tap_coords/,
  );
});

test("executeTool: rejects an out-of-enum value", async () => {
  await assert.rejects(
    () => executeTool("reboot", { mode: "melt-the-device" }),
    /Invalid parameters for reboot/,
  );
});

test("executeTool: rejects an unknown tool name", async () => {
  await assert.rejects(
    () => executeTool("definitely_not_a_real_tool", {}),
    /Unknown tool/,
  );
});

test("executeTool: accepts well-formed parameters for every tool's schema (dry validation)", () => {
  // Full execution would require a real device; this only proves the schema itself
  // accepts the kind of input each tool is documented to take, so a legitimate call
  // is never rejected by the new validation layer.
  const sample = {
    x: 1, y: 1, x1: 1, y1: 1, x2: 2, y2: 2, width: 10, height: 10,
    text: "hi", key: "KEYCODE_BACK", command: "echo hi", package: "com.android.chrome",
    filter: "chrome", local_path: "/tmp/a", device_path: "/sdcard/a", apk_path: "/tmp/a.apk",
    output: "/sdcard/out.pcap", remote_path: "/sdcard/out.pcap", mode: "normal",
    center_x: 1, center_y: 1, angle_deg: 90, radius: 100, duration_ms: 100,
    start_spread: 100, end_spread: 50, hold: { x: 1, y: 1 }, touches: [{x:1,y:1},{x:2,y:2}],
    points: [{x:1,y:1},{x:2,y:2}], actions: [{ type: "sleep", ms: 10 }], count: 2,
    times: 1, interval_ms: 100, rotation: "0", keep_data: false, fps: 2, direction: "up",
  };
  // A couple of keys (e.g. "mode") mean different enums on different tools, so they
  // need a per-tool override rather than one global sample value.
  const overrides = { set_perf_mode: { mode: "performance" } };
  for (const t of Object.values(TOOLS)) {
    const params = {};
    for (const key of Object.keys(t.shape)) {
      if (overrides[t.name]?.[key] !== undefined) params[key] = overrides[t.name][key];
      else if (key in sample) params[key] = sample[key];
    }
    const parsed = t.schema.safeParse(params);
    assert.ok(parsed.success, `${t.name} rejected a well-formed sample: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
  }
});
