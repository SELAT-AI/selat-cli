import { mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Environment for tests that spawn `bin/selat.mjs`.
 *
 * The CLI shells out (`circle`, `npm`, `node`, `selat-pay`, …). A test that
 * inherits the host PATH lets every fixture gap fall through to the real
 * binary — which is how a fake `circle` with no `--version` once ran a real
 * `npm install -g @circle-fin/cli@latest` on a developer machine.
 *
 * So PATH here is: the fixture dirs the test hands over, then ONE private
 * tools dir holding symlinks to exactly `node` (the CLI spawns it for the
 * skill and selat-pay), `sh`, `bash` and `env` (fixture shebangs). Nothing
 * else resolves — not `npm`, not the real `circle` — even on nvm installs,
 * where node's own bin dir would otherwise bring the whole global tree along.
 */
let toolsDir;
function tools() {
  if (toolsDir) return toolsDir;
  toolsDir = mkdtempSync(join(tmpdir(), "selat-test-tools-"));
  const links = {
    node: process.execPath,
    sh: "/bin/sh",
    bash: "/bin/bash",
    env: "/usr/bin/env",
  };
  for (const [name, target] of Object.entries(links)) {
    if (existsSync(target)) symlinkSync(target, join(toolsDir, name));
  }
  return toolsDir;
}

export function closedPath(...bins) {
  return [...bins, tools()].join(delimiter);
}

export function closedEnv(overrides = {}, { bins = [] } = {}) {
  return {
    ...process.env,
    PATH: closedPath(...bins),
    // Never let a spawned CLI install anything, whatever PATH says.
    SELAT_NO_INSTALL: "1",
    ...overrides,
  };
}
