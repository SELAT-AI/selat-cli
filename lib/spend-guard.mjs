/**
 * Shared spend guards for paid CLI paths.
 *
 * Two residuals this module closes:
 *   1. YOLO `--max-amount` — an explicit flag used to be unbounded "user
 *      authority". An agent could pass `--max-amount 999` and spend. There is
 *      now a hard CLI ceiling (default $1) that applies even to an explicit
 *      flag. A TTY confirm or `--allow-high-max-amount` may raise it, still
 *      never above the documented $5 hard cap. Non-TTY / agent invocations
 *      cannot exceed $1. The Apify prepaid token ($1.05) is a documented
 *      exception for that known token only — not a generic hole.
 *   2. Session-budget require-to-pay lives in budget.mjs (`missingSessionBudget`).
 *
 * selat-mcp is not in this tree. This module never touches keys.
 */

export const HARD_CLI_MAX_AMOUNT_USD = 1;
export const RAISED_CLI_MAX_AMOUNT_USD = 5;
export const APIFY_PREPAID_TOKEN_USD = 1.05;
export const ALLOW_HIGH_MAX_AMOUNT_FLAG = "--allow-high-max-amount";

/**
 * Allowed per-call ceiling for this invocation.
 * Non-TTY / agent: $1 (Apify prepaid token $1.05 is the only exception).
 * TTY + confirm or `--allow-high-max-amount` on a TTY: up to $5.
 */
export function allowedMaxAmountCeiling({
  interactive = false,
  allowHigh = false,
  apifyPrepaid = false,
} = {}) {
  if (allowHigh && interactive) return RAISED_CLI_MAX_AMOUNT_USD;
  if (apifyPrepaid) return APIFY_PREPAID_TOKEN_USD;
  return HARD_CLI_MAX_AMOUNT_USD;
}

/**
 * Authorize an explicit `--max-amount` against the hard CLI ceiling.
 * Returns { ok, capUsd } or { ok: false, error }.
 * Catalog hints are not handled here — those stay last-wins then clamped.
 */
export function authorizeExplicitMaxAmount(explicit, {
  interactive = false,
  allowHigh = false,
  apifyPrepaid = false,
} = {}) {
  if (explicit == null) return { ok: true, capUsd: null };
  const n = Number(explicit);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: `--max-amount "${explicit}" must be a positive number` };
  }
  if (n > RAISED_CLI_MAX_AMOUNT_USD) {
    return {
      ok: false,
      error:
        `--max-amount ${n} exceeds the documented hard cap $${RAISED_CLI_MAX_AMOUNT_USD} ` +
        `(nothing was charged)`,
    };
  }
  const ceiling = allowedMaxAmountCeiling({ interactive, allowHigh, apifyPrepaid });
  if (n <= HARD_CLI_MAX_AMOUNT_USD) return { ok: true, capUsd: n };
  if (apifyPrepaid && n <= APIFY_PREPAID_TOKEN_USD) {
    return { ok: true, capUsd: n, apifyException: true };
  }
  if (n <= ceiling) return { ok: true, capUsd: n, raised: true };
  return {
    ok: false,
    error:
      `--max-amount ${n} exceeds the $${HARD_CLI_MAX_AMOUNT_USD} hard CLI ceiling ` +
      `for non-interactive / agent runs (nothing was charged)`,
    hint:
      `On a TTY, confirm or pass ${ALLOW_HIGH_MAX_AMOUNT_FLAG} to raise up to ` +
      `$${RAISED_CLI_MAX_AMOUNT_USD}. Non-TTY invocations cannot exceed $${HARD_CLI_MAX_AMOUNT_USD}.`,
  };
}

/**
 * TTY raise path: an explicit cap in ($1, $5] may be authorized by confirm
 * or by `--allow-high-max-amount`. Non-TTY cannot raise. `prompt` is injected
 * so tests stay non-interactive.
 */
export async function confirmHighMaxAmount({
  explicit,
  interactive = false,
  allowHigh = false,
  jsonMode = false,
  apifyPrepaid = false,
  prompt,
} = {}) {
  const n = Number(explicit);
  if (!Number.isFinite(n) || n <= HARD_CLI_MAX_AMOUNT_USD) {
    return { ok: true, allowHigh: false };
  }
  const first = authorizeExplicitMaxAmount(explicit, { interactive, allowHigh, apifyPrepaid });
  if (first.ok) return { ok: true, allowHigh: !!(allowHigh && interactive), capUsd: first.capUsd };
  if (n > RAISED_CLI_MAX_AMOUNT_USD) return first;
  if (interactive && !jsonMode && typeof prompt === "function") {
    const go = await prompt(
      `Raise the per-call ceiling to $${n} (hard cap $${RAISED_CLI_MAX_AMOUNT_USD})?`
    );
    if (!go) {
      return { ok: false, error: "declined — per-call ceiling stays at $1; nothing was charged" };
    }
    return { ok: true, allowHigh: true, capUsd: n };
  }
  return first;
}
