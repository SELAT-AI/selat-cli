/**
 * `selat search "<intent>"` — discover + rank SELAT catalogue endpoints. FREE.
 *
 * The "search SELAT first" entrypoint: no payment, no wallet, no signature. This is
 * what the plugin's interception hooks and the selat-discovery skill point at — and the
 * free front half of `selat run` (which is `rank.mjs … --pick` + pay). Here we run the
 * SAME ranker in its default, no-pick mode (pure discovery) and print the ranked
 * candidates, then a probe-first next step for the top match.
 *
 *   selat search "enrich a person by name and company"
 *   selat search "generate an image of a robot" --top 3
 *   selat search "people enrichment" --json        # machine-readable (for agents/hooks)
 *
 * Flags forwarded to the ranker: --top N, --refresh, --explain (→ --explain-payability),
 * --json, --capability <name>. --verbose is handled here: it replays the ranker's stderr
 * (catalog-loader warnings), which is otherwise suppressed unless the ranker fails. No
 * payment path exists in this command — rank.mjs without --pick never settles.
 *
 * --capability is Layer 0 passthrough: discovery scopes the ranked pool to endpoints
 * labeled with that name and refuses (unknown name or empty labeled pool) rather than
 * silently widening. This CLI does not interpret the name.
 */

import { join } from "node:path";
import { sh } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { egressLikelyBlocked, sandboxHintText } from "../host.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";

const HELP = `${fmt.bold("selat search")} — discover & rank SELAT endpoints for a capability (FREE; no wallet, no spend)

${fmt.bold("Usage:")}
  selat search "<intent>" [flags]

${fmt.bold("Flags:")}
  --top N              Show top N matches (default 5)
  --json               Machine-readable output (for agents / interception hooks)
  --explain            Show why each match is or isn't payable right now
  --refresh            Re-fetch catalogs before ranking
  --capability <name>  Rank only endpoints labeled with this capability (Layer 0).
                       Use when you know the kind of service but not which one.
                       Unknown names and empty labeled pools are refused, never widened.
  --verbose            Also show catalog-loader warnings (skipped/invalid entries)
  --help, -h           Show this help

${fmt.bold("Examples:")}
  selat search "enrich a person by name and company"
  selat search "transcribe audio to text" --top 3
  selat search "people enrichment" --json
  selat search "find recent papers" --capability web.search

Discovery only — to pay, use ${fmt.cyan("selat run \"<intent>\"")} (rank + pay) or the
${fmt.cyan("selat-pay … --probe-only --live-probe")} command printed below the results.`;

export async function search(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  // Build the intent from non-flag words, skipping values that belong to
  // value-taking flags (e.g. the "3" in `--top 3` or `web.search` in
  // `--capability web.search`) so they don't pollute the query.
  const valueFlags = new Set(["--top", "--capability"]);
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) i++; // skip its value
      continue;
    }
    words.push(a);
  }
  const intent = words.join(" ").trim();
  if (!intent) {
    console.error(fmt.error("usage: selat search \"<intent>\" [--capability <name>]"));
    return 1;
  }

  const skill = findSkill("rank.mjs");
  if (!skill.found) {
    console.error(fmt.error("discovery skill not found"));
    console.error("");
    for (const line of skillInstallLines(skill.path)) console.error(fmt.cyan(line));
    return 1;
  }
  const rank = join(skill.path, "scripts", "rank.mjs");

  // Pass-through flags (all map to rank.mjs's own surface). No --pick → no payment.
  // Omitted --capability is omitted here too: unscoped ranking stays today's default.
  const passthrough = searchRankFlags(args);

  // The ranker streams results on stdout and catalog-loader warnings (skipped /
  // invalid catalog rows) on stderr. Those warnings drown the shortlist when the
  // command runs inside an agent, which sees both streams — so capture stderr and
  // replay it only under --verbose, or on failure (where it carries the error).
  const verbose = args.includes("--verbose");
  const replayStderr = (res) => {
    if (res.stderr && (verbose || res.code !== 0)) process.stderr.write(res.stderr);
  };

  // --json: forward verbatim for machine consumers (agents, interception hooks).
  if (args.includes("--json")) {
    const res = await sh("node", [rank, intent, "--json", ...passthrough], { inheritStdout: true });
    replayStderr(res);
    return res.code;
  }

  // Human mode: stream the ranked list, then append a probe-first next step.
  const list = await sh("node", [rank, intent, ...passthrough], { inheritStdout: true });
  replayStderr(list);
  if (list.code !== 0) {
    // rank.mjs failed (its stderr was replayed above). If discovery couldn't reach
    // the catalog because the host sandboxes egress, surface the exact allowlist fix.
    if (await egressLikelyBlocked()) console.error("\n" + fmt.dim(sandboxHintText()));
    return list.code;
  }

  await printProbeNextStep(rank, intent, searchCapabilityArgs(args));
  return 0;
}

/**
 * rank.mjs flags `selat search` forwards (after the intent). `--pick` is added
 * only by the probe-next-step footer, and only `--capability` is forwarded
 * there so the plan is scoped to the same labeled pool as the shortlist.
 * Exported so tests can pin parse/forward without spawning.
 */
export function searchRankFlags(args) {
  const out = [];
  const topIdx = args.indexOf("--top");
  if (topIdx !== -1 && args[topIdx + 1]) out.push("--top", args[topIdx + 1]);
  if (args.includes("--refresh")) out.push("--refresh");
  if (args.includes("--explain")) out.push("--explain-payability");
  out.push(...searchCapabilityArgs(args));
  return out;
}

/** `--capability <name>` argv fragment, or [] when the flag is omitted. */
export function searchCapabilityArgs(args) {
  const i = args.indexOf("--capability");
  if (i === -1 || args[i + 1] == null) return [];
  return ["--capability", args[i + 1]];
}

/**
 * Derive an explicitly acknowledged `selat-pay … --probe-only --live-probe` line for the top match, so search → probe →
 * pay is a guided funnel rather than guesswork. Best-effort: we ask the ranker for the
 * top pick's payment plan (still no settlement — --pick only computes a plan) and turn
 * its selat-pay exec hint into a probe. Any failure just skips the footer silently.
 */
async function printProbeNextStep(rank, intent, capabilityArgv = []) {
  try {
    // Keep the pick inside the same capability scope as the shortlist. An
    // unscoped --pick would re-widen the pool the user just asked to narrow.
    const pick = await sh("node", [rank, intent, "--pick", ...capabilityArgv]);
    if (pick.code !== 0) return;
    const plan = JSON.parse(pick.stdout);
    const hint = plan?.exec_hints?.[0];
    // Apify picks use the prepaid-token model, not a per-call selat-pay POST. A
    // probe against the Actor URL would (wrongly) settle its own x402 in full.
    // Point at the buy-once → Bearer flow instead.
    const runCmd = "selat run \"" + intent + "\"" + (capabilityArgv.length ? " " + capabilityArgv.join(" ") : "");
    if (hint?.flow === "apify-prepaid-token") {
      console.log("");
      console.log(fmt.bold("▸ Next (Apify prepaid-token — buy once, then reuse):"));
      console.log(fmt.cyan("  " + runCmd));
      console.log(fmt.dim("  The listed per-call price is only the metered rate. The cash event is a"));
      console.log(fmt.dim("  prepaid token: $1 minimum + 5% fee = $1.05 up front. Runs draw down the"));
      console.log(fmt.dim("  balance, which expires 14 days after purchase with no refund — so the"));
      console.log(fmt.dim("  effective per-call cost is $1.05 ÷ calls you actually make before expiry."));
      console.log(fmt.dim("  The token is reused until it drains or expires. Don't selat-pay POST the Actor URL."));
      return;
    }
    let argv = Array.isArray(hint?.argv) ? hint.argv : null;
    if (!argv && typeof hint?.cmd === "string") argv = hint.cmd.trim().split(/\s+/);
    if (!argv || argv[0] !== "selat-pay") return;
    if (!argv.includes("--probe-only")) argv = [...argv, "--probe-only"];
    if (!argv.includes("--live-probe")) argv = [...argv, "--live-probe"];
    console.log("");
    console.log(fmt.bold("▸ Next (live probe, no spend):"));
    console.log(fmt.cyan("  " + argv.join(" ")));
    console.log(fmt.dim("  This probe may invoke the target method/body. Use it only after confirming the endpoint is safe to call."));
    console.log(fmt.dim("  The probe JSON carries quote.extensions.selatTransactabilityIndex when the router"));
    console.log(fmt.dim("  has health data (last paid status + captured-payment stats) — check it before paying;"));
    console.log(fmt.dim("  a 4xx/5xx lastPaid or low successRate means pick another candidate. Absence = no data."));
    console.log(fmt.dim("  Then drop --probe-only to pay, or run: " + runCmd));
  } catch {
    /* best-effort footer — never fail the search over it */
  }
}
