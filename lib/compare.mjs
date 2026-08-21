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
import { safeHttpUrl } from "./url-safety.mjs";
import { validateSelatPayArgv } from "./commands/run.mjs";
import { HARD_CLI_MAX_AMOUNT_USD, authorizeExplicitMaxAmount } from "./spend-guard.mjs";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

// Probes never settle, so the chain/cap flags below only satisfy selat-pay's
// arg surface; the quote they read is chain-independent.
const FALLBACK_PROBE_CHAIN = "base";
const FALLBACK_PROBE_CAP = "0.10";

// Ceiling on a --pay test-call cap. Derived caps come from catalog/probe
// data (untrusted-ish), so they are bounded. An explicit --max-amount is
// now clamped to the same hard CLI ceiling unless a TTY raise authorized it.
export const COMPARE_PAY_CAP_CEILING_USD = HARD_CLI_MAX_AMOUNT_USD;

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
  // Catalog entries are untrusted data and --pay settles real USDC against this
  // URL, so the same destination rule as a skill step applies: https:// only
  // (http:// for loopback development).
  if (!safeHttpUrl(url)) return null;

  // The hint is untrusted catalog data and --pay settles real USDC. Run it
  // through the SAME validator `selat run` uses (string-typed argv, no control
  // characters, exactly `selat-pay`, https destination) before trusting it; a
  // hint that fails validation is ignored in favour of the synthesized argv.
  const hint = Array.isArray(plan.exec_hints) ? plan.exec_hints[0] : null;
  let payArgv = null;
  if (Array.isArray(hint?.argv) && hint.argv[2] === url) {
    const checked = validateSelatPayArgv(hint.argv);
    if (checked.ok) payArgv = checked.args;
  }
  if (!payArgv) {
    const method =
      plan.endpoint.method && plan.endpoint.method !== "?"
        ? String(plan.endpoint.method).toUpperCase()
        : "GET";
    payArgv = [method, url, "--chain", FALLBACK_PROBE_CHAIN, "--max-amount", FALLBACK_PROBE_CAP];
    if (BODY_METHODS.has(method)) payArgv.push("--body", "{}");
  }

  // A hint could inject a probe flag (which would make the "paid" leg exit 0
  // without settling — a fake success). Strip it here; the explicit comparison
  // probe path adds both consent flags, while the settle path carries neither.
  payArgv = stripFlag(stripFlag(payArgv, "--probe-only"), "--live-probe");
  // selat-pay's parser is last-wins, so the ENFORCED hint cap is the last
  // --max-amount, not the first — read it the same way the confirmation must.
  const capLastIdx = payArgv.lastIndexOf("--max-amount");
  const hintCap = capLastIdx !== -1 ? Number(payArgv[capLastIdx + 1]) : NaN;
  return {
    url,
    payArgv,
    probeArgv: [...payArgv, "--probe-only", "--live-probe"],
    hintCapUsd: Number.isFinite(hintCap) && hintCap > 0 ? hintCap : null
  };
}

/**
 * Probe one candidate at its catalog serviceUrl (selat-pay --probe-only --live-probe —
 * never settles, but may invoke the upstream). Returns { reachable, mode, livePriceUsd, latencyMs, error,
 * payArgv, hintCapUsd }; latencyMs is the probe round-trip (spawn + live 402
 * quote), a relative signal for comparing candidates.
 */
export async function probeCandidate(plan, { selatPay }) {
  const built = probeArgvForPlan(plan);
  if (!built) {
    return {
      reachable: false, mode: null, livePriceUsd: null, latencyMs: null,
      error: "no concrete https endpoint in the catalog entry", payArgv: null, hintCapUsd: null
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

// A probe error that means "this machine isn't set up", not "this service is
// down" — selat-pay can't route without a router URL, so every routed probe
// fails identically and the candidates look uniformly broken.
const PROBE_SETUP_ERROR = /missing --router-url or SELAT_ROUTER_URL/i;

/**
 * Why nothing was reachable, or null when at least one probe succeeded.
 * Accepts comparison rows ({ probe }) or bare probe results. Returns
 * { kind: "setup" | "candidates", message, hint } — "setup" means the probes
 * never left this machine, which is worth saying out loud instead of printing a
 * column of ✗ and exiting 1.
 */
export function diagnoseUnreachable(rows) {
  const probes = rows.map((r) => r?.probe ?? r).filter(Boolean);
  if (probes.length === 0 || probes.some((p) => p.reachable)) return null;
  if (probes.every((p) => PROBE_SETUP_ERROR.test(p.error ?? ""))) {
    return {
      kind: "setup",
      message: "every probe failed before reaching a service — the SELAT Router URL is not configured",
      hint: "configure it with:  selat init        (then check it with:  selat doctor)"
    };
  }
  return {
    kind: "candidates",
    message: `no candidate answered with an x402/MPP challenge (${probes.length} probed)`,
    hint: null
  };
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
 * authorized against the hard CLI ceiling (default $1; TTY raise may lift
 * it). Anything derived from catalog/probe data is clamped to
 * COMPARE_PAY_CAP_CEILING_USD.
 */
export function paidCapUsd({
  explicit = null,
  livePriceUsd = null,
  hintCapUsd = null,
  interactive = false,
  allowHigh = false,
} = {}) {
  if (explicit != null) {
    const auth = authorizeExplicitMaxAmount(explicit, { interactive, allowHigh });
    if (!auth.ok) return NaN;
    return auth.capUsd;
  }
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
// Remove every occurrence of a value-taking flag (the flag AND its value).
export function stripFlag(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) { i++; continue; } // skip flag + its value
    out.push(argv[i]);
  }
  return out;
}

export function settleArgv(payArgv, { capUsd, chain = null }) {
  // Strip ALL prior --max-amount (selat-pay is last-wins, so replacing only the
  // first left a hostile hint's second, higher cap in force — a confirmed-cap
  // bypass) and any --probe-only (which would exit 0 without settling), then
  // set exactly one confirmed cap.
  let argv = stripFlag(stripFlag(payArgv.slice(), "--max-amount"), "--probe-only");
  if (chain) {
    argv = stripFlag(argv, "--chain");
    argv.push("--chain", String(chain));
  }
  argv.push("--max-amount", String(capUsd));
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
