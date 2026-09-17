import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// No MCP_API_KEY anywhere (env or .env) — the default, auth-optional state — so these
// routes must behave exactly as they always have for an operator who hasn't set a key.
delete process.env.MCP_API_KEY;
process.env.ADB_DEVICE = "127.0.0.1:1";

const { TOOLS, startHttpServer } = await import("../server.mjs");

let srv, baseUrl;

before(async () => {
  srv = startHttpServer(0); // port 0 = OS-assigned ephemeral port
  await new Promise((resolve, reject) => {
    srv.once("listening", resolve);
    srv.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  await new Promise((resolve) => srv.close(resolve));
});

test("/health responds 200 with expected shape, no auth required by default", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.server, "thereallywow");
});

test("/tools length matches TOOLS.length exactly (the tool-count-drift regression test)", async () => {
  const res = await fetch(`${baseUrl}/tools`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tools.length, Object.keys(TOOLS).length);
});

test("/execute returns 400 (not 500, not silent misbehavior) for a malformed tool call", async () => {
  const res = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_name: "tap_coords", parameters: { x: 10 } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid parameters for tap_coords/);
});

test("/execute returns 400 for an unknown tool name", async () => {
  const res = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool_name: "not_a_real_tool", parameters: {} }),
  });
  assert.equal(res.status, 400);
});

test("/reconnect rejects a shell-metacharacter device id with 400 and does not run it", async () => {
  const res = await fetch(`${baseUrl}/reconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device: "1.2.3.4:5555; touch /tmp/thereallywow-test-reconnect-pwned" }),
  });
  assert.equal(res.status, 400);
});
