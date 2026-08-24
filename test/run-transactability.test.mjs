import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTransactabilityIndex,
  transactabilityLineFromStderr,
} from "../lib/commands/run.mjs";

// `selat run` surfaces the Transactability Score from selat-pay's captured
// stderr — DISPLAY ONLY. The one-line string is produced by selat-pay's shared
// formatter (@selat-ai/selat-pay/transactability); these pin the stderr parsing
// and the end-to-end line. Nothing here asserts any gate — there is none.

const stderrWith = (healthStatus) =>
  `[selat-pay] payTo=0xabc quoteId=q_123\n` +
  `[selat-pay] extensions=${JSON.stringify({
    selatTransactabilityIndex: { info: { healthStatus } },
  })}\n` +
  `[selat-pay] status=200\n`;

test("parses the STI block out of captured selat-pay stderr", () => {
  const hs = parseTransactabilityIndex(
    stderrWith({ stats: { "7d": { paidNum: 42, successRate: 0.98 } }, lastPaid: { status: 200, timestamp: "1786090695" } })
  );
  assert.ok(hs, "expected a healthStatus object");
  assert.equal(hs.stats["7d"].paidNum, 42);
  assert.equal(hs.lastPaid.status, 200);
});

test("formats the canonical Transactability Score line", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "7d": { paidNum: 42, successRate: 0.98 } }, lastPaid: { status: 200 } })
  );
  assert.equal(line, "✓ Transactability Score · 7d · delivered 2xx 98% · 42 paid · last 200");
  assert.ok(!line.includes("low confidence"), "42 paid is not a thin sample");
});

test("annotates low confidence when paidNum is small", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "24h": { paidNum: 1, successRate: 1 } }, lastPaid: { status: 200 } })
  );
  assert.equal(line, "✓ Transactability Score · 24h · delivered 2xx 100% · 1 paid (low confidence) · last 200");
});

test("a non-2xx lastPaid is shown as-is, never as a bad badge", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "7d": { paidNum: 8, successRate: 0.7 } }, lastPaid: { status: 503 } })
  );
  assert.equal(line, "✓ Transactability Score · 7d · delivered 2xx 70% · 8 paid · last 503");
});

test("absent STI block reads as unmeasured, not a failure", () => {
  assert.equal(
    transactabilityLineFromStderr("[selat-pay] payTo=0xabc\n[selat-pay] status=200\n"),
    "Transactability Score: unmeasured"
  );
  assert.equal(transactabilityLineFromStderr(""), "Transactability Score: unmeasured");
  assert.equal(transactabilityLineFromStderr(undefined), "Transactability Score: unmeasured");
});

test("parseTransactabilityIndex returns null on garbled JSON", () => {
  assert.equal(parseTransactabilityIndex("[selat-pay] extensions={not json}\n"), null);
});

// --- probe argv transform: the dry-run --live-probe seam ----------------------

import { probeArgvFromPayArgs } from "../lib/commands/run.mjs";

test("probeArgvFromPayArgs drops --max-amount and adds --probe-only --live-probe", () => {
  const pay = ["POST", "https://api.exa.ai/search", "--chain", "base", "--body", "{}", "--max-amount", "0.015"];
  const probe = probeArgvFromPayArgs(pay);
  assert.deepEqual(probe, [
    "POST", "https://api.exa.ai/search", "--chain", "base", "--body", "{}",
    "--probe-only", "--live-probe",
  ]);
  assert.ok(!probe.includes("--max-amount"), "cap must be dropped — a probe never settles");
});

test("probeArgvFromPayArgs preserves the endpoint/method/body and never double-adds probe flags", () => {
  const pay = ["GET", "https://x/y", "--chain", "base", "--probe-only", "--live-probe", "--max-amount", "1"];
  const probe = probeArgvFromPayArgs(pay);
  assert.equal(probe.filter((a) => a === "--probe-only").length, 1);
  assert.equal(probe.filter((a) => a === "--live-probe").length, 1);
  assert.equal(probe[0], "GET");
  assert.equal(probe[1], "https://x/y");
});
