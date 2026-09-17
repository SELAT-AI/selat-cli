import test from "node:test";
import assert from "node:assert/strict";

import { resolveArcDepositEnv, arcDepositSpawnEnv } from "../lib/commands/fund.mjs";
import { maskedFingerprint } from "../lib/arc-fund-signer.mjs";

// Arc mainnet can't use the Circle agent wallet, so `selat fund --chain arc`
// deposits with a raw EOA key + a private RPC. These pin that credentials
// resolve with shell env winning over the selat config .env, that eco is
// rejected, and that a missing credential fails loudly rather than silently
// falling back to the agent wallet. The resolve result is a key-blind wire
// type (SELAT-AI/selat-cli#189): identity is a fingerprint, not the raw key.

const KEY = "0x" + "ab".repeat(32);
const RPC = "https://example.arc-mainnet.invalid/token";

test("resolves from shell env without putting the key on the wire type", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: {},
    env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.env, { ARC_RPC_URL: RPC });
  assert.equal(res.fingerprint, maskedFingerprint(KEY));
  assert.equal(res.env.SELAT_PRIVATE_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(res), KEY);
});

test("falls back to the selat config when shell env is unset", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
    env: {},
  });
  assert.ok(res.ok);
  assert.deepEqual(res.env, { ARC_RPC_URL: RPC });
  assert.equal(arcDepositSpawnEnv(res).SELAT_PRIVATE_KEY, KEY);
  assert.equal(arcDepositSpawnEnv(res).ARC_RPC_URL, RPC);
});

test("shell env wins over the config .env", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    config: { SELAT_PRIVATE_KEY: "0x" + "cd".repeat(32), ARC_RPC_URL: "https://config.invalid" },
    env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
  });
  assert.ok(res.ok);
  assert.equal(res.env.ARC_RPC_URL, RPC);
  assert.equal(arcDepositSpawnEnv(res).SELAT_PRIVATE_KEY, KEY);
  assert.equal(arcDepositSpawnEnv(res).ARC_RPC_URL, RPC);
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

test("refuses a malformed key without echoing it", () => {
  const bad = "0xnot-a-key";
  const res = resolveArcDepositEnv({
    method: "direct",
    config: {},
    env: { SELAT_PRIVATE_KEY: bad, ARC_RPC_URL: RPC },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /0x-prefixed 32-byte hex/);
  assert.doesNotMatch(res.error, bad);
  assert.doesNotMatch(JSON.stringify(res), bad);
});

test("a valueless --method is an error, not a silent direct deposit", async () => {
  // `selat fund --amount 5 --yes --method` (value forgotten) used to default
  // to "direct" — a gas-requiring deposit — with --yes skipping the one
  // confirm screen that would have caught it.
  const { fund } = await import("../lib/commands/fund.mjs");
  const code = await fund(["--amount", "5", "--yes", "--method"]);
  assert.equal(code, 1);
});
