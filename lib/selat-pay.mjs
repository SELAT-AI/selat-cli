/**
 * selat-pay helpers — install detection, version check, resolver.
 *
 * selat-pay is bundled as a dependency of selat-cli, so when selat-cli is
 * installed globally the binary lives at:
 *   <selat-cli>/node_modules/@selat-ai/selat-pay/bin/selat-pay.mjs
 * and is symlinked into:
 *   <selat-cli>/node_modules/.bin/selat-pay
 *
 * npm only links the *top-level* package's bin entries onto the user's
 * global PATH, so the bundled selat-pay is NOT on PATH after a clean
 * `npm install -g @selat-ai/selat-cli`. This module resolves it explicitly.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { sh, hasBin } from "./sh.mjs";

const require = createRequire(import.meta.url);

let _cached;

/**
 * Resolve a usable selat-pay install. Prefers a global install if present
 * (lets a user override the bundled copy), otherwise falls back to the
 * bundled dependency.
 *
 * @returns {Promise<
 *   | { source: "global", bin: "selat-pay", binDir: null }
 *   | { source: "bundled", bin: string, binDir: string }
 *   | { source: null }
 * >}
 */
export async function resolveSelatPay() {
  if (_cached) return _cached;

  if (await hasBin("selat-pay")) {
    _cached = { source: "global", bin: "selat-pay", binDir: null };
    return _cached;
  }

  try {
    const pkgJsonPath = require.resolve("@selat-ai/selat-pay/package.json");
    const pkgRoot = dirname(pkgJsonPath);
    const binPath = join(pkgRoot, "bin", "selat-pay.mjs");
    if (existsSync(binPath)) {
      // <selat-cli-root>/node_modules/@selat-ai/selat-pay -> up to .bin
      const binDir = join(pkgRoot, "..", "..", ".bin");
      _cached = { source: "bundled", bin: binPath, binDir };
      return _cached;
    }
  } catch {
    // dep not installed — fall through
  }

  _cached = { source: null };
  return _cached;
}

export async function hasSelatPay() {
  const r = await resolveSelatPay();
  return r.source !== null;
}

export async function selatPayVersion() {
  // selat-pay doesn't have a `--version` flag yet; just confirm `--help` runs.
  const r = await resolveSelatPay();
  if (r.source === null) return null;
  const cmd = r.source === "global" ? "selat-pay" : process.execPath;
  const args = r.source === "global" ? ["--help"] : [r.bin, "--help"];
  const res = await sh(cmd, args).catch(() => ({ code: 1 }));
  if (res.code !== 0) return null;
  return r.source === "bundled" ? "installed (bundled)" : "installed (global)";
}
