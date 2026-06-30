/**
 * Host adaptation — make `selat` work inside agent harnesses that don't behave
 * like a normal login shell.
 *
 * This logic used to live in the selat-plugins SessionStart hook
 * (`ensure-runner.sh`), but the plugin bundle only updates when the user runs
 * their harness's plugin-update command (and OpenClaw has no auto-update at
 * all). The runner, by contrast, is re-pulled to `latest` by that same hook
 * every session — even on a stale bundle — so host-adaptation that lives HERE
 * reaches every existing install automatically. See SELAT-AI/selat-cli#46.
 *
 * Everything in this module is best-effort and fail-safe: a problem adapting to
 * the host must never block the command the user actually ran.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync
} from "node:fs";

// Harnesses that (a) don't persist the SessionStart hook's env and (b) run agent
// shell commands in a process that doesn't source ~/.zshrc / ~/.bash_profile — so
// neither $SELAT_RUNNER nor a shell-rc PATH line reaches the session, and bare
// `selat` won't resolve. For each, when its marker dir exists (the harness is
// present) we symlink `selat` into a dir already on that harness's PATH.
//   OpenClaw: ~/.openclaw present → link into ~/.openclaw/bin (verified live).
// Add more harnesses here as the same "no env file / doesn't source rc" pattern
// shows up; it's the only place that needs to change.
const HARNESS_BIN_DIRS = [
  { name: "openclaw", marker: ".openclaw", binSegments: [".openclaw", "bin"] }
];

/**
 * Symlink this runner onto PATH for harnesses that otherwise can't find `selat`.
 * Idempotent (skips when the link already points at us), fail-safe, and a no-op
 * on every host whose marker dir is absent — so it costs ~nothing on Claude Code,
 * Cursor, a plain terminal, etc.
 */
export function ensureHarnessPath() {
  let self;
  try {
    // The path the user invoked us by (the shim, or a global bin). Resolve through
    // symlinks so the link we create points at the real entry, not back at itself.
    self = realpathSync(process.argv[1]);
  } catch {
    return;
  }
  if (!self) return;

  const home = homedir();
  for (const h of HARNESS_BIN_DIRS) {
    try {
      if (!existsSync(join(home, h.marker))) continue; // harness not present here
      const binDir = join(home, ...h.binSegments);
      const link = join(binDir, "selat");

      // Already linked to us? Leave it.
      try {
        if (lstatSync(link).isSymbolicLink() && realpathSync(link) === self) continue;
      } catch {
        /* link missing or dangling — (re)create below */
      }

      mkdirSync(binDir, { recursive: true });
      try {
        unlinkSync(link); // clear a stale file/symlink if present
      } catch {
        /* nothing to remove */
      }
      symlinkSync(self, link);
    } catch {
      /* never block a command over PATH linking */
    }
  }
}

// The catalog hosts SELAT discovery must reach. Mirrors guides/cursor.md +
// install.md so the in-CLI hint and the docs stay in lockstep.
const SANDBOX_ALLOW = ["api.circle.com", "*.selat.ai", "registry.npmjs.org", "*.npmjs.org"];

/**
 * Guidance (NOT an action) for when an agent host sandboxes network egress and
 * blocks the catalog fetch — e.g. Cursor 2.5+ denies egress by default. We never
 * write the sandbox config ourselves: it's the user's own security boundary.
 */
export function sandboxHintText() {
  return [
    "Your agent host may be sandboxing network egress (e.g. Cursor 2.5+ denies it by",
    "default). SELAT discovery needs api.circle.com + router.selat.ai. Allowlist them in",
    ".cursor/sandbox.json (or ~/.cursor/sandbox.json):",
    '  { "networkPolicy": { "default": "deny", "allow": ' + JSON.stringify(SANDBOX_ALLOW) + " } }",
    "…or run the selat command in a normal terminal outside the sandbox."
  ].join("\n");
}

/**
 * Probe the real public discovery endpoint (the same fetch `selat search` makes)
 * to decide whether a catalog failure was actually a blocked-egress sandbox — so
 * callers only surface the sandbox hint when it's relevant. Fail-safe: any
 * ambiguity resolves to `false` (don't cry wolf). A reachable status (2xx/3xx/
 * 401/404 — host answered) ⇒ not blocked; connection error / 403 / 407 ⇒ blocked.
 */
export async function egressLikelyBlocked() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch("https://api.circle.com/v2/x402/discovery/resources", {
      method: "GET",
      signal: ac.signal
    });
    return r.status === 403 || r.status === 407;
  } catch {
    return true; // refused / blocked / timeout
  } finally {
    clearTimeout(timer);
  }
}
