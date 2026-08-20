import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { payExecTuple, apifyExecTuple, apifyRunArgs } from "../lib/commands/run.mjs";
import { selatPaySpawn } from "../lib/selat-pay.mjs";

// `--dry-run --json` has to hand a MACHINE something it can execute. It already
// emits `command`, but that is shell-quoted for a human to read, and re-running
// it would mean shell-parsing a string — the exact hazard the run path avoids by
// spawning without a shell. Without an executable form, a machine consumer's
// only option is to re-run the intent, which re-ranks and can land on a
// different service at a different price than the one it was just quoted.
//
// These pin the tuple so it stays spawnable and stays identical to what the
// paid path actually runs.

const bundled = { source: "bundled", bin: "/pkg/@selat-ai/selat-pay/bin/selat-pay.mjs", binDir: null, packageRoot: "/pkg" };
const global = { source: "global", bin: null, binDir: null, packageRoot: null };

const payArgs = ["POST", "https://api.example.com/lookup", "--chain", "base", "--max-amount", "0.01"];

test("payExecTuple returns the same spawn tuple the paid path uses", () => {
  // The whole point: dry-run and pay must not drift.
  const spawn = selatPaySpawn(bundled, payArgs);
  const exec = payExecTuple(bundled, payArgs);
  assert.equal(exec.cmd, spawn.cmd);
  assert.deepEqual(exec.argv, spawn.args);
  assert.equal(exec.runner, "selat-pay");
});

test("payExecTuple runs the bundled selat-pay through node, not PATH", () => {
  const exec = payExecTuple(bundled, payArgs);
  assert.equal(exec.cmd, process.execPath);
  assert.equal(exec.argv[0], bundled.bin);
  assert.deepEqual(exec.argv.slice(1), payArgs);
});

test("payExecTuple uses PATH only for a global install", () => {
  const exec = payExecTuple(global, payArgs);
  assert.equal(exec.cmd, "selat-pay");
  assert.deepEqual(exec.argv, payArgs);
});

test("payExecTuple keeps the endpoint pinned, so a consumer cannot be re-ranked", () => {
  const exec = payExecTuple(bundled, payArgs);
  assert.ok(
    exec.argv.includes("https://api.example.com/lookup"),
    "the quoted endpoint must survive into the executable form",
  );
});

test("payExecTuple argv needs no shell quoting to be spawnable", () => {
  // Each argv entry must be one whole token. If any entry carried embedded
  // quoting, a consumer would be back to parsing strings.
  const withBody = ["POST", "https://api.example.com/x", "--body", '{"q":"a b c"}'];
  const exec = payExecTuple(bundled, withBody);
  assert.equal(exec.argv[exec.argv.length - 1], '{"q":"a b c"}');
  assert.ok(!exec.argv.some((a) => typeof a !== "string"));
});

test("apifyExecTuple points node at the skill's token script", () => {
  const runArgs = apifyRunArgs({ actorId: "apify~instagram-scraper" });
  const exec = apifyExecTuple({ skillPath: "/skills/selat-discovery", selatPay: bundled, runArgs });
  assert.equal(exec.runner, "apify-token");
  assert.equal(exec.cmd, "node");
  assert.equal(exec.argv[0], join("/skills/selat-discovery", "scripts", "apify_token.mjs"));
  assert.deepEqual(exec.argv.slice(1), runArgs);
});

test("apifyExecTuple carries SELAT_PAY_BIN, since buying a token is itself a selat-pay call", () => {
  const runArgs = apifyRunArgs({ actorId: "owner~actor" });
  assert.equal(
    apifyExecTuple({ skillPath: "/s", selatPay: bundled, runArgs }).env.SELAT_PAY_BIN,
    bundled.bin,
  );
  assert.equal(
    apifyExecTuple({ skillPath: "/s", selatPay: global, runArgs }).env.SELAT_PAY_BIN,
    "selat-pay",
  );
});

test("apifyExecTuple preserves --input and --auto-rebuy", () => {
  const runArgs = apifyRunArgs({ actorId: "owner~actor", inputInline: '{"a":1}', autoRebuy: true });
  const exec = apifyExecTuple({ skillPath: "/s", selatPay: bundled, runArgs });
  assert.ok(exec.argv.includes("--input"));
  assert.ok(exec.argv.includes('{"a":1}'));
  assert.ok(exec.argv.includes("--auto-rebuy"));
});
