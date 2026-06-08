/**
 * `selat skill <list|install|run>` — manage and invoke Selat skills.
 *
 * A skill is a declarative manifest composed of one or more catalogue endpoint
 * steps; running one spawns selat-pay per step (see lib/skill-registry.mjs).
 * This is distinct from lib/skill.mjs (the rank.mjs finder) — different file,
 * different job.
 */

import { fmt } from "../ui.mjs";
import {
  listSkills,
  listAvailable,
  installSkill,
  invokeSkill,
  resolveSkill,
  scaffoldSkill,
  validateSkillDir,
  verifySkillDir,
  registerSkill,
  submitSkill
} from "../skill-registry.mjs";

const USAGE = `${fmt.bold("selat skill")} — manage, author, and run Selat skills

${fmt.bold("Subcommands:")}
  list [--available]            List installed skills, or available ones to install.
  install <name|path> [--force] Install a skill by name (from the registry) or a local path.
  run <name> [--p value ...]    Run an installed skill; pass its params as --flags.
  new <name> [--dir .] [--force] Scaffold a new skill folder (SOP layout) to contribute.
  validate <path>               Validate a skill folder against the Agent Skill SOP.
  verify <path> [--pay] [--p v]  Live-check each endpoint (real 402 price/rail); --pay makes a capped paid call.
  register <path> [--index p]   Add/update the skill's entry in index.json.
  submit <path> [--dry-run]     Open a PR to the selat-skills repo (gated on a passing verify receipt).

${fmt.bold("Examples:")}
  selat skill list --available
  selat skill install market-snapshot
  selat skill run token-price --symbols ETH,USDC
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
  console.log(fmt.header("Available skills"));
  const width = Math.max(...skills.map((s) => s.name.length));
  for (const s of skills) {
    const meta = [s.kind, s.rail].filter(Boolean).join("/");
    console.log(`  ${fmt.cyan(s.name.padEnd(width))}  ${fmt.dim(`(${meta})`.padEnd(16))}  ${s.description ?? ""}`);
  }
  console.log("");
  console.log(fmt.dim("Install one with:  selat skill install <name>"));
  return 0;
}

async function installCmd(args) {
  const force = args.includes("--force");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error(fmt.error("usage: selat skill install <name|path> [--force]"));
    return 1;
  }
  try {
    const { name, dir, source } = await installSkill(target, { force });
    const from = source && source !== "path" ? ` from ${source}` : "";
    console.log("  " + fmt.ok(`installed skill '${name}'${from} → ${dir}`));
    console.log("  " + fmt.dim(`run it:  selat skill run ${name}`));
    return 0;
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

async function newCmd(args) {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error(fmt.error("usage: selat skill new <name> [--dir <dir>] [--force]"));
    return 1;
  }
  const dir = flag(args, "--dir") || ".";
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
  const path = args.find((a) => !a.startsWith("--"));
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
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error(fmt.error("usage: selat skill verify <path> [--pay] [--param value ...]"));
    return 1;
  }
  // Parse flags: --pay (bare) enables the capped paid call; --chain/--max-amount
  // are reserved per-run overrides; everything else is a skill param.
  const params = {};
  const overrides = {};
  let pay = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "pay") { pay = true; continue; }
    const next = args[i + 1];
    const value = next != null && !next.startsWith("--") ? args[++i] : true;
    if (key === "chain") overrides.chain = value === true ? undefined : value;
    else if (key === "max-amount") overrides.maxAmount = value === true ? undefined : value;
    else params[key] = value;
  }

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
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error(fmt.error("usage: selat skill register <path> [--index <path>]"));
    return 1;
  }
  try {
    const { indexPath, entry, action } = await registerSkill(path, { indexPath: flag(args, "--index") || undefined });
    console.log("  " + fmt.ok(`${action} '${entry.name}' in ${indexPath}`));
    console.log("    " + fmt.dim(`${JSON.stringify(entry)}`));
    return 0;
  } catch (err) {
    console.error(fmt.error(err.message ?? String(err)));
    return 1;
  }
}

async function submitCmd(args) {
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error(fmt.error("usage: selat skill submit <path> [--dry-run] [--repo owner/name]"));
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const repo = flag(args, "--repo") || undefined;
  let res;
  try {
    res = await submitSkill(path, { dryRun, repo });
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
    return 0;
  }
  console.log("  " + (res.pushed ? fmt.warn(`branch '${res.branch}' pushed, but PR not opened`) : fmt.err("could not push")));
  if (res.hint) console.error(fmt.dim("  " + res.hint.split("\n").join("\n  ")));
  if (res.detail) console.error(fmt.dim("  " + res.detail));
  return 1;
}

async function runCmd(args) {
  const name = args[0];
  if (!name) {
    console.error(fmt.error("usage: selat skill run <name> [--param value ...]"));
    return 1;
  }

  // Parse trailing flags. --chain and --max-amount are reserved overrides
  // applied to every step; everything else becomes a skill param (manifest
  // keys map 1:1, no camelization). A bare --flag with no value is `true`.
  const params = {};
  const overrides = {};
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next != null && !next.startsWith("--") ? rest[++i] : true;
    if (key === "chain") overrides.chain = value === true ? undefined : value;
    else if (key === "max-amount") overrides.maxAmount = value === true ? undefined : value;
    else params[key] = value;
  }

  const found = await resolveSkill(name);
  if (!found) {
    console.error(fmt.error(`skill '${name}' is not installed`));
    console.error(fmt.dim(`install it:  selat skill install ${name}`));
    return 1;
  }

  try {
    const { code, steps } = await invokeSkill(name, params, {
      overrides,
      onStep: ({ index, step, display, total }) => {
        const label = step.label ? ` — ${step.label}` : "";
        console.log(fmt.dim(`▸ step ${index + 1}/${total}${label}`));
        console.log(fmt.dim(`  selat-pay ${display}`));
        console.log("");
      }
    });

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
