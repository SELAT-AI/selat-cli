import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const selatBin = fileURLToPath(new URL("../bin/selat.mjs", import.meta.url));

// `skill verify --json` previously crashed with "jsonMode is not defined"
// (ReferenceError from a half-wired flag). #105 stopped the crash by ignoring
// --json; this makes it emit the canonical selat-verify/v1 receipt so verify
// matches its --json-emitting siblings (run, compare). A consumer piping the
// output through JSON.parse must ALWAYS get JSON — including on failure.

async function run(args) {
  try {
    const { stdout } = await pexec("node", [selatBin, ...args]);
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "" };
  }
}

test("skill verify --json emits parseable JSON on the error path, never a crash or prose", async () => {
  // A non-existent path can't load a manifest — deterministic, no network.
  const { code, stdout } = await run(["skill", "verify", "/definitely/not/a/skill", "--json"]);
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout); // throws (failing the test) if it isn't JSON
  assert.equal(parsed.schema, "selat-verify/v1");
  assert.equal(parsed.ok, false);
  assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  // and no human chatter leaked onto stdout before/after the JSON
  assert.equal(stdout.trim().startsWith("{"), true);
  assert.equal(stdout.trim().endsWith("}"), true);
});

test("skill verify (no --json) stays human and does NOT emit JSON", async () => {
  const { stdout } = await run(["skill", "verify", "/definitely/not/a/skill"]);
  assert.throws(() => JSON.parse(stdout.trim() || "not-json"));
});
