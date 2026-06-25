/**
 * `selat doctor` — diagnose setup problems. Single pass through:
 *   - Node / npm / git version
 *   - Circle CLI installed + authed
 *   - Agent wallet exists
 *   - Gateway balance
 *   - agent-payment skill installed
 *   - selat-pay installed
 *   - ~/.config/selat-pay/.env present and valid
 *   - Router URL reachable
 */

import { fmt } from "../ui.mjs";
import { sh, binVersion } from "../sh.mjs";
import { authStatus, getAgentAddress, gatewayBalancesByChain, usdcBalances, hasCircle } from "../circle.mjs";
import { resolveSelatPay, selatPayVersion } from "../selat-pay.mjs";
import { readConfig, configPath } from "../config.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

export async function doctor() {
  console.log(fmt.bold("\nselat doctor — checking your setup"));
  console.log("");

  let failures = 0;
  const fail = (msg) => { failures++; console.log("  " + fmt.err(msg)); };
  const pass = (msg) => console.log("  " + fmt.ok(msg));
  const warn = (msg) => console.log("  " + fmt.warn(msg));

  // Binaries
  console.log(fmt.bold("Binaries:"));
  for (const bin of ["node", "npm", "git"]) {
    const v = await binVersion(bin);
    if (v) pass(`${bin} ${v}`);
    else fail(`${bin} not on PATH`);
  }

  // Agent-payment skill
  console.log(fmt.bold("\nAgent-payment skill:"));
  const skill = findSkill("rank.mjs");
  if (skill.found) {
    pass(`skill at ${skill.path}`);
  } else {
    fail("agent-payment skill not found — `selat run` needs it for discovery and ranking");
    for (const line of skillInstallLines(skill.path)) console.log("  " + fmt.dim(line));
  }

  // Circle CLI
  console.log(fmt.bold("\nCircle CLI:"));
  if (await hasCircle()) {
    pass("circle binary on PATH");
    const status = await authStatus();
    if (status.authed) pass(`authenticated${status.email ? " as " + status.email : ""}`);
    else fail("not authenticated — run `selat init`");
  } else {
    fail("circle CLI not installed — install Circle CLI, then run `selat init`");
  }

  // Agent wallet
  console.log(fmt.bold("\nAgent Wallet:"));
  const address = await getAgentAddress();
  if (address) {
    pass(`wallet ${address}`);
    const gw = await gatewayBalancesByChain(address);
    const bal = gw ? gw.total : null;
    if (bal != null) {
      const fmtBal = bal.toFixed(6) + " USDC";
      if (bal >= 0.5) pass(`Gateway balance: ${fmtBal}`);
      else if (bal > 0) warn(`Gateway balance: ${fmtBal} (low — top up before heavy use)`);
      else warn("Gateway balance: 0 USDC (run `selat fund`)");
      // Per-chain breakdown so you can see WHICH chain holds the funds — that's
      // the chain to pass as `--chain` when paying. Eco deposits settle on
      // Polygon, so eco-funded balances show up here as a Polygon row.
      for (const c of (gw.perChain ?? []).filter((c) => (c.usdc ?? 0) > 0)) {
        const chainKey = c.network ? c.network.toLowerCase() : `domain-${c.domain}`;
        console.log("    " + fmt.dim(`${c.network} (domain ${c.domain}): ${c.usdc.toFixed(6)} USDC — pay with --chain ${chainKey}`));
      }
    } else {
      warn("Gateway balance: could not read (Circle API issue or no wallet on the queried chain)");
    }
    // On-chain USDC across the deposit-source chains (distinct from Gateway).
    const oc = await usdcBalances(address);
    for (const c of oc.perChain) {
      if (c.usdc == null) warn(`on-chain USDC ${c.key}: could not read`);
      else if (c.usdc > 0) pass(`on-chain USDC ${c.key}: ${c.usdc.toFixed(2)}`);
      else warn(`on-chain USDC ${c.key}: 0.00`);
    }
    if ((bal ?? 0) <= 0 && !oc.hasAny) {
      warn("No on-chain USDC and Gateway is empty — run `selat fund`");
    }
  } else {
    fail("no agent wallet found — run `selat init`");
  }

  // selat-pay
  console.log(fmt.bold("\nselat-pay:"));
  const selatPay = await resolveSelatPay();
  const versionLabel = await selatPayVersion(); // e.g. "installed (bundled, v0.3.1)"
  if (selatPay.source === "global") {
    pass(`selat-pay ${versionLabel ?? "installed (global)"}`);
    console.log("    " + fmt.dim("bundled selat-pay missing — install with `npm install -g @selat-ai/selat-cli` to restore"));
  } else if (selatPay.source === "bundled") {
    pass(`selat-pay ${versionLabel ?? "installed (bundled)"} — ${selatPay.bin}`);
    console.log("    " + fmt.dim("only reachable via `selat run`; for a shell-callable copy: npm i -g @selat-ai/selat-pay"));
  } else if (selatPay.source === "env-override") {
    pass(`selat-pay ${versionLabel ?? "installed (env-override)"} — ${selatPay.bin}`);
    console.log("    " + fmt.dim("override via $SELAT_PAY_BIN — unset to fall back to bundled"));
  } else {
    fail("selat-pay not found — reinstall selat-cli, or install selat-pay globally");
  }

  // Config file
  console.log(fmt.bold("\nConfig:"));
  const cfg = await readConfig();
  if (Object.keys(cfg).length === 0) {
    fail(`${configPath()} missing or empty — run \`selat init\``);
  } else {
    pass(`${configPath()} present`);
    if (cfg.SELAT_ROUTER_URL) pass(`SELAT_ROUTER_URL=${cfg.SELAT_ROUTER_URL}`);
    else warn("SELAT_ROUTER_URL not set");
    if (cfg.SELAT_AGENT_WALLET_ADDRESS) pass(`SELAT_AGENT_WALLET_ADDRESS=${cfg.SELAT_AGENT_WALLET_ADDRESS}`);
    else warn("SELAT_AGENT_WALLET_ADDRESS not set");
    if (cfg.SELAT_ROUTER_URL && !cfg.SELAT_ROUTER_URL.startsWith("https://")) {
      warn("Router URL is not https:// — MITM possible. Replace when production router is available.");
    }
  }

  // Router reachable
  if (cfg.SELAT_ROUTER_URL) {
    console.log(fmt.bold("\nRouter reachability:"));
    const r = await sh("curl", ["-sS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${cfg.SELAT_ROUTER_URL}/healthz`]).catch(() => null);
    if (r && r.stdout.trim() === "200") pass(`${cfg.SELAT_ROUTER_URL}/healthz returns 200`);
    else fail(`${cfg.SELAT_ROUTER_URL} unreachable or returned ${r?.stdout?.trim() || "(curl error)"}`);
  }

  // Summary
  console.log("");
  if (failures === 0) {
    console.log(fmt.bold(fmt.green("All checks passed.")));
    return 0;
  }
  console.log(fmt.bold(fmt.red(`${failures} check(s) failed.`)));
  console.log(fmt.dim("Most fixes: install missing tools, then run `selat init` again."));
  return 1;
}
