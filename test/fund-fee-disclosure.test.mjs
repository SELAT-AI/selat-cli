import test from "node:test";
import assert from "node:assert/strict";

import {
  ECO_FEE_ESTIMATE_BY_CHAIN,
  ECO_FEE_ESTIMATE_DEFAULT,
  depositReconcileLine,
  ecoFeeEstimate,
  estimatedEcoNet,
  methodPlanLines
} from "../lib/commands/fund.mjs";

// Eco Fast Deposits (v2) fee disclosure. The fee is applied server-side by
// Eco with no quote surface, so the constants are MEASURED from live
// deposits and rounded UP — the disclosed net must never overpromise:
//   base      $0.50     → fee $0.055300  (2026-08-05)
//   optimism  $2.10     → fee $0.055476  (2026-08-11, credited $2.044524)
//   arbitrum  $5.194162 → fee $0.095761  (2026-08-11, credited $5.098401)
// base and optimism charged near-identical fees at 4× different amounts, so
// the schedule is per-source-chain FIXED, not a percentage — the retired v1
// pipeline's "$0.03 + 1.3bp" and the older "~1.5%" model are both wrong here.

// --- fee estimates ----------------------------------------------------------

test("fee estimates are per-source-chain and rounded up from the live measurements", () => {
  assert.equal(ecoFeeEstimate("base"), 0.06);
  assert.equal(ecoFeeEstimate("optimism"), 0.06);
  assert.equal(ecoFeeEstimate("arbitrum"), 0.1);
  // Rounded UP: estimate must be at or above every measured fee.
  assert.ok(ECO_FEE_ESTIMATE_BY_CHAIN.base >= 0.0553);
  assert.ok(ECO_FEE_ESTIMATE_BY_CHAIN.optimism >= 0.055476);
  assert.ok(ECO_FEE_ESTIMATE_BY_CHAIN.arbitrum >= 0.095761);
  // Unmeasured chains assume the worst measured fee, never a cheaper guess.
  assert.equal(ecoFeeEstimate("unichain"), ECO_FEE_ESTIMATE_DEFAULT);
  assert.equal(ecoFeeEstimate(undefined), ECO_FEE_ESTIMATE_DEFAULT);
  assert.equal(ECO_FEE_ESTIMATE_DEFAULT, Math.max(...Object.values(ECO_FEE_ESTIMATE_BY_CHAIN)));
});

test("net estimates never overpromise against the live credited amounts", () => {
  // optimism $2.10 actually credited $2.044524 — estimate must not exceed it.
  assert.equal(estimatedEcoNet(2.1, "optimism"), 2.04);
  assert.ok(estimatedEcoNet(2.1, "optimism") <= 2.044524);
  // arbitrum $5.194162 actually credited $5.098401.
  assert.equal(estimatedEcoNet(5.194162, "arbitrum"), 5.09);
  assert.ok(estimatedEcoNet(5.194162, "arbitrum") <= 5.098401);
  // base $0.50 actually credited $0.4447.
  assert.equal(estimatedEcoNet(0.5, "base"), 0.44);
  assert.ok(estimatedEcoNet(0.5, "base") <= 0.4447);
});

test("net estimate floors to a cent and never goes negative", () => {
  assert.equal(estimatedEcoNet(2, "base"), 1.94);
  // float-hostile inputs: (n - fee) * 100 must not floor a cent away
  assert.equal(estimatedEcoNet(1.06, "base"), 1);
  assert.equal(estimatedEcoNet(0.06, "base"), 0);
  assert.equal(estimatedEcoNet(0.03, "base"), 0); // below the fee — nothing credited
  assert.equal(estimatedEcoNet(0), 0);
  assert.equal(estimatedEcoNet("nope"), 0);
});

// --- confirm-time plan lines ------------------------------------------------

test("eco plan disclosure names the fixed per-chain fee and estimated net", () => {
  const text = methodPlanLines({ method: "eco", chainKey: "optimism", amount: 2.1 }).join("\n");
  assert.match(text, /route\s+optimism → settles into Gateway on Polygon/);
  assert.match(text, /fee\s+~\$0\.06 fixed Eco fee from optimism/);
  assert.match(text, /measured, not quotable pre-deposit/);
  assert.match(text, /weighs heavier on small deposits/);
  assert.match(text, /net\s+you'll receive ≈\$2\.04 in Gateway/);
  // arbitrum's measured fee is higher — the plan must say so, not average it.
  const arb = methodPlanLines({ method: "eco", chainKey: "arbitrum", amount: 5.194162 }).join("\n");
  assert.match(arb, /fee\s+~\$0\.10 fixed Eco fee from arbitrum/);
  assert.match(arb, /net\s+you'll receive ≈\$5\.09 in Gateway/);
});

test("direct plan states no routing fee (credits at face value)", () => {
  const text = methodPlanLines({ method: "direct", chainKey: "base", amount: 2 }).join("\n");
  assert.match(text, /fee\s+none — direct deposits credit at face value/);
  assert.doesNotMatch(text, /net\s/);
});

// --- post-credit reconciliation ---------------------------------------------

test("reconcile line names the eco fee instead of leaving money missing", () => {
  assert.equal(
    depositReconcileLine({ method: "eco", amount: 2.1, baselineTotal: 7.850301, currentTotal: 9.894825 }),
    "deposited $2.10, credited $2.04 (eco fee $0.06)"
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
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: null, currentTotal: 5 }), null);
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: 1, currentTotal: null }), null);
  assert.equal(depositReconcileLine({ method: "eco", amount: 2, baselineTotal: 3, currentTotal: 3 }), null);
});
