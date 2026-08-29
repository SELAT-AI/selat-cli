// --allow-unlisted: explicit per-call opt-out of the catalog gate for a
// pinned URL. Seam tests pin the parse and the rank.mjs argv so the flag
// cannot drift from the spawn, and the guards that make it safe to offer:
// never without --endpoint, never implied.
import test from "node:test";
import assert from "node:assert/strict";

import { parseRunArgs, rankPickArgv, KNOWN_RUN_FLAGS, pinRefusal } from "../lib/commands/run.mjs";

test("--allow-unlisted is a known flag and parses with --endpoint", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--allow-unlisted"));
  const parsed = parseRunArgs(["paid delivery check", "--endpoint", "https://api.x.dev/v1", "--allow-unlisted"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.allowUnlisted, true);
  assert.equal(parsed.endpoint, "https://api.x.dev/v1");
});

test("--allow-unlisted without --endpoint is refused at parse time", () => {
  const parsed = parseRunArgs(["paid delivery check", "--allow-unlisted"]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /--allow-unlisted requires --endpoint/);
});

test("rankPickArgv forwards --allow-unlisted only alongside a pin", () => {
  assert.deepEqual(
    rankPickArgv({ intent: "x", endpoint: "https://api.x.dev/v1", allowUnlisted: true }),
    ["x", "--pick", "--endpoint", "https://api.x.dev/v1", "--allow-unlisted"],
  );
  // Defensive: even if a caller sets the flag without a pin, it is not emitted.
  assert.deepEqual(rankPickArgv({ intent: "x", allowUnlisted: true }), ["x", "--pick"]);
  // Absent by default.
  assert.deepEqual(
    rankPickArgv({ intent: "x", endpoint: "https://api.x.dev/v1" }),
    ["x", "--pick", "--endpoint", "https://api.x.dev/v1"],
  );
});

test("the not-in-catalog refusal names the flag", () => {
  const refusal = pinRefusal(4, "https://api.x.dev/v1");
  assert.equal(refusal.reason, "endpoint-not-in-catalog");
  assert.match(refusal.error, /--allow-unlisted/);
});
