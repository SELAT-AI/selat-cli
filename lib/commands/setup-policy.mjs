/**
 * `selat setup-policy` — set Circle wallet spending limits.
 *
 * Circle stores STABLECOIN_TRANSFER policies PER (wallet, chain) and its
 * signing service enforces whichever policy governs the SOURCE chain of a
 * transfer (verified live 2026-08-11 — see spendingPolicy() in
 * lib/circle.mjs). A cap written to one chain leaves every other chain on
 * Circle's account default (typically $100/mo), so the default here is to
 * apply the caps to EVERY mainnet chain the wallet exists on; `--chain`
 * scopes to one.
 *
 * Each per-chain write is confirmed with its own email OTP: the Circle CLI
 * mints an ephemeral human-entity JWT per `wallet limit set` invocation and
 * discards it after the single write (verified in the CLI source,
 * withEphemeralHumanSession) — there is no batch write and no way to reuse
 * one code across chains. We can't bypass that, but we can be honest about
 * it up front: the plan says how many codes are coming before the first one
 * is sent. `wallet limit set` also FAILS where a custom policy already
 * exists, so chains with different existing caps get a `wallet limit reset`
 * (its own OTP) before the set.
 */

import { fmt, prompt, promptYesNo, stdinIsInteractive } from "../ui.mjs";
import { sh } from "../sh.mjs";
import {
  getAgentAddress,
  listAgentWalletsDetailed,
  chainsForAddress,
  spendingPolicyByChain,
  describeChainPolicy
} from "../circle.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

const CAP_FLAGS = [
  ["perTx", "--per-tx", "Per-transaction cap (USDC)", "5"],
  ["daily", "--daily", "Daily cap (USDC)", "50"],
  ["weekly", "--weekly", "Weekly cap (USDC)", "200"],
  ["monthly", "--monthly", "Monthly cap (USDC)", "500"],
];

export const SETUP_POLICY_HELP = `Usage: selat setup-policy [options]

Set Circle wallet spending limits — the hard ceiling the agent cannot bypass.
Circle stores spending policies PER CHAIN and enforces the policy of the chain
a payment is signed on, so this applies your caps to every mainnet chain the
wallet exists on (a chain left out stays on Circle's default, typically
$100/mo). Circle confirms each per-chain write with its own emailed one-time
code — there is no batch write — and entering the codes needs an interactive
terminal (Circle's policy-write security layer, not ours).

Options:
  --per-tx <usd>    Per-transaction cap (prompt default: 5)
  --daily <usd>     Daily cap (prompt default: 50)
  --weekly <usd>    Weekly cap (prompt default: 200)
  --monthly <usd>   Monthly cap (prompt default: 500)
  --chain <CODE>    Cap only this one chain (e.g. BASE, ARB) instead of every
                    chain the wallet exists on — one emailed code instead of N.
  -h, --help        Show this help. Never prompts, never writes.

With all four caps given as flags, the prompts are skipped and the only
interactive steps left are Circle's emailed codes.`;

/**
 * Parse setup-policy args. Pure and exported for tests.
 *
 * `chain: null` means "every mainnet chain the wallet exists on" (the
 * default — caps are per-chain, so partial coverage is the bug this command
 * exists to prevent). `--chain <CODE>` scopes the run to one chain (both
 * `--chain X` and `--chain=X` forms; a following flag is not a value).
 */
export function parseSetupPolicyArgs(args = []) {
  const out = { chain: null, help: false, caps: {}, unknown: [] };
  const capByFlag = new Map(CAP_FLAGS.map(([key, flag]) => [flag, key]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") { out.help = true; continue; }
    if (a === "--chain") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) { out.chain = v.toUpperCase(); i++; }
      continue;
    }
    if (a.startsWith("--chain=")) {
      const v = a.slice("--chain=".length);
      if (v) out.chain = v.toUpperCase();
      continue;
    }
    const eq = a.indexOf("=");
    const flagName = eq > 0 ? a.slice(0, eq) : a;
    if (capByFlag.has(flagName)) {
      const value = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (eq < 0 && value !== undefined && !String(value).startsWith("--")) i++;
      out.caps[capByFlag.get(flagName)] = value;
      continue;
    }
    out.unknown.push(a);
  }
  return out;
}

/** A cap must be a positive finite number; returns the error string or null. */
export function capValueError(flag, value) {
  if (value === undefined || value === "" || String(value).startsWith("--")) {
    return `${flag} needs a value (USDC amount)`;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return `${flag} must be a positive number, got "${value}"`;
  return null;
}

/**
 * Do a chain's existing limits already equal the requested caps? Pure and
 * exported for tests. `caps` values arrive as strings (flags/prompts).
 */
export function sameCaps(limits, caps) {
  return [["perTx", "perTx"], ["daily", "daily"], ["weekly", "weekly"], ["monthly", "monthly"]]
    .every(([lk, ck]) => {
      const want = Number(caps?.[ck]);
      return Number.isFinite(want) && limits?.[lk] === want;
    });
}

/**
 * Plan the per-chain writes for a spendingPolicyByChain() result. Pure and
 * exported for tests. Returns [{ chain, action, otps, reason }] where action
 * is:
 *   - "skip"      — a CUSTOM policy with exactly these caps already governs
 *   - "set"       — no custom policy governs (DEFAULT or unreadable): one
 *                   `wallet limit set` write, one emailed code
 *   - "reset+set" — a DIFFERENT custom policy exists; Circle's `limit set`
 *                   refuses to overwrite, so `limit reset` first (each write
 *                   is its own emailed code: two total)
 */
export function planPolicyWrites({ rows, caps }) {
  return (rows ?? []).map((row) => {
    if (row.readable && row.origin === "CUSTOM") {
      if (sameCaps(row.limits, caps)) {
        return { chain: row.chain, action: "skip", otps: 0, reason: "already capped at these values" };
      }
      return {
        chain: row.chain,
        action: "reset+set",
        otps: 2,
        reason: "different custom caps exist — Circle requires a reset before a new set"
      };
    }
    return {
      chain: row.chain,
      action: "set",
      otps: 1,
      reason: row.readable ? "on Circle DEFAULT" : "policy state unreadable — attempting the write"
    };
  });
}

/** Total emailed codes a plan will cost. Pure and exported for tests. */
export function plannedOtpCount(plan) {
  return (plan ?? []).reduce((sum, p) => sum + (p.otps ?? 0), 0);
}

export async function setupPolicy(args = []) {
  const parsed = parseSetupPolicyArgs(args);

  // Help is inert: no wallet lookup, no prompts, no Circle spawn. Previously
  // `--help` fell through to the interactive flow, where four Enter presses
  // wrote a real spending policy.
  if (parsed.help) {
    console.log(SETUP_POLICY_HELP);
    return 0;
  }
  if (parsed.unknown.length) {
    console.error(fmt.err(`unknown option: ${parsed.unknown[0]}`));
    console.log(SETUP_POLICY_HELP);
    return 1;
  }

  // Validate any provided caps before touching the wallet or the network.
  for (const [key, flag] of CAP_FLAGS) {
    if (key in parsed.caps) {
      const err = capValueError(flag, parsed.caps[key]);
      if (err) {
        console.error(fmt.err(err));
        return 1;
      }
    }
  }

  // The OTPs always need a terminal — Circle's constraint, not ours. In a
  // non-TTY shell, fail fast with a paste-ready command (caps pre-filled
  // from whatever was given) instead of throwing mid-prompt.
  if (!stdinIsInteractive()) {
    const filled = CAP_FLAGS
      .map(([key, flag, , dflt]) => `${flag} ${parsed.caps[key] ?? dflt}`)
      .join(" ");
    console.error(fmt.err("setup-policy needs an interactive terminal — Circle emails a one-time code for each per-chain policy write that must be typed at a prompt."));
    console.error("Run this in a terminal (caps pre-filled; adjust as needed):");
    console.error(`  selat setup-policy ${filled}`);
    return 1;
  }

  const address = await getAgentAddress();
  if (!address) {
    console.error(fmt.err("No agent wallet found — run `selat init` first."));
    return 1;
  }

  // Resolve the chains to cap: --chain scopes to one; the default is every
  // mainnet chain the wallet exists on, discovered live — writing to a chain
  // the wallet isn't on would just fail at Circle.
  let chains;
  if (parsed.chain) {
    chains = [parsed.chain];
  } else {
    const discovered = await listAgentWalletsDetailed().catch(() => ({ wallets: [] }));
    chains = chainsForAddress(discovered.wallets, address);
    if (!chains.length) {
      console.error(fmt.err("could not discover which chains this wallet exists on — scope the write explicitly: selat setup-policy --chain <CODE>"));
      return 1;
    }
  }

  console.log(fmt.bold("\nSet a spending policy on your Circle Agent Wallet"));
  console.log(fmt.dim("This caps how much the wallet can spend per tx / day / week / month."));
  console.log(fmt.dim("It's the only hard ceiling the agent literally cannot bypass."));
  console.log(fmt.dim("Caps are PER CHAIN: a chain left out keeps Circle's default (typically $100/mo)."));
  console.log("");
  console.log(fmt.dim(`Wallet: ${address}`));
  console.log(fmt.dim(`Chains: ${chains.join(", ")}${parsed.chain ? " (scoped by --chain)" : " (every chain the wallet exists on)"}`));
  console.log("");

  // Flags skip their prompt; anything missing is asked for interactively.
  const caps = { ...parsed.caps };
  for (const [key, , label, dflt] of CAP_FLAGS) {
    if (!(key in caps)) caps[key] = await prompt(label, { default: dflt });
  }

  // Read each chain's current policy (free, no OTP) so the plan can skip
  // chains already carrying these caps and warn where a reset is needed.
  const rows = await spendingPolicyByChain(address, { chains });
  const plan = planPolicyWrites({ rows, caps });
  const writes = plan.filter((p) => p.action !== "skip");
  const otpTotal = plannedOtpCount(plan);

  console.log("");
  console.log(fmt.bold("Plan:"));
  for (const p of plan) {
    const row = rows.find((r) => r.chain === p.chain);
    console.log(`  ${p.chain.padEnd(6)} ${p.action.padEnd(9)} — ${p.reason}`);
    console.log(fmt.dim(`         now: ${describeChainPolicy(row)}`));
  }
  if (!writes.length) {
    console.log("");
    console.log(fmt.ok(`all ${plan.length} chain(s) already carry these caps — nothing to write`));
    return 0;
  }

  console.log("");
  console.log(fmt.warn(`Circle will email ${otpTotal} separate one-time code(s) — one per policy write.`));
  console.log(fmt.dim("Per-chain writes each need their own code (Circle's policy-write security layer;"));
  console.log(fmt.dim("there is no batch write). To cap a single chain: selat setup-policy --chain <CODE>."));
  console.log("");

  const proceed = await promptYesNo(
    `Proceed with ${writes.length} chain write(s) (${otpTotal} emailed code(s))?`,
    { default: true }
  );
  if (!proceed) {
    console.log(fmt.dim("aborted — no policies were changed"));
    return 0;
  }

  const results = [];
  let writeNo = 0;
  for (const p of writes) {
    writeNo++;
    console.log("");
    console.log(fmt.bold(`— ${p.chain} (chain ${writeNo} of ${writes.length}) —`));
    if (p.action === "reset+set") {
      console.log(fmt.dim(`resetting ${p.chain}'s existing custom policy first (Circle refuses to overwrite; this write has its own emailed code)…`));
      const reset = await sh(
        CIRCLE_BIN,
        ["wallet", "limit", "reset", "--address", address, "--chain", p.chain, "--yes"],
        { inherit: true }
      );
      if (reset.code !== 0) {
        console.error(fmt.err(`reset failed on ${p.chain} — skipping this chain`));
        results.push({ chain: p.chain, ok: false });
        continue;
      }
    }
    const set = await sh(
      CIRCLE_BIN,
      [
        "wallet", "limit", "set",
        "--address", address,
        "--chain", p.chain,
        "--policy-type", "stablecoin",
        "--per-tx", String(caps.perTx),
        "--daily", String(caps.daily),
        "--weekly", String(caps.weekly),
        "--monthly", String(caps.monthly)
      ],
      { inherit: true }
    );
    results.push({ chain: p.chain, ok: set.code === 0 });
    if (set.code !== 0) console.error(fmt.err(`policy set failed on ${p.chain}`));
  }

  console.log("");
  const failed = results.filter((r) => !r.ok);
  const okChains = results.filter((r) => r.ok).map((r) => r.chain);
  const skipped = plan.filter((p) => p.action === "skip").map((p) => p.chain);
  if (okChains.length) console.log(fmt.ok(`policy set on ${okChains.join(", ")}`));
  if (skipped.length) console.log(fmt.dim(`already capped (skipped): ${skipped.join(", ")}`));
  if (failed.length) {
    console.error(fmt.err(`failed on ${failed.map((r) => r.chain).join(", ")} — those chains still enforce their previous policy.`));
    console.error(fmt.dim(`Retry a single chain: selat setup-policy --chain ${failed[0].chain} ${CAP_FLAGS.map(([k, f]) => `${f} ${caps[k]}`).join(" ")}`));
    return 1;
  }
  return 0;
}
