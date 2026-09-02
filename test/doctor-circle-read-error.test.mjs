import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { circleReadErrorLines } from "../lib/commands/doctor.mjs";

// `selat doctor` collapsed every failed Circle read into "could not read
// (Circle API issue …)" and dropped the CLI's stderr. A transient burst then
// looked identical to an empty wallet or a broken install. Keep the reason.

test("circleReadErrorLines renders the recorded reason plus the transient-burst hint", () => {
  const lines = circleReadErrorLines("circle gateway balance: Error: 429 Too Many Requests");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /circle said: circle gateway balance: Error: 429/);
  assert.match(lines[1], /rerun `selat doctor`/);
});

test("circleReadErrorLines stays quiet with nothing recorded", () => {
  assert.deepEqual(circleReadErrorLines(null), []);
  assert.deepEqual(circleReadErrorLines(""), []);
});

test("a failing circle binary leaves its stderr in lastCircleReadError (deprecation noise filtered)", async () => {
  // CIRCLE_BIN is read at module load, so point it at a stub BEFORE importing.
  const dir = mkdtempSync(join(tmpdir(), "selat-circle-stub-"));
  const stub = join(dir, "circle");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      "echo '(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.' >&2",
      "echo '(Use `node --trace-deprecation ...` to show where the warning was created)' >&2",
      "echo 'Error: Gateway API returned 503 Service Unavailable' >&2",
      "exit 1",
      "",
    ].join("\n")
  );
  chmodSync(stub, 0o755);
  process.env.CIRCLE_BIN = stub;
  const circle = await import(`../lib/circle.mjs?stub=${Date.now()}`);

  assert.equal(await circle.gatewayBalancesByChain("0xabc"), null);
  const reason = circle.lastCircleReadError();
  assert.match(reason, /^circle gateway balance: /);
  assert.match(reason, /503 Service Unavailable/);
  assert.doesNotMatch(reason, /DeprecationWarning|trace-deprecation/);

  assert.equal(await circle.walletUsdcBalance("0xabc", "BASE"), null);
  assert.match(circle.lastCircleReadError(), /^circle wallet balance --chain BASE: /);

  const pol = await circle.chainSpendingPolicy("0xabc", "MATIC");
  assert.equal(pol.readable, false);
  assert.match(circle.lastCircleReadError(), /^circle wallet limit --chain MATIC: /);
});
