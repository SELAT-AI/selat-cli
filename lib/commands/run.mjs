/**
 * `juris run <intent>` — discover + rank + pay in one pipe.
 *
 * Equivalent to:
 *   node scripts/rank.mjs "<intent>" --pick | jq -r '.exec_hints[0].cmd' | sh
 *
 * For v0 this expects the runtime-integration-and-discovery skill to be
 * installed at ~/.claude/skills/runtime-integration-and-discovery (the
 * default Claude Code skill install path). If it isn't found, prints
 * install instructions and exits.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sh, hasBin } from "../sh.mjs";
import { fmt } from "../ui.mjs";

const DEFAULT_SKILL_PATH = process.env.JURIS_SKILL_PATH ||
  join(homedir(), ".claude", "skills", "runtime-integration-and-discovery");

export async function run(args) {
  const intent = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!intent) {
    console.error(fmt.error("usage: juris run \"<intent>\""));
    return 1;
  }

  if (!existsSync(join(DEFAULT_SKILL_PATH, "scripts", "rank.mjs"))) {
    console.error(fmt.error("Skill not found at " + DEFAULT_SKILL_PATH));
    console.error("");
    console.error("Install the skill (one-time):");
    console.error(fmt.cyan("  git clone https://github.com/MyJuris/juris-agent-payments " + DEFAULT_SKILL_PATH));
    console.error(fmt.cyan("  cd " + DEFAULT_SKILL_PATH + " && npm install"));
    console.error("");
    console.error("Or set JURIS_SKILL_PATH to a custom location.");
    return 1;
  }

  if (!(await hasBin("juris-pay"))) {
    console.error(fmt.error("juris-pay not on PATH — run `juris init` first."));
    return 1;
  }

  if (!(await hasBin("jq"))) {
    console.error(fmt.warn("jq not on PATH — required for the canonical pipeline."));
    console.error(fmt.dim("Install: `brew install jq` or your package manager."));
    return 1;
  }

  console.log(fmt.dim(`▸ ranking intent: "${intent}"`));

  // Step 1: pick
  const pick = await sh(
    "node",
    [join(DEFAULT_SKILL_PATH, "scripts", "rank.mjs"), intent, "--pick"]
  );
  if (pick.code !== 0) {
    console.error(fmt.error("rank.mjs failed:"));
    console.error(pick.stderr || pick.stdout);
    return 1;
  }

  // Step 2: jq extract
  const jq = await sh("jq", ["-r", ".exec_hints[0].cmd // empty"], { input: pick.stdout });
  if (jq.code !== 0 || !jq.stdout.trim()) {
    console.error(fmt.error("no runnable juris-pay command in pick output"));
    console.error(fmt.dim("This usually means the top match has no routable payment terms."));
    console.error(fmt.dim("Try --payable-now or inspect the live 402 manually."));
    return 1;
  }

  const cmd = jq.stdout.trim();
  console.log(fmt.dim(`▸ running: ${cmd}`));
  console.log("");

  // Step 3: execute
  const run = await sh("sh", ["-c", cmd], { inherit: true });
  return run.code;
}
