import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  SKILL_ENV_VAR,
  SKILL_NAME,
  PLUGIN_RUNTIME_ENV_VAR,
  ALLOW_LOCAL_SKILL_ENV_VAR,
  defaultSkillPath,
  findSkill,
  packagedSkillPath,
  skillPackageVersion,
  skillCandidates,
  skillInstallLines,
  skillSource
} from "../lib/skill.mjs";

// Every delegating command (run/search/history/spend) locates the discovery
// skill through findSkill(). Its candidate ORDER is what lets a dev checkout
// shadow the npm-bundled copy, and the env override has to win outright.

function withEnv(value, fn) {
  const prev = process.env[SKILL_ENV_VAR];
  if (value === undefined) delete process.env[SKILL_ENV_VAR];
  else process.env[SKILL_ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[SKILL_ENV_VAR];
    else process.env[SKILL_ENV_VAR] = prev;
  }
}

/** A skill dir containing scripts/<script>. */
function fakeSkill(scripts = ["rank.mjs"]) {
  const dir = mkdtempSync(join(tmpdir(), "selat-skill-"));
  mkdirSync(join(dir, "scripts"));
  for (const s of scripts) writeFileSync(join(dir, "scripts", s), "");
  return dir;
}

test("defaultSkillPath points at the agent skills dir in $HOME", () => {
  assert.equal(defaultSkillPath(), join(homedir(), ".codex", "skills", SKILL_NAME));
});

test("SELAT_SKILL_PATH is the only candidate when set", () => {
  withEnv("/checkouts/selat-discovery", () => {
    assert.deepEqual(skillCandidates(), ["/checkouts/selat-discovery"]);
  });
});

test("candidates prefer local checkouts over the npm-bundled copy", () => {
  withEnv(undefined, () => {
    const candidates = skillCandidates();
    assert.equal(candidates[0], defaultSkillPath());
    assert.equal(candidates[1], join(homedir(), ".claude", "skills", SKILL_NAME));
    assert.equal(candidates.at(-1), packagedSkillPath(), "the bundled dependency is the last resort");
  });
});

test("packagedSkillPath resolves the bundled dependency's package root", () => {
  assert.match(packagedSkillPath(), /selat-discovery$/);
});

test("findSkill reports the dir holding the required script", () => {
  const dir = fakeSkill(["rank.mjs", "setup.mjs"]);
  withEnv(dir, () => {
    const found = findSkill();
    assert.equal(found.found, true);
    assert.equal(found.path, dir);
    assert.equal(found.requiredScript, "rank.mjs");
    assert.deepEqual(found.checked, [dir]);
    assert.equal(findSkill("setup.mjs").found, true);
  });
});

test("skillPackageVersion and skillSource describe local overrides", () => {
  const dir = fakeSkill(["rank.mjs"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@selat-ai/selat-discovery", version: "0.1.2" }));
  withEnv(dir, () => {
    assert.equal(skillPackageVersion(dir), "0.1.2");
    assert.equal(skillSource(dir), "env-override");
  });
});

test("findSkill misses when the candidate lacks that particular script", () => {
  const dir = fakeSkill(["rank.mjs"]);
  withEnv(dir, () => {
    const missing = findSkill("spend_report.mjs");
    assert.equal(missing.found, false);
    assert.equal(missing.requiredScript, "spend_report.mjs");
    assert.equal(missing.path, dir, "falls back to the first candidate so callers can name it");
  });
});

test("findSkill on a nonexistent override reports the checked path, not a crash", () => {
  const nowhere = join(tmpdir(), "selat-no-such-skill");
  withEnv(nowhere, () => {
    const res = findSkill();
    assert.equal(res.found, false);
    assert.deepEqual(res.checked, [nowhere]);
  });
});

function withPluginEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("plugin mode ignores a local skill unless the developer acknowledgement is set", () => {
  const local = fakeSkill(["rank.mjs"]);
  withPluginEnv({
    [PLUGIN_RUNTIME_ENV_VAR]: "1",
    [SKILL_ENV_VAR]: local,
    [ALLOW_LOCAL_SKILL_ENV_VAR]: undefined,
  }, () => {
    assert.deepEqual(skillCandidates(), [packagedSkillPath()]);
    assert.equal(findSkill().path, packagedSkillPath());
  });
});

test("plugin mode permits an explicitly acknowledged local developer skill", () => {
  const local = fakeSkill(["rank.mjs"]);
  withPluginEnv({
    [PLUGIN_RUNTIME_ENV_VAR]: "1",
    [SKILL_ENV_VAR]: local,
    [ALLOW_LOCAL_SKILL_ENV_VAR]: "1",
  }, () => {
    assert.deepEqual(skillCandidates(), [local]);
    assert.equal(findSkill().path, local);
  });
});

test("skillInstallLines tell the user how to restore the skill", () => {
  const lines = skillInstallLines();
  assert.ok(lines.some((l) => l.includes("npm install -g @selat-ai/selat-cli")));
  assert.ok(lines.some((l) => l.includes(SKILL_ENV_VAR)));
});
