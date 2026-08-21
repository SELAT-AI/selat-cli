/**
 * `selat freeze` / `selat unfreeze` — local kill switch for fund + pay.
 *
 * Freeze writes a flag file. This CLI refuses `selat fund` (deposits and
 * --onramp) and paid selat-pay spawns while it exists. selat-pay also checks
 * the same file pre-signature. Unfreeze removes the file. Purely local — no
 * Circle round-trip, and it does not change Circle wallet policy
 * (`selat setup-policy` stays OTP-gated).
 *
 * Schema owner is selat-pay (freezePath/isFrozen in bin/selat-pay.mjs);
 * these mirror it so `selat` can write/read the flag without spawning.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fmt } from "../ui.mjs";

function stateHome() {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

export function freezeFilePath() {
  return process.env.SELAT_PAY_FREEZE_PATH || join(stateHome(), "selat-pay", "frozen.json");
}

/**
 * Read the freeze flag. Mirrors selat-pay's isFrozen(): fail closed — a
 * present-but-malformed flag file still counts as frozen; only removing the
 * file unfreezes. Returns { frozenAt, note } or null when not frozen.
 */
export function readFreeze({ path = freezeFilePath() } = {}) {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf8"));
    return {
      frozenAt: typeof f?.frozenAt === "string" ? f.frozenAt : null,
      note: typeof f?.note === "string" ? f.note : null,
    };
  } catch {
    return { frozenAt: null, note: null };
  }
}

/**
 * One prominent human line for a readFreeze() result, shared by the freeze
 * command and the `selat budget` display. Returns null when not frozen.
 */
export function freezeStatusLine(frozen) {
  if (!frozen) return null;
  const at = frozen.frozenAt ?? "unknown time";
  const note = frozen.note ? ` — ${frozen.note}` : "";
  return `FROZEN since ${at}${note} · fund + pay from this CLI refused · resume: selat unfreeze`;
}

/**
 * If a freeze flag is present, return the refuse payload for a money-moving
 * command. Fail closed (same as readFreeze). `kind` is "fund" or "pay" so
 * the error names the action that was blocked. Returns null when not frozen.
 */
export function frozenMoneyMove(kind = "pay", { path = freezeFilePath() } = {}) {
  const frozen = readFreeze({ path });
  if (!frozen) return null;
  const at = frozen.frozenAt ?? "unknown time";
  const note = frozen.note ? ` — ${frozen.note}` : "";
  const action = kind === "fund" ? "fund (deposits / onramp)" : "pay";
  return {
    frozen,
    error: `frozen since ${at}${note} — this CLI will not ${action} until you run selat unfreeze`,
    hint: "Freeze is a local kill switch for fund + pay from this CLI. It does not change Circle wallet policy.",
  };
}

const FREEZE_HELP = `${fmt.bold("selat freeze")} — local kill switch for fund + pay from this CLI

${fmt.bold("Usage:")}
  selat freeze [--note "<why>"]

Writes a local flag file. While it exists this CLI refuses ${fmt.cyan("selat fund")}
(deposits and --onramp) and paid calls. selat-pay also refuses to sign.
Local and instant — no Circle round-trip, and Circle wallet policy is unchanged.
Probes and free discovery keep working. Resume with ${fmt.cyan("selat unfreeze")}.`;

const UNFREEZE_HELP = `${fmt.bold("selat unfreeze")} — resume fund + pay after a freeze

${fmt.bold("Usage:")}
  selat unfreeze`;

/** `--note <text>` or `--note=<text>` from argv, else null. Exported for tests. */
export function noteArg(args) {
  const eq = args.find((a) => a.startsWith("--note="));
  if (eq) return eq.slice("--note=".length) || null;
  const idx = args.indexOf("--note");
  if (idx === -1) return null;
  const next = args[idx + 1];
  return next && !next.startsWith("--") ? next : null;
}

export async function freeze(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(FREEZE_HELP);
    return 0;
  }
  const note = noteArg(args);
  const file = freezeFilePath();
  const already = readFreeze({ path: file });
  const frozenAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ schema: "selat-pay.freeze/v1", frozenAt, ...(note ? { note } : {}) }, null, 2) + "\n",
    { mode: 0o600 }
  );
  if (already) {
    console.log(fmt.ok(`fund + pay were already frozen — freeze refreshed (${frozenAt})`));
  } else {
    console.log(fmt.ok(`fund + pay frozen (${frozenAt})`));
  }
  if (note) console.log(fmt.dim(`  note: ${note}`));
  console.log(fmt.dim("  local kill switch: this CLI will refuse fund and pay until you unfreeze"));
  console.log(fmt.dim("  probes and free discovery still work · Circle wallet policy is unchanged"));
  console.log(fmt.dim("  resume: selat unfreeze · check: selat budget"));
  return 0;
}

export async function unfreeze(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(UNFREEZE_HELP);
    return 0;
  }
  const file = freezeFilePath();
  const frozen = readFreeze({ path: file });
  if (!frozen) {
    console.log(fmt.dim("fund + pay were not frozen"));
    return 0;
  }
  rmSync(file);
  console.log(fmt.ok("unfrozen — this CLI can fund and pay again"));
  console.log(fmt.dim("  the wallet policy caps (selat budget) still apply"));
  return 0;
}
