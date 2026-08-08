import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sh, shSafe, signalExitCode } from "../lib/sh.mjs";
import { errorChain } from "../lib/debug.mjs";
import { sessionSpentDetailed, readSessionConfig } from "../lib/commands/budget.mjs";
import { listSkillsDetailed, resolveSkill } from "../lib/skill-registry.mjs";

// Failures that used to be flattened into 0 / null / "not installed". Each case
// below is a state a user could not previously distinguish from success.

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("a child killed by a signal reports a failing exit code, not 0", async () => {
  const res = await sh(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(res.signal, "SIGKILL");
  assert.notEqual(res.code, 0, "a SIGKILLed payment process must not look successful");
  assert.equal(res.code, signalExitCode("SIGKILL"));
});

test("shSafe reports a spawn failure as a result with the reason, not a rejection", async () => {
  const res = await shSafe(join(tmpdir(), "selat-nonexistent-binary-xyz"), ["--version"]);
  assert.equal(res.code, null, "code null distinguishes 'never ran' from 'ran and failed'");
  assert.match(res.stderr, /ENOENT/);
  assert.ok(res.spawnError instanceof Error);
});

test("readConfig names the path and keeps the cause when the config is unreadable", async () => {
  const home = tmp("selat-cli-cfg-");
  // A directory where the .env file belongs: present, but not readable as a file.
  mkdirSync(join(home, "selat-pay", ".env"), { recursive: true });
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  try {
    const { readConfig } = await import("../lib/config.mjs");
    const err = await readConfig().then(() => null, (e) => e);
    assert.ok(err, "an unreadable config must not be reported as 'not configured yet'");
    assert.match(err.message, /could not read/);
    assert.match(errorChain(err), /EISDIR/);
  } finally {
    if (old == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});

test("session spend flags an unreadable ledger instead of reporting $0 spent", () => {
  const dir = tmp("selat-cli-ledger-");
  const asDir = join(dir, "ledger.jsonl");
  mkdirSync(asDir);

  const unreadable = sessionSpentDetailed("t1", { path: asDir });
  assert.deepEqual(
    { spent: unreadable.spent, unreadable: unreadable.unreadable },
    { spent: 0, unreadable: true }
  );

  // Absent ledger = nothing paid yet: a true zero, not a read failure.
  const absent = sessionSpentDetailed("t1", { path: join(dir, "nope.jsonl") });
  assert.deepEqual(absent, { spent: 0, unreadable: false, skipped: 0, error: null });
});

test("session spend counts the ledger lines it had to skip", () => {
  const dir = tmp("selat-cli-ledger-");
  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, [
    JSON.stringify({ sessionId: "t1", amountUsd: 0.01 }),
    "{not json",
    JSON.stringify({ sessionId: "t1", amountUsd: 0.02 }),
    ""
  ].join("\n"));

  const r = sessionSpentDetailed("t1", { path: ledger });
  assert.equal(r.skipped, 1, "a truncated ledger line understates spend — say how many");
  assert.ok(Math.abs(r.spent - 0.03) < 1e-9);
});

test("a malformed session budget file is reported, not silently treated as armed", () => {
  const dir = tmp("selat-cli-session-");
  const f = join(dir, "session.json");
  writeFileSync(f, "{oops");
  const warnings = [];
  const original = console.error;
  console.error = (msg) => warnings.push(String(msg));
  try {
    assert.equal(readSessionConfig({ env: {}, filePath: f }), null);
  } finally {
    console.error = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not valid JSON/);
});

test("an installed-but-unloadable skill is surfaced, not reported as not installed", async () => {
  const xdg = tmp("selat-cli-skills-");
  const dir = join(xdg, "selat", "skills", "broken-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{not json");

  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldDev = process.env.SELAT_SKILLS_DIR;
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.SELAT_SKILLS_DIR;
  try {
    const { skills, broken } = await listSkillsDetailed();
    assert.equal(skills.length, 0);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].name, "broken-skill");
    assert.match(broken[0].error, /invalid JSON/);

    await assert.rejects(() => resolveSkill("broken-skill"), /installed at .*but could not be loaded/);
    assert.equal(await resolveSkill("never-installed"), null);
  } finally {
    if (oldXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldDev != null) process.env.SELAT_SKILLS_DIR = oldDev;
  }
});

test("errorChain unwraps a wrapped cause so the real reason survives", () => {
  const err = new Error("could not read /x/.env", { cause: new Error("EACCES: permission denied") });
  assert.equal(errorChain(err), "could not read /x/.env: EACCES: permission denied");
  assert.equal(errorChain("plain string"), "plain string");
});
