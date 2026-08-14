import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_GATEWAY_DEPOSIT_USDC,
  depositAmountError,
} from "../lib/commands/fund.mjs";

// Circle CLI ≥1.0.0 refuses `gateway deposit` below 0.5 USDC (any method,
// any chain — verified live 2026-08-13: "Gateway deposit amount must be at
// least 0.5 USDC", checked before even the method/chain flags). fund mirrors
// the floor so the refusal lands before the prompt/confirm flow, with SELAT
// wording instead of a raw CLI error mid-flow.

test("the mirrored floor matches the CLI's 0.5 USDC minimum", () => {
  assert.equal(MIN_GATEWAY_DEPOSIT_USDC, 0.5);
});

test("depositAmountError refuses sub-floor amounts with actionable wording", () => {
  const err = depositAmountError(0.25);
  assert.match(err, /0\.5 USDC minimum/);
  assert.match(err, /--amount 0\.5 or more/);
  assert.equal(depositAmountError(0.5), null);
  assert.equal(depositAmountError(2), null);
});

test("depositAmountError keeps the positive-number rule first", () => {
  assert.equal(depositAmountError(0), "--amount must be a positive number");
  assert.equal(depositAmountError(-1), "--amount must be a positive number");
  assert.equal(depositAmountError(NaN), "--amount must be a positive number");
});

test("Arc raw-key deposits are exempt from the CLI floor but not the positive rule", () => {
  // Arc bypasses the Circle CLI entirely (raw EOA key + private RPC), so the
  // CLI's floor must not block it.
  assert.equal(depositAmountError(0.25, { isArc: true }), null);
  assert.equal(depositAmountError(0, { isArc: true }), "--amount must be a positive number");
});
