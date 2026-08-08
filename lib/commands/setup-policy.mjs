/**
 * `selat setup-policy` — set Circle wallet spending limits.
 *
 * Requires another email OTP from Circle (spending-policy writes are gated
 * by Circle's identity-verification flow that the agent cannot satisfy
 * silently). We can't bypass that, but we can guide the user: caps are
 * accepted as flags so everything up to the OTP is scriptable, and a shell
 * with no TTY gets a copyable, pre-filled command instead of a prompt crash.
 */

import { fmt, prompt, stdinIsInteractive } from "../ui.mjs";
import { sh } from "../sh.mjs";
import { CIRCLE_BIN, getAgentAddress } from "../circle.mjs";

const CAP_FLAGS = [
  ["perTx", "--per-tx", "Per-transaction cap (USDC)", "5"],
  ["daily", "--daily", "Daily cap (USDC)", "50"],
  ["weekly", "--weekly", "Weekly cap (USDC)", "200"],
  ["monthly", "--monthly", "Monthly cap (USDC)", "500"],
];

export const SETUP_POLICY_HELP = `Usage: selat setup-policy [options]

Set Circle wallet spending limits — the hard ceiling the agent cannot bypass.
Circle emails a one-time code to confirm the write; entering it needs an
interactive terminal (Circle's policy-write security layer, not ours).

Options:
  --per-tx <usd>    Per-transaction cap (prompt default: 5)
  --daily <usd>     Daily cap (prompt default: 50)
  --weekly <usd>    Weekly cap (prompt default: 200)
  --monthly <usd>   Monthly cap (prompt default: 500)
  --chain <CODE>    Advanced: route the policy write via a specific chain
                    (default BASE; caps themselves are wallet-scoped).
  -h, --help        Show this help. Never prompts, never writes.

With all four caps given as flags, the prompts are skipped and the only
interactive step left is Circle's emailed code.`;

/**
 * Parse setup-policy args. Pure and exported for tests.
 *
 * The Circle CLI requires a --chain on the policy write, but the chain is
 * write routing, not part of the policy the user is setting: the caps are
 * wallet-scoped and the user's money model is chain-free (see
 * spendingPolicy() in lib/circle.mjs). So the interactive flow never asks
 * about chains — the write routes via BASE silently — and `--chain <CODE>`
 * exists only as an advanced escape hatch (both `--chain X` and `--chain=X`
 * forms; a following flag is not a value).
 */
export function parseSetupPolicyArgs(args = []) {
  const out = { chain: "BASE", help: false, caps: {}, unknown: [] };
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

  // The OTP at the end always needs a terminal — Circle's constraint, not
  // ours. In a non-TTY shell, fail fast with a paste-ready command (caps
  // pre-filled from whatever was given) instead of throwing mid-prompt.
  if (!stdinIsInteractive()) {
    const filled = CAP_FLAGS
      .map(([key, flag, , dflt]) => `${flag} ${parsed.caps[key] ?? dflt}`)
      .join(" ");
    console.error(fmt.err("setup-policy needs an interactive terminal — Circle emails a one-time code that must be typed at a prompt."));
    console.error("Run this in a terminal (caps pre-filled; adjust as needed):");
    console.error(`  selat setup-policy ${filled}`);
    return 1;
  }

  const address = await getAgentAddress();
  if (!address) {
    console.error(fmt.err("No agent wallet found — run `selat init` first."));
    return 1;
  }

  console.log(fmt.bold("\nSet a spending policy on your Circle Agent Wallet"));
  console.log(fmt.dim("This caps how much the wallet can spend per tx / day / week / month."));
  console.log(fmt.dim("It's the only hard ceiling the agent literally cannot bypass."));
  console.log("");
  console.log(fmt.dim(`Wallet: ${address}`));
  console.log("");

  // Flags skip their prompt; anything missing is asked for interactively.
  const caps = { ...parsed.caps };
  for (const [key, , label, dflt] of CAP_FLAGS) {
    if (!(key in caps)) caps[key] = await prompt(label, { default: dflt });
  }

  console.log("");
  console.log(fmt.warn("Circle will send a one-time code to your email."));
  console.log(fmt.dim("Enter the code at the prompt below. This is Circle's policy-write security layer."));
  console.log("");

  const code = await sh(
    CIRCLE_BIN,
    [
      "wallet", "limit", "set",
      "--address", address,
      "--chain", parsed.chain,
      "--policy-type", "stablecoin",
      "--per-tx", String(caps.perTx),
      "--daily", String(caps.daily),
      "--weekly", String(caps.weekly),
      "--monthly", String(caps.monthly)
    ],
    { inherit: true }
  );

  if (code.code === 0) {
    console.log(fmt.ok("policy set"));
    return 0;
  }
  console.error(fmt.err("policy set failed — try running the Circle CLI directly"));
  return code.code;
}
