import test from "node:test";
import assert from "node:assert/strict";

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// resolveSelatPay memoizes its answer for the process, so a case that needs a
// different resolution loads its own module instance (the query string defeats
// the ESM cache). Instances are shared by group to keep that to a minimum.
// The resolution ORDER is the point: a stale global selat-pay silently
// overriding the bundled, pinned version is where version-skew payment bugs
// came from — see the module header in lib/selat-pay.mjs.
const loadFresh = (tag) => import(`../lib/selat-pay.mjs?case=${tag}`);

/** A fake selat-pay install: <root>/package.json + <root>/bin/selat-pay.mjs. */
function fakeInstall({ version = "9.9.9", exitCode = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "selat-pay-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@selat-ai/selat-pay", version }));
  mkdirSync(join(root, "bin"));
  const bin = join(root, "bin", "selat-pay.mjs");
  writeFileSync(bin, `process.exit(${exitCode});\n`);
  return { root, bin };
}

function setEnv(vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ── An explicit SELAT_PAY_BIN override ──────────────────────────────────────

const override = fakeInstall({ version: "1.2.3" });
const restoreOverrideEnv = setEnv({ SELAT_PAY_BIN: override.bin });
const overrideMod = await loadFresh("override");
test.after(restoreOverrideEnv);

test("SELAT_PAY_BIN wins and reports the adjacent package root", async () => {
  const r = await overrideMod.resolveSelatPay();
  assert.equal(r.source, "env-override");
  assert.equal(r.bin, override.bin);
  assert.equal(r.packageRoot, override.root, "walks up to the package.json next to bin/");
  assert.equal(r.binDir, null);
  assert.equal(await overrideMod.hasSelatPay(), true);
});

test("resolution is memoized: the second call returns the same object", async () => {
  assert.equal(await overrideMod.resolveSelatPay(), await overrideMod.resolveSelatPay());
});

test("selatPayVersion reports source, path and package version for an override", async () => {
  assert.equal(await overrideMod.selatPayVersion(), `installed (env-override, ${override.bin}, v1.2.3)`);
});

test("ensureSelatPayHistoryDir creates the parent of SELAT_PAY_HISTORY_PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-hist-"));
  const restore = setEnv({ SELAT_PAY_HISTORY_PATH: join(dir, "deep", "gateway-history.jsonl") });
  try {
    await overrideMod.ensureSelatPayHistoryDir();
    assert.equal(existsSync(join(dir, "deep")), true);
    await overrideMod.ensureSelatPayHistoryDir(); // idempotent
  } finally {
    restore();
  }
});

test("ensureSelatPayHistoryDir honors XDG_STATE_HOME when no explicit path is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-state-"));
  const restore = setEnv({ SELAT_PAY_HISTORY_PATH: undefined, XDG_STATE_HOME: dir });
  try {
    await overrideMod.ensureSelatPayHistoryDir();
    assert.equal(existsSync(join(dir, "selat-pay")), true);
  } finally {
    restore();
  }
});

// ── An override that is a bare binary (no package.json, doesn't run) ─────────

test("a bare override resolves with a null packageRoot and no version claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-pay-bare-"));
  const bin = join(dir, "selat-pay.mjs");
  writeFileSync(bin, "process.exit(0);\n");
  const restore = setEnv({ SELAT_PAY_BIN: bin });
  try {
    const mod = await loadFresh("bare");
    const r = await mod.resolveSelatPay();
    assert.equal(r.source, "env-override");
    assert.equal(r.packageRoot, null, "nothing above it looks like a package");
    assert.equal(await mod.selatPayVersion(), `installed (env-override, ${bin})`);
  } finally {
    restore();
  }
});

test("selatPayVersion returns null when the resolved binary does not run", async () => {
  const { bin } = fakeInstall({ exitCode: 1 });
  const restore = setEnv({ SELAT_PAY_BIN: bin });
  try {
    const mod = await loadFresh("broken");
    assert.equal(await mod.selatPayVersion(), null, "a binary that can't even --help is not usable");
  } finally {
    restore();
  }
});

// ── No override: a typo must fail loud; otherwise the bundled dep is used ────

test("a SELAT_PAY_BIN typo fails loud instead of falling through to another binary", async () => {
  const restore = setEnv({ SELAT_PAY_BIN: join(tmpdir(), "no-such-selat-pay") });
  try {
    const mod = await loadFresh("default");
    await assert.rejects(mod.resolveSelatPay(), /does not exist/);
  } finally {
    restore();
  }
});

test("without an override the bundled dependency is used, not a PATH lookup", async () => {
  const restore = setEnv({ SELAT_PAY_BIN: undefined });
  try {
    // Same instance as the typo case above: that throw never cached a result.
    const mod = await loadFresh("default");
    const r = await mod.resolveSelatPay();
    assert.equal(r.source, "bundled");
    assert.ok(existsSync(r.bin), "the bundled bin path must exist");
    assert.match(r.binDir, /\.bin$/);
    assert.match(r.packageRoot, /selat-pay$/);
    assert.equal(await mod.hasSelatPay(), true);
  } finally {
    restore();
  }
});
