// --payable-now: `selat run`'s "no runnable selat-pay command" error told the
// user to "Try --payable-now", but the parser rejected that flag as unknown and
// the rank.mjs spawn never carried it — so following the advice dead-ended.
// Seam tests pin the parse, the rank.mjs argv, the help text, and the hint so
// the flag the error recommends is the flag the spawn actually forwards.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { closedEnv } from "./helpers/closed-env.mjs";

import {
  parseRunArgs,
  rankPickArgv,
  payableNowArgs,
  noRunnableHintLine,
  KNOWN_RUN_FLAGS,
} from "../lib/commands/run.mjs";

test("--payable-now is a known flag and parses as a boolean, not intent", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--payable-now"));
  const parsed = parseRunArgs(["search recent papers", "--payable-now"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payableNow, true);
  assert.equal(parsed.intent, "search recent papers");
  // Position-independent, and never swallows a following token as a value.
  const leading = parseRunArgs(["--payable-now", "search", "recent", "papers", "--dry-run"]);
  assert.equal(leading.payableNow, true);
  assert.equal(leading.dryRun, true);
  assert.equal(leading.intent, "search recent papers");
});

test("--payable-now defaults off", () => {
  const parsed = parseRunArgs(["search recent papers"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payableNow, false);
});

test("payableNowArgs forwards the flag only when set", () => {
  assert.deepEqual(payableNowArgs({}), []);
  assert.deepEqual(payableNowArgs({ payableNow: false }), []);
  assert.deepEqual(payableNowArgs({ payableNow: true }), ["--payable-now"]);
});

test("rankPickArgv forwards --payable-now to rank.mjs", () => {
  assert.deepEqual(
    rankPickArgv({ intent: "search recent papers", payableNow: true }),
    ["search recent papers", "--pick", "--payable-now"],
  );
  // Absent by default: broad, rail-agnostic ranking stays the default argv.
  assert.deepEqual(rankPickArgv({ intent: "search recent papers" }), ["search recent papers", "--pick"]);
});

test("rankPickArgv keeps --payable-now alongside a pin and --capability", () => {
  assert.deepEqual(
    rankPickArgv({
      intent: "x",
      liveProbe: true,
      endpoint: "https://a.example/x",
      method: "POST",
      capability: "web.search",
      payableNow: true,
    }),
    ["x", "--pick", "--live-probe", "--endpoint", "https://a.example/x", "--method", "POST", "--capability", "web.search", "--payable-now"],
  );
});

test("the no-runnable-command hint recommends a flag run accepts, once", () => {
  const first = noRunnableHintLine({ payableNow: false });
  assert.match(first, /--payable-now/);
  // Whatever the hint names must survive parseRunArgs, or the advice dead-ends.
  const flags = first.match(/--[a-z-]+/g) ?? [];
  assert.ok(flags.length > 0);
  for (const flag of flags) assert.ok(KNOWN_RUN_FLAGS.includes(flag), `hint names unknown flag ${flag}`);
  // Already applied: don't tell the user to pass it again.
  const again = noRunnableHintLine({ payableNow: true });
  assert.doesNotMatch(again, /Try --payable-now/);
  assert.match(again, /live 402/);
});

test("selat run --help lists --payable-now", async () => {
  const run = promisify(execFile);
  const r = await run(process.execPath, ["bin/selat.mjs", "run", "--help"], { env: closedEnv() });
  assert.match(r.stdout, /--payable-now/);
  assert.match(r.stdout, /routable via selat-pay/);
});

// End to end through bin/selat.mjs against a fake discovery skill whose
// rank.mjs records its argv: the retry the hint recommends must reach the
// ranker carrying --payable-now, and nothing is ever paid (--dry-run, fake
// selat-pay, no session budget).
function fakeSkill({ runnable }) {
  const dir = mkdtempSync(join(tmpdir(), "selat-payable-now-"));
  mkdirSync(join(dir, "skill", "scripts"), { recursive: true });
  const argvFile = join(dir, "argv.jsonl");
  writeFileSync(argvFile, "");
  const pick = runnable
    ? { service: { name: "Example API" }, minAmountUsd: 0.01, exec_hints: [{ argv: ["selat-pay", "GET", "https://api.example/v1", "--max-amount", "0.05", "--chain", "base"] }] }
    : { service: { name: "Unroutable API" }, minAmountUsd: 0.01, exec_hints: [] };
  writeFileSync(join(dir, "skill", "scripts", "rank.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.SELAT_TEST_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `process.stdout.write(${JSON.stringify(JSON.stringify(pick))});`,
  ].join("\n"));
  const fakePay = join(dir, "fake-selat-pay.mjs");
  writeFileSync(fakePay, "process.stdout.write('{}');\n");
  const env = closedEnv({
    SELAT_SKILL_PATH: join(dir, "skill"),
    SELAT_TEST_ARGV_FILE: argvFile,
    SELAT_PAY_BIN: fakePay,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    XDG_STATE_HOME: join(dir, "xdg-state"),
  });
  const calls = () => readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { env, calls };
}

test("selat run --payable-now --dry-run forwards the flag to rank.mjs and pays nothing", async () => {
  const run = promisify(execFile);
  const { env, calls } = fakeSkill({ runnable: true });
  const r = await run(process.execPath, ["bin/selat.mjs", "run", "--json", "--dry-run", "--payable-now", "search recent papers"], { env }).catch((e) => e);
  assert.equal(r.code ?? 0, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, r.stdout);
  assert.deepEqual(calls(), [["search recent papers", "--pick", "--payable-now"]]);
});

test("the no-runnable-command error names --payable-now, and that retry reaches rank.mjs", async () => {
  const run = promisify(execFile);
  const { env, calls } = fakeSkill({ runnable: false });
  const first = await run(process.execPath, ["bin/selat.mjs", "run", "--dry-run", "search recent papers"], { env }).catch((e) => e);
  assert.equal(first.code, 1);
  assert.match(first.stderr, /no runnable selat-pay command/);
  assert.match(first.stderr, /Try --payable-now/);
  assert.deepEqual(calls(), [["search recent papers", "--pick"]]);
  // Following the advice must not hit "unknown flag": the flag is forwarded.
  const retry = await run(process.execPath, ["bin/selat.mjs", "run", "--dry-run", "search recent papers", "--payable-now"], { env }).catch((e) => e);
  assert.doesNotMatch(retry.stderr, /unknown flag/);
  assert.deepEqual(calls()[1], ["search recent papers", "--pick", "--payable-now"]);
  // The fake still yields nothing runnable, so the hint no longer repeats itself.
  assert.doesNotMatch(retry.stderr, /Try --payable-now/);
  assert.match(retry.stderr, /--payable-now was already applied/);
});

// --json contract: this refusal used to print prose to stderr with an empty
// stdout, which JSON.parse("") turns into a crash at a machine caller. It now
// goes through the same {ok:false, error} stdout path as every other failure,
// carrying the retry advice as data.
test("no-runnable-command under --json is a parseable refusal on stdout with the hint as data", async () => {
  const run = promisify(execFile);
  const { env, calls } = fakeSkill({ runnable: false });
  const first = await run(process.execPath, ["bin/selat.mjs", "run", "--json", "--dry-run", "search recent papers"], { env }).catch((e) => e);
  assert.equal(first.code, 1);
  const out = JSON.parse(first.stdout.trim());
  assert.equal(out.ok, false);
  assert.match(out.error, /no runnable selat-pay command/);
  assert.equal(out.reason, "no-runnable-command");
  assert.equal(out.payableNow, false);
  assert.match(out.hint, /--payable-now/);
  assert.equal(out.detail, "missing exec_hints[0]");
  assert.deepEqual(calls(), [["search recent papers", "--pick"]]);

  const retry = await run(process.execPath, ["bin/selat.mjs", "run", "--json", "--dry-run", "--payable-now", "search recent papers"], { env }).catch((e) => e);
  assert.equal(retry.code, 1);
  const again = JSON.parse(retry.stdout.trim());
  assert.equal(again.ok, false);
  assert.equal(again.reason, "no-runnable-command");
  assert.equal(again.payableNow, true);
  assert.doesNotMatch(again.hint, /Try --payable-now/);
  assert.deepEqual(calls()[1], ["search recent papers", "--pick", "--payable-now"]);
});
