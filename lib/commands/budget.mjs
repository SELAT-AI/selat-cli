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
import { getAgentAddress, spendingBudget, spendingPolicy, policyFromBudget, describePolicy } from "../circle.mjs";
import { readFreeze, freezeStatusLine } from "./freeze.mjs";
import { formatUsd } from "../pricing.mjs";
import { selatPayLedger } from "../selat-pay-ledger.mjs";

// Session-budget file + ledger locations. Schema owner is selat-pay
// (sessionConfig/sessionSpentUsd in bin/selat-pay.mjs). The armed-check below
// stays a local sync read (seven sync call sites gate paid commands on it);
// the spend total is selat-pay's own function (sessionSpent → selat-pay-ledger).
function stateHome() {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}
export function sessionFilePath() {
  return process.env.SELAT_PAY_SESSION_PATH || join(stateHome(), "selat-pay", "session.json");
}
function ledgerPath() {
  return process.env.SELAT_PAY_HISTORY_PATH || join(stateHome(), "selat-pay", "gateway-history.jsonl");
}
/**
 * Session budget is armed only by `selat budget start` writing session.json.
 * `SELAT_SESSION_BUDGET` in process env (or cwd `.env`) cannot invent/arm
 * a budget — an agent that can set env must not pick the session total.
 * Env may still LOWER an already-armed file budget. Never reads cwd `.env`.
 */
export function readSessionConfig({ env = process.env, filePath = sessionFilePath() } = {}) {
  let file = null;
  try {
    const f = JSON.parse(readFileSync(filePath, "utf8"));
    const budgetUsd = Number(f.budgetUsd);
    if (Number.isFinite(budgetUsd) && budgetUsd > 0 && f.sessionId) {
      file = { budgetUsd, sessionId: String(f.sessionId), source: "file" };
    }
  } catch { /* none */ }
  if (!file) return null;

  const envBudget = Number(env.SELAT_SESSION_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0 && envBudget < file.budgetUsd) {
    return { budgetUsd: envBudget, sessionId: file.sessionId, source: "file+env" };
  }
  return file;
}
/**
 * Session spend exactly as selat-pay enforces it (selat-pay's own
 * sessionSpentUsd — see lib/selat-pay-ledger.mjs). null when the bundled
 * selat-pay can't be loaded; callers render that as unknown.
 */
export async function sessionSpent(sessionId, { path = ledgerPath() } = {}) {
  const ledger = await selatPayLedger();
  return ledger ? ledger.sessionSpentUsd(sessionId, { path }) : null;
}

const HELP = `${fmt.bold("selat budget")} — show spending caps + remaining budget (read-only)

${fmt.bold("Usage:")}
  selat budget [--json]
  selat budget start --amount <usd>   # arm a per-session spending tripwire
  selat budget start --amount <usd> --force   # change an armed budget (spend carries over)
  selat budget stop                   # disarm it

Paid calls (${fmt.cyan("selat run")}, ${fmt.cyan("selat skill run")},
compare --pay, verify --pay) refuse unless a session budget is armed
by ${fmt.cyan("selat budget start --amount <usd>")} writing session.json.
Process env ${fmt.cyan("SELAT_SESSION_BUDGET")} cannot invent that arm.
${fmt.cyan("selat freeze")} is the kill switch for fund + pay from this CLI.

The caps below are Circle wallet policy — the hard ceiling a runaway agent
cannot bypass. Set or change them with ${fmt.cyan("selat setup-policy")}.`;

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
    // Re-arming used to mint a fresh session id, silently resetting spend to $0
    // — an agent that hit "budget exhausted" could re-arm itself forever.
    // Replacing an armed session now needs --force and keeps its id, so the
    // spend so far carries over; only `selat budget stop` ends a session.
    const existing = readSessionConfig({ env: {}, filePath: file });
    if (existing) {
      const spent = await sessionSpent(existing.sessionId);
      const spentText = spent == null ? "unknown" : spendText(spent);
      if (!args.includes("--force")) {
        console.error(fmt.error(`a session budget is already armed: $${existing.budgetUsd} (${existing.sessionId}, ${spentText} spent)`));
        console.error(fmt.dim("  change its amount with --force (spend so far carries over), or end it first: selat budget stop"));
        return 1;
      }
      console.log(fmt.warn(`replacing the armed $${existing.budgetUsd} budget with $${amount}; ${spentText} already spent in ${existing.sessionId} carries over`));
    }
    mkdirSync(dirname(file), { recursive: true });
    const sessionId = existing ? existing.sessionId : `sess-${randomUUID().slice(0, 8)}`;
    writeFileSync(
      file,
      JSON.stringify({ schema: "selat-pay.session/v1", sessionId, budgetUsd: amount, startedAt: new Date().toISOString() }, null, 2) + "\n",
      { mode: 0o600 }
    );
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
  // --chain is an ADVANCED, internal query-routing arg (the Circle CLI wants
  // a --chain even for wallet-scoped reads). It is deliberately absent from
  // the help text and never rendered: the budget is part of the user's money
  // model, and the money model is chain-free.
  const chainIdx = args.indexOf("--chain");
  const chain = (chainIdx !== -1 && args[chainIdx + 1] ? args[chainIdx + 1] : "BASE").toUpperCase();

  const address = await getAgentAddress().catch(() => null);
  if (!address) {
    console.error(fmt.error("no agent wallet configured — run `selat init` first"));
    return 1;
  }
  const b = await spendingBudget(address, chain);
  // The budget surface is the truthful cap-state read (see spendingPolicy);
  // reuse the read we already have, fall back only when it was unreadable.
  const policy = policyFromBudget(b) ?? await spendingPolicy(address, chain);
  const summary = budgetUserSummary({ policy, budget: b });
  const session = readSessionConfig();
  const frozen = readFreeze();

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: b.readable || policy.readable,
      wallet: address,
      frozen: frozen ?? null,
      custom: !!policy.custom,
      limits: policy.limits ?? null,
      remaining: b.readable ? b.rows : null,
      session: session ? { ...session, spentUsd: await sessionSpent(session.sessionId) } : null,
      user_summary: frozen ? `${freezeStatusLine(frozen)} ${summary}` : summary
    }, null, 2) + "\n");
    return b.readable || policy.readable ? 0 : 1;
  }

  console.log(fmt.bold("\nSpending budget") + fmt.dim(`  wallet ${address}`));
  if (frozen) {
    console.log("  " + fmt.bold(fmt.red(freezeStatusLine(frozen))));
  }
  if (session) {
    const spent = await sessionSpent(session.sessionId);
    const left = spent == null ? null : Math.max(0, session.budgetUsd - spent);
    console.log(`  session  ${spent == null ? "unknown" : spendText(spent)} spent of $${session.budgetUsd} (${session.sessionId}, ${session.source}) — ${left == null ? "unknown" : spendText(left)} left`);
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
 * Confirmation-time spend line for money moments (`selat run` pre-payment,
 * `selat fund`'s plan): "session: $X spent of $Y" when a session budget is
 * armed, else null. Pure when session/spentUsd are injected — exported for
 * tests; callers use the zero-arg form.
 */
/**
 * If no session budget is armed, return the refuse payload for a paid call.
 * Armed = `selat budget start` writing session.json. Env / cwd `.env` cannot arm.
 * Returns null when a budget is present. Free discovery does not call this.
 */
export function missingSessionBudget({ env = process.env, filePath = sessionFilePath() } = {}) {
  if (readSessionConfig({ env, filePath })) return null;
  return {
    error:
      "no session budget armed — paid calls require `selat budget start --amount <usd>` before spending",
    hint:
      "Arm a session tripwire with `selat budget start --amount <usd>`. " +
      "`selat freeze` is the kill switch for fund + pay from this CLI.",
  };
}

// 4 fixed decimals rounded a $0.00705 session to "$0.0070", hiding sub-cent
// router fees. Keep at least 4 decimals but show up to 6 (USDC precision).
export function spendText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "$0.0000";
  const t = v.toFixed(6).replace(/0{1,2}$/, "");
  return `$${t}`;
}

export function sessionSpendLine({ session = readSessionConfig(), spentUsd } = {}) {
  if (!session) return null;
  return `session: ${spentUsd == null ? "unknown" : spendText(spentUsd)} spent of $${session.budgetUsd}`;
}

/** sessionSpendLine for the armed session with its live spend (callers' form). */
export async function liveSessionSpendLine() {
  const session = readSessionConfig();
  if (!session) return null;
  return sessionSpendLine({ session, spentUsd: await sessionSpent(session.sessionId) });
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
