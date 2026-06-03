#!/usr/bin/env node
/**
 * selat — setup helper + runner for SELAT agent payments.
 *
 * Usage:
 *   selat init
 *   selat run "<intent>"
 *   selat fund --chain base --amount 2 [--method direct|eco]
 *   selat setup-policy
 *   selat doctor
 */

import { init } from "../lib/commands/init.mjs";
import { run } from "../lib/commands/run.mjs";
import { doctor } from "../lib/commands/doctor.mjs";
import { fund } from "../lib/commands/fund.mjs";
import { setupPolicy } from "../lib/commands/setup-policy.mjs";
import { skill } from "../lib/commands/skill.mjs";
import { fmt } from "../lib/ui.mjs";

const USAGE = `${fmt.bold("selat")} — agent payment setup helper

${fmt.bold("Commands:")}
  init                  Check skill, Circle auth, Agent Wallet, selat-pay, and config.
  run <intent>          Discover + rank + pay for an x402 service in one pipe.
  skill <list|run|…>    List, install, and run packaged Selat skills.
  fund                  Top up Gateway; --method eco gasless from Base, Optimism, or Arbitrum → Polygon.
  setup-policy          Set Circle spending limits (recommended before any deposit > $20).
  doctor                Diagnose setup problems (skill, PATH, auth, wallet, config).

${fmt.bold("Options:")}
  --help, -h            Show this help.
  --version, -v         Show version.

${fmt.bold("Examples:")}
  selat init
  selat run "summarize the latest news on gold prices"
  selat skill install market-snapshot && selat skill run market-snapshot
  selat fund --chain base --amount 2
  selat fund --chain optimism --amount 2 --method eco   # gasless (Base/Optimism/Arbitrum), no ETH gas needed
`;

const VERSION = "0.4.3";

async function main(argv) {
  const [, , cmd, ...rest] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }

  switch (cmd) {
    case "init":
      return await init(rest);
    case "run":
      return await run(rest);
    case "skill":
      return await skill(rest);
    case "fund":
      return await fund(rest);
    case "setup-policy":
      return await setupPolicy(rest);
    case "doctor":
      return await doctor(rest);
    default:
      console.error(fmt.error(`unknown command: ${cmd}`));
      console.error("");
      console.error(USAGE);
      return 1;
  }
}

main(process.argv)
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(fmt.error(`fatal: ${err?.message ?? err}`));
    if (process.env.SELAT_DEBUG === "1" && err?.stack) console.error(err.stack);
    process.exit(1);
  });
