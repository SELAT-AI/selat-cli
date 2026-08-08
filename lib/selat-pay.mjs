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
 *
 * Resolution priority (highest first):
 *   1. $SELAT_PAY_BIN              — explicit user override; fails loud if missing.
 *   2. bundled @selat-ai/selat-pay — the version pinned in package.json. Default.
 *   3. global `selat-pay` on PATH  — last-resort fallback when the bundled dep
 *                                    is somehow missing.
 *
 * Bundled wins over global by design. A historically-installed global selat-pay
 * silently overriding the version selat-cli was tested against has been the
 * cause of skew bugs (see commit msg). Users who genuinely want a different
 * selat-pay should set $SELAT_PAY_BIN to that binary's absolute path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { sh, hasBin } from "./sh.mjs";
import { historyPath } from "./paths.mjs";

/** What every caller says when the resolver comes up empty. */
export const SELAT_PAY_MISSING_MESSAGE =
  "selat-pay not found — reinstall selat-cli, or install selat-pay globally.";

/** The throwable form, tagged so callers can skip their own error rendering. */
export function selatPayMissingError() {
  const err = new Error(SELAT_PAY_MISSING_MESSAGE);
  err.selatPayMissing = true;
  return err;
}

const require = createRequire(import.meta.url);

let _cached;

/**
 * Resolve a usable selat-pay install. See module-level doc for priority order.
 *
 * @returns {Promise<
 *   | { source: "env-override", bin: string, binDir: null, packageRoot: string|null }
 *   | { source: "bundled", bin: string, binDir: string, packageRoot: string }
 *   | { source: "global", bin: "selat-pay", binDir: null, packageRoot: null }
 *   | { source: null }
 * >}
 */
export async function resolveSelatPay() {
  if (_cached) return _cached;

  // 1. Explicit override via env var. Fail loud if the path doesn't exist so
  //    a typo doesn't silently fall through to a different binary.
  const envBin = process.env.SELAT_PAY_BIN;
  if (envBin) {
    if (!existsSync(envBin)) {
      throw new Error(`SELAT_PAY_BIN points to ${envBin} but that file does not exist`);
    }
    // Try to locate an adjacent package.json (.../bin/selat-pay.mjs -> .../package.json)
    const packageRoot = findPackageRoot(envBin);
    _cached = { source: "env-override", bin: envBin, binDir: null, packageRoot };
    return _cached;
  }

  // 2. Bundled dependency. This is the pinned-by-package.json version
  //    selat-cli was tested against — wins over a global install to prevent
  //    silent version skew.
  try {
    const pkgJsonPath = require.resolve("@selat-ai/selat-pay/package.json");
    const pkgRoot = dirname(pkgJsonPath);
    const binPath = join(pkgRoot, "bin", "selat-pay.mjs");
    if (existsSync(binPath)) {
      // <selat-cli-root>/node_modules/@selat-ai/selat-pay -> up to .bin
      const binDir = join(pkgRoot, "..", "..", ".bin");
      _cached = { source: "bundled", bin: binPath, binDir, packageRoot: pkgRoot };
      return _cached;
    }
  } catch {
    // bundled dep missing — fall through to the global last-resort
  }

  // 3. Last-resort fallback: global selat-pay on PATH. Only reached when
  //    selat-cli's bundled dep is missing (broken install, monorepo workspace,
  //    etc.). selat-cli doesn't know the global's version; doctor will surface
  //    it as "global" so the user can decide whether to trust it.
  if (await hasBin("selat-pay")) {
    _cached = { source: "global", bin: "selat-pay", binDir: null, packageRoot: null };
    return _cached;
  }

  _cached = { source: null };
  return _cached;
}

export async function hasSelatPay() {
  const r = await resolveSelatPay();
  return r.source !== null;
}

/**
 * Build the command to spawn a resolved selat-pay install with `sh()`.
 *
 * For a resolved file path (env-override, bundled) we execute it directly with
 * the current Node (process.execPath, as selatPayVersion already does), so PATH
 * lookup of a bare `selat-pay` can never silently substitute a different binary
 * — the version-skew class the resolver exists to prevent. Only the last-resort
 * "global" source, which has no known path, goes through PATH.
 *
 * @param {Awaited<ReturnType<typeof resolveSelatPay>>} resolved
 * @param {string[]} argv  selat-pay arguments (without the leading "selat-pay")
 * @returns {{ cmd: string, args: string[] }}
 */
export function selatPaySpawn(resolved, argv) {
  if (!resolved || resolved.source == null) {
    throw new Error("selat-pay is not resolved");
  }
  if (resolved.source === "global") {
    return { cmd: "selat-pay", args: argv };
  }
  return { cmd: process.execPath, args: [resolved.bin, ...argv] };
}

/**
 * Ensure selat-pay's local Gateway history directory exists before we spawn it.
 *
 * selat-pay treats history as best-effort, but creating the directory here
 * avoids noisy "history write failed: ENOENT" messages on fresh machines while
 * preserving user overrides via SELAT_PAY_HISTORY_PATH / XDG_STATE_HOME.
 */
export async function ensureSelatPayHistoryDir() {
  await mkdir(dirname(historyPath()), { recursive: true });
}

/**
 * Returns a human-readable description of the resolved selat-pay install,
 * including the package version when discoverable. Format examples:
 *   "installed (bundled, v0.3.1)"
 *   "installed (env-override, /usr/local/bin/selat-pay, v0.3.1)"
 *   "installed (global, v0.3.0)"   ← version when --version flag exists
 *   "installed (global)"           ← when version cannot be probed
 */
export async function selatPayVersion() {
  const r = await resolveSelatPay();
  if (r.source === null) return null;

  // Read version from package.json when we know where the install lives.
  let version = null;
  if (r.packageRoot) {
    try {
      const pkg = JSON.parse(readFileSync(join(r.packageRoot, "package.json"), "utf8"));
      version = pkg.version;
    } catch {
      // missing or unreadable package.json — leave version null
    }
  }

  // Confirm the binary actually runs. (selat-pay doesn't expose --version yet;
  // --help is the cheapest smoke check.)
  const cmd = r.source === "global" ? "selat-pay" : process.execPath;
  const args = r.source === "global" ? ["--help"] : [r.bin, "--help"];
  const res = await sh(cmd, args).catch(() => ({ code: 1 }));
  if (res.code !== 0) return null;

  if (r.source === "env-override") {
    return version
      ? `installed (env-override, ${r.bin}, v${version})`
      : `installed (env-override, ${r.bin})`;
  }
  return version ? `installed (${r.source}, v${version})` : `installed (${r.source})`;
}

function findPackageRoot(binPath) {
  // Walk up from the binary looking for a package.json. Bounded depth so a
  // weird symlink can't spin forever.
  let dir = dirname(binPath);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
