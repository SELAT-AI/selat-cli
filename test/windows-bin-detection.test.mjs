import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasBin, isWindows } from "../lib/sh.mjs";

// Windows support: `command -v` and `which` do not exist on Windows, so the
// previous hasBin() returned false for every binary there — including a Circle
// CLI that was installed and answering `circle --version`. That single false
// negative produced the "Circle CLI not found" wall at `selat init` step 3/8,
// and no amount of reinstalling could clear it.
//
// These tests pin the platform-independent contract. The cmd.exe path itself
// cannot be exercised from POSIX CI; what is pinned here is that the POSIX
// behaviour did not regress and that the explicit-path branch (the CIRCLE_BIN
// escape hatch) resolves without shelling out to a POSIX-only tool.

const dir = mkdtempSync(join(tmpdir(), "selat-hasbin-"));

test("isWindows reflects the host platform", () => {
  assert.equal(isWindows, process.platform === "win32");
});

test("a binary on PATH is detected", async () => {
  assert.equal(await hasBin("node"), true);
});

test("a binary absent from PATH is not detected", async () => {
  assert.equal(await hasBin("selat-definitely-not-a-real-binary-xyz"), false);
});

test("an explicit path is resolved on the filesystem, not via PATH", async () => {
  // CIRCLE_BIN is documented as the escape hatch when the shim is off PATH.
  // Neither `where` nor `command -v` resolves a path, so this must not shell out.
  const real = join(dir, "circle-shim");
  writeFileSync(real, "#!/bin/sh\nexit 0\n");
  assert.equal(await hasBin(real), true);
  assert.equal(await hasBin(join(dir, "not-here")), false);
});

test("a Windows-style path is treated as a path on any platform", async () => {
  // Must take the filesystem branch rather than being passed to `command -v`,
  // which would report a spurious true/false depending on the shell.
  assert.equal(await hasBin("C:\\Program Files\\npm\\circle.cmd"), false);
});

test("an empty name is not reported as present", async () => {
  assert.equal(await hasBin(""), false);
});

test("an explicit path to a DIRECTORY is not a binary", async () => {
  // existsSync alone answered true here (e.g. CIRCLE_BIN pointing at the
  // install folder instead of the binary inside it); the check must require a
  // regular file so the failure surfaces at doctor/detection time, not as a
  // confusing EACCES/EISDIR at spawn time.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "hasbin-dir-"));
  assert.equal(await hasBin(dir), false);
});
