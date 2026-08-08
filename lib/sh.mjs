/**
 * Shell-out helpers. Promisified spawn + run-and-capture, with sensible defaults.
 */

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { statSync } from "node:fs";

export const isWindows = process.platform === "win32";

// cmd.exe metacharacters that must be ^-escaped so the shell treats them as
// literal text rather than syntax (redirection, piping, grouping, var expansion).
const CMD_META = /([()%!^"<>&|])/g;

/**
 * Quote one argv element so the CHILD process's CommandLineToArgvW parser
 * rebuilds it byte-for-byte: double every run of backslashes that precedes a
 * quote (and the trailing run), escape quotes as \", then wrap. This is the
 * layer the old one-liner got wrong — it doubled only trailing backslashes, so
 * a backslash-before-quote (every JSON body with a quoted string value) was
 * corrupted, sending an altered payload into a paid call on Windows.
 */
export function quoteArgvWin(value) {
  const s = String(value);
  if (s === "") return '""';
  if (!/[\s"]/.test(s)) return s;
  const body = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${body}"`;
}

/**
 * Full Windows command-line quoting for `cmd.exe /d /s /c "<line>"`, ported from
 * the cross-spawn algorithm (github.com/moxystudio/node-cross-spawn) — the
 * de-facto correct handling of the two stacked parsers involved:
 *   1. CommandLineToArgvW (the child) — handled by quoteArgvWin above;
 *   2. cmd.exe itself, which sees the line first — handled by ^-escaping every
 *      metacharacter (including inside the argv quotes, so `&`/`|`/`%` in a
 *      value can't break out into shell syntax).
 * A .cmd/.bat target re-parses its arguments a second time (npm shims forward
 * `%*`), so metacharacters in its args are ^-escaped TWICE. Real executables
 * (node.exe) parse once, so single-escaped.
 */
function escapeCmdArg(arg, batch) {
  let s = quoteArgvWin(arg).replace(CMD_META, "^$1");
  if (batch) s = s.replace(CMD_META, "^$1");
  return s;
}
function escapeCmdCommand(command) {
  return command.replace(CMD_META, "^$1");
}

// Is the resolved command a batch shim (.cmd/.bat)? Those double-parse their
// arguments. An explicit extension answers directly; a bare name is resolved
// via `where` (PATHEXT-aware) — this is what makes `circle`/`npm` (installed as
// .cmd) escape correctly while `node`/`where` do not.
function isBatchCommand(command) {
  if (/\.(cmd|bat)$/i.test(command)) return true;
  if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) return false; // resolved path, no extension → not batch
  const r = spawnSync("where", [command], { encoding: "utf8" });
  const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return !!first && /\.(cmd|bat)$/i.test(first.trim());
}

/**
 * Run a command and capture stdout/stderr/exit code.
 * Does not throw on non-zero exit; caller checks `code`.
 *
 * On Windows the binaries we shell out to (`circle`, `npm`) are installed by npm
 * as `.cmd` shims, which CreateProcess cannot execute directly — they must go
 * through cmd.exe. Rather than Node's `shell: true` (which joins argv into a
 * string with no escaping, leaving us to hand-quote), we invoke cmd.exe
 * explicitly with `windowsVerbatimArguments` and a fully-escaped command line so
 * both the shell and the child parse the arguments back exactly as given.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, cwd?: string, input?: string, inherit?: boolean, inheritStdout?: boolean }} opts
 *   `inheritStdout` streams the child's stdout straight to the terminal while
 *   still capturing stderr, so callers can decide whether diagnostics surface.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function sh(command, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    let file = command;
    let spawnArgs = args;
    let spawnOpts = {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: opts.inherit
        ? "inherit"
        : opts.inheritStdout
          ? ["inherit", "inherit", "pipe"]
          : ["pipe", "pipe", "pipe"]
    };
    if (isWindows) {
      const batch = isBatchCommand(command);
      const line = [escapeCmdCommand(command), ...args.map((a) => escapeCmdArg(a, batch))].join(" ");
      file = process.env.comspec || "cmd.exe";
      spawnArgs = ["/d", "/s", "/c", `"${line}"`];
      spawnOpts.windowsVerbatimArguments = true;
    }
    const child = spawn(file, spawnArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    if (!opts.inherit) {
      child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    }
    child.on("error", reject);
    // A signal-killed child closes with code=null — that is a failure, not a
    // success. `code ?? 0` mapped an OOM-killed or Ctrl-C'd selat-pay to exit
    // 0, so callers printed "paid — settled" (and --json emitted ok:true) for
    // a payment that died mid-flight. 128+signal mirrors shell convention;
    // stderr carries the signal name for the caller's error surface.
    child.on("close", (code, signal) => {
      if (code == null) {
        const sig = signal || "unknown signal";
        resolve({ code: 128 + (os.constants.signals[signal] ?? 1), stdout, stderr: stderr + `\nprocess killed by ${sig}`, signal: sig });
        return;
      }
      resolve({ code, stdout, stderr });
    });
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
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
  // nor `command -v` resolves those, so test the filesystem directly. Must be a
  // file: existsSync alone answered true for a directory (e.g. CIRCLE_BIN
  // pointing at an install folder rather than the binary inside it), passing
  // the check here only to fail with EACCES/EISDIR at spawn time.
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    try {
      return statSync(name).isFile();
    } catch {
      return false;
    }
  }
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
