import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHarnessPath, sandboxHintText } from "../lib/host.mjs";

// ensureHarnessPath() symlinks `selat` onto PATH for harnesses that don't persist
// the SessionStart hook's env (OpenClaw: ~/.openclaw/bin). It must be a no-op when
// the harness marker is absent, create a correct symlink when present, and be
// idempotent + fail-safe. We drive it against a temp HOME + a fake runner binary.
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "selat-host-"));
  const self = join(home, "runner-selat");
  writeFileSync(self, "#!/bin/sh\n");
  const prevHome = process.env.HOME;
  const prevArgv1 = process.argv[1];
  process.env.HOME = home;
  process.argv[1] = self;
  try {
    return fn({ home, self });
  } finally {
    process.env.HOME = prevHome;
    process.argv[1] = prevArgv1;
  }
}

test("ensureHarnessPath: no-op when ~/.openclaw is absent", () => {
  withHome(({ home }) => {
    ensureHarnessPath();
    assert.equal(existsSync(join(home, ".openclaw", "bin", "selat")), false);
  });
});

test("ensureHarnessPath: links selat into ~/.openclaw/bin when present", () => {
  withHome(({ home, self }) => {
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    ensureHarnessPath();
    const link = join(home, ".openclaw", "bin", "selat");
    assert.ok(lstatSync(link).isSymbolicLink(), "should be a symlink");
    assert.equal(realpathSync(link), realpathSync(self), "should point at the runner");
  });
});

test("ensureHarnessPath: idempotent across repeated calls", () => {
  withHome(({ home, self }) => {
    mkdirSync(join(home, ".openclaw"), { recursive: true });
    ensureHarnessPath();
    ensureHarnessPath();
    ensureHarnessPath();
    const link = join(home, ".openclaw", "bin", "selat");
    assert.equal(realpathSync(link), realpathSync(self));
  });
});

test("ensureHarnessPath: replaces a stale (wrong-target) selat link", () => {
  withHome(({ home, self }) => {
    const binDir = join(home, ".openclaw", "bin");
    mkdirSync(binDir, { recursive: true });
    const stale = join(home, "old-runner");
    writeFileSync(stale, "#!/bin/sh\n");
    symlinkSync(stale, join(binDir, "selat"));
    ensureHarnessPath();
    assert.equal(realpathSync(join(binDir, "selat")), realpathSync(self));
  });
});

test("sandboxHintText: names the catalog hosts and a deny-default allowlist", () => {
  const t = sandboxHintText();
  assert.match(t, /api\.circle\.com/);
  assert.match(t, /\*\.selat\.ai/);
  assert.match(t, /sandbox\.json/);
  assert.match(t, /"default": "deny"/);
});
