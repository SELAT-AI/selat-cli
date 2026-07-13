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
