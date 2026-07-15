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
import { sh, shellQuoteForDisplay } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import { ensureSelatPayHistoryDir, resolveSelatPay, selatPaySpawn } from "../selat-pay.mjs";
import { egressLikelyBlocked, sandboxHintText } from "../host.mjs";
import { sessionSpendLine } from "./budget.mjs";

const RUN_USAGE = "usage: selat run \"<intent>\" [--dry-run] [--input '<json>' | --input-file <path>] [--auto-rebuy] [--json] [--verbose]";

// Every flag `selat run` understands. Kept as data so the unknown-flag error
// can list them and tests can pin the set.
export const KNOWN_RUN_FLAGS = ["--dry-run", "--input", "--input-file", "--auto-rebuy", "--json", "--verbose"];

/**
 * Parse `selat run` argv into options + intent. Pure and unit-testable.
 *
 * --input / --input-file carry Actor input for an Apify pick, and --auto-rebuy
 * (Apify picks ONLY) opts into buying a replacement token if the current one
 * drains mid-run — it's a no-op / warned for any other service, which is
 * per-call x402 with no token to replace.
 *
 * Unknown --flags are an ERROR, not intent tokens: `run` spends real money, and
 * silently dropping a flag like --dry-run means paying when the user asked not
 * to (tester feedback round 2).
 */
export function parseRunArgs(args) {
  const opts = { inputInline: undefined, inputFile: undefined, autoRebuy: false, dryRun: false, jsonMode: false, verbose: false };
  const intentTokens = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--input" || a === "--input-file") {
      const value = args[++i];
      if (value == null) return { ok: false, error: `${a} requires a value` };
      if (a === "--input") opts.inputInline = value;
      else opts.inputFile = value;
      continue;
    }
    if (a === "--auto-rebuy") { opts.autoRebuy = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (a === "--json") { opts.jsonMode = true; continue; }
    if (a === "--verbose") { opts.verbose = true; continue; }
    if (a.startsWith("--")) {
      return { ok: false, error: `unknown flag ${a} — known flags: ${KNOWN_RUN_FLAGS.join(", ")}` };
    }
    intentTokens.push(a);
  }
  return { ok: true, ...opts, intent: intentTokens.join(" ").trim() };
}

export async function run(args) {
  const parsedArgs = parseRunArgs(args);
  if (!parsedArgs.ok) {
    console.error(fmt.error(parsedArgs.error));
    console.error(fmt.dim(RUN_USAGE));
    return 1;
  }
  const { intent, inputInline, inputFile, autoRebuy, dryRun, jsonMode, verbose } = parsedArgs;
  if (!intent) {
    console.error(fmt.error(RUN_USAGE));
    return 1;
  }

  const skill = findSkill("rank.mjs");
  if (!skill.found) {
    console.error(fmt.error("agent-payment skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }

  const selatPay = await resolveSelatPay();
  if (selatPay.source === null) {
    console.error(fmt.error("selat-pay not found — reinstall selat-cli, or install selat-pay globally."));
    return 1;
  }

  if (!jsonMode) console.log(fmt.dim(`▸ ranking intent: "${intent}"`));

  // Step 1: pick
  const pick = await sh(
    "node",
    [join(skill.path, "scripts", "rank.mjs"), intent, "--pick"]
  );
  if (pick.code !== 0) {
    console.error(fmt.error("rank.mjs failed:"));
    console.error(pick.stderr || pick.stdout);
    // If the catalog fetch was blocked by a host network sandbox, surface the fix.
    if (await egressLikelyBlocked()) console.error("\n" + fmt.dim(sandboxHintText()));
    return 1;
  }

  // Step 2: parse and validate the selected execution hint.
  let plan;
  try {
    plan = JSON.parse(pick.stdout);
  } catch {
    console.error(fmt.error("rank.mjs returned invalid JSON"));
    return 1;
  }

  // Apify uses the prepaid-token model, not per-call x402. The rank pick carries
  // paymentModel "apify-prepaid-token", but its selat-pay hint would (wrongly) pay
  // the Actor endpoint's own x402. Intercept and route to the prepaid-token flow:
  // ensure a token (buy via the Router if needed), then call the Actor with the
  // Bearer token. The token PURCHASE is itself a plain selat-pay Gateway-batched
  // call to {ROUTER}/apify/prepaid-token, so selat-pay needs no change.
  if (isApifyPrepaidPick(plan)) {
    return await runApifyPrepaid({ plan, skill, selatPay, inputInline, inputFile, autoRebuy, intent, dryRun, jsonMode, verbose });
  }

  // --auto-rebuy is reserved for Apify prepaid-token picks (it re-buys a drained
  // token). Every other service is per-call x402, where there is no token to
  // replace — so if the top pick isn't Apify, say so instead of silently eating it.
  if (autoRebuy) {
    console.error(fmt.warn("--auto-rebuy applies only to Apify prepaid-token picks; ignoring it for this service."));
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

  const { args: selatPayArgs, display } = parsed;

  // --dry-run stops HERE: the pick is ranked and the selat-pay command is
  // validated, but nothing is signed or sent. This is the last line before
  // money moves, so the guard lives at the spawn boundary, not in the parser.
  if (dryRun) {
    return printDryRun({ intent, plan, command: display, jsonMode });
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

// Shared --dry-run epilogue: show what WOULD run, charge nothing, exit 0.
// `extra` carries model-specific fields (e.g. Apify actorId) into --json output.
function printDryRun({ intent, plan, command, jsonMode, extra = {} }) {
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

async function runApifyPrepaid({ plan, skill, selatPay, inputInline, inputFile, autoRebuy = false, intent = "", dryRun = false, jsonMode = false, verbose = false }) {
  const actorId = apifyActorIdFromPlan(plan);
  if (!actorId) {
    console.error(fmt.error("could not resolve the Apify Actor id from the pick"));
    return 1;
  }

  // --dry-run stops before the token check: even "ensure token" can BUY a
  // token (~$1) when none is cached, so a dry run must not reach it.
  if (dryRun) {
    const runArgs = apifyRunArgs({ actorId, inputInline, inputFile, autoRebuy });
    return printDryRun({
      intent,
      plan,
      command: ["apify_token.mjs", ...runArgs].map(shellQuoteForDisplay).join(" "),
      jsonMode,
      extra: { paymentModel: "apify-prepaid-token", actorId }
    });
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
    console.error(fmt.dim("▸ --auto-rebuy: if the token drains mid-run, a replacement (~$1) will be bought and the run retried."));
  }

  const payBin = selatPay.source === "global" ? "selat-pay" : selatPay.bin;
  const runArgs = apifyRunArgs({ actorId, inputInline, inputFile, autoRebuy });

  if (!jsonMode) {
    // Same confirmation-time visibility as the x402 path — a token purchase
    // mid-flow counts against the armed session budget too.
    const spendLine = sessionSpendLine();
    if (spendLine) console.log(fmt.dim(`▸ ${spendLine}`));
    console.log(fmt.dim(`▸ Apify prepaid-token flow: ensure token → run ${actorId}`));
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

function parseSelatPayHint(hint) {
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

function validateSelatPayArgv(argv) {
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
