import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closedEnv } from "./helpers/closed-env.mjs";

// `selat init` installs the Circle CLI when it's missing and upgrades it when
// it's below MIN_CIRCLE_CLI_VERSION — automatically, no prompt or flag. These
// run under a closed PATH with a fake npm, and ensureCircle refuses under
// NODE_TEST_CONTEXT, so the attempt is observable but can never reach the
// host: "Installing/Upgrading …" followed by the guard's refusal.

const pexec = promisify(execFile);
const selatBin = new URL("../bin/selat.mjs", import.meta.url).pathname;

async function fixture({ circleVersion }) {
  const root = await mkdtemp(join(tmpdir(), "selat-init-autoinstall-"));
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  if (circleVersion !== null) {
    await writeFile(join(binDir, "circle"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${circleVersion}; exit 0; }\necho "unexpected circle $*" >&2; exit 2\n`);
    await chmod(join(binDir, "circle"), 0o755);
  }
  await writeFile(join(binDir, "npm"), `#!/bin/sh\necho "FAKE-NPM $*" >&2; exit 97\n`);
  await chmod(join(binDir, "npm"), 0o755);
  return binDir;
}

async function runInit(binDir) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [selatBin, "init"], {
      input: "",
      env: closedEnv({ XDG_CONFIG_HOME: join(binDir, "..", "xdg"), NO_COLOR: "1", SELAT_NO_INSTALL: "" }, { bins: [binDir] }),
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

test("missing Circle CLI: init attempts the install without asking", async () => {
  const r = await runInit(await fixture({ circleVersion: null }));
  assert.match(r.out, /Circle CLI not found — installing @circle-fin\/cli@latest/);
  assert.match(r.out, /installs are disabled/, "guard, not npm, stopped it");
  assert.doesNotMatch(r.out, /FAKE-NPM/);
  assert.equal(r.code, 1);
});

test("old Circle CLI: init attempts the upgrade without asking", async () => {
  const r = await runInit(await fixture({ circleVersion: "1.0.0" }));
  assert.match(r.out, /1\.0\.0 is below the 1\.1\.1 floor — upgrading @circle-fin\/cli@latest/);
  assert.match(r.out, /installs are disabled/);
  assert.doesNotMatch(r.out, /FAKE-NPM/);
});

test("current Circle CLI: init leaves it alone", async () => {
  const r = await runInit(await fixture({ circleVersion: "1.1.1" }));
  assert.match(r.out, /Circle CLI 1\.1\.1 on PATH/);
  assert.doesNotMatch(r.out, /installing|upgrading|installs are disabled|FAKE-NPM/);
});
