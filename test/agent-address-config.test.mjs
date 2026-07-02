import test from "node:test";
import assert from "node:assert/strict";

import { configuredPayerAddress } from "../lib/circle.mjs";
import { pickFundedSibling } from "../lib/commands/doctor.mjs";

// Issue #54: getAgentAddress() must consult the same home config selat-pay
// signs from — not just process.env — or doctor/helpers report a different
// (often empty) wallet than the actual payer. Addresses are fabricated.
const ENV_ADDR = "0x1111111111111111111111111111111111111111";
const CFG_ADDR = "0x2222222222222222222222222222222222222222";

test("configuredPayerAddress: env wins over home config", () => {
  const got = configuredPayerAddress({
    env: { SELAT_AGENT_WALLET_ADDRESS: ENV_ADDR },
    config: { SELAT_AGENT_WALLET_ADDRESS: CFG_ADDR },
  });
  assert.equal(got, ENV_ADDR);
});

test("configuredPayerAddress: falls back to the home config when env is unset", () => {
  assert.equal(
    configuredPayerAddress({ env: {}, config: { SELAT_AGENT_WALLET_ADDRESS: CFG_ADDR } }),
    CFG_ADDR,
  );
  // Whitespace in a hand-edited .env is tolerated.
  assert.equal(
    configuredPayerAddress({ env: {}, config: { SELAT_AGENT_WALLET_ADDRESS: `  ${CFG_ADDR}  ` } }),
    CFG_ADDR,
  );
});

test("configuredPayerAddress: invalid values are skipped, not returned", () => {
  // Invalid env does NOT shadow a valid config value.
  assert.equal(
    configuredPayerAddress({
      env: { SELAT_AGENT_WALLET_ADDRESS: "not-an-address" },
      config: { SELAT_AGENT_WALLET_ADDRESS: CFG_ADDR },
    }),
    CFG_ADDR,
  );
  assert.equal(configuredPayerAddress({ env: {}, config: {} }), null);
  assert.equal(configuredPayerAddress(), null);
  assert.equal(
    configuredPayerAddress({ env: { SELAT_AGENT_WALLET_ADDRESS: "0x123" }, config: {} }),
    null,
  );
});

// doctor's funded-sibling hint: when the resolved wallet is empty but another
// agent wallet on the account holds Gateway funds, surface it.
const W_EMPTY = "0x3333333333333333333333333333333333333333";
const W_RICH = "0x4444444444444444444444444444444444444444";
const W_POOR = "0x5555555555555555555555555555555555555555";

test("pickFundedSibling returns the best-funded other wallet", () => {
  const got = pickFundedSibling(
    [
      { address: W_POOR, usd: 0.01 },
      { address: W_RICH, usd: 5.845435 },
      { address: W_EMPTY, usd: 0 },
    ],
    W_EMPTY,
  );
  assert.deepEqual(got, { address: W_RICH, usd: 5.845435 });
});

test("pickFundedSibling excludes the current wallet and zero balances", () => {
  // The current wallet's own funds never count as a "sibling" finding.
  assert.equal(pickFundedSibling([{ address: W_EMPTY, usd: 9 }], W_EMPTY), null);
  // Case-insensitive current-address match.
  assert.equal(pickFundedSibling([{ address: W_EMPTY.toUpperCase(), usd: 9 }], W_EMPTY), null);
  assert.equal(pickFundedSibling([{ address: W_POOR, usd: 0 }], W_EMPTY), null);
  assert.equal(pickFundedSibling([], W_EMPTY), null);
  assert.equal(pickFundedSibling(undefined, W_EMPTY), null);
});
