/**
 * juris-pay helpers — install detection, version check.
 *
 * juris-pay currently lives in the juris-router repo at juris-pay/.
 */

import { sh, hasBin } from "./sh.mjs";

export async function hasJurisPay() {
  return hasBin("juris-pay");
}

export async function jurisPayVersion() {
  // juris-pay doesn't have a `--version` flag yet; just confirm `--help` runs.
  const r = await sh("juris-pay", ["--help"]).catch(() => ({ code: 1 }));
  return r.code === 0 ? "installed" : null;
}
