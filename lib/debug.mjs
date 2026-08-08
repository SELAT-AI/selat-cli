/**
 * Diagnostics for errors the CLI deliberately does not propagate.
 *
 * Several paths here are best-effort by design (PATH linking, a QR image, a
 * reliability badge): a failure must never break the command the user ran. But
 * "don't fail" is not the same as "throw the evidence away" — every swallowed
 * error goes through `debugError`, so `SELAT_DEBUG=1` turns an invisible
 * degradation into a traceable one.
 */

/** Human message for an unknown thrown value. */
export function errorMessage(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  return err.message ?? String(err);
}

/**
 * Message plus the `cause` chain, e.g. "could not read config: EACCES".
 * Bounded so a self-referential cause can't loop.
 */
export function errorChain(err, { depth = 5 } = {}) {
  const parts = [];
  let current = err;
  for (let i = 0; i < depth && current != null; i++) {
    const msg = errorMessage(current);
    if (parts[parts.length - 1] !== msg) parts.push(msg);
    current = current?.cause;
  }
  return parts.join(": ");
}

export function debugEnabled() {
  return process.env.SELAT_DEBUG === "1";
}

/**
 * Record an error that is intentionally not propagated. Silent unless
 * SELAT_DEBUG=1; always writes to stderr so machine-readable stdout stays
 * clean. `context` should name the operation that degraded.
 */
export function debugError(context, err) {
  if (!debugEnabled()) return;
  const detail = err?.stack || errorChain(err);
  console.error(`[selat:debug] ${context}: ${detail}`);
}
