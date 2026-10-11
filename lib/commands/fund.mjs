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
  authStatus,
  chainSpendingPolicy,
  describeChainPolicy,
  gatewayBalancesByChain,
  GATEWAY_BALANCE_KEY_PREFIX,
  retryNullRead,
  walletUsdcBalance,
  TARGET_USDC_CHAINS
} from "../circle.mjs";
import { invalidateCircleCache } from "../circle-cache.mjs";
import { sessionSpendLine } from "./budget.mjs";
import { frozenMoneyMove } from "./freeze.mjs";
import { FUND_QR_CHAINS, usdcTransferUri, writeFundQr } from "../qr.mjs";
import {
  createOnrampSession,
  onrampExpiryMinutes,
  onrampSessionLines,
  openInBrowser
} from "../onramp.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

/**
 * Every Gateway read in this command is the deposit-credit proof (baseline,
 * post-deposit figure, --wait polling), so it bypasses the balance cache.
 */
const liveGatewayBalances = (address) => gatewayBalancesByChain(address, "BASE", { cache: false });

/** Default --wait timeout: deposits typically credit in 5–10 min; allow 15. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
/** How often --wait re-reads the unified balance. */
export const WAIT_POLL_INTERVAL_MS = 15_000;

export const FUND_HELP = `Usage: selat fund [options]

Top up your Circle Gateway balance (deposits USDC from the on-chain wallet into
the unified balance spendable from any supported chain).

Options:
  --amount <usd>    USDC to deposit (default prompt: 2; min 0.5 — Circle
                    CLI's Gateway deposit floor)
  --chain <name>    Source chain (default: arc for direct — USDC is Arc's gas
                    token; base for eco, which can't source from Arc)
  --method <m>      direct | eco  (default: direct; both are gasless — eco is
                    Eco Fast Deposits from Base, Arbitrum or Optimism: ~$0.03
                    fixed fee, settles into Gateway on Arc in about a minute)
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
mints a browser link; the purchase happens in Circle's widget.)
\`selat freeze\` is a local kill switch: this command refuses while frozen.`;

/** Exact `-h` / `--help` argv tokens only. Empty argv is the deposit flow, not usage. */
function wantsFundHelp(args) {
  if (!Array.isArray(args)) return false;
  return args.some((a) => a === "-h" || a === "--help");
}

export async function fund(args, { interactive = stdinIsInteractive() } = {}) {
  // Help is inert: no skill lookup, no prompts, no deposit flow. Previously
  // `fund --help` fell through and started prompting toward a real deposit —
  // the defect class #101 fixed for setup-policy, one command over.
  // Bare `selat fund` (no tokens) must still enter the deposit flow — a
  // `!args.length` (or substring) match here would swallow it and print Usage.
  if (wantsFundHelp(args)) {
    console.log(FUND_HELP);
    return 0;
  }
  // Local kill switch: freeze refuses every fund path (Gateway deposit,
  // --onramp session, empty-wallet QR) before any money-adjacent work.
  // Help above stays inert so `selat fund --help` still works while frozen.
  const frozen = frozenMoneyMove("fund");
  if (frozen) {
    console.error(fmt.error(frozen.error));
    console.error(fmt.dim(frozen.hint));
    return 1;
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

  // A present-but-valueless --method must not silently become "direct": the
  // user typed the flag intending an eco fast deposit (fixed fee, lands on
  // Arc), and with --yes there is no confirm screen to catch the
  // silently-different direct deposit (source-chain landing, slower credit).
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

  // Parsed before the chain so the default chain follows the method: Arc for
  // direct deposits, Base for eco (Arc isn't an eco source).
  const inputs = resolveFundInputs({ args, interactive, method: method.value });
  if (!inputs.ok) {
    console.error(fmt.error(inputs.error));
    return 1;
  }
  const chainArg = inputs.chain || (await prompt("Chain", { default: defaultFundChain(method.value) }));
  const amountArg = inputs.amount || (await prompt("USDC to deposit", { default: "2" }));

  const amount = Number(amountArg);
  // Every chain inherits the Circle CLI's 0.5 USDC floor — checked here so it
  // fails before prompts and plans, not as a raw CLI error mid-flow.
  const amountError = depositAmountError(amount);
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

  // Resolve the payer wallet once: the spending-policy line, the empty-wallet
  // check, the pre-deposit baseline, and the post-deposit unified-balance
  // read all key off it. Every chain — Arc included since Circle CLI 1.1.1 —
  // deposits from this agent wallet; there is no local-key path.
  const walletAddr = await getAgentAddress().catch(() => null);

  // Empty-wallet branch: a Gateway deposit needs on-chain USDC to move. If
  // the wallet doesn't hold enough on the deposit chain, the skill's deposit
  // would only fail later with an opaque error — offer the Circle CLI's QR
  // funding flow (EIP-681; the user pays from an external wallet, nothing is
  // signed here) instead. Skipped when the balance can't be read (never block
  // on a read failure).
  if (walletAddr) {
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
  const methodLabel = method.value === "eco" ? "Eco fast" : "direct";
  if (method.value === "eco") {
    // The skill's `eco-deposit` is the source of truth for supported source
    // chains and settles into Gateway on Arc; it rejects unsupported chains
    // during the dry-run below. We don't duplicate the allowlist here.
    console.log(fmt.dim("▸ Eco fast deposit (faster credit for a small fixed fee — every deposit method is gasless); settles into Gateway on Arc — a routing detail: your unified balance is spendable from any supported chain."));
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
  // eco routing fee (and the settlement chain) surface for the first time
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
    ? `Proceed with Eco fast deposit of ${amount} USDC on ${chainArg} (≈${formatUsdc(estimatedEcoNet(amount, chainArg))} credited after the ~${formatUsdc(ecoFeeEstimate(chainArg))} fixed Eco fee)?`
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
  const before = walletAddr ? await retryNullRead(() => liveGatewayBalances(walletAddr)) : null;

  // The confirm phrase is required for mainnet deposits and ignored on
  // testnet chains; it matches the skill's expectedDepositConfirmation().
  const phrase = `deposit ${amount} USDC`;
  // Drop the cached balance BEFORE depositing, not after: a deposit can
  // broadcast and still exit non-zero (a confirmation timeout), and that path
  // would otherwise keep serving the pre-deposit figure until the TTL. A
  // deposit raises the balance, so unlike a payment it cannot be accounted for
  // conservatively — only a fresh read is safe.
  invalidateCircleCache(GATEWAY_BALANCE_KEY_PREFIX);
  const depositCode = (await sh(
    "node",
    [
      join(skill.path, "scripts", "setup.mjs"),
      skillCommand,
      "--chain", chainArg,
      "--amount", String(amount),
      "--confirm", phrase
    ],
    { inherit: true }
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
    const balancesNow = await liveGatewayBalances(walletAddr);
    for (const line of unifiedBalanceLines(balancesNow, { byChain })) console.log(line);
    if (method.value === "eco") {
      console.log(fmt.dim(`  Eco's fixed fee applies — expect ≈${formatUsdc(estimatedEcoNet(amount, chainArg))} of the ${formatUsdc(amount)} to be credited.`));
    }
    console.log(fmt.dim("Deposits typically become spendable in 5–10 minutes — this success is the submission, not the credit. Use `selat fund --wait` to block until it's spendable."));
    if (method.value === "eco") await ecoSettlementPolicyNudge(walletAddr);
    return 0;
  }

  console.log(fmt.dim("▸ Waiting for the Gateway credit (deposits typically take 5–10 minutes to become spendable)…"));
  const result = await waitForGatewayCredit({
    address: walletAddr,
    amount,
    baselineTotal: before?.total ?? null,
    timeoutMs: timeout.ms,
    intervalMs: WAIT_POLL_INTERVAL_MS,
    readBalances: liveGatewayBalances,
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
    if (method.value === "eco") await ecoSettlementPolicyNudge(walletAddr);
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
export function resolveFundInputs({ args, interactive, method = "direct" }) {
  const chain = arg(args, "--chain");
  const amount = arg(args, "--amount");
  const yes = args.includes("--yes") || args.includes("-y");
  if (interactive) return { ok: true, chain, amount, confirmed: yes || null };
  if (!amount) {
    return { ok: false, error: "no TTY to prompt for the deposit amount — re-run with --amount <usdc> (and --yes to confirm the deposit)" };
  }
  if (!yes) {
    return { ok: false, error: `a deposit needs explicit confirmation and this shell has no TTY — re-run with --yes to deposit ${amount} USDC on ${chain || defaultFundChain(method)}` };
  }
  return { ok: true, chain: chain || defaultFundChain(method), amount, confirmed: true };
}

/**
 * Default `--chain` for a deposit. Direct deposits lead with Arc: eco deposits
 * settle there, USDC is Arc's gas token, and for Circle Agent Wallets the
 * deposit gas was sponsored (2026-10-11: a $0.728922 direct deposit credited in
 * full and left the wallet at exactly $0). Eco can't source from Arc, so eco
 * keeps Base. Mirrors selat-discovery's PREFERRED_DEPOSIT_KEYS. Pure; exported
 * for tests.
 */
export function defaultFundChain(method = "direct") {
  return method === "eco" ? "base" : "arc";
}

function parseMethod(method) {
  if (method === "direct" || method === "eco") return { ok: true, value: method };
  return { ok: false, reason: "--method must be `direct` or `eco`" };
}

/**
 * Circle CLI ≥1.0.0 refuses `gateway deposit` below 0.5 USDC (any method,
 * any chain). Mirrored here so the refusal happens before the confirm flow
 * with SELAT wording. Pure; returns an error string or null.
 */
export const MIN_GATEWAY_DEPOSIT_USDC = 0.5;
export function depositAmountError(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return "--amount must be a positive number";
  }
  if (amount < MIN_GATEWAY_DEPOSIT_USDC) {
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
 * Where Circle CLI eco deposits settle on mainnet: Gateway on Arc (domain 26).
 * Eco decides this server-side; the Circle CLI (≥1.1.x) labels it Arc and three
 * live deposits on 2026-10-11 (from Base, Arbitrum, Optimism) all credited Arc.
 * Before Circle CLI 1.1.x eco settled on Polygon — older balances still sit there.
 */
export const ECO_SETTLEMENT_CHAIN = { key: "arc", label: "Arc" };

/**
 * After an Eco deposit, the credited balance lives in Gateway on the eco
 * settlement chain (Arc) and future spends authorize there — so THAT chain's
 * per-(wallet, chain) policy is what caps them, NOT the Base source chain we
 * just deposited from (Circle enforces the source chain of each transfer, incl.
 * ERC-3009 signing; verified live 2026-08-11). The pre-deposit warning names
 * the source chain (correct for the deposit's own signing) and so can't close
 * this loop — hence a completion nudge pointed at the settlement chain.
 * Best-effort: the policy read never blocks and never throws; skip the nudge
 * only when the settlement chain is already capped.
 */
// Pure line-builder (exported for tests). Returns [] when the settlement chain
// already carries a custom policy (no nudge), else a two-line nudge whose
// second line reflects whether its policy read as an uncapped default or was
// unreadable.
export function ecoSettlementPolicyNudgeLines(policy, label = ECO_SETTLEMENT_CHAIN.label) {
  const pol = policy;
  if (pol && pol.readable && pol.origin === "CUSTOM") return [];
  const state = pol && pol.readable
    ? `${label} has no custom cap; Circle's default governs.`
    : `Couldn't read ${label}'s policy — confirm it's capped.`;
  return [
    `This balance settles into Gateway on ${label} — spends from it are capped by ` +
      `${label}'s spending policy, not the source chain you deposited from.`,
    `${state} Set the ceiling: selat setup-policy   (caps every chain, incl. ${label})`,
  ];
}

async function ecoSettlementPolicyNudge(walletAddr) {
  if (!walletAddr) return;
  const pol = await chainSpendingPolicy(walletAddr, circleChainCode(ECO_SETTLEMENT_CHAIN.key)).catch(() => null);
  const [warnLine, hintLine] = ecoSettlementPolicyNudgeLines(pol);
  if (!warnLine) return;
  console.log("");
  console.log(fmt.warn(warnLine));
  console.log(fmt.dim(`  ${hintLine}`));
}

/**
 * Map a selat chain key ("base", "polygon", …) to the Circle CLI --chain code
 * ("BASE", "MATIC", …). Extends TARGET_USDC_CHAINS with the other Gateway EVM
 * mainnets the Circle CLI knows (Arc mainnet since CLI 1.1.1). Returns null
 * for chains the Circle CLI can't address, so callers skip Circle-CLI-only
 * branches.
 */
const EXTRA_CHAIN_CODES = { ethereum: "ETH", avalanche: "AVAX", unichain: "UNI", arc: "ARC" };
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
  readBalances = liveGatewayBalances,
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
 * Eco Fast Deposits fee — MEASURED, not quoted pre-deposit. The Circle CLI
 * shows no fee before funding the vault; Eco's vault-status API itemizes it
 * afterwards (GET api.eco.com/circle-gateway/v2/depositAddresses/<vault>
 * ?sourceChainId=N → fees[]). Live Circle CLI eco deposits on 2026-10-11, all
 * crediting Gateway on Arc:
 *   base      $0.65 → fee $0.030081  ($0.030000 protocol + $0.000081 CCTP)
 *   arbitrum  $0.70 → fee $0.030094  ($0.030000 protocol + $0.000094 CCTP)
 *   optimism  $0.70 → fee $0.030088  ($0.030000 protocol + $0.000088 CCTP)
 * So the fee is a flat $0.03 Eco protocol fee plus Circle's CCTP fast-transfer
 * fee (≈1.3bp), the same on every source chain. Superseded: the August
 * estimates ($0.06 base/optimism, $0.10 arbitrum) measured an earlier Eco
 * route that settled on Polygon. Estimates are rounded UP one cent so the
 * disclosed net never overpromises; a fixed fee weighs heavier on small
 * deposits (~8% at $0.50, ~1% at $4+). Eco applies the fee server-side, so it
 * can change without notice.
 * Source chains: the Circle CLI (≥1.1.x) accepts BASE, ARB and OP for
 * `--method eco`; `selat fund` delegates to the selat-discovery skill, whose
 * allowlist matches since 0.28.0 (base, arbitrum, optimism). All three rows
 * are measured.
 * Direct deposits credit at face value (on-chain deposit into the Gateway
 * Wallet contract; gas is paid separately in the source chain's native token).
 */
export const ECO_FEE_ESTIMATE_BY_CHAIN = { base: 0.04, optimism: 0.04, arbitrum: 0.04 };
/** Unmeasured source chains assume the worst measured fee. */
export const ECO_FEE_ESTIMATE_DEFAULT = 0.04;

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
      `  route   ${chainKey} → settles into Gateway on ${ECO_SETTLEMENT_CHAIN.label}`,
      `  fee     ~${formatUsdc(ecoFeeEstimate(chainKey))} fixed Eco fee from ${chainKey} (measured, not quotable pre-deposit; weighs heavier on small deposits)`,
      `  net     you'll receive ≈${formatUsdc(estimatedEcoNet(amount, chainKey))} in Gateway`
    ];
  }
  if (String(chainKey ?? "").trim().toLowerCase() === "arc") {
    return [
      "  fee     none — direct deposits credit at face value (Arc's gas token is USDC; Circle sponsored it for agent wallets in testing)"
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
  if (key === "arc") {
    // Arc has no EIP-681 URI (USDC is native gas), and not every exchange
    // withdraws to Arc — name the two routes that always work.
    lines.push(
      `  No USDC on Arc? Buy it there: selat fund --onramp   ${fmt.dim("(the Onramp widget carries USDC on Arc)")}`,
      `  Or move it from another chain: circle bridge transfer ARC --amount ${formatUsdc(shortfall).replace("$", "")} --address ${address} --chain <BASE|ARB|OP|…>   ${fmt.dim("(Circle forwarder fee ~$0.05–0.08)")}`
    );
  }
  return lines;
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
