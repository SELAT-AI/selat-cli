import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  diagnoseUnreachable,
  discoverCandidates,
  probeArgvForPlan,
  probeCandidate,
  probeCandidates,
  settleArgv,
  settleCandidate
} from "../lib/compare.mjs";

// `selat skill compare` shells out twice per candidate: rank.mjs for the
// shortlist, then selat-pay (--probe-only, and with --pay a settled call). These
// exercise those spawns against stand-in scripts, so the free/paid boundary and
// the stdout/stderr parsing are pinned without touching the network or money.

const scriptDir = mkdtempSync(join(tmpdir(), "selat-compare-"));
let scriptSeq = 0;

/** Write a stand-in executable that reports a fixed stdout/stderr/exit code. */
function fakeScript({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const path = join(scriptDir, `fake-${scriptSeq++}.mjs`);
  writeFileSync(
    path,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(`${path}.argv.json`)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`
    ].join("\n"),
    "utf8"
  );
  return { path, argv: () => JSON.parse(readFileSync(`${path}.argv.json`, "utf8")) };
}

/** A resolved selat-pay pointing at a stand-in binary (see lib/selat-pay.mjs). */
const asSelatPay = (bin) => ({ source: "env-override", bin, binDir: null, packageRoot: null });

const PROBE_JSON = JSON.stringify({
  mode: "routed-x402",
  quote: { price: { amount: "8000", formatted: "$0.008000 USDC" } }
});

const planFor = (url, extra = {}) => ({ endpoint: { url, method: "GET" }, ...extra });

// ── discoverCandidates ──────────────────────────────────────────────────────

test("discoverCandidates asks the ranker for a JSON top-N shortlist", async () => {
  const rank = fakeScript({
    stdout: JSON.stringify({ strongMatch: true, note: "close match", results: [{ id: "a" }] })
  });
  const res = await discoverCandidates(rank.path, "people enrichment", { limit: 3, refresh: true });
  assert.deepEqual(res, { strongMatch: true, note: "close match", plans: [{ id: "a" }] });
  assert.deepEqual(rank.argv(), ["people enrichment", "--json", "--top", "3", "--refresh"]);
});

test("discoverCandidates defaults the limit and normalizes a resultless payload", async () => {
  const rank = fakeScript({ stdout: JSON.stringify({}) });
  const res = await discoverCandidates(rank.path, "gold prices");
  assert.deepEqual(res, { strongMatch: false, note: null, plans: [] });
  assert.deepEqual(rank.argv(), ["gold prices", "--json", "--top", "5"]);
});

test("discoverCandidates surfaces a ranker failure with its stderr attached", async () => {
  const rank = fakeScript({ stderr: "catalog unreachable", exitCode: 2 });
  await assert.rejects(discoverCandidates(rank.path, "x"), (err) => {
    assert.match(err.message, /rank\.mjs exited 2/);
    assert.equal(err.stderr, "catalog unreachable");
    return true;
  });
});

test("discoverCandidates rejects unparseable ranker output", async () => {
  const rank = fakeScript({ stdout: "not json" });
  await assert.rejects(discoverCandidates(rank.path, "x"), /invalid JSON/);
});

// ── probeCandidate (free — never settles) ───────────────────────────────────

test("probeCandidate reports a live quote and explicitly acknowledges the upstream probe", async () => {
  const pay = fakeScript({ stdout: PROBE_JSON });
  const res = await probeCandidate(planFor("https://api.example/v1/enrich"), { selatPay: asSelatPay(pay.path) });
  assert.equal(res.reachable, true);
  assert.equal(res.mode, "routed-x402");
  assert.equal(res.livePriceUsd, 0.008);
  assert.equal(typeof res.latencyMs, "number");
  assert.equal(res.error, null);
  assert.deepEqual(res.payArgv, [
    "GET", "https://api.example/v1/enrich", "--chain", "base", "--max-amount", "0.10"
  ]);
  assert.equal(res.hintCapUsd, 0.1);
  const argv = pay.argv();
  assert.ok(argv.includes("--probe-only"), "a comparison probe must never settle");
  assert.ok(argv.includes("--live-probe"), "a comparison probe must explicitly acknowledge upstream contact");
  assert.equal(argv.at(-1), "--live-probe");
});

test("probeCandidate reads selat-pay's error line when the probe fails", async () => {
  const pay = fakeScript({ stderr: "[selat-pay] error: connect ETIMEDOUT\n", exitCode: 1 });
  const res = await probeCandidate(planFor("https://api.example/v1"), { selatPay: asSelatPay(pay.path) });
  assert.equal(res.reachable, false);
  assert.equal(res.error, "connect ETIMEDOUT");
});

test("probeCandidate treats a 200 with no 402 challenge as unreachable", async () => {
  const pay = fakeScript({ stdout: '{"ok":true}' });
  const res = await probeCandidate(planFor("https://api.example/v1"), { selatPay: asSelatPay(pay.path) });
  assert.equal(res.reachable, false);
  assert.equal(res.mode, null);
  assert.equal(res.error, "no x402/MPP challenge");
});

test("probeCandidate short-circuits a plan with no endpoint, without spawning", async () => {
  const res = await probeCandidate({ service: { url: "https://provider.example" } }, { selatPay: null });
  assert.deepEqual(res, {
    reachable: false, mode: null, livePriceUsd: null, latencyMs: null,
    error: "no concrete https endpoint in the catalog entry", payArgv: null, hintCapUsd: null
  });
});

test("probeCandidates probes every plan and keeps the input order", async () => {
  const pay = fakeScript({ stdout: PROBE_JSON });
  const res = await probeCandidates(
    [planFor("https://a.example/v1"), { service: {} }, planFor("https://b.example/v1")],
    { selatPay: asSelatPay(pay.path) }
  );
  assert.deepEqual(res.map((r) => r.reachable), [true, false, true]);
  assert.deepEqual(res[2].payArgv[1], "https://b.example/v1");
});

// ── diagnoseUnreachable ─────────────────────────────────────────────────────

const ROUTER_ERROR = "missing --router-url or SELAT_ROUTER_URL";

test("diagnoseUnreachable stays quiet while any candidate is reachable", () => {
  assert.equal(diagnoseUnreachable([{ probe: { reachable: true, error: null } }]), null);
  assert.equal(
    diagnoseUnreachable([
      { probe: { reachable: false, error: ROUTER_ERROR } },
      { probe: { reachable: true, error: null } }
    ]),
    null
  );
  assert.equal(diagnoseUnreachable([]), null);
});

test("diagnoseUnreachable blames local setup when every probe failed on the router URL", () => {
  const diag = diagnoseUnreachable([
    { probe: { reachable: false, error: ROUTER_ERROR } },
    { probe: { reachable: false, error: ROUTER_ERROR } }
  ]);
  assert.equal(diag.kind, "setup");
  assert.match(diag.message, /SELAT Router URL is not configured/);
  assert.match(diag.hint, /selat init/);
});

test("diagnoseUnreachable blames the candidates when even one failure is remote", () => {
  const diag = diagnoseUnreachable([
    { probe: { reachable: false, error: ROUTER_ERROR } },
    { probe: { reachable: false, error: "connect ETIMEDOUT" } }
  ]);
  assert.equal(diag.kind, "candidates");
  assert.match(diag.message, /no candidate answered .*\(2 probed\)/);
  assert.equal(diag.hint, null);
});

test("diagnoseUnreachable also reads bare probe results (verify's steps)", () => {
  // `verify` reports steps as { reachable, error, … } with no `probe` wrapper.
  assert.equal(diagnoseUnreachable([{ reachable: false, error: ROUTER_ERROR }]).kind, "setup");
  assert.equal(diagnoseUnreachable([{ reachable: false, error: null }]).kind, "candidates");
});

// ── settleCandidate (real spend — capped) ───────────────────────────────────

test("settleCandidate settles under the given cap and reports the HTTP status", async () => {
  const pay = fakeScript({ stdout: '{"data":"ok"}', stderr: "[selat-pay] status=200\n" });
  const res = await settleCandidate(
    ["GET", "https://api.example/v1", "--chain", "base", "--max-amount", "0.10"],
    { selatPay: asSelatPay(pay.path), capUsd: 0.01, chain: "polygon" }
  );
  assert.deepEqual(res, {
    settled: true,
    httpStatus: 200,
    latencyMs: res.latencyMs,
    stdout: '{"data":"ok"}',
    error: null
  });
  assert.deepEqual(pay.argv(), [
    "GET", "https://api.example/v1", "--chain", "polygon", "--max-amount", "0.01"
  ]);
  assert.ok(!pay.argv().includes("--probe-only"));
});

test("settleCandidate reports selat-pay's error, or a bare exit code", async () => {
  const named = fakeScript({ stderr: "[selat-pay] error: insufficient_balance\n", exitCode: 1 });
  const res = await settleCandidate(["GET", "https://api.example/v1"], {
    selatPay: asSelatPay(named.path),
    capUsd: 0.01
  });
  assert.equal(res.settled, false);
  assert.equal(res.httpStatus, null);
  assert.equal(res.error, "insufficient_balance");

  const silent = fakeScript({ exitCode: 4 });
  const res2 = await settleCandidate(["GET", "https://api.example/v1"], {
    selatPay: asSelatPay(silent.path),
    capUsd: 0.01
  });
  assert.equal(res2.error, "selat-pay exited 4");
});

// Review-#3 Tier-1 #5: compare --pay ran the catalog exec-hint argv with none
// of the validation `run` applies, and settleArgv replaced only the FIRST
// --max-amount while selat-pay is last-wins — so a hint could bypass the
// confirmed cap, fake settlement with --probe-only, or inject control chars.

test("settleArgv strips ALL --max-amount (duplicate-cap bypass) and any --probe-only", () => {
  // Hostile hint: cheap first cap (what a user might see), expensive second
  // (what selat-pay's last-wins parser would enforce), plus a --probe-only.
  const hostile = ["GET", "https://api.example/v1", "--max-amount", "0.05", "--probe-only", "--max-amount", "50"];
  const out = settleArgv(hostile, { capUsd: 0.01, chain: "base" });
  const caps = out.filter((a, i) => out[i - 1] === "--max-amount");
  assert.deepEqual(caps, ["0.01"], "exactly one cap, the confirmed one");
  assert.ok(!out.includes("--probe-only"), "no --probe-only on the settle leg");
  assert.ok(!out.includes("50"), "the hostile second cap is gone");
});

test("probeArgvForPlan rejects a hint with control characters, falling back to a safe argv", () => {
  const plan = {
    endpoint: { url: "https://api.example/v1", method: "GET" },
    exec_hints: [{ argv: ["selat-pay", "GET", "https://api.example/v1", "--max-amount", "0.05\ninjected"] }],
  };
  const built = probeArgvForPlan(plan);
  // Hint ignored (control char) -> synthesized argv, which carries no injected token.
  assert.ok(built.payArgv.every((a) => !/[\r\n]/.test(a)));
});

test("probeArgvForPlan reads the LAST --max-amount as the enforced hint cap (last-wins)", () => {
  const plan = {
    endpoint: { url: "https://api.example/v1", method: "GET" },
    exec_hints: [{ argv: ["selat-pay", "GET", "https://api.example/v1", "--max-amount", "0.05", "--max-amount", "50"] }],
  };
  const built = probeArgvForPlan(plan);
  assert.equal(built.hintCapUsd, 50, "the cap selat-pay would actually enforce, not the first");
});

test("probeArgvForPlan strips a hint-injected --probe-only from the pay argv", () => {
  const plan = {
    endpoint: { url: "https://api.example/v1", method: "GET" },
    exec_hints: [{ argv: ["selat-pay", "GET", "https://api.example/v1", "--probe-only", "--max-amount", "0.05"] }],
  };
  const built = probeArgvForPlan(plan);
  assert.ok(!built.payArgv.includes("--probe-only"));
});
