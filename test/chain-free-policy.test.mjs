import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Design principle: the chain must NEVER appear in the user's money model —
// balance, spending, or policy. Chains are internal routing detail only.
// These tests pin (a) the truthful cap-state read (`circle wallet limit
// budget` is the source of truth; the plain `limit` read is inconsistent
// across query chains — verified live) and (b) chain-free rendering of every
// policy/budget surface.

const dir = mkdtempSync(join(tmpdir(), "selat-chain-free-"));

// Fake Circle CLI. Default mode mirrors the live inconsistency: the plain
// `wallet limit` read reports origin DEFAULT with no limits while `wallet
// limit budget` reports the user's CUSTOM caps + consumed counters. Mode
// "budget-unreadable" makes the budget surface fail so the fallback path is
// exercisable.
const fakeCircle = join(dir, "fake-circle");
writeFileSync(fakeCircle, `#!/bin/sh
case "$*" in
  *"limit budget"*)
    if [ "$FAKE_CIRCLE_MODE" = "budget-unreadable" ]; then exit 1; fi
    echo '{"data":{"policies":{"STABLECOIN_TRANSFER":{"origin":"CUSTOM","per_tx_limit":"5","daily_limit":"50","daily_remaining":"50","weekly_limit":"200","weekly_remaining":"200","monthly_limit":"500","monthly_remaining":"493"}}}}'
    ;;
  *"wallet limit"*)
    if [ "$FAKE_CIRCLE_MODE" = "budget-unreadable" ]; then
      echo '{"data":{"policies":[{"origin":"CUSTOM","ruleType":"TRANSFER_LIMIT","perTxLimit":"7","dailyLimit":"70"}]}}'
    else
      echo '{"data":{"policies":[{"origin":"DEFAULT","ruleType":"TRANSFER_LIMIT"}]}}'
    fi
    ;;
  *) echo '{}' ;;
esac
`);
chmodSync(fakeCircle, 0o755);

// Route this process's circle shell-outs at the fake BEFORE lib/circle.mjs
// captures CIRCLE_BIN at module load (hence the dynamic imports).
process.env.CIRCLE_BIN = fakeCircle;
const { spendingPolicy, policyFromBudget, describePolicy } = await import("../lib/circle.mjs");
const { budgetUserSummary } = await import("../lib/commands/budget.mjs");
const { policyDoctorLines } = await import("../lib/commands/doctor.mjs");
const { parseSetupPolicyArgs } = await import("../lib/commands/setup-policy.mjs");

const ADDRESS = "0xb291279be48742f0a1e9ed15c8d6d2d09ea9e4da";

// Every chain name the Circle CLI or the money path knows, plus the word
// "chain" itself — none of them may leak into a policy/budget surface.
const CHAIN_TOKENS =
  /\b(chain|chains|base|eth|ethereum|arb|arbitrum|op|optimism|matic|poly|polygon|avax|avalanche|uni|unichain|monad|solana)\b/i;

test("policyFromBudget maps the budget surface to the policy shape", () => {
  assert.equal(policyFromBudget({ readable: false }), null);
  assert.equal(policyFromBudget(null), null);
  assert.deepEqual(policyFromBudget({ readable: true, custom: false, rows: [] }), { readable: true, custom: false });
  assert.deepEqual(
    policyFromBudget({
      readable: true,
      custom: true,
      rows: [
        { window: "per-tx", limit: 5, remaining: null },
        { window: "daily", limit: 50, remaining: 50 },
        { window: "weekly", limit: 200, remaining: 200 },
        { window: "monthly", limit: 500, remaining: 493 }
      ]
    }),
    { readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } }
  );
  // sparse rows leave the other windows null rather than undefined
  assert.deepEqual(
    policyFromBudget({ readable: true, custom: true, rows: [{ window: "daily", limit: 10, remaining: 4 }] }),
    { readable: true, custom: true, limits: { perTx: null, daily: 10, weekly: null, monthly: null } }
  );
});

test("spendingPolicy trusts `limit budget` over an inconsistent plain `limit` read", async () => {
  // The fake's plain `limit` says DEFAULT/no-limits (what POLYGON reports
  // live); the budget surface says CUSTOM with caps (what both chains'
  // budget reads report live). The truthful answer is CUSTOM.
  const policy = await spendingPolicy(ADDRESS);
  assert.deepEqual(policy, {
    readable: true,
    custom: true,
    limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 }
  });
});

test("spendingPolicy falls back to the plain `limit` read when budget is unreadable", async () => {
  process.env.FAKE_CIRCLE_MODE = "budget-unreadable";
  try {
    const policy = await spendingPolicy(ADDRESS);
    assert.deepEqual(policy, {
      readable: true,
      custom: true,
      limits: { perTx: 7, daily: 70, weekly: null, monthly: null }
    });
  } finally {
    delete process.env.FAKE_CIRCLE_MODE;
  }
});

test("describePolicy and budgetUserSummary never name a chain", () => {
  const shapes = [
    null,
    { readable: false },
    { readable: true, custom: false },
    { readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } },
    { readable: true, custom: true, limits: { perTx: 5, daily: null, weekly: null, monthly: null } },
    { readable: true, custom: true, limits: {} }
  ];
  for (const policy of shapes) {
    assert.doesNotMatch(describePolicy(policy), CHAIN_TOKENS, `describePolicy(${JSON.stringify(policy)})`);
  }
  const summaries = [
    budgetUserSummary({ policy: { readable: false }, budget: { readable: false } }),
    budgetUserSummary({ policy: { readable: true, custom: false }, budget: { readable: true, rows: [] } }),
    budgetUserSummary({
      policy: { readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } },
      budget: { readable: true, rows: [{ window: "daily", limit: 50, remaining: 37 }] }
    })
  ];
  for (const s of summaries) assert.doesNotMatch(s, CHAIN_TOKENS, s);
});

test("doctor's spending-policy lines never name a chain", () => {
  const cases = [
    policyDoctorLines({ readable: false }),
    policyDoctorLines(null),
    policyDoctorLines({ readable: true, custom: false }),
    policyDoctorLines({ readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } })
  ];
  for (const lines of cases) {
    assert.ok(lines.length >= 1);
    for (const line of lines) {
      assert.ok(["pass", "warn", "dim"].includes(line.level));
      assert.doesNotMatch(line.text, CHAIN_TOKENS, line.text);
    }
  }
  // the capped wallet still reads its true caps
  assert.equal(
    policyDoctorLines({ readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } })[0].text,
    "capped at $5/tx · $50/day · $200/wk · $500/mo"
  );
});

test("setup-policy args: chain defaults silently to BASE; --chain is an advanced override", () => {
  assert.deepEqual(parseSetupPolicyArgs([]), { chain: "BASE" });
  assert.deepEqual(parseSetupPolicyArgs(undefined), { chain: "BASE" });
  assert.deepEqual(parseSetupPolicyArgs(["--chain", "matic"]), { chain: "MATIC" });
  assert.deepEqual(parseSetupPolicyArgs(["--chain=op"]), { chain: "OP" });
  // a following flag is not a chain value; empty inline value keeps default
  assert.deepEqual(parseSetupPolicyArgs(["--chain", "--json"]), { chain: "BASE" });
  assert.deepEqual(parseSetupPolicyArgs(["--chain="]), { chain: "BASE" });
  assert.deepEqual(parseSetupPolicyArgs(["--chain"]), { chain: "BASE" });
});

// End-to-end: `selat budget` (human + --json) against the fake Circle CLI.
// Pins both truthfulness (CUSTOM caps shown even though the plain `limit`
// read claims DEFAULT) and chain-free rendering of the whole surface.

const pexecFile = promisify(execFile);
const selatBin = fileURLToPath(new URL("../bin/selat.mjs", import.meta.url));

function budgetEnv() {
  return {
    ...process.env,
    CIRCLE_BIN: fakeCircle,
    SELAT_AGENT_WALLET_ADDRESS: ADDRESS,
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json"),
    SELAT_PAY_HISTORY_PATH: join(dir, "no-history.jsonl"),
    SELAT_PAY_FREEZE_PATH: join(dir, "no-freeze.json"),
    NO_COLOR: "1"
  };
}

test("`selat budget` renders the true CUSTOM caps with zero chain language", async () => {
  const { stdout } = await pexecFile(process.execPath, [selatBin, "budget"], { env: budgetEnv() });
  assert.match(stdout, /capped at \$5\/tx · \$50\/day · \$200\/wk · \$500\/mo/);
  assert.match(stdout, /monthly\s+\$493 left of \$500/);
  assert.doesNotMatch(stdout, CHAIN_TOKENS, stdout);
});

test("`selat budget --json` is chain-free and keeps the true cap state", async () => {
  const { stdout } = await pexecFile(process.execPath, [selatBin, "budget", "--json"], { env: budgetEnv() });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.custom, true);
  assert.deepEqual(parsed.limits, { perTx: 5, daily: 50, weekly: 200, monthly: 500 });
  assert.ok(!("chain" in parsed), "JSON payload must not carry a chain field");
  assert.doesNotMatch(stdout, CHAIN_TOKENS, stdout);
});

test("`selat budget --help` no longer advertises a chain knob", async () => {
  const { stdout } = await pexecFile(process.execPath, [selatBin, "budget", "--help"], { env: budgetEnv() });
  assert.doesNotMatch(stdout, /--chain/);
});
