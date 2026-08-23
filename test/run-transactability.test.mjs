import test from "node:test";
import assert from "node:assert/strict";

import {
  parseTransactabilityIndex,
  formatTransactabilityLine,
  transactabilityLineFromStderr,
} from "../lib/commands/run.mjs";

// `selat run` surfaces the Transactability Index (STI) from selat-pay's captured
// stderr — DISPLAY ONLY. These pin the field derivation (window key + successRate%
// + paidNum + lastPaid.status) and the "unmeasured" fallback when the block is
// absent. Nothing here asserts any gate/threshold behaviour — there is none.

const stderrWith = (healthStatus) =>
  `[selat-pay] payTo=0xabc quoteId=q_123\n` +
  `[selat-pay] extensions=${JSON.stringify({
    selatTransactabilityIndex: { info: { healthStatus } },
  })}\n` +
  `[selat-pay] status=200\n`;

test("parses the STI block out of captured selat-pay stderr", () => {
  const hs = parseTransactabilityIndex(
    stderrWith({ stats: { "7d": { paidNum: 42, successRate: 0.98 } }, lastPaid: { status: 200, timestamp: "2026-08-20T10:00:00Z" } })
  );
  assert.ok(hs, "expected a healthStatus object");
  assert.equal(hs.stats["7d"].paidNum, 42);
  assert.equal(hs.lastPaid.status, 200);
});

test("formats window key + successRate% + paidNum + lastPaid.status", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "7d": { paidNum: 42, successRate: 0.98 } }, lastPaid: { status: 200, timestamp: "2026-08-20T10:00:00Z" } })
  );
  assert.equal(line, "Transactability Index: 7d · 98% delivered 2xx · 42 paid · last paid 200");
  assert.ok(!line.includes("low confidence"), "42 paid is not a thin sample");
});

test("annotates low confidence when paidNum is small", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "24h": { paidNum: 1, successRate: 1 } }, lastPaid: { status: 200 } })
  );
  assert.equal(line, "Transactability Index: 24h · 100% delivered 2xx · 1 paid (low confidence) · last paid 200");
});

test("accepts successRate given as a percentage (0..100) or a fraction (0..1)", () => {
  assert.match(
    formatTransactabilityLine({ stats: { all: { paidNum: 9, successRate: 96 } } }),
    /all · 96% delivered 2xx · 9 paid/
  );
  assert.match(
    formatTransactabilityLine({ stats: { all: { paidNum: 9, successRate: 0.5 } } }),
    /all · 50% delivered 2xx/
  );
});

test("a non-2xx lastPaid is shown as-is, never as a bad badge", () => {
  const line = formatTransactabilityLine({ stats: { "7d": { paidNum: 8, successRate: 0.7 } }, lastPaid: { status: 503 } });
  assert.equal(line, "Transactability Index: 7d · 70% delivered 2xx · 8 paid · last paid 503");
});

test("absent STI block reads as unmeasured, not a failure", () => {
  // No extensions line at all in the captured stderr.
  assert.equal(
    transactabilityLineFromStderr("[selat-pay] payTo=0xabc\n[selat-pay] status=200\n"),
    "Transactability Index: unmeasured"
  );
  assert.equal(transactabilityLineFromStderr(""), "Transactability Index: unmeasured");
  assert.equal(transactabilityLineFromStderr(undefined), "Transactability Index: unmeasured");
  // Present block but empty window + empty lastPaid is still "unmeasured".
  assert.equal(
    transactabilityLineFromStderr(stderrWith({ stats: {}, lastPaid: {} })),
    "Transactability Index: unmeasured"
  );
});

test("parseTransactabilityIndex returns null on garbled JSON", () => {
  assert.equal(parseTransactabilityIndex("[selat-pay] extensions={not json}\n"), null);
});
