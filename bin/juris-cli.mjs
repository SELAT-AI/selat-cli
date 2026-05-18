#!/usr/bin/env node
/**
 * juris-cli — setup helper + runner for Juris agent payments.
 *
 * Usage:
 *   juris-cli init
 *   juris-cli run "<intent>"
 *   juris-cli fund --chain base --amount 2
 *   juris-cli setup-policy
 *   juris-cli doctor
 */

import { init } from "../lib/commands/init.mjs";
import { run } from "../lib/commands/run.mjs";
import { doctor } from "../lib/commands/doctor.mjs";
import { fund } from "../lib/commands/fund.mjs";
import { setupPolicy } from "../lib/commands/setup-policy.mjs";
import { fmt } from "../lib/ui.mjs";

const USAGE = `${fmt.bold("juris-cli")} — agent payment setup helper

${fmt.bold("Commands:")}
  init                  Check Circle CLI auth, Agent Wallet, juris-pay, and config.
  run <intent>          Discover + rank + pay for an x402 service in one pipe.
  fund                  Top up your Circle Gateway balance.
  setup-policy          Set Circle spending limits (recommended before any deposit > $20).
  doctor                Diagnose setup problems (PATH, auth, wallet, drip status).

${fmt.bold("Options:")}
  --help, -h            Show this help.
  --version, -v         Show version.

${fmt.bold("Examples:")}
  juris-cli init
  juris-cli run "summarize the latest news on gold prices"
  juris-cli fund --chain base --amount 2
`;

const VERSION = "0.1.0";

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
    if (process.env.JURIS_DEBUG === "1" && err?.stack) console.error(err.stack);
    process.exit(1);
  });
