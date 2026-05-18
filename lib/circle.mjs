/**
 * Circle CLI helpers — auth status, wallet operations, parsing.
 */

import { sh, hasBin } from "./sh.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

export async function hasCircle() {
  return hasBin(CIRCLE_BIN);
}

/**
 * Install Circle CLI globally with npm.
 * Retries with a temp cache if the default cache is broken (a known issue).
 */
export async function installCircleCli() {
  const direct = await sh("npm", ["install", "-g", "@circle-fin/cli"], { inherit: true });
  if (direct.code === 0) return { ok: true, fallback: false };

  // Fallback: isolated cache. Matches scripts/install-circle-cli.sh in the skill repo.
  const tmp = process.env.TMPDIR || "/tmp";
  const cacheDir = `${tmp}/juris-circle-install-cache`;
  const retry = await sh(
    "npm",
    ["install", "-g", "@circle-fin/cli", "--cache", cacheDir],
    { inherit: true }
  );
  return { ok: retry.code === 0, fallback: true };
}

/**
 * Check whether the Circle CLI has an active agent session.
 * Returns { authed: boolean, email?: string }.
 *
 * Real output of `circle wallet status --type agent`:
 *   Type:     agent
 *   Email:    user@example.com
 *   Status:   VALID
 *   Expires:  Nd Nh Nm
 */
export async function authStatus() {
  const r = await sh(CIRCLE_BIN, ["wallet", "status", "--type", "agent"]).catch(() => null);
  if (!r || r.code !== 0) return { authed: false };
  const out = r.stdout + r.stderr;
  const status = out.match(/Status:\s*(\S+)/i)?.[1]?.toUpperCase();
  if (status !== "VALID") return { authed: false };
  const email = out.match(/Email:\s*([\w._%+-]+@[\w.-]+\.[A-Za-z]{2,})/i)?.[1];
  return { authed: true, email };
}

/**
 * Trigger `circle wallet login --type agent` for the given email.
 * The Circle CLI handles the OTP prompt interactively.
 */
export async function login(email) {
  const r = await sh(CIRCLE_BIN, ["wallet", "login", email, "--type", "agent"], {
    env: { CIRCLE_ACCEPT_TERMS: "1" },
    inherit: true
  });
  return r.code === 0;
}

/**
 * Default chains an Agent Wallet is created on. Circle CLI's `wallet list`
 * requires --chain; we query a representative chain to discover the wallet
 * address (all Agent Wallets share the same address across Circle chains).
 */
const DEFAULT_QUERY_CHAINS = ["BASE", "ETH", "ARB", "OP", "POLY", "AVAX", "UNI", "MONAD"];

/**
 * List agent wallets. Iterates the supported chains and returns the union.
 * Real JSON output of `circle wallet list --type agent --chain BASE`:
 *   { "data": { "wallets": [ { "type": "agent", "address": "0x...", "blockchain": "BASE", ... } ] } }
 */
export async function listAgentWallets() {
  const seen = new Map(); // address -> set of chains
  for (const chain of DEFAULT_QUERY_CHAINS) {
    const r = await sh(CIRCLE_BIN, ["wallet", "list", "--type", "agent", "--chain", chain, "--output", "json"]).catch(() => null);
    if (!r || r.code !== 0) continue;
    try {
      const parsed = JSON.parse(r.stdout);
      const wallets = parsed?.data?.wallets ?? parsed?.wallets ?? [];
      for (const w of wallets) {
        if (!w.address) continue;
        const addr = w.address.toLowerCase();
        if (!seen.has(addr)) seen.set(addr, new Set());
        seen.get(addr).add(w.blockchain ?? w.chain ?? chain);
      }
    } catch {
      // ignore malformed output for this chain
    }
  }
  return [...seen].map(([address, chains]) => ({ address, chains: [...chains] }));
}

/**
 * Pick the canonical agent wallet address. All Circle Agent Wallets share the
 * same address across chains (same MPC-derived address per agent account),
 * so we just return the first one we find. Prefer the address that appears
 * on the most chains (in case there are stale single-chain wallets).
 */
export async function getAgentAddress() {
  const wallets = await listAgentWallets();
  if (wallets.length === 0) return null;
  wallets.sort((a, b) => b.chains.length - a.chains.length);
  return wallets[0].address;
}

/**
 * Create agent wallets on every Circle-supported chain. Idempotent — Circle
 * CLI no-ops on chains where a wallet already exists.
 */
export async function createWallets() {
  const r = await sh(CIRCLE_BIN, ["wallet", "create", "--type", "agent"], { inherit: true });
  return r.code === 0;
}

/**
 * Check Gateway balance across all Circle-supported chains. The Circle CLI
 * requires --chain even though Gateway is chain-unified; pass BASE as the
 * query chain since it always returns the cross-chain totals.
 *
 * Real JSON output:
 *   { "data": { "total": "0", "token": "USDC", "balances": [ ... per-network ... ] } }
 *
 * Returns total USDC as a number, or null if unavailable.
 */
export async function gatewayBalance(address, queryChain = "BASE") {
  if (!address) return null;
  const r = await sh(CIRCLE_BIN, [
    "gateway", "balance",
    "--address", address,
    "--chain", queryChain,
    "--output", "json"
  ]).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const total = parsed?.data?.total ?? parsed?.total ?? null;
    if (total == null) return null;
    // total is in base units (USDC has 6 decimals) — convert to USD.
    return Number(BigInt(total)) / 1_000_000;
  } catch {
    return null;
  }
}
