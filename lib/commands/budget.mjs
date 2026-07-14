/**
 * `selat budget` — show the wallet's spending caps and what's left in each
 * window. Read-only: the caps are Circle wallet policy (the one hard ceiling
 * the agent cannot bypass); change them with `selat setup-policy`.
 *
 * This command exists because users ask for a "budget circuit breaker" in
 * exactly those words — the capability is Circle policy, but nothing else in
 * the product answers to the word "budget".
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fmt } from "../ui.mjs";
import { getAgentAddress, spendingBudget, spendingPolicy, describePolicy } from "../circle.mjs";

// Session-budget file + ledger locations. Schema owner is selat-pay
// (sessionConfig/sessionSpentUsd in bin/selat-pay.mjs) — these tiny readers
// mirror it so `selat budget` can display state without spawning a process.
function stateHome() {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}
export function sessionFilePath() {
  return process.env.SELAT_PAY_SESSION_PATH || join(stateHome(), "selat-pay", "session.json");
}
function ledgerPath() {
  return process.env.SELAT_PAY_HISTORY_PATH || join(stateHome(), "selat-pay", "gateway-history.jsonl");
}
export function readSessionConfig({ env = process.env, filePath = sessionFilePath() } = {}) {
  const envBudget = Number(env.SELAT_SESSION_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0) {
    return { budgetUsd: envBudget, sessionId: env.SELAT_SESSION_ID || `day:${new Date().toISOString().slice(0, 10)}`, source: "env" };
  }
  try {
    const f = JSON.parse(readFileSync(filePath, "utf8"));
    const budgetUsd = Number(f.budgetUsd);
    if (Number.isFinite(budgetUsd) && budgetUsd > 0 && f.sessionId) return { budgetUsd, sessionId: String(f.sessionId), source: "file" };
  } catch { /* none */ }
  return null;
}
export function sessionSpent(sessionId, { path = ledgerPath() } = {}) {
  let spent = 0;
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return 0; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.sessionId === sessionId && Number.isFinite(Number(r.amountUsd))) spent += Number(r.amountUsd);
    } catch { /* skip */ }
  }
  return spent;
}

const HELP = `${fmt.bold("selat budget")} — show spending caps + remaining budget (read-only)

${fmt.bold("Usage:")}
  selat budget [--chain BASE] [--json]
  selat budget start --amount <usd>   # arm a per-session spending tripwire
  selat budget stop                   # disarm it

The caps are Circle wallet policy — the hard ceiling a runaway agent cannot
bypass. Set or change them with ${fmt.cyan("selat setup-policy")}.`;

export async function budget(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  // `selat budget start --amount 2` arms a session budget (file-based, so it
  // survives agent harnesses where every tool call is a fresh shell);
  // `selat budget stop` disarms it. Enforcement happens in selat-pay,
  // pre-signature, on every paid call.
  if (args[0] === "start") {
    const i = args.indexOf("--amount");
    const amount = Number(i !== -1 ? args[i + 1] : args[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error(fmt.error("usage: selat budget start --amount <usd>"));
      return 1;
    }
    const file = sessionFilePath();
    mkdirSync(dirname(file), { recursive: true });
    const sessionId = `sess-${randomUUID().slice(0, 8)}`;
    writeFileSync(file, JSON.stringify({ schema: "selat-pay.session/v1", sessionId, budgetUsd: amount, startedAt: new Date().toISOString() }, null, 2) + "\n");
    console.log(fmt.ok(`session budget armed: $${amount} (${sessionId})`));
    console.log(fmt.dim("  every paid call now counts against it; over-budget calls are refused before signing"));
    console.log(fmt.dim("  disarm: selat budget stop · check: selat budget"));
    return 0;
  }
  if (args[0] === "stop") {
    const file = sessionFilePath();
    if (existsSync(file)) { rmSync(file); console.log(fmt.ok("session budget disarmed")); }
    else console.log(fmt.dim("no session budget was armed"));
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
  const session = readSessionConfig();

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: b.readable || policy.readable,
      wallet: address,
      chain,
      custom: !!policy.custom,
      limits: policy.limits ?? null,
      remaining: b.readable ? b.rows : null,
      session: session ? { ...session, spentUsd: sessionSpent(session.sessionId) } : null,
      user_summary: summary
    }, null, 2) + "\n");
    return b.readable || policy.readable ? 0 : 1;
  }

  console.log(fmt.bold("\nSpending budget") + fmt.dim(`  wallet ${address} · ${chain}`));
  if (session) {
    const spent = sessionSpent(session.sessionId);
    const left = Math.max(0, session.budgetUsd - spent);
    console.log(`  session  $${spent.toFixed(4)} spent of $${session.budgetUsd} (${session.sessionId}, ${session.source}) — $${left.toFixed(4)} left`);
  } else {
    console.log(fmt.dim("  session  no budget armed — arm one: selat budget start --amount 2"));
  }
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
