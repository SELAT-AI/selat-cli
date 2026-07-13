/**
 * `selat fund` — top up Circle Gateway balance.
 *
 * Thin wrapper around the selat-discovery skill's
 * `scripts/setup.mjs deposit` / `eco-deposit` commands, which handle the
 * Circle CLI deposit + confirmation phrase.
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt, prompt, promptYesNo, stdinIsInteractive } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import { getAgentAddress, spendingPolicy, describePolicy } from "../circle.mjs";
import { readConfig, configPath } from "../config.mjs";

export async function fund(args, { interactive = stdinIsInteractive() } = {}) {
  const skill = findSkill("setup.mjs");
  if (!skill.found) {
    console.error(fmt.error("agent-payment skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }

  const inputs = resolveFundInputs({ args, interactive });
  if (!inputs.ok) {
    console.error(fmt.error(inputs.error));
    return 1;
  }
  const chainArg = inputs.chain || (await prompt("Chain", { default: "base" }));
  const amountArg = inputs.amount || (await prompt("USDC to deposit", { default: "2" }));
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

  // Arc mainnet can't use the Circle agent wallet (the Circle CLI only knows
  // ARC-TESTNET), so the skill deposits to Arc with a raw EOA key + a private
  // RPC. Resolve those here (shell env wins, then the selat config .env) and
  // pass them through to setup.mjs.
  let depositEnv;
  if (chainArg.toLowerCase() === "arc") {
    const res = resolveArcDepositEnv({ method: method.value, config: await readConfig() });
    if (!res.ok) {
      console.error(fmt.error(res.error));
      if (res.missing) {
        console.error(fmt.dim("Arc mainnet can't use the Circle agent wallet — deposits use a raw EOA key + your private Arc RPC."));
        console.error(fmt.dim(`Set them in your shell or ${configPath()}.`));
      }
      return 1;
    }
    depositEnv = res.env;
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
  // Surface the wallet's spending policy at the money moment — the one hard
  // ceiling a runaway agent cannot bypass. Survey feedback says nobody
  // discovers `selat setup-policy` from docs alone, so the deposit plan is
  // where it must appear. Best-effort read; never blocks the deposit.
  const walletAddr = await getAgentAddress().catch(() => null);
  const policy = await spendingPolicy(walletAddr);

  console.log("");
  console.log(fmt.dim("Plan:"));
  console.log(`  method  ${methodLabel}`);
  console.log(`  chain   ${chainArg}`);
  console.log(`  amount  ${amount} USDC`);
  console.log(`  policy  ${describePolicy(policy)}`);
  console.log("");
  if (policy.readable && !policy.custom) {
    console.log(fmt.warn(
      amount > 20
        ? "this wallet has NO spending caps — strongly recommended before deposits over $20"
        : "this wallet has NO spending caps — a looping agent could spend the full balance"
    ));
    console.log(fmt.dim("  set the hard ceiling first (per-tx/daily/weekly/monthly): selat setup-policy"));
    console.log("");
  }

  let confirmed = inputs.confirmed;
  if (confirmed) {
    console.log(fmt.dim(`--yes: proceeding with ${methodLabel} deposit of ${amount} USDC on ${chainArg}.`));
  } else {
    confirmed = await promptYesNo(
      `Proceed with ${methodLabel} deposit of ${amount} USDC on ${chainArg}?`,
      { default: false }
    );
  }
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
    { inherit: true, ...(depositEnv ? { env: depositEnv } : {}) }
  )).code;
}

function arg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

/**
 * Resolve the deposit inputs up front so a non-interactive shell (agent
 * harness, CI, pipe) fails fast with instructions instead of stalling on a
 * prompt. Money moves here, so non-TTY runs must be fully explicit: both the
 * amount and a `--yes` consent flag are required; only the chain may default.
 * Interactive runs keep the existing prompt flow (`--yes` skips the
 * confirmation there too). `confirmed: null` means "ask via promptYesNo".
 */
export function resolveFundInputs({ args, interactive }) {
  const chain = arg(args, "--chain");
  const amount = arg(args, "--amount");
  const yes = args.includes("--yes") || args.includes("-y");
  if (interactive) return { ok: true, chain, amount, confirmed: yes || null };
  if (!amount) {
    return { ok: false, error: "no TTY to prompt for the deposit amount — re-run with --amount <usdc> (and --yes to confirm the deposit)" };
  }
  if (!yes) {
    return { ok: false, error: `a deposit needs explicit confirmation and this shell has no TTY — re-run with --yes to deposit ${amount} USDC on ${chain || "base"}` };
  }
  return { ok: true, chain: chain || "base", amount, confirmed: true };
}

function parseMethod(method) {
  if (method === "direct" || method === "eco") return { ok: true, value: method };
  return { ok: false, reason: "--method must be `direct` or `eco`" };
}

/**
 * Resolve the env a `--chain arc` deposit needs to pass through to setup.mjs.
 *
 * Arc mainnet can't use the Circle agent wallet, so the skill deposits with a
 * raw EOA key + a private RPC: SELAT_PRIVATE_KEY and ARC_RPC_URL. Shell env
 * wins over the selat config .env. Eco (gasless) isn't supported on Arc.
 *
 * Returns `{ ok: true, env }` or `{ ok: false, error, missing? }`. `missing`
 * is only set when the failure is unset credentials (so the caller can print
 * the how-to-fix hint); a rejected method has no `missing`.
 */
export function resolveArcDepositEnv({ method, config = {}, env = process.env } = {}) {
  if (method === "eco") {
    return { ok: false, error: "--method eco is not supported on Arc; use the default (direct)." };
  }
  const privateKey = env.SELAT_PRIVATE_KEY || config.SELAT_PRIVATE_KEY;
  const rpcUrl = env.ARC_RPC_URL || config.ARC_RPC_URL;
  const missing = [];
  if (!privateKey) missing.push("SELAT_PRIVATE_KEY");
  if (!rpcUrl) missing.push("ARC_RPC_URL");
  if (missing.length) {
    return { ok: false, error: `Arc deposits need ${missing.join(" and ")}.`, missing };
  }
  return { ok: true, env: { SELAT_PRIVATE_KEY: privateKey, ARC_RPC_URL: rpcUrl } };
}
