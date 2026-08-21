import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  AGENT_HARNESS_ENV_KEYS,
  ALLOW_HIGH_MAX_AMOUNT_FLAG,
  APIFY_PREPAID_TOKEN_USD,
  HARD_CLI_MAX_AMOUNT_USD,
  RAISED_CLI_MAX_AMOUNT_USD,
  allowedMaxAmountCeiling,
  authorizeExplicitMaxAmount,
  confirmHighMaxAmount,
  inAgentHarness,
} from "../lib/spend-guard.mjs";
import {
  applyRunMaxAmountCeiling,
  authorizeRunMaxAmount,
  DEFAULT_RUN_MAX_AMOUNT_USD,
  KNOWN_RUN_FLAGS,
} from "../lib/commands/run.mjs";
import { missingSessionBudget, readSessionConfig } from "../lib/commands/budget.mjs";

const pexec = promisify(execFile);
const SELAT_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "selat.mjs");

test("hard CLI ceiling is $1 for everyone; Apify token is $1.05; raise export aliases $1", () => {
  assert.equal(HARD_CLI_MAX_AMOUNT_USD, 1);
  assert.equal(DEFAULT_RUN_MAX_AMOUNT_USD, 1);
  assert.equal(RAISED_CLI_MAX_AMOUNT_USD, HARD_CLI_MAX_AMOUNT_USD);
  assert.equal(APIFY_PREPAID_TOKEN_USD, 1.05);
  assert.equal(ALLOW_HIGH_MAX_AMOUNT_FLAG, "--allow-high-max-amount");
  assert.ok(KNOWN_RUN_FLAGS.includes(ALLOW_HIGH_MAX_AMOUNT_FLAG));
  assert.ok(AGENT_HARNESS_ENV_KEYS.includes("CURSOR_AGENT"));
});

test("allowedMaxAmountCeiling never raises for TTY / allowHigh / harness", () => {
  assert.equal(allowedMaxAmountCeiling({}), 1);
  assert.equal(allowedMaxAmountCeiling({ allowHigh: true, interactive: false }), 1);
  assert.equal(allowedMaxAmountCeiling({ allowHigh: true, interactive: true }), 1);
  assert.equal(allowedMaxAmountCeiling({ apifyPrepaid: true }), 1.05);
  assert.equal(allowedMaxAmountCeiling({ apifyPrepaid: true, allowHigh: true, interactive: true }), 1.05);
});

test("inAgentHarness detects known harness env keys", () => {
  assert.equal(inAgentHarness({ env: {} }), false);
  assert.equal(inAgentHarness({ env: { CURSOR_AGENT: "1" } }), true);
  assert.equal(inAgentHarness({ env: { CLAUDECODE: "1" } }), true);
  assert.equal(inAgentHarness({ env: { CODEX_HOME: "/tmp/codex" } }), true);
  assert.equal(inAgentHarness({ env: { GEMINI_CLI: "1" } }), true);
  assert.equal(inAgentHarness({ env: { OPENCLAW_HOME: "/tmp/openclaw" } }), true);
  assert.equal(inAgentHarness({ env: { HERMES_SESSION: "s" } }), true);
  assert.equal(inAgentHarness({ env: { CURSOR_AGENT: "" } }), false);
});

test("explicit --max-amount 999 is refused in non-TTY (YOLO clamp)", () => {
  const auth = authorizeExplicitMaxAmount(999, { interactive: false });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /\$1 hard CLI ceiling/);

  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--max-amount", "0.05"],
    { explicit: 999, interactive: false }
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /hard CLI ceiling/);
});

test("explicit --max-amount 3 is refused even with --allow-high-max-amount", () => {
  const auth = authorizeExplicitMaxAmount(3, { interactive: false, allowHigh: true });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /\$1 hard CLI ceiling/);
  assert.match(auth.hint, /does not raise/);
});

test("explicit --max-amount at or under $1 is allowed without a raise", () => {
  assert.equal(authorizeExplicitMaxAmount(1, { interactive: false }).capUsd, 1);
  assert.equal(authorizeExplicitMaxAmount(0.05, { interactive: false }).capUsd, 0.05);
});

test("harness-like + isTTY + --allow-high-max-amount cannot exceed $1", () => {
  const harness = { interactive: true, allowHigh: true, agent: true };
  const five = authorizeExplicitMaxAmount(5, harness);
  assert.equal(five.ok, false);
  assert.match(five.error, /\$1 hard CLI ceiling/);
  assert.match(five.hint, /TTY and agent harnesses/);
  assert.equal(authorizeExplicitMaxAmount(1, harness).ok, true);
  assert.equal(authorizeExplicitMaxAmount(1, harness).capUsd, 1);
});

test("TTY + --allow-high-max-amount still cannot exceed $1 (raise dropped)", () => {
  const ok = authorizeExplicitMaxAmount(5, { interactive: true, allowHigh: true });
  assert.equal(ok.ok, false);
  assert.match(ok.error, /\$1 hard CLI ceiling/);
  const nope = authorizeExplicitMaxAmount(5.01, { interactive: true, allowHigh: true });
  assert.equal(nope.ok, false);
});

test("Apify prepaid $1.05 is allowed on non-TTY; the same 1.05 is refused on x402", () => {
  const apify = authorizeExplicitMaxAmount(1.05, { interactive: false, apifyPrepaid: true });
  assert.equal(apify.ok, true);
  assert.equal(apify.capUsd, 1.05);
  assert.equal(apify.apifyException, true);

  const x402 = authorizeExplicitMaxAmount(1.05, { interactive: false, apifyPrepaid: false });
  assert.equal(x402.ok, false);
  assert.match(x402.error, /\$1 hard CLI ceiling/);
});

test("Apify exception is not a generic hole: 1.06 and 999 still refuse on non-TTY", () => {
  assert.equal(authorizeExplicitMaxAmount(1.06, { interactive: false, apifyPrepaid: true }).ok, false);
  assert.equal(authorizeExplicitMaxAmount(999, { interactive: false, apifyPrepaid: true }).ok, false);
});

test("applyRunMaxAmountCeiling still last-wins then clamps catalog hints", () => {
  const hostile = ["GET", "https://api.example/v1", "--max-amount", "0.05", "--max-amount", "50"];
  const got = applyRunMaxAmountCeiling(hostile);
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, 1);
  assert.deepEqual(got.args.slice(-2), ["--max-amount", "1"]);
});

test("applyRunMaxAmountCeiling: explicit 0.02 still last-wins over a hostile hint", () => {
  const hostile = ["GET", "https://api.example/v1", "--max-amount", "0.05", "--max-amount", "50"];
  const got = applyRunMaxAmountCeiling(hostile, { explicit: 0.02 });
  assert.equal(got.ok, true);
  assert.equal(got.capUsd, 0.02);
});

test("confirmHighMaxAmount: TTY yes still cannot exceed $1", async () => {
  const yes = await confirmHighMaxAmount({
    explicit: 3,
    interactive: true,
    allowHigh: true,
    agent: true,
    prompt: async () => true,
  });
  assert.equal(yes.ok, false);
  assert.match(yes.error, /\$1 hard CLI ceiling/);

  const atCap = await confirmHighMaxAmount({
    explicit: 1,
    interactive: true,
    prompt: async () => true,
  });
  assert.equal(atCap.ok, true);
  assert.equal(atCap.allowHigh, false);
  assert.equal(atCap.capUsd, 1);
});

test("authorizeRunMaxAmount: non-TTY 999 refuses", async () => {
  const got = await authorizeRunMaxAmount({
    maxAmount: 999,
    interactive: false,
    jsonMode: true,
  });
  assert.equal(got.ok, false);
  assert.match(got.error, /hard CLI ceiling/);
});

test("authorizeRunMaxAmount: harness + isTTY + --allow-high-max-amount cannot exceed $1", async () => {
  const got = await authorizeRunMaxAmount({
    maxAmount: 5,
    allowHighMaxAmount: true,
    interactive: true,
    agent: true,
    prompt: async () => true,
  });
  assert.equal(got.ok, false);
  assert.match(got.error, /\$1 hard CLI ceiling/);
});

test("missingSessionBudget: absent / env-only refuse; file-armed allows", () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-session-guard-"));
  const none = join(dir, "none.json");
  const missing = missingSessionBudget({ env: {}, filePath: none });
  assert.match(missing.error, /selat budget start --amount/);
  assert.match(missing.hint, /selat freeze/);
  assert.match(missing.hint, /kill switch/);

  const f = join(dir, "session.json");
  writeFileSync(f, JSON.stringify({ sessionId: "s1", budgetUsd: 2 }));
  assert.equal(missingSessionBudget({ env: {}, filePath: f }), null);
  assert.ok(missingSessionBudget({ env: { SELAT_SESSION_BUDGET: "2" }, filePath: none }));
  assert.ok(missingSessionBudget({ env: { SELAT_SESSION_BUDGET: "99999" }, filePath: none }));
});

test("readSessionConfig: env cannot invent a budget; may lower a file budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-session-read-"));
  const none = join(dir, "none.json");
  assert.equal(readSessionConfig({ env: { SELAT_SESSION_BUDGET: "99999", SELAT_SESSION_ID: "t1" }, filePath: none }), null);

  const f = join(dir, "session.json");
  writeFileSync(f, JSON.stringify({ sessionId: "file-9", budgetUsd: 2 }));
  assert.deepEqual(readSessionConfig({ env: {}, filePath: f }), { budgetUsd: 2, sessionId: "file-9", source: "file" });
  assert.deepEqual(
    readSessionConfig({ env: { SELAT_SESSION_BUDGET: "0.5" }, filePath: f }),
    { budgetUsd: 0.5, sessionId: "file-9", source: "file+env" }
  );
  assert.deepEqual(
    readSessionConfig({ env: { SELAT_SESSION_BUDGET: "99999" }, filePath: f }),
    { budgetUsd: 2, sessionId: "file-9", source: "file" }
  );
});

test("paid selat run without a session budget refuses (does not rank or pay)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-run-budget-"));
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
  };
  delete env.SELAT_SESSION_BUDGET;
  delete env.SELAT_SESSION_ID;
  const r = await pexec(process.execPath, ["bin/selat.mjs", "run", "--json", "weather in tokyo"], { env }).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /session budget/);
  assert.match(parsed.error, /budget start/);
  assert.doesNotMatch(parsed.error, /skill not found|rank\.mjs/);
});

test("SELAT_SESSION_BUDGET=99999 with no session.json still refuses paid run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-run-env-budget-"));
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
    SELAT_SESSION_BUDGET: "99999",
    SELAT_SESSION_ID: "spoofed",
    CURSOR_AGENT: "1",
  };
  const r = await pexec(process.execPath, ["bin/selat.mjs", "run", "--json", "--max-amount", "0.05", "weather"], { env }).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /session budget/);
  assert.match(parsed.error, /budget start/);
  assert.doesNotMatch(parsed.error, /skill not found|rank\.mjs/);
});

test("file-armed session.json allows the paid path past the budget gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-run-file-budget-"));
  const session = join(dir, "session.json");
  writeFileSync(session, JSON.stringify({ sessionId: "s-file", budgetUsd: 2 }));
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: session,
    SELAT_SKILL_PATH: join(dir, "no-such-skill"),
  };
  delete env.SELAT_SESSION_BUDGET;
  delete env.SELAT_SESSION_ID;
  const r = await pexec(process.execPath, ["bin/selat.mjs", "run", "--json", "--max-amount", "0.05", "weather"], { env }).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(parsed.error, /session budget/);
  assert.match(parsed.error, /skill not found/);
});

test("harness env + --allow-high-max-amount 5 refuses the $1 ceiling on paid run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-run-harness-cap-"));
  const session = join(dir, "session.json");
  writeFileSync(session, JSON.stringify({ sessionId: "s-h", budgetUsd: 10 }));
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: session,
    CURSOR_AGENT: "1",
    CLAUDECODE: "1",
  };
  const r = await pexec(
    process.execPath,
    ["bin/selat.mjs", "run", "--json", "--max-amount", "5", "--allow-high-max-amount", "weather"],
    { env }
  ).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /hard CLI ceiling/);
  assert.doesNotMatch(parsed.error, /skill not found|rank\.mjs/);
});

test("selat budget start writes session.json and is not blocked by missing env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-budget-start-"));
  const session = join(dir, "session.json");
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: session,
  };
  delete env.SELAT_SESSION_BUDGET;
  const r = await pexec(process.execPath, ["bin/selat.mjs", "budget", "start", "--amount", "2"], { env });
  assert.match(r.stdout, /session budget armed: \$2/);
  const cfg = readSessionConfig({ env: {}, filePath: session });
  assert.equal(cfg.budgetUsd, 2);
  assert.equal(cfg.source, "file");
  assert.equal(missingSessionBudget({ env: {}, filePath: session }), null);
});

test("cwd .env with SELAT_SESSION_BUDGET does not arm a paid run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-cwd-env-"));
  writeFileSync(join(dir, ".env"), "SELAT_SESSION_BUDGET=99999\nSELAT_SESSION_ID=cwd\n");
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
  };
  delete env.SELAT_SESSION_BUDGET;
  delete env.SELAT_SESSION_ID;
  const r = await pexec(process.execPath, [SELAT_BIN, "run", "--json", "weather"], { env, cwd: dir }).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /session budget/);
});

test("selat run --dry-run does not require a session budget (free preview)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-run-dry-"));
  const env = {
    ...process.env,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
    SELAT_SKILL_PATH: join(dir, "no-such-skill"),
  };
  delete env.SELAT_SESSION_BUDGET;
  const r = await pexec(process.execPath, ["bin/selat.mjs", "run", "--dry-run", "--json", "weather"], { env }).catch((e) => e);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(parsed.error, /session budget/);
  assert.match(parsed.error, /skill not found/);
});

test("free discovery stays ungated: selat search --help / skill list --help", async () => {
  for (const argv of [["search", "--help"], ["skill", "list", "--help"]]) {
    const r = await pexec(process.execPath, ["bin/selat.mjs", ...argv]);
    assert.doesNotMatch(r.stdout + (r.stderr || ""), /session budget armed|budget start/);
  }
});
