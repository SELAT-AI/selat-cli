import test from "node:test";
import assert from "node:assert/strict";

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { history } from "../lib/commands/history.mjs";
import { search } from "../lib/commands/search.mjs";
import { spend } from "../lib/commands/spend.mjs";

// history / spend / search are thin wrappers: they resolve the discovery skill,
// translate flags, and return the child's exit code. What can break silently is
// the argv they hand the skill's script (wrong wallet, wrong limit, an intent
// polluted by a flag value) and the exit code they propagate — so the fake skill
// below records its argv and exits with a code we choose.

/**
 * A stand-in discovery skill. Each script dumps its argv to
 * $SELAT_TEST_ARGV_FILE and exits with $SELAT_TEST_EXIT_CODE.
 */
function fakeSkillDir(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "selat-cmd-"));
  mkdirSync(join(dir, "scripts"));
  for (const name of scripts) {
    writeFileSync(
      join(dir, "scripts", name),
      [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.SELAT_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "process.exit(Number(process.env.SELAT_TEST_EXIT_CODE ?? 0));"
      ].join("\n"),
      "utf8"
    );
  }
  return dir;
}

/** Run `fn` against a fake skill + isolated config, capturing the skill's argv. */
async function withFakeSkill(scripts, fn, { exitCode = 0, config = null } = {}) {
  const dir = fakeSkillDir(scripts);
  const argvFile = join(dir, "argv.jsonl");
  writeFileSync(argvFile, "");
  const xdg = mkdtempSync(join(tmpdir(), "selat-cmd-cfg-"));
  if (config) {
    mkdirSync(join(xdg, "selat-pay"), { recursive: true });
    writeFileSync(join(xdg, "selat-pay", ".env"), config, "utf8");
  }
  const prev = { ...process.env };
  process.env.SELAT_SKILL_PATH = dir;
  process.env.SELAT_TEST_ARGV_FILE = argvFile;
  process.env.SELAT_TEST_EXIT_CODE = String(exitCode);
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const code = await fn();
    const calls = readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { code, calls, dir };
  } finally {
    for (const key of ["SELAT_SKILL_PATH", "SELAT_TEST_ARGV_FILE", "SELAT_TEST_EXIT_CODE", "XDG_CONFIG_HOME"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

/** Point the skill lookup at an empty dir so the "not installed" path is taken. */
async function withoutSkill(fn) {
  const prev = process.env.SELAT_SKILL_PATH;
  process.env.SELAT_SKILL_PATH = join(tmpdir(), "selat-no-such-skill");
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SELAT_SKILL_PATH;
    else process.env.SELAT_SKILL_PATH = prev;
  }
}

/** Swallow the commands' own console output so test output stays readable. */
function quiet(t) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
}

// ── selat history ───────────────────────────────────────────────────────────

test("history --help exits 0 without touching the skill", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["setup.mjs"], () => history(["--help"]));
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
  assert.equal(await withFakeSkill(["setup.mjs"], () => history(["-h"])).then((r) => r.code), 0);
});

test("history forwards address, limit, chain and --json to the skill reader", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["setup.mjs"], () =>
    history(["--address", "0xabc", "--limit", "5", "--chain", "base", "--json"])
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "gateway-history",
    "--address", "0xabc",
    "--limit", "5",
    "--chain", "base",
    "--json"
  ]);
});

test("history defaults the limit and falls back to the configured wallet", async (t) => {
  quiet(t);
  const { calls } = await withFakeSkill(
    ["setup.mjs"],
    () => history([]),
    { config: "SELAT_AGENT_WALLET_ADDRESS=0xfromconfig\n" }
  );
  assert.deepEqual(calls[0], ["gateway-history", "--address", "0xfromconfig", "--limit", "20"]);
});

test("history propagates the reader's exit code", async (t) => {
  quiet(t);
  const { code } = await withFakeSkill(
    ["setup.mjs"],
    () => history(["--address", "0xabc"]),
    { exitCode: 7 }
  );
  assert.equal(code, 7);
});

test("history fails with guidance when no wallet is configured", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["setup.mjs"], () => history([]));
  assert.equal(code, 1);
  assert.deepEqual(calls, [], "nothing runs without an address");
});

test("history rejects bad flags before spawning anything", async (t) => {
  quiet(t);
  for (const args of [
    ["--nope"],
    ["--address"],
    ["--address", "--json"],
    ["--limit", "0"],
    ["--limit", "abc"],
    ["0xabc"]
  ]) {
    const { code, calls } = await withFakeSkill(["setup.mjs"], () => history(args));
    assert.equal(code, 1, `${args.join(" ")} should be rejected`);
    assert.deepEqual(calls, []);
  }
});

test("history reports a missing discovery skill instead of spawning node", async (t) => {
  quiet(t);
  assert.equal(await withoutSkill(() => history(["--address", "0xabc"])), 1);
});

// ── selat spend ─────────────────────────────────────────────────────────────

test("spend passes its flags straight through to spend_report.mjs", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["spend_report.mjs"], () =>
    spend(["--json", "--wallet", "0xabc"])
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["--json", "--wallet", "0xabc"]);
});

test("spend defaults to no flags and propagates the report's exit code", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["spend_report.mjs"], () => spend(), { exitCode: 2 });
  assert.equal(code, 2);
  assert.deepEqual(calls[0], []);
});

test("spend reports a missing spend report rather than failing obscurely", async (t) => {
  quiet(t);
  assert.equal(await withoutSkill(() => spend()), 1);
});

// ── selat search ────────────────────────────────────────────────────────────

test("search --help exits 0 without ranking", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["rank.mjs"], () => search(["--help"]));
  assert.equal(code, 0);
  assert.deepEqual(calls, []);
});

test("search requires an intent", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["rank.mjs"], () => search([]));
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

test("search builds the intent from words only, skipping a flag's value", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["rank.mjs"], () =>
    search(["people", "enrichment", "--top", "3", "--refresh", "--explain"])
  );
  assert.equal(code, 0);
  assert.deepEqual(calls[0], ["people enrichment", "--top", "3", "--refresh", "--explain-payability"]);
  assert.deepEqual(
    calls[1],
    ["people enrichment", "--pick"],
    "the probe-next-step footer asks for a plan; --pick alone never settles"
  );
});

test("search --json forwards the ranker's JSON verbatim and skips the footer", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(["rank.mjs"], () => search(["gold prices", "--json"]));
  assert.equal(code, 0);
  assert.deepEqual(calls, [["gold prices", "--json"]], "no second --pick call in machine mode");
});

test("search propagates a ranker failure without asking for a plan", async (t) => {
  quiet(t);
  const { code, calls } = await withFakeSkill(
    ["rank.mjs"],
    () => search(["gold prices", "--json"]),
    { exitCode: 4 }
  );
  assert.equal(code, 4);
  assert.deepEqual(calls, [["gold prices", "--json"]]);
});

test("search reports a missing discovery skill", async (t) => {
  quiet(t);
  assert.equal(await withoutSkill(() => search(["gold prices"])), 1);
});

test("skill compare hard-errors on unknown flags instead of silently dropping them", async () => {
  // A typo'd --max-ammount used to be silently dropped: the $0.05 cap was
  // discarded (falling back to the $1/candidate ceiling), --yes suppressed
  // the confirm, and "0.05" polluted the ranking intent. With --pay that's
  // paying against a cap the user never set.
  const { skill } = await import("../lib/commands/skill.mjs");
  const code = await skill(["compare", "an intent", "--max-ammount", "0.05", "--pay", "--yes"]);
  assert.equal(code, 1);
});

test("skill run: firstPositional resolves the name past leading flags, incl. bare --raw-key", async () => {
  // Regression guard: firstPositional accepts flags before the name, but the
  // flag loop used to slice args[0] — dropping a leading flag (a lost
  // --max-amount ran under the manifest ceiling). raw-key must be bare here or
  // it consumes the name as its value.
  const { firstPositional } = await import("../lib/commands/skill.mjs");
  assert.equal(firstPositional(["--max-amount", "0.05", "my-skill"]), "my-skill");
  assert.equal(firstPositional(["--json", "my-skill"]), "my-skill");
  assert.equal(firstPositional(["--raw-key", "my-skill"]), "my-skill");
  assert.equal(firstPositional(["my-skill", "--json"]), "my-skill");
});
