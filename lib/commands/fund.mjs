/**
 * `juris fund` — top up Circle Gateway balance.
 *
 * Thin wrapper around the runtime-integration-and-discovery skill's
 * `scripts/setup.mjs deposit` command, which handles the Circle CLI
 * deposit + confirmation phrase.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sh } from "../sh.mjs";
import { fmt, prompt, promptYesNo } from "../ui.mjs";

const SKILL_PATH = process.env.JURIS_SKILL_PATH ||
  join(homedir(), ".claude", "skills", "runtime-integration-and-discovery");

export async function fund(args) {
  if (!existsSync(join(SKILL_PATH, "scripts", "setup.mjs"))) {
    console.error(fmt.error("Skill not found at " + SKILL_PATH));
    console.error(fmt.dim("Install the discovery skill or set JURIS_SKILL_PATH to its location."));
    return 1;
  }

  const chainArg = arg(args, "--chain") || (await prompt("Chain", { default: "base" }));
  const amountArg = arg(args, "--amount") || (await prompt("USDC to deposit", { default: "2" }));
  const amount = Number(amountArg);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(fmt.error("--amount must be a positive number"));
    return 1;
  }

  console.log(fmt.dim(`▸ dry-run first to show what will happen…`));
  const dryRun = await sh(
    "node",
    [
      join(SKILL_PATH, "scripts", "setup.mjs"),
      "deposit",
      "--chain", chainArg,
      "--amount", String(amount)
    ],
    { inherit: true }
  );
  if (dryRun.code !== 0) return dryRun.code;

  const confirmed = await promptYesNo(
    `Proceed with depositing ${amount} USDC on ${chainArg}?`,
    { default: false }
  );
  if (!confirmed) {
    console.log(fmt.dim("aborted"));
    return 0;
  }

  // Real deposit with explicit confirm phrase
  const phrase = `deposit ${amount} USDC`;
  return (await sh(
    "node",
    [
      join(SKILL_PATH, "scripts", "setup.mjs"),
      "deposit",
      "--chain", chainArg,
      "--amount", String(amount),
      "--confirm", phrase
    ],
    { inherit: true }
  )).code;
}

function arg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}
