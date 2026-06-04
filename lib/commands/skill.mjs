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
  resolveSkill
} from "../skill-registry.mjs";

const USAGE = `${fmt.bold("selat skill")} — manage and run Selat skills

${fmt.bold("Subcommands:")}
  list [--available]            List installed skills, or available ones to install.
  install <name|path> [--force] Install a skill by name (from the registry) or a local path.
  run <name> [--p value ...]    Run an installed skill; pass its params as --flags.

${fmt.bold("Examples:")}
  selat skill list --available
  selat skill install market-snapshot
  selat skill run market-snapshot
  selat skill run token-price --symbols ETH,USDC
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
