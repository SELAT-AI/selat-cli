import test from "node:test";
import assert from "node:assert/strict";

import { selatPaySpawn } from "../lib/selat-pay.mjs";

// A resolved env-override or bundled selat-pay must be executed by path (via
// the current Node), never by a bare-name PATH lookup that could substitute a
// different, version-skewed binary onto a real EIP-712 payment. See
// SELAT-AI/selat-cli#17.

test("env-override executes the resolved binary by path, not via PATH", () => {
  const { cmd, args } = selatPaySpawn(
    { source: "env-override", bin: "/opt/sp/bin/selat-pay.mjs" },
    ["GET", "https://x", "--max-amount", "0.05"]
  );
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ["/opt/sp/bin/selat-pay.mjs", "GET", "https://x", "--max-amount", "0.05"]);
});

test("bundled executes the resolved binary by path", () => {
  const { cmd, args } = selatPaySpawn({ source: "bundled", bin: "/n/sp.mjs" }, ["GET", "https://x"]);
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ["/n/sp.mjs", "GET", "https://x"]);
});

test("global (last resort) goes through PATH by bare name", () => {
  const { cmd, args } = selatPaySpawn({ source: "global", bin: "selat-pay" }, ["GET", "https://x"]);
  assert.equal(cmd, "selat-pay");
  assert.deepEqual(args, ["GET", "https://x"]);
});

test("an unresolved install throws rather than spawning something arbitrary", () => {
  assert.throws(() => selatPaySpawn({ source: null }, []), /not resolved/);
  assert.throws(() => selatPaySpawn(undefined, []), /not resolved/);
});
