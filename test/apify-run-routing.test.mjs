import test from "node:test";
import assert from "node:assert/strict";

import { isApifyPrepaidPick, apifyActorIdFromPlan, apifyRunArgs } from "../lib/commands/run.mjs";

// `selat run` must route an Apify (prepaid-token) rank pick to the token flow
// instead of running its (wrong) per-call selat-pay hint. These pin the two pure
// detectors that make that decision.

const apifyPlan = {
  service: { id: "apify:apify~instagram-scraper" },
  endpoint: {
    fullUrl: "https://api.apify.com/v2/actors/apify~instagram-scraper/run-sync-get-dataset-items",
    payments: [{ protocol: "x402", scheme: "prepaid-token", paymentModel: "apify-prepaid-token" }],
  },
};

const normalPlan = {
  service: { id: "exa.ai" },
  endpoint: {
    fullUrl: "https://api.exa.ai/search",
    payments: [{ protocol: "x402", scheme: "exact", domain: "gateway-batched" }],
  },
};

test("isApifyPrepaidPick detects the prepaid-token paymentModel", () => {
  assert.equal(isApifyPrepaidPick(apifyPlan), true);
  assert.equal(isApifyPrepaidPick(normalPlan), false);
});

test("isApifyPrepaidPick falls back to the apify: service id", () => {
  assert.equal(isApifyPrepaidPick({ service: { id: "apify:owner~actor" }, endpoint: { payments: [] } }), true);
  assert.equal(isApifyPrepaidPick({}), false);
});

test("apifyActorIdFromPlan prefers the Actor URL, falls back to the service id", () => {
  assert.equal(apifyActorIdFromPlan(apifyPlan), "apify~instagram-scraper");
  assert.equal(apifyActorIdFromPlan({ service: { id: "apify:owner~actor" } }), "owner~actor");
  assert.equal(apifyActorIdFromPlan(normalPlan), null);
  assert.equal(apifyActorIdFromPlan({}), null);
});

test("apifyActorIdFromPlan accepts the legacy /v2/acts/ alias too (cached picks)", () => {
  const legacy = { endpoint: { fullUrl: "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items" } };
  assert.equal(apifyActorIdFromPlan(legacy), "apify~instagram-scraper");
});

test("apifyRunArgs forwards input and appends --auto-rebuy only when set", () => {
  const id = "apify~x";
  assert.deepEqual(apifyRunArgs({ actorId: id }), ["run", id]);
  assert.deepEqual(
    apifyRunArgs({ actorId: id, inputInline: '{"a":1}' }),
    ["run", id, "--input", '{"a":1}'],
  );
  assert.deepEqual(
    apifyRunArgs({ actorId: id, inputFile: "in.json", autoRebuy: true }),
    ["run", id, "--input-file", "in.json", "--auto-rebuy"],
  );
  // --auto-rebuy goes last, after input, and only when opted in.
  assert.deepEqual(
    apifyRunArgs({ actorId: id, inputInline: "{}", autoRebuy: true }),
    ["run", id, "--input", "{}", "--auto-rebuy"],
  );
  assert.equal(apifyRunArgs({ actorId: id, autoRebuy: false }).includes("--auto-rebuy"), false);
});
