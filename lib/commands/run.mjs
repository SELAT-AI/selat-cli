/**
 * `selat run <intent>` — discover + rank + pay in one pipe.
 *
 * Equivalent to:
 *   node scripts/rank.mjs "<intent>" --pick
 *   # validate the selected selat-pay command, then spawn it directly
 *
 * For v0 this expects the agent-payment skill to be installed locally.
 * If it isn't found, prints install instructions and exits.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sh, shellQuoteForDisplay } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import { ensureSelatPayHistoryDir, resolveSelatPay, selatPaySpawn } from "../selat-pay.mjs";
import { egressLikelyBlocked, sandboxHintText } from "../host.mjs";
import { safeHttpUrl } from "../url-safety.mjs";
import {
  applyParamsToPayArgs,
  applyParamsToUrl,
  missingPlanParams,
  paramRetryLine,
  parseParamFlags,
  replanUrlParams,
  remainingPathPlaceholders,
} from "../run-params.mjs";
import { missingSessionBudget, sessionSpendLine } from "./budget.mjs";
import { frozenMoneyMove } from "./freeze.mjs";
import { stdinIsInteractive } from "../ui.mjs";
import {
  ALLOW_HIGH_MAX_AMOUNT_FLAG,
  APIFY_PREPAID_TOKEN_USD,
  HARD_CLI_MAX_AMOUNT_USD,
  authorizeExplicitMaxAmount,
} from "../spend-guard.mjs";

const RUN_USAGE = `usage: selat run "<intent>" [--capability <name>] [--endpoint <url> [--method <verb>]] [--max-amount <usd>] [${ALLOW_HIGH_MAX_AMOUNT_FLAG}] [--dry-run] [--live-probe] [--param key=value ...] [--input '<json>' | --input-file <path>] [--auto-rebuy] [--json] [--verbose]`;

// Every flag `selat run` understands. Kept as data so the unknown-flag error
// can list them and tests can pin the set.
export const KNOWN_RUN_FLAGS = ["--dry-run", "--live-probe", "--param", "--input", "--input-file", "--auto-rebuy", "--endpoint", "--method", "--capability", "--max-amount", ALLOW_HIGH_MAX_AMOUNT_FLAG, "--json", "--verbose"];

// Conservative per-call ceiling. Catalog exec_hints are untrusted; a hint
// above this is clamped. An explicit --max-amount is ALSO clamped to this
// for everyone — isTTY and --allow-high-max-amount cannot raise it. Same $1
// bound as skill-registry's manifest ceiling and skill compare --pay.
export const DEFAULT_RUN_MAX_AMOUNT_USD = HARD_CLI_MAX_AMOUNT_USD;

/**
 * Parse `selat run` argv into options + intent. Pure and unit-testable.
 *
 * --input / --input-file carry Actor input for an Apify pick, and --auto-rebuy
 * (Apify picks ONLY) opts into buying a replacement token if the current one
 * drains mid-run — it's a no-op / warned for any other service, which is
 * per-call x402 with no token to replace. --param key=value (repeatable)
 * fills endpoint path/query/body params (validated by parseParamFlags at the
 * call site, where the error can be worded per pair).
 *
 * --endpoint <url> pins the exact endpoint instead of letting the intent choose
 * it, with --method to disambiguate a URL listed under several verbs. Both are
 * forwarded to rank.mjs, which resolves the pin against the federated catalog
 * and refuses a URL that is not listed. Use it to pay the endpoint you were
 * quoted: re-ranking an intent can otherwise resolve to a different endpoint at
 * a different price, because catalog services are merged and one service can
 * span unrelated capabilities.
 *
 * --capability <name> is Layer 0 passthrough to rank.mjs: scope ranking to
 * endpoints labeled with that capability. Discovery refuses an unknown name or
 * an empty labeled pool rather than silently widening. This CLI does not
 * interpret the name — omitted, the flag is not forwarded, so unscoped ranking
 * stays today's default.
 *
 * Unknown --flags are an ERROR, not intent tokens: `run` spends real money, and
 * silently dropping a flag like --dry-run means paying when the user asked not
 * to (tester feedback round 2).
 */
export function parseRunArgs(args) {
  const opts = { inputInline: undefined, inputFile: undefined, autoRebuy: false, dryRun: false, liveProbe: false, jsonMode: false, verbose: false, rawParams: [], endpoint: undefined, method: undefined, capability: undefined, maxAmount: undefined, allowHighMaxAmount: false };
  const intentTokens = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Help must be inert (fund/setup-policy learned this the hard way): with
    // no guard, `-h` didn't start with "--" and became the INTENT — entering
    // the rank->pick->pay pipeline on the highest-stakes command.
    if (a === "-h" || a === "--help") return { ok: true, help: true };
    if (a === "--input" || a === "--input-file") {
      const value = args[++i];
      // A flag-looking token is a missing value, not a value: `--input
      // --dry-run` used to swallow --dry-run as the JSON and then PAY.
      if (value == null || value.startsWith("--")) {
        return { ok: false, error: `${a} requires a value${value != null ? ` (got flag-like ${value})` : ""}` };
      }
      if (a === "--input") opts.inputInline = value;
      else opts.inputFile = value;
      continue;
    }
    if (a === "--param") {
      const value = args[++i];
      if (value == null || value.startsWith("--")) return { ok: false, error: "--param requires a key=value argument" };
      opts.rawParams.push(value);
      continue;
    }
    if (a === "--endpoint" || a === "--method" || a === "--capability" || a === "--max-amount") {
      const value = args[++i];
      if (value == null || value.startsWith("--")) {
        return { ok: false, error: `${a} requires a value${value != null ? ` (got flag-like ${value})` : ""}` };
      }
      if (a === "--endpoint") opts.endpoint = value;
      else if (a === "--method") opts.method = value;
      else if (a === "--capability") opts.capability = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          return { ok: false, error: `--max-amount "${value}" must be a positive number` };
        }
        opts.maxAmount = n;
      }
      continue;
    }
    if (a === "--auto-rebuy") { opts.autoRebuy = true; continue; }
    if (a === ALLOW_HIGH_MAX_AMOUNT_FLAG) { opts.allowHighMaxAmount = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--live-probe") { opts.liveProbe = true; continue; }
    if (a === "--json") { opts.jsonMode = true; continue; }
    if (a === "--verbose") { opts.verbose = true; continue; }
    if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag ${a} — known flags: ${KNOWN_RUN_FLAGS.join(", ")}` };
    }
    intentTokens.push(a);
  }
  return { ok: true, ...opts, intent: intentTokens.join(" ").trim() };
}

/**
 * Extra argv forwarding a pin to rank.mjs. --method is meaningless without
 * --endpoint (there is nothing to disambiguate), so it is dropped rather than
 * passed through to become a confusing downstream error.
 */
export function pinArgs({ endpoint, method } = {}) {
  if (!endpoint) return [];
  return ["--endpoint", endpoint, ...(method ? ["--method", method] : [])];
}

/**
 * Extra argv forwarding Layer 0 `--capability` to rank.mjs. Omitted when the
 * flag is absent so unscoped ranking stays today's default. The name is passed
 * through as-is: discovery refuses unknown names and empty labeled pools.
 */
export function capabilityArgs({ capability } = {}) {
  if (!capability) return [];
  return ["--capability", capability];
}

/**
 * rank.mjs argv after the script path for `selat run`'s pick step. The single
 * seam tests pin so --live-probe / --endpoint / --capability cannot drift from
 * the spawn.
 */
export function rankPickArgv({ intent, liveProbe = false, endpoint, method, capability } = {}) {
  return [
    intent,
    "--pick",
    ...(liveProbe ? ["--live-probe"] : []),
    ...pinArgs({ endpoint, method }),
    ...capabilityArgs({ capability }),
  ];
}

/**
 * Map rank.mjs's pin-specific exit codes to an honest error.
 *
 * rank.mjs exits 4 when a pinned URL is not in the federated catalog (or the
 * method does not match) and 5 when the pinned endpoint fails the payment-layer
 * reliability check. Both are deliberate refusals that charge nothing — folding
 * them into a generic "rank.mjs failed" would tell a caller their setup is
 * broken when in fact the pin was honoured. Returns null for any other code,
 * and for an unpinned run, where these codes carry no such meaning.
 */
export function pinRefusal(code, endpoint) {
  if (!endpoint) return null;
  if (code === 4) {
    return {
      reason: "endpoint-not-in-catalog",
      error: "the pinned endpoint is not in the federated catalog — nothing was charged",
    };
  }
  if (code === 5) {
    return {
      reason: "endpoint-unreliable",
      error: "the pinned endpoint failed the payment-layer reliability check — nothing was charged, and no substitute was paid",
    };
  }
  return null;
}

/**
 * Emit a failure honestly in BOTH modes. --json callers are machines: every
 * error path must put a parseable {ok:false, error} on stdout, not prose on
 * stderr with an empty stdout (which JSON.parse("") turns into a crash at the
 * caller). verifyCmd set this contract; run now follows it.
 */
function emitRunError({ jsonMode, error, extra = {}, hints = [] }) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error, ...extra }));
  } else {
    console.error(fmt.error(error));
    for (const h of hints) console.error(h);
  }
  return 1;
}

export async function run(args) {
  const parsedArgs = parseRunArgs(args);
  if (!parsedArgs.ok) {
    // jsonMode may not have parsed; honor a --json anywhere in argv.
    return emitRunError({
      jsonMode: args.includes("--json"),
      error: parsedArgs.error,
      hints: [fmt.dim(RUN_USAGE)],
    });
  }
  if (parsedArgs.help) {
    // Inert by construction: no skill lookup, no rank, no selat-pay resolve.
    console.log(RUN_USAGE);
    console.log("");
    console.log("Flags:");
    console.log("  --dry-run             Print the selected paid command without executing it");
    console.log("  --live-probe          Allow plan-time endpoint/schema probing; it may invoke the target method/body");
    console.log("  --param key=value     Fill endpoint path/query/body params (repeatable)");
    console.log("  --input '<json>'      Inline Actor input (Apify picks)");
    console.log("  --input-file <path>   Actor input from a JSON file");
    console.log("  --auto-rebuy          Apify only: buy a replacement token if it drains mid-run");
    console.log("  --endpoint <url>      Pay this exact endpoint instead of letting the intent");
    console.log("                        pick one. Must be in the federated catalog; an unlisted");
    console.log("                        URL is refused, never paid. Use it to pay the endpoint");
    console.log("                        you were quoted — re-ranking can otherwise resolve to a");
    console.log("                        different endpoint at a different price.");
    console.log("  --method <verb>       Disambiguate --endpoint when one URL is listed under");
    console.log("                        several methods");
    console.log("  --capability <name>   Rank only endpoints labeled with this capability");
    console.log("                        (Layer 0). Unknown names and empty labeled pools");
    console.log("                        are refused, never silently widened.");
    console.log("  --max-amount <usd>    Per-call spend ceiling, applied last-wins after the");
    console.log(`                        catalog hint is validated. Hard CLI ceiling $${HARD_CLI_MAX_AMOUNT_USD}`);
    console.log("                        even when the flag is explicit. isTTY and agent harnesses");
    console.log(`                        cannot exceed $${HARD_CLI_MAX_AMOUNT_USD} (Apify prepaid token $${APIFY_PREPAID_TOKEN_USD}`);
    console.log("                        is a documented exception for that token only)");
    console.log(`  ${ALLOW_HIGH_MAX_AMOUNT_FLAG}`);
    console.log("                        Accepted for compatibility; does not raise the $1 ceiling");
    console.log("                        (isTTY is not a human gate)");
    console.log("  --json                Machine-readable output");
    console.log("  --verbose             Show rank/pay diagnostics");
    console.log("  -h, --help            Show this help. Never ranks, never pays.");
    return 0;
  }
  const { intent, inputInline, inputFile, autoRebuy, dryRun, liveProbe, jsonMode, verbose, rawParams, endpoint, method, capability, maxAmount, allowHighMaxAmount } = parsedArgs;
  if (!intent) {
    return emitRunError({ jsonMode, error: "an intent is required", hints: [fmt.dim(RUN_USAGE)] });
  }
  // Refuse a YOLO 999 before ranking. The $1-vs-$1.05 Apify exception is
  // decided after the pick, so a 1.05 flag is not judged here (that would
  // be a generic hole if we allowed it on every x402 call, and a false
  // refuse if we blocked it on Apify). Anything above the prepaid token
  // cannot be payable even on Apify.
  if (maxAmount != null && maxAmount > APIFY_PREPAID_TOKEN_USD) {
    return emitRunError({
      jsonMode,
      // Name the bound this branch actually tests. It refuses above $1.05, not
      // above $1 — quoting the $1 ceiling here sends the reader to a value that
      // is then refused for the opposite reason ("below the prepaid-token
      // price"), which reads as a contradiction with no payable value.
      error:
        `--max-amount ${maxAmount} exceeds $${APIFY_PREPAID_TOKEN_USD}, the most any single call can require ` +
        `(the hard CLI ceiling is $${HARD_CLI_MAX_AMOUNT_USD}; $${APIFY_PREPAID_TOKEN_USD} is the documented ` +
        `Apify prepaid-token exception, and is the only value an Apify Actor accepts) — nothing was charged`,
    });
  }

  if (!dryRun) {
    const unarmed = missingSessionBudget();
    if (unarmed) {
      return emitRunError({ jsonMode, error: unarmed.error, hints: [fmt.dim(unarmed.hint)] });
    }
  }

  const parsedParams = parseParamFlags(rawParams);
  if (!parsedParams.ok) {
    return emitRunError({ jsonMode, error: parsedParams.error });
  }
  const params = parsedParams.params;

  const skill = findSkill("rank.mjs");
  if (!skill.found) {
    return emitRunError({
      jsonMode,
      error: "agent-payment skill not found",
      hints: ["", ...skillInstallLines(skill.path).map((l) => fmt.cyan(l))],
    });
  }

  const selatPay = await resolveSelatPay();
  if (selatPay.source === null) {
    return emitRunError({ jsonMode, error: "selat-pay not found — reinstall selat-cli, or install selat-pay globally." });
  }

  if (!jsonMode) console.log(fmt.dim(`▸ ranking intent: "${intent}"`));

  // Step 1: pick
  const pick = await sh(
    "node",
    [join(skill.path, "scripts", "rank.mjs"), ...rankPickArgv({ intent, liveProbe, endpoint, method, capability })]
  );
  if (pick.code !== 0) {
    // A pin refusal is not a rank failure — it is rank.mjs doing its job, and a
    // caller (especially a machine) needs to tell them apart. Nothing is ever
    // charged on these paths.
    const refusal = pinRefusal(pick.code, endpoint);
    if (refusal) {
      return emitRunError({
        jsonMode,
        error: refusal.error,
        extra: { reason: refusal.reason, endpoint, ...(method ? { method } : {}), detail: (pick.stderr || "").trim().slice(0, 2000) },
        hints: [pick.stderr],
      });
    }
    const blocked = await egressLikelyBlocked();
    return emitRunError({
      jsonMode,
      error: "rank.mjs failed",
      extra: { detail: (pick.stderr || pick.stdout || "").trim().slice(0, 2000) },
      hints: [pick.stderr || pick.stdout, ...(blocked ? ["\n" + fmt.dim(sandboxHintText())] : [])],
    });
  }

  // Step 2: parse and validate the selected execution hint.
  let plan;
  try {
    plan = JSON.parse(pick.stdout);
  } catch {
    return emitRunError({ jsonMode, error: "rank.mjs returned invalid JSON" });
  }

  // Apify uses the prepaid-token model, not per-call x402. The rank pick carries
  // paymentModel "apify-prepaid-token", but its selat-pay hint would (wrongly) pay
  // the Actor endpoint's own x402. Intercept and route to the prepaid-token flow:
  // ensure a token (buy via the Router if needed), then call the Actor with the
  // Bearer token. The token PURCHASE is itself a plain selat-pay Gateway-batched
  // call to {ROUTER}/apify/prepaid-token, so selat-pay needs no change.
  if (isApifyPrepaidPick(plan)) {
    if (params.length > 0) {
      console.error(fmt.warn("--param applies to query/body params of x402 endpoints; Apify Actor input goes via --input. Ignoring --param."));
    }
    return await runApifyPrepaid({
      plan, skill, selatPay, inputInline, inputFile, autoRebuy, intent, dryRun, jsonMode, verbose,
      maxAmount, allowHighMaxAmount,
    });
  }

  // --auto-rebuy is reserved for Apify prepaid-token picks (it re-buys a drained
  // token). Every other service is per-call x402, where there is no token to
  // replace — so if the top pick isn't Apify, say so instead of silently eating it.
  if (autoRebuy) {
    console.error(fmt.warn("--auto-rebuy applies only to Apify prepaid-token picks; ignoring it for this service."));
  }

  // A pick can be refused because a successful call needs params the indexed
  // URL doesn't carry (requiresPathParams since discovery 0.10.0,
  // requiresQueryParams since 0.11). With --param values we re-plan the pick
  // through the skill's own buildPaymentPlan (its cap ceiling + chain logic
  // stay authoritative); without them, say exactly which params are needed
  // and print the retry line.
  const missing = missingPlanParams(plan);
  if (missing.length > 0 && params.length > 0) {
    const replanned = await replanWithParams({ plan, skill, intent, params });
    if (!replanned.ok) {
      return reportMissingParams({ plan, intent, jsonMode, missing: replanned.missing ?? missing, reason: replanned.reason });
    }
    plan = replanned.plan;
  } else if (missing.length > 0) {
    return reportMissingParams({ plan, intent, jsonMode, missing });
  }

  const hint = plan?.exec_hints?.[0];
  const parsed = parseSelatPayHint(hint);
  if (!parsed.ok) {
    console.error(fmt.error("no runnable selat-pay command in pick output"));
    if (parsed.reason) console.error(fmt.dim(parsed.reason));
    console.error(fmt.dim("This usually means the top match has no routable payment terms."));
    console.error(fmt.dim("Try --payable-now or inspect the live 402 manually."));
    return 1;
  }

  let { args: selatPayArgs, display } = parsed;
  // --param on a runnable pick: substitute path placeholders and set query /
  // body params on the validated selat-pay argv. (After a re-plan the URL
  // already carries the values; applying again is idempotent — query keys are
  // replaced, not duplicated.) Applied BEFORE the --dry-run guard so a dry
  // run previews the exact with-params command that would be paid.
  if (params.length > 0) {
    const applied = applyParamsToPayArgs(selatPayArgs, params, plan);
    if (!applied.ok) {
      console.error(fmt.error(`could not apply --param values: ${applied.reason}`));
      return 1;
    }
    selatPayArgs = applied.args;
    display = ["selat-pay", ...selatPayArgs].map(shellQuoteForDisplay).join(" ");
  }

  // Last-wins ceiling AFTER hint validation (and any --param rewrite).
  // Catalog hints can carry a hostile second --max-amount; selat-pay is
  // last-wins, so we strip every prior cap and append exactly one.
  const authorized = await authorizeRunMaxAmount({ maxAmount, allowHighMaxAmount, jsonMode, apifyPrepaid: false });
  if (!authorized.ok) {
    return emitRunError({ jsonMode, error: authorized.error, hints: authorized.hint ? [fmt.dim(authorized.hint)] : [] });
  }
  const capped = applyRunMaxAmountCeiling(selatPayArgs, {
    explicit: authorized.capUsd,
    allowHigh: authorized.allowHigh,
    interactive: stdinIsInteractive() && !jsonMode,
  });
  if (!capped.ok) {
    return emitRunError({ jsonMode, error: capped.reason });
  }
  selatPayArgs = capped.args;
  display = ["selat-pay", ...selatPayArgs].map(shellQuoteForDisplay).join(" ");

  // --dry-run stops HERE: the pick is ranked and the selat-pay command is
  // validated (with any --param values already applied), but nothing is
  // signed or sent. This is the last line before money moves, so the guard
  // lives at the spawn boundary, not in the parser.
  if (dryRun) {
    return printDryRun({
      intent,
      plan,
      command: display,
      exec: payExecTuple(selatPay, selatPayArgs),
      jsonMode,
    });
  }

  const frozen = frozenMoneyMove("pay");
  if (frozen) {
    return emitRunError({ jsonMode, error: frozen.error, hints: [fmt.dim(frozen.hint)] });
  }

  if (!jsonMode) {
    // Confirmation-time visibility: when a session budget is armed, show the
    // running total right where the money is about to move.
    const spendLine = sessionSpendLine();
    if (spendLine) console.log(fmt.dim(`▸ ${spendLine}`));
    console.log(fmt.dim(`▸ running: ${display}`));
    console.log("");
  }

  // Step 3: execute without a shell. selatPaySpawn runs the resolved binary
  // directly (process.execPath + bin path) for env-override/bundled, so PATH
  // can't substitute a different selat-pay; only "global" goes through PATH.
  const { cmd, args: spawnArgs } = selatPaySpawn(selatPay, selatPayArgs);
  await ensureSelatPayHistoryDir();
  // Capture instead of inheriting: selat-pay's stdout is the response payload;
  // its stderr is wire diagnostics (quotes, payTo, signing domains) that read
  // as noise to a non-technical user. Humans get a one-line receipt plus the
  // payload; --json gets one machine object with a relay-ready user_summary;
  // diagnostics surface only with --verbose or on failure.
  const run = await sh(cmd, spawnArgs, { inherit: false });
  const svcName = plan?.service?.name || "the service";
  const priceText = receiptPriceText(plan?.minAmountUsd);
  if (run.code !== 0) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        ok: false,
        intent,
        service: svcName,
        exitCode: run.code,
        user_summary: `The paid call to ${svcName} failed before returning a result — check selat spend to confirm nothing was charged.`,
        stderr: (run.stderr || "").trim()
      }, null, 2) + "\n");
      return run.code;
    }
    if (run.stderr) console.error(run.stderr.trim());
    console.error(fmt.err(`payment to ${svcName} failed (exit ${run.code})`));
    return run.code;
  }
  const rawBody = (run.stdout || "").trim();
  let response = rawBody;
  try { response = JSON.parse(rawBody); } catch { /* non-JSON upstream body */ }
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: true,
      intent,
      service: svcName,
      priceUsd: plan?.minAmountUsd ?? null,
      user_summary: `Paid ${priceText} to ${svcName} from the user's wallet; the result is in the response field.`,
      response
    }, null, 2) + "\n");
    return 0;
  }
  if (verbose && run.stderr) console.error(fmt.dim(run.stderr.trim()));
  console.log(fmt.ok(`paid ${priceText} to ${svcName} — settled from your wallet (details: selat spend)`));
  // DISPLAY ONLY: surface the endpoint's Transactability Index from the captured
  // selat-pay stderr. Informational — the payment above has already settled, and
  // this never gates or blocks anything. "unmeasured" when no health data.
  console.log(fmt.dim(`▸ ${transactabilityLineFromStderr(run.stderr)}`));
  console.log("");
  console.log(rawBody);
  return 0;
}

/**
 * Human dollar text for a receipt line. Catalog prices are floor hints; when
 * the plan has none (e.g. pay-per-event), say so instead of inventing a number.
 */
export function receiptPriceText(amountUsd) {
  if (amountUsd == null) return "the live-quoted price";
  const n = Number(amountUsd);
  return `~$${n >= 0.01 ? n.toFixed(2) : String(n)}`;
}

// --- Transactability Index (STI), DISPLAY ONLY -----------------------------
//
// At pay time selat-pay emits its captured stderr diagnostics, one line of
// which is `[selat-pay] extensions={...selatTransactabilityIndex...}`. We parse
// that block out of run.stderr and print a one-line, informational summary so
// the human can see the endpoint's recent payment health right where they paid.
//
// This is DISPLAY ONLY: nothing here gates, thresholds, or blocks a payment —
// the payment has already settled by the time this prints. Absence of the block
// means "unknown/unmeasured", never a bad/negative badge.
//
// The formatter is intentionally a small local copy rather than an import from
// selat-pay, to keep this PR self-contained (see #167). It SHOULD later be
// replaced by selat-pay's shared formatter once #63 lands.

// paidNum is a confidence weight: below this many captured payments the window's
// successRate is too thin to trust, so we annotate the line rather than drop it.
const TI_CONFIDENCE_MIN_PAID = 5;

// successRate arrives as a fraction (0..1) or a percentage (0..100). Normalize
// to an integer percent for display; return null when it isn't a finite number.
function toTransactabilityPercent(successRate) {
  const n = Number(successRate);
  if (!Number.isFinite(n)) return null;
  const p = n <= 1 ? n * 100 : n;
  return Math.round(p);
}

/**
 * Pull the `selatTransactabilityIndex.info.healthStatus` block out of captured
 * selat-pay stderr. Returns the healthStatus object, or null when the line is
 * absent or unparseable (both mean "unmeasured" downstream).
 *
 * Brace-matched (not a greedy regex) so it survives whether selat-pay prints
 * the extensions object on one line or across several.
 */
export function parseTransactabilityIndex(stderr) {
  if (!stderr || typeof stderr !== "string") return null;
  const marker = stderr.indexOf("extensions=");
  if (marker === -1) return null;
  const start = stderr.indexOf("{", marker);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < stderr.length; i++) {
    const c = stderr[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;
  let ext;
  try { ext = JSON.parse(stderr.slice(start, end)); } catch { return null; }
  const hs = ext?.selatTransactabilityIndex?.info?.healthStatus;
  return (hs && typeof hs === "object") ? hs : null;
}

/**
 * One-line human summary of a healthStatus block. Same field derivation and
 * semantics as issue #63's formatter: window key + successRate% + paidNum +
 * lastPaid.status, and "unmeasured" when the block (or its data) is absent.
 *
 * DISPLAY ONLY — this string is never a gate signal or a pass/fail badge.
 */
export function formatTransactabilityLine(healthStatus) {
  const LABEL = "Transactability Index";
  if (!healthStatus || typeof healthStatus !== "object") return `${LABEL}: unmeasured`;

  const parts = [];
  // stats is a SINGLE most-recent window keyed by 24h | 7d | all (or {} = none).
  const stats = healthStatus.stats;
  let windowKey = null, windowStats = null;
  if (stats && typeof stats === "object" && !Array.isArray(stats)) {
    const keys = Object.keys(stats);
    if (keys.length > 0) { windowKey = keys[0]; windowStats = stats[windowKey]; }
  }
  if (windowKey && windowStats && typeof windowStats === "object") {
    // successRate is transport-level ("delivered 2xx"), not content quality.
    const pct = toTransactabilityPercent(windowStats.successRate);
    parts.push(pct != null ? `${windowKey} · ${pct}% delivered 2xx` : `${windowKey}`);
    const paidNum = Number(windowStats.paidNum);
    if (Number.isFinite(paidNum)) {
      const thin = paidNum < TI_CONFIDENCE_MIN_PAID ? " (low confidence)" : "";
      parts.push(`${paidNum} paid${thin}`);
    }
  }
  // lastPaid = { status, timestamp } or {}. Shown as-is, never scored.
  const lastPaid = healthStatus.lastPaid;
  if (lastPaid && typeof lastPaid === "object" && lastPaid.status != null) {
    parts.push(`last paid ${lastPaid.status}`);
  }
  return parts.length ? `${LABEL}: ${parts.join(" · ")}` : `${LABEL}: unmeasured`;
}

/**
 * Convenience: parse captured selat-pay stderr and format it in one step. Always
 * returns a printable line (the "unmeasured" state when the block is absent).
 */
export function transactabilityLineFromStderr(stderr) {
  return formatTransactabilityLine(parseTransactabilityIndex(stderr));
}

/**
 * The machine-executable half of a --dry-run plan, x402 path.
 *
 * Wraps selatPaySpawn so the tuple a dry run advertises is produced by the very
 * function the paid path spawns with — the two cannot drift.
 */
export function payExecTuple(selatPay, selatPayArgs) {
  const spawn = selatPaySpawn(selatPay, selatPayArgs);
  return { runner: "selat-pay", cmd: spawn.cmd, argv: spawn.args };
}

/**
 * The same, for the Apify prepaid-token path, which runs a skill script under
 * node and needs SELAT_PAY_BIN pointed at the resolved selat-pay (the token
 * PURCHASE is itself a selat-pay call).
 */
export function apifyExecTuple({ skillPath, selatPay, runArgs }) {
  return {
    runner: "apify-token",
    cmd: "node",
    argv: [join(skillPath, "scripts", "apify_token.mjs"), ...runArgs],
    env: { SELAT_PAY_BIN: selatPay.source === "global" ? "selat-pay" : selatPay.bin },
  };
}

// Shared --dry-run epilogue: show what WOULD run, charge nothing, exit 0.
// `extra` carries model-specific fields (e.g. Apify actorId) into --json output.
//
// `exec` is the machine half of `command`. `command` is shell-quoted for a
// human to read; re-executing it would mean shell-parsing a string, which is
// exactly the hazard the run path avoids by spawning without a shell. So --json
// also carries the resolved spawn tuple — the SAME one the non-dry-run path
// hands to the OS — letting a machine consumer execute the plan it was just
// quoted, instead of re-running the intent and being re-ranked onto a different
// service at a different price.
function printDryRun({ intent, plan, command, exec = null, jsonMode, extra = {} }) {
  const svcName = plan?.service?.name || extra.actorId || "the service";
  const priceText = receiptPriceText(plan?.minAmountUsd);
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: true,
      dryRun: true,
      intent,
      service: svcName,
      priceUsd: plan?.minAmountUsd ?? null,
      command,
      ...(exec ? { exec } : {}),
      ...extra,
      user_summary: `Dry run: would pay ${priceText} to ${svcName} — nothing was charged. Re-run without --dry-run to pay.`
    }, null, 2) + "\n");
    return 0;
  }
  console.log(fmt.bold("dry run — no payment made"));
  console.log(`  service: ${svcName}`);
  console.log(`  price:   ${priceText}` + fmt.dim(" (catalog floor; the live quote can differ)"));
  console.log(`  command: ${command}`);
  console.log("");
  console.log(fmt.dim("Re-run without --dry-run to pay."));
  return 0;
}

// Is this rank pick an Apify Actor paid via the prepaid-token model?
export function isApifyPrepaidPick(plan) {
  const pays = plan?.endpoint?.payments || plan?.payments || [];
  if (Array.isArray(pays) && pays.some((p) => p?.paymentModel === "apify-prepaid-token")) return true;
  return typeof plan?.service?.id === "string" && plan.service.id.startsWith("apify:");
}

// `<owner>~<actor>` from the pick's Actor URL, or the `apify:` service id.
export function apifyActorIdFromPlan(plan) {
  const url = plan?.endpoint?.fullUrl || "";
  // Accept the canonical /v2/actors/ path and the legacy /v2/acts/ alias — the
  // discovery catalog now generates /v2/actors/, but cached picks may still use
  // /v2/acts/. Both resolve on Apify.
  const m = /\/v2\/act(?:s|ors)\/([^/]+)\/run-sync/.exec(url);
  if (m) return decodeURIComponent(m[1]);
  const id = plan?.service?.id;
  if (typeof id === "string" && id.startsWith("apify:")) return id.slice("apify:".length);
  return null;
}

// Delegate to the discovery skill's apify_token.mjs: ensure a valid token (buy via
// the Router if needed), then run the Actor with the Bearer token. selat-pay is
// used only for the one token purchase, via SELAT_PAY_BIN (the binary this CLI
// resolved), so the bundled selat-pay wins over any global one — same as the
// normal run path.
// Build the `apify_token.mjs run` argv from the resolved Actor id and run flags.
// Pure + exported so the flag passthrough is unit-testable without spawning.
// --auto-rebuy is forward-compatible: an older apify_token.mjs simply ignores it.
export function apifyRunArgs({ actorId, inputInline, inputFile, autoRebuy = false }) {
  const inputArgs = inputInline ? ["--input", inputInline]
    : inputFile ? ["--input-file", inputFile]
    : [];
  return ["run", actorId, ...inputArgs, ...(autoRebuy ? ["--auto-rebuy"] : [])];
}

async function runApifyPrepaid({ plan, skill, selatPay, inputInline, inputFile, autoRebuy = false, intent = "", dryRun = false, jsonMode = false, verbose = false, maxAmount, allowHighMaxAmount = false } = {}) {
  const actorId = apifyActorIdFromPlan(plan);
  if (!actorId) {
    console.error(fmt.error("could not resolve the Apify Actor id from the pick"));
    return 1;
  }

  // --dry-run stops before the token check: even "ensure token" can BUY a
  // token ($1.05 — $1 minimum + 5% fee) when none is cached, so a dry run must not reach it.
  // Prepaid-token purchase is a known $1.05. An explicit --max-amount below
  // that is a hard refuse. The $1 x402 default is not applied here — it would
  // make every Apify pick unpayable. An explicit cap above $1.05 still hits
  // the hard CLI ceiling (non-TTY cannot YOLO 999); $1.05 itself is the
  // documented exception for this token only.
  const authorized = await authorizeRunMaxAmount({
    maxAmount,
    allowHighMaxAmount,
    jsonMode,
    apifyPrepaid: true,
  });
  if (!authorized.ok) {
    return emitRunError({ jsonMode, error: authorized.error, hints: authorized.hint ? [fmt.dim(authorized.hint)] : [] });
  }
  if (authorized.capUsd != null && authorized.capUsd < APIFY_PREPAID_TOKEN_USD) {
    return emitRunError({
      jsonMode,
      error: `Apify prepaid-token purchase is $${APIFY_PREPAID_TOKEN_USD} — --max-amount ${authorized.capUsd} is below that; nothing was charged`,
    });
  }

  if (dryRun) {
    const runArgs = apifyRunArgs({ actorId, inputInline, inputFile, autoRebuy });
    // Mirror the real spawn below, including the env it needs. Emitted without
    // an existence check on the script so a dry run keeps its promise never to
    // fail on account of the thing it is only describing.
    return printDryRun({
      intent,
      plan,
      command: ["apify_token.mjs", ...runArgs].map(shellQuoteForDisplay).join(" "),
      exec: apifyExecTuple({ skillPath: skill.path, selatPay, runArgs }),
      jsonMode,
      extra: { paymentModel: "apify-prepaid-token", actorId }
    });
  }

  const frozen = frozenMoneyMove("pay");
  if (frozen) {
    return emitRunError({ jsonMode, error: frozen.error, hints: [fmt.dim(frozen.hint)] });
  }

  const tokenScript = join(skill.path, "scripts", "apify_token.mjs");
  if (!existsSync(tokenScript)) {
    console.error(fmt.error("this Apify pick needs a newer discovery skill (apify_token.mjs not found)."));
    console.error(fmt.dim("Update @selat-ai/selat-discovery, or point SELAT_SKILL_PATH at a checkout with scripts/apify_token.mjs."));
    return 1;
  }

  if (!inputInline && !inputFile) {
    console.error(fmt.dim(`▸ no --input given; running ${actorId} with {} (pass --input '<json>' for real Actor input)`));
  }
  if (autoRebuy) {
    console.error(fmt.dim("▸ --auto-rebuy: if the token drains mid-run, a replacement will be bought — $1.05 cash ($1 minimum + 5% fee) — and the run retried."));
  }

  const payBin = selatPay.source === "global" ? "selat-pay" : selatPay.bin;
  const runArgs = apifyRunArgs({ actorId, inputInline, inputFile, autoRebuy });

  if (!jsonMode) {
    // Same confirmation-time visibility as the x402 path — a token purchase
    // mid-flow counts against the armed session budget too.
    const spendLine = sessionSpendLine();
    if (spendLine) console.log(fmt.dim(`▸ ${spendLine}`));
    console.log(fmt.dim(`▸ Apify prepaid-token flow: ensure token → run ${actorId}`));
    console.log(fmt.dim("  (if no live token is cached, \"ensure token\" buys one: $1.05 cash — $1 minimum + 5% fee;"));
    console.log(fmt.dim("  the balance meters per run and expires 14 days after purchase, no refund)"));
    console.log("");
  }
  await ensureSelatPayHistoryDir();
  // Human mode keeps streaming (a token purchase mid-flow should be visible as
  // it happens). --json captures: apify_token.mjs prints the Actor result to
  // stdout and diagnostics to stderr, same split as selat-pay.
  const res = await sh("node", [tokenScript, ...runArgs], {
    inherit: !jsonMode,
    env: { SELAT_PAY_BIN: payBin },
  });
  if (!jsonMode) return res.code;

  const svcName = plan?.service?.name || actorId;
  if (res.code !== 0) {
    process.stdout.write(JSON.stringify({
      ok: false,
      intent,
      service: svcName,
      paymentModel: "apify-prepaid-token",
      actorId,
      exitCode: res.code,
      user_summary: `The ${svcName} run failed — any prepaid Apify token that was bought stays usable for later runs (check selat spend).`,
      stderr: (res.stderr || "").trim()
    }, null, 2) + "\n");
    return res.code;
  }
  const rawBody = (res.stdout || "").trim();
  let response = rawBody;
  try { response = JSON.parse(rawBody); } catch { /* non-JSON Actor output */ }
  if (verbose && res.stderr) console.error((res.stderr || "").trim());
  process.stdout.write(JSON.stringify({
    ok: true,
    intent,
    service: svcName,
    paymentModel: "apify-prepaid-token",
    actorId,
    user_summary: `Ran ${svcName} via the prepaid Apify token — this draws down the token balance per run instead of a per-call charge (details: selat spend); the result is in the response field.`,
    response
  }, null, 2) + "\n");
  return 0;
}

/**
 * Re-plan a params-refused pick after substituting --param values into the
 * endpoint URL. The runnable command is rebuilt by the DISCOVERY SKILL's own
 * buildPaymentPlan (imported from the installed skill), so its --max-amount
 * ceiling and chain-resolution logic stay authoritative — this CLI never
 * derives payment caps itself.
 */
async function replanWithParams({ plan, skill, intent, params }) {
  const epUrl = plan?.endpoint?.url;
  if (!epUrl) return { ok: false, reason: "pick has no endpoint URL" };

  // Are all flagged params covered by the provided --param keys?
  const provided = new Set(params.map(([k]) => k));
  const stillFlagged = missingPlanParams(plan).filter((m) => !provided.has(m.name));
  const { url } = applyParamsToUrl(epUrl, replanUrlParams(plan, params));
  const leftoverPlaceholders = remainingPathPlaceholders(url);
  if (stillFlagged.length > 0 || leftoverPlaceholders.length > 0) {
    const leftoverNames = new Set(stillFlagged.map((m) => m.name));
    const missing = [
      ...stillFlagged,
      ...leftoverPlaceholders
        .map((ph) => ({ kind: "path", name: ph.replace(/^[:{\s]+/, "").replace(/[}*\s]+$/, "") }))
        .filter((m) => m.name && !leftoverNames.has(m.name)),
    ];
    return { ok: false, missing, reason: "some required params were not provided via --param" };
  }

  const libPath = join(skill.path, "scripts", "lib", "rank.mjs");
  if (!existsSync(libPath)) {
    return { ok: false, reason: "installed discovery skill lacks scripts/lib/rank.mjs — update @selat-ai/selat-discovery" };
  }
  let lib;
  try {
    lib = await import(pathToFileURL(libPath).href);
  } catch (err) {
    return { ok: false, reason: `could not load the skill ranker: ${err.message}` };
  }
  if (typeof lib.buildPaymentPlan !== "function") {
    return { ok: false, reason: "skill ranker does not export buildPaymentPlan — update @selat-ai/selat-discovery" };
  }

  const result = {
    service: {
      id: plan.service?.id ?? plan.service?.name ?? "service",
      name: plan.service?.name ?? "service",
      url: plan.service?.url ?? "",
      sources: [],
      ...(plan.docs ? { docs: plan.docs } : {}),
    },
    endpoint: {
      method: plan.endpoint?.method,
      path: plan.endpoint?.path,
      fullUrl: url,
      description: plan.endpoint?.description || "",
      ...(plan.endpoint?.inputSchema ? { inputSchema: plan.endpoint.inputSchema } : {}),
      ...(plan.pathParams ? { pathParams: plan.pathParams } : {}),
      ...(plan.queryParams ? { queryParams: plan.queryParams } : {}),
      payments: plan.payments || [],
    },
    serviceMinAmountUsd: plan.serviceMinAmountUsd ?? null,
    score: typeof plan.score === "number" ? plan.score : 0,
    why: plan.why || {},
  };
  let rebuilt;
  try {
    rebuilt = lib.buildPaymentPlan(intent, result, { providedParams: params.map(([name]) => name) });
  } catch (err) {
    return { ok: false, reason: `re-planning with params failed: ${err.message}` };
  }
  if (rebuilt?.requiresPathParams || rebuilt?.requiresQueryParams || rebuilt?.requiresBodyParams) {
    return { ok: false, missing: missingPlanParams(rebuilt), reason: rebuilt.note };
  }
  if (!Array.isArray(rebuilt?.exec_hints) || rebuilt.exec_hints.length === 0) {
    return { ok: false, reason: rebuilt?.note || "no runnable selat-pay hint after applying params" };
  }
  return { ok: true, plan: rebuilt };
}

// Refused pick, no (or insufficient) --param values: say exactly which params
// are needed and hand back a copy-pasteable retry line. Nothing is charged.
function reportMissingParams({ plan, intent, jsonMode, missing = [], reason }) {
  const svcName = plan?.service?.name || "the picked service";
  const retry = missing.length > 0 ? paramRetryLine(intent, missing) : null;
  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      ok: false,
      intent,
      service: svcName,
      needsParams: missing.map(({ kind, name, description, example, enumValues }) => ({
        kind,
        name,
        ...(description ? { description } : {}),
        ...(example != null && example !== "" ? { example } : {}),
        ...(Array.isArray(enumValues) && enumValues.length > 0 ? { enumValues } : {}),
      })),
      ...(retry ? { retry } : {}),
      ...(reason ? { reason } : {}),
      ...(plan?.docs ? { docs: plan.docs } : {}),
      user_summary: `${svcName} needs ${missing.map((m) => m.name).join(", ") || "additional parameters"} before it can be paid — nothing was charged.`,
    }, null, 2) + "\n");
    return 1;
  }
  console.error(fmt.error(`${svcName} needs ${missing.length === 1 ? "a parameter" : "parameters"} before it can be paid — nothing was charged`));
  for (const m of missing) {
    const bits = [`  ${m.name}`, `(${m.kind} param)`];
    if (m.description) bits.push(`— ${m.description}`);
    console.error(bits.join(" "));
  }
  if (reason) console.error(fmt.dim(reason));
  if (retry) {
    console.error("");
    console.error(`retry with values: ${fmt.cyan(retry)}`);
  }
  const docsUrl = plan?.docs?.docsUrl || plan?.docs?.openApiUrl || plan?.docs?.providerUrl;
  if (docsUrl) console.error(fmt.dim(`params documented at: ${docsUrl}`));
  return 1;
}

/**
 * Authorization for an explicit `--max-amount` on `selat run`.
 * Exported for tests. Apify prepaid is opted in by the caller after the pick.
 * `allowHigh` / `interactive` / `prompt` are accepted and ignored — they
 * cannot raise the $1 ceiling (isTTY is not a human gate).
 */
export async function authorizeRunMaxAmount({
  maxAmount,
  allowHighMaxAmount = false,
  jsonMode = false,
  apifyPrepaid = false,
  interactive = stdinIsInteractive() && !jsonMode,
  prompt,
  agent = false,
} = {}) {
  void prompt;
  void jsonMode;
  if (maxAmount == null) return { ok: true, capUsd: null, allowHigh: false };
  const auth = authorizeExplicitMaxAmount(maxAmount, {
    interactive,
    allowHigh: allowHighMaxAmount,
    apifyPrepaid,
    agent,
  });
  if (!auth.ok) return auth;
  return { ...auth, allowHigh: false };
}

/**
 * Last-wins spend ceiling for a validated selat-pay argv.
 *
 * Catalog exec_hints are untrusted and selat-pay's parser is last-wins, so a
 * hint can hide a high second --max-amount after a cheap first one. Strip
 * every prior cap, then append exactly one:
 *   - explicit --max-amount is clamped to the hard CLI ceiling (default $1).
 *     isTTY / --allow-high-max-amount cannot raise it. Values above the
 *     allowed ceiling are refused (not silently spent).
 *   - otherwise min(hint's last cap, DEFAULT_RUN_MAX_AMOUNT_USD), or the
 *     default when the hint has no usable cap
 */
export function applyRunMaxAmountCeiling(argv, {
  explicit = null,
  defaultUsd = DEFAULT_RUN_MAX_AMOUNT_USD,
  interactive = false,
  allowHigh = false,
  apifyPrepaid = false,
} = {}) {
  if (!Array.isArray(argv)) return { ok: false, reason: "argv must be an array" };
  const lastIdx = argv.lastIndexOf("--max-amount");
  const hintCap = lastIdx !== -1 ? Number(argv[lastIdx + 1]) : NaN;
  let cap;
  if (explicit != null) {
    const auth = authorizeExplicitMaxAmount(explicit, { interactive, allowHigh, apifyPrepaid });
    if (!auth.ok) return { ok: false, reason: auth.error };
    cap = auth.capUsd;
  } else if (Number.isFinite(hintCap) && hintCap > 0) {
    cap = Math.min(hintCap, defaultUsd);
  } else {
    cap = defaultUsd;
  }
  const stripped = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-amount") { i++; continue; }
    stripped.push(argv[i]);
  }
  return { ok: true, args: [...stripped, "--max-amount", String(cap)], capUsd: cap };
}

/** Validate a ranker exec hint into spawnable selat-pay args. Exported for tests. */
export function parseSelatPayHint(hint) {
  if (!hint || typeof hint !== "object") {
    return { ok: false, reason: "missing exec_hints[0]" };
  }

  if (Array.isArray(hint.argv)) {
    return validateSelatPayArgv(hint.argv);
  }

  if (typeof hint.cmd === "string" && hint.cmd.trim()) {
    const parsed = parseCommandLine(hint.cmd);
    if (!parsed.ok) return parsed;
    return validateSelatPayArgv(parsed.argv);
  }

  return { ok: false, reason: "exec hint did not include cmd or argv" };
}

export function validateSelatPayArgv(argv) {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
    return { ok: false, reason: "exec hint argv must be an array of strings" };
  }
  if (argv[0] !== "selat-pay") {
    return { ok: false, reason: "exec hint command must be exactly `selat-pay`" };
  }
  if (argv.length < 3) {
    return { ok: false, reason: "selat-pay hint is missing method or URL" };
  }
  if (argv.some((a) => /[\0\r\n]/.test(a))) {
    return { ok: false, reason: "selat-pay hint contains a control character" };
  }
  // The hint comes from catalog data, and argv[2] is where a real USDC payment
  // lands: require https:// (http:// only for loopback) so an untrusted entry
  // cannot route a signed payment over plaintext or an unexpected scheme.
  if (!safeHttpUrl(argv[2])) {
    return {
      ok: false,
      reason: `selat-pay hint url "${argv[2]}" must use https:// (http:// is allowed only for localhost)`
    };
  }

  return {
    ok: true,
    args: argv.slice(1),
    display: argv.map(shellQuoteForDisplay).join(" ")
  };
}

function parseCommandLine(command) {
  const argv = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        i++;
        if (i >= command.length) return { ok: false, reason: "unterminated escape sequence" };
        current += command[i];
      } else if (ch === "$" || ch === "`") {
        return { ok: false, reason: "shell expansion is not allowed in exec hints" };
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        argv.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }

    if (ch === "\\") {
      i++;
      if (i >= command.length) return { ok: false, reason: "unterminated escape sequence" };
      current += command[i];
      tokenStarted = true;
      continue;
    }

    if ("|&;<>(){}$`".includes(ch)) {
      return { ok: false, reason: `shell metacharacter ${ch} is not allowed in exec hints` };
    }

    current += ch;
    tokenStarted = true;
  }

  if (quote) return { ok: false, reason: "unterminated quoted string" };
  if (tokenStarted) argv.push(current);
  if (argv.length === 0) return { ok: false, reason: "empty exec hint command" };
  return { ok: true, argv };
}
