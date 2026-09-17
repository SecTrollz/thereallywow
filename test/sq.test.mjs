import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sq } from "../server.mjs";

// The real security property: whatever sq() produces, when substituted into a shell
// command string exactly the way server.mjs does (`cmd ${sq(value)}`), must behave as a
// single inert argument to the shell — never as additional shell syntax. Round-tripping
// through a real shell via `echo` proves this directly instead of pattern-matching the
// escaped text.
function shellRoundTrip(value) {
  return execFileSync("/bin/sh", ["-c", `echo ${sq(value)}`], { encoding: "utf8" }).replace(/\n$/, "");
}

test("sq: normal values round-trip unchanged through a real shell", () => {
  assert.equal(shellRoundTrip("com.android.chrome"), "com.android.chrome");
  assert.equal(shellRoundTrip("192.168.1.50:5555"), "192.168.1.50:5555");
});

test("sq: shell-metacharacter payloads come back as inert literal text, never executed", () => {
  const payloads = [
    "x; touch /tmp/thereallywow-test-pwned",
    "$(whoami)",
    "`id`",
    "a && echo injected",
    "a | cat /etc/passwd",
    "a' ; echo injected ; echo '",
  ];
  for (const p of payloads) {
    assert.equal(shellRoundTrip(p), p, `payload ${JSON.stringify(p)} was not neutralized`);
  }
  assert.throws(() => execFileSync("test", ["-e", "/tmp/thereallywow-test-pwned"]));
});

test("sq: embedded single quotes survive the round trip intact", () => {
  assert.equal(shellRoundTrip("it's a test"), "it's a test");
  assert.equal(shellRoundTrip("''''"), "''''");
});
