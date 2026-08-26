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
  assert.equal(line, "✓ Transactability Score · 7d 2xx 98% (42 paid) · last 200");
  assert.ok(!line.includes("low confidence"), "42 paid is not a thin sample");
});

test("annotates low confidence when paidNum is small", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "24h": { paidNum: 1, successRate: 1 } }, lastPaid: { status: 200 } })
  );
  assert.equal(line, "✓ Transactability Score · 24h 2xx 100% (1 paid) · low confidence · last 200");
});

test("a non-2xx lastPaid is shown as-is, never as a bad badge", () => {
  const line = transactabilityLineFromStderr(
    stderrWith({ stats: { "7d": { paidNum: 8, successRate: 0.7 } }, lastPaid: { status: 503 } })
  );
  assert.equal(line, "✓ Transactability Score · 7d 2xx 70% (8 paid) · last 503");
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

// --- trace passthrough: quote.transactabilityTrace from probe stdout ----------
//
// `selat run --dry-run --live-probe --json` passes the full decision trace
// through from selat-pay's --probe-only JSON stdout, so machine consumers get
// it without reaching for the internal selat-pay CLI. These pin the stdout
// parsing seam. DISPLAY/telemetry only — nothing gates on the trace.

import { transactabilityTraceFromStdout } from "../lib/commands/run.mjs";

// A representative --probe-only stdout: one JSON object whose quote carries
// the attribution-typed trace (shape owned by selat-pay's
// buildTransactabilityTrace; we pass it through opaquely).
const probeStdoutWith = (trace) =>
  JSON.stringify(
    {
      mode: "routed",
      selectedProtocol: "x402",
      detected: { protocols: ["x402"] },
      quote: {
        quoteId: "q_123",
        price: { amount: "15000", formatted: "$0.015000 USDC" },
        network: "base",
        payTo: "0xabc",
        scheme: "exact",
        ...(trace !== undefined ? { transactabilityTrace: trace } : {}),
      },
    },
    null,
    2
  ) + "\n";

const SAMPLE_TRACE = {
  metric: "transactability",
  version: "1",
  endpointUrl: "https://api.exa.ai/search",
  dataStatus: "measured",
  attribution: {
    counterparty: {
      owner: "endpoint",
      primarySource: "network",
      signal: "ok",
      network: { window: "7d", deliveryRate: 0.98, capturedPayments: 42, scope: "network-wide" },
    },
  },
};

test("parses quote.transactabilityTrace out of --probe-only stdout", () => {
  const trace = transactabilityTraceFromStdout(probeStdoutWith(SAMPLE_TRACE));
  assert.ok(trace, "expected a trace object");
  // Passthrough is opaque: the object comes back exactly as selat-pay emitted it.
  assert.deepEqual(trace, SAMPLE_TRACE);
});

test("a quote without a trace yields null, not an error", () => {
  assert.equal(transactabilityTraceFromStdout(probeStdoutWith(undefined)), null);
});

test("non-JSON, empty, or missing stdout yields null", () => {
  assert.equal(transactabilityTraceFromStdout("routed free passthrough\n"), null);
  assert.equal(transactabilityTraceFromStdout(""), null);
  assert.equal(transactabilityTraceFromStdout(undefined), null);
  assert.equal(transactabilityTraceFromStdout(null), null);
});

test("a non-object trace value is rejected, not passed through", () => {
  assert.equal(transactabilityTraceFromStdout(probeStdoutWith("measured")), null);
  assert.equal(transactabilityTraceFromStdout(probeStdoutWith(42)), null);
});
