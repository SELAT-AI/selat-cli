/**
 * `selat fund` — top up Circle Gateway balance.
 *
 * Thin wrapper around the selat-discovery skill's
 * `scripts/setup.mjs deposit` / `eco-deposit` commands, which handle the
 * Circle CLI deposit + confirmation phrase.
 *
 * Balance semantics follow Circle's unified-balance model (see
 * docs/ubk-spike.md): a Gateway deposit moves USDC out of the on-chain wallet
 * into ONE unified balance that is spendable from any supported chain. The
 * Unified Balance Kit SDK itself can't sign for self-custody Agent Wallets
 * (its Circle Wallets adapter needs developer-custody credentials), so
 * deposits stay on the Circle CLI and the unified balance is read via
 * `gateway balance --all` — but the UX is unified-balance native:
 *   - `--wait` polls until the deposit is actually credited (deposits report
 *     success 5–10 minutes before the balance is spendable);
 *   - every deposit prints the unified balance with the explicit note that
 *     the on-chain balance dropping is by design (funds are not lost);
 *   - an empty wallet gets a `circle wallet fund --method crypto --open`
 *     QR offer (EIP-681) instead of erroring downstream.
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt, prompt, promptYesNo, stdinIsInteractive } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import {
  getAgentAddress,
  spendingPolicy,
  describePolicy,
  gatewayBalancesByChain,
  walletUsdcBalance,
  TARGET_USDC_CHAINS
} from "../circle.mjs";
import { readConfig, configPath } from "../config.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

/** Default --wait timeout: deposits typically credit in 5–10 min; allow 15. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
/** How often --wait re-reads the unified balance. */
export const WAIT_POLL_INTERVAL_MS = 15_000;

export async function fund(args, { interactive = stdinIsInteractive() } = {}) {
  const skill = findSkill("setup.mjs");
  if (!skill.found) {
    console.error(fmt.error("agent-payment skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }

  const inputs = resolveFundInputs({ args, interactive });
  if (!inputs.ok) {
    console.error(fmt.error(inputs.error));
    return 1;
  }
  const chainArg = inputs.chain || (await prompt("Chain", { default: "base" }));
  const amountArg = inputs.amount || (await prompt("USDC to deposit", { default: "2" }));
  const method = parseMethod(arg(args, "--method") || "direct");
  if (!method.ok) {
    console.error(fmt.error(method.reason));
    return 1;
  }

  const amount = Number(amountArg);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(fmt.error("--amount must be a positive number"));
    return 1;
  }

  const wait = args.includes("--wait");
  const timeout = resolveWaitTimeout(arg(args, "--timeout"));
  if (!timeout.ok) {
    console.error(fmt.error(timeout.error));
    return 1;
  }

  // Arc mainnet can't use the Circle agent wallet (the Circle CLI only knows
  // ARC-TESTNET), so the skill deposits to Arc with a raw EOA key + a private
  // RPC. Resolve those here (shell env wins, then the selat config .env) and
  // pass them through to setup.mjs.
  let depositEnv;
  const isArc = chainArg.toLowerCase() === "arc";
  if (isArc) {
    const res = resolveArcDepositEnv({ method: method.value, config: await readConfig() });
    if (!res.ok) {
      console.error(fmt.error(res.error));
      if (res.missing) {
        console.error(fmt.dim("Arc mainnet can't use the Circle agent wallet — deposits use a raw EOA key + your private Arc RPC."));
        console.error(fmt.dim(`Set them in your shell or ${configPath()}.`));
      }
      return 1;
    }
    depositEnv = res.env;
  }

  // Resolve the payer wallet once: the spending-policy line, the empty-wallet
  // check, the pre-deposit baseline, and the post-deposit unified-balance
  // read all key off it. Arc deposits sign with a raw EOA instead, so the
  // agent address is only used there for the Gateway (unified balance) reads.
  const walletAddr = await getAgentAddress().catch(() => null);

  // Empty-wallet branch: a Gateway deposit needs on-chain USDC to move. If
  // the wallet doesn't hold enough on the deposit chain, the skill's deposit
  // would only fail later with an opaque error — offer the Circle CLI's QR
  // funding flow (EIP-681; the user pays from an external wallet, nothing is
  // signed here) instead. Skipped on Arc (raw-EOA path, no Circle CLI chain
  // code) and when the balance can't be read (never block on a read failure).
  if (!isArc && walletAddr) {
    const chainCode = circleChainCode(chainArg);
    const onchain = chainCode ? await walletUsdcBalance(walletAddr, chainCode) : null;
    if (chainCode && onchain != null && onchain < amount) {
      const shortfall = qrShortfall(amount, onchain);
      const qrArgs = qrFundArgs({ address: walletAddr, chainCode, amount: shortfall });
      const qrCommand = `${CIRCLE_BIN} ${qrArgs.join(" ")}`;
      console.log("");
      console.log(fmt.warn(`wallet holds ${formatUsdc(onchain)} USDC on-chain on ${chainArg} — the ${formatUsdc(amount)} deposit needs ${formatUsdc(shortfall)} more.`));
      if (interactive) {
        const openQr = await promptYesNo(
          `Open a funding QR in your browser (EIP-681 — pay ${formatUsdc(shortfall)} USDC from any external wallet)?`,
          { default: true }
        );
        if (openQr) {
          const r = await sh(CIRCLE_BIN, qrArgs, { inherit: true });
          if (r.code !== 0) return r.code;
          console.log("");
          console.log(fmt.dim("Once the transfer lands on-chain, re-run this `selat fund` command to deposit into your unified balance."));
          return 0;
        }
        console.log(fmt.dim(`Fund the wallet later with: ${qrCommand}`));
        return 1;
      }
      console.error(fmt.error("not enough on-chain USDC to deposit."));
      console.error(fmt.dim("Fund the wallet first (browser QR, pay from any external wallet):"));
      console.error(fmt.cyan(`  ${qrCommand}`));
      return 1;
    }
  }

  const skillCommand = method.value === "eco" ? "eco-deposit" : "deposit";
  const methodLabel = method.value === "eco" ? "Eco gasless" : "direct";
  if (method.value === "eco") {
    // The skill's `eco-deposit` is the source of truth for supported source
    // chains and settles into Gateway on Polygon; it rejects unsupported chains
    // during the dry-run below. We don't duplicate the allowlist here.
    console.log(fmt.dim("▸ Eco gasless deposit (no ETH/native gas needed); settles into Gateway on Polygon — a routing detail: your unified balance is spendable from any supported chain."));
  }

  // The skill's single-chain `deposit` / `eco-deposit` has no dry-run mode —
  // it deposits as soon as it's invoked (only `deposit-all` supports a
  // preview via --execute). So we show the plan locally and invoke setup.mjs
  // exactly once, after the user confirms, with the mainnet confirm phrase.
  // Surface the wallet's spending policy at the money moment — the one hard
  // ceiling a runaway agent cannot bypass. Survey feedback says nobody
  // discovers `selat setup-policy` from docs alone, so the deposit plan is
  // where it must appear. Best-effort read; never blocks the deposit.
  const policy = await spendingPolicy(walletAddr);

  console.log("");
  console.log(fmt.dim("Plan:"));
  console.log(`  method  ${methodLabel}`);
  console.log(`  chain   ${chainArg}`);
  console.log(`  amount  ${amount} USDC`);
  if (wait) console.log(`  wait    until credited (timeout ${formatElapsed(timeout.ms)})`);
  console.log(`  policy  ${describePolicy(policy)}`);
  console.log("");
  if (policy.readable && !policy.custom) {
    console.log(fmt.warn(
      amount > 20
        ? "this wallet has NO spending caps — strongly recommended before deposits over $20"
        : "this wallet has NO spending caps — a looping agent could spend the full balance"
    ));
    console.log(fmt.dim("  set the hard ceiling first (per-tx/daily/weekly/monthly): selat setup-policy"));
    console.log("");
  }

  let confirmed = inputs.confirmed;
  if (confirmed) {
    console.log(fmt.dim(`--yes: proceeding with ${methodLabel} deposit of ${amount} USDC on ${chainArg}.`));
  } else {
    confirmed = await promptYesNo(
      `Proceed with ${methodLabel} deposit of ${amount} USDC on ${chainArg}?`,
      { default: false }
    );
  }
  if (!confirmed) {
    console.log(fmt.dim("aborted"));
    return 0;
  }

  // Snapshot the unified balance BEFORE the deposit so --wait can tell a
  // fresh credit apart from funds that were already there.
  const before = walletAddr ? await gatewayBalancesByChain(walletAddr) : null;

  // The confirm phrase is required for mainnet deposits and ignored on
  // testnet chains; it matches the skill's expectedDepositConfirmation().
  const phrase = `deposit ${amount} USDC`;
  const depositCode = (await sh(
    "node",
    [
      join(skill.path, "scripts", "setup.mjs"),
      skillCommand,
      "--chain", chainArg,
      "--amount", String(amount),
      "--confirm", phrase
    ],
    { inherit: true, ...(depositEnv ? { env: depositEnv } : {}) }
  )).code;
  if (depositCode !== 0) return depositCode;

  if (!walletAddr) {
    console.log("");
    console.log(fmt.dim("Deposit submitted. Couldn't resolve the payer wallet address, so the unified balance can't be read here — check it with `selat doctor`."));
    if (wait) console.log(fmt.warn("--wait skipped: no wallet address to poll."));
    return 0;
  }

  console.log("");
  if (!wait) {
    const balancesNow = await gatewayBalancesByChain(walletAddr);
    for (const line of unifiedBalanceLines(balancesNow)) console.log(line);
    console.log(fmt.dim("Deposits typically become spendable in 5–10 minutes — this success is the submission, not the credit. Use `selat fund --wait` to block until it's spendable."));
    return 0;
  }

  console.log(fmt.dim("▸ Waiting for the Gateway credit (deposits typically take 5–10 minutes to become spendable)…"));
  const result = await waitForGatewayCredit({
    address: walletAddr,
    amount,
    baselineTotal: before?.total ?? null,
    timeoutMs: timeout.ms,
    intervalMs: WAIT_POLL_INTERVAL_MS,
    readBalances: gatewayBalancesByChain,
    onPoll: ({ elapsedMs, total }) => {
      const current = total == null ? "unreadable" : formatUsdc(total);
      console.log(fmt.dim(`  … unified balance ${current} — waiting for the ${formatUsdc(amount)} credit (${formatElapsed(elapsedMs)} elapsed, timeout ${formatElapsed(timeout.ms)})`));
    }
  });

  if (result.credited) {
    console.log(fmt.ok(`credited after ${formatElapsed(result.elapsedMs)}`));
    for (const line of unifiedBalanceLines(result.balances)) console.log(line);
    return 0;
  }
  console.error(fmt.warn(`deposit not credited after ${formatElapsed(result.elapsedMs)} — it is usually still settling, not lost.`));
  for (const line of unifiedBalanceLines(result.balances)) console.error(line);
  console.error(fmt.dim("Re-check with `selat doctor`, or extend the wait with --timeout <seconds> (re-running only deposits again after an explicit confirm)."));
  return 1;
}

function arg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

/**
 * Resolve the deposit inputs up front so a non-interactive shell (agent
 * harness, CI, pipe) fails fast with instructions instead of stalling on a
 * prompt. Money moves here, so non-TTY runs must be fully explicit: both the
 * amount and a `--yes` consent flag are required; only the chain may default.
 * Interactive runs keep the existing prompt flow (`--yes` skips the
 * confirmation there too). `confirmed: null` means "ask via promptYesNo".
 */
export function resolveFundInputs({ args, interactive }) {
  const chain = arg(args, "--chain");
  const amount = arg(args, "--amount");
  const yes = args.includes("--yes") || args.includes("-y");
  if (interactive) return { ok: true, chain, amount, confirmed: yes || null };
  if (!amount) {
    return { ok: false, error: "no TTY to prompt for the deposit amount — re-run with --amount <usdc> (and --yes to confirm the deposit)" };
  }
  if (!yes) {
    return { ok: false, error: `a deposit needs explicit confirmation and this shell has no TTY — re-run with --yes to deposit ${amount} USDC on ${chain || "base"}` };
  }
  return { ok: true, chain: chain || "base", amount, confirmed: true };
}

function parseMethod(method) {
  if (method === "direct" || method === "eco") return { ok: true, value: method };
  return { ok: false, reason: "--method must be `direct` or `eco`" };
}

/**
 * Resolve `--timeout <seconds>` for --wait. Defaults to 15 minutes (deposits
 * typically credit in 5–10). Returns { ok: true, ms } or { ok: false, error }.
 */
export function resolveWaitTimeout(raw) {
  if (raw == null) return { ok: true, ms: DEFAULT_WAIT_TIMEOUT_MS };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: "--timeout must be a positive number of seconds" };
  }
  return { ok: true, ms: n * 1000 };
}

/**
 * Map a selat chain key ("base", "polygon", …) to the Circle CLI --chain code
 * ("BASE", "MATIC", …). Extends TARGET_USDC_CHAINS with the other Gateway EVM
 * mainnets the Circle CLI knows. Returns null for chains the Circle CLI can't
 * address (e.g. Arc mainnet), so callers skip Circle-CLI-only branches.
 */
const EXTRA_CHAIN_CODES = { ethereum: "ETH", avalanche: "AVAX", unichain: "UNI" };
export function circleChainCode(chainKey, { chains = TARGET_USDC_CHAINS } = {}) {
  const key = String(chainKey ?? "").trim().toLowerCase();
  if (!key) return null;
  const hit = chains.find((c) => c.key === key);
  if (hit) return hit.circleCode;
  return EXTRA_CHAIN_CODES[key] ?? null;
}

/**
 * On-chain USDC still needed before a deposit of `amount` can move: the
 * shortfall the QR funding flow should request. Rounded up to USDC's 6
 * decimals so the follow-up deposit never comes up a dust-amount short.
 */
export function qrShortfall(amount, onchain) {
  const missing = amount - (onchain ?? 0);
  if (!(missing > 0)) return 0;
  return Math.ceil(missing * 1e6) / 1e6;
}

/**
 * Argv for the Circle CLI's QR funding flow:
 * `circle wallet fund --method crypto --open` prints an EIP-681 QR and opens
 * it in the browser; the user pays from an external wallet, so nothing here
 * signs or moves funds.
 */
export function qrFundArgs({ address, chainCode, amount }) {
  return [
    "wallet", "fund",
    "--address", address,
    "--chain", chainCode,
    "--amount", String(amount),
    "--method", "crypto",
    "--open"
  ];
}

/**
 * Has the deposit landed in the unified balance? Credits can come in slightly
 * under face value (Eco deposits deduct a fee), so reaching `minCreditRatio`
 * of the deposited amount over the pre-deposit baseline counts as credited.
 * A null baseline (the pre-deposit read failed) is treated as 0, so a wallet
 * that already held funds resolves immediately rather than hanging on a
 * target it may never reach — the progress lines still show the live total.
 */
export function depositCredited({ baselineTotal, currentTotal, amount, minCreditRatio = 0.9 }) {
  if (currentTotal == null) return false;
  const base = baselineTotal ?? 0;
  return currentTotal >= base + amount * minCreditRatio - 1e-9;
}

/**
 * Poll the unified Gateway balance until the deposit is credited or the
 * timeout lapses. Reads at least once; `onPoll` fires before every sleep so
 * the caller can render progress. All effects are injectable for tests.
 * Returns { credited, balances, elapsedMs }.
 */
export async function waitForGatewayCredit({
  address,
  amount,
  baselineTotal = null,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  intervalMs = WAIT_POLL_INTERVAL_MS,
  readBalances = gatewayBalancesByChain,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  onPoll = () => {}
} = {}) {
  const started = now();
  for (;;) {
    const balances = await readBalances(address);
    const elapsedMs = now() - started;
    if (depositCredited({ baselineTotal, currentTotal: balances?.total ?? null, amount })) {
      return { credited: true, balances, elapsedMs };
    }
    if (elapsedMs + intervalMs > timeoutMs) {
      return { credited: false, balances, elapsedMs };
    }
    onPoll({ elapsedMs, total: balances?.total ?? null });
    await sleep(intervalMs);
  }
}

/** "$2.50"; sub-cent balances keep 6 decimals so dust never renders as $0.00. */
export function formatUsdc(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "$?";
  return n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`;
}

/** "45s", "1m30s", "15m0s" — for progress lines and timeouts. */
export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

/**
 * Human lines for a `gatewayBalancesByChain()` result, unified-balance first:
 * ONE spendable-anywhere total, per-chain rows demoted to a routing detail,
 * and the explicit "on-chain drop is by design" note — the post-deposit
 * moment is exactly when an agent reads the wallet balance and concludes the
 * funds were lost.
 */
export function unifiedBalanceLines(balances) {
  if (!balances || balances.total == null) {
    return [
      "Unified balance: unreadable right now — the deposit is unaffected. Re-check with `selat doctor` or `circle gateway balance --all`."
    ];
  }
  const lines = [
    `Your unified balance: ${formatUsdc(balances.total)} USDC — one balance, spendable from any supported chain.`
  ];
  const funded = (balances.perChain ?? []).filter((c) => (c.usdc ?? 0) > 0);
  if (funded.length) {
    lines.push(
      fmt.dim(`  held via ${funded.map((c) => `${c.network} ${formatUsdc(c.usdc)}`).join(" · ")} — a routing detail, not a spending restriction.`)
    );
  }
  lines.push(
    fmt.dim("  Your on-chain wallet balance dropping after a deposit is by design: the funds moved into Gateway, they are not lost.")
  );
  return lines;
}

/**
 * Resolve the env a `--chain arc` deposit needs to pass through to setup.mjs.
 *
 * Arc mainnet can't use the Circle agent wallet, so the skill deposits with a
 * raw EOA key + a private RPC: SELAT_PRIVATE_KEY and ARC_RPC_URL. Shell env
 * wins over the selat config .env. Eco (gasless) isn't supported on Arc.
 *
 * Returns `{ ok: true, env }` or `{ ok: false, error, missing? }`. `missing`
 * is only set when the failure is unset credentials (so the caller can print
 * the how-to-fix hint); a rejected method has no `missing`.
 */
export function resolveArcDepositEnv({ method, config = {}, env = process.env } = {}) {
  if (method === "eco") {
    return { ok: false, error: "--method eco is not supported on Arc; use the default (direct)." };
  }
  const privateKey = env.SELAT_PRIVATE_KEY || config.SELAT_PRIVATE_KEY;
  const rpcUrl = env.ARC_RPC_URL || config.ARC_RPC_URL;
  const missing = [];
  if (!privateKey) missing.push("SELAT_PRIVATE_KEY");
  if (!rpcUrl) missing.push("ARC_RPC_URL");
  if (missing.length) {
    return { ok: false, error: `Arc deposits need ${missing.join(" and ")}.`, missing };
  }
  return { ok: true, env: { SELAT_PRIVATE_KEY: privateKey, ARC_RPC_URL: rpcUrl } };
}
