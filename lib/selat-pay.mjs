/**
 * selat-pay helpers — install detection, version check.
 *
 * selat-pay currently lives in the selat-router repo at selat-pay/.
 */

import { sh, hasBin } from "./sh.mjs";

export async function hasSelatPay() {
  return hasBin("selat-pay");
}

export async function selatPayVersion() {
  // selat-pay doesn't have a `--version` flag yet; just confirm `--help` runs.
  const r = await sh("selat-pay", ["--help"]).catch(() => ({ code: 1 }));
  return r.code === 0 ? "installed" : null;
}
