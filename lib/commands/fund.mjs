/**
 * `juris fund` — top up Circle Gateway balance.
 *
 * Thin wrapper around the runtime-integration-and-discovery skill's
 * `scripts/setup.mjs deposit` / `eco-deposit` commands, which handle the
 * Circle CLI deposit + confirmation phrase.
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt, prompt, promptYesNo } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

const ECO_SUPPORTED_CHAIN_ALIASES = new Set(["base", "8453", "eip155:8453"]);
const ECO_SUPPORTED_CHAIN_LABEL = "base by default (Base / Circle BASE / eip155:8453)";

export async function fund(args) {
  const skill = findSkill("setup.mjs");
  if (!skill.found) {
    console.error(fmt.error("agent-payment skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }

  const chainArg = arg(args, "--chain") || (await prompt("Chain", { default: "base" }));
  const amountArg = arg(args, "--amount") || (await prompt("USDC to deposit", { default: "2" }));
  const method = parseMethod(arg(args, "--method") || "direct");
  if (!method.ok) {
    console.error(fmt.error(method.reason));
    return 1;
  }

  const amount = Number(amountArg);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(fmt.error("--amount must be a positive number"));
    return 1;
  }

  const skillCommand = method.value === "eco" ? "eco-deposit" : "deposit";
  const methodLabel = method.value === "eco" ? "Eco gasless" : "direct";
  if (method.value === "eco" && !isEcoSupportedChain(chainArg)) {
    console.error(fmt.error(`Eco deposits currently support ${ECO_SUPPORTED_CHAIN_LABEL}.`));
    console.error(fmt.dim("Use `--chain base`, or omit `--method eco` for a direct Gateway deposit."));
    return 1;
  }
  if (method.value === "eco") {
    console.log(fmt.dim(`▸ Eco deposit support: ${ECO_SUPPORTED_CHAIN_LABEL}`));
    console.log(fmt.dim("▸ No ETH/native gas deposit is needed in the wallet for this gasless path."));
  }

  console.log(fmt.dim(`▸ dry-run first to show what will happen…`));
  const dryRun = await sh(
    "node",
    [
      join(skill.path, "scripts", "setup.mjs"),
      skillCommand,
      "--chain", chainArg,
      "--amount", String(amount)
    ],
    { inherit: true }
  );
  if (dryRun.code !== 0) return dryRun.code;

  const confirmed = await promptYesNo(
    `Proceed with ${methodLabel} deposit of ${amount} USDC on ${chainArg}?`,
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
      join(skill.path, "scripts", "setup.mjs"),
      skillCommand,
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

function parseMethod(method) {
  if (method === "direct" || method === "eco") return { ok: true, value: method };
  return { ok: false, reason: "--method must be `direct` or `eco`" };
}

function isEcoSupportedChain(chain) {
  return ECO_SUPPORTED_CHAIN_ALIASES.has(String(chain).toLowerCase());
}
