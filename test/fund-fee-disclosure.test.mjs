import test from "node:test";
import assert from "node:assert/strict";

import {
  ECO_ROUTING_FEE_RATE,
  depositReconcileLine,
  estimatedEcoNet,
  methodPlanLines
} from "../lib/commands/fund.mjs";

// Live Hermes incident: a deposit executed via the eco route landed NET 1.97
// of 2.00 USDC on Polygon — the ~1.5% routing fee and the route surfaced for
// the first time AFTER settlement. Fee and route now belong to the
// confirm-time plan, and the post-credit output reconciles deposited vs
// credited so the fee never reads as missing money.

// --- fee estimate ---------------------------------------------------------------

test("eco net estimate matches the observed live deposit (2.00 → 1.97)", () => {
  assert.equal(ECO_ROUTING_FEE_RATE, 0.015);
  assert.equal(estimatedEcoNet(2), 1.97);
  assert.equal(estimatedEcoNet(10), 9.85);
  // Floored to a cent — the disclosure must never overpromise.
  assert.ok(estimatedEcoNet(1) <= 1 * (1 - ECO_ROUTING_FEE_RATE));
  assert.equal(estimatedEcoNet(0), 0);
  assert.equal(estimatedEcoNet("nope"), 0);
});

// --- confirm-time plan lines ------------------------------------------------------

test("eco plan discloses route, fee, and estimated net at confirm time", () => {
  const text = methodPlanLines({ method: "eco", chainKey: "base", amount: 2 }).join("\n");
  assert.match(text, /route\s+base → settles into Gateway on Polygon/);
  assert.match(text, /fee\s+~1\.5% Eco routing fee/);
  assert.match(text, /not quotable pre-deposit/);
  assert.match(text, /net\s+you'll receive ≈\$1\.97 in Gateway/);
});

test("direct plan states no routing fee (credits at face value)", () => {
  const text = methodPlanLines({ method: "direct", chainKey: "base", amount: 2 }).join("\n");
  assert.match(text, /fee\s+none — direct deposits credit at face value/);
  assert.doesNotMatch(text, /net\s/);
});

// --- post-credit reconciliation ---------------------------------------------------

test("reconcile line names the eco routing fee instead of leaving money missing", () => {
  assert.equal(
    depositReconcileLine({ method: "eco", amount: 2, baselineTotal: 0, currentTotal: 1.97 }),
    "deposited $2.00, credited $1.97 (eco routing fee $0.03)"
  );
});

test("reconcile line reports full credit for direct deposits", () => {
  assert.equal(
    depositReconcileLine({ method: "direct", amount: 2, baselineTotal: 1, currentTotal: 3 }),
    "deposited $2.00, credited in full ($2.00)"
  );
});

test("a direct shortfall is labeled as such, not as an eco fee", () => {
  assert.match(
    depositReconcileLine({ method: "direct", amount: 2, baselineTotal: 0, currentTotal: 1.9 }),
    /settlement shortfall \$0\.10/
  );
});

test("reconcile stays quiet when the delta can't be measured", () => {
  // No pre-deposit baseline: the delta would include pre-existing funds.
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: null, currentTotal: 5 }), null);
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: 1, currentTotal: null }), null);
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: 3, currentTotal: 3 }), null);
});
