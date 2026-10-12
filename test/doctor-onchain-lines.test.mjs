import test from "node:test";
import assert from "node:assert/strict";

import { onchainUsdcLines } from "../lib/commands/doctor.mjs";

const oc = (rows) => ({ perChain: rows.map(([key, usdc]) => ({ key, usdc })) });

test("a funded Gateway with empty on-chain balances shows no warnings", () => {
  const lines = onchainUsdcLines(oc([["base", 0], ["optimism", 0], ["arbitrum", 0], ["polygon", 0], ["arc", 0]]), { gatewayBal: 5.471084 });
  assert.deepEqual(lines.map((l) => l.level), ["info"]);
  assert.equal(lines[0].text, "on-chain USDC: 0.00 on base, optimism, arbitrum, polygon, arc — normal once deposits are in Gateway");
});

test("an empty Gateway doesn't call zero on-chain balances normal", () => {
  const lines = onchainUsdcLines(oc([["base", 0], ["arc", 0]]), { gatewayBal: 0 });
  assert.equal(lines[0].text, "on-chain USDC: 0.00 on base, arc");
});

test("USDC sitting on-chain is a warning with the deposit command, largest first", () => {
  const lines = onchainUsdcLines(oc([["base", 0.2], ["arc", 5], ["polygon", 0]]), { gatewayBal: 0 });
  assert.deepEqual(lines.map((l) => l.level), ["warn", "warn", "info", "info"]);
  assert.match(lines[0].text, /^on-chain USDC arc: 5\.00 — not in Gateway yet, so it can't pay for anything$/);
  assert.match(lines[1].text, /^on-chain USDC base: 0\.20/);
  assert.equal(lines[2].text, "Deposit it: selat fund --chain arc --amount 5.00");
  assert.equal(lines[3].text, "on-chain USDC: 0.00 on polygon");
});

test("unreadable chains stay individual warnings", () => {
  const lines = onchainUsdcLines(oc([["base", null], ["arc", 0]]), { gatewayBal: 3 });
  assert.deepEqual(lines[0], { level: "warn", text: "on-chain USDC base: could not read" });
  assert.equal(lines[1].text, "on-chain USDC: 0.00 on arc — normal once deposits are in Gateway");
});
