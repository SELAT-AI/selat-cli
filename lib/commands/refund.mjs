/**
 * `selat refund claim|query <quote-id>` — file or query a refund claim.
 *
 * Thin wrapper around the bundled selat-pay CLI:
 *   selat-pay refund claim|query <quoteId> [flags]
 *
 * Refund is SIWx auth (plus selat-pay's dummy Gateway owner probe), not a
 * payment: it does not consume session budget and does not take --max-amount.
 * This command does not reimplement that protocol — it resolves selat-pay and
 * forwards argv unchanged so Circle signing prompts still work.
 */

import { sh } from "../sh.mjs";
import { fmt } from "../ui.mjs";
import { resolveSelatPay, selatPaySpawn } from "../selat-pay.mjs";

export const REFUND_ACTIONS = ["claim", "query"];

// Same shape selat-pay's refund client already enforces. A light check here
// keeps the "selatx…" error on this binary so a missing/typo'd id never
// reaches Circle signing.
export const REFUND_QUOTE_ID_RE = /^selatx[A-Za-z0-9_-]{3,}$/;

export const REFUND_USAGE = `${fmt.bold("selat refund")} — file or query a refund claim for a paid quote

${fmt.bold("Usage:")}
  selat refund claim <quote-id> [--chain <name>] [selat-pay refund flags]
  selat refund query <quote-id> [--chain <name>] [selat-pay refund flags]

${fmt.bold("Actions:")}
  claim               File a refund claim for a prior paid selatx… quote
  query               Check the status of a refund claim

${fmt.bold("Options:")}
  --chain <name>      Chain key forwarded to selat-pay (e.g. base)
  --router-url <url>  Override SELAT_ROUTER_URL
  --raw-key           Dev-only: sign with SELAT_PRIVATE_KEY (selat-pay)
  -h, --help          Show this help. Never resolves or spawns selat-pay.

${fmt.bold("Examples:")}
  selat refund claim selatx… --chain base
  selat refund query selatx… --chain base

This is authentication (SIWx), not a payment. It does not consume session
budget and does not require --max-amount. Remaining flags pass through to
selat-pay unchanged — the refund protocol lives there, not here.
`;

/**
 * Parse `selat refund` argv. Pure + exported so tests can pin action / quote-id
 * validation without spawning. `--help` / `-h` anywhere is inert help, matching
 * history / fund / run (a flag must never become the quote id).
 */
export function parseRefundArgs(args = []) {
  if (!Array.isArray(args)) return { ok: false, error: "argv must be an array" };
  if (args.includes("--help") || args.includes("-h")) return { ok: true, help: true };

  const [action, quoteId, ...rest] = args;
  if (!action) {
    return { ok: false, error: "a refund action is required (claim or query)" };
  }
  if (!REFUND_ACTIONS.includes(action)) {
    return { ok: false, error: `unknown refund action: ${action} (expected claim or query)` };
  }
  if (!quoteId || quoteId.startsWith("-")) {
    return { ok: false, error: "a quote id is required (selatx… id from a prior paid call)" };
  }
  if (!REFUND_QUOTE_ID_RE.test(quoteId)) {
    return {
      ok: false,
      error: `invalid refund quote id ${quoteId}; expected a selatx-prefixed id (e.g. selatx123)`,
    };
  }
  return { ok: true, action, quoteId, rest };
}

/** selat-pay argv (no leading binary name) for a parsed refund command. */
export function refundPayArgv({ action, quoteId, rest = [] } = {}) {
  return ["refund", action, quoteId, ...rest];
}

export async function refund(args = [], {
  resolve = resolveSelatPay,
  spawn = selatPaySpawn,
  run = sh,
} = {}) {
  const parsed = parseRefundArgs(args);
  if (!parsed.ok) {
    console.error(fmt.error(parsed.error));
    console.error(fmt.dim("usage: selat refund claim|query <quote-id> [--chain <name>]"));
    return 1;
  }
  if (parsed.help) {
    console.log(REFUND_USAGE);
    return 0;
  }

  const selatPay = await resolve();
  if (!selatPay || selatPay.source == null) {
    console.error(fmt.error(
      "selat-pay not found — reinstall @selat-ai/selat-cli, or ensure the bundled selat-pay is installed."
    ));
    return 1;
  }

  const payArgs = refundPayArgv(parsed);
  const { cmd, args: spawnArgs } = spawn(selatPay, payArgs);
  // inherit: Circle / SIWx signing prompts must reach the terminal.
  return (await run(cmd, spawnArgs, { inherit: true })).code;
}
