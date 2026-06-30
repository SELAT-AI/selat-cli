import test from "node:test";
import assert from "node:assert/strict";

import { resolveWalletAddress } from "../lib/commands/init.mjs";

// resolveWalletAddress() makes the bootstrap wallet path idempotent + recoverable:
// it attempts the (idempotent) create, then reads the address back. If create
// FAILS — most often because the account is at Circle's 5-wallet cap, which means
// a wallet already exists — it must recover by reusing the readable/configured
// wallet rather than dead-ending init. Deps are injected so this is deterministic.

const ADDR = "0x" + "ab".repeat(20);
const CONFIGURED = "0x" + "cd".repeat(20);

test("create succeeds and a wallet reads back → use it, created=true, no warning", async () => {
  const logs = [];
  const r = await resolveWalletAddress({
    createWallets: async () => true,
    getAgentAddress: async () => ADDR,
    configuredAddr: null,
    log: (m) => logs.push(m)
  });
  assert.deepEqual(r, { address: ADDR, created: true });
  assert.equal(logs.length, 0);
});

test("create FAILS but a wallet still reads back (at the cap) → reuse it, created=false, warns", async () => {
  const logs = [];
  const r = await resolveWalletAddress({
    createWallets: async () => false, // e.g. account at the 5-wallet limit
    getAgentAddress: async () => ADDR, // …but a wallet already exists
    configuredAddr: null,
    log: (m) => logs.push(m)
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.created, false);
  assert.match(logs.join(" "), /5-wallet limit|using existing/i);
});

test("create fails, nothing reads back, but a configured address exists → reuse configured", async () => {
  const logs = [];
  const r = await resolveWalletAddress({
    createWallets: async () => false,
    getAgentAddress: async () => null,
    configuredAddr: CONFIGURED,
    log: (m) => logs.push(m)
  });
  assert.equal(r.address, CONFIGURED);
  assert.equal(r.created, false);
  assert.match(logs.join(" "), /configured/i);
});

test("create fails, nothing reads back, no configured address → null (caller errors)", async () => {
  const r = await resolveWalletAddress({
    createWallets: async () => false,
    getAgentAddress: async () => null,
    configuredAddr: null
  });
  assert.equal(r.address, null);
  assert.equal(r.created, false);
});

test("does not warn when create genuinely succeeds even with a configured address present", async () => {
  const logs = [];
  const r = await resolveWalletAddress({
    createWallets: async () => true,
    getAgentAddress: async () => ADDR,
    configuredAddr: CONFIGURED,
    log: (m) => logs.push(m)
  });
  assert.equal(r.address, ADDR);
  assert.equal(r.created, true);
  assert.equal(logs.length, 0);
});
