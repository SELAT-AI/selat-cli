import test from "node:test";
import assert from "node:assert/strict";

import { describePolicy } from "../lib/circle.mjs";
import { budgetUserSummary } from "../lib/commands/budget.mjs";

// Surfacing the Circle spending policy (the hard wallet-level ceiling) at
// money moments — from user feedback: testers ask for a "budget circuit
// breaker" because nothing surfaces `selat setup-policy` after install.

test("describePolicy covers unreadable / uncapped / capped wallets", () => {
  assert.match(describePolicy({ readable: false }), /could not read/);
  assert.match(describePolicy(null), /could not read/);
  assert.match(describePolicy({ readable: true, custom: false }), /no custom spending caps.*setup-policy/i);
  assert.equal(
    describePolicy({ readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } }),
    "capped at $5/tx · $50/day · $200/wk · $500/mo"
  );
  assert.equal(
    describePolicy({ readable: true, custom: true, limits: { perTx: 5, daily: null, weekly: null, monthly: null } }),
    "capped at $5/tx"
  );
});

test("budgetUserSummary speaks plainly for capped and uncapped wallets", () => {
  const uncapped = budgetUserSummary({ policy: { readable: true, custom: false }, budget: { readable: true, rows: [] } });
  assert.match(uncapped, /no spending caps/i);
  assert.match(uncapped, /setup-policy/);

  const capped = budgetUserSummary({
    policy: { readable: true, custom: true, limits: { perTx: 5, daily: 50, weekly: 200, monthly: 500 } },
    budget: { readable: true, rows: [{ window: "daily", limit: 50, remaining: 37 }] }
  });
  assert.match(capped, /capped/i);
  assert.match(capped, /\$37 of the \$50 daily budget/);
  assert.doesNotMatch(capped, /https?:\/\//);

  assert.match(budgetUserSummary({ policy: { readable: false }, budget: { readable: false } }), /could not read/i);
});

// Session budget display + config readers (enforcement lives in selat-pay).
test("session budget: env config, file config, ledger sum", async () => {
  const { readSessionConfig, sessionSpent } = await import("../lib/commands/budget.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "selat-cli-session-"));

  const env = { SELAT_SESSION_BUDGET: "2", SELAT_SESSION_ID: "t1" };
  assert.deepEqual(readSessionConfig({ env, filePath: join(dir, "none.json") }), { budgetUsd: 2, sessionId: "t1", source: "env" });

  const f = join(dir, "session.json");
  writeFileSync(f, JSON.stringify({ sessionId: "file-9", budgetUsd: 1.5 }));
  assert.deepEqual(readSessionConfig({ env: {}, filePath: f }), { budgetUsd: 1.5, sessionId: "file-9", source: "file" });
  assert.equal(readSessionConfig({ env: {}, filePath: join(dir, "none.json") }), null);

  const ledger = join(dir, "ledger.jsonl");
  writeFileSync(ledger, [
    JSON.stringify({ sessionId: "t1", amountUsd: 0.01 }),
    JSON.stringify({ sessionId: "t1", amountUsd: 0.005 }),
    JSON.stringify({ sessionId: "other", amountUsd: 4 }),
    ""
  ].join("\n"));
  assert.ok(Math.abs(sessionSpent("t1", { path: ledger }) - 0.015) < 1e-9);
});
