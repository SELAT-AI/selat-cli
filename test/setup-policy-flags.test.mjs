import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSetupPolicyArgs,
  capValueError,
  setupPolicy,
  SETUP_POLICY_HELP,
} from "../lib/commands/setup-policy.mjs";

// setup-policy was prompt-only (unusable in any agent harness: the non-TTY
// throw suggested "pass the value via a flag" when no flag existed) and had
// no --help guard — on a TTY, four Enter presses after `--help` wrote a real
// spending policy. These pin the fixed contract.

const capture = () => {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => Object.assign(console, orig) };
};

test("cap flags parse in both --flag value and --flag=value forms", () => {
  const p = parseSetupPolicyArgs(["--per-tx", "5", "--daily=50", "--weekly", "200", "--monthly=500"]);
  assert.deepEqual(p.caps, { perTx: "5", daily: "50", weekly: "200", monthly: "500" });
  assert.equal(p.help, false);
  assert.deepEqual(p.unknown, []);
});

test("capValueError accepts positive numbers, rejects the rest", () => {
  assert.equal(capValueError("--per-tx", "5"), null);
  assert.equal(capValueError("--per-tx", "0.5"), null);
  assert.match(capValueError("--per-tx", "0"), /positive/);
  assert.match(capValueError("--per-tx", "-3"), /positive/);
  assert.match(capValueError("--per-tx", "five"), /positive/);
  assert.match(capValueError("--per-tx", undefined), /needs a value/);
  assert.match(capValueError("--per-tx", "--daily"), /needs a value/);
});

test("--help is inert: prints usage, exits 0, spawns nothing, prompts nothing", async () => {
  const c = capture();
  try {
    const code = await setupPolicy(["--help"]);
    assert.equal(code, 0);
    assert.ok(c.lines.join("\n").includes("Never prompts, never writes"));
  } finally { c.restore(); }
});

test("an unknown flag errors with usage instead of falling through to prompts", async () => {
  const c = capture();
  try {
    const code = await setupPolicy(["--jsn"]);
    assert.equal(code, 1);
    assert.ok(c.lines.some((l) => l.includes("unknown option: --jsn")));
  } finally { c.restore(); }
});

test("a bad cap value fails before any wallet or network activity", async () => {
  const c = capture();
  try {
    const code = await setupPolicy(["--per-tx", "zero"]);
    assert.equal(code, 1);
    assert.ok(c.lines.some((l) => l.includes("--per-tx must be a positive number")));
  } finally { c.restore(); }
});

test("non-TTY fails fast with a paste-ready command carrying the given caps", async () => {
  // The test runner has no TTY on stdin, which is exactly the harness case.
  assert.equal(process.stdin.isTTY, undefined);
  const c = capture();
  try {
    const code = await setupPolicy(["--per-tx", "2", "--daily", "10"]);
    assert.equal(code, 1);
    const joined = c.lines.join("\n");
    assert.ok(joined.includes("needs an interactive terminal"));
    assert.ok(joined.includes("selat setup-policy --per-tx 2 --daily 10 --weekly 200 --monthly 500"));
  } finally { c.restore(); }
});

test("help text documents every cap flag", () => {
  for (const f of ["--per-tx", "--daily", "--weekly", "--monthly", "--chain"]) {
    assert.ok(SETUP_POLICY_HELP.includes(f), f);
  }
});
