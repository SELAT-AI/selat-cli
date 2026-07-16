import test from "node:test";
import assert from "node:assert/strict";

import { gatewayPerChainLines, pendingDepositHintLines } from "../lib/commands/doctor.mjs";

// A 0/low Gateway reading right after a deposit means "still settling", not
// "lost" — doctor must say so instead of leaving the user staring at 0 USDC.

test("pendingDepositHintLines fires on a zero balance", () => {
  const lines = pendingDepositHintLines(0);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /5–10 min/);
  assert.match(lines[0], /isn't lost/);
  assert.match(lines[1], /selat fund --wait/);
  assert.match(lines[1], /circle gateway balance --all/);
});

test("pendingDepositHintLines fires on a low (sub-0.5) balance", () => {
  assert.equal(pendingDepositHintLines(0.1).length, 2);
  assert.equal(pendingDepositHintLines(0.499999).length, 2);
});

test("pendingDepositHintLines stays quiet when the balance is healthy or unreadable", () => {
  assert.deepEqual(pendingDepositHintLines(0.5), []);
  assert.deepEqual(pendingDepositHintLines(12), []);
  // Unreadable balance already gets its own warning; don't stack hints on it.
  assert.deepEqual(pendingDepositHintLines(null), []);
  assert.deepEqual(pendingDepositHintLines(undefined), []);
});

// Per-chain Gateway rows are a routing detail behind `doctor --by-chain` —
// the default Gateway line is ONE number (live onboarding feedback: the
// enumeration read as separate per-chain balances).

test("gatewayPerChainLines lists funded chains as routing detail", () => {
  const lines = gatewayPerChainLines({
    total: 4.04,
    perChain: [
      { network: "Base", domain: 6, usdc: 0 },
      { network: "Polygon", domain: 7, usdc: 4.04 }
    ]
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Polygon \(domain 7\): 4\.040000 USDC/);
  assert.match(lines[0], /routing detail/);
  assert.match(lines[0], /--chain polygon/);
});

test("gatewayPerChainLines is empty when nothing is funded or unreadable", () => {
  assert.deepEqual(gatewayPerChainLines({ total: 0, perChain: [{ network: "Base", domain: 6, usdc: 0 }] }), []);
  assert.deepEqual(gatewayPerChainLines(null), []);
  assert.deepEqual(gatewayPerChainLines({}), []);
});
