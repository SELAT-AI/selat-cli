/**
 * Shell-out helpers. Promisified spawn + run-and-capture, with sensible defaults.
 */

import { spawn } from "node:child_process";

/**
 * Run a command and capture stdout/stderr/exit code.
 * Does not throw on non-zero exit; caller checks `code`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, cwd?: string, input?: string, inherit?: boolean }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function sh(command, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"]
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
 * Detect whether a binary is on PATH.
 */
export async function hasBin(name) {
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
