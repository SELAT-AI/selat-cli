/**
 * `juris init` — bootstrap a new agent payment setup in one flow.
 *
 * Steps (see spec at docs/welcome-drip-spec.md for #7):
 *   1. Check prerequisites (node, npm, git)
 *   2. Install Circle CLI if missing
 *   3. Circle Agent Wallet login (interactive — email OTP)
 *   4. Create agent wallets
 *   5. Install juris-pay
 *   6. Write config to $XDG_CONFIG_HOME/juris-pay/.env
 *   7. (optional) Claim welcome drip
 */

import { fmt, prompt, promptYesNo } from "../ui.mjs";
import { sh, hasBin, binVersion } from "../sh.mjs";
import {
  hasCircle,
  installCircleCli,
  authStatus,
  login,
  createWallets,
  getAgentAddress,
  listAgentWallets,
  gatewayBalance
} from "../circle.mjs";
import { hasJurisPay, installJurisPay } from "../juris-pay.mjs";
import { readConfig, writeConfig, configPath } from "../config.mjs";

const STEPS = 7;

// Demo Juris Router — HTTPS pre-launch endpoint at https://router.juris.fund.
// No SLA: availability and pricing may change without notice. Override at
// init time via --router-url=<url> or by setting JURIS_DEFAULT_ROUTER_URL
// in the environment. The runtime guard below still fires if a user
// override downgrades to plain http:// — MITM is real on plain HTTP because
// a network attacker can rewrite `payTo` in the 402 and steal a signed
// payment, so keep the default https:// unless you're running a router
// locally for development.
const DEFAULT_ROUTER_URL =
  process.env.JURIS_DEFAULT_ROUTER_URL || "https://router.juris.fund";

export async function init(args) {
  const skipDrip = args.includes("--no-drip");
  const force = args.includes("--force");

  console.log(fmt.header(`Juris Agent Payments — init`));

  // [1/7] Prerequisites
  console.log(fmt.step(1, STEPS, "Checking prerequisites"));
  const prereqOk = await checkPrerequisites();
  if (!prereqOk) return 1;

  // [2/7] Circle CLI
  console.log(fmt.step(2, STEPS, "Installing Circle CLI"));
  if (await hasCircle()) {
    console.log("      " + fmt.ok("Circle CLI already on PATH"));
  } else {
    const r = await installCircleCli();
    if (!r.ok) {
      console.error("      " + fmt.err("Circle CLI install failed."));
      console.error("      Try manually: npm install -g @circle-fin/cli");
      return 1;
    }
    console.log("      " + fmt.ok(`Circle CLI installed${r.fallback ? " (used isolated npm cache)" : ""}`));
  }

  // [3/7] Login
  console.log(fmt.step(3, STEPS, "Circle Agent Wallet login"));
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

  // [4/7] Wallets
  console.log(fmt.step(4, STEPS, "Creating agent wallets"));
  const created = await createWallets();
  if (!created) {
    console.error("      " + fmt.err("wallet create failed"));
    return 1;
  }
  const wallets = await listAgentWallets();
  const address = wallets[0]?.address;
  if (!address) {
    console.error("      " + fmt.err("could not read back wallet address after create"));
    return 1;
  }
  console.log("      " + fmt.ok(`wallet ${address}`));
  console.log("      " + fmt.dim(`across ${wallets.length} Circle-supported chains`));

  // [5/7] juris-pay
  console.log(fmt.step(5, STEPS, "Installing juris-pay"));
  if (await hasJurisPay()) {
    console.log("      " + fmt.ok("juris-pay already on PATH"));
  } else {
    const r = await installJurisPay();
    if (r.ok) {
      console.log("      " + fmt.ok(`juris-pay installed (source: ${r.source})`));
    } else {
      console.error("      " + fmt.warn("juris-pay is not yet available on npm."));
      console.error("      " + fmt.dim(r.reason));
      console.error("      Continuing — init will write config; install juris-pay manually before running `juris run`.");
    }
  }

  // [6/7] Config
  console.log(fmt.step(6, STEPS, "Writing config"));
  const existing = await readConfig();
  const routerUrl =
    args.find((a) => a.startsWith("--router-url="))?.split("=")[1] ||
    existing.JURIS_ROUTER_URL ||
    DEFAULT_ROUTER_URL;
  await writeConfig({
    ...existing,
    JURIS_ROUTER_URL: routerUrl,
    JURIS_AGENT_WALLET_ADDRESS: address
  });
  console.log("      " + fmt.ok(`${configPath()} (mode 0600)`));
  console.log("      " + fmt.dim(`JURIS_ROUTER_URL=${routerUrl}`));
  console.log("      " + fmt.dim(`JURIS_AGENT_WALLET_ADDRESS=${address}`));
  if (!routerUrl.startsWith("https://")) {
    console.log("      " + fmt.warn(`router URL is plain HTTP — MITM possible. Pre-launch demo only.`));
  }

  // [7/7] Welcome drip (stub — see docs/welcome-drip-spec.md)
  console.log(fmt.step(7, STEPS, "Welcome drip"));
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
          console.error("      " + fmt.dim("You can deposit USDC manually: juris fund --chain base --amount 2"));
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
  console.log(fmt.cyan(`    npx @myjuris/juris run "summarize the latest news on gold prices"`));
  console.log("");
  console.log("  Set a spending policy before depositing > $20:");
  console.log(fmt.cyan(`    npx @myjuris/juris setup-policy`));
  console.log("");
  console.log("  If something looks off:");
  console.log(fmt.cyan(`    npx @myjuris/juris doctor`));
  console.log("");
  return 0;
}

async function checkPrerequisites() {
  const checks = [
    { bin: "node", min: 18 },
    { bin: "npm", min: 0 },
    { bin: "git", min: 0 }
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
  // docs/welcome-drip-spec.md in the juris-router repo.
  //
  // When the endpoint lands, this function:
  //   1. Builds an EIP-712 attestation with { recipient: address, chain: "base", issuedAt, nonce }.
  //   2. Shells to `circle wallet sign typed-data` to get the signature.
  //   3. POSTs to ${routerUrl}/welcome/drip with the attestation.
  //   4. Parses the response and returns { ok, amountUsd, txHash } or { ok: false, reason }.
  return {
    ok: false,
    reason:
      "welcome-drip endpoint not yet deployed (spec at https://github.com/MyJuris/juris-router/pull/6)"
  };
}
