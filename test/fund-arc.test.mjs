import test from "node:test";
import assert from "node:assert/strict";

import { resolveArcDepositEnv } from "../lib/commands/fund.mjs";

// Arc mainnet can't use the Circle agent wallet, so `selat fund --chain arc`
// deposits with a raw EOA key + a private RPC. These pin that the env those
// deposits sign with (SELAT_PRIVATE_KEY / ARC_RPC_URL) is resolved with shell
// env winning over the selat config .env, that eco is rejected, and that a
// missing credential fails loudly rather than silently falling back to the
// agent wallet. See the Arc raw-key deposit path (agent-payments).

const KEY = "0x" + "ab".repeat(32);
const RPC = "https://example.arc-mainnet.invalid/token";

test("resolves from shell env", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: {},
    env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
  });
  assert.deepEqual(res, { ok: true, env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC } });
});

test("falls back to the selat config when shell env is unset", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
    env: {},
  });
  assert.ok(res.ok);
  assert.deepEqual(res.env, { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC });
});

test("shell env wins over the config .env", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: { SELAT_PRIVATE_KEY: "0xconfig", ARC_RPC_URL: "https://config.invalid" },
    env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
  });
  assert.ok(res.ok);
  assert.equal(res.env.SELAT_PRIVATE_KEY, KEY);
  assert.equal(res.env.ARC_RPC_URL, RPC);
});

test("rejects eco (gasless) on Arc before checking credentials", () => {
  const res = resolveArcDepositEnv({
    method: "eco",
    config: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
    env: {},
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /eco is not supported on Arc/);
  assert.equal(res.missing, undefined);
});

test("fails loudly when both credentials are missing", () => {
  const res = resolveArcDepositEnv({ method: "direct", config: {}, env: {} });
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ["SELAT_PRIVATE_KEY", "ARC_RPC_URL"]);
  assert.match(res.error, /SELAT_PRIVATE_KEY and ARC_RPC_URL/);
});

test("names just the one missing credential", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: {},
    env: { SELAT_PRIVATE_KEY: KEY },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ["ARC_RPC_URL"]);
});
