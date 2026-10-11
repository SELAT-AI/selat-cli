import test from "node:test";
import assert from "node:assert/strict";

import { BALANCE_CHAINS, TARGET_USDC_CHAINS, usdcFromWalletBalancePayload } from "../lib/circle.mjs";
import { FUND_QR_CHAINS } from "../lib/qr.mjs";

test("on-chain balance reads include Arc; the QR target list does not change", () => {
  const arc = BALANCE_CHAINS.find((c) => c.key === "arc");
  assert.deepEqual(arc, { key: "arc", circleCode: "ARC", id: 5042, usdc: null });
  assert.ok(!TARGET_USDC_CHAINS.some((c) => c.key === "arc"));
  // Arc appears exactly once in the funding-QR list (from qr.mjs's own extras).
  assert.equal(FUND_QR_CHAINS.filter((c) => c.key === "arc").length, 1);
});

test("Arc's double USDC listing (native + 0x3600… ERC-20 view) counts once", () => {
  // Live `circle wallet balance --chain ARC --output json`, 2026-10-11.
  const payload = { data: { balances: [
    { amount: "2.96", token: { name: "USDC", symbol: "USDC", blockchain: "ARC", decimals: 18, isNative: true } },
    { amount: "2.96", token: { name: "USDC", symbol: "USDC", blockchain: "ARC", decimals: 6, isNative: false, tokenAddress: "0x3600000000000000000000000000000000000000" } },
  ] } };
  assert.equal(usdcFromWalletBalancePayload(payload), 2.96);
});
