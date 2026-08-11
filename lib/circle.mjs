/**
 * Circle CLI helpers — auth status, wallet operations, parsing.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  // os.tmpdir() honours TMPDIR on POSIX and TEMP/TMP on Windows, where the
  // previous `/tmp` fallback was not a valid path.
  const cache = join(tmpdir(), "selat-circle-npm-cache");
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

export function normalizeAddress(address) {
  const value = String(address ?? "").trim();
  return ADDR_RE.test(value) ? value : null;
}

/**
 * Resolve the configured payer address from env and the home config, in that
 * order. Pure (both sources injected) so it's unit-testable. Returns a valid
 * 0x address or null.
 */
export function configuredPayerAddress({ env = {}, config = {} } = {}) {
  for (const source of [env, config]) {
    const v = normalizeAddress(source?.SELAT_AGENT_WALLET_ADDRESS);
    if (v) return v;
  }
  return null;
}

/**
 * Pick the best wallet from discovered Circle agent wallets.
 * Resolution order:
 *   1. configured payer wallet, when it is present in the discovered set
 *   2. wallet with positive Gateway balance
 *   3. wallet present on the most chains
 *
 * Returns { address, source, gatewayBalance? } or null.
 */
export async function selectAgentWallet(
  wallets,
  { configuredAddress = null, checkGateway = true, gatewayBalanceFor = gatewayBalance } = {}
) {
  if (!Array.isArray(wallets) || wallets.length === 0) return null;
  const candidates = wallets
    .map((wallet, index) => ({
      ...wallet,
      address: normalizeAddress(wallet.address),
      chains: wallet.chains ?? [],
      index
    }))
    .filter((wallet) => wallet.address);
  if (candidates.length === 0) return null;

  const configured = normalizeAddress(configuredAddress);
  const configuredWallet = configured
    ? candidates.find((wallet) => wallet.address.toLowerCase() === configured.toLowerCase())
    : null;
  if (configuredWallet) return { address: configuredWallet.address, source: "config" };

  if (checkGateway) {
    const withGateway = await Promise.all(
      candidates.map(async (wallet) => ({
        ...wallet,
        gatewayBalance: await gatewayBalanceFor(wallet.address)
      }))
    );
    const funded = withGateway
      .filter((wallet) => (wallet.gatewayBalance ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.gatewayBalance ?? 0) - (a.gatewayBalance ?? 0) ||
          (b.chains?.length ?? 0) - (a.chains?.length ?? 0) ||
          a.index - b.index
      );
    if (funded.length > 0) {
      return {
        address: funded[0].address,
        source: "gateway",
        gatewayBalance: funded[0].gatewayBalance
      };
    }
  }

  const sorted = candidates
    .slice()
    .sort((a, b) => (b.chains?.length ?? 0) - (a.chains?.length ?? 0) || a.index - b.index);
  return { address: sorted[0].address, source: "chain-count" };
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
 * order: env > home config > funded discovered wallet > most-chains wallet.
 */
export async function getAgentAddress() {
  const config = await readConfig().catch(() => ({}));
  const configured = configuredPayerAddress({ env: process.env, config });
  if (configured) return configured;
  const wallets = await listAgentWallets();
  const selected = await selectAgentWallet(wallets, { checkGateway: true });
  return selected?.address ?? null;
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
 *
 * `usdc` is the Circle-issued USDC contract on each chain — values mirror the
 * selat-discovery skill's scripts/chains.mjs registry (the deposit-side source
 * of truth; the Base address is also confirmed live in the `circle wallet
 * balance` payload). Used to build EIP-681 funding URIs/QRs (lib/qr.mjs).
 */
export const TARGET_USDC_CHAINS = [
  { key: "base", circleCode: "BASE", id: 8453, usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { key: "optimism", circleCode: "OP", id: 10, usdc: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
  { key: "arbitrum", circleCode: "ARB", id: 42161, usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { key: "polygon", circleCode: "MATIC", id: 137, usdc: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" }
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
/**
 * Read the wallet's aggregate Circle spending-policy state: has the user set
 * custom caps at all, and at what values. Returns { readable: false } when
 * the CLI or read is unavailable, else { readable: true, custom, limits }
 * where `custom` means a user-set (origin CUSTOM) transfer-limit policy
 * exists and `limits` is { perTx, daily, weekly, monthly } in USD (null when
 * unset).
 *
 * IMPORTANT — the policy is PER CHAIN, and this read is NOT. Verified live
 * (2026-08-11, dev wallet): Circle stores STABLECOIN_TRANSFER policies as
 * per-(wallet, chain) rows with origin CUSTOM or DEFAULT, and the signing
 * service enforces whichever row governs the SOURCE chain of a transfer —
 * including EIP-712/ERC-3009 typed-data authorizations (a $6 authorization
 * on BASE was refused under BASE's $5/tx CUSTOM cap while a $5.19 deposit on
 * ARB sailed through under ARB's $100/mo DEFAULT). What a 2026-07 note here
 * called an "inconsistent" plain `limit` read was the per-chain truth: the
 * CUSTOM caps existed on BASE only. The `limit budget` surface this function
 * prefers reads identically on every query chain, so it answers "did the
 * user set caps anywhere" (setup-nudge decisions: init, budget) — it does
 * NOT say which chain those caps govern. For chain-truthful display use
 * chainSpendingPolicy() / spendingPolicyByChain() below.
 *
 * Read-only; never throws.
 */
export async function spendingPolicy(address, chainCode = "BASE") {
  if (!address) return { readable: false };
  const fromBudget = policyFromBudget(await spendingBudget(address, chainCode));
  if (fromBudget) return fromBudget;
  return spendingPolicyFromLimitRead(address, chainCode);
}

/**
 * Map a spendingBudget() result to the spendingPolicy() shape. Pure and
 * exported for tests. Returns null when the budget surface was unreadable
 * (caller falls back to the plain `limit` read).
 */
export function policyFromBudget(budget) {
  if (!budget?.readable) return null;
  if (!budget.custom) return { readable: true, custom: false };
  const limits = { perTx: null, daily: null, weekly: null, monthly: null };
  for (const row of budget.rows ?? []) {
    if (row.window === "per-tx") limits.perTx = row.limit;
    else if (Object.hasOwn(limits, row.window)) limits[row.window] = row.limit;
  }
  return { readable: true, custom: true, limits };
}

/**
 * Fallback cap-state read via the plain `circle wallet limit` surface — only
 * used when `limit budget` is unreadable. Reduces the queried chain's row to
 * the aggregate spendingPolicy() shape.
 */
async function spendingPolicyFromLimitRead(address, chainCode) {
  const row = await chainSpendingPolicy(address, chainCode);
  if (!row.readable) return { readable: false };
  if (row.origin !== "CUSTOM") return { readable: true, custom: false };
  return { readable: true, custom: true, limits: row.limits };
}

/**
 * Extract the governing STABLECOIN_TRANSFER row from a `circle wallet limit
 * --output json` payload. Pure and exported for tests.
 *
 * Real payload (confirmed live 2026-08-11): { data: { policies: [ { origin:
 * "CUSTOM"|"DEFAULT", ruleType: "TRANSFER_LIMIT", perTxLimit, dailyLimit,
 * weeklyLimit, monthlyLimit, ... } ] } }. DEFAULT rows carry real limits too
 * (Circle's account default is $100/month) — they are the enforced policy on
 * chains where the user never set caps, so they must not be dropped. A CUSTOM
 * row wins over a DEFAULT row when both appear.
 *
 * Returns { origin, limits } ({ origin: null, limits: null } when the payload
 * has no transfer-limit row), or null when the payload is malformed.
 */
export function policyRowFromLimitPayload(parsed) {
  const policies = parsed?.data?.policies ?? parsed?.policies ?? [];
  if (!Array.isArray(policies)) return null;
  const transfer = policies.filter(
    (x) => String(x?.ruleType ?? "").toUpperCase() === "TRANSFER_LIMIT"
  );
  const byOrigin = (o) => transfer.find((x) => String(x?.origin ?? "").toUpperCase() === o);
  const row = byOrigin("CUSTOM") ?? byOrigin("DEFAULT");
  if (!row) return { origin: null, limits: null };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return {
    origin: String(row.origin).toUpperCase(),
    limits: { perTx: num(row.perTxLimit), daily: num(row.dailyLimit), weekly: num(row.weeklyLimit), monthly: num(row.monthlyLimit) }
  };
}

/**
 * The spending policy that governs ONE chain, via the plain `circle wallet
 * limit` read — the chain-truthful surface (see spendingPolicy() above for
 * the live verification). Returns { readable: false, chain } on any read
 * failure, else { readable: true, chain, origin: "CUSTOM"|"DEFAULT"|null,
 * limits }. Read-only; never throws.
 */
export async function chainSpendingPolicy(address, chainCode) {
  if (!address || !chainCode) return { readable: false, chain: chainCode ?? null };
  const r = await sh(CIRCLE_BIN, [
    "wallet", "limit",
    "--address", address,
    "--chain", chainCode,
    "--output", "json"
  ]).catch(() => null);
  if (!r || r.code !== 0) return { readable: false, chain: chainCode };
  try {
    const row = policyRowFromLimitPayload(JSON.parse(r.stdout));
    if (!row) return { readable: false, chain: chainCode };
    return { readable: true, chain: chainCode, ...row };
  } catch {
    return { readable: false, chain: chainCode };
  }
}

/**
 * Per-chain policy state across the Circle mainnet chains, in parallel.
 * Chains where the read fails (e.g. the wallet doesn't exist there) come back
 * readable: false — callers filter rather than fail. Order follows `chains`.
 */
export async function spendingPolicyByChain(address, { chains = DEFAULT_QUERY_CHAINS } = {}) {
  return Promise.all(chains.map((chain) => chainSpendingPolicy(address, chain)));
}

/**
 * The chains a discovered wallet exists on (Circle --chain codes), from a
 * listAgentWalletsDetailed().wallets array. Pure and exported for tests.
 */
export function chainsForAddress(wallets, address) {
  const addr = String(address ?? "").toLowerCase();
  const wallet = (wallets ?? []).find((w) => String(w?.address ?? "").toLowerCase() === addr);
  return wallet?.chains ?? [];
}

/**
 * Read remaining spending budget per window (`circle wallet limit budget`).
 * Returns { readable: false } or { readable: true, custom, rows } with rows
 * like { window: "daily", limit, remaining }. Read-only; never throws.
 * `chainCode` is query routing for this surface — the budget rows read
 * identically on every query chain (verified live). NOTE that enforcement is
 * NOT wallet-scoped: the policy actually applied to a transfer is the source
 * chain's per-(wallet, chain) row (see spendingPolicy /
 * chainSpendingPolicy).
 */
export async function spendingBudget(address, chainCode = "BASE") {
  if (!address) return { readable: false };
  const r = await sh(CIRCLE_BIN, [
    "wallet", "limit", "budget",
    "--address", address,
    "--chain", chainCode,
    "--output", "json"
  ]).catch(() => null);
  if (!r || r.code !== 0) return { readable: false };
  try {
    const parsed = JSON.parse(r.stdout);
    const pol = parsed?.data?.policies?.STABLECOIN_TRANSFER ?? null;
    if (!pol) return { readable: true, custom: false, rows: [] };
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const rows = [];
    if (pol.per_tx_limit != null) rows.push({ window: "per-tx", limit: num(pol.per_tx_limit), remaining: null });
    for (const w of ["daily", "weekly", "monthly"]) {
      if (pol[`${w}_limit`] != null || pol[`${w}_remaining`] != null) {
        rows.push({ window: w, limit: num(pol[`${w}_limit`]), remaining: num(pol[`${w}_remaining`]) });
      }
    }
    return { readable: true, custom: String(pol.origin ?? "").toUpperCase() === "CUSTOM", rows };
  } catch {
    return { readable: false };
  }
}

/**
 * One human line for a spendingPolicy() result — the wallet-aggregate
 * cap-state summary used by `selat budget`. Chain-truthful surfaces (doctor,
 * fund) use describeChainPolicy() instead.
 */
export function describePolicy(policy) {
  if (!policy?.readable) return "unknown (could not read the wallet policy)";
  if (!policy.custom) return "none — no custom spending caps (set them: selat setup-policy)";
  const caps = formatCapList(policy.limits);
  return caps ? `capped at ${caps}` : "custom policy set";
}

/** "$5/tx \u00b7 $50/day \u00b7 $200/wk \u00b7 $500/mo" for a limits object; null when empty. */
export function formatCapList(limits) {
  const L = limits || {};
  const part = (v, label) => (v != null ? `$${v}/${label}` : null);
  const parts = [part(L.perTx, "tx"), part(L.daily, "day"), part(L.weekly, "wk"), part(L.monthly, "mo")].filter(Boolean);
  return parts.length ? parts.join(" \u00b7 ") : null;
}

/**
 * One human line for a chainSpendingPolicy() row. Caps are per-chain and a
 * DEFAULT row is a real, enforced policy (typically $100/mo) \u2014 the line must
 * say plainly that the user's custom caps do not govern such a chain, because
 * that is exactly the gap that let a deposit sail past the "$5/tx" the user
 * believed covered the wallet.
 */
export function describeChainPolicy(row) {
  if (!row?.readable) return "unknown (could not read this chain's policy)";
  const caps = formatCapList(row.limits);
  if (row.origin === "CUSTOM") {
    return caps ? `capped at ${caps} (your custom caps)` : "custom policy set";
  }
  return caps
    ? `Circle DEFAULT (${caps}) \u2014 your custom caps do not govern here`
    : "Circle DEFAULT \u2014 no custom caps govern here";
}

/**
 * Extract the USDC amount from a `circle wallet balance --output json`
 * payload. Pure and exported for tests. The CLI has shipped several shapes:
 *   - 0.0.5 (current): { data: { balances: [{ amount, token: { symbol } }] } }
 *     — the symbol is NESTED under `token.symbol`. Missing this read a funded
 *     wallet as $0 and blocked `selat fund` on a wallet that held USDC
 *     (live Hermes onboarding incident, 2026-07).
 *   - older/flat: { tokens|balances: [{ symbol|token, amount|balance|value }] }
 * Returns null when the payload is unreadable (never guess), 0 when the rows
 * are readable but hold no USDC.
 */
export function usdcFromWalletBalancePayload(parsed) {
  const tokens =
    parsed?.data?.balances ?? parsed?.balances ??
    parsed?.data?.tokens ?? parsed?.tokens ?? [];
  if (!Array.isArray(tokens)) return null;
  const usdc = tokens.find((t) => {
    const symbol =
      t?.symbol ??
      t?.token?.symbol ??
      (typeof t?.token === "string" ? t.token : "");
    return String(symbol ?? "").toUpperCase() === "USDC";
  });
  if (!usdc) return 0;
  const amount = Number(usdc.amount ?? usdc.balance ?? usdc.value ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

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
    return usdcFromWalletBalancePayload(JSON.parse(r.stdout));
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
