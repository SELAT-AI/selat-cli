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

test("unknown balances rank above confirmed-zero, below confirmed-funded", () => {
  // null = the READ failed, not an empty wallet. Circle API failures come in
  // bursts, so a funded wallet whose read failed must not sort below an empty
  // wallet whose read succeeded — rank #1 is the default a plain Enter (or a
  // non-interactive run) accepts.
  const ranked = rankWalletCandidates({
    wallets: WALLETS,
    balances: { [W2.toLowerCase()]: 0 }, // W1/W3 unknown (null)
  });
  assert.deepEqual(ranked.map((w) => w.address), [W1, W3, W2]); // unknowns keep listed order
  assert.equal(ranked[0].gatewayUsd, null);
  assert.equal(ranked.at(-1).gatewayUsd, 0); // confirmed-empty sorts last
});

test("confirmed-funded still outranks unknown, by balance desc", () => {
  const ranked = rankWalletCandidates({
    wallets: WALLETS,
    balances: { [W2.toLowerCase()]: 0.25, [W3.toLowerCase()]: 5.84 }, // W1 unknown
  });
  assert.deepEqual(ranked.map((w) => w.address), [W3, W2, W1]);
});

test("does not mutate the input and tolerates empty/missing fields", () => {
  const input = WALLETS.map((w) => ({ ...w }));
  const ranked = rankWalletCandidates({ wallets: input, balances: {} });
  assert.deepEqual(input, WALLETS); // untouched
  assert.equal(ranked.length, 3);
  assert.deepEqual(rankWalletCandidates({ wallets: [] }), []);
  assert.deepEqual(rankWalletCandidates({}), []);
});
