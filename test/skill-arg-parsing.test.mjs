import test from "node:test";
import assert from "node:assert/strict";

import { firstPositional } from "../lib/commands/skill.mjs";
import { validateManifest } from "../lib/skill-registry.mjs";

// firstPositional must not mistake a value-taking flag's value for the
// positional path/name (issue #17). `args.find(a => !a.startsWith("--"))` did.

test("firstPositional skips value-flag values to find the real positional", () => {
  // The cap value 0.05 must NOT be taken as the path.
  assert.equal(firstPositional(["--max-amount", "0.05", "./skills/foo"]), "./skills/foo");
  assert.equal(firstPositional(["--chain", "base", "--symbols", "ETH", "./skills/foo"]), "./skills/foo");
  // Positional first still works.
  assert.equal(firstPositional(["./skills/foo", "--pay"]), "./skills/foo");
  // Bare flags don't consume the next token.
  assert.equal(firstPositional(["--pay", "./skills/foo"]), "./skills/foo");
  assert.equal(firstPositional(["--force", "market-snapshot"]), "market-snapshot");
  // No positional → undefined.
  assert.equal(firstPositional(["--max-amount", "0.05"]), undefined);
  assert.equal(firstPositional([]), undefined);
});

// A manifest must not declare a body on a method that drops it (issue #17):
// compileStep only forwards a body for POST/PUT/PATCH.

test("validateManifest rejects a body on GET/DELETE instead of silently dropping it", () => {
  const withBody = (method) => ({
    schema: "selat-skill/v1",
    name: "demo",
    steps: [{ method, url: "https://api.example.com/x", body: { q: 1 } }],
  });
  assert.throws(() => validateManifest(withBody("GET")), /body is not allowed for GET/);
  assert.throws(() => validateManifest(withBody("DELETE")), /body is not allowed for DELETE/);
  // Body on a body-method is fine.
  assert.doesNotThrow(() => validateManifest(withBody("POST")));
});
