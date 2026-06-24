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

import { join } from "node:path";
import { sh, shellQuoteForDisplay } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { findSkill, skillInstallLines } from "../skill.mjs";
import { ensureSelatPayHistoryDir, resolveSelatPay, selatPaySpawn } from "../selat-pay.mjs";

export async function run(args) {
  const intent = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!intent) {
    console.error(fmt.error("usage: selat run \"<intent>\""));
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

  console.log(fmt.dim(`▸ ranking intent: "${intent}"`));

  // Step 1: pick
  const pick = await sh(
    "node",
    [join(skill.path, "scripts", "rank.mjs"), intent, "--pick"]
  );
  if (pick.code !== 0) {
    console.error(fmt.error("rank.mjs failed:"));
    console.error(pick.stderr || pick.stdout);
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
  console.log(fmt.dim(`▸ running: ${display}`));
  console.log("");

  // Step 3: execute without a shell. selatPaySpawn runs the resolved binary
  // directly (process.execPath + bin path) for env-override/bundled, so PATH
  // can't substitute a different selat-pay; only "global" goes through PATH.
  const { cmd, args: spawnArgs } = selatPaySpawn(selatPay, selatPayArgs);
  await ensureSelatPayHistoryDir();
  const run = await sh(cmd, spawnArgs, { inherit: true });
  return run.code;
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
