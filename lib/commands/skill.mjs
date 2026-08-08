/**
 * `selat skill <list|install|run>` — manage and invoke Selat skills.
 *
 * A skill is a declarative manifest composed of one or more catalogue endpoint
 * steps; running one spawns selat-pay per step (see lib/skill-registry.mjs).
 * This is distinct from lib/skill.mjs (the rank.mjs finder) — different file,
 * different job.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fmt, promptYesNo, stdinIsInteractive } from "../ui.mjs";
import { flagValue, positionalWords } from "../args.mjs";
import { selatStateDir } from "../paths.mjs";
import {
  MANIFEST_MAX_AMOUNT_CEILING_USD,
  listSkills,
  listAvailable,
  fetchReliability,
  installSkill,
  invokeSkill,
  resolveSkill,
  scaffoldSkill,
  validateSkillDir,
  verifySkillDir,
  registerSkill,
  submitSkill
} from "../skill-registry.mjs";
import {
  discoverCandidates,
  matchReliability,
  paidCapUsd,
  probeCandidates,
  settleCandidate,
  sortComparisonRows
} from "../compare.mjs";
import { requireSkill, skillScript } from "../skill.mjs";
import { ensureSelatPayHistoryDir, resolveSelatPay, SELAT_PAY_MISSING_MESSAGE } from "../selat-pay.mjs";
import { warnIfEgressBlocked } from "../host.mjs";
import { isApifyPrepaidPick } from "./run.mjs";

const USAGE = `${fmt.bold("selat skill")} — manage, author, and run Selat skills

${fmt.bold("Subcommands:")}
  list [--available]            List installed skills, or available ones (with reliability) to install.
  install <name|path> [--force] [--max-amount <usd>]
                                Install a skill by name (from the registry) or a local path.
  run <name> [--p value ...]    Run an installed skill; pass its params as --flags. --json emits\n                                one machine object (per-step responses + a user_summary line).
                                Overrides: --chain <c>, --max-amount <usd>, --raw-key.
  compare "<intent>" [--limit N] [--json] [--pay]
                                Probe the top catalog candidates for an intent side-by-side
                                (FREE); --pay adds one capped, confirmed test call each.
  new <name> [--dir .] [--force] Scaffold a new skill folder (SOP layout) to contribute.
  validate <path>               Validate a skill folder against the Agent Skill SOP.
  verify <path> [--pay] [--p v]  Live-check each endpoint (real 402 price/rail); --pay makes a capped paid call.
  register <path> [--index p]   Add/update the skill's entry in index.json.
  submit <path> [--dry-run]     Open a PR to the selat-skills repo (gated on a passing verify receipt).
                                Submits from your fork by default unless you have write access;
                                --fork / --no-fork force either flow.

${fmt.bold("Examples:")}
  selat skill list --available
  selat skill compare "search the web for recent news" --limit 3
  selat skill install market-snapshot
  selat skill run token-price --symbols ETH,USDC
  selat skill run web-search --query "USDC news" --chain arc --raw-key   # pay from an Arc EOA Gateway balance
  selat skill new my-skill && selat skill validate ./my-skill
  selat skill verify ./skills/market-snapshot          # free: probe live prices
  selat skill verify ./skills/token-price --symbols ETH --pay   # capped real call
  selat skill register ./skills/my-skill && selat skill submit ./skills/my-skill
`;

export async function skill(args) {
  const sub = args[0];
  switch (sub) {
    case "list":
      return await listCmd(args.slice(1));
    case "run":
      return await runCmd(args.slice(1));
    case "compare":
      return await compareCmd(args.slice(1));
    case "install":
      return await installCmd(args.slice(1));
    case "new":
      return await newCmd(args.slice(1));
    case "validate":
      return await validateCmd(args.slice(1));
    case "verify":
      return await verifyCmd(args.slice(1));
    case "register":
      return await registerCmd(args.slice(1));
    case "submit":
      return await submitCmd(args.slice(1));
    case undefined:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return sub ? 0 : 1;
    default:
      console.error(fmt.error(`unknown skill subcommand: ${sub}`));
      console.error("");
      console.error(USAGE);
      return 1;
  }
}

async function listCmd(args) {
  if (args.includes("--available")) return await availableCmd();

  const skills = await listSkills();
  if (skills.length === 0) {
    console.log(fmt.dim("No skills installed."));
    console.log(fmt.dim("See installable skills:  selat skill list --available"));
    return 0;
  }
  console.log(fmt.header("Installed skills"));
  const width = Math.max(...skills.map((s) => s.name.length));
  for (const s of skills) {
    const tag = s.source === "dev" ? "(dev) " : "(user)";
    console.log(`  ${fmt.ok(s.name.padEnd(width))}  ${fmt.dim(tag)}  ${s.description}`);
  }
  return 0;
}

async function availableCmd() {
  let skills;
  try {
    skills = await listAvailable();
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
  if (!skills.length) {
    console.log(fmt.dim("No skills in the registry."));
    return 0;
  }
  const { generatedAt, byName } = await fetchReliability(); // best-effort; empty if no registry yet
  const haveReliability = byName.size > 0;

  console.log(fmt.header("Available skills"));
  const width = Math.max(...skills.map((s) => s.name.length));
  for (const s of skills) {
    const meta = [s.kind, s.rail].filter(Boolean).join("/");
    const rel = byName.get(s.name);
    const badge = reliabilityBadge(rel);
    console.log(`  ${badge}  ${fmt.cyan(s.name.padEnd(width))}  ${fmt.dim(`(${meta})`.padEnd(16))}  ${s.description ?? ""}`);
  }
  console.log("");
  if (haveReliability) {
    console.log(fmt.dim(`Reliability: ${fmt.green("●")} ok  ${fmt.yellow("●")} degraded  ${fmt.red("●")} down  ${fmt.dim("○")} unknown` +
      (generatedAt ? `  (checked ${relativeTime(generatedAt)})` : "")));
  }
  console.log(fmt.dim("Install one with:  selat skill install <name>"));
  return 0;
}

/** A colored status dot from a reliability entry (○ when unknown/absent). */
function reliabilityBadge(rel) {
  switch (rel?.status) {
    case "ok": return fmt.green("●");
    case "degraded": return fmt.yellow("●");
    case "down": return fmt.red("●");
    default: return fmt.dim("○");
  }
}

/** "3h ago" / "2d ago" from an ISO timestamp; "" if unparseable. */
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 90) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function installCmd(args) {
  const force = args.includes("--force");
  const maxAmount = flagValue(args, "--max-amount") || undefined;
  const target = firstPositional(args);
  if (!target) {
    console.error(fmt.error("usage: selat skill install <name|path> [--force] [--max-amount <usd>]"));
    return 1;
  }
  // Interactive terminals get a look-then-confirm path for manifests that
  // declare caps above the manifest ceiling (default NO). Non-TTY installs
  // keep the fail-fast ceiling error, which already names --max-amount.
  const onConfirmCaps = stdinIsInteractive()
    ? async (caps) => {
        console.log("  " + fmt.warn(`this skill declares spend caps above the $${MANIFEST_MAX_AMOUNT_CEILING_USD.toFixed(2)} manifest ceiling:`));
        for (const c of caps) {
          console.log("      " + `${c.source}${c.label ? ` — ${c.label}` : ""}: cap $${c.cap.toFixed(2)}`);
        }
        console.log("  " + fmt.dim("a cap is the most a single call may spend (a ceiling), not the expected charge"));
        return await promptYesNo("Accept these caps and install?", { default: false });
      }
    : undefined;
  try {
    const { name, dir, source } = await installSkill(target, { force, maxAmount, onConfirmCaps });
    const from = source && source !== "path" ? ` from ${source}` : "";
    console.log("  " + fmt.ok(`installed skill '${name}'${from} → ${dir}`));
    console.log("  " + fmt.dim(`run it:  selat skill run ${name}`));
    return 0;
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
}

// Bare (value-less) flags across skill subcommands. Every other `--flag`
// consumes the following token as its value.
const BARE_SKILL_FLAGS = new Set(["--force", "--pay", "--dry-run"]);

/**
 * Parse the `--flag value` tail that `skill run` and `skill verify` share.
 *
 * --chain, --max-amount and --raw-key are reserved per-run overrides (--raw-key
 * signs locally with SELAT_PRIVATE_KEY, for chains the Circle Agent Wallet
 * can't sign — e.g. Arc mainnet); --json and --pay are bare switches; every
 * other --flag becomes a skill param (manifest keys map 1:1, no camelization),
 * with a value-less flag meaning `true`.
 */
export function parseSkillInvocationArgs(args) {
  const params = {};
  const overrides = {};
  let jsonMode = false;
  let pay = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "json") { jsonMode = true; continue; }
    if (key === "pay") { pay = true; continue; }
    const next = args[i + 1];
    const value = next != null && !next.startsWith("--") ? args[++i] : true;
    if (key === "chain") overrides.chain = value === true ? undefined : value;
    else if (key === "max-amount") overrides.maxAmount = value === true ? undefined : value;
    else if (key === "raw-key") overrides.rawKey = value === true || value === "true";
    else params[key] = value;
  }
  return { params, overrides, jsonMode, pay };
}

// First positional argument, skipping value-taking flags and their values.
// `args.find(a => !a.startsWith("--"))` is wrong: in
// `skill verify --max-amount 0.05 ./skill` it returns "0.05" (the cap value),
// not the path.
export function firstPositional(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) return a;
    if (!BARE_SKILL_FLAGS.has(a)) {
      const next = args[i + 1];
      if (next != null && !next.startsWith("--")) i++; // consume the flag's value
    }
  }
  return undefined;
}

async function newCmd(args) {
  const name = firstPositional(args);
  if (!name) {
    console.error(fmt.error("usage: selat skill new <name> [--dir <dir>] [--force]"));
    return 1;
  }
  const dir = flagValue(args, "--dir") || ".";
  const force = args.includes("--force");
  try {
    const { dir: target, files } = await scaffoldSkill(name, { dir, force });
    console.log("  " + fmt.ok(`scaffolded skill '${name}' → ${target}`));
    for (const f of files) console.log("    " + fmt.dim(f));
    console.log("");
    console.log("  " + fmt.dim("Next: edit the files (replace TODOs), then:"));
    console.log("  " + fmt.cyan(`    selat skill validate ${target}`));
    return 0;
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
}

async function validateCmd(args) {
  const path = firstPositional(args);
  if (!path) {
    console.error(fmt.error("usage: selat skill validate <path>"));
    return 1;
  }
  let res;
  try {
    res = await validateSkillDir(path);
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
  console.log(fmt.header(`Validating ${res.name}`));
  for (const e of res.errors) console.log("  " + fmt.err(e));
  for (const w of res.warnings) console.log("  " + fmt.warn(w));
  console.log("");
  if (res.ok) {
    console.log("  " + fmt.ok(`valid${res.warnings.length ? ` (${res.warnings.length} warning${res.warnings.length > 1 ? "s" : ""})` : ""}`));
    return 0;
  }
  console.log("  " + fmt.err(`invalid — ${res.errors.length} error${res.errors.length > 1 ? "s" : ""}`));
  return 1;
}

async function verifyCmd(args) {
  const path = firstPositional(args);
  if (!path) {
    console.error(fmt.error("usage: selat skill verify <path> [--pay] [--param value ...]"));
    return 1;
  }
  const { params, overrides, pay } = parseSkillInvocationArgs(args);

  let res;
  try {
    res = await verifySkillDir(path, {
      params, overrides, pay,
      onStep: ({ index, total, phase, step, display }) => {
        if (phase === "probe") {
          const label = step.label ? ` — ${step.label}` : "";
          console.log(fmt.dim(`▸ step ${index + 1}/${total}${label}`));
          console.log(fmt.dim(`  probe: selat-pay ${display} --probe-only`));
        } else if (phase === "pay") {
          console.log(fmt.dim(`  pay:   selat-pay ${display}`));
        }
      }
    });
  } catch (err) {
    if (err.paramKey) {
      console.error(fmt.error(`missing required --${err.paramKey}`));
      if (err.paramDescription) console.error(fmt.dim(`  ${err.paramDescription}`));
      return 1;
    }
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }

  console.log(fmt.bold(`\n${res.name} — verification`));
  for (const s of res.steps) {
    const rail = s.rail ? ` [${s.rail}]` : "";
    const price = s.livePriceUsd != null ? `$${s.livePriceUsd}` : "(no price)";
    const capStr = s.maxAmount != null ? ` / cap $${s.maxAmount}` : "";
    const paidStr = s.paid ? ` · paid ${s.paid.settled ? "✓" : "✗"} http=${s.paid.httpStatus ?? "?"} ${s.paid.latencyMs}ms` : "";
    const good = s.reachable && s.withinCap && (!pay || (s.paid && s.paid.settled));
    if (good) console.log("  " + fmt.ok(`step ${s.index + 1}${rail}: ${s.mode} ${price}${capStr}${paidStr}`));
    else console.log("  " + fmt.err(`step ${s.index + 1}${rail}: ${s.error || "failed"} (${price}${capStr})${paidStr}`));
  }
  console.log("");
  console.log("  " + fmt.dim(`receipt: ${res.receiptPath}`));
  if (res.ok) {
    console.log("  " + fmt.ok(pay ? "verified — all steps settled" : "verified — all steps quote within cap"));
    return 0;
  }
  console.log("  " + fmt.err("verification failed"));
  return 1;
}

async function registerCmd(args) {
  const path = firstPositional(args);
  if (!path) {
    console.error(fmt.error("usage: selat skill register <path> [--index <path>]"));
    return 1;
  }
  try {
    const { indexPath, entry, action } = await registerSkill(path, { indexPath: flagValue(args, "--index") || undefined });
    console.log("  " + fmt.ok(`${action} '${entry.name}' in ${indexPath}`));
    console.log("    " + fmt.dim(`${JSON.stringify(entry)}`));
    return 0;
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
}

async function submitCmd(args) {
  const path = firstPositional(args);
  if (!path) {
    console.error(fmt.error("usage: selat skill submit <path> [--dry-run] [--fork|--no-fork] [--repo owner/name]"));
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const repo = flagValue(args, "--repo") || undefined;
  const fork = args.includes("--fork") ? true : args.includes("--no-fork") ? false : null;
  let res;
  try {
    res = await submitSkill(path, { dryRun, repo, fork });
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    if (err.needVerify) console.error(fmt.dim("  the skill must pass `selat skill verify` (a passing receipt) before it can be submitted"));
    return 1;
  }
  if (res.dryRun) {
    console.log(fmt.header(`Submit plan (dry-run) — ${res.entry.name}`));
    console.log("  " + fmt.dim(`repo root: ${res.repoRoot}`));
    console.log("  " + fmt.dim(`branch:    ${res.branch}`));
    console.log("  " + fmt.dim(`files:     ${res.files.join(", ")}`));
    console.log("  " + fmt.dim(`index:     ${JSON.stringify(res.entry)}`));
    console.log("");
    console.log(fmt.bold("  PR title: ") + res.title);
    console.log(fmt.dim(res.body.split("\n").map((l) => "  " + l).join("\n")));
    console.log("");
    console.log("  " + fmt.dim("re-run without --dry-run to push the branch and open the PR"));
    return 0;
  }
  if (res.prUrl) {
    console.log("  " + fmt.ok(`opened PR: ${res.prUrl}`));
    if (res.via === "fork") console.log("  " + fmt.dim(`submitted from your fork (${res.forkRepo}, remote 'fork')`));
    return 0;
  }
  console.log("  " + (res.pushed ? fmt.warn(`branch '${res.branch}' pushed, but PR not opened`) : fmt.err("could not push")));
  if (res.hint) console.error(fmt.dim("  " + res.hint.split("\n").join("\n  ")));
  if (res.detail) console.error(fmt.dim("  " + res.detail));
  return 1;
}

const COMPARE_HELP = `${fmt.bold("selat skill compare")} — vet catalog candidates for an intent side-by-side

Shortlists the top matches from the federated catalog (same discovery as
${fmt.cyan("selat search")}), then free-probes each candidate's live 402 at its catalog
serviceUrl (${fmt.bold("never settles")}) and prints one table: live price, rail, probe
latency, reachability, and the selat-skills registry reliability badge.

${fmt.bold("Usage:")}
  selat skill compare "<intent>" [flags]

${fmt.bold("Flags:")}
  --limit N          Candidates to shortlist and probe (default 5)
  --json             Machine-readable output (progress goes to stderr)
  --refresh          Re-fetch catalogs before ranking
  --pay              One capped SETTLED test call per reachable candidate
                     (real spend — asks for confirmation first) and save each
                     response as an output sample
  --yes              Skip the --pay confirmation (required for --pay with --json
                     or in non-interactive runs)
  --max-amount <usd> Per-call spend cap for --pay (default: live price + 25%
                     headroom, clamped to $1)
  --chain <c>        Pay-chain override for --pay (probes are chain-independent)
  --help, -h         Show this help

${fmt.bold("Examples:")}
  selat skill compare "search the web for recent news"
  selat skill compare "enrich a person by name and company" --limit 3
  selat skill compare "generate an image" --json
  selat skill compare "token prices" --pay --max-amount 0.05

Probes always hit the catalog serviceUrl — the descriptive provider url does
not serve the 402 challenge. Exit code 0 when at least one candidate is
reachable. --pay skips Apify prepaid-token candidates (test those with
${fmt.cyan("selat run")} — a per-call payment would settle the Actor's own x402 in full).`;

async function compareCmd(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(COMPARE_HELP);
    return 0;
  }

  // Intent = non-flag words, skipping values of value-taking flags (same
  // approach as `selat search`). Unknown --flags are dropped.
  const valueFlags = ["--limit", "--max-amount", "--chain"];
  const rawLimit = flagValue(args, "--limit");
  const limit = rawLimit == null ? 5 : Number(rawLimit);
  const maxAmount = flagValue(args, "--max-amount");
  const chain = flagValue(args, "--chain");
  const json = args.includes("--json");
  const pay = args.includes("--pay");
  const yes = args.includes("--yes");
  const refresh = args.includes("--refresh");
  const intent = positionalWords(args, { valueFlags }).join(" ").trim();
  if (!intent) {
    console.error(fmt.error("usage: selat skill compare \"<intent>\" [--limit N] [--json] [--pay]"));
    return 1;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    console.error(fmt.error("--limit must be a positive integer"));
    return 1;
  }
  if (maxAmount != null && (!Number.isFinite(Number(maxAmount)) || Number(maxAmount) <= 0)) {
    console.error(fmt.error(`--max-amount "${maxAmount}" must be a positive number`));
    return 1;
  }
  // Fail fast when the --pay confirmation could never be answered (or would
  // pollute --json stdout with a prompt).
  if (pay && !yes && (json || !process.stdin.isTTY)) {
    console.error(fmt.error(json
      ? "--pay with --json needs --yes (an interactive prompt would corrupt the JSON stream)"
      : "--pay needs a terminal to confirm the spend — pass --yes to authorize it non-interactively"));
    return 1;
  }

  const discovery = requireSkill("rank.mjs", { message: "discovery skill not found" });
  if (!discovery) return 1;
  const selatPay = await resolveSelatPay();
  if (selatPay.source === null) {
    console.error(fmt.error(SELAT_PAY_MISSING_MESSAGE));
    return 1;
  }

  // Progress goes to stderr so --json stdout stays machine-clean.
  console.error(fmt.dim(`▸ discovering candidates for "${intent}" (free — no spend)…`));
  let found;
  try {
    found = await discoverCandidates(skillScript(discovery, "rank.mjs"), intent, { limit, refresh });
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    if (err.stderr) console.error(fmt.dim(String(err.stderr).trim()));
    await warnIfEgressBlocked();
    return 1;
  }
  if (found.plans.length === 0) {
    console.error(fmt.error("no catalog candidates matched the intent — try broader wording or --refresh"));
    if (found.note) console.error(fmt.dim(found.note));
    return 1;
  }
  if (!found.strongMatch) {
    console.error(fmt.warn("no strong catalog match — candidates below are LOW CONFIDENCE; reword the intent before paying"));
  }

  console.error(fmt.dim(`▸ probing ${found.plans.length} candidate${found.plans.length > 1 ? "s" : ""} at their catalog serviceUrl (free — never settles)…`));
  const [probes, reliability] = await Promise.all([
    probeCandidates(found.plans, { selatPay }),
    fetchReliability() // best-effort; empty if no registry yet
  ]);

  const rows = found.plans.map((plan, i) => ({
    plan,
    probe: probes[i],
    reliability: matchReliability(plan, reliability.byUrl),
    paid: null
  }));
  const sorted = sortComparisonRows(rows);

  if (pay) {
    const code = await payCompareRows(sorted, { intent, selatPay, maxAmount, chain, yes });
    if (code !== 0) return code;
  }

  if (json) {
    console.log(JSON.stringify({
      intent,
      strongMatch: found.strongMatch,
      ...(found.note ? { note: found.note } : {}),
      checkedAt: new Date().toISOString(),
      limit,
      candidates: sorted.map((row, i) => ({
        rank: i + 1,
        service: row.plan.service,
        endpoint: row.plan.endpoint, // endpoint.url is the catalog serviceUrl
        score: row.plan.score ?? null,
        probe: {
          reachable: row.probe.reachable,
          mode: row.probe.mode,
          livePriceUsd: row.probe.livePriceUsd,
          latencyMs: row.probe.latencyMs,
          error: row.probe.error
        },
        reliability: row.reliability,
        paid: row.paid
      }))
    }, null, 2));
  } else {
    renderCompareTable(sorted, { pay, generatedAt: reliability.generatedAt });
    console.log("");
    console.log(fmt.dim(`Pay for the top pick with:  selat run "${intent}"` + (pay ? "" : "   (or re-run with --pay for settled test calls)")));
  }

  return sorted.some((r) => r.probe.reachable) ? 0 : 1;
}

/**
 * The --pay leg: pick eligible candidates, confirm the worst-case spend, then
 * run one capped settled call each (serially, so spend is attributable) and
 * save every response body as an output sample. Mutates row.paid in place.
 * Returns 0, or 1 when the user declined.
 */
async function payCompareRows(sorted, { intent, selatPay, maxAmount, chain, yes }) {
  const jobs = [];
  for (const row of sorted) {
    if (!row.probe.reachable) {
      row.paid = { skipped: "unreachable" };
      continue;
    }
    // Apify Actors use the prepaid-token model; a per-call payment at the Actor
    // URL would settle its own x402 in full (same rule as `selat run`/`search`).
    if (isApifyPrepaidPick(row.plan)) {
      row.paid = { skipped: "apify prepaid-token flow — test it with `selat run` instead" };
      continue;
    }
    const capUsd = paidCapUsd({
      explicit: maxAmount,
      livePriceUsd: row.probe.livePriceUsd,
      hintCapUsd: row.probe.hintCapUsd
    });
    if (row.probe.livePriceUsd != null && row.probe.livePriceUsd > capUsd) {
      row.paid = { skipped: `live price $${row.probe.livePriceUsd} exceeds cap $${capUsd}` };
      continue;
    }
    jobs.push({ row, capUsd });
  }

  if (jobs.length === 0) {
    console.error(fmt.warn("--pay: no eligible candidates (unreachable, over cap, or prepaid-token flow)"));
    return 0;
  }

  const totalCap = jobs.reduce((sum, j) => sum + j.capUsd, 0);
  console.error("");
  console.error(fmt.bold(`▸ --pay: ${jobs.length} settled test call${jobs.length > 1 ? "s" : ""} (worst case $${totalCap.toFixed(4)} total):`));
  for (const { row, capUsd } of jobs) {
    const price = row.probe.livePriceUsd != null ? `$${row.probe.livePriceUsd}` : "price unknown";
    console.error(fmt.dim(`    ${row.plan.service.name} — ${price}, cap $${capUsd}`));
  }
  if (!yes) {
    const go = await promptYesNo(`Spend up to $${totalCap.toFixed(4)} on these test calls?`, { default: false });
    if (!go) {
      console.error(fmt.dim("declined — no payment made"));
      return 1;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sampleDir = selatStateDir("compare", stamp);
  await mkdir(sampleDir, { recursive: true });
  await ensureSelatPayHistoryDir();

  for (const [i, { row, capUsd }] of jobs.entries()) {
    console.error(fmt.dim(`▸ paid test ${i + 1}/${jobs.length}: ${row.plan.service.name} (cap $${capUsd})`));
    const res = await settleCandidate(row.probe.payArgv, { selatPay, capUsd, chain });
    let samplePath = null;
    if (res.stdout.trim()) {
      let ext = "txt";
      try { JSON.parse(res.stdout); ext = "json"; } catch { /* keep txt */ }
      const slug = String(row.plan.service.name || "candidate").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
      samplePath = join(sampleDir, `${i + 1}-${slug}.${ext}`);
      await writeFile(samplePath, res.stdout, "utf8");
    }
    row.paid = {
      settled: res.settled,
      httpStatus: res.httpStatus,
      amountUsd: row.probe.livePriceUsd,
      capUsd,
      latencyMs: res.latencyMs,
      samplePath,
      ...(res.error ? { error: res.error } : {})
    };
  }
  console.error(fmt.dim(`  samples: ${sampleDir}`));
  return 0;
}

/**
 * One aligned comparison table; each row is followed by a dim endpoint-detail
 * line. Cells are padded as plain text, then single-glyph cells (PROBE, REL)
 * are colorized whole so ANSI codes never skew the column widths.
 */
function renderCompareTable(sorted, { pay, generatedAt }) {
  const priceCell = (v) => (v == null ? "?" : v === 0 ? "$0" : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
  const cells = sorted.map((row, i) => ({
    idx: String(i + 1),
    name: row.plan.service.name.length > 30 ? row.plan.service.name.slice(0, 28) + ".." : row.plan.service.name,
    price: priceCell(row.probe.livePriceUsd),
    rail: row.probe.mode ?? "—",
    latency: row.probe.latencyMs != null ? `${row.probe.latencyMs}ms` : "—",
    probe: row.probe.reachable ? "✓" : "✗",
    rel: row.reliability ? "●" : "○",
    paid: paidCell(row.paid)
  }));
  const header = { idx: "#", name: "SERVICE", price: "PRICE", rail: "RAIL", latency: "LATENCY", probe: "PROBE", rel: "REL", paid: "PAID" };
  const keys = ["idx", "name", "price", "rail", "latency", "probe", "rel", ...(pay ? ["paid"] : [])];
  const rightAligned = new Set(["idx", "price", "latency"]);
  const w = {};
  for (const key of keys) {
    w[key] = Math.max(header[key].length, ...cells.map((c) => c[key].length));
  }
  const padCell = (key, text) => (rightAligned.has(key) ? text.padStart(w[key]) : text.padEnd(w[key]));

  console.log("");
  console.log(fmt.bold("  " + keys.map((k) => padCell(k, header[k])).join("  ")));
  sorted.forEach((row, i) => {
    const c = cells[i];
    const colorFor = {
      probe: row.probe.reachable ? fmt.green : fmt.red,
      rel: row.reliability
        ? (row.reliability.status === "ok" ? fmt.green : fmt.red)
        : fmt.dim
    };
    console.log("  " + keys.map((k) => {
      const padded = padCell(k, c[k]);
      return colorFor[k] ? colorFor[k](padded) : padded;
    }).join("  "));

    const method = row.plan.endpoint?.method && row.plan.endpoint.method !== "?" ? row.plan.endpoint.method : "?";
    const detail = [`${method} ${row.plan.endpoint?.url ?? "(no endpoint)"}`];
    if (row.probe.error) detail.push(fmt.red(row.probe.error));
    if (row.paid?.skipped) detail.push(`pay skipped: ${row.paid.skipped}`);
    if (row.paid?.error) detail.push(fmt.red(`pay: ${row.paid.error}`));
    if (row.paid?.samplePath) detail.push(`sample: ${row.paid.samplePath}`);
    console.log(fmt.dim(`  ${" ".repeat(w.idx)}  ${detail.join("  ·  ")}`));
  });
  console.log("");
  console.log(fmt.dim(`PROBE: live 402 at the catalog serviceUrl (free, never settles).  REL: ${fmt.green("●")} ok  ${fmt.red("●")} down  ${fmt.dim("○")} unknown — selat-skills registry` +
    (generatedAt ? ` (checked ${relativeTime(generatedAt)})` : "")));
}

function paidCell(paid) {
  if (!paid) return "—";
  if (paid.skipped) return "skip";
  if (paid.settled) return `✓ ${paid.httpStatus ?? "?"} ${paid.latencyMs}ms`;
  return `✗ ${paid.httpStatus ?? "?"}`;
}

async function runCmd(args) {
  const name = args[0];
  if (!name) {
    console.error(fmt.error("usage: selat skill run <name> [--param value ...]"));
    return 1;
  }

  const { params, overrides, jsonMode } = parseSkillInvocationArgs(args.slice(1));

  const found = await resolveSkill(name);
  if (!found) {
    console.error(fmt.error(`skill '${name}' is not installed`));
    console.error(fmt.dim(`install it:  selat skill install ${name}`));
    return 1;
  }

  try {
    const { code, steps } = await invokeSkill(name, params, {
      overrides,
      capture: jsonMode,
      onStep: jsonMode ? undefined : ({ index, step, display, total }) => {
        const label = step.label ? ` — ${step.label}` : "";
        console.log(fmt.dim(`▸ step ${index + 1}/${total}${label}`));
        console.log(fmt.dim(`  selat-pay ${display}`));
        console.log("");
      }
    });

    if (jsonMode) {
      // One machine object for agents: per-step payloads plus a relay-ready
      // plain-language user_summary (see the selat-discovery skill's
      // "Talking To The User" guidance).
      const okCount = steps.filter((s) => s.ok).length;
      process.stdout.write(JSON.stringify({
        ok: code === 0,
        skill: found.name,
        user_summary: code === 0
          ? `Ran the ${found.name} skill: all ${steps.length} step${steps.length === 1 ? "" : "s"} succeeded; results are in the steps field.`
          : `Ran the ${found.name} skill: ${okCount} of ${steps.length} steps succeeded — the rest failed and were not charged beyond their caps.`,
        steps: steps.map((s) => {
          let response = (s.stdout ?? "").trim();
          try { response = JSON.parse(response); } catch { /* non-JSON body */ }
          return { index: s.index, label: s.label, rail: s.rail, ok: s.ok, ...(s.error ? { error: s.error } : {}), response };
        })
      }, null, 2) + "\n");
      return code;
    }

    // Per-step summary so a multi-rail run reports every rail, even if one failed.
    console.log(fmt.bold(`\n${found.name} — summary`));
    for (const s of steps) {
      const rail = s.rail ? ` [${s.rail}]` : "";
      const desc = s.label ?? `step ${s.index + 1}`;
      if (s.ok) console.log("  " + fmt.ok(`step ${s.index + 1}${rail}: ${desc}`));
      else console.log("  " + fmt.err(`step ${s.index + 1}${rail}: ${desc}${s.error ? ` (${s.error})` : ""}`));
    }
    return code;
  } catch (err) {
    if (err.paramKey) {
      console.error(fmt.error(`missing required --${err.paramKey}`));
      if (err.paramDescription) console.error(fmt.dim(`  ${err.paramDescription}`));
      return 1;
    }
    console.error(fmt.error(err.message ?? String(err)));
    if (err.selatPayMissing) return 1;
    return 1;
  }
}
