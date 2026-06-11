/**
 * Circle CLI helpers — auth status, wallet operations, parsing.
 */

import { randomUUID } from "node:crypto";

import { sh, hasBin } from "./sh.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

export async function hasCircle() {
  return hasBin(CIRCLE_BIN);
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
// Circle CLI blockchain codes. Polygon is "MATIC" (matches the agent-payments
// chain registry and Circle docs); "POLY" is not a Circle code and silently
// returns nothing.
const DEFAULT_QUERY_CHAINS = ["BASE", "ETH", "ARB", "OP", "MATIC", "AVAX", "UNI", "MONAD"];

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
 * Create agent wallets on every Circle-supported chain. By default this is the
 * idempotent bootstrap (the Circle CLI no-ops where a wallet already exists).
 * Pass { fresh: true } to request an *additional* agent wallet under the same
 * account (Circle allows up to 5) by sending a unique idempotency key.
 */
export async function createWallets({ fresh = false } = {}) {
  const args = ["wallet", "create", "--type", "agent"];
  if (fresh) args.push("--idempotency-key", randomUUID());
  const r = await sh(CIRCLE_BIN, args, { inherit: true });
  return r.code === 0;
}

/**
 * The three chains we check for on-chain USDC at init/doctor time. Kept local
 * (rather than importing the skill's chains registry) so selat-cli has no
 * cross-package dependency. `circleCode` is what the Circle CLI's --chain wants.
 */
export const TARGET_USDC_CHAINS = [
  { key: "base", circleCode: "BASE", id: 8453 },
  { key: "optimism", circleCode: "OP", id: 10 },
  { key: "arbitrum", circleCode: "ARB", id: 42161 }
];

/**
 * Read the on-chain USDC balance for a wallet on a single chain via
 * `circle wallet balance --address <addr> --chain <CODE> --output json`.
 *
 * Real JSON output (confirmed live):
 *   { "data": { "balances": [ { "symbol": "USDC", "amount": "1.5", ... } ] } }
 *
 * Unlike `gateway balance` (base units), `wallet balance` emits human-readable
 * token amounts, so we return the amount as-is — no /1e6 conversion. Returns
 * null (not 0) when the call fails or no wallet/token exists on that chain, so
 * callers can distinguish "no funds" from "could not read".
 */
export async function walletUsdcBalance(address, chainCode) {
  if (!address) return null;
  const r = await sh(CIRCLE_BIN, [
    "wallet", "balance",
    "--address", address,
    "--chain", chainCode,
    "--output", "json"
  ]).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const tokens =
      parsed?.data?.balances ?? parsed?.balances ??
      parsed?.data?.tokens ?? parsed?.tokens ?? [];
    if (!Array.isArray(tokens)) return null;
    const usdc = tokens.find(
      (t) => String(t.symbol ?? t.token ?? "").toUpperCase() === "USDC"
    );
    if (!usdc) return 0;
    const amount = Number(usdc.amount ?? usdc.balance ?? usdc.value ?? 0);
    return Number.isFinite(amount) ? amount : 0;
  } catch {
    return null;
  }
}

/**
 * Check on-chain USDC across the target chains (Base / Optimism / Arbitrum).
 * Returns { perChain: [{ key, circleCode, id, usdc }], total, hasAny, errors }
 * where usdc is null for chains that could not be read. `hasAny` is true when
 * any chain holds a positive USDC balance.
 */
export async function usdcBalances(address, { chains = TARGET_USDC_CHAINS } = {}) {
  const perChain = await Promise.all(
    chains.map(async (c) => ({
      key: c.key,
      circleCode: c.circleCode,
      id: c.id,
      usdc: await walletUsdcBalance(address, c.circleCode)
    }))
  );
  const total = perChain.reduce((sum, c) => sum + (c.usdc ?? 0), 0);
  const hasAny = perChain.some((c) => (c.usdc ?? 0) > 0);
  const errors = perChain.filter((c) => c.usdc == null).map((c) => c.key);
  return { perChain, total, hasAny, errors };
}

/**
 * Check Gateway balance across all Circle-supported chains. The Circle CLI
 * requires --chain even though Gateway is chain-unified, and the cross-chain
 * total requires --all (matching the agent-payments wrapper); without --all the
 * call reports only the single --chain network. We pass BASE as the query chain
 * and --all to get the unified total.
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
    "--all",
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
