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
import { authStatus, getAgentAddress, gatewayBalance, hasCircle } from "../circle.mjs";
import { hasSelatPay } from "../selat-pay.mjs";
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
    const bal = await gatewayBalance(address);
    if (bal != null) {
      const fmtBal = bal.toFixed(6) + " USDC";
      if (bal >= 0.5) pass(`Gateway balance: ${fmtBal}`);
      else if (bal > 0) warn(`Gateway balance: ${fmtBal} (low — top up before heavy use)`);
      else warn("Gateway balance: 0 USDC (run `selat fund` or claim the welcome drip)");
    } else {
      warn("Gateway balance: could not read (Circle API issue or no wallet on the queried chain)");
    }
  } else {
    fail("no agent wallet found — run `selat init`");
  }

  // selat-pay
  console.log(fmt.bold("\nselat-pay:"));
  if (await hasSelatPay()) pass("selat-pay on PATH");
  else fail("selat-pay not on PATH — install or link selat-pay before running `selat run`");

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
