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
    { dryRun: got.dryRun, jsonMode: got.jsonMode, verbose: got.verbose, autoRebuy: got.autoRebuy },
    { dryRun: false, jsonMode: false, verbose: false, autoRebuy: false }
  );
  assert.equal(got.inputInline, undefined);
  assert.equal(got.inputFile, undefined);
});

test("parseRunArgs handles value flags and boolean flags together", () => {
  const got = parseRunArgs(["run actor", "--input", '{"q":1}', "--auto-rebuy", "--json", "--verbose"]);
  assert.equal(got.ok, true);
  assert.equal(got.intent, "run actor");
  assert.equal(got.inputInline, '{"q":1}');
  assert.equal(got.autoRebuy, true);
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
