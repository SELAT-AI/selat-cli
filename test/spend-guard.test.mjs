import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  ALLOW_HIGH_MAX_AMOUNT_FLAG,
  APIFY_PREPAID_TOKEN_USD,
  HARD_CLI_MAX_AMOUNT_USD,
  RAISED_CLI_MAX_AMOUNT_USD,
  allowedMaxAmountCeiling,
  authorizeExplicitMaxAmount,
  confirmHighMaxAmount,
} from "../lib/spend-guard.mjs";
import {
  applyRunMaxAmountCeiling,
  authorizeRunMaxAmount,
  DEFAULT_RUN_MAX_AMOUNT_USD,
  KNOWN_RUN_FLAGS,
} from "../lib/commands/run.mjs";
import { missingSessionBudget } from "../lib/commands/budget.mjs";

const pexec = promisify(execFile);

test("hard CLI ceiling is $1; documented raise cap is $5; Apify token is $1.05", () => {
  assert.equal(HARD_CLI_MAX_AMOUNT_USD, 1);
  assert.equal(DEFAULT_RUN_MAX_AMOUNT_USD, 1);
  assert.equal(RAISED_CLI_MAX_AMOUNT_USD, 5);
  assert.equal(APIFY_PREPAID_TOKEN_USD, 1.05);
  assert.equal(ALLOW_HIGH_MAX_AMOUNT_FLAG, "--allow-high-max-amount");
  assert.ok(KNOWN_RUN_FLAGS.includes(ALLOW_HIGH_MAX_AMOUNT_FLAG));
});

test("non-TTY / agent ceiling is $1; TTY+allowHigh raises to $5; Apify exception is $1.05 only", () => {
  assert.equal(allowedMaxAmountCeiling({}), 1);
  assert.equal(allowedMaxAmountCeiling({ allowHigh: true, interactive: false }), 1);
  assert.equal(allowedMaxAmountCeiling({ allowHigh: true, interactive: true }), 5);
  assert.equal(allowedMaxAmountCeiling({ apifyPrepaid: true }), 1.05);
  assert.equal(allowedMaxAmountCeiling({ apifyPrepaid: true, allowHigh: true, interactive: true }), 5);
});

test("explicit --max-amount 999 is refused in non-TTY (YOLO clamp)", () => {
  const auth = authorizeExplicitMaxAmount(999, { interactive: false });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /exceeds the documented hard cap \$5/);

  const got = applyRunMaxAmountCeiling(
    ["GET", "https://api.example/v1", "--max-amount", "0.05"],
    { explicit: 999, interactive: false }
  );
  assert.equal(got.ok, false);
  assert.match(got.reason, /hard cap \$5|hard CLI ceiling/);
});

test("explicit --max-amount 3 is refused in non-TTY even with --allow-high-max-amount", () => {
  const auth = authorizeExplicitMaxAmount(3, { interactive: false, allowHigh: true });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /\$1 hard CLI ceiling/);
  assert.match(auth.hint, /Non-TTY/);
});

test("explicit --max-amount at or under $1 is allowed without a raise", () => {
  assert.equal(authorizeExplicitMaxAmount(1, { interactive: false }).capUsd, 1);
  assert.equal(authorizeExplicitMaxAmount(0.05, { interactive: false }).capUsd, 0.05);
});

test("TTY + --allow-high-max-amount may raise up to $5, never above", () => {
  const ok = authorizeExplicitMaxAmount(5, { interactive: true, allowHigh: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.capUsd, 5);
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

test("confirmHighMaxAmount: TTY prompt can raise; decline stays at $1", async () => {
  const yes = await confirmHighMaxAmount({
    explicit: 3,
    interactive: true,
    prompt: async () => true,
  });
  assert.equal(yes.ok, true);
  assert.equal(yes.allowHigh, true);
  assert.equal(yes.capUsd, 3);

  const no = await confirmHighMaxAmount({
    explicit: 3,
    interactive: true,
    prompt: async () => false,
  });
  assert.equal(no.ok, false);
  assert.match(no.error, /declined/);
});

test("authorizeRunMaxAmount: non-TTY 999 refuses", async () => {
  const got = await authorizeRunMaxAmount({
    maxAmount: 999,
    interactive: false,
    jsonMode: true,
  });
  assert.equal(got.ok, false);
  assert.match(got.error, /hard cap \$5/);
});

test("missingSessionBudget: absent → refuse payload; armed file/env → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-session-guard-"));
  const none = join(dir, "none.json");
  const missing = missingSessionBudget({ env: {}, filePath: none });
  assert.match(missing.error, /selat budget start --amount/);
  assert.match(missing.hint, /selat freeze/);
  assert.match(missing.hint, /kill switch/);

  const f = join(dir, "session.json");
  writeFileSync(f, JSON.stringify({ sessionId: "s1", budgetUsd: 2 }));
  assert.equal(missingSessionBudget({ env: {}, filePath: f }), null);
  assert.equal(missingSessionBudget({ env: { SELAT_SESSION_BUDGET: "2" }, filePath: none }), null);
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
