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
import { safeHttpUrl } from "../url-safety.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import {
  getAgentAddress,
  authStatus,
  chainSpendingPolicy,
  describeChainPolicy,
  gatewayBalancesByChain,
  retryNullRead,
  walletUsdcBalance,
  TARGET_USDC_CHAINS
} from "../circle.mjs";
import { readConfig, configPath } from "../config.mjs";
import { sessionSpendLine } from "./budget.mjs";
import { FUND_QR_CHAINS, usdcTransferUri, writeFundQr } from "../qr.mjs";
import {
  createOnrampSession,
  onrampExpiryMinutes,
  onrampSessionLines,
  openInBrowser
} from "../onramp.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

/** Default --wait timeout: deposits typically credit in 5–10 min; allow 15. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
/** How often --wait re-reads the unified balance. */
export const WAIT_POLL_INTERVAL_MS = 15_000;

export const FUND_HELP = `Usage: selat fund [options]

Top up your Circle Gateway balance (deposits USDC from the on-chain wallet into
the unified balance spendable from any supported chain).

Options:
  --amount <usd>    USDC to deposit (default prompt: 2; min 0.5 — Circle
                    CLI's Gateway deposit floor; Arc raw-key deposits exempt)
  --chain <name>    Source chain (default prompt: base)
  --method <m>      direct | eco  (default: direct; eco is gasless from Base —
                    Circle CLI ≥1.0.0's eco source coverage)
  --onramp          Buy USDC with a card instead (Circle Onramp browser widget;
                    you pick the amount in the widget). Mints a session and
                    prints/opens the URL — no deposit, no money moves here.
                    This is SELAT's built-in onramp, NOT Transak (Circle CLI's
                    \`wallet fund --method fiat\`).
  --address <0x>    Onramp destination wallet (default: the configured SELAT
                    wallet). Only valid with --onramp.
  --wait            Poll until the deposit is actually spendable (~5-10 min)
  --by-chain        Show the per-chain balance breakdown
  --yes, --confirm  Skip the deposit confirmation prompt
  --timeout <sec>   Max seconds to wait with --wait
  -h, --help        Show this help. Never prompts, never deposits.

fund moves money — with no --amount/--chain it prompts, and without --yes it
asks you to confirm before depositing. (--onramp is the exception: it only
mints a browser link; the purchase happens in Circle's widget.)`;

export async function fund(args, { interactive = stdinIsInteractive() } = {}) {
  // Help is inert: no skill lookup, no prompts, no deposit flow. Previously
  // `fund --help` fell through and started prompting toward a real deposit —
  // the defect class #101 fixed for setup-policy, one command over.
  if (args.includes("-h") || args.includes("--help")) {
    console.log(FUND_HELP);
    return 0;
  }
  // Fiat onramp is its own path: no skill, no deposit flow, no confirmation
  // phrase — minting the session moves no money (the card purchase happens in
  // Circle's widget, under the user's control). Runs before the skill lookup
  // so `selat fund --onramp` works anywhere the CLI is installed, any time —
  // not just in init's post-provisioning fork. Live Hermes feedback: an agent
  // asked to "use onramp" had no SELAT-native command and fell back to
  // `circle wallet fund --method fiat`, which is Transak — a different onramp.
  if (args.includes("--onramp")) {
    return await onrampFund(args, { interactive });
  }
  if (args.includes("--address")) {
    console.error(fmt.error("--address is only valid with --onramp (deposits always move the configured wallet's own USDC)"));
    return 1;
  }
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
  // A present-but-valueless --method must not silently become "direct": the
  // user typed the flag intending gasless/eco, and with --yes there is no
  // confirm screen to catch a gas-requiring direct deposit.
  const methodRaw = arg(args, "--method");
  if (args.includes("--method") && (methodRaw == null || methodRaw.startsWith("--"))) {
    console.error(fmt.error("--method requires a value (direct or eco)"));
    return 1;
  }
  const method = parseMethod(methodRaw || "direct");
  if (!method.ok) {
    console.error(fmt.error(method.reason));
    return 1;
  }

  const amount = Number(amountArg);
  // Arc deposits bypass the Circle CLI (raw-key path), so only the
  // positive-number rule applies there; every other chain inherits the CLI's
  // 0.5 USDC floor — checked here so it fails before prompts and plans, not
  // as a raw CLI error mid-flow.
  const isArc = chainArg.toLowerCase() === "arc";
  const amountError = depositAmountError(amount, { isArc });
  if (amountError) {
    console.error(fmt.error(amountError));
    return 1;
  }

  const wait = args.includes("--wait");
  // Per-chain Gateway rows confuse more than they inform (live onboarding
  // feedback): default output is ONE number; --by-chain opts into the rows.
  const byChain = args.includes("--by-chain");
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
    if (chainCode && onchain == null) {
      // Read failed (null ≠ empty): don't block the deposit, but don't
      // degrade silently either — if the wallet really is empty the deposit
      // hits the opaque downstream error this check exists to pre-empt.
      console.log(fmt.dim(
        `couldn't verify the wallet's on-chain USDC on ${chainArg} (balance read failed) — proceeding; the deposit will fail if the wallet doesn't hold ${formatUsdc(amount)}.`
      ));
    }
    if (chainCode && onchain != null && onchain < amount) {
      const shortfall = qrShortfall(amount, onchain);
      const qrArgs = qrFundArgs({ address: walletAddr, chainCode, amount: shortfall });
      const qrCommand = `${CIRCLE_BIN} ${qrArgs.join(" ")}`;
      console.log("");
      console.log(fmt.warn(`wallet holds ${formatUsdc(onchain)} USDC on-chain on ${chainArg} — the ${formatUsdc(amount)} deposit needs ${formatUsdc(shortfall)} more.`));
      console.log("");
      for (const line of fundingStageLines({ shortfall })) console.log(line);
      console.log("");
      // Primary Step-1 output: the address + payment details + a QR image the
      // agent can send straight into a chat. The Circle CLI's browser QR
      // below stays for browser users, but its /tmp/*.html page is useless in
      // chat harnesses (live Hermes test: the agent had to improvise
      // rendering it to an image before the user could scan anything).
      const uri = usdcTransferUri({ chainKey: chainArg, address: walletAddr, amountUsdc: shortfall });
      for (const line of fundingDetailLines({ address: walletAddr, chainKey: chainArg, shortfall, uri })) {
        console.log(line);
      }
      if (uri) {
        try {
          const qrPath = writeFundQr({ chainKey: chainArg, uri });
          console.log("");
          console.log(fmt.cyan(`QR image: ${qrPath}`) + " " + fmt.dim("— agents: in chat harnesses, send this image to the user; it's scannable by any wallet app."));
        } catch {
          console.log(fmt.dim("(couldn't write a QR image — the address and payment URI above are enough to pay manually.)"));
        }
      }
      console.log("");
      if (interactive) {
        const openQr = await promptYesNo(
          `Open a funding QR in your browser (EIP-681 — pay ${formatUsdc(shortfall)} USDC from any external wallet)?`,
          { default: true }
        );
        if (openQr) {
          const r = await sh(CIRCLE_BIN, qrArgs, { inherit: true });
          if (r.code !== 0) return r.code;
          console.log("");
          console.log(fmt.dim("That's Step 1. Once the transfer lands on-chain, re-run this `selat fund` command (Step 2) to deposit into Gateway."));
          return 0;
        }
        console.log(fmt.dim(`Fund the wallet later with: ${qrCommand}`));
        return 1;
      }
      console.error(fmt.error("not enough on-chain USDC to deposit yet."));
      console.error(fmt.dim("Step 1 first — get USDC to the wallet address (browser QR, pay from any external wallet):"));
      console.error(fmt.cyan(`  ${qrCommand}`));
      console.error(fmt.dim(`Then Step 2 — re-run: selat fund --amount ${amount}`));
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
  // Surface the spending policy that governs THIS deposit at the money
  // moment. Circle enforces the SOURCE chain's per-(wallet, chain) policy —
  // including for ERC-3009 typed-data signing — so the plan must show the
  // deposit chain's policy, not a chain-free summary (verified live
  // 2026-08-11: a $5.19 deposit on ARB was governed by ARB's $100/mo
  // DEFAULT while the user's $5/tx caps lived on BASE only). Best-effort
  // read; never blocks the deposit.
  const policy = await chainSpendingPolicy(walletAddr, circleChainCode(chainArg));

  console.log("");
  console.log(fmt.dim("Plan:"));
  console.log(`  method  ${methodLabel}`);
  console.log(`  chain   ${chainArg}`);
  console.log(`  amount  ${amount} USDC`);
  // Fee + route disclosure at CONFIRM time — the live Hermes test saw the
  // eco routing fee (and the Polygon settlement) surface for the first time
  // AFTER the money moved. Both belong in the plan the user says yes to.
  for (const line of methodPlanLines({ method: method.value, chainKey: chainArg, amount })) {
    console.log(line);
  }
  if (wait) console.log(`  wait    until credited (timeout ${formatElapsed(timeout.ms)})`);
  console.log(`  policy  ${policyPlanLine({ chainKey: chainArg, policy })}`);
  // When a session budget is armed, show the running total at the money moment.
  const spendLine = sessionSpendLine();
  if (spendLine) console.log(`  ${spendLine.replace("session:", "session")}`);
  console.log("");
  if (policy.readable && policy.origin !== "CUSTOM") {
    console.log(fmt.warn(
      amount > 20
        ? `no custom spending caps govern ${chainArg} — strongly recommended before deposits over $20`
        : `no custom spending caps govern ${chainArg} — spending from this chain is limited only by Circle's default`
    ));
    console.log(fmt.dim("  caps are per-chain; set the hard ceiling on every chain: selat setup-policy"));
    console.log("");
  }

  // The prompt names the net for eco so the fee is part of the yes/no, not a
  // post-settlement surprise.
  const proceedQuestion = method.value === "eco"
    ? `Proceed with Eco gasless deposit of ${amount} USDC on ${chainArg} (≈${formatUsdc(estimatedEcoNet(amount, chainArg))} credited after the ~${formatUsdc(ecoFeeEstimate(chainArg))} fixed Eco fee)?`
    : `Proceed with direct deposit of ${amount} USDC on ${chainArg} (no routing fee)?`;
  let confirmed = inputs.confirmed;
  if (confirmed) {
    console.log(fmt.dim(`--yes: proceeding with ${methodLabel} deposit of ${amount} USDC on ${chainArg}.`));
  } else {
    confirmed = await promptYesNo(proceedQuestion, { default: false });
  }
  if (!confirmed) {
    console.log(fmt.dim("aborted"));
    return 0;
  }

  // Snapshot the unified balance BEFORE the deposit so --wait can tell a
  // fresh credit apart from funds that were already there. Retry a failed
  // read — no money has moved yet, and without this baseline --wait cannot
  // verify the credit (it degrades to the unverified wording below).
  const before = walletAddr ? await retryNullRead(() => gatewayBalancesByChain(walletAddr)) : null;

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
    for (const line of unifiedBalanceLines(balancesNow, { byChain })) console.log(line);
    if (method.value === "eco") {
      console.log(fmt.dim(`  Eco's fixed fee applies — expect ≈${formatUsdc(estimatedEcoNet(amount, chainArg))} of the ${formatUsdc(amount)} to be credited.`));
    }
    console.log(fmt.dim("Deposits typically become spendable in 5–10 minutes — this success is the submission, not the credit. Use `selat fund --wait` to block until it's spendable."));
    if (method.value === "eco") await ecoPolygonPolicyNudge(walletAddr);
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
      console.log(fmt.dim(`  … Gateway balance ${current} — waiting for the ${formatUsdc(amount)} credit (${formatElapsed(elapsedMs)} elapsed, timeout ${formatElapsed(timeout.ms)})`));
    }
  });

  if (result.credited) {
    if (result.verified) {
      console.log(fmt.ok(`credited after ${formatElapsed(result.elapsedMs)}`));
    } else {
      // Null baseline: the balance covers the deposit, but pre-existing funds
      // satisfy that too — claiming "credited after 0s" on a pre-funded wallet
      // reported the OLD balance as the new credit.
      console.log(fmt.warn(
        `Gateway shows ${formatUsdc(result.balances?.total)} — the pre-deposit balance read failed, so the ${formatUsdc(amount)} credit can't be told apart from funds already present.`
      ));
      console.log(fmt.dim("  Deposits typically become spendable in 5–10 minutes; re-check with `selat doctor`."));
    }
    // Reconcile deposited vs credited so a routing fee reads as a fee, not
    // as missing money.
    const reconcile = depositReconcileLine({
      method: method.value,
      amount,
      baselineTotal: before?.total ?? null,
      currentTotal: result.balances?.total ?? null
    });
    if (reconcile) console.log(reconcile);
    for (const line of unifiedBalanceLines(result.balances, { byChain })) console.log(line);
    if (method.value === "eco") await ecoPolygonPolicyNudge(walletAddr);
    return 0;
  }
  console.error(fmt.warn(`deposit not credited after ${formatElapsed(result.elapsedMs)} — it is usually still settling, not lost.`));
  for (const line of unifiedBalanceLines(result.balances, { byChain })) console.error(line);
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
 * Circle CLI ≥1.0.0 refuses `gateway deposit` below 0.5 USDC (any method,
 * any chain). Mirrored here so the refusal happens before the confirm flow
 * with SELAT wording. Arc raw-key deposits don't go through the CLI and are
 * exempt. Pure; returns an error string or null.
 */
export const MIN_GATEWAY_DEPOSIT_USDC = 0.5;
export function depositAmountError(amount, { isArc = false } = {}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "--amount must be a positive number";
  }
  if (!isArc && amount < MIN_GATEWAY_DEPOSIT_USDC) {
    return (
      `Circle CLI enforces a ${MIN_GATEWAY_DEPOSIT_USDC} USDC minimum for Gateway deposits — ` +
      `${amount} USDC is below the floor. Re-run with --amount ${MIN_GATEWAY_DEPOSIT_USDC} or more.`
    );
  }
  return null;
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
 * After an Eco deposit, the credited balance lives in Gateway on Polygon and
 * future spends authorize there — so POLYGON's per-(wallet, chain) policy is
 * what caps them, NOT the Base/OP/Arb source chain we just deposited from
 * (Circle enforces the source chain of each transfer, incl. ERC-3009 signing;
 * verified live 2026-08-11). The pre-deposit warning names the source chain
 * (correct for the deposit's own signing) and so can't close this loop — hence
 * a completion nudge pointed at Polygon. Best-effort: the policy read never
 * blocks and never throws; skip the nudge only when Polygon is already capped.
 */
// Pure line-builder (exported for tests). Returns [] when Polygon already
// carries a custom policy (no nudge), else a two-line nudge whose second line
// reflects whether Polygon's policy read as an uncapped default or was
// unreadable.
export function ecoPolygonPolicyNudgeLines(polygonPolicy) {
  const pol = polygonPolicy;
  if (pol && pol.readable && pol.origin === "CUSTOM") return [];
  const state = pol && pol.readable
    ? "Polygon has no custom cap; Circle's default governs."
    : "Couldn't read Polygon's policy — confirm it's capped.";
  return [
    "This balance settles into Gateway on Polygon — spends from it are capped by " +
      "Polygon's spending policy, not the source chain you deposited from.",
    `${state} Set the ceiling: selat setup-policy   (caps every chain, incl. Polygon)`,
  ];
}

async function ecoPolygonPolicyNudge(walletAddr) {
  if (!walletAddr) return;
  const pol = await chainSpendingPolicy(walletAddr, circleChainCode("polygon")).catch(() => null);
  const [warnLine, hintLine] = ecoPolygonPolicyNudgeLines(pol);
  if (!warnLine) return;
  console.log("");
  console.log(fmt.warn(warnLine));
  console.log(fmt.dim(`  ${hintLine}`));
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
 * The plan's spending-policy line: the policy governing the DEPOSIT chain,
 * named as such. Circle enforces per-(wallet, chain) policies by source
 * chain, so a chain-free "capped at …" here would claim coverage the deposit
 * chain may not have. Pure and exported for tests.
 */
export function policyPlanLine({ chainKey, policy }) {
  return `on ${chainKey}: ${describeChainPolicy(policy)}`;
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
 * target it may never reach — but that resolution is then indistinguishable
 * from pre-existing funds, so callers MUST NOT present it as a confirmed
 * credit: waitForGatewayCredit surfaces this as `verified: false` and the
 * fund command words it as "can't be told apart from funds already present".
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
 * Returns { credited, verified, balances, elapsedMs }; `verified` is false
 * when the pre-deposit baseline was unreadable — a `credited` result then
 * only means "the balance covers the deposit", which pre-existing funds also
 * satisfy, so callers must word it as unconfirmed.
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
  const verified = baselineTotal != null;
  for (;;) {
    const balances = await readBalances(address);
    const elapsedMs = now() - started;
    if (depositCredited({ baselineTotal, currentTotal: balances?.total ?? null, amount })) {
      return { credited: true, verified, balances, elapsedMs };
    }
    if (elapsedMs + intervalMs > timeoutMs) {
      return { credited: false, verified, balances, elapsedMs };
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
 * Human lines for a `gatewayBalancesByChain()` result: ONE figure, no chain
 * enumeration. Live onboarding showed that listing per-chain rows makes users
 * (and agents) believe the balance is split into per-chain buckets — it isn't;
 * Gateway is one balance. The per-chain routing detail stays available behind
 * `--by-chain` only. The "on-chain drop is by design" note stays: the
 * post-deposit moment is exactly when an agent reads the wallet balance and
 * concludes the funds were lost.
 */
export function unifiedBalanceLines(balances, { byChain = false } = {}) {
  if (!balances || balances.total == null) {
    return [
      "Gateway balance: unreadable right now — the deposit is unaffected. Re-check with `selat doctor` or `circle gateway balance --all`."
    ];
  }
  const lines = [
    `Gateway balance: ${formatUsdc(balances.total)} USDC — spendable on any supported chain.`
  ];
  if (byChain) {
    const funded = (balances.perChain ?? []).filter((c) => (c.usdc ?? 0) > 0);
    if (funded.length) {
      lines.push(
        fmt.dim(`  held via ${funded.map((c) => `${c.network} ${formatUsdc(c.usdc)}`).join(" · ")} — a routing detail, not a spending restriction.`)
      );
    }
  }
  lines.push(
    fmt.dim("  Your on-chain wallet balance dropping after a deposit is by design: the funds moved into Gateway, they are not lost.")
  );
  return lines;
}

/**
 * Stage framing for the funding flow, printed when the wallet address holds
 * no (or not enough) on-chain USDC. Live onboarding showed users read the
 * empty-wallet refusal as "the fund command is broken" — it must instead say
 * which of the two movements they are on: (1) get USDC to the agent wallet
 * address, (2) re-run `selat fund` to deposit it into Gateway.
 */
export function fundingStageLines({ shortfall } = {}) {
  const need = shortfall != null ? `${formatUsdc(shortfall)} USDC` : "USDC";
  return [
    fmt.bold("Funding happens in two steps:"),
    `  Step 1 of 2 — get ${need} to your agent wallet address (QR / manual details below).`,
    `  Step 2 of 2 — re-run \`selat fund\` to deposit it into Gateway; it becomes one spendable Gateway balance.`
  ];
}

/**
 * Eco Fast Deposits (v2) fee — MEASURED, not quoted. Neither Eco's docs, the
 * Circle CLI, nor the v2 API discloses a fee or offers a quote surface, so
 * these are estimates from live deposits, rendered with "~"/"≈" and never as
 * an exact promise. The measured shape is a FIXED fee per deposit that
 * varies by source chain, with no meaningful percentage component:
 *   base      $0.50    → fee $0.055300   (2026-08-05, MetaMask-side run)
 *   optimism  $2.10    → fee $0.055476   (2026-08-11, job 6a7a9e40…)
 *   arbitrum  $5.194162 → fee $0.095761  (2026-08-11, job 6a7a8ffa…)
 * base and optimism charged near-identical fees at 4× different amounts, so
 * an earlier percentage model (and the pre-v2 "$0.03 + 1.3bp" schedule of
 * Eco's retired v1 pipeline) is wrong for this path. Estimates are rounded
 * UP from the measurements so the disclosed net never overpromises; a fixed
 * fee weighs heavier on small deposits (~11% at $0.50, ~1% at $5+). Eco
 * applies the fee server-side, so it can change without notice.
 * Base is the only reachable eco source now that the skill delegates to
 * Circle CLI ≥1.0.0 (its --method eco covers BASE only); the optimism and
 * arbitrum rows stay as measured history and as the basis for the default.
 * Direct deposits credit at face value (on-chain deposit into the Gateway
 * Wallet contract; gas is paid separately in the source chain's native token).
 */
export const ECO_FEE_ESTIMATE_BY_CHAIN = { base: 0.06, optimism: 0.06, arbitrum: 0.1 };
/** Unmeasured source chains assume the worst measured fee. */
export const ECO_FEE_ESTIMATE_DEFAULT = 0.1;

/** Conservative (rounded-up) fee estimate for an eco deposit from `chainKey`. */
export function ecoFeeEstimate(chainKey) {
  const key = String(chainKey ?? "").trim().toLowerCase();
  return ECO_FEE_ESTIMATE_BY_CHAIN[key] ?? ECO_FEE_ESTIMATE_DEFAULT;
}

/** Estimated NET credited for an eco deposit from `chainKey`, floored to a
 *  cent so the disclosure never overpromises. */
export function estimatedEcoNet(amount, chainKey) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.floor((n - ecoFeeEstimate(chainKey)) * 100 + 1e-9) / 100);
}

/**
 * Fee/route plan lines for the confirm block — the fee and the settlement
 * destination must be part of the plan the user says yes to, not a
 * post-settlement discovery (live Hermes incident: a 2 USDC deposit landed
 * as 1.97 on Polygon with the fee first visible AFTER settlement).
 */
export function methodPlanLines({ method, chainKey, amount }) {
  if (method === "eco") {
    return [
      `  route   ${chainKey} → settles into Gateway on Polygon`,
      `  fee     ~${formatUsdc(ecoFeeEstimate(chainKey))} fixed Eco fee from ${chainKey} (measured, not quotable pre-deposit; weighs heavier on small deposits)`,
      `  net     you'll receive ≈${formatUsdc(estimatedEcoNet(amount, chainKey))} in Gateway`
    ];
  }
  return [
    `  fee     none — direct deposits credit at face value (gas paid separately in native ${chainKey} gas)`
  ];
}

/**
 * One line reconciling deposited vs credited once --wait sees the credit, so
 * an eco routing fee reads as a fee — not as lost money. Returns null when
 * the delta can't be measured (unreadable totals or no pre-deposit baseline).
 */
export function depositReconcileLine({ method, amount, baselineTotal, currentTotal }) {
  if (baselineTotal == null || currentTotal == null) return null;
  const credited = currentTotal - baselineTotal;
  if (!(credited > 0)) return null;
  if (amount - credited > 0.000001) {
    const feeLabel = method === "eco" ? "eco fee" : "settlement shortfall";
    return `deposited ${formatUsdc(amount)}, credited ${formatUsdc(credited)} (${feeLabel} ${formatUsdc(amount - credited)})`;
  }
  return `deposited ${formatUsdc(amount)}, credited in full (${formatUsdc(credited)})`;
}

/**
 * The Step-1 payment details: address, network, token, amount, and the raw
 * EIP-681 URI (so any agent can render its own QR when it can't send the PNG).
 * Pure and exported for tests. A null `uri` (unknown chain / bad amount)
 * degrades to address-only details rather than printing a wrong URI.
 */
export function fundingDetailLines({ address, chainKey, shortfall, uri, chains = FUND_QR_CHAINS } = {}) {
  const key = String(chainKey ?? "").trim().toLowerCase();
  const chain = chains.find((c) => c.key === key);
  const network = chain ? `${chainKey} (chain id ${chain.id})` : String(chainKey ?? "unknown");
  const lines = [
    `  Address  ${address}   ${fmt.dim("(your agent wallet — send USDC here)")}`,
    `  Network  ${network}`,
    `  Token    USDC`,
    `  Amount   ${formatUsdc(shortfall)} USDC`
  ];
  if (uri) lines.push(`  URI      ${uri}`);
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
  // The raw key signs a real transfer against whatever this RPC says the chain
  // state is, so a plaintext or non-http(s) endpoint is refused: an attacker on
  // the path could feed the deposit a forged nonce/receipt or observe it.
  if (!safeHttpUrl(rpcUrl)) {
    return {
      ok: false,
      error: `ARC_RPC_URL "${rpcUrl}" must be an https:// URL (http:// is allowed only for localhost).`
    };
  }
  return { ok: true, env: { SELAT_PRIVATE_KEY: privateKey, ARC_RPC_URL: rpcUrl } };
}

/**
 * Resolve the onramp destination wallet: --address <0x…> when given (any agent
 * wallet — live Hermes feedback: users fund wallet #1 while wallet #3 is the
 * configured payer), else the configured SELAT wallet. Pure; exported for tests.
 */
export function resolveOnrampTarget({ args, configuredAddr = null }) {
  const raw = arg(args, "--address");
  if (args.includes("--address") && (raw == null || raw.startsWith("--"))) {
    return { ok: false, error: "--address requires a 0x wallet address" };
  }
  if (raw != null) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) {
      return { ok: false, error: `--address ${raw} is not a valid 0x wallet address` };
    }
    return { ok: true, address: raw };
  }
  if (configuredAddr) return { ok: true, address: configuredAddr };
  return { ok: false, error: "no wallet address — run `selat init` first, or pass --address 0x…" };
}

/**
 * `selat fund --onramp` — fiat Step 1: mint a chain-scoped Circle Onramp
 * session for the target wallet and print (interactive: offer to open) the
 * browser widget URL. The amount is chosen inside the widget, so this path
 * never prompts for one and never needs the deposit confirmation phrase —
 * nothing here signs or moves money. Non-TTY shells print the URL for the
 * agent to relay into chat.
 */
async function onrampFund(args, { interactive }) {
  const configured = await getAgentAddress().catch(() => null);
  const target = resolveOnrampTarget({ args, configuredAddr: configured });
  if (!target.ok) {
    console.error(fmt.error(target.error));
    return 1;
  }
  console.log(fmt.dim(`▸ Circle Onramp (card → USDC) for wallet ${target.address}`));
  if (configured && target.address.toLowerCase() !== configured.toLowerCase()) {
    console.log(fmt.warn(`this is not the configured SELAT wallet (${configured}) — paid calls spend from the configured wallet.`));
  }
  let session;
  try {
    session = await createOnrampSession({ address: target.address, userId: "selat-fund" });
  } catch (e) {
    console.error(fmt.error(`Circle Onramp unavailable: ${e.message}`));
    console.error(fmt.dim("Crypto funding still works: selat fund --amount 2"));
    return 1;
  }
  // Best-effort email lookup so the KYC note can name the exact address the
  // user must reuse; a failed read still prints the generic note.
  const auth = await authStatus().catch(() => ({}));
  const lines = onrampSessionLines({
    widgetUrl: session.widgetUrl,
    minutesLeft: onrampExpiryMinutes(session.expiresAt),
    walletEmail: auth.email ?? null
  });
  console.log(fmt.cyan(lines[0]));
  console.log(fmt.cyan(lines[1]));
  console.log(fmt.dim(lines[2]));
  console.log(fmt.warn(lines[3]));
  if (interactive) {
    const open = await promptYesNo("Open it in your browser now?", { default: true });
    if (open && (await openInBrowser(session.widgetUrl))) {
      console.log(fmt.ok("opened in your browser"));
    }
  }
  return 0;
}
