import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const selatBin = fileURLToPath(new URL("../bin/selat.mjs", import.meta.url));

// `selat fund --help` fell through to the interactive deposit flow (it began
// prompting toward a real Gateway deposit) — the same defect class #101 fixed
// for setup-policy. Help must be inert: print usage, exit 0, no prompts, no
// skill lookup, no deposit.

async function run(args) {
  try {
    const { stdout, stderr } = await pexec("node", [selatBin, ...args], { input: "" });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("fund --help prints usage and exits 0 without entering the deposit flow", async () => {
  const { code, stdout, stderr } = await run(["fund", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: selat fund/);
  assert.match(stdout, /Never prompts, never deposits/);
  // The deposit flow was never entered: its non-TTY error string only appears
  // when fund reaches the amount prompt. (Help text mentions deposits by design,
  // so assert on flow-only strings, not on the word "deposit".)
  assert.doesNotMatch(stdout + stderr, /no TTY to prompt for the deposit/);
});

test("fund -h behaves identically", async () => {
  const { code, stdout } = await run(["fund", "-h"]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage: selat fund/);
});

test("bare fund (no --help) does NOT print help — still enters its own flow", async () => {
  const { stdout, stderr } = await run(["fund"]);
  assert.doesNotMatch(stdout, /Usage: selat fund/);
  // non-TTY stdin: it reaches the deposit-input path and errors there, proving
  // the help guard didn't swallow the real command.
  assert.match(stdout + stderr, /--amount|not found|no TTY/);
});
