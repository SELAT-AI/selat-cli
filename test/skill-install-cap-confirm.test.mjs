import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { installSkill, planCapConfirmation } from "../lib/skill-registry.mjs";

// Vetted registry skills may declare per-step caps above the $1 manifest
// ceiling (documented, priced endpoints). Interactive installs now surface the
// offending caps and ask (default NO) instead of hard-erroring; non-TTY
// installs keep the fail-fast ceiling error, which names --max-amount. These
// pin the pure decision helper (planCapConfirmation) and the installSkill
// onConfirmCaps wiring. See tester feedback WS3.

function manifest(over = {}) {
  return {
    schema: "selat-skill/v1",
    name: "demo",
    description: "demo",
    chain: "base",
    steps: [{ method: "GET", url: "https://api.example.com/data", maxAmount: "0.10" }],
    ...over,
  };
}

// ── planCapConfirmation: the pure decision ──────────────────────────────────

test("proceeds when every declared cap is within the ceiling", () => {
  const plan = planCapConfirmation(manifest({ maxAmount: "0.50" }));
  assert.deepEqual(plan, { action: "proceed", caps: [] });
});

test("a cap exactly at the ceiling is not above it", () => {
  const plan = planCapConfirmation(
    manifest({ maxAmount: "1.00", steps: [{ method: "GET", url: "https://a.example/x", maxAmount: "1.00" }] })
  );
  assert.equal(plan.action, "proceed");
});

test("confirms interactively when a step cap exceeds the ceiling", () => {
  const m = manifest({
    steps: [
      { method: "GET", url: "https://a.example/x", maxAmount: "0.10", label: "cheap step" },
      { method: "GET", url: "https://b.example/y", maxAmount: "2.50", label: "pricey step" },
    ],
  });
  const plan = planCapConfirmation(m, { interactive: true });
  assert.equal(plan.action, "confirm");
  assert.deepEqual(plan.caps, [{ source: "step 2", label: "pricey step", cap: 2.5 }]);
});

test("lists the manifest-level cap too, and every offending step", () => {
  const m = manifest({
    maxAmount: "5.00",
    steps: [
      { method: "GET", url: "https://a.example/x", maxAmount: "5.00", label: "one" },
      { method: "GET", url: "https://b.example/y", maxAmount: "5.00" },
    ],
  });
  const plan = planCapConfirmation(m, { interactive: true });
  assert.equal(plan.action, "confirm");
  assert.deepEqual(plan.caps, [
    { source: "step 1", label: "one", cap: 5 },
    { source: "step 2", label: null, cap: 5 },
    { source: "manifest", label: null, cap: 5 },
  ]);
});

test("rejects (fail-fast) when above-ceiling caps meet a non-interactive stdin", () => {
  const plan = planCapConfirmation(manifest({ maxAmount: "5.00" }), { interactive: false });
  assert.equal(plan.action, "reject");
  assert.equal(plan.caps.length, 1);
});

test("an explicit --max-amount is user authority: no prompt, exactly as today", () => {
  const plan = planCapConfirmation(manifest({ maxAmount: "5.00" }), {
    interactive: true,
    maxAmountOverride: "5.00",
  });
  assert.deepEqual(plan, { action: "proceed", caps: [] });
});

test("ignores malformed cap values (validateManifest still rejects them)", () => {
  const m = manifest({ steps: [{ method: "GET", url: "https://a.example/x", maxAmount: "lots" }] });
  const plan = planCapConfirmation(m, { interactive: true });
  assert.equal(plan.action, "proceed");
});

test("tolerates a junk manifest shape without throwing", () => {
  assert.equal(planCapConfirmation(null).action, "proceed");
  assert.equal(planCapConfirmation({ steps: "nope" }).action, "proceed");
});

// ── installSkill: onConfirmCaps wiring ──────────────────────────────────────

async function withHighCapSkill(fn) {
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldDev = process.env.SELAT_SKILLS_DIR;
  const root = await mkdtemp(join(tmpdir(), "selat-cli-test-"));
  const src = join(root, "src");
  const xdg = join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.SELAT_SKILLS_DIR;
  try {
    await mkdir(src, { recursive: true });
    await writeFile(
      join(src, "manifest.json"),
      JSON.stringify({
        schema: "selat-skill/v1",
        name: "high-cap-confirm-demo",
        description: "High cap confirm demo",
        chain: "base",
        maxAmount: "2.50",
        steps: [{ method: "GET", url: "https://api.example.com/data", maxAmount: "2.50", label: "pricey" }],
      }),
      "utf8"
    );
    await fn({ src, xdg });
  } finally {
    if (oldXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldDev == null) delete process.env.SELAT_SKILLS_DIR;
    else process.env.SELAT_SKILLS_DIR = oldDev;
  }
}

test("installSkill installs above-ceiling caps when the confirm callback accepts", async () => {
  await withHighCapSkill(async ({ src, xdg }) => {
    let seen = null;
    const res = await installSkill(src, {
      onConfirmCaps: async (caps) => {
        seen = caps;
        return true;
      },
    });
    assert.equal(res.name, "high-cap-confirm-demo");
    assert.deepEqual(seen, [
      { source: "step 1", label: "pricey", cap: 2.5 },
      { source: "manifest", label: null, cap: 2.5 },
    ]);
    const stored = JSON.parse(
      await readFile(join(xdg, "selat", "skills", "high-cap-confirm-demo", "manifest.json"), "utf8")
    );
    assert.equal(stored.maxAmount, "2.50");
  });
});

test("installSkill aborts without writing when the confirm callback declines", async () => {
  await withHighCapSkill(async ({ src, xdg }) => {
    await assert.rejects(
      () => installSkill(src, { onConfirmCaps: async () => false }),
      /install cancelled[\s\S]*--max-amount/
    );
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(xdg, "selat", "skills", "high-cap-confirm-demo")), false);
  });
});

test("installSkill without a callback keeps today's fail-fast ceiling error", async () => {
  await withHighCapSkill(async ({ src }) => {
    await assert.rejects(() => installSkill(src), /exceeds the per-call ceiling.*--max-amount/);
  });
});
