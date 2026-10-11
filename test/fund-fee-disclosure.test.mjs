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

// Eco Fast Deposits fee disclosure. The Circle CLI shows no fee before the
// vault is funded, so the constants are MEASURED from live deposits and
// rounded UP — the disclosed net must never overpromise. Live Circle CLI eco
// deposits on 2026-10-11, each crediting Gateway on Arc (Eco's vault-status
// API itemizes $0.030000 protocol + a CCTP fee of a few hundredths of a cent):
//   base      $0.65 → credited $0.619919 (fee $0.030081)
//   arbitrum  $0.70 → credited $0.669906 (fee $0.030094)
//   optimism  $0.70 → credited $0.669912 (fee $0.030088)
// The fee is flat across source chains; the August per-chain estimates
// ($0.06 / $0.10) measured an earlier Eco route that settled on Polygon.

const MEASURED_2026_10_11 = [
  { chain: "base", amount: 0.65, credited: 0.619919, fee: 0.030081 },
  { chain: "arbitrum", amount: 0.7, credited: 0.669906, fee: 0.030094 },
  { chain: "optimism", amount: 0.7, credited: 0.669912, fee: 0.030088 },
];

// --- fee estimates ----------------------------------------------------------

test("fee estimates are flat and rounded up from the live measurements", () => {
  for (const m of MEASURED_2026_10_11) {
    assert.equal(ecoFeeEstimate(m.chain), 0.04, m.chain);
    // Rounded UP: estimate must be at or above every measured fee.
    assert.ok(ECO_FEE_ESTIMATE_BY_CHAIN[m.chain] >= m.fee, m.chain);
  }
  // Unmeasured chains assume the worst measured fee, never a cheaper guess.
  assert.equal(ecoFeeEstimate("unichain"), ECO_FEE_ESTIMATE_DEFAULT);
  assert.equal(ecoFeeEstimate(undefined), ECO_FEE_ESTIMATE_DEFAULT);
  assert.equal(ECO_FEE_ESTIMATE_DEFAULT, Math.max(...Object.values(ECO_FEE_ESTIMATE_BY_CHAIN)));
});

test("net estimates never overpromise against the live credited amounts", () => {
  for (const m of MEASURED_2026_10_11) {
    assert.ok(estimatedEcoNet(m.amount, m.chain) <= m.credited, m.chain);
  }
  assert.equal(estimatedEcoNet(0.65, "base"), 0.61);
  assert.equal(estimatedEcoNet(0.7, "arbitrum"), 0.66);
  assert.equal(estimatedEcoNet(0.7, "optimism"), 0.66);
});

test("net estimate floors to a cent and never goes negative", () => {
  assert.equal(estimatedEcoNet(2, "base"), 1.96);
  // float-hostile inputs: (n - fee) * 100 must not floor a cent away
  assert.equal(estimatedEcoNet(1.04, "base"), 1);
  assert.equal(estimatedEcoNet(0.04, "base"), 0);
  assert.equal(estimatedEcoNet(0.03, "base"), 0); // below the fee — nothing credited
  assert.equal(estimatedEcoNet(0), 0);
  assert.equal(estimatedEcoNet("nope"), 0);
});

// --- confirm-time plan lines ------------------------------------------------

test("eco plan disclosure names the Arc settlement, the fixed fee and estimated net", () => {
  const text = methodPlanLines({ method: "eco", chainKey: "optimism", amount: 0.7 }).join("\n");
  assert.match(text, /route\s+optimism → settles into Gateway on Arc/);
  assert.doesNotMatch(text, /Polygon/);
  assert.match(text, /fee\s+~\$0\.04 fixed Eco fee from optimism/);
  assert.match(text, /measured, not quotable pre-deposit/);
  assert.match(text, /weighs heavier on small deposits/);
  assert.match(text, /net\s+you'll receive ≈\$0\.66 in Gateway/);
  // the fee is flat now: base discloses the same fee as optimism
  const base = methodPlanLines({ method: "eco", chainKey: "base", amount: 0.65 }).join("\n");
  assert.match(base, /fee\s+~\$0\.04 fixed Eco fee from base/);
  assert.match(base, /net\s+you'll receive ≈\$0\.61 in Gateway/);
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
