/**
 * `selat setup-policy` — set Circle wallet spending limits.
 *
 * Requires another email OTP from Circle (spending-policy writes are gated
 * by Circle's identity-verification flow that the agent cannot satisfy
 * silently). We can't bypass that, but we can guide the user.
 */

import { fmt, prompt } from "../ui.mjs";
import { sh } from "../sh.mjs";
import { getAgentAddress } from "../circle.mjs";

const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";

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
  let chain = "BASE";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chain") {
      const v = args[i + 1];
      if (v && !v.startsWith("--")) chain = v.toUpperCase();
    } else if (a.startsWith("--chain=")) {
      const v = a.slice("--chain=".length);
      if (v) chain = v.toUpperCase();
    }
  }
  return { chain };
}

export async function setupPolicy(args = []) {
  const { chain } = parseSetupPolicyArgs(args);
  const address = await getAgentAddress();
  if (!address) {
    console.error(fmt.error("No agent wallet found — run `selat init` first."));
    return 1;
  }

  console.log(fmt.bold("\nSet a spending policy on your Circle Agent Wallet"));
  console.log(fmt.dim("This caps how much the wallet can spend per tx / day / week / month."));
  console.log(fmt.dim("It's the only hard ceiling the agent literally cannot bypass."));
  console.log("");
  console.log(fmt.dim(`Wallet: ${address}`));
  console.log("");

  const perTx = await prompt("Per-transaction cap (USDC)", { default: "5" });
  const daily = await prompt("Daily cap (USDC)", { default: "50" });
  const weekly = await prompt("Weekly cap (USDC)", { default: "200" });
  const monthly = await prompt("Monthly cap (USDC)", { default: "500" });

  console.log("");
  console.log(fmt.warn("Circle will send a one-time code to your email."));
  console.log(fmt.dim("Enter the code at the prompt below. This is Circle's policy-write security layer."));
  console.log("");

  const code = await sh(
    CIRCLE_BIN,
    [
      "wallet", "limit", "set",
      "--address", address,
      "--chain", chain,
      "--policy-type", "stablecoin",
      "--per-tx", perTx,
      "--daily", daily,
      "--weekly", weekly,
      "--monthly", monthly
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
