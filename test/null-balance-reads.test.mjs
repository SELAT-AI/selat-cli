import test from "node:test";
import assert from "node:assert/strict";

import { retryNullRead } from "../lib/circle.mjs";
import { gatewayUnreadableLines } from "../lib/commands/init.mjs";

// Null-vs-zero conflation fixes: every balance helper in circle.mjs signals a
// FAILED read as null (never throws), and several callers treated that null
// as a confirmed-zero balance. The live incident: an init run whose Circle
// API calls were transiently failing told a user with $9.77 in Gateway
// "No USDC yet — fund before paid calls". These tests pin the retry helper
// and the honest "unreadable ≠ empty" wording.

// --- retryNullRead ------------------------------------------------------------

test("returns the first non-null read without retrying", async () => {
  let calls = 0;
  const result = await retryNullRead(async () => { calls += 1; return 9.77; });
  assert.equal(result, 9.77);
  assert.equal(calls, 1);
});

test("retries a null read once and returns the recovered value", async () => {
  const reads = [null, 9.77];
  const slept = [];
  const result = await retryNullRead(async () => reads.shift(), {
    sleep: async (ms) => { slept.push(ms); }
  });
  assert.equal(result, 9.77);
  assert.deepEqual(slept, [1500]); // one backoff between the two attempts
});

test("returns null after exhausting attempts, never sleeping after the last", async () => {
  let calls = 0;
  const slept = [];
  const result = await retryNullRead(async () => { calls += 1; return null; }, {
    attempts: 3,
    delayMs: 100,
    sleep: async (ms) => { slept.push(ms); }
  });
  assert.equal(result, null);
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 100]); // no trailing sleep once attempts are spent
});

test("zero is a valid read, not a failure to retry", async () => {
  let calls = 0;
  const result = await retryNullRead(async () => { calls += 1; return 0; });
  assert.equal(result, 0);
  assert.equal(calls, 1);
});

// --- gatewayUnreadableLines -----------------------------------------------------

test("unreadable Gateway balance is never worded as an empty wallet", () => {
  const addr = "0x" + "ab".repeat(20);
  const text = gatewayUnreadableLines(addr).join("\n");
  assert.match(text, /Couldn't read/);
  assert.match(text, /may already be funded/);
  assert.match(text, new RegExp(`circle gateway balance --address ${addr} --chain BASE --all`));
  assert.doesNotMatch(text, /No USDC/i); // the false claim the fix removes
});
