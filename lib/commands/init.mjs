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
  gatewayBalance
} from "../circle.mjs";
import { hasSelatPay } from "../selat-pay.mjs";
import { readConfig, writeConfig, configPath } from "../config.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

const STEPS = 8;

// Demo SELAT Router — HTTPS pre-launch endpoint at https://router.selat.ai.
// No SLA: availability and pricing may change without notice. Override at
// init time via --router-url=<url> or by setting SELAT_DEFAULT_ROUTER_URL
// in the environment. The runtime guard below still fires if a user
// override downgrades to plain http:// — MITM is real on plain HTTP because
// a network attacker can rewrite `payTo` in the 402 and steal a signed
// payment, so keep the default https:// unless you're running a router
// locally for development.
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

  // [5/8] Wallets
  console.log(fmt.step(5, STEPS, "Creating agent wallets"));
  const created = await createWallets();
  if (!created) {
    console.error("      " + fmt.err("wallet create failed"));
    return 1;
  }
  const wallets = await listAgentWallets();
  const address = await getAgentAddress();
  if (!address) {
    console.error("      " + fmt.err("could not read back wallet address after create"));
    return 1;
  }
  console.log("      " + fmt.ok(`wallet ${address}`));
  console.log("      " + fmt.dim(`across ${wallets.length} Circle-supported chains`));

  // [6/8] selat-pay
  console.log(fmt.step(6, STEPS, "Checking selat-pay"));
  if (await hasSelatPay()) {
    console.log("      " + fmt.ok("selat-pay already on PATH"));
  } else {
    console.error("      " + fmt.warn("selat-pay not found on PATH."));
    console.error("      " + fmt.dim("Continuing — init will write config; install or link selat-pay before running `selat run`."));
  }

  // [7/8] Config
  console.log(fmt.step(7, STEPS, "Writing config"));
  const existing = await readConfig();
  const routerUrl =
    args.find((a) => a.startsWith("--router-url="))?.split("=")[1] ||
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
    console.log("      " + fmt.warn(`router URL is plain HTTP — MITM possible. Pre-launch demo only.`));
  }

  // [8/8] Welcome drip (stub — see docs/welcome-drip-spec.md)
  console.log(fmt.step(8, STEPS, "Welcome drip"));
  if (skipDrip) {
    console.log("      " + fmt.dim("skipped (--no-drip)"));
  } else {
    const balance = await gatewayBalance(address);
    if (balance != null && balance > 0) {
      console.log("      " + fmt.dim(`Gateway balance already ${balance.toFixed(6)} USDC; skipping drip`));
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
