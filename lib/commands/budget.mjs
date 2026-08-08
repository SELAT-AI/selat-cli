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
import { debugError, errorChain } from "../debug.mjs";
import { getAgentAddress, spendingBudget, spendingPolicy, policyFromBudget, describePolicy } from "../circle.mjs";
import { readFreeze, freezeStatusLine } from "./freeze.mjs";

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
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    // No file = no budget armed, which is the normal case. Anything else means
    // a tripwire the user believes is armed cannot be read, so say so instead
    // of reporting "no budget" — that silently removes a spending guard.
    if (err.code !== "ENOENT") {
      debugError("reading the session budget file", err);
      console.error(fmt.warn(`could not read the session budget at ${filePath} (${errorChain(err)}) — treating it as no budget armed`));
    }
    return null;
  }
  try {
    const f = JSON.parse(raw);
    const budgetUsd = Number(f.budgetUsd);
    if (Number.isFinite(budgetUsd) && budgetUsd > 0 && f.sessionId) return { budgetUsd, sessionId: String(f.sessionId), source: "file" };
    console.error(fmt.warn(`session budget file ${filePath} has no usable budget — treating it as no budget armed (re-arm: selat budget start --amount <usd>)`));
  } catch (err) {
    debugError("parsing the session budget file", err);
    console.error(fmt.warn(`session budget file ${filePath} is not valid JSON — treating it as no budget armed (re-arm: selat budget start --amount <usd>)`));
  }
  return null;
}
/**
 * Session spend plus what could not be read. Pure (no output) so callers decide
 * how to surface a partial read; `unreadable` means the total is 0 because the
 * ledger could not be opened, and `skipped` counts ledger lines that did not
 * parse. Either way the returned total UNDERSTATES real spend, so a caller
 * must not present it as authoritative.
 */
export function sessionSpentDetailed(sessionId, { path = ledgerPath() } = {}) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // An absent ledger means nothing has been paid yet — a true zero.
    if (err.code === "ENOENT") return { spent: 0, unreadable: false, skipped: 0, error: null };
    return { spent: 0, unreadable: true, skipped: 0, error: err };
  }
  let spent = 0;
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.sessionId === sessionId && Number.isFinite(Number(r.amountUsd))) spent += Number(r.amountUsd);
    } catch {
      skipped++;
    }
  }
  return { spent, unreadable: false, skipped, error: null };
}

/**
 * Session spend as a number, warning on stderr when the figure is incomplete.
 * The warning matters because this total is what a user compares against their
 * armed budget: a silent 0 from an unreadable ledger reads as "nothing spent".
 */
export function sessionSpent(sessionId, { path = ledgerPath() } = {}) {
  const r = sessionSpentDetailed(sessionId, { path });
  if (r.unreadable) {
    debugError("reading the selat-pay spend ledger", r.error);
    console.error(fmt.warn(`could not read the spend ledger at ${path} (${errorChain(r.error)}) — session spend is reported as $0 but may be higher`));
  } else if (r.skipped > 0) {
    console.error(fmt.warn(`skipped ${r.skipped} unparseable line(s) in the spend ledger at ${path} — session spend may be understated`));
  }
  return r.spent;
}

const HELP = `${fmt.bold("selat budget")} — show spending caps + remaining budget (read-only)

${fmt.bold("Usage:")}
  selat budget [--json]
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
  // --chain is an ADVANCED, internal query-routing arg (the Circle CLI wants
  // a --chain even for wallet-scoped reads). It is deliberately absent from
  // the help text and never rendered: the budget is part of the user's money
  // model, and the money model is chain-free.
  const chainIdx = args.indexOf("--chain");
  const chain = (chainIdx !== -1 && args[chainIdx + 1] ? args[chainIdx + 1] : "BASE").toUpperCase();

  // Distinguish "no wallet configured" from "looking it up failed": telling a
  // user to run `selat init` when Circle was simply unreachable sends them to
  // re-bootstrap a setup that is already correct.
  let lookupError = null;
  const address = await getAgentAddress().catch((err) => {
    lookupError = err;
    return null;
  });
  if (!address) {
    if (lookupError) {
      debugError("resolving the agent wallet address", lookupError);
      console.error(fmt.error(`could not resolve the agent wallet: ${errorChain(lookupError)}`));
      console.error(fmt.dim("Diagnose with `selat doctor`."));
    } else {
      console.error(fmt.error("no agent wallet configured — run `selat init` first"));
    }
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
      session: session ? { ...session, spentUsd: sessionSpent(session.sessionId) } : null,
      user_summary: frozen ? `${freezeStatusLine(frozen)} ${summary}` : summary
    }, null, 2) + "\n");
    return b.readable || policy.readable ? 0 : 1;
  }

  console.log(fmt.bold("\nSpending budget") + fmt.dim(`  wallet ${address}`));
  if (frozen) {
    console.log("  " + fmt.bold(fmt.red(freezeStatusLine(frozen))));
  }
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
 * Confirmation-time spend line for money moments (`selat run` pre-payment,
 * `selat fund`'s plan): "session: $X spent of $Y" when a session budget is
 * armed, else null. Pure when session/spentUsd are injected — exported for
 * tests; callers use the zero-arg form.
 */
export function sessionSpendLine({ session = readSessionConfig(), spentUsd } = {}) {
  if (!session) return null;
  const spent = spentUsd ?? sessionSpent(session.sessionId);
  return `session: $${spent.toFixed(4)} spent of $${session.budgetUsd}`;
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
