/**
 * Shared spend guards for paid CLI paths.
 *
 * Per-call ceiling: $1 for everyone. `stdin.isTTY` is not a human gate —
 * Cursor, Claude Code, Codex, Gemini CLI, OpenClaw, and Hermes often allocate
 * a PTY, so a TTY confirm or `--allow-high-max-amount` is agent-spoofable.
 * There is no reliable human-only signal in this CLI (host.mjs only PATH-links
 * OpenClaw when ~/.openclaw exists; that is "harness installed", not "this
 * invocation is a human"). The $5 raise is therefore dropped. Circle wallet
 * policy (`selat setup-policy`) and a file-armed session budget remain the
 * other ceilings.
 *
 * The Apify prepaid token ($1.05) is a documented exception for that known
 * token only — not a generic hole.
 *
 * `--allow-high-max-amount` is still parsed (so an agent passing it is not an
 * unknown-flag error) and is a no-op for the ceiling.
 *
 * selat-mcp is not in this tree. This module never touches keys.
 */

export const HARD_CLI_MAX_AMOUNT_USD = 1;
export const APIFY_PREPAID_TOKEN_USD = 1.05;
export const ALLOW_HIGH_MAX_AMOUNT_FLAG = "--allow-high-max-amount";

// Kept so callers/tests that still name the dropped raise see a stable export.
// It is not a raise path. The hard CLI ceiling is $1.
export const RAISED_CLI_MAX_AMOUNT_USD = HARD_CLI_MAX_AMOUNT_USD;

/**
 * Env keys commonly set by agent harnesses that allocate a PTY. Presence
 * means "this process is likely an agent" — never a reason to raise the
 * ceiling. Used by tests and by inAgentHarness().
 */
export const AGENT_HARNESS_ENV_KEYS = [
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_HOME",
  "CODEX_CI",
  "GEMINI_CLI",
  "GEMINI_SANDBOX",
  "OPENCLAW_HOME",
  "OPENCLAW_SHELL",
  "HERMES_HOME",
  "HERMES_SESSION",
];

/** True when env looks like a known agent harness (Cursor, Claude Code, …). */
export function inAgentHarness({ env = process.env } = {}) {
  return AGENT_HARNESS_ENV_KEYS.some((k) => {
    const v = env[k];
    return v != null && v !== "";
  });
}

/**
 * Allowed per-call ceiling. Always $1, except the Apify prepaid token ($1.05).
 * interactive / allowHigh / harness are accepted and ignored — they cannot
 * raise. A PTY agent passing --allow-high-max-amount still gets $1.
 */
export function allowedMaxAmountCeiling({
  apifyPrepaid = false,
} = {}) {
  if (apifyPrepaid) return APIFY_PREPAID_TOKEN_USD;
  return HARD_CLI_MAX_AMOUNT_USD;
}

/**
 * Authorize an explicit `--max-amount` against the hard CLI ceiling.
 * Returns { ok, capUsd } or { ok: false, error }.
 * Catalog hints are not handled here — those stay last-wins then clamped.
 *
 * `interactive` / `allowHigh` / `agent` are accepted so call sites and tests
 * can pass harness-like context; they never raise the ceiling.
 */
export function authorizeExplicitMaxAmount(explicit, {
  interactive = false,
  allowHigh = false,
  apifyPrepaid = false,
  agent = false,
} = {}) {
  void interactive;
  void allowHigh;
  void agent;
  if (explicit == null) return { ok: true, capUsd: null };
  const n = Number(explicit);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `--max-amount "${explicit}" must be a positive number` };
  }
  if (n <= HARD_CLI_MAX_AMOUNT_USD) return { ok: true, capUsd: n };
  if (apifyPrepaid && n <= APIFY_PREPAID_TOKEN_USD) {
    return { ok: true, capUsd: n, apifyException: true };
  }
  return {
    ok: false,
    error:
      `--max-amount ${n} exceeds the $${HARD_CLI_MAX_AMOUNT_USD} hard CLI ceiling ` +
      `(nothing was charged)`,
    hint:
      `The per-call ceiling is $${HARD_CLI_MAX_AMOUNT_USD} for every invocation, ` +
      `including TTY and agent harnesses. ${ALLOW_HIGH_MAX_AMOUNT_FLAG} does not raise it. ` +
      `Circle wallet policy (selat setup-policy) and a file-armed session budget ` +
      `(selat budget start) are the other ceilings.`,
  };
}

/**
 * Former TTY raise path. Kept so existing call sites stay valid.
 * Never raises: a yes from `prompt` or `--allow-high-max-amount` cannot
 * exceed $1 (Apify $1.05 is the only exception).
 */
export async function confirmHighMaxAmount({
  explicit,
  interactive = false,
  allowHigh = false,
  jsonMode = false,
  apifyPrepaid = false,
  agent = false,
  prompt,
} = {}) {
  void prompt;
  void jsonMode;
  const auth = authorizeExplicitMaxAmount(explicit, { interactive, allowHigh, apifyPrepaid, agent });
  if (!auth.ok) return auth;
  return { ok: true, allowHigh: false, capUsd: auth.capUsd };
}
