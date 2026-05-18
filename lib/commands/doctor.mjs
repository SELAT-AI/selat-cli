/**
 * `juris-cli doctor` — diagnose setup problems. Single pass through:
 *   - Node / npm / git version
 *   - Circle CLI installed + authed
 *   - Agent wallet exists
 *   - Gateway balance
 *   - juris-pay installed
 *   - ~/.config/juris-pay/.env present and valid
 *   - Router URL reachable
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fmt } from "../ui.mjs";
import { sh, hasBin, binVersion } from "../sh.mjs";
import { authStatus, getAgentAddress, gatewayBalance, hasCircle } from "../circle.mjs";
import { hasJurisPay } from "../juris-pay.mjs";
import { readConfig, configPath } from "../config.mjs";

const SKILL_PATH = process.env.JURIS_SKILL_PATH ||
  join(homedir(), ".claude", "skills", "runtime-integration-and-discovery");

export async function doctor() {
  console.log(fmt.bold("\njuris-cli doctor — checking your setup"));
  console.log("");

  let failures = 0;
  const fail = (msg) => { failures++; console.log("  " + fmt.err(msg)); };
  const pass = (msg) => console.log("  " + fmt.ok(msg));
  const warn = (msg) => console.log("  " + fmt.warn(msg));

  // Binaries
  console.log(fmt.bold("Binaries:"));
  for (const bin of ["node", "npm", "git", "jq"]) {
    const v = await binVersion(bin);
    if (v) pass(`${bin} ${v}`);
    else fail(`${bin} not on PATH`);
  }

  // Circle CLI
  console.log(fmt.bold("\nCircle CLI:"));
  if (await hasCircle()) {
    pass("circle binary on PATH");
    const status = await authStatus();
    if (status.authed) pass(`authenticated${status.email ? " as " + status.email : ""}`);
    else fail("not authenticated — run `juris-cli init`");
  } else {
    fail("circle CLI not installed — install Circle CLI, then run `juris-cli init`");
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
      else warn("Gateway balance: 0 USDC (run `juris-cli fund` or claim the welcome drip)");
    } else {
      warn("Gateway balance: could not read (Circle API issue or no wallet on the queried chain)");
    }
  } else {
    fail("no agent wallet found — run `juris-cli init`");
  }

  // juris-pay
  console.log(fmt.bold("\njuris-pay:"));
  if (await hasJurisPay()) pass("juris-pay on PATH");
  else fail("juris-pay not on PATH — install or link juris-pay before running `juris-cli run`");

  // Config file
  console.log(fmt.bold("\nConfig:"));
  const cfg = await readConfig();
  if (Object.keys(cfg).length === 0) {
    fail(`${configPath()} missing or empty — run \`juris-cli init\``);
  } else {
    pass(`${configPath()} present`);
    if (cfg.JURIS_ROUTER_URL) pass(`JURIS_ROUTER_URL=${cfg.JURIS_ROUTER_URL}`);
    else warn("JURIS_ROUTER_URL not set");
    if (cfg.JURIS_AGENT_WALLET_ADDRESS) pass(`JURIS_AGENT_WALLET_ADDRESS=${cfg.JURIS_AGENT_WALLET_ADDRESS}`);
    else warn("JURIS_AGENT_WALLET_ADDRESS not set");
    if (cfg.JURIS_ROUTER_URL && !cfg.JURIS_ROUTER_URL.startsWith("https://")) {
      warn("Router URL is not https:// — MITM possible. Replace when production router is available.");
    }
  }

  // Router reachable
  if (cfg.JURIS_ROUTER_URL) {
    console.log(fmt.bold("\nRouter reachability:"));
    const r = await sh("curl", ["-sS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", `${cfg.JURIS_ROUTER_URL}/healthz`]).catch(() => null);
    if (r && r.stdout.trim() === "200") pass(`${cfg.JURIS_ROUTER_URL}/healthz returns 200`);
    else fail(`${cfg.JURIS_ROUTER_URL} unreachable or returned ${r?.stdout?.trim() || "(curl error)"}`);
  }

  // Skill installed
  console.log(fmt.bold("\nSkill:"));
  if (existsSync(join(SKILL_PATH, "scripts", "rank.mjs"))) pass(`runtime-integration-and-discovery at ${SKILL_PATH}`);
  else warn(`skill not at ${SKILL_PATH}; \`juris-cli run\` won't work until installed`);

  // Summary
  console.log("");
  if (failures === 0) {
    console.log(fmt.bold(fmt.green("All checks passed.")));
    return 0;
  }
  console.log(fmt.bold(fmt.red(`${failures} check(s) failed.`)));
  console.log(fmt.dim("Most fixes: install missing tools, then run `juris-cli init` again."));
  return 1;
}
