/**
 * Shell-out helpers. Promisified spawn + run-and-capture, with sensible defaults.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";

import { debugError, errorMessage } from "./debug.mjs";

export const isWindows = process.platform === "win32";

/**
 * Exit code for a child that was killed by a signal. `close` reports code null
 * in that case, and reporting it as 0 would turn a killed payment process into
 * a success. Follows the shell convention of 128 + signal number.
 */
export function signalExitCode(signal) {
  const number = signal ? constants.signals[signal] : null;
  return 128 + (typeof number === "number" ? number : 0);
}

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
 * @returns {Promise<{ code: number, signal: string|null, stdout: string, stderr: string }>}
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
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? signalExitCode(signal),
        signal: signal ?? null,
        stdout,
        stderr
      })
    );
    if (opts.input && child.stdin) {
      // A child that exits before reading its input makes this write emit EPIPE
      // on the stream. Unhandled, that error event crashes the CLI with a stack
      // unrelated to what the user ran; the child's own exit code is the signal
      // that matters, so surface the write failure only under SELAT_DEBUG.
      child.stdin.on("error", (err) => debugError(`writing stdin to ${command}`, err));
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * sh() that reports a spawn failure as a result instead of rejecting, so
 * callers can tell "the binary isn't there" apart from "it ran and failed" —
 * `.catch(() => null)` collapses both and loses the reason. `code` is null
 * when the process never started; the reason is in `stderr` / `spawnError`.
 *
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, spawnError?: Error }>}
 */
export async function shSafe(command, args = [], opts = {}) {
  try {
    return await sh(command, args, opts);
  } catch (err) {
    debugError(`spawning ${command}`, err);
    return {
      code: null,
      signal: null,
      stdout: "",
      stderr: errorMessage(err),
      spawnError: err instanceof Error ? err : new Error(errorMessage(err))
    };
  }
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
    const where = await shSafe("where", [name]);
    return where.code === 0 && where.stdout.trim().length > 0;
  }
  const result = await shSafe("command", ["-v", name]);
  if (result.code === 0 && result.stdout.trim()) return true;
  // Fallback: try `which` on macOS/Linux.
  const which = await shSafe("which", [name]);
  return which.code === 0 && which.stdout.trim().length > 0;
}

/**
 * Get a version string by running `<bin> --version`. Returns trimmed first line or null.
 */
export async function binVersion(bin, versionArg = "--version") {
  const r = await shSafe(bin, [versionArg]);
  if (r.code !== 0) return null;
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
