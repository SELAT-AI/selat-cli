#!/usr/bin/env node
/**
 * selat — setup helper + runner for SELAT agent payments.
 *
 * Usage:
 *   selat init
 *   selat run "<intent>"
 *   selat fund --chain base --amount 2 [--method direct|eco] [--wait [--timeout <s>]] [--by-chain]
 *   selat setup-policy
 *   selat doctor
 */

import { init } from "../lib/commands/init.mjs";
import { run } from "../lib/commands/run.mjs";
import { search } from "../lib/commands/search.mjs";
import { doctor } from "../lib/commands/doctor.mjs";
import { fund } from "../lib/commands/fund.mjs";
import { history } from "../lib/commands/history.mjs";
import { spend } from "../lib/commands/spend.mjs";
import { budget } from "../lib/commands/budget.mjs";
import { freeze, unfreeze } from "../lib/commands/freeze.mjs";
import { setupPolicy } from "../lib/commands/setup-policy.mjs";
import { skill } from "../lib/commands/skill.mjs";
import { fmt } from "../lib/ui.mjs";
import { ensureHarnessPath } from "../lib/host.mjs";

const USAGE = `${fmt.bold("selat")} — agent payment setup helper

${fmt.bold("Commands:")}
  init                  Check skill, Circle auth, Agent Wallet, selat-pay, and config.
  search <intent>       Discover + rank endpoints (FREE; no wallet, no spend).
                        --capability <name> scopes to a labeled capability.
  run <intent>          Discover + rank + pay for an x402 service in one pipe.
                        --dry-run shows the pick + price + command without paying.
                        --capability <name> scopes ranking to a labeled capability.
  skill <list|run|compare|…> List, install, run, author (new/validate) Selat skills;
                        compare probes catalog candidates for an intent side-by-side (FREE).
  fund                  Top up your Gateway balance. --wait blocks until the
                        deposit is spendable (credits take ~5–10 min); --method eco sources from
                        Base (gasless; Circle CLI ≥1.0.0's eco coverage). Offers a browser QR when
                        the wallet is empty. --by-chain shows the per-chain routing detail
                        (default: one number).
  history               Show locally recorded Gateway micropayments.
  spend                 Unified spend report: settled spend + Apify token utilization (read-only).
  budget                Show spending caps + remaining budget (read-only; caps are set via setup-policy).
  freeze                Local kill switch: refuse fund + pay from this CLI (--note "<why>").
  unfreeze              Resume fund + pay after a freeze.
  setup-policy          Set Circle spending limits (recommended before any deposit > $20).
  doctor                Diagnose setup problems (skill, PATH, auth, wallet, config).

${fmt.bold("Options:")}
  --help, -h            Show this help.
  --version, -v         Show version.

${fmt.bold("Examples:")}
  selat init
  selat search "enrich a person by name and company"   # free discovery, no spend
  selat skill compare "search the web" --limit 3        # probe candidates side-by-side, free
  selat run "summarize the latest news on gold prices"
  selat skill install twitter-profile-lookup && selat skill run twitter-profile-lookup --handle openai
  selat history
  selat fund --chain base --amount 2 --wait             # block until the deposit is spendable
  selat fund --chain base --amount 2 --method eco       # gasless (Base is the only eco source), no ETH gas needed
`;

const VERSION = "0.16.11";

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

  // Make `selat` resolvable in harnesses that don't persist the hook's PATH/env
  // (e.g. OpenClaw). Best-effort + idempotent + a no-op off those hosts. Riding the
  // runner means existing installs get this on the next session — see lib/host.mjs.
  ensureHarnessPath();

  switch (cmd) {
    case "init":
      return await init(rest);
    case "search":
      return await search(rest);
    case "run":
      return await run(rest);
    case "skill":
      return await skill(rest);
    case "fund":
      return await fund(rest);
    case "history":
      return await history(rest);
    case "budget":
      return await budget(rest);
    case "freeze":
      return await freeze(rest);
    case "unfreeze":
      return await unfreeze(rest);
    case "spend":
      return await spend(rest);
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
  // exitCode (not process.exit): a hard exit drops piped stdout past ~64KB,
  // truncating large --json payloads mid-write. Setting exitCode lets Node
  // flush both streams and exit when the event loop drains.
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((err) => {
    console.error(fmt.error(`fatal: ${err?.message ?? err}`));
    if (process.env.SELAT_DEBUG === "1" && err?.stack) console.error(err.stack);
    process.exitCode = 1;
  });
