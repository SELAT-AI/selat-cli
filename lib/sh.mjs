/**
 * Shell-out helpers. Promisified spawn + run-and-capture, with sensible defaults.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const isWindows = process.platform === "win32";

/**
 * Run a command and capture stdout/stderr/exit code.
 * Does not throw on non-zero exit; caller checks `code`.
 *
 * On Windows the binaries we shell out to (`circle`, `npm`) are installed by npm
 * as `.cmd` shims, which CreateProcess cannot execute directly — Node only runs
 * them through cmd.exe. `shell: true` is therefore required there, and unlike on
 * POSIX it is not a quoting hazard: every argv element is escaped below before
 * cmd.exe sees it.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, cwd?: string, input?: string, inherit?: boolean, inheritStdout?: boolean }} opts
 *   `inheritStdout` streams the child's stdout straight to the terminal while
 *   still capturing stderr, so callers can decide whether diagnostics surface.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function sh(command, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(isWindows ? quoteWin(command) : command, isWindows ? args.map(quoteWin) : args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      shell: isWindows,
      stdio: opts.inherit
        ? "inherit"
        : opts.inheritStdout
          ? ["inherit", "inherit", "pipe"]
          : ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    if (!opts.inherit) {
      child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Escape one argv element for cmd.exe. `shell: true` on Windows concatenates
 * argv into a command string, so anything unquoted with a space or a cmd
 * metacharacter would split or inject. Double quotes are doubled per cmd's own
 * rules; a trailing backslash is doubled so it does not escape the closing quote.
 */
function quoteWin(value) {
  const s = String(value);
  if (s.length && !/[\s"^&|<>()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Detect whether a binary is on PATH.
 *
 * `command -v` and `which` are POSIX-only — neither exists on Windows, so the
 * previous implementation returned false for every binary there, including a
 * Circle CLI that was installed and working. Windows uses `where`, which also
 * resolves the PATHEXT shims (`circle.cmd`) that npm actually installs.
 */
export async function hasBin(name) {
  // CIRCLE_BIN may be an explicit path rather than a PATH entry; neither `where`
  // nor `command -v` resolves those, so test the filesystem directly.
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return existsSync(name);
  if (isWindows) {
    const where = await sh("where", [name]).catch(() => ({ code: 1, stdout: "" }));
    return where.code === 0 && where.stdout.trim().length > 0;
  }
  const result = await sh("command", ["-v", name]).catch(() => ({ code: 1 }));
  if (result.code === 0 && result.stdout.trim()) return true;
  // Fallback: try `which` on macOS/Linux.
  const which = await sh("which", [name]).catch(() => ({ code: 1 }));
  return which.code === 0 && which.stdout.trim().length > 0;
}

/**
 * Get a version string by running `<bin> --version`. Returns trimmed first line or null.
 */
export async function binVersion(bin, versionArg = "--version") {
  const r = await sh(bin, [versionArg]).catch(() => null);
  if (!r || r.code !== 0) return null;
  return (r.stdout + r.stderr).split("\n")[0].trim() || null;
}

/**
 * Quote a single argument for human-readable display of a shell command. Not
 * for execution — sh() runs argv arrays without a shell.
 */
export function shellQuoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
