import test from "node:test";
import assert from "node:assert/strict";

import {
  applyRunMaxAmountCeiling,
  DEFAULT_RUN_MAX_AMOUNT_USD,
  KNOWN_RUN_FLAGS,
} from "../lib/commands/run.mjs";

// `selat run` used to reject --max-amount (not in KNOWN_RUN_FLAGS) while the
// README advertised it. Cap today came only from catalog exec_hints. The
// ceiling is last-wins after hint validation — same idea as compare --pay.

test("KNOWN_RUN_FLAGS includes --max-amount so the parser no longer rejects it", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--max-amount"));
});

test("DEFAULT_RUN_MAX_AMOUNT_USD is the conservative $1 ceiling", () => {
  assert.equal(DEFAULT_RUN_MAX_AMOUNT_USD, 1);
});

test("applyRunMaxAmountCeiling clamps a high catalog hint to the default", () => {
  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--chain", "base", "--max-amount", "50"]
  );
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, 1);
  assert.deepEqual(got.args.slice(-2), ["--max-amount", "1"]);
  assert.equal(got.args.filter((a) => a === "--max-amount").length, 1);
});

test("applyRunMaxAmountCeiling keeps a catalog hint that is already under the default", () => {
  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--max-amount", "0.0075"]
  );
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, 0.0075);
  assert.deepEqual(got.args.slice(-2), ["--max-amount", "0.0075"]);
});

test("applyRunMaxAmountCeiling uses the default when the hint has no cap", () => {
  const got = applyRunMaxAmountCeiling(["GET", "https://api.example/v1", "--chain", "base"]);
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, DEFAULT_RUN_MAX_AMOUNT_USD);
  assert.deepEqual(got.args.slice(-2), ["--max-amount", "1"]);
});

test("applyRunMaxAmountCeiling: explicit --max-amount 5 is refused without a TTY raise", () => {
  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--max-amount", "0.05"],
    { explicit: 5, interactive: false }
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /hard CLI ceiling/);
});

test("applyRunMaxAmountCeiling: TTY + --allow-high-max-amount still refuses $5", () => {
  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--max-amount", "0.05"],
    { explicit: 5, interactive: true, allowHigh: true }
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /hard CLI ceiling/);
});

test("applyRunMaxAmountCeiling strips a hostile second --max-amount (last-wins)", () => {
  const hostile = ["GET", "https://api.example/v1", "--max-amount", "0.05", "--max-amount", "50"];
  const got = applyRunMaxAmountCeiling(hostile);
  assert.equal(got.ok, true);
  // No explicit flag: last hint cap is 50, clamped to $1.
  assert.equal(got.capUsd, 1);
  const caps = got.args.filter((a, i) => got.args[i - 1] === "--max-amount");
  assert.deepEqual(caps, ["1"]);
  assert.ok(!got.args.includes("50"));
  assert.ok(!got.args.includes("0.05"));
});

test("applyRunMaxAmountCeiling last-wins an explicit cap over a hostile hint", () => {
  const hostile = ["GET", "https://api.example/v1", "--max-amount", "0.05", "--max-amount", "50"];
  const got = applyRunMaxAmountCeiling(hostile, { explicit: 0.02 });
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, 0.02);
  const caps = got.args.filter((a, i) => got.args[i - 1] === "--max-amount");
  assert.deepEqual(caps, ["0.02"]);
});

test("the pre-ranking refusal names the bound it actually tests ($1.05, not $1)", async () => {
  // The branch refuses `maxAmount > APIFY_PREPAID_TOKEN_USD` but used to
  // interpolate HARD_CLI_MAX_AMOUNT_USD. Reading "exceeds the $1 hard CLI
  // ceiling" sends you to --max-amount 1, which is then refused for the
  // OPPOSITE reason ("below the prepaid-token price") — so the two messages
  // together describe an empty range, and the one payable value ($1.05) is
  // never named. The condition was always right; only the message lied.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "commands", "run.mjs"),
    "utf8",
  );
  const guard = src.slice(src.indexOf("Refuse a YOLO 999 before ranking"));
  const block = guard.slice(0, guard.indexOf("}\n\n"));
  assert.match(block, /maxAmount > APIFY_PREPAID_TOKEN_USD/, "the condition tests the token price");
  assert.match(block, /exceeds \$\$\{APIFY_PREPAID_TOKEN_USD\}/,
    "the message must lead with the bound it tests");
  assert.doesNotMatch(block, /exceeds the \$\$\{HARD_CLI_MAX_AMOUNT_USD\} hard CLI ceiling/,
    "it must not claim the $1 ceiling is what refused this value");
});
