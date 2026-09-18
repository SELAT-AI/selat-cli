import test from "node:test";
import assert from "node:assert/strict";

test("a valueless --method is an error, not a silent direct deposit", async () => {
  // `selat fund --amount 5 --yes --method` (value forgotten) used to default
  // to "direct" — a gas-requiring deposit — with --yes skipping the one
  // confirm screen that would have caught it.
  const { fund } = await import("../lib/commands/fund.mjs");
  const code = await fund(["--amount", "5", "--yes", "--method"]);
  assert.equal(code, 1);
});
