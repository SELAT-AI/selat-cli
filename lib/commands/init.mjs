/**
 * `selat init` — bootstrap a new agent payment setup in one flow.
 *
 * Steps (see spec at docs/welcome-drip-spec.md for #7):
 *   1. Check prerequisites (node)
 *   2. Check agent-payment skill
 *   3. Check Circle CLI
 *   4. Circle Agent Wallet login (interactive — email OTP)
 *   5. Create agent wallets
 *   6. Check selat-pay
 *   7. Write config to $XDG_CONFIG_HOME/selat-pay/.env
 *   8. (optional) Claim welcome drip
 */

import { fmt, prompt, promptYesNo } from "../ui.mjs";
import { binVersion } from "../sh.mjs";
import {
  hasCircle,
  authStatus,
  login,
  createWallets,
  getAgentAddress,
  listAgentWallets,
  gatewayBalance,
  usdcBalances
} from "../circle.mjs";
import { resolveSelatPay } from "../selat-pay.mjs";
import { readConfig, writeConfig, configPath } from "../config.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

const STEPS = 8;

// The SELAT Router. Defaults to https://router.selat.ai; override at init
// time via --router-url=<url> or by setting SELAT_DEFAULT_ROUTER_URL in the
// environment. The runtime guard below still fires if a user override
// downgrades to plain http:// — MITM is real on plain HTTP because a network
// attacker can rewrite `payTo` in the 402 and steal a signed payment, so keep
// the default https:// unless you're running a router locally for development.
const DEFAULT_ROUTER_URL =
  process.env.SELAT_DEFAULT_ROUTER_URL || "https://router.selat.ai";

export async function init(args) {
  const skipDrip = args.includes("--no-drip");
  const force = args.includes("--force");

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
    console.error("      " + fmt.err("Circle CLI not found on PATH."));
    console.error("      Install Circle CLI, authenticate it, then run `selat init` again.");
    return 1;
  }

  // [4/8] Login
  console.log(fmt.step(4, STEPS, "Circle Agent Wallet login"));
  const status = await authStatus();
  if (status.authed && !force) {
    console.log("      " + fmt.ok(`already logged in${status.email ? ` as ${status.email}` : ""}`));
  } else {
    const email = await prompt("Email for your Circle agent account:", {
      validate: (v) => (/.@./.test(v) ? null : "Enter a valid email address.")
    });
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
  const existingAddr = force ? null : await getAgentAddress();
  let address;
  if (force) {
    const created = await createWallets();
    if (!created) {
      console.error("      " + fmt.err("wallet create failed"));
      return 1;
    }
    address = await getAgentAddress();
  } else if (existingAddr) {
    const choice = await chooseWallet(existingAddr);
    if (choice === "use") {
      address = existingAddr;
    } else {
      address = await createNewWallet();
      if (!address) return 1;
    }
  } else {
    const created = await createWallets();
    if (!created) {
      console.error("      " + fmt.err("wallet create failed"));
      return 1;
    }
    address = await getAgentAddress();
  }
  if (!address) {
    console.error("      " + fmt.err("could not read back wallet address after create"));
    return 1;
  }
  const wallets = await listAgentWallets();
  console.log("      " + fmt.ok(`wallet ${address}`));
  console.log("      " + fmt.dim(`across ${wallets.length} Circle-supported chains`));

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
  const existing = await readConfig();
  // slice past the prefix rather than split("=") — a router URL can itself
  // contain '=' (e.g. ?tenant=abc), which split("=")[1] would truncate.
  const routerArg = args.find((a) => a.startsWith("--router-url="));
  const routerUrl =
    (routerArg ? routerArg.slice("--router-url=".length) : "") ||
    existing.SELAT_ROUTER_URL ||
    DEFAULT_ROUTER_URL;
  await writeConfig({
    ...existing,
    SELAT_ROUTER_URL: routerUrl,
    SELAT_AGENT_WALLET_ADDRESS: address
  });
  console.log("      " + fmt.ok(`${configPath()} (mode 0600)`));
  console.log("      " + fmt.dim(`SELAT_ROUTER_URL=${routerUrl}`));
  console.log("      " + fmt.dim(`SELAT_AGENT_WALLET_ADDRESS=${address}`));
  if (!routerUrl.startsWith("https://")) {
    console.log("      " + fmt.warn(`router URL is plain HTTP — MITM possible.`));
  }

  // [8/8] Welcome drip (stub — see docs/welcome-drip-spec.md)
  console.log(fmt.step(8, STEPS, "Welcome drip"));
  if (skipDrip) {
    console.log("      " + fmt.dim("skipped (--no-drip)"));
  } else {
    const balance = await gatewayBalance(address);
    if (balance != null && balance > 0) {
      console.log("      " + fmt.dim(`Gateway balance already ${balance.toFixed(6)} USDC; skipping drip`));
    } else if (await hasOnchainUsdc(address)) {
      // Gateway is empty but the wallet holds on-chain USDC on Base/OP/Arb.
      // That USDC still has to be deposited into Gateway before paid calls work,
      // so nudge toward `selat fund` rather than the drip. Advisory only.
    } else {
      const wantDrip = await promptYesNo(
        "Claim 2 USDC welcome drip to make your first paid call?",
        { default: true }
      );
      if (wantDrip) {
        const dripResult = await claimWelcomeDrip(address, routerUrl);
        if (dripResult.ok) {
          console.log("      " + fmt.ok(`drip received: ${dripResult.amountUsd} USDC`));
        } else {
          console.error("      " + fmt.warn(`drip not received: ${dripResult.reason}`));
          console.error("      " + fmt.dim("You can deposit USDC manually: selat fund --chain base --amount 2"));
        }
      } else {
        console.log("      " + fmt.dim("skipped — you'll need to fund manually before paid calls work"));
      }
    }
  }

  // Done
  console.log("");
  console.log(fmt.bold("You're ready."));
  console.log("");
  console.log("  Make a paid call:");
  console.log(fmt.cyan(`    selat run "summarize the latest news on gold prices"`));
  console.log("");
  console.log("  Set a spending policy before depositing > $20:");
  console.log(fmt.cyan(`    selat setup-policy`));
  console.log("");
  console.log("  If something looks off:");
  console.log(fmt.cyan(`    selat doctor`));
  console.log("");
  return 0;
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

/**
 * Ask whether to reuse the existing agent wallet or create a new one.
 * Returns 'use' or 'new'. Uses prompt() (not promptYesNo) so both options are
 * named and self-documenting.
 */
async function chooseWallet(existingAddr) {
  console.log("      " + fmt.ok(`agent wallet found: ${existingAddr}`));
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
 * If the wallet holds on-chain USDC on Base/Optimism/Arbitrum, print a
 * per-chain breakdown plus a `selat fund` hint and return true. Returns false
 * when nothing is found (so the caller falls back to the welcome-drip prompt).
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

async function claimWelcomeDrip(address, routerUrl) {
  // Stub for v0: the welcome-drip endpoint isn't built yet. See
  // docs/welcome-drip-spec.md in the selat-router repo.
  //
  // When the endpoint lands, this function:
  //   1. Builds an EIP-712 attestation with { recipient: address, chain: "base", issuedAt, nonce }.
  //   2. Shells to `circle wallet sign typed-data` to get the signature.
  //   3. POSTs to ${routerUrl}/welcome/drip with the attestation.
  //   4. Parses the response and returns { ok, amountUsd, txHash } or { ok: false, reason }.
  return {
    ok: false,
    reason:
      "welcome-drip endpoint not yet deployed (spec at https://github.com/SELAT-AI/selat-router/pull/6)"
  };
}
