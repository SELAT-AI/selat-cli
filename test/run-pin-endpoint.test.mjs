import test from "node:test";
import assert from "node:assert/strict";

import { parseRunArgs, pinArgs, pinRefusal, KNOWN_RUN_FLAGS } from "../lib/commands/run.mjs";

// `selat run` takes an intent, and rank.mjs re-ranks that intent at pay time.
// Catalog services are merged across registries, so one service can span
// unrelated capabilities — meaning a caller that discovered and priced an
// endpoint could be handed a different one when it actually paid. --endpoint
// pins the endpoint so the thing quoted is the thing paid.

test("--endpoint and --method are known flags", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--endpoint"));
  assert.ok(KNOWN_RUN_FLAGS.includes("--method"));
});

test("parseRunArgs captures the pin without swallowing the intent", () => {
  const r = parseRunArgs(["enrich", "a", "company", "--endpoint", "https://api.example/x", "--method", "POST"]);
  assert.equal(r.ok, true);
  assert.equal(r.intent, "enrich a company");
  assert.equal(r.endpoint, "https://api.example/x");
  assert.equal(r.method, "POST");
});

test("parseRunArgs defaults the pin to absent", () => {
  const r = parseRunArgs(["enrich a company"]);
  assert.equal(r.endpoint, undefined);
  assert.equal(r.method, undefined);
});

test("a flag-like value is a missing value, not a value", () => {
  // Same hazard --input had: `--endpoint --dry-run` must not swallow --dry-run
  // as the URL and then PAY.
  const r = parseRunArgs(["x", "--endpoint", "--dry-run"]);
  assert.equal(r.ok, false);
  assert.match(r.error, /--endpoint requires a value/);

  const m = parseRunArgs(["x", "--endpoint", "https://a.example/x", "--method"]);
  assert.equal(m.ok, false);
  assert.match(m.error, /--method requires a value/);
});

test("the pin composes with --dry-run and --json", () => {
  const r = parseRunArgs(["x", "--endpoint", "https://a.example/x", "--dry-run", "--json"]);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.jsonMode, true);
  assert.equal(r.endpoint, "https://a.example/x");
});

// --- forwarding -------------------------------------------------------------

test("pinArgs forwards nothing when unpinned", () => {
  assert.deepEqual(pinArgs({}), []);
  assert.deepEqual(pinArgs({ method: "POST" }), [], "--method alone has nothing to disambiguate");
});

test("pinArgs forwards the endpoint, and the method only alongside it", () => {
  assert.deepEqual(pinArgs({ endpoint: "https://a.example/x" }), ["--endpoint", "https://a.example/x"]);
  assert.deepEqual(
    pinArgs({ endpoint: "https://a.example/x", method: "POST" }),
    ["--endpoint", "https://a.example/x", "--method", "POST"],
  );
});

test("pinArgs keeps the URL as one argv token", () => {
  // Spawned without a shell, so a URL with a query stays inert data.
  const args = pinArgs({ endpoint: "https://a.example/x?q=a b&r=1" });
  assert.equal(args[1], "https://a.example/x?q=a b&r=1");
});

// --- refusals ---------------------------------------------------------------

test("pinRefusal names the two deliberate refusals rank.mjs makes", () => {
  const notFound = pinRefusal(4, "https://a.example/x");
  assert.equal(notFound.reason, "endpoint-not-in-catalog");
  assert.match(notFound.error, /nothing was charged/);

  const unreliable = pinRefusal(5, "https://a.example/x");
  assert.equal(unreliable.reason, "endpoint-unreliable");
  assert.match(unreliable.error, /no substitute was paid/);
});

test("pinRefusal stays silent for an unpinned run", () => {
  // Without a pin these exit codes carry no pin meaning — claiming otherwise
  // would tell a caller their endpoint was rejected when they never gave one.
  assert.equal(pinRefusal(4, undefined), null);
  assert.equal(pinRefusal(5, undefined), null);
});

test("pinRefusal does not claim unrelated failures are pin refusals", () => {
  for (const code of [1, 2, 3, 6, 127]) {
    assert.equal(pinRefusal(code, "https://a.example/x"), null, `exit ${code} is not a pin refusal`);
  }
});
