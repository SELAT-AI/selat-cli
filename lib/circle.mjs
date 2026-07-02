/**
 * Circle CLI helpers — auth status, wallet operations, parsing.
 */

import { randomUUID } from "node:crypto";

import { sh, hasBin } from "./sh.mjs";
import { readConfig } from "./config.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

export async function hasCircle() {
  return hasBin(CIRCLE_BIN);
}

/**
 * Ensure the Circle CLI is installed. No-op if `circle` is already on PATH;
 * otherwise install @circle-fin/cli globally. Installing the binary moves no
 * money — wallet login (OTP), creation, and funding still happen interactively
 * under the user's own Circle account, so self-custody is preserved.
 *
 * Mirrors scripts/install-circle-cli.sh: retry with an isolated temp cache if
 * the default npm cache is broken (some agent hosts inherit stale root-owned
 * npm state). Returns true if `circle` resolves on PATH afterward.
 */
export async function ensureCircle() {
  if (await hasCircle()) return true;
  if (!(await hasBin("npm"))) return false;
  let r = await sh("npm", ["install", "-g", "@circle-fin/cli"], { inherit: true });
  if (r.code === 0 && (await hasCircle())) return true;
  const cache = `${process.env.TMPDIR || "/tmp"}/selat-circle-npm-cache`;
  r = await sh("npm", ["install", "-g", "@circle-fin/cli", "--cache", cache], { inherit: true });
  return r.code === 0 && (await hasCircle());
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
  return (await listAgentWalletsDetailed()).wallets;
}

/**
 * Like listAgentWallets(), but keeps enough diagnostics for setup flows to
 * distinguish "no wallets exist" from "Circle wallet list was unreachable".
 */
export async function listAgentWalletsDetailed() {
  const seen = new Map(); // address -> set of chains
  const failures = [];
  for (const chain of DEFAULT_QUERY_CHAINS) {
    const r = await sh(CIRCLE_BIN, ["wallet", "list", "--type", "agent", "--chain", chain, "--output", "json"]).catch(() => null);
    if (!r || r.code !== 0) {
      failures.push({
        chain,
        code: r?.code ?? null,
        message: (r?.stderr || r?.stdout || "wallet list failed").trim()
      });
      continue;
    }
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
      failures.push({ chain, code: r.code, message: "wallet list returned malformed JSON" });
    }
  }
  return {
    wallets: [...seen].map(([address, chains]) => ({ address, chains: [...chains] })),
    failures,
    queriedChains: DEFAULT_QUERY_CHAINS.length
  };
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve the configured payer address from env and the home config, in that
 * order. Pure (both sources injected) so it's unit-testable. Returns a valid
 * 0x address or null.
 */
export function configuredPayerAddress({ env = {}, config = {} } = {}) {
  for (const source of [env, config]) {
    const v = String(source?.SELAT_AGENT_WALLET_ADDRESS ?? "").trim();
    if (ADDR_RE.test(v)) return v;
  }
  return null;
}

/**
 * Pick the agent wallet address to resolve balances / settlement chain against.
 *
 * This MUST agree with the wallet selat-pay actually signs with, which is
 * `SELAT_AGENT_WALLET_ADDRESS` (see selat-pay `--address` default). selat-pay
 * reads that from ~/.config/selat-pay/.env itself, so this helper must consult
 * the SAME home config — not just process.env, which the shell rarely exports
 * (issue #54). A Circle account can hold up to 5 agent wallets with DISTINCT
 * addresses (createWallets `{ fresh: true }`), so deriving the address purely
 * from `listAgentWallets()` can resolve a *different* (and possibly unfunded)
 * wallet than the payer — which makes a funded wallet look empty. Resolution
 * order: env > home config > discovery (most-chains wallet) as a last resort.
 */
export async function getAgentAddress() {
  const config = await readConfig().catch(() => ({}));
  const configured = configuredPayerAddress({ env: process.env, config });
  if (configured) return configured;
  const wallets = await listAgentWallets();
  if (wallets.length === 0) return null;
  // No payer pinned: prefer the address on the most chains (stale single-chain
  // wallets last). With multiple agent wallets this is a heuristic — pin
  // SELAT_AGENT_WALLET_ADDRESS to be deterministic.
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
 * The chains we check for on-chain USDC at init/doctor time. Kept local
 * (rather than importing the skill's chains registry) so selat-cli has no
 * cross-package dependency. `circleCode` is what the Circle CLI's --chain wants.
 *
 * Base/Optimism/Arbitrum are the Eco (gasless) deposit sources; Polygon is the
 * Eco settlement chain and a valid `direct` deposit source, so it's checked too
 * — otherwise a wallet holding USDC on Polygon looks empty here.
 */
export const TARGET_USDC_CHAINS = [
  { key: "base", circleCode: "BASE", id: 8453 },
  { key: "optimism", circleCode: "OP", id: 10 },
  { key: "arbitrum", circleCode: "ARB", id: 42161 },
  { key: "polygon", circleCode: "MATIC", id: 137 }
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
 * Check on-chain USDC across the target chains (see TARGET_USDC_CHAINS).
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
  const res = await gatewayBalancesByChain(address, queryChain);
  return res ? res.total : null;
}

/**
 * Per-chain Gateway balance breakdown. Same `gateway balance --all` call as
 * gatewayBalance(), but also parses the per-network `balances[]` array so callers
 * can show WHICH chain holds the funds — i.e. the chain you must pass as
 * `--chain` when paying. Eco deposits settle on Polygon, so eco-funded balances
 * surface here as a Polygon row even though the source chain was Base/OP/Arb.
 *
 * Real JSON output (confirmed live against the Circle CLI):
 *   { "data": { "total": "4.040922", "token": "USDC",
 *       "balances": [ { "network": "Base", "domain": 6, "balance": "4.040922" }, ... ] } }
 * NOTE: `total` and each `balance` are human-readable USDC decimal strings, NOT
 * base units — parse with Number(), not BigInt()/1e6. (The old base-units
 * assumption made `gatewayBalance` throw and report null for any funded wallet.)
 *
 * Returns { total, perChain: [{ network, domain, usdc }] }, or null if unavailable.
 */
export async function gatewayBalancesByChain(address, queryChain = "BASE") {
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
    const data = parsed?.data ?? parsed;
    const rawTotal = data?.total;
    if (rawTotal == null) return null;
    const toUsd = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const perChain = Array.isArray(data?.balances)
      ? data.balances.map((b) => ({
          network: b.network ?? null,
          domain: b.domain ?? null,
          usdc: toUsd(b.balance ?? "0")
        }))
      : [];
    return { total: toUsd(rawTotal), perChain };
  } catch {
    return null;
  }
}

/**
 * Map a Circle Gateway network name (the `network` field in `gateway balance`
 * rows, e.g. "Base", "Polygon") to a selat-pay `--chain` key. The names lowercase
 * cleanly to selat-pay's keys for the EVM chains we pay on (base, optimism,
 * arbitrum, polygon, ethereum, avalanche, unichain).
 */
export function gatewayNetworkToChainKey(network) {
  return network ? String(network).toLowerCase() : null;
}

/**
 * Resolve the chain to pay on from the wallet's funded Gateway balance: the
 * chain holding the largest positive balance. Returns a selat-pay chain key
 * (e.g. "polygon"), or null when nothing is funded / the balance is unavailable.
 *
 * Used as the default `--chain` for skills that don't pin one, so an Eco deposit
 * — which settles on Polygon regardless of source chain — "just works" without
 * the user having to pass --chain.
 */
export async function resolveFundedChainKey(address) {
  const gw = await gatewayBalancesByChain(address);
  if (!gw) return null;
  const funded = (gw.perChain ?? []).filter((c) => (c.usdc ?? 0) > 0);
  if (!funded.length) return null;
  funded.sort((a, b) => (b.usdc ?? 0) - (a.usdc ?? 0));
  return gatewayNetworkToChainKey(funded[0].network);
}
