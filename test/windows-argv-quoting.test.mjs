import test from "node:test";
import assert from "node:assert/strict";
import { quoteArgvWin } from "../lib/sh.mjs";

// The pre-fix quoteWin doubled only TRAILING backslashes, so a
// backslash-immediately-before-a-quote (present in every JSON body whose string
// values contain a quote) was corrupted — on Windows this sent an altered
// payload into a paid call. quoteArgvWin implements the documented
// CommandLineToArgvW quoting; this pins the child-parser layer with a faithful
// simulator so the escaping is verified even without a Windows host.

// Faithful CommandLineToArgvW parser (Microsoft's documented backslash/quote
// rules) — reconstructs argv[] from a command line the way the child does.
function commandLineToArgv(cmdline) {
  const args = [];
  let cur = "", inQuotes = false, bs = 0, has = false, i = 0;
  const flush = (n) => { cur += "\\".repeat(n); };
  while (i < cmdline.length) {
    const c = cmdline[i];
    if (c === "\\") { bs++; i++; continue; }
    if (c === '"') {
      flush(Math.floor(bs / 2));
      if (bs % 2 === 1) { cur += '"'; has = true; }
      else { inQuotes = !inQuotes; has = true; }
      bs = 0; i++; continue;
    }
    if (bs) { flush(bs); bs = 0; }
    if (!inQuotes && (c === " " || c === "\t")) {
      if (has || cur) { args.push(cur); cur = ""; has = false; }
      i++; continue;
    }
    cur += c; has = true; i++;
  }
  if (bs) flush(bs);
  if (has || cur) args.push(cur);
  return args;
}

const CASES = [
  `{"q":"say \\"hi\\" now"}`,   // the reported bug: backslash-before-quote
  `a\\"b`,
  `{"q":"plain"}`,
  `{"query":"a & b | c"}`,      // cmd metachars inside a value
  `C:\\path\\to\\circle.cmd`,
  `trailing\\`,
  ``,
  `simple`,
  `{"domain":"x.com","ids":["a","b"]}`,
];

test("quoteArgvWin round-trips through the child CommandLineToArgvW parser", () => {
  for (const arg of CASES) {
    // Strip the cmd-meta ^ layer the shell would consume, then parse as the child does.
    const shellSeen = quoteArgvWin(arg); // child layer only (no ^; that's cmd's layer)
    const parsed = commandLineToArgv(`prog ${shellSeen}`)[1] ?? "";
    assert.equal(parsed, arg, `round-trip failed for ${JSON.stringify(arg)}`);
  }
});

test("the specific regression: backslash-before-quote is preserved", () => {
  const arg = `a\\"b`;
  assert.equal(commandLineToArgv(`p ${quoteArgvWin(arg)}`)[1], `a\\"b`);
  // pre-fix behaviour lost the backslash → a"b; guard against regressing there
  assert.notEqual(commandLineToArgv(`p ${quoteArgvWin(arg)}`)[1], `a"b`);
});

test("no-escape fast path leaves clean args untouched", () => {
  assert.equal(quoteArgvWin("wallet"), "wallet");
  assert.equal(quoteArgvWin("--address"), "--address");
  assert.equal(quoteArgvWin("0xabc123"), "0xabc123");
  assert.equal(quoteArgvWin("BASE"), "BASE");
});
