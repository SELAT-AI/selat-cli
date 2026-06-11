/**
 * `selat history` — show locally recorded Gateway micropayments.
 *
 * The canonical reader lives in the selat-agent-payments skill. This command
 * supplies the configured wallet address and delegates to that reader.
 */

import { join } from "node:path";
import { readConfig } from "../config.mjs";
import { sh } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

const USAGE = `${fmt.bold("selat history")} — show local Gateway micropayment history

${fmt.bold("Usage:")}
  selat history [--address 0x...] [--chain base] [--limit 20] [--json]

${fmt.bold("Options:")}
  --address <addr>   Wallet to filter by (default: SELAT_AGENT_WALLET_ADDRESS)
  --chain <key>      Chain key to filter by (e.g. base)
  --limit <n>        Number of records to show (default: 20)
  --json             Emit structured JSON
`;

export async function history(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const skill = findSkill("setup.mjs");
  if (!skill.found) {
    console.error(fmt.error("agent-payment skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }

  let opts;
  try {
    opts = parseArgs(args);
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
  const cfg = await readConfig();
  const address = opts.address || cfg.SELAT_AGENT_WALLET_ADDRESS;
  if (!address) {
    console.error(fmt.error("no wallet address configured"));
    console.error(fmt.dim("Run `selat init`, or pass --address 0x..."));
    return 1;
  }

  const setupArgs = [
    join(skill.path, "scripts", "setup.mjs"),
    "gateway-history",
    "--address", address,
    "--limit", String(opts.limit || 20),
  ];
  if (opts.chain) setupArgs.push("--chain", opts.chain);
  if (opts.json) setupArgs.push("--json");

  return (await sh("node", setupArgs, { inherit: true })).code;
}

function parseArgs(args) {
  const out = { address: null, chain: null, limit: 20, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--address" || arg === "--chain" || arg === "--limit") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--address") out.address = value;
      else if (arg === "--chain") out.chain = value;
      else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new Error("--limit must be a positive integer");
        out.limit = n;
      }
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return out;
}
