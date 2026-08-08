/**
 * XDG state paths shared by every command that reads selat-pay's local state.
 *
 * The schema owner is selat-pay (freeze flag, session budget, Gateway history);
 * these resolvers mirror it in ONE place so a path override — and the
 * XDG_STATE_HOME fallback — cannot drift between `selat budget`, `selat
 * freeze`, `selat fund` and the QR writer.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function stateHome() {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

/** State dir for selat-pay's own files (freeze flag, session, history). */
export function selatPayStateDir() {
  return join(stateHome(), "selat-pay");
}

/** State dir for selat-cli's own artifacts (compare samples, …). */
export function selatStateDir(...segments) {
  return join(stateHome(), "selat", ...segments);
}

/**
 * A file under selatPayStateDir(), honouring an env override when the caller
 * names one (selat-pay reads the same variables).
 */
export function selatPayStatePath(fileName, envVar) {
  const override = envVar ? process.env[envVar] : null;
  return override || join(selatPayStateDir(), fileName);
}

/** selat-pay's Gateway history ledger (JSONL). */
export function historyPath() {
  return selatPayStatePath("gateway-history.jsonl", "SELAT_PAY_HISTORY_PATH");
}
