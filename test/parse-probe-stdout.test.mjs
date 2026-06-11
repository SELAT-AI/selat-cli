import test from "node:test";
import assert from "node:assert/strict";

import { parseProbeStdout } from "../lib/skill-registry.mjs";

// Guards the cross-repo contract that `skill verify` depends on: selat-pay's
// `--probe-only` output shape. A free (zero-quote) endpoint must parse as
// reachable with price 0 so the step verifies — see SELAT-AI/selat-cli#20,
// resolved once selat-pay#9 emitted a free-case probe summary.

// selat-pay's actual --probe-only stdout for a FREE endpoint (mode=routed-free).
const FREE_PROBE = JSON.stringify({
  mode: "routed-free",
  selectedProtocol: "free",
  detected: { x402: null, mpp: null },
  quote: { price: { amount: "0", formatted: "$0 USDC" }, network: "eip155:8453" },
}, null, 2);

// selat-pay's --probe-only stdout for a PAID (routed-x402) endpoint.
const PAID_PROBE = JSON.stringify({
  mode: "routed-x402",
  quote: { quoteId: "q1", price: { amount: "8000", formatted: "$0.008000 USDC" } },
}, null, 2);

test("parseProbeStdout maps a free routed-free summary to reachable with price 0", () => {
  const { mode, livePriceUsd } = parseProbeStdout(FREE_PROBE);
  assert.equal(mode, "routed-free");
  assert.equal(livePriceUsd, 0);

  // verifySkillDir's reachability/cap logic over this result.
  const cap = 0.05;
  const reachable = mode != null; // (with selat-pay exit code 0)
  const withinCap = reachable && livePriceUsd != null && Number.isFinite(cap)
    ? livePriceUsd <= cap
    : reachable && livePriceUsd == null;
  assert.equal(reachable, true);
  assert.equal(withinCap, true);
});

test("parseProbeStdout still maps a paid summary to its base-unit price", () => {
  const { mode, livePriceUsd } = parseProbeStdout(PAID_PROBE);
  assert.equal(mode, "routed-x402");
  assert.equal(livePriceUsd, 0.008);
});

test("parseProbeStdout returns nulls when there is no probe summary", () => {
  // Pre-#9 free behavior (raw body) and any non-JSON / no-mode output.
  assert.deepEqual(parseProbeStdout('{"ok":true,"data":"free body"}'), { mode: null, livePriceUsd: null });
  assert.deepEqual(parseProbeStdout("not json"), { mode: null, livePriceUsd: null });
});

test("parseProbeStdout recovers JSON embedded in surrounding log lines", () => {
  const noisy = `[selat-pay] probing\n${FREE_PROBE}\n[selat-pay] done`;
  const { mode, livePriceUsd } = parseProbeStdout(noisy);
  assert.equal(mode, "routed-free");
  assert.equal(livePriceUsd, 0);
});
