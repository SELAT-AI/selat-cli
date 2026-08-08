/**
 * `selat init` — bootstrap a new agent payment setup in one flow.
 *
 * Steps:
 *   1. Check prerequisites (node)
 *   2. Check agent-payment skill
 *   3. Check Circle CLI
 *   4. Circle Agent Wallet login (interactive — email OTP)
 *   5. Create agent wallets
 *   6. Check selat-pay
 *   7. Write config to $XDG_CONFIG_HOME/selat-pay/.env
 *   8. Funding check (Gateway / on-chain USDC)
 */

import { fmt, prompt, promptYesNo, stdinIsInteractive } from "../ui.mjs";
import { binVersion, isWindows } from "../sh.mjs";
import {
  hasCircle,
  ensureCircle,
  authStatus,
  login,
  createWallets,
  getAgentAddress,
  listAgentWallets,
  listAgentWalletsDetailed,
  gatewayBalance,
  usdcBalances,
  spendingPolicy
} from "../circle.mjs";
import { resolveSelatPay } from "../selat-pay.mjs";
import { readConfig, writeConfig, configPath } from "../config.mjs";
import { usdcAmountText } from "../format.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import { setupPolicy } from "./setup-policy.mjs";

const STEPS = 8;

// The SELAT Router. Defaults to https://router.selat.ai; override at init
// time via --router-url=<url> or by setting SELAT_DEFAULT_ROUTER_URL in the
// environment. The runtime guard below still fires if a user override
// downgrades to plain http:// — MITM is real on plain HTTP because a network
// attacker can rewrite `payTo` in the 402 and steal a signed payment, so keep
// the default https:// unless you're running a router locally for development.
const DEFAULT_ROUTER_URL =
  process.env.SELAT_DEFAULT_ROUTER_URL || "https://router.selat.ai";

const USAGE = `${fmt.bold("selat init")} — bootstrap SELAT agent payments

${fmt.bold("Usage:")}
  selat init [--force] [--email <address>] [--wallet <n|address|new>] [--router-url=<url>]

${fmt.bold("Options:")}
  --force               Recreate/ensure wallets non-interactively.
  --email <address>     Circle agent account email (skips the login email prompt).
  --wallet <n|address|new>
                        Select a wallet non-interactively (skips the "Wallet to use"
                        prompt): a 1-based index from the list, a 0x address, or 'new'.
                        Also read from SELAT_WALLET. For agent shells / CI with no TTY.
  --router-url=<url>    Override the SELAT Router URL written to config.
  --help, -h            Show this help.
`;

export async function init(args) {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    console.log(USAGE);
    return 0;
  }

  const force = args.includes("--force");
  const walletPreset = walletArg(args);

  console.log(fmt.header(`SELAT Agent Payments — init`));

  // [1/7] Prerequisites
  console.log(fmt.step(1, STEPS, "Checking prerequisites"));
  const prereqOk = await checkPrerequisites();
  if (!prereqOk) return 1;

  // [2/8] Agent-payment skill
  console.log(fmt.step(2, STEPS, "Checking agent-payment skill"));
  const skill = findSkill("rank.mjs");
  if (skill.found) {
    console.log("      " + fmt.ok(`skill at ${skill.path}`));
  } else {
    console.error("      " + fmt.warn("agent-payment skill not found."));
    console.error("      " + fmt.dim("Continuing — init can prepare wallet/config, but `selat run` needs the skill."));
    for (const line of skillInstallLines(skill.path)) {
      console.error("      " + fmt.dim(line));
    }
  }

  // [3/8] Circle CLI
  console.log(fmt.step(3, STEPS, "Checking Circle CLI"));
  if (await hasCircle()) {
    console.log("      " + fmt.ok("Circle CLI already on PATH"));
  } else {
    // Auto-install the Circle CLI rather than bouncing the user out of setup.
    // Installing the binary moves no money — wallet login (OTP), creation, and
    // funding still happen interactively under the user's own Circle account
    // in the steps below, preserving self-custody.
    console.log("      " + fmt.dim("Circle CLI not found — installing @circle-fin/cli…"));
    if (await ensureCircle()) {
      console.log("      " + fmt.ok("Circle CLI installed"));
    } else {
      console.error("      " + fmt.err("Circle CLI auto-install failed."));
      console.error("      Install it manually: npm install -g @circle-fin/cli, then run `selat init` again.");
      if (isWindows) {
        console.error("      " + fmt.dim("Already installed? `circle --version` working here means the shim is"));
        console.error("      " + fmt.dim("outside PATH — point at it directly: set CIRCLE_BIN=C:\\path\\to\\circle.cmd"));
      }
      return 1;
    }
  }

  // [4/8] Login
  console.log(fmt.step(4, STEPS, "Circle Agent Wallet login"));
  const status = await authStatus();
  if (status.authed && !force) {
    console.log("      " + fmt.ok(`already logged in${status.email ? ` as ${status.email}` : ""}`));
  } else {
    let email = emailArg(args);
    if (email && !/.@./.test(email)) {
      console.error("      " + fmt.err(`--email ${email} is not a valid email address`));
      return 1;
    }
    // The Circle login is email + a 6-digit OTP typed at the Circle CLI's own
    // prompt — it cannot complete without a terminal. In an agent shell / CI,
    // fail fast with the manual two-step instead of hanging on a prompt.
    if (!stdinIsInteractive()) {
      console.error("      " + fmt.err("not logged in, and this shell has no TTY for the email/OTP login."));
      console.error(`      Log in from an interactive terminal first: circle wallet login ${email || "<email>"} --type agent`);
      console.error("      (the Circle CLI prompts for the 6-digit code), then re-run `selat init` here.");
      return 1;
    }
    if (!email) {
      email = await prompt("Email for your Circle agent account:", {
        validate: (v) => (/.@./.test(v) ? null : "Enter a valid email address.")
      });
    }
    console.log(fmt.dim(`      A login code will be sent to ${email}.`));
    console.log(fmt.dim(`      The Circle CLI will prompt for the 6-digit code.`));
    const ok = await login(email);
    if (!ok) {
      console.error("      " + fmt.err("login failed"));
      console.error("      Try manually: circle wallet login <email> --type agent");
      return 1;
    }
    console.log("      " + fmt.ok(`logged in as ${email}`));
  }

  // [5/8] Wallets — when an agent wallet already exists, explicitly ask whether
  // to reuse it or create a new one. Circle allows multiple agent wallets per
  // account (up to 5), so "create new" adds another wallet under the *current*
  // account — no email change needed (handled by createNewWallet()).
  // `--force` keeps the non-interactive bootstrap: create/ensure wallets on the
  // current account with no prompt — the escape hatch for scripts/CI.
  console.log(fmt.step(5, STEPS, "Creating agent wallets"));
  const existingConfig = await readConfig();
  const configuredAddr = force ? null : normalizeAddress(existingConfig.SELAT_AGENT_WALLET_ADDRESS);
  const walletLookup = force ? null : await listAgentWalletsDetailed();
  const walletLookupFailed =
    !!walletLookup &&
    walletLookup.wallets.length === 0 &&
    walletLookup.failures.length >= walletLookup.queriedChains;
  const existingAddr = force ? null : pickAgentAddress(walletLookup.wallets);
  let address;
  let wallets = walletLookup?.wallets ?? [];
  const walletLog = (m) => console.log("      " + fmt.warn(m));
  if (force) {
    const r = await resolveWalletAddress({ createWallets, getAgentAddress, configuredAddr, log: walletLog });
    if (!r.address) {
      console.error("      " + fmt.err("wallet create failed"));
      return 1;
    }
    address = r.address;
    wallets = await listAgentWallets();
  } else if (wallets.length > 1) {
    // Multiple agent wallets on the account (Circle allows up to 5). Don't
    // silently take the first-listed (newest) one — that's how a fresh host
    // ends up configured with an empty wallet while the funded one sits 3rd
    // in the list (issue #52). Rank candidates (configured > funded > listed
    // order), show the menu, and default to the best so a plain Enter — or an
    // agent driving init — picks sensibly.
    const picked = await chooseAmongWallets({ wallets, configuredAddr, preset: walletPreset });
    if (picked === null) return 1; // invalid --wallet; error already printed
    if (picked === "new") {
      address = await createNewWallet();
      if (!address) return 1;
      wallets = await listAgentWallets();
    } else {
      address = picked;
    }
  } else if (existingAddr) {
    const choice = await chooseWallet(existingAddr, { preset: walletPreset });
    if (choice === null) return 1; // invalid --wallet; error already printed
    if (choice === "use") {
      address = existingAddr;
    } else {
      address = await createNewWallet();
      if (!address) return 1;
      wallets = await listAgentWallets();
    }
  } else if (configuredAddr && walletLookupFailed) {
    console.log("      " + fmt.warn("Circle wallet lookup failed; reusing configured wallet"));
    console.log("      " + fmt.dim(`SELAT_AGENT_WALLET_ADDRESS=${configuredAddr}`));
    address = configuredAddr;
  } else {
    // No wallet discovered. Attempt the idempotent bootstrap create — but if it
    // fails because the account is at Circle's wallet cap (i.e. a wallet already
    // exists), recover by reusing it instead of dead-ending init.
    const r = await resolveWalletAddress({ createWallets, getAgentAddress, configuredAddr, log: walletLog });
    if (!r.address) {
      console.error("      " + fmt.err("wallet create failed"));
      return 1;
    }
    address = r.address;
    wallets = await listAgentWallets();
  }
  if (!address) {
    console.error("      " + fmt.err("could not read back wallet address after create"));
    return 1;
  }
  console.log("      " + fmt.ok(`wallet ${address}`));
  if (wallets.length > 0) {
    console.log("      " + fmt.dim(`across ${wallets.length} Circle-supported chains`));
  } else {
    console.log("      " + fmt.dim("Circle chain coverage not verified; wallet came from existing config"));
  }

  // [6/8] selat-pay
  console.log(fmt.step(6, STEPS, "Checking selat-pay"));
  const selatPay = await resolveSelatPay();
  if (selatPay.source === "global") {
    console.log("      " + fmt.ok("selat-pay installed (global)"));
  } else if (selatPay.source === "bundled") {
    console.log("      " + fmt.ok("selat-pay installed (bundled with selat-cli)"));
  } else {
    console.error("      " + fmt.warn("selat-pay not found."));
    console.error("      " + fmt.dim("Continuing — reinstall selat-cli or `npm i -g @selat-ai/selat-pay` before running `selat run`."));
  }

  // [7/8] Config
  console.log(fmt.step(7, STEPS, "Writing config"));
  // slice past the prefix rather than split("=") — a router URL can itself
  // contain '=' (e.g. ?tenant=abc), which split("=")[1] would truncate.
  const routerArg = args.find((a) => a.startsWith("--router-url="));
  const routerUrl =
    (routerArg ? routerArg.slice("--router-url=".length) : "") ||
    existingConfig.SELAT_ROUTER_URL ||
    DEFAULT_ROUTER_URL;
  await writeConfig({
    ...existingConfig,
    SELAT_ROUTER_URL: routerUrl,
    SELAT_AGENT_WALLET_ADDRESS: address
  });
  console.log("      " + fmt.ok(`${configPath()} (mode 0600)`));
  console.log("      " + fmt.dim(`SELAT_ROUTER_URL=${routerUrl}`));
  console.log("      " + fmt.dim(`SELAT_AGENT_WALLET_ADDRESS=${address}`));
  if (!routerUrl.startsWith("https://")) {
    console.log("      " + fmt.warn(`router URL is plain HTTP — MITM possible.`));
  }

  // [8/8] Funding check — report Gateway balance, or nudge to `selat fund`.
  console.log(fmt.step(8, STEPS, "Funding check"));
  const balance = await gatewayBalance(address);
  if (balance != null && balance > 0) {
    console.log("      " + fmt.ok(`Gateway balance: ${usdcAmountText(balance)}`));
  } else if (await hasOnchainUsdc(address)) {
    // Gateway is empty but the wallet holds on-chain USDC on a source chain;
    // hasOnchainUsdc() already printed the breakdown + a `selat fund` hint.
  } else {
    for (const line of noUsdcHintLines()) console.log("      " + fmt.dim(line));
  }

  // Spending-policy chaining — the wallet is ready, so this is THE moment to
  // set the one hard ceiling a runaway agent cannot bypass. Testers report
  // nobody discovers `selat setup-policy` from docs alone. Best-effort policy
  // read; never blocks init. The setup-policy flow itself is interactive
  // (Circle emails an OTP typed at the Circle CLI's own prompt — that prompt
  // belongs to the user's terminal), so non-TTY shells get the verbatim
  // command instead of a hung prompt.
  const policy = await spendingPolicy(address).catch(() => ({ readable: false }));
  const offer = policyChainDecision({ policy, interactive: stdinIsInteractive() });
  let policySet = !!(policy?.readable && policy.custom);
  if (offer.recommend) {
    console.log("");
    console.log(fmt.warn("This wallet has NO spending caps — a runaway agent could spend the full balance."));
    console.log("      " + fmt.dim("Circle wallet policy (per-tx/daily/weekly/monthly) is the one hard ceiling"));
    console.log("      " + fmt.dim("the agent literally cannot bypass. Strongly recommended before funding."));
    if (offer.mode === "prompt") {
      const yes = await promptYesNo("Set spending caps now?", { default: true });
      if (yes) {
        policySet = (await setupPolicy([])) === 0;
      } else {
        console.log("      " + fmt.dim("Skipped — set them any time: selat setup-policy"));
      }
    } else {
      console.log("      " + fmt.dim("Set them from an interactive terminal (Circle emails a one-time code):"));
      console.log("      " + fmt.cyan("selat setup-policy"));
    }
  }

  // Done
  console.log("");
  console.log(fmt.bold("You're ready."));
  console.log("");
  console.log("  Make a paid call:");
  console.log(fmt.cyan(`    selat run "summarize the latest news on gold prices"`));
  console.log("");
  if (!policySet) {
    console.log("  Set a spending policy before depositing > $20:");
    console.log(fmt.cyan(`    selat setup-policy`));
    console.log("");
  }
  console.log("  If something looks off:");
  console.log(fmt.cyan(`    selat doctor`));
  console.log("");
  return 0;
}

/**
 * Decide how init's success path offers `setup-policy` chaining. Pure and
 * exported for tests. Only recommend when the policy read succeeded AND shows
 * no custom caps (best-effort: an unreadable policy stays silent rather than
 * nagging on a Circle hiccup). Interactive shells get the yes/no prompt
 * (default YES); non-TTY shells get the verbatim command printed instead —
 * the Circle OTP prompt belongs to the user's own terminal.
 */
export function policyChainDecision({ policy, interactive }) {
  const uncapped = !!policy?.readable && !policy.custom;
  if (!uncapped) return { recommend: false, mode: null };
  return { recommend: true, mode: interactive ? "prompt" : "print" };
}

async function checkPrerequisites() {
  const checks = [
    { bin: "node", min: 18 },
  ];

  let allOk = true;
  for (const c of checks) {
    const v = await binVersion(c.bin);
    if (!v) {
      console.error("      " + fmt.err(`${c.bin} not found on PATH`));
      allOk = false;
      continue;
    }
    if (c.bin === "node") {
      const major = parseInt(v.replace(/^v/, "").split(".")[0], 10);
      if (Number.isFinite(major) && major < c.min) {
        console.error("      " + fmt.err(`node ${v} is too old; need >= ${c.min}`));
        allOk = false;
        continue;
      }
    }
    console.log("      " + fmt.ok(`${c.bin} ${v}`));
  }
  return allOk;
}

/** `--email <addr>` or `--email=<addr>` from argv, else null. */
export function emailArg(args) {
  const eq = args.find((a) => a.startsWith("--email="));
  if (eq) return eq.slice("--email=".length) || null;
  const idx = args.indexOf("--email");
  if (idx === -1) return null;
  const next = args[idx + 1];
  return next && !next.startsWith("--") ? next : null;
}

/**
 * `--wallet <n|address|new>` / `--wallet=…`, else the `SELAT_WALLET` env var,
 * else null. The non-interactive escape for wallet selection — the counterpart
 * to `--email`, so an agent shell / CI (e.g. a Hermes runner with no usable TTY)
 * can pick a wallet without the `Wallet to use [1-N/new]` prompt, instead of
 * faking a pseudo-terminal to pipe a digit in.
 */
export function walletArg(args) {
  const eq = args.find((a) => a.startsWith("--wallet="));
  if (eq) return eq.slice("--wallet=".length) || null;
  const idx = args.indexOf("--wallet");
  if (idx !== -1) {
    const next = args[idx + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return process.env.SELAT_WALLET || null;
}

/**
 * Resolve a wallet preset against the ranked candidate list. Accepts a 1-based
 * index, a full 0x address (case-insensitive), or 'new'/'n'. Returns the chosen
 * address, the literal 'new', or null when it doesn't resolve — callers treat
 * null as a hard error and fail fast rather than fall through to a prompt that
 * would hang in a non-TTY shell. Pure.
 */
export function resolveWalletPreset(preset, ranked) {
  const t = String(preset ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t === "new" || t === "n") return "new";
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= ranked.length) return ranked[n - 1].address;
  const byAddr = ranked.find((w) => w.address.toLowerCase() === t);
  return byAddr ? byAddr.address : null;
}

function normalizeAddress(address) {
  const value = String(address ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;
}

function pickAgentAddress(wallets) {
  if (!Array.isArray(wallets) || wallets.length === 0) return null;
  const sorted = wallets.slice().sort((a, b) => (b.chains?.length ?? 0) - (a.chains?.length ?? 0));
  return sorted[0].address;
}

/**
 * Rank wallet candidates for the multi-wallet menu: the configured address
 * first, then by Gateway balance (desc), then original list order. Pure and
 * dependency-free so it's unit-testable. `balances` maps lowercase address →
 * USD number (null/missing = unknown, ranks below any known balance).
 * Returns [{ address, chains, gatewayUsd, isConfigured }] — never mutates input.
 */
export function rankWalletCandidates({ wallets, configuredAddr = null, balances = {} }) {
  const cfg = String(configuredAddr ?? "").toLowerCase();
  return (wallets ?? [])
    .map((w, i) => ({
      address: w.address,
      chains: w.chains ?? [],
      gatewayUsd: balances[w.address?.toLowerCase()] ?? null,
      isConfigured: !!cfg && w.address?.toLowerCase() === cfg,
      _i: i
    }))
    .sort((a, b) =>
      (b.isConfigured - a.isConfigured) ||
      ((b.gatewayUsd ?? -1) - (a.gatewayUsd ?? -1)) ||
      (a._i - b._i)
    )
    .map(({ _i, ...w }) => w);
}

/**
 * List all agent wallets with Gateway balances and let the user pick one (or
 * type 'new'). Balance lookups run in parallel and are advisory — a failed
 * lookup shows '?' rather than blocking init. Defaults to the best-ranked
 * candidate (configured > funded > listed order), so a plain Enter picks
 * sensibly even when init is driven non-interactively by an agent.
 * Returns the chosen address, or 'new'.
 */
async function chooseAmongWallets({ wallets, configuredAddr, preset = null }) {
  console.log("      " + fmt.ok(`${wallets.length} agent wallets found on this Circle account`));
  console.log("      " + fmt.dim("Checking Gateway balances…"));
  const balances = {};
  await Promise.all(
    wallets.map(async (w) => {
      balances[w.address.toLowerCase()] = await gatewayBalance(w.address).catch(() => null);
    })
  );

  const ranked = rankWalletCandidates({ wallets, configuredAddr, balances });
  for (let i = 0; i < ranked.length; i++) {
    const w = ranked[i];
    const bal = w.gatewayUsd == null ? "?" : usdcAmountText(w.gatewayUsd);
    const marks = [w.isConfigured ? "configured" : null, i === 0 ? "default" : null]
      .filter(Boolean).join(", ");
    console.log(
      `      ${fmt.bold(String(i + 1))}. ${w.address}  Gateway: ${bal}` +
      (marks ? `  ${fmt.dim(`(${marks})`)}` : "")
    );
  }

  // Non-interactive selection via --wallet / SELAT_WALLET. Resolve against the
  // ranked list (so an index means the same thing a human would see), and fail
  // fast on a bad value rather than dropping into a prompt that can't be answered.
  if (preset != null) {
    const resolved = resolveWalletPreset(preset, ranked);
    if (!resolved) {
      console.error("      " + fmt.err(
        `--wallet ${preset} did not match a wallet — pass 1-${ranked.length}, a listed 0x address, or 'new'.`
      ));
      return null;
    }
    console.log("      " + fmt.ok(
      `wallet selected via --wallet: ${resolved === "new" ? "create new" : resolved}`
    ));
    return resolved;
  }

  const answer = await prompt(`Wallet to use [1-${ranked.length}/new]`, {
    default: "1",
    validate: (v) => {
      const t = v.trim().toLowerCase();
      if (t === "new" || t === "n") return null;
      const n = Number(t);
      return Number.isInteger(n) && n >= 1 && n <= ranked.length
        ? null
        : `Enter 1-${ranked.length} or 'new'.`;
    }
  });
  const norm = answer.trim().toLowerCase();
  if (norm === "new" || norm === "n") return "new";
  return ranked[Number(norm) - 1].address;
}

/**
 * Ask whether to reuse the existing agent wallet or create a new one.
 * Returns 'use' or 'new'. Uses prompt() (not promptYesNo) so both options are
 * named and self-documenting.
 */
async function chooseWallet(existingAddr, { preset = null } = {}) {
  console.log("      " + fmt.ok(`agent wallet found: ${existingAddr}`));

  // Non-interactive selection via --wallet / SELAT_WALLET. With a single wallet,
  // 'use'/'u'/'1'/the address all mean reuse; 'new'/'n' means create. Anything
  // else is a hard error (fail fast, don't hang on the prompt).
  if (preset != null) {
    const t = String(preset).trim().toLowerCase();
    if (t === "new" || t === "n") {
      console.log("      " + fmt.ok("creating a new wallet via --wallet"));
      return "new";
    }
    if (t === "use" || t === "u" || t === "1" || t === existingAddr.toLowerCase()) {
      console.log("      " + fmt.ok("reusing the existing wallet via --wallet"));
      return "use";
    }
    console.error("      " + fmt.err(
      `--wallet ${preset} doesn't match this wallet — pass 'use', '1', ${existingAddr}, or 'new'.`
    ));
    return null;
  }

  const answer = await prompt("Use this wallet, or create a new one? [use/new]", {
    default: "use",
    validate: (v) =>
      ["use", "u", "new", "n"].includes(v.trim().toLowerCase())
        ? null
        : "Type 'use' or 'new'."
  });
  const norm = answer.trim().toLowerCase();
  return norm === "new" || norm === "n" ? "new" : "use";
}

/**
 * Create a new agent wallet under the CURRENT Circle account. Circle allows
 * multiple agent wallets per account (up to 5) — no email change is required.
 * Selects the freshly created wallet by diffing the wallet list before/after.
 * Returns the new address, or null on create failure. If no new wallet appears
 * (e.g. the account is already at Circle's 5-wallet limit), it explains that
 * and falls back to the existing wallet.
 */
async function createNewWallet() {
  console.log(
    "      " +
      fmt.dim("Creating a new agent wallet under your current Circle account (Circle allows up to 5 per account).")
  );
  const before = new Set((await listAgentWallets()).map((w) => w.address.toLowerCase()));

  const created = await createWallets({ fresh: true });
  if (!created) {
    console.error("      " + fmt.err("wallet create failed"));
    return null;
  }

  const after = await listAgentWallets();
  const fresh = after.find((w) => !before.has(w.address.toLowerCase()));
  if (fresh) return fresh.address;

  console.log(
    "      " +
      fmt.warn("No new wallet was created — your account may be at Circle's limit of 5 agent wallets. Using the existing wallet.")
  );
  return await getAgentAddress();
}

/**
 * Resolve the agent wallet address for the bootstrap (non-interactive) paths,
 * making wallet creation idempotent AND recoverable. We attempt the idempotent
 * bootstrap create, then read the address back. Crucially, if create FAILS — most
 * often because the account is already at Circle's 5-wallet cap, which means a
 * wallet ALREADY exists — we recover by reusing the wallet we can read back (or a
 * configured address) instead of dead-ending init. No funds move; this only
 * avoids creating a duplicate or erroring when a usable wallet is already present.
 *
 * Dependency-injected (createWallets / getAgentAddress) so it's unit-testable.
 * Returns { address, created }; address is null only when nothing usable exists.
 */
export async function resolveWalletAddress({ createWallets, getAgentAddress, configuredAddr = null, log = () => {} }) {
  const created = await createWallets();
  const addr = await getAgentAddress();
  if (addr) {
    if (!created) {
      log("wallet create skipped (account may be at Circle's 5-wallet limit) — using existing wallet");
    }
    return { address: addr, created };
  }
  if (configuredAddr) {
    log("Circle wallet lookup didn't surface a wallet — reusing configured address");
    return { address: configuredAddr, created: false };
  }
  return { address: null, created };
}

/**
 * Closing funding hint when the wallet holds no readable USDC anywhere
 * (on-chain zero or unknown, Gateway empty). Stage-aware: `selat fund` on an
 * empty wallet does NOT deposit — it first shows a QR / address details to
 * top up the wallet address (Step 1), and only a re-run deposits into Gateway
 * (Step 2). Saying just "run selat fund" here sent users into a command that
 * appeared to refuse them (live onboarding feedback). Pure; exported for tests.
 */
export function noUsdcHintLines() {
  return [
    "No USDC yet — fund before paid calls: selat fund --amount 2",
    "(selat fund will first show a QR / address details to top up your wallet,",
    " then deposit into Gateway on a re-run — one spendable Gateway balance.)"
  ];
}

/**
 * If the wallet holds on-chain USDC on any checked chain (TARGET_USDC_CHAINS),
 * print a per-chain breakdown plus a `selat fund` hint and return true. Returns false
 * when nothing is found (so the caller can nudge to `selat fund`).
 * Advisory only — never blocks init.
 */
async function hasOnchainUsdc(address) {
  const onchain = await usdcBalances(address);
  if (!onchain.hasAny) return false;
  const breakdown = onchain.perChain
    .map((c) => `${c.key} ${(c.usdc ?? 0).toFixed(2)}`)
    .join(", ");
  console.log("      " + fmt.ok(`on-chain USDC: ${breakdown}`));
  // Suggest depositing from the chain with the largest balance.
  const top = onchain.perChain
    .slice()
    .sort((a, b) => (b.usdc ?? 0) - (a.usdc ?? 0))[0];
  console.log(
    "      " +
      fmt.dim(
        `That USDC isn't in Gateway yet. Deposit it to pay: selat fund --chain ${top.key} --amount ${(top.usdc ?? 0).toFixed(2)}`
      )
  );
  return true;
}
