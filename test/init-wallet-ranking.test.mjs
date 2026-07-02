import test from "node:test";
import assert from "node:assert/strict";

import { rankWalletCandidates } from "../lib/commands/init.mjs";

// Multi-wallet init selection (issue #52): a Circle account can hold up to 5
// agent wallets, listed newest-first. init must not silently take the first —
// rankWalletCandidates orders the menu (and its default) as configured >
// funded > listed order. Addresses are fabricated placeholders.
const W1 = "0x1111111111111111111111111111111111111111"; // newest → listed first
const W2 = "0x2222222222222222222222222222222222222222";
const W3 = "0x3333333333333333333333333333333333333333"; // funded
const WALLETS = [
  { address: W1, chains: ["BASE", "OP"] },
  { address: W2, chains: ["BASE"] },
  { address: W3, chains: ["BASE", "OP", "ARB"] },
];

test("ranks the funded wallet above the first-listed when nothing is configured", () => {
  const ranked = rankWalletCandidates({
    wallets: WALLETS,
    balances: { [W3.toLowerCase()]: 5.84, [W1.toLowerCase()]: 0, [W2.toLowerCase()]: 0 },
  });
  assert.equal(ranked[0].address, W3);
  assert.equal(ranked[0].gatewayUsd, 5.84);
  // Ties (both 0) keep listed order.
  assert.deepEqual(ranked.slice(1).map((w) => w.address), [W1, W2]);
});

test("configured wallet outranks a better-funded one (config is explicit intent)", () => {
  const ranked = rankWalletCandidates({
    wallets: WALLETS,
    configuredAddr: W2.toUpperCase(), // case-insensitive match
    balances: { [W3.toLowerCase()]: 5.84, [W2.toLowerCase()]: 0.1 },
  });
  assert.equal(ranked[0].address, W2);
  assert.equal(ranked[0].isConfigured, true);
  assert.equal(ranked[1].address, W3); // then funded
});

test("unknown balances rank below any known balance, listed order otherwise", () => {
  const ranked = rankWalletCandidates({
    wallets: WALLETS,
    balances: { [W2.toLowerCase()]: 0 }, // W1/W3 unknown (null)
  });
  assert.equal(ranked[0].address, W2); // 0 is still a known balance
  assert.deepEqual(ranked.slice(1).map((w) => w.address), [W1, W3]);
  assert.equal(ranked[1].gatewayUsd, null);
});

test("does not mutate the input and tolerates empty/missing fields", () => {
  const input = WALLETS.map((w) => ({ ...w }));
  const ranked = rankWalletCandidates({ wallets: input, balances: {} });
  assert.deepEqual(input, WALLETS); // untouched
  assert.equal(ranked.length, 3);
  assert.deepEqual(rankWalletCandidates({ wallets: [] }), []);
  assert.deepEqual(rankWalletCandidates({}), []);
});
