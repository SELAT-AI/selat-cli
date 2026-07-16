import test from "node:test";
import assert from "node:assert/strict";

import { usdcFromWalletBalancePayload } from "../lib/circle.mjs";

// Live Hermes onboarding incident (2026-07): the Circle CLI 0.0.5 payload
// nests the token symbol (`data.balances[].token.symbol`), and the old parser
// stringified the token object — so a wallet holding USDC read as $0 and
// `selat fund` refused a deposit that would have succeeded, while a manual
// `circle wallet balance` clearly showed the funds. These tests pin every
// shape the CLI has shipped, with the 0.0.5 envelope captured verbatim.

test("parses the live Circle CLI 0.0.5 envelope (data.balances + nested token.symbol)", () => {
  // Captured from `circle wallet balance --output json` (CLI 0.0.5).
  const live = {
    data: {
      balances: [
        {
          amount: "3",
          token: {
            name: "USD Coin",
            symbol: "USDC",
            blockchain: "BASE",
            decimals: 6,
            isNative: false,
            tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
          }
        }
      ]
    }
  };
  assert.equal(usdcFromWalletBalancePayload(live), 3);
});

test("parses legacy flat shapes (symbol / token string, amount / balance / value)", () => {
  assert.equal(usdcFromWalletBalancePayload({ tokens: [{ symbol: "USDC", amount: "1.5" }] }), 1.5);
  assert.equal(usdcFromWalletBalancePayload({ balances: [{ token: "usdc", balance: 0.25 }] }), 0.25);
  assert.equal(usdcFromWalletBalancePayload({ data: { tokens: [{ symbol: "USDC", value: 2 }] } }), 2);
});

test("non-USDC rows read as zero holdings, not unknown", () => {
  assert.equal(usdcFromWalletBalancePayload({ tokens: [{ symbol: "ETH", amount: "1" }] }), 0);
  assert.equal(usdcFromWalletBalancePayload({ data: { balances: [] } }), 0);
});

test("a non-array rows field is unreadable (null), never zero", () => {
  assert.equal(usdcFromWalletBalancePayload({ tokens: "nope" }), null);
});

test("a nested token object must never be stringified into a non-match", () => {
  // The regression: token is an object, symbol lives inside it, amount is 0.
  const zeroRow = { data: { balances: [{ amount: "0", token: { symbol: "USDC" } }] } };
  assert.equal(usdcFromWalletBalancePayload(zeroRow), 0);
});
