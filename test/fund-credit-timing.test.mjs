import test from "node:test";
import assert from "node:assert/strict";

import { expectedCreditWindow, creditTimeoutLine } from "../lib/commands/fund.mjs";

// Observed 2026-10-11 (Circle CLI 1.2.1): a direct Arc deposit was credited by
// the first balance read; eco deposits from Base/Arbitrum/Optimism credited on
// Arc in 30–60s; direct deposits elsewhere wait for source-chain finality.
test("credit window follows the method and chain", () => {
  assert.equal(expectedCreditWindow({ method: "direct", chainKey: "arc" }), "within seconds");
  assert.equal(expectedCreditWindow({ method: "direct", chainKey: "ARC " }), "within seconds");
  assert.equal(expectedCreditWindow({ method: "eco", chainKey: "base" }), "in about a minute");
  assert.equal(expectedCreditWindow({ method: "eco", chainKey: "arbitrum" }), "in about a minute");
  assert.equal(expectedCreditWindow({ method: "direct", chainKey: "polygon" }), "in 5–10 minutes");
  assert.equal(expectedCreditWindow({ method: "direct", chainKey: "base" }), "in 5–10 minutes");
  assert.equal(expectedCreditWindow({}), "in 5–10 minutes");
});

test("timeout warning: slow route says still settling; fast routes flag the delay", () => {
  const slow = creditTimeoutLine({ elapsed: "15m0s", creditWindow: "in 5–10 minutes" });
  assert.match(slow, /usually still settling, not lost/);
  const arc = creditTimeoutLine({ elapsed: "15m0s", creditWindow: "within seconds" });
  assert.match(arc, /longer than usual \(this route typically credits within seconds\)/);
  assert.match(arc, /not lost/);
  assert.match(arc, /re-check the Gateway balance before depositing again/);
  assert.doesNotMatch(arc, /usually still settling/);
});
