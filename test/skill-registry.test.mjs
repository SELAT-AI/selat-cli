import test from "node:test";
import assert from "node:assert/strict";

import { compileStep, validateManifest } from "../lib/skill-registry.mjs";

// A manifest is untrusted data fetched anonymously from a public, community
// repo. These tests pin the validation that keeps a malicious or compromised
// manifest from (a) declaring an arbitrarily large spend cap or (b) routing a
// signed USDC payment to an unsafe destination. See SELAT-AI/selat-cli#16.

function manifest(over = {}) {
  return {
    schema: "selat-skill/v1",
    name: "demo",
    chain: "base",
    steps: [{ method: "GET", url: "https://api.example.com/data", ...over }],
  };
}

function step(over = {}) {
  return { method: "GET", url: "https://api.example.com/data", ...over };
}

// ── compileStep: spend cap ──────────────────────────────────────────────────

test("compileStep rejects an attacker-sized manifest cap", () => {
  assert.throws(
    () => compileStep({ chain: "base", maxAmount: "1000000" }, step(), {}),
    /exceeds the per-call ceiling/
  );
});

test("compileStep rejects a non-numeric manifest cap", () => {
  assert.throws(
    () => compileStep({ chain: "base", maxAmount: "lots" }, step(), {}),
    /must be a positive number/
  );
});

test("compileStep rejects a zero or negative manifest cap", () => {
  assert.throws(() => compileStep({ chain: "base", maxAmount: "0" }, step(), {}), /positive number/);
  assert.throws(() => compileStep({ chain: "base", maxAmount: "-1" }, step(), {}), /positive number/);
});

test("compileStep accepts a small manifest cap within the ceiling", () => {
  const { argv } = compileStep({ chain: "base", maxAmount: "0.01" }, step(), {});
  assert.deepEqual(argv.slice(-2), ["--max-amount", "0.01"]);
});

test("compileStep treats an explicit --max-amount as user authority, unbounded by the ceiling", () => {
  // The manifest declares a hostile cap, but the user explicitly overrides it.
  const { argv } = compileStep(
    { chain: "base", maxAmount: "1000000" },
    step(),
    {},
    { maxAmount: "5" }
  );
  assert.deepEqual(argv.slice(-2), ["--max-amount", "5"]);
});

test("compileStep still validates a malformed user override", () => {
  assert.throws(
    () => compileStep({ chain: "base", maxAmount: "0.01" }, step(), {}, { maxAmount: "abc" }),
    /must be a positive number/
  );
});

// ── compileStep: --raw-key override ─────────────────────────────────────────

test("compileStep emits --raw-key when the override is set", () => {
  // Arc Gateway funds sit under a raw EOA the Circle Agent Wallet can't sign,
  // so `selat skill run --raw-key` must reach selat-pay as --raw-key.
  const { argv } = compileStep({ chain: "arc", maxAmount: "0.01" }, step(), {}, { rawKey: true });
  assert.ok(argv.includes("--raw-key"), "argv should include --raw-key");
});

test("compileStep omits --raw-key by default (default signing path)", () => {
  const { argv } = compileStep({ chain: "base", maxAmount: "0.01" }, step(), {});
  assert.ok(!argv.includes("--raw-key"), "argv should not include --raw-key");
});

test("compileStep omits --raw-key when the override is falsy", () => {
  const { argv } = compileStep({ chain: "base", maxAmount: "0.01" }, step(), {}, { rawKey: false });
  assert.ok(!argv.includes("--raw-key"));
});

test("compileStep requires a cap from some source", () => {
  assert.throws(() => compileStep({ chain: "base" }, step(), {}), /no maxAmount set/);
});

// ── compileStep: payment destination ──────────────────────────────────────────

test("compileStep rejects a plain-http upstream", () => {
  assert.throws(
    () => compileStep({ chain: "base", maxAmount: "0.01" }, step({ url: "http://evil.example/x" }), {}),
    /must use https:\/\//
  );
});

test("compileStep rejects http smuggled in through a template parameter", () => {
  // The static url passes scheme checks at validate time, but resolves to
  // http:// after substitution — compileStep must catch the compiled url.
  assert.throws(
    () =>
      compileStep(
        { chain: "base", maxAmount: "0.01" },
        step({ url: "http://${host}/x" }),
        { host: "evil.example" }
      ),
    /must use https:\/\//
  );
});

test("compileStep allows http only for loopback (local dev)", () => {
  const { argv } = compileStep(
    { chain: "base", maxAmount: "0.01" },
    step({ url: "http://localhost:8787/x" }),
    {}
  );
  assert.equal(argv[1], "http://localhost:8787/x");
});

test("compileStep compiles an https upstream with substituted params", () => {
  const { argv } = compileStep(
    { chain: "base", maxAmount: "0.01" },
    step({ url: "https://api.example.com/q?ids=${ids}" }),
    { ids: "ETH,USDC" }
  );
  assert.equal(argv[1], "https://api.example.com/q?ids=ETH%2CUSDC");
});

// ── validateManifest: early feedback at install / load ───────────────────────

test("validateManifest rejects a plain-http step url", () => {
  assert.throws(() => validateManifest(manifest({ url: "http://evil.example/x" })), /must use https:\/\//);
});

test("validateManifest rejects a manifest-level cap over the ceiling", () => {
  assert.throws(
    () => validateManifest({ schema: "selat-skill/v1", name: "demo", maxAmount: "999", steps: [step()] }),
    /exceeds the per-call ceiling/
  );
});

test("validateManifest rejects a non-numeric step cap", () => {
  assert.throws(() => validateManifest(manifest({ maxAmount: "free" })), /must be a positive number/);
});

test("validateManifest defers a fully-templated host to compile time", () => {
  // "https://${host}/x" can't be scheme-checked until params are substituted,
  // so validate must not false-positive on it.
  assert.doesNotThrow(() => validateManifest(manifest({ url: "https://${host}/x" })));
});

test("validateManifest accepts a clean manifest", () => {
  const m = manifest({ maxAmount: "0.05" });
  assert.equal(validateManifest(m), m);
});
