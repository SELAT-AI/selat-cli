import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRunArgs,
  run as runCmd,
  KNOWN_RUN_FLAGS,
  capabilityArgs,
  rankPickArgv,
  pinArgs,
} from "../lib/commands/run.mjs";
import { search, searchRankFlags, searchCapabilityArgs } from "../lib/commands/search.mjs";

// Layer 0 `--capability` is a CLI passthrough to discovery's rank.mjs. The CLI
// must parse and forward the flag; it must not interpret names, invent catalog
// counts, or silently drop the flag (which would re-widen the ranked pool).

test("--capability is a known selat run flag", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--capability"));
});

test("parseRunArgs captures --capability without swallowing the intent", () => {
  const r = parseRunArgs(["find", "recent", "papers", "--capability", "web.search"]);
  assert.equal(r.ok, true);
  assert.equal(r.intent, "find recent papers");
  assert.equal(r.capability, "web.search");
});

test("parseRunArgs defaults --capability to absent", () => {
  const r = parseRunArgs(["find recent papers"]);
  assert.equal(r.ok, true);
  assert.equal(r.capability, undefined);
});

test("parseRunArgs refuses a missing or flag-like --capability value", () => {
  const missing = parseRunArgs(["x", "--capability"]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /--capability requires a value/);

  const flagLike = parseRunArgs(["x", "--capability", "--dry-run"]);
  assert.equal(flagLike.ok, false);
  assert.match(flagLike.error, /--capability requires a value/);
});

test("parseRunArgs composes --capability with --dry-run, --json, and --live-probe", () => {
  const r = parseRunArgs(["x", "--capability", "web.search", "--dry-run", "--json", "--live-probe"]);
  assert.equal(r.ok, true);
  assert.equal(r.capability, "web.search");
  assert.equal(r.dryRun, true);
  assert.equal(r.jsonMode, true);
  assert.equal(r.liveProbe, true);
});

test("capabilityArgs forwards nothing when omitted", () => {
  assert.deepEqual(capabilityArgs({}), []);
  assert.deepEqual(capabilityArgs({ capability: undefined }), []);
});

test("capabilityArgs forwards the name as one argv token", () => {
  assert.deepEqual(capabilityArgs({ capability: "web.search" }), ["--capability", "web.search"]);
});

test("rankPickArgv omits --capability when the flag is absent (today's pick argv)", () => {
  assert.deepEqual(rankPickArgv({ intent: "find papers" }), ["find papers", "--pick"]);
});

test("rankPickArgv forwards --capability web.search to rank.mjs", () => {
  assert.deepEqual(
    rankPickArgv({ intent: "find papers", capability: "web.search" }),
    ["find papers", "--pick", "--capability", "web.search"],
  );
});

test("rankPickArgv keeps --live-probe and --endpoint next to --capability", () => {
  assert.deepEqual(
    rankPickArgv({
      intent: "x",
      liveProbe: true,
      endpoint: "https://a.example/x",
      method: "POST",
      capability: "web.search",
    }),
    [
      "x",
      "--pick",
      "--live-probe",
      ...pinArgs({ endpoint: "https://a.example/x", method: "POST" }),
      "--capability",
      "web.search",
    ],
  );
});

test("searchRankFlags forwards --capability and keeps existing flags", () => {
  assert.deepEqual(
    searchRankFlags(["find papers", "--top", "3", "--refresh", "--explain", "--capability", "web.search"]),
    ["--top", "3", "--refresh", "--explain-payability", "--capability", "web.search"],
  );
});

test("searchRankFlags and searchCapabilityArgs omit --capability when the flag is absent", () => {
  assert.deepEqual(searchRankFlags(["find papers", "--top", "3"]), ["--top", "3"]);
  assert.deepEqual(searchCapabilityArgs(["find papers", "--json"]), []);
});

function captureLog(t) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.log = log; });
  return { lines, text: () => lines.join("\n") };
}

test("selat search --help documents --capability", async (t) => {
  const cap = captureLog(t);
  const code = await search(["--help"]);
  assert.equal(code, 0);
  assert.match(cap.text(), /--capability <name>/);
  assert.match(cap.text(), /Layer 0/);
});

test("selat run --help documents --capability", async (t) => {
  const cap = captureLog(t);
  const code = await runCmd(["--help"]);
  assert.equal(code, 0);
  assert.match(cap.text(), /--capability <name>/);
  assert.match(cap.text(), /Layer 0/);
});
