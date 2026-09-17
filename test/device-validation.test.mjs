import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidDeviceId } from "../server.mjs";

test("isValidDeviceId: accepts real device identifiers", () => {
  const valid = [
    "192.168.1.168:5556",
    "100.64.0.1:5555",
    "emulator-5554",
    "R58M123ABCD", // USB serial
    "127.0.0.1:1",
  ];
  for (const id of valid) assert.equal(isValidDeviceId(id), true, `expected ${id} to be valid`);
});

test("isValidDeviceId: rejects shell-metacharacter payloads", () => {
  const malicious = [
    "1.2.3.4:5555; touch /tmp/pwned",
    "$(whoami)",
    "`id`",
    "1.2.3.4:5555 && rm -rf /",
    "1.2.3.4:5555|cat /etc/passwd",
    "1.2.3.4:5555\ntouch /tmp/pwned",
    "'; rm -rf / #",
    "",
    "-x", // must not be interpretable as a flag
  ];
  for (const id of malicious) assert.equal(isValidDeviceId(id), false, `expected ${JSON.stringify(id)} to be rejected`);
});

test("isValidDeviceId: rejects non-string input", () => {
  assert.equal(isValidDeviceId(null), false);
  assert.equal(isValidDeviceId(undefined), false);
  assert.equal(isValidDeviceId(12345), false);
  assert.equal(isValidDeviceId({}), false);
});
