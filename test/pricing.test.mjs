import test from "node:test";
import assert from "node:assert/strict";

import {
  CROSS_PROTOCOL_MARKUP,
  allInPrice,
  allInPriceFields,
  allInPriceText,
  formatUsd,
} from "../lib/pricing.mjs";
import { spendText } from "../lib/commands/budget.mjs";

// Quotes carry the upstream price; the router keeps ~5% on cross-protocol
// translation and passes same-rail Gateway-batched at par. Measured: an
// erc-3009 endpoint quoted $0.001 settled as $0.00105.
const plan = (domain, minAmountUsd, extra = {}) => ({
  minAmountUsd,
  exec_hints: [{ domain, amountUsd: minAmountUsd, ...extra }],
});

test("erc-3009 and tempo-native add the 5% markup", () => {
  for (const d of ["erc-3009", "tempo-native"]) {
    const p = allInPrice(plan(d, 0.001));
    assert.equal(p.feePct, CROSS_PROTOCOL_MARKUP);
    assert.equal(p.feeUsd, 0.00005);
    assert.equal(p.totalUsd, 0.00105);
  }
  assert.equal(allInPriceText(plan("erc-3009", 0.001)), "$0.001 + 5% fee = $0.00105");
});

test("gateway-batched is same-rail at par", () => {
  const p = allInPrice(plan("gateway-batched", 0.001));
  assert.equal(p.feeUsd, 0);
  assert.equal(p.totalUsd, 0.001);
  assert.equal(allInPriceText(plan("gateway-batched", 0.001)), "$0.001 (same-rail, no fee)");
});

test("mpp-solana is translated (~5%); unknown domains show nothing", () => {
  // Measured: smartmoney.market (MPP on Solana) listed $0.01, charged $0.0105.
  const p = allInPrice(plan("mpp-solana", 0.01));
  assert.equal(p.feePct, CROSS_PROTOCOL_MARKUP);
  assert.equal(p.totalUsd, 0.0105);
  assert.equal(allInPrice(plan("permit2", 0.01)), null);
  assert.equal(allInPriceText(plan("some-new-domain", 0.01)), null);
});

test("never invents a number: unknown price, domain, or Apify token flow", () => {
  assert.equal(allInPrice({ minAmountUsd: null, exec_hints: [{ domain: "erc-3009" }] }), null);
  assert.equal(allInPrice({ minAmountUsd: 0.01, exec_hints: [{}] }), null);
  assert.equal(allInPrice({ minAmountUsd: 0.01, exec_hints: [] }), null);
  assert.equal(allInPrice(plan("erc-3009", 1, { flow: "apify-prepaid-token" })), null);
  assert.deepEqual(allInPriceFields({}), {});
});

test("JSON fields are additive and keep upstream price separate", () => {
  assert.deepEqual(allInPriceFields(plan("erc-3009", 0.02)), {
    upstreamUsd: 0.02,
    feeUsd: 0.001,
    totalUsd: 0.021,
    feePct: 0.05,
  });
});

test("sub-cent fees stay visible in text", () => {
  assert.equal(formatUsd(0.00105), "$0.00105");
  assert.equal(formatUsd(0.0105), "$0.0105");
  assert.equal(formatUsd(1.05), "$1.05");
});

test("session spend keeps sub-cent precision (was rounded to $0.0070)", () => {
  assert.equal(spendText(0.00705), "$0.00705");
  assert.equal(spendText(0.006), "$0.0060");
  assert.equal(spendText(0), "$0.0000");
});
