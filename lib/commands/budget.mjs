/**
 * `selat budget` — show the wallet's spending caps and what's left in each
 * window. Read-only: the caps are Circle wallet policy (the one hard ceiling
 * the agent cannot bypass); change them with `selat setup-policy`.
 *
 * This command exists because users ask for a "budget circuit breaker" in
 * exactly those words — the capability is Circle policy, but nothing else in
 * the product answers to the word "budget".
 */

import { fmt } from "../ui.mjs";
import { getAgentAddress, spendingBudget, spendingPolicy, describePolicy } from "../circle.mjs";

const HELP = `${fmt.bold("selat budget")} — show spending caps + remaining budget (read-only)

${fmt.bold("Usage:")}
  selat budget [--chain BASE] [--json]

The caps are Circle wallet policy — the hard ceiling a runaway agent cannot
bypass. Set or change them with ${fmt.cyan("selat setup-policy")}.`;

export async function budget(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const jsonMode = args.includes("--json");
  const chainIdx = args.indexOf("--chain");
  const chain = (chainIdx !== -1 && args[chainIdx + 1] ? args[chainIdx + 1] : "BASE").toUpperCase();

  const address = await getAgentAddress().catch(() => null);
  if (!address) {
    console.error(fmt.error("no agent wallet configured — run `selat init` first"));
    return 1;
  }
  const b = await spendingBudget(address, chain);
  const policy = await spendingPolicy(address, chain);
  const summary = budgetUserSummary({ policy, budget: b });

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: b.readable || policy.readable,
      wallet: address,
      chain,
      custom: !!policy.custom,
      limits: policy.limits ?? null,
      remaining: b.readable ? b.rows : null,
      user_summary: summary
    }, null, 2) + "\n");
    return b.readable || policy.readable ? 0 : 1;
  }

  console.log(fmt.bold("\nSpending budget") + fmt.dim(`  wallet ${address} · ${chain}`));
  console.log("  " + describePolicy(policy));
  if (b.readable && b.rows.length) {
    for (const r of b.rows) {
      const rem = r.remaining != null ? `$${r.remaining} left` : "";
      const lim = r.limit != null ? `of $${r.limit}` : "";
      console.log(`    ${r.window.padEnd(8)} ${rem} ${lim}`.trimEnd());
    }
  }
  console.log("");
  console.log(fmt.dim(policy.custom
    ? "Change the caps: selat setup-policy (email OTP — Circle's policy-write security)"
    : "Set the caps:    selat setup-policy (email OTP — Circle's policy-write security)"));
  return b.readable || policy.readable ? 0 : 1;
}

/**
 * Relay-ready plain-language line (see the skill's "Talking To The User").
 * Exported for tests.
 */
export function budgetUserSummary({ policy, budget }) {
  if (!policy?.readable && !budget?.readable) {
    return "Could not read the wallet's spending caps right now.";
  }
  if (!policy?.custom) {
    return "This wallet has no spending caps set — any balance could be spent. Setting caps takes one step: selat setup-policy.";
  }
  const daily = (budget?.rows || []).find((r) => r.window === "daily");
  const capText = describePolicy(policy).replace(/^capped at /, "");
  const left = daily?.remaining != null && daily?.limit != null
    ? ` $${daily.remaining} of the $${daily.limit} daily budget is left today.`
    : "";
  return `Spending is capped at ${capText}.${left}`;
}
