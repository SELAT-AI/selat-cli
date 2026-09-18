import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closedEnv } from "./helpers/closed-env.mjs";

// `selat init` may install/upgrade the Circle CLI (a global npm install — a
// host change) only with consent: a TTY prompt, or --install-circle-cli.
// Without a TTY and without the flag it must refuse and print the command.
// Every run here is under a closed PATH with a fake npm, so nothing can
// actually install even if the gate were wrong.

const pexec = promisify(execFile);
const selatBin = new URL("../bin/selat.mjs", import.meta.url).pathname;

async function fixture({ circleVersion }) {
  const root = await mkdtemp(join(tmpdir(), "selat-init-consent-"));
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  if (circleVersion !== null) {
    await writeFile(join(binDir, "circle"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${circleVersion}; exit 0; }\necho "unexpected circle $*" >&2; exit 2\n`);
    await chmod(join(binDir, "circle"), 0o755);
  }
  await writeFile(join(binDir, "npm"), `#!/bin/sh\necho "FAKE-NPM $*" >&2; exit 97\n`);
  await chmod(join(binDir, "npm"), 0o755);
  return { root, binDir };
}

async function runInit(binDir, args, extraEnv = {}) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [selatBin, "init", ...args], {
      input: "",
      env: closedEnv({ XDG_CONFIG_HOME: join(binDir, "..", "xdg"), NO_COLOR: "1", SELAT_NO_INSTALL: "", ...extraEnv }, { bins: [binDir] }),
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

test("non-TTY, no flag: refuses to install a missing Circle CLI and prints the command", async () => {
  const { binDir } = await fixture({ circleVersion: null });
  const r = await runInit(binDir, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /Circle CLI not found/);
  assert.match(r.out, /npm install -g @circle-fin\/cli@latest/);
  assert.match(r.out, /--install-circle-cli/);
  assert.doesNotMatch(r.out, /FAKE-NPM/, "npm must not have been invoked");
});

test("non-TTY, no flag: refuses to upgrade an old Circle CLI", async () => {
  const { binDir } = await fixture({ circleVersion: "1.0.0" });
  const r = await runInit(binDir, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /1\.0\.0 is below the 1\.1\.1 floor/);
  assert.doesNotMatch(r.out, /FAKE-NPM/);
});

test("--install-circle-cli is consent: init attempts the install", async () => {
  const { binDir } = await fixture({ circleVersion: "1.0.0" });
  const r = await runInit(binDir, ["--install-circle-cli"]);
  // Consent gets init past the gate to ensureCircle — which then refuses
  // because NODE_TEST_CONTEXT is inherited from this runner (layer 1). So the
  // observable proof of consent is "Upgrading…" followed by that refusal,
  // and the fake npm (layer 2) is never reached.
  assert.match(r.out, /Upgrading @circle-fin\/cli@latest/);
  assert.match(r.out, /installs are disabled/);
  assert.doesNotMatch(r.out, /FAKE-NPM/);
  assert.equal(r.code, 1);
});

test("an up-to-date Circle CLI is never touched, flag or not", async () => {
  const { binDir } = await fixture({ circleVersion: "1.1.1" });
  const r = await runInit(binDir, ["--install-circle-cli"]);
  assert.match(r.out, /Circle CLI 1\.1\.1 on PATH/);
  assert.doesNotMatch(r.out, /FAKE-NPM/);
});
