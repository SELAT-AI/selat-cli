/**
 * `selat skill compare` core — shortlist federated-catalog candidates for an
 * intent, then free-probe each one live so a skill composer can vet
 * alternatives side-by-side without accounts or keys.
 *
 * Kept separate from the command layer so the probe-and-rank path can be
 * reused by the planned evoskill-publish converter's step-mining (match
 * observed calls against the catalog, then probe the catalog serviceUrl) —
 * see sentient-grant/evoskill-selat-integration-design.md §5.
 *
 * CATALOG RULE: probes and paid test calls always target the candidate's
 * catalog serviceUrl (plan.endpoint.url — rank.mjs's endpoint.fullUrl), never
 * the descriptive provider url (plan.service.url). The 402 challenge is only
 * served at the serviceUrl; for routed merchants the provider host is not
 * payable at all.
 */

import { sh } from "./sh.mjs";
import { selatPaySpawn } from "./selat-pay.mjs";
import { parseProbeStdout, reliabilityUrlKey } from "./skill-registry.mjs";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Probes never settle, so the chain/cap flags below only satisfy selat-pay's
// arg surface; the quote they read is chain-independent.
const FALLBACK_PROBE_CHAIN = "base";
const FALLBACK_PROBE_CAP = "0.10";

// Ceiling on a --pay test-call cap that was NOT set explicitly by the user.
// Derived caps come from catalog/probe data (untrusted-ish), so they are
// bounded — same philosophy as skill-registry's manifest cap ceiling. An
// explicit --max-amount is user authority and is not clamped.
export const COMPARE_PAY_CAP_CEILING_USD = 1.0;

/**
 * Run the discovery ranker (the same rank.mjs `selat search` uses) and return
 * the top-N candidate payment plans for an intent.
 * Returns { strongMatch, note, plans } or throws with .stderr on failure.
 */
export async function discoverCandidates(rankScript, intent, { limit = 5, refresh = false } = {}) {
  const argv = [rankScript, intent, "--json", "--top", String(limit)];
  if (refresh) argv.push("--refresh");
  const res = await sh("node", argv);
  if (res.code !== 0) {
    const err = new Error(`discovery failed (rank.mjs exited ${res.code})`);
    err.stderr = res.stderr || res.stdout;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("rank.mjs returned invalid JSON");
  }
  return {
    strongMatch: !!parsed.strongMatch,
    note: parsed.note ?? null,
    plans: Array.isArray(parsed.results) ? parsed.results : []
  };
}

/**
 * Build the selat-pay argv (without the leading "selat-pay") for a candidate
 * plan. Prefers the ranker's first exec hint (already priced and chain-keyed),
 * but only when it targets the plan's catalog serviceUrl — a hint pointing
 * anywhere else is rebuilt from the endpoint instead of trusted. Returns
 * { url, payArgv, probeArgv, hintCapUsd } or null when the plan has no
 * concrete endpoint to probe.
 */
export function probeArgvForPlan(plan) {
  const url = plan?.endpoint?.url; // the catalog serviceUrl — NEVER plan.service.url
  if (typeof url !== "string" || !url) return null;

  const hint = Array.isArray(plan.exec_hints) ? plan.exec_hints[0] : null;
  let payArgv = null;
  if (Array.isArray(hint?.argv) && hint.argv[0] === "selat-pay" && hint.argv[2] === url) {
    payArgv = hint.argv.slice(1);
  }
  if (!payArgv) {
    const method =
      plan.endpoint.method && plan.endpoint.method !== "?"
        ? String(plan.endpoint.method).toUpperCase()
        : "GET";
    payArgv = [method, url, "--chain", FALLBACK_PROBE_CHAIN, "--max-amount", FALLBACK_PROBE_CAP];
    if (BODY_METHODS.has(method)) payArgv.push("--body", "{}");
  }

  const capIdx = payArgv.indexOf("--max-amount");
  const hintCap = capIdx !== -1 ? Number(payArgv[capIdx + 1]) : NaN;
  return {
    url,
    payArgv,
    probeArgv: [...payArgv, "--probe-only"],
    hintCapUsd: Number.isFinite(hintCap) && hintCap > 0 ? hintCap : null
  };
}

/**
 * Free-probe one candidate at its catalog serviceUrl (selat-pay --probe-only —
 * never settles). Returns { reachable, mode, livePriceUsd, latencyMs, error,
 * payArgv, hintCapUsd }; latencyMs is the probe round-trip (spawn + live 402
 * quote), a relative signal for comparing candidates.
 */
export async function probeCandidate(plan, { selatPay }) {
  const built = probeArgvForPlan(plan);
  if (!built) {
    return {
      reachable: false, mode: null, livePriceUsd: null, latencyMs: null,
      error: "no concrete endpoint in the catalog entry", payArgv: null, hintCapUsd: null
    };
  }
  const spawn = selatPaySpawn(selatPay, built.probeArgv);
  const t0 = Date.now();
  const res = await sh(spawn.cmd, spawn.args);
  const latencyMs = Date.now() - t0;
  const { mode, livePriceUsd } = parseProbeStdout(res.stdout || "");
  const reachable = res.code === 0 && mode != null;
  const error = reachable
    ? null
    : (res.stderr || "").match(/\[selat-pay\] error: (.+)/)?.[1]?.trim() || "no x402/MPP challenge";
  return { reachable, mode, livePriceUsd, latencyMs, error, payArgv: built.payArgv, hintCapUsd: built.hintCapUsd };
}

/** Probe every candidate concurrently (each probe is an independent spawn). */
export async function probeCandidates(plans, { selatPay }) {
  return Promise.all(plans.map((plan) => probeCandidate(plan, { selatPay })));
}

/** The reliability registry entry for a plan's serviceUrl, or null. */
export function matchReliability(plan, byUrl) {
  if (!byUrl || byUrl.size === 0) return null;
  const key = reliabilityUrlKey(plan?.endpoint?.url ?? "");
  return key ? byUrl.get(key) ?? null : null;
}

/**
 * Default comparison order: reachable candidates first, then live price
 * ascending (unknown-price last), then probe latency, then ranker score.
 */
export function sortComparisonRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.probe.reachable !== b.probe.reachable) return a.probe.reachable ? -1 : 1;
    const ap = a.probe.livePriceUsd;
    const bp = b.probe.livePriceUsd;
    if ((ap == null) !== (bp == null)) return ap == null ? 1 : -1;
    if (ap != null && bp != null && ap !== bp) return ap - bp;
    const al = a.probe.latencyMs ?? Number.POSITIVE_INFINITY;
    const bl = b.probe.latencyMs ?? Number.POSITIVE_INFINITY;
    if (al !== bl) return al - bl;
    return (b.plan?.score ?? 0) - (a.plan?.score ?? 0);
  });
}

/**
 * The per-candidate spend cap for a --pay test call. An explicit user cap is
 * authority (returned as-is); anything derived from catalog/probe data is
 * clamped to COMPARE_PAY_CAP_CEILING_USD.
 */
export function paidCapUsd({ explicit = null, livePriceUsd = null, hintCapUsd = null } = {}) {
  if (explicit != null) return Number(explicit);
  let cap;
  if (livePriceUsd != null && Number.isFinite(livePriceUsd)) {
    cap = Math.max(0.01, livePriceUsd * 1.25); // modest headroom over the live quote
  } else if (hintCapUsd != null) {
    cap = hintCapUsd;
  } else {
    cap = 0.10;
  }
  return Math.min(cap, COMPARE_PAY_CAP_CEILING_USD);
}

/** payArgv with its --max-amount replaced by capUsd and optional --chain override. */
export function settleArgv(payArgv, { capUsd, chain = null }) {
  const argv = payArgv.slice();
  const capIdx = argv.indexOf("--max-amount");
  if (capIdx !== -1) argv[capIdx + 1] = String(capUsd);
  else argv.push("--max-amount", String(capUsd));
  if (chain) {
    const chainIdx = argv.indexOf("--chain");
    if (chainIdx !== -1) argv[chainIdx + 1] = String(chain);
    else argv.push("--chain", String(chain));
  }
  return argv;
}

/**
 * One capped SETTLED test call against a candidate (real spend — the command
 * layer confirms with the user first). Returns { settled, httpStatus,
 * latencyMs, stdout, error }; stdout is the response body, which the caller
 * saves as the candidate's output sample.
 */
export async function settleCandidate(payArgv, { selatPay, capUsd, chain = null }) {
  const spawn = selatPaySpawn(selatPay, settleArgv(payArgv, { capUsd, chain }));
  const t0 = Date.now();
  const res = await sh(spawn.cmd, spawn.args);
  const latencyMs = Date.now() - t0;
  const status = (res.stderr || "").match(/status=(\d+)/)?.[1];
  const error = res.code === 0
    ? null
    : (res.stderr || "").match(/\[selat-pay\] error: (.+)/)?.[1]?.trim() || `selat-pay exited ${res.code}`;
  return { settled: res.code === 0, httpStatus: status ? Number(status) : null, latencyMs, stdout: res.stdout || "", error };
}
