/**
 * All-in price disclosure for paid calls.
 *
 * Catalog quotes carry the UPSTREAM price. The SELAT Router passes same-rail
 * Gateway-batched upstreams through at par (0%) and keeps a ~5% markup when it
 * translates a cross-protocol upstream (erc-3009 / tempo-native MPP) — see the
 * selat-discovery README ("Every paid call goes through the SELAT Router").
 * Measured 2026-10-03: an erc-3009 endpoint quoted $0.001 settled as $0.00105.
 *
 * Display only. Nothing here gates or changes what is paid.
 */

export const CROSS_PROTOCOL_MARKUP = 0.05;

// Payment domains that the router translates (markup applies).
const MARKED_UP_DOMAINS = new Set(["erc-3009", "tempo-native"]);

/**
 * { upstreamUsd, feePct, feeUsd, totalUsd, domain } for a rank plan, or null
 * when the price or the payment domain is unknown (never invent a number).
 * Apify prepaid-token picks disclose their own $1 + 5% elsewhere — skipped.
 */
export function allInPrice(plan) {
  const upstream = Number(plan?.minAmountUsd);
  if (plan?.minAmountUsd == null || !Number.isFinite(upstream) || upstream < 0) return null;
  const hint = Array.isArray(plan?.exec_hints) ? plan.exec_hints[0] : null;
  if (!hint || hint.flow === "apify-prepaid-token") return null;
  const domain = typeof hint.domain === "string" ? hint.domain : null;
  if (!domain) return null;
  const feePct = MARKED_UP_DOMAINS.has(domain) ? CROSS_PROTOCOL_MARKUP : 0;
  const feeUsd = roundUsd(upstream * feePct);
  return { upstreamUsd: upstream, feePct, feeUsd, totalUsd: roundUsd(upstream + feeUsd), domain };
}

// USDC has 6 decimals; avoid float noise like 0.0010500000000000001.
function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** "$0.001" style, enough precision that sub-cent fees stay visible. */
export function formatUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${String(roundUsd(v))}`;
}

/** One-line human text, e.g. "$0.001 + 5% fee = $0.00105". null when unknown. */
export function allInPriceText(plan) {
  const p = allInPrice(plan);
  if (!p) return null;
  if (p.feePct === 0) return `${formatUsd(p.upstreamUsd)} (same-rail, no fee)`;
  return `${formatUsd(p.upstreamUsd)} + ${p.feePct * 100}% fee = ${formatUsd(p.totalUsd)}`;
}

/** Extra JSON fields for --json output; additive, `priceUsd` stays upstream. */
export function allInPriceFields(plan) {
  const p = allInPrice(plan);
  if (!p) return {};
  return { upstreamUsd: p.upstreamUsd, feeUsd: p.feeUsd, totalUsd: p.totalUsd, feePct: p.feePct };
}
