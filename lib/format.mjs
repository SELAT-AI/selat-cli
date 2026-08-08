/**
 * Number + money formatting shared across commands.
 *
 * Money renders identically everywhere (a balance that reads "$0.00" in one
 * command and "$0.000012" in another is a support ticket), so the dollar and
 * USDC-amount renderers live here rather than per command.
 */

/** Number when the value is finite, else null — never guess a balance. */
export function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "$2.50"; sub-cent values keep 6 decimals so dust never renders as $0.00. */
export function formatUsd(value) {
  const n = finiteNumber(value);
  if (value == null || n == null) return "$?";
  return n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`;
}

/** "1.500000 USDC" — full 6-decimal token amount for balance readouts. */
export function usdcAmountText(value) {
  const n = finiteNumber(value);
  return n == null ? "? USDC" : `${n.toFixed(6)} USDC`;
}

/** "45s", "1m30s", "15m0s" — for progress lines and timeouts. */
export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}
