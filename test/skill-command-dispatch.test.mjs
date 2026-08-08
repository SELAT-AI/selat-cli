import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { firstPositional, skill } from "../lib/commands/skill.mjs";

// `selat skill` is the widest subcommand surface, and every branch below runs
// before any network call or spend: dispatch, usage errors, and the authoring
// subcommands that only touch the filesystem. Anything that would probe or pay
// is exercised through an argument error instead.

const tmp = () => mkdtemp(join(tmpdir(), "selat-skill-cmd-"));

/** Swallow the command's own console output so test output stays readable. */
function quiet(t) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
}

test("skill with no subcommand prints usage and fails; explicit help succeeds", async (t) => {
  quiet(t);
  assert.equal(await skill([]), 1, "a bare `selat skill` is a usage error");
  for (const help of ["--help", "-h", "help"]) {
    assert.equal(await skill([help]), 0, `${help} is a successful help request`);
  }
});

test("skill rejects an unknown subcommand", async (t) => {
  quiet(t);
  assert.equal(await skill(["frobnicate"]), 1);
});

test("skill new scaffolds a folder and reports a bad name as a usage error", async (t) => {
  quiet(t);
  const dir = await tmp();
  assert.equal(await skill(["new", "my-skill", "--dir", dir]), 0);
  assert.ok(existsSync(join(dir, "my-skill", "manifest.json")));

  assert.equal(await skill(["new", "--dir", dir]), 1, "no name given");
  assert.equal(await skill(["new", "My-Skill", "--dir", dir]), 1, "not kebab-case");
  assert.equal(await skill(["new", "my-skill", "--dir", dir]), 1, "would overwrite without --force");
  assert.equal(await skill(["new", "my-skill", "--dir", dir, "--force"]), 0);
});

test("skill validate exits 0 on a scaffolded skill and 1 once it is broken", async (t) => {
  quiet(t);
  const dir = await tmp();
  await skill(["new", "my-skill", "--dir", dir]);
  const skillDir = join(dir, "my-skill");
  assert.equal(await skill(["validate", skillDir]), 0, "warnings alone don't fail validation");

  const manifest = JSON.parse(await readFile(join(skillDir, "manifest.json"), "utf8"));
  manifest.name = "renamed";
  await writeFile(join(skillDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  assert.equal(await skill(["validate", skillDir]), 1);

  assert.equal(await skill(["validate"]), 1, "no path given");
});

test("skill install/verify/register/submit each refuse to run without a target", async (t) => {
  quiet(t);
  for (const sub of ["install", "verify", "register", "submit"]) {
    assert.equal(await skill([sub]), 1, `${sub} without a target is a usage error`);
  }
});

test("skill verify accepts --json without crashing, and fails on a missing skill", async (t) => {
  quiet(t);
  // --json used to assign an undeclared `jsonMode`, throwing a ReferenceError
  // before verification even started.
  assert.equal(await skill(["verify", join(tmpdir(), "selat-no-such-skill"), "--json"]), 1);
});

test("skill verify surfaces a missing required param as a usage error", async (t) => {
  quiet(t);
  const dir = await tmp();
  await skill(["new", "my-skill", "--dir", dir]);
  // The scaffold declares a required `example` param, so verification stops
  // before it ever probes an endpoint.
  assert.equal(await skill(["verify", join(dir, "my-skill")]), 1);
});

test("skill register reports an unregisterable path rather than throwing", async (t) => {
  quiet(t);
  assert.equal(await skill(["register", join(tmpdir(), "selat-no-such-skill")]), 1);
});

// firstPositional is what keeps a flag's value from being read as the path.

test("firstPositional skips value-taking flags but not bare ones", () => {
  assert.equal(firstPositional(["verify", "--max-amount", "0.05", "./skill"]), "verify");
  assert.equal(firstPositional(["--max-amount", "0.05", "./skill"]), "./skill");
  assert.equal(firstPositional(["--pay", "./skill"]), "./skill", "--pay takes no value");
  assert.equal(firstPositional(["--force", "--dry-run", "./skill"]), "./skill");
  assert.equal(firstPositional(["--chain", "base"]), undefined);
  assert.equal(firstPositional([]), undefined);
});
