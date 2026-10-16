import assert from "node:assert/strict";
import test from "node:test";
import { apifyRunDisplayCommand, selatRunDisplayCommand } from "../lib/commands/run.mjs";

const payArgs = ["POST", "https://api.example.com/search", "--body", '{"q":"a b"}', "--max-amount", "0.02", "--chain", "arc"];

test("dry-run command is a pinned selat run line, never selat-pay", () => {
  const cmd = selatRunDisplayCommand({ intent: "web search", payArgs, params: [["q", "a b"]] });
  assert.match(cmd, /^selat run /);
  assert.ok(!cmd.includes("selat-pay"));
  assert.ok(cmd.includes("--endpoint https://api.example.com/search"));
  assert.ok(cmd.includes("--method POST"));
  assert.ok(cmd.includes("--max-amount 0.02"));
  assert.ok(cmd.includes("--param"), "user params are carried so the pinned run rebuilds the same body");
  assert.ok(cmd.includes("a b") && /'q=a b'|"q=a b"/.test(cmd), "values with spaces are shell-quoted");
});

test("the chain and the engine body flag are never shown", () => {
  const cmd = selatRunDisplayCommand({ intent: "x", payArgs });
  assert.ok(!cmd.includes("--chain"));
  assert.ok(!cmd.includes("--body"));
});

test("--allow-unlisted and the last --max-amount win", () => {
  const args = ["GET", "https://u.example/p", "--max-amount", "0.5", "--max-amount", "0.1"];
  const cmd = selatRunDisplayCommand({ intent: "x", payArgs: args, allowUnlisted: true });
  assert.ok(cmd.includes("--allow-unlisted"));
  assert.ok(cmd.endsWith("--max-amount 0.1"));
});

test("apify dry-run command is selat run with the actor input", () => {
  const cmd = apifyRunDisplayCommand({ intent: "scrape a profile", inputInline: '{"directUrls":["https://x.y/z"]}', autoRebuy: true });
  assert.match(cmd, /^selat run /);
  assert.ok(cmd.includes("--input"));
  assert.ok(cmd.includes("--auto-rebuy"));
  assert.ok(!cmd.includes("apify_token.mjs") && !cmd.includes("selat-pay"));
  const fromFile = apifyRunDisplayCommand({ intent: "x", inputFile: "in.json", maxAmount: 1.05 });
  assert.ok(fromFile.includes("--input-file in.json") && fromFile.includes("--max-amount 1.05"));
});
