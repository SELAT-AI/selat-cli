import test from "node:test";
import assert from "node:assert/strict";

import { probeRouterHealthz, describeProbeError } from "../lib/commands/doctor.mjs";

// A single probe flip-flopped the doctor verdict on transient network blips
// even though /healthz consistently returns 200 — the check must retry before
// failing, and a final failure must name the cause instead of "(network error)".

const ROUTER = "https://router.example.com";

/** sleep that records requested delays without waiting real time. */
function fakeSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

function fetchFailure(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}

test("passes on first-attempt 2xx without retrying", async () => {
  const { delays, sleep } = fakeSleep();
  const urls = [];
  const res = await probeRouterHealthz({
    routerUrl: ROUTER,
    fetchImpl: async (url) => { urls.push(url); return { status: 200 }; },
    sleep
  });
  assert.deepEqual(res, { ok: true, status: 200, attempt: 1 });
  assert.deepEqual(urls, [`${ROUTER}/healthz`]); // probes /healthz, not the root
  assert.deepEqual(delays, []); // no backoff on success
});

test("recovers from a transient failure: fail, backoff, then 2xx passes", async () => {
  const { delays, sleep } = fakeSleep();
  const outcomes = [
    () => { throw fetchFailure("ECONNRESET"); },
    () => ({ status: 204 }) // any 2xx is a pass, not just 200
  ];
  const res = await probeRouterHealthz({
    routerUrl: ROUTER,
    backoffMs: 500,
    fetchImpl: async () => outcomes.shift()(),
    sleep
  });
  assert.deepEqual(res, { ok: true, status: 204, attempt: 2 });
  assert.deepEqual(delays, [500]); // one backoff between the two attempts
});

test("exhausts all attempts with growing backoff and reports the last network error", async () => {
  const { delays, sleep } = fakeSleep();
  let calls = 0;
  const res = await probeRouterHealthz({
    routerUrl: ROUTER,
    attempts: 3,
    backoffMs: 500,
    fetchImpl: async () => { calls++; throw fetchFailure("ECONNREFUSED"); },
    sleep
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]); // backoff grows, none after the last attempt
  assert.deepEqual(res, { ok: false, attempt: 3, status: null, error: "connection refused" });
});

test("a persistent non-2xx fails with the status, not a network-error message", async () => {
  const { sleep } = fakeSleep();
  const res = await probeRouterHealthz({
    routerUrl: ROUTER,
    attempts: 2,
    fetchImpl: async () => ({ status: 503 }),
    sleep
  });
  assert.deepEqual(res, { ok: false, attempt: 2, status: 503, error: null });
});

test("reports whichever outcome the final attempt saw when failures are mixed", async () => {
  const { sleep } = fakeSleep();
  const outcomes = [
    () => ({ status: 502 }),
    () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }) }
  ];
  const res = await probeRouterHealthz({
    routerUrl: ROUTER,
    attempts: 2,
    fetchImpl: async () => outcomes.shift()(),
    sleep
  });
  assert.deepEqual(res, { ok: false, attempt: 2, status: null, error: "timeout" });
});

// --- describeProbeError ------------------------------------------------------

test("classifies the distinguishing failure causes", () => {
  assert.equal(describeProbeError(Object.assign(new Error("t"), { name: "TimeoutError" })), "timeout");
  assert.equal(describeProbeError(fetchFailure("ENOTFOUND")), "DNS lookup failed (ENOTFOUND)");
  assert.equal(describeProbeError(fetchFailure("EAI_AGAIN")), "DNS lookup failed (EAI_AGAIN)");
  assert.equal(describeProbeError(fetchFailure("ECONNREFUSED")), "connection refused");
  assert.equal(describeProbeError(fetchFailure("ECONNRESET")), "connection reset");
  assert.equal(describeProbeError(fetchFailure("EHOSTUNREACH")), "host unreachable (EHOSTUNREACH)");
  assert.equal(describeProbeError(fetchFailure("UND_ERR_CONNECT_TIMEOUT")), "timeout");
  assert.equal(describeProbeError(fetchFailure("CERT_HAS_EXPIRED")), "TLS error (CERT_HAS_EXPIRED)");
  assert.equal(describeProbeError(fetchFailure("DEPTH_ZERO_SELF_SIGNED_CERT")), "TLS error (DEPTH_ZERO_SELF_SIGNED_CERT)");
  assert.equal(describeProbeError(fetchFailure("ERR_TLS_CERT_ALTNAME_INVALID")), "TLS error (ERR_TLS_CERT_ALTNAME_INVALID)");
});

test("digs the code out of an AggregateError cause (multi-address connect failure)", () => {
  const agg = new AggregateError([Object.assign(new Error("refused"), { code: "ECONNREFUSED" })], "aggregate");
  const err = Object.assign(new TypeError("fetch failed"), { cause: agg });
  assert.equal(describeProbeError(err), "connection refused");
});

test("falls back to the raw code or message instead of a bare '(network error)'", () => {
  assert.equal(describeProbeError(fetchFailure("EPIPE")), "network error (EPIPE)");
  assert.equal(describeProbeError(new TypeError("fetch failed")), "network error (fetch failed)");
  assert.equal(describeProbeError(undefined), "network error (unknown)");
});
