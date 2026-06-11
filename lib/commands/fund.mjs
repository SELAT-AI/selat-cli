/**
 * `selat fund` — top up Circle Gateway balance.
 *
 * Thin wrapper around the selat-agent-payments skill's
 * `scripts/setup.mjs deposit` / `eco-deposit` commands, which handle the
 * Circle CLI deposit + confirmation phrase.
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt, prompt, promptYesNo } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

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
  if (method.value === "eco") {
    // The skill's `eco-deposit` is the source of truth for supported source
    // chains and settles into Gateway on Polygon; it rejects unsupported chains
    // during the dry-run below. We don't duplicate the allowlist here.
    console.log(fmt.dim("▸ Eco gasless deposit (no ETH/native gas needed); settles into Gateway on Polygon."));
  }

  // The skill's single-chain `deposit` / `eco-deposit` has no dry-run mode —
  // it deposits as soon as it's invoked (only `deposit-all` supports a
  // preview via --execute). So we show the plan locally and invoke setup.mjs
  // exactly once, after the user confirms, with the mainnet confirm phrase.
  console.log("");
  console.log(fmt.dim("Plan:"));
  console.log(`  method  ${methodLabel}`);
  console.log(`  chain   ${chainArg}`);
  console.log(`  amount  ${amount} USDC`);
  console.log("");

  const confirmed = await promptYesNo(
    `Proceed with ${methodLabel} deposit of ${amount} USDC on ${chainArg}?`,
    { default: false }
  );
  if (!confirmed) {
    console.log(fmt.dim("aborted"));
    return 0;
  }

  // The confirm phrase is required for mainnet deposits and ignored on
  // testnet chains; it matches the skill's expectedDepositConfirmation().
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
