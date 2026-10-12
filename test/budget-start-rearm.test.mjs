import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-arming used to mint a fresh session id (spend silently back to $0), so an
// agent at "budget exhausted" could re-arm itself forever. Now replacing an
// armed session needs --force and keeps the id, so spend carries over.
test("budget start: refuses to replace an armed session; --force keeps its id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-budget-"));
  process.env.SELAT_PAY_SESSION_PATH = join(dir, "session.json");
  process.env.SELAT_PAY_HISTORY_PATH = join(dir, "history.jsonl");
  const { budget } = await import("../lib/commands/budget.mjs");
  const quiet = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(await budget(["start", "--amount", "2"]), 0);
    const first = JSON.parse(readFileSync(process.env.SELAT_PAY_SESSION_PATH, "utf8"));
    writeFileSync(process.env.SELAT_PAY_HISTORY_PATH,
      JSON.stringify({ sessionId: first.sessionId, outcome: "settled", amountUsd: 1.99 }) + "\n");

    assert.equal(await budget(["start", "--amount", "2"]), 1); // refused
    assert.equal(JSON.parse(readFileSync(process.env.SELAT_PAY_SESSION_PATH, "utf8")).sessionId, first.sessionId);

    assert.equal(await budget(["start", "--amount", "3", "--force"]), 0);
    const after = JSON.parse(readFileSync(process.env.SELAT_PAY_SESSION_PATH, "utf8"));
    assert.equal(after.sessionId, first.sessionId); // spend carries over
    assert.equal(after.budgetUsd, 3);

    assert.equal(await budget(["stop"]), 0);
    assert.equal(await budget(["start", "--amount", "1"]), 0);
    assert.notEqual(JSON.parse(readFileSync(process.env.SELAT_PAY_SESSION_PATH, "utf8")).sessionId, first.sessionId);
  } finally {
    console.log = quiet.log; console.error = quiet.error;
    delete process.env.SELAT_PAY_SESSION_PATH; delete process.env.SELAT_PAY_HISTORY_PATH;
  }
});
