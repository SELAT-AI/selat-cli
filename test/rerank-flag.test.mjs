// `--rerank off|shadow|on` is a passthrough to discovery's rank.mjs (Jev
// capability re-rank). Both commands must forward the same mode so `selat run`
// pays what `selat search` showed, and must forward NOTHING when the flag is
// absent (rank.mjs then applies SELAT_RERANK or its default, and discovery
// versions that predate the flag are never sent it).
import test from "node:test";
import assert from "node:assert/strict";
import { search, parseRerankFlag, searchRankFlags, RERANK_MODES } from "../lib/commands/search.mjs";
import { run as runCmd, parseRunArgs, rankPickArgv, KNOWN_RUN_FLAGS } from "../lib/commands/run.mjs";

test("modes are off | shadow | on", () => {
  assert.deepEqual(RERANK_MODES, ["off", "shadow", "on"]);
});

test("search: absent flag forwards nothing; a valid mode is forwarded after existing flags", () => {
  assert.deepEqual(searchRankFlags(["find papers"]), []);
  assert.deepEqual(searchRankFlags(["find papers", "--rerank", "on", "--top", "3"]), ["--top", "3", "--rerank", "on"]);
  assert.deepEqual(searchRankFlags(["find papers", "--capability", "web.search", "--rerank", "shadow"]), ["--capability", "web.search", "--rerank", "shadow"]);
});

test("search: missing, flag-like or unknown modes are refused, never forwarded", () => {
  assert.equal(parseRerankFlag(["q", "--rerank"]).ok, false);
  const flagLike = searchRankFlags(["q", "--rerank", "--json"]);
  assert.equal(flagLike.ok, false);
  assert.match(flagLike.error, /flag-like --json/);
  assert.equal(Array.isArray(flagLike), false);
  assert.match(parseRerankFlag(["q", "--rerank", "maybe"]).error, /must be one of off \| shadow \| on/);
});

test("run: --rerank is known, parses without swallowing the intent, and refuses bad values", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--rerank"));
  const p = parseRunArgs(["smart", "money", "13F", "--rerank", "on", "--dry-run"]);
  assert.equal(p.ok, true);
  assert.equal(p.rerank, "on");
  assert.equal(p.intent, "smart money 13F");
  assert.equal(p.dryRun, true);
  assert.equal(parseRunArgs(["q"]).rerank, undefined);
  assert.equal(parseRunArgs(["q", "--rerank"]).ok, false);
  assert.equal(parseRunArgs(["q", "--rerank", "--dry-run"]).ok, false, "must not swallow --dry-run as the mode");
  assert.match(parseRunArgs(["q", "--rerank", "yes"]).error, /must be one of/);
});

test("run: rankPickArgv forwards the mode to rank.mjs --pick, and nothing when absent", () => {
  assert.deepEqual(rankPickArgv({ intent: "q" }), ["q", "--pick"]);
  assert.deepEqual(rankPickArgv({ intent: "q", rerank: "on" }), ["q", "--pick", "--rerank", "on"]);
  assert.deepEqual(rankPickArgv({ intent: "q", capability: "web.search", payableNow: true, rerank: "off" }), ["q", "--pick", "--capability", "web.search", "--payable-now", "--rerank", "off"]);
});

function captureLog(t) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.log = log; });
  return { text: () => lines.join("\n") };
}

test("both --help pages document --rerank", async (t) => {
  const cap = captureLog(t);
  assert.equal(await search(["--help"]), 0);
  assert.equal(await runCmd(["--help"]), 0);
  const text = cap.text();
  assert.equal((text.match(/--rerank <mode>/g) || []).length, 2);
  assert.match(text, /catalog\.selat\.ai/);
});
