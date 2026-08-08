import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sh, hasBin, binVersion, shellQuoteForDisplay, isWindows } from "../lib/sh.mjs";

// Every external call selat makes (circle, node, selat-pay) goes through sh().
// These pin the capture/exit-code contract callers branch on — sh() never throws
// on a non-zero exit, so a silent behavior change here would be read as success.

test("sh captures stdout, stderr and the child's exit code without throwing", async () => {
  const res = await sh(process.execPath, [
    "-e",
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"
  ]);
  assert.equal(res.code, 3);
  assert.equal(res.stdout, "out");
  assert.equal(res.stderr, "err");
});

test("sh writes opts.input to the child's stdin", async () => {
  const res = await sh(process.execPath, [
    "-e",
    "process.stdin.on('data', (d) => process.stdout.write('got:' + d))"
  ], { input: "otp-123" });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "got:otp-123");
});

test("sh layers opts.env over the inherited environment", async () => {
  const res = await sh(process.execPath, ["-e", "process.stdout.write(String(process.env.SELAT_TEST_VAR))"], {
    env: { SELAT_TEST_VAR: "on" }
  });
  assert.equal(res.stdout, "on");
});

test("sh runs in opts.cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-sh-"));
  const res = await sh(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });
  assert.match(res.stdout, new RegExp(dir.split("/").pop()));
});

test("sh rejects when the command cannot be spawned at all", async (t) => {
  if (isWindows) return t.skip("cmd.exe reports a missing command as a non-zero exit, not a spawn error");
  await assert.rejects(sh("selat-definitely-not-a-real-binary"), (err) => err.code === "ENOENT");
});

test("hasBin finds a binary on PATH and rejects one that isn't there", async () => {
  assert.equal(await hasBin("node"), true);
  assert.equal(await hasBin("selat-definitely-not-a-real-binary"), false);
});

test("hasBin treats a path-like name as a filesystem check, not a PATH lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-bin-"));
  const bin = join(dir, "circle");
  writeFileSync(bin, "#!/bin/sh\n");
  assert.equal(await hasBin(bin), true, "an existing explicit CIRCLE_BIN path counts as installed");
  assert.equal(await hasBin(join(dir, "missing")), false);
});

test("binVersion returns the first line, or null when the probe fails", async () => {
  assert.match(await binVersion(process.execPath), /^v\d+\./);
  assert.equal(await binVersion("selat-definitely-not-a-real-binary"), null);
  assert.equal(
    await binVersion(process.execPath, "--definitely-not-a-node-flag"),
    null,
    "a non-zero exit has no usable version"
  );
});

test("binVersion falls back to stderr when the tool prints its version there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-ver-"));
  const script = join(dir, "tool.mjs");
  writeFileSync(script, "process.stderr.write('1.2.3\\nextra\\n');\n");
  assert.equal(await binVersion(process.execPath, script), "1.2.3");
});

test("shellQuoteForDisplay leaves safe argv alone and quotes the rest", () => {
  assert.equal(shellQuoteForDisplay("--max-amount"), "--max-amount");
  assert.equal(shellQuoteForDisplay("https://api.x/v1"), "https://api.x/v1");
  assert.equal(shellQuoteForDisplay("two words"), "'two words'");
  assert.equal(shellQuoteForDisplay("https://api.x/v1?q=1"), "'https://api.x/v1?q=1'", "a query string needs quoting");
  assert.equal(shellQuoteForDisplay("it's"), `'it'\\''s'`);
  assert.equal(shellQuoteForDisplay(""), "''");
});
