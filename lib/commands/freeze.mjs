/**
 * `selat freeze` / `selat unfreeze` — instant local kill switch.
 *
 * Freeze writes a flag file; selat-pay checks it pre-signature (right beside
 * the session-budget check) and refuses every paid call while it exists.
 * Unfreeze removes the file. Purely local — no Circle round-trip — so it is
 * effective the moment the file lands on disk. The unbypassable ceiling
 * remains the Circle wallet policy (`selat setup-policy`).
 *
 * Schema owner is selat-pay (freezePath/isFrozen in bin/selat-pay.mjs);
 * these mirror it so `selat` can write/read the flag without spawning.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fmt } from "../ui.mjs";
import { selatPayStatePath } from "../paths.mjs";

export function freezeFilePath() {
  return selatPayStatePath("frozen.json", "SELAT_PAY_FREEZE_PATH");
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
  return `FROZEN since ${at}${note} · all payments refused · resume: selat unfreeze`;
}

const FREEZE_HELP = `${fmt.bold("selat freeze")} — instantly refuse all paid calls (local kill switch)

${fmt.bold("Usage:")}
  selat freeze [--note "<why>"]

Writes a local flag file that selat-pay checks before signing anything.
Every paid call is refused until you run ${fmt.cyan("selat unfreeze")}.
Local and instant — no Circle round-trip. Probes and free discovery keep working.`;

const UNFREEZE_HELP = `${fmt.bold("selat unfreeze")} — resume paid calls after a freeze

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
    console.log(fmt.ok(`payments were already frozen — freeze refreshed (${frozenAt})`));
  } else {
    console.log(fmt.ok(`payments frozen (${frozenAt})`));
  }
  if (note) console.log(fmt.dim(`  note: ${note}`));
  console.log(fmt.dim("  every paid call is now refused before signing; probes and free discovery still work"));
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
    console.log(fmt.dim("payments were not frozen"));
    return 0;
  }
  rmSync(file);
  console.log(fmt.ok("payments unfrozen — paid calls can settle again"));
  console.log(fmt.dim("  the wallet policy caps (selat budget) still apply"));
  return 0;
}
