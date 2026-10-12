/**
 * selat-pay owns the session-budget ledger semantics (which outcomes count as
 * spend, in-flight write-ahead rows, settle-rejected exclusions). selat-cli
 * displays the same number by calling selat-pay's own exported
 * sessionSpentUsd from the bundled package instead of keeping a copy — a copy
 * already drifted once (it counted settle-rejected rows selat-pay excludes,
 * over-reporting `selat budget` ~28x on 2026-10-11).
 *
 * selat-pay's package `exports` map doesn't list its bin, so resolve the
 * package root through the exported package.json and import the bin by path.
 * Importing it is side-effect free (its CLI entry only runs when invoked
 * directly). Resolves to null when the bundled selat-pay can't be loaded.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

let loaded;
export async function selatPayLedger() {
  if (loaded !== undefined) return loaded;
  try {
    const pkg = createRequire(import.meta.url).resolve("@selat-ai/selat-pay/package.json");
    const mod = await import(pathToFileURL(join(dirname(pkg), "bin", "selat-pay.mjs")).href);
    loaded = typeof mod.sessionSpentUsd === "function" ? mod : null;
  } catch {
    loaded = null;
  }
  return loaded;
}
