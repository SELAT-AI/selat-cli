/**
 * juris-pay helpers — install detection, version check.
 *
 * juris-pay currently lives in the juris-router repo at juris-pay/. Two
 * install paths:
 *   1. (preferred, once published) `npm install -g @myjuris/juris-pay`
 *   2. (today) clone juris-router, cd juris-pay/, npm install && npm link
 */

import { sh, hasBin, binVersion } from "./sh.mjs";

export async function hasJurisPay() {
  return hasBin("juris-pay");
}

export async function jurisPayVersion() {
  // juris-pay doesn't have a `--version` flag yet; just confirm `--help` runs.
  const r = await sh("juris-pay", ["--help"]).catch(() => ({ code: 1 }));
  return r.code === 0 ? "installed" : null;
}

export async function installJurisPay() {
  // For v0, try the npm path first; if it 404s (not published yet), fall through.
  const tryNpm = await sh("npm", ["install", "-g", "@myjuris/juris-pay"], { inherit: true }).catch(
    () => ({ code: 1 })
  );
  if (tryNpm.code === 0) return { ok: true, source: "npm" };

  return {
    ok: false,
    source: "manual",
    reason:
      "Could not install @myjuris/juris-pay from npm (likely not published yet). " +
      "Install manually: git clone https://github.com/MyJuris/juris-router && cd juris-router/juris-pay && npm install && npm link"
  };
}
