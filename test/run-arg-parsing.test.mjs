import test from "node:test";
import assert from "node:assert/strict";

import { parseRunArgs, KNOWN_RUN_FLAGS } from "../lib/commands/run.mjs";

// `selat run` used to DROP unknown --flags and pay anyway — a tester passed
// --dry-run and got charged (tester feedback round 2). Parsing is now strict:
// unknown flags error, --dry-run is real, and value-flags require a value.

test("parseRunArgs rejects unknown flags and lists the known ones", () => {
  const got = parseRunArgs(["--dyr-run", "weather in tokyo"]);
  assert.equal(got.ok, false);
  assert.match(got.error, /unknown flag --dyr-run/);
  for (const flag of KNOWN_RUN_FLAGS) assert.ok(got.error.includes(flag), `error lists ${flag}`);
});

test("parseRunArgs parses --dry-run alongside the intent", () => {
  const got = parseRunArgs(["--dry-run", "weather", "in", "tokyo"]);
  assert.equal(got.ok, true);
  assert.equal(got.dryRun, true);
  assert.equal(got.intent, "weather in tokyo");
});

test("parseRunArgs defaults every flag off", () => {
  const got = parseRunArgs(["weather in tokyo"]);
  assert.equal(got.ok, true);
  assert.deepEqual(
    { dryRun: got.dryRun, liveProbe: got.liveProbe, jsonMode: got.jsonMode, verbose: got.verbose, autoRebuy: got.autoRebuy },
    { dryRun: false, liveProbe: false, jsonMode: false, verbose: false, autoRebuy: false }
  );
  assert.equal(got.inputInline, undefined);
  assert.equal(got.inputFile, undefined);
  assert.equal(got.maxAmount, undefined);
});

test("parseRunArgs accepts --max-amount and lists it among known flags", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--max-amount"));
  const got = parseRunArgs(["--max-amount", "0.05", "weather in tokyo"]);
  assert.equal(got.ok, true);
  assert.equal(got.maxAmount, 0.05);
  assert.equal(got.intent, "weather in tokyo");
});

test("parseRunArgs rejects a missing, flag-like, or non-positive --max-amount", () => {
  assert.match(parseRunArgs(["x", "--max-amount"]).error, /--max-amount requires a value/);
  assert.match(parseRunArgs(["x", "--max-amount", "--dry-run"]).error, /--max-amount requires a value/);
  assert.match(parseRunArgs(["x", "--max-amount", "0"]).error, /must be a positive number/);
  assert.match(parseRunArgs(["x", "--max-amount", "lots"]).error, /must be a positive number/);
});

test("parseRunArgs handles value flags and boolean flags together", () => {
  const got = parseRunArgs(["run actor", "--input", '{"q":1}', "--auto-rebuy", "--live-probe", "--json", "--verbose"]);
  assert.equal(got.ok, true);
  assert.equal(got.intent, "run actor");
  assert.equal(got.inputInline, '{"q":1}');
  assert.equal(got.autoRebuy, true);
  assert.equal(got.liveProbe, true);
  assert.equal(got.jsonMode, true);
  assert.equal(got.verbose, true);
});

test("parseRunArgs takes --input-file's value without eating the intent", () => {
  const got = parseRunArgs(["--input-file", "./in.json", "scrape a page"]);
  assert.equal(got.ok, true);
  assert.equal(got.inputFile, "./in.json");
  assert.equal(got.intent, "scrape a page");
});

test("parseRunArgs errors when a value flag has no value", () => {
  assert.equal(parseRunArgs(["intent", "--input"]).ok, false);
  assert.match(parseRunArgs(["intent", "--input"]).error, /--input requires a value/);
  assert.equal(parseRunArgs(["intent", "--input-file"]).ok, false);
});

test("parseRunArgs yields an empty intent for flag-only argv", () => {
  const got = parseRunArgs(["--dry-run"]);
  assert.equal(got.ok, true);
  assert.equal(got.intent, "");
});

// Review-#2 Tier-2 hardening: help inertness + flag-eating value slots.

test("-h and --help parse as help, never as intent", () => {
  for (const flag of ["-h", "--help"]) {
    const r = parseRunArgs([flag]);
    assert.equal(r.ok, true);
    assert.equal(r.help, true);
    // help wins even mixed with other tokens
    const mixed = parseRunArgs(["scrape", "tweets", flag]);
    assert.equal(mixed.help, true);
  }
});

test("--input refuses a flag-looking value instead of eating it", () => {
  // `--input --dry-run` used to swallow --dry-run as the JSON and then pay.
  const r = parseRunArgs(["x", "--input", "--dry-run"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /--input requires a value/);
  // and the legit form still works
  const ok = parseRunArgs(["x", "--input", "{\"a\":1}", "--dry-run"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.inputInline, "{\"a\":1}");
  assert.equal(ok.dryRun, true);
});

test("--input-file and --param refuse flag-looking values too", () => {
  assert.equal(parseRunArgs(["x", "--input-file", "--json"]).ok, false);
  assert.equal(parseRunArgs(["x", "--param", "--json"]).ok, false);
});

// --json error contract: machines read stdout; every failure must be a
// parseable {ok:false, error} there, matching verifyCmd's contract.

test("selat run --help lists --max-amount", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const r = await run("node", ["bin/selat.mjs", "run", "--help"]);
  assert.match(r.stdout, /--max-amount <usd>/);
  assert.match(r.stdout, /default \$1/);
});

test("run --json emits JSON on arg-parse and missing-intent errors", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  for (const argv of [["run", "--json", "--bogus"], ["run", "--json"]]) {
    const r = await run("node", ["bin/selat.mjs", ...argv]).catch((e) => e);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.length > 0);
  }
});

test("skill run --json emits JSON when the skill is not installed", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const r = await run("node", ["bin/selat.mjs", "skill", "run", "nope-not-installed", "--json"]).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /not installed/);
});
