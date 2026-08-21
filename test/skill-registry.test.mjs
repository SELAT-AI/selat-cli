import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compileStep, installSkill, listSkills, validateManifest } from "../lib/skill-registry.mjs";

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

test("compileStep refuses an explicit --max-amount above the hard CLI ceiling", () => {
  assert.throws(
    () => compileStep(
      { chain: "base", maxAmount: "0.01" },
      step(),
      {},
      { maxAmount: "999" }
    ),
    /hard cap \$5|hard CLI ceiling/
  );
});

test("compileStep refuses an explicit --max-amount of $5 even with a TTY raise", () => {
  assert.throws(
    () => compileStep(
      { chain: "base", maxAmount: "0.01" },
      step(),
      {},
      { maxAmount: "5", interactive: true, allowHighMaxAmount: true }
    ),
    /hard CLI ceiling/
  );
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

test("validateManifest accepts a high manifest cap with explicit --max-amount authorization", () => {
  assert.doesNotThrow(() =>
    validateManifest(
      { schema: "selat-skill/v1", name: "demo", maxAmount: "5", steps: [step({ maxAmount: "5" })] },
      { maxAmountOverride: "5" }
    )
  );
});

test("validateManifest rejects a high manifest cap above explicit --max-amount authorization", () => {
  assert.throws(
    () =>
      validateManifest(
        { schema: "selat-skill/v1", name: "demo", maxAmount: "5", steps: [step({ maxAmount: "5" })] },
        { maxAmountOverride: "1" }
      ),
    /exceeds explicit --max-amount/
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

test("installSkill installs a high-cap local manifest only with explicit authorization", async () => {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldDev = process.env.SELAT_SKILLS_DIR;
  const root = await mkdtemp(join(tmpdir(), "selat-cli-test-"));
  const src = join(root, "src");
  const xdg = join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.SELAT_SKILLS_DIR;

  try {
    await mkdir(src, { recursive: true });
    const manifestPath = join(src, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schema: "selat-skill/v1",
        name: "high-cap-demo",
        description: "High cap demo",
        chain: "base",
        maxAmount: "5",
        steps: [{ method: "GET", url: "https://api.example.com/data", maxAmount: "5" }]
      }),
      "utf8"
    );

    await assert.rejects(() => installSkill(src), /exceeds the per-call ceiling/);
    const installed = await installSkill(src, { maxAmount: "5" });
    assert.equal(installed.name, "high-cap-demo");
    assert.ok(existsSync(join(xdg, "selat", "skills", "high-cap-demo", "manifest.json")));
    const stored = JSON.parse(await readFile(join(xdg, "selat", "skills", "high-cap-demo", "manifest.json"), "utf8"));
    assert.equal(stored.maxAmount, "5");

    const skills = await listSkills();
    assert.ok(skills.some((s) => s.name === "high-cap-demo"), "high-cap installed skill should be listable");
  } finally {
    if (oldXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldDev == null) delete process.env.SELAT_SKILLS_DIR;
    else process.env.SELAT_SKILLS_DIR = oldDev;
  }
});

// ── chain is not a manifest property ────────────────────────────────────────
// Settlement chain is resolved at runtime (from the wallet's funded Gateway
// balance), so a manifest need not declare one. These pin that a chain-less
// manifest validates and compiles via the caller-supplied defaultChain.

test("validateManifest accepts a chain-less manifest", () => {
  assert.doesNotThrow(() =>
    validateManifest({ schema: "selat-skill/v1", name: "demo", maxAmount: "0.01", steps: [step()] })
  );
});

test("compileStep resolves a chain-less manifest from defaultChain (funded Gateway balance)", () => {
  const { argv } = compileStep({ maxAmount: "0.01" }, step(), {}, {}, "polygon");
  assert.equal(argv[2], "--chain");
  assert.equal(argv[3], "polygon"); // e.g. Eco-funded balance settles on Polygon
});

test("compileStep precedence: --chain override beats manifest chain beats defaultChain", () => {
  // manifest pins base, but an explicit --chain wins.
  const pinned = compileStep({ chain: "base", maxAmount: "0.01" }, step(), {}, { chain: "arbitrum" }, "polygon");
  assert.equal(pinned.argv[3], "arbitrum");
  // no override: an optional manifest pin still beats the default.
  const manifestPin = compileStep({ chain: "base", maxAmount: "0.01" }, step(), {}, {}, "polygon");
  assert.equal(manifestPin.argv[3], "base");
});

test("compileStep with no chain anywhere still errors clearly", () => {
  assert.throws(() => compileStep({ maxAmount: "0.01" }, step(), {}), /no chain set/);
});
