import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeHttpUrl, isLoopbackHost, safeHttpUrl } from "../lib/url-safety.mjs";
import { probeArgvForPlan } from "../lib/compare.mjs";
import { resolveArcDepositEnv } from "../lib/commands/fund.mjs";
import { parseSelatPayHint } from "../lib/commands/run.mjs";

test("safeHttpUrl accepts https and loopback http only", () => {
  assert.ok(safeHttpUrl("https://api.example.com/x?q=1"));
  assert.ok(safeHttpUrl("http://localhost:8080/healthz"));
  assert.ok(safeHttpUrl("http://127.0.0.1:8080"));
  assert.equal(safeHttpUrl("http://evil.example/x"), null);
  assert.equal(safeHttpUrl("file:///etc/passwd"), null);
  assert.equal(safeHttpUrl("ftp://example.com"), null);
  assert.equal(safeHttpUrl("not a url"), null);
  assert.equal(safeHttpUrl(""), null);
  assert.equal(safeHttpUrl(undefined), null);
});

test("safeHttpUrl rejects a value curl/selat-pay would read as a flag", () => {
  assert.equal(safeHttpUrl("-K/tmp/curlrc"), null);
  assert.equal(safeHttpUrl("--output=/tmp/x"), null);
});

test("isLoopbackHost covers the loopback spellings", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  assert.equal(isLoopbackHost("localhost.evil.example"), false);
});

test("assertSafeHttpUrl distinguishes unparseable from unsafe", () => {
  assert.throws(() => assertSafeHttpUrl("nope", { source: "router" }), /is not a valid URL/);
  assert.throws(() => assertSafeHttpUrl("http://evil.example", { source: "router" }), /must use https:\/\//);
});

test("probeArgvForPlan refuses a catalog endpoint that is not https", () => {
  const plan = (url) => ({ endpoint: { url, method: "GET" }, service: { name: "svc" } });
  assert.equal(probeArgvForPlan(plan("http://evil.example/paid")), null);
  assert.equal(probeArgvForPlan(plan("file:///etc/passwd")), null);
  assert.ok(probeArgvForPlan(plan("https://api.example.com/paid")));
});

test("probeArgvForPlan ignores an exec hint pointed at a non-https url", () => {
  const built = probeArgvForPlan({
    endpoint: { url: "http://evil.example/paid", method: "GET" },
    exec_hints: [{ argv: ["selat-pay", "GET", "http://evil.example/paid", "--chain", "base", "--max-amount", "5"] }],
    service: { name: "svc" }
  });
  assert.equal(built, null);
});

test("parseSelatPayHint rejects a hint whose payment url is not https", () => {
  const hint = (url) => ({ argv: ["selat-pay", "GET", url, "--chain", "base", "--max-amount", "0.05"] });
  assert.match(parseSelatPayHint(hint("http://evil.example/paid")).reason, /must use https:\/\//);
  assert.match(parseSelatPayHint(hint("file:///etc/passwd")).reason, /must use https:\/\//);
  assert.match(
    parseSelatPayHint({ cmd: "selat-pay GET http://evil.example/paid --chain base --max-amount 0.05" }).reason,
    /must use https:\/\//
  );
  assert.equal(parseSelatPayHint(hint("https://api.example.com/paid")).ok, true);
  assert.equal(parseSelatPayHint(hint("http://localhost:4000/paid")).ok, true);
});

test("resolveArcDepositEnv rejects a plaintext ARC_RPC_URL", () => {
  const env = { SELAT_PRIVATE_KEY: "0xabc", ARC_RPC_URL: "http://rpc.evil.example" };
  const res = resolveArcDepositEnv({ method: "direct", env });
  assert.equal(res.ok, false);
  assert.match(res.error, /must be an https:\/\/ URL/);
  assert.equal(res.missing, undefined);
});

test("resolveArcDepositEnv accepts an https ARC_RPC_URL", () => {
  const env = { SELAT_PRIVATE_KEY: "0xabc", ARC_RPC_URL: "https://rpc.arc.example" };
  const res = resolveArcDepositEnv({ method: "direct", env });
  assert.equal(res.ok, true);
  assert.deepEqual(res.env, { SELAT_PRIVATE_KEY: "0xabc", ARC_RPC_URL: "https://rpc.arc.example" });
});
