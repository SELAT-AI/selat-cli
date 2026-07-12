import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  COMPARE_PAY_CAP_CEILING_USD,
  paidCapUsd,
  probeArgvForPlan,
  settleArgv,
  sortComparisonRows,
  matchReliability
} from "../lib/compare.mjs";
import { fetchReliability, reliabilityUrlKey } from "../lib/skill-registry.mjs";

// `skill compare` probes candidates straight off the federated catalog, so its
// argv derivation carries the same trust boundary as skill manifests: the probe
// must target the catalog serviceUrl (plan.endpoint.url) — never the
// descriptive provider url, and never whatever URL an exec hint happens to
// name. See the catalog rule in lib/compare.mjs.

function plan(over = {}) {
  return {
    service: { id: "svc:demo", name: "Demo", url: "https://provider.example.com", sources: ["circle"] },
    endpoint: { method: "POST", url: "https://api.demo.com/search", path: "/search", description: "" },
    payments: [],
    minAmountUsd: 0.005,
    score: 0.9,
    exec_hints: [
      {
        protocol: "x402",
        network: "eip155:8453",
        cmd: "selat-pay POST https://api.demo.com/search --chain base --max-amount 0.0075 --body '{}'",
        argv: ["selat-pay", "POST", "https://api.demo.com/search", "--chain", "base", "--max-amount", "0.0075", "--body", "{}"]
      }
    ],
    ...over
  };
}

// ── probeArgvForPlan: the serviceUrl rule ────────────────────────────────────

test("probeArgvForPlan targets the catalog serviceUrl and appends --probe-only", () => {
  const built = probeArgvForPlan(plan());
  assert.equal(built.url, "https://api.demo.com/search");
  assert.equal(built.payArgv[1], "https://api.demo.com/search");
  assert.equal(built.probeArgv.at(-1), "--probe-only");
  assert.ok(!built.payArgv.includes("--probe-only"));
  assert.equal(built.hintCapUsd, 0.0075);
});

test("probeArgvForPlan never probes the descriptive provider url", () => {
  const built = probeArgvForPlan(plan());
  assert.ok(!built.probeArgv.includes("https://provider.example.com"));
});

test("probeArgvForPlan rebuilds from the endpoint when the hint targets a different URL", () => {
  const p = plan({
    exec_hints: [{
      argv: ["selat-pay", "POST", "https://somewhere-else.example.com/x", "--chain", "base", "--max-amount", "0.5"]
    }]
  });
  const built = probeArgvForPlan(p);
  assert.equal(built.payArgv[1], "https://api.demo.com/search");
  // Rebuilt argv, so the hint's cap must not leak through.
  assert.equal(built.hintCapUsd, 0.10);
});

test("probeArgvForPlan falls back to a GET without body when the plan has no hints", () => {
  const p = plan({ exec_hints: [], endpoint: { method: "GET", url: "https://api.demo.com/data" } });
  const built = probeArgvForPlan(p);
  assert.equal(built.payArgv[0], "GET");
  assert.equal(built.payArgv[1], "https://api.demo.com/data");
  assert.ok(!built.payArgv.includes("--body"));
  assert.ok(built.payArgv.includes("--chain"));
  assert.ok(built.payArgv.includes("--max-amount"));
});

test("probeArgvForPlan adds an empty --body for a hint-less POST", () => {
  const p = plan({ exec_hints: [] });
  const built = probeArgvForPlan(p);
  const i = built.payArgv.indexOf("--body");
  assert.notEqual(i, -1);
  assert.equal(built.payArgv[i + 1], "{}");
});

test("probeArgvForPlan returns null for a plan with no concrete endpoint", () => {
  assert.equal(probeArgvForPlan(plan({ endpoint: null })), null);
  assert.equal(probeArgvForPlan(null), null);
});

// ── sortComparisonRows: reachable first, then price ─────────────────────────

test("sortComparisonRows puts reachable first, then price ascending, unknown price last", () => {
  const rows = [
    { plan: { score: 0.9 }, probe: { reachable: false, livePriceUsd: 0.001, latencyMs: 100 } },
    { plan: { score: 0.5 }, probe: { reachable: true, livePriceUsd: 0.05, latencyMs: 900 } },
    { plan: { score: 0.7 }, probe: { reachable: true, livePriceUsd: null, latencyMs: 400 } },
    { plan: { score: 0.6 }, probe: { reachable: true, livePriceUsd: 0.002, latencyMs: 1500 } }
  ];
  const sorted = sortComparisonRows(rows);
  assert.deepEqual(sorted.map((r) => r.plan.score), [0.6, 0.5, 0.7, 0.9]);
  // Input order untouched (sort is non-mutating).
  assert.equal(rows[0].plan.score, 0.9);
});

test("sortComparisonRows breaks price ties by probe latency, then score", () => {
  const rows = [
    { plan: { score: 0.5 }, probe: { reachable: true, livePriceUsd: 0.01, latencyMs: 900 } },
    { plan: { score: 0.9 }, probe: { reachable: true, livePriceUsd: 0.01, latencyMs: 300 } }
  ];
  assert.deepEqual(sortComparisonRows(rows).map((r) => r.plan.score), [0.9, 0.5]);
});

// ── paidCapUsd: explicit user cap is authority; derived caps are clamped ────

test("paidCapUsd returns an explicit user cap unclamped", () => {
  assert.equal(paidCapUsd({ explicit: "5" }), 5);
});

test("paidCapUsd derives live price + headroom, clamped to the ceiling", () => {
  assert.equal(paidCapUsd({ livePriceUsd: 0.02 }), 0.025);
  assert.equal(paidCapUsd({ livePriceUsd: 0.001 }), 0.01); // floor
  assert.equal(paidCapUsd({ livePriceUsd: 40 }), COMPARE_PAY_CAP_CEILING_USD); // clamp
});

test("paidCapUsd falls back to the hint cap, clamped, then a flat default", () => {
  assert.equal(paidCapUsd({ hintCapUsd: 0.06 }), 0.06);
  assert.equal(paidCapUsd({ hintCapUsd: 3 }), COMPARE_PAY_CAP_CEILING_USD);
  assert.equal(paidCapUsd({}), 0.10);
});

// ── settleArgv: cap + chain overrides ────────────────────────────────────────

test("settleArgv replaces the cap and applies a chain override", () => {
  const payArgv = ["POST", "https://api.demo.com/search", "--chain", "base", "--max-amount", "0.0075"];
  const argv = settleArgv(payArgv, { capUsd: 0.02, chain: "polygon" });
  assert.equal(argv[argv.indexOf("--max-amount") + 1], "0.02");
  assert.equal(argv[argv.indexOf("--chain") + 1], "polygon");
  // Original untouched.
  assert.equal(payArgv[payArgv.indexOf("--max-amount") + 1], "0.0075");
  assert.equal(payArgv[payArgv.indexOf("--chain") + 1], "base");
});

// ── reliability matching by serviceUrl ───────────────────────────────────────

test("reliabilityUrlKey normalizes host case, trailing slash, and drops the query", () => {
  assert.equal(
    reliabilityUrlKey("https://API.Exa.ai/search/?q=x#frag"),
    reliabilityUrlKey("https://api.exa.ai/search")
  );
  assert.equal(reliabilityUrlKey("not a url"), null);
});

test("fetchReliability exposes a per-endpoint byUrl view, pessimistic across skills", async () => {
  const oldDev = process.env.SELAT_SKILLS_DIR;
  const root = await mkdtemp(join(tmpdir(), "selat-cli-test-"));
  try {
    await writeFile(join(root, "reliability.json"), JSON.stringify({
      generatedAt: "2026-07-04T00:00:00.000Z",
      skills: [
        {
          name: "skill-a", status: "ok",
          steps: [{ url: "https://api.exa.ai/search?q=demo", reachable: true }]
        },
        {
          name: "skill-b", status: "degraded",
          steps: [
            { url: "https://api.exa.ai/search", reachable: false },
            { url: "https://mpp.example.com/x", reachable: true }
          ]
        }
      ]
    }));
    process.env.SELAT_SKILLS_DIR = root;
    const { byUrl } = await fetchReliability();

    // Two skills probed the same endpoint with mixed results → down wins.
    const exa = byUrl.get(reliabilityUrlKey("https://api.exa.ai/search"));
    assert.equal(exa.status, "down");
    assert.equal(byUrl.get(reliabilityUrlKey("https://mpp.example.com/x")).status, "ok");

    // matchReliability keys a candidate plan by its catalog serviceUrl.
    const hit = matchReliability(
      { endpoint: { url: "https://api.exa.ai/search?q=live" } },
      byUrl
    );
    assert.equal(hit.status, "down");
    assert.equal(matchReliability({ endpoint: { url: "https://unknown.example.com/y" } }, byUrl), null);
  } finally {
    if (oldDev == null) delete process.env.SELAT_SKILLS_DIR;
    else process.env.SELAT_SKILLS_DIR = oldDev;
  }
});
