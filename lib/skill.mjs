import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SKILL_NAME = "selat-discovery";
export const SKILL_PACKAGE = "@selat-ai/selat-discovery";
export const SKILL_ENV_VAR = "SELAT_SKILL_PATH";

export function defaultSkillPath() {
  return join(homedir(), ".codex", "skills", SKILL_NAME);
}

// The skill ships as an npm dependency of this CLI. Resolve its package root
// from node_modules; returns null if it isn't installed alongside the CLI.
export function packagedSkillPath() {
  try {
    const require = createRequire(import.meta.url);
    return dirname(require.resolve(`${SKILL_PACKAGE}/package.json`));
  } catch {
    return null;
  }
}

export function skillCandidates() {
  if (process.env[SKILL_ENV_VAR]) return [process.env[SKILL_ENV_VAR]];
  // Prefer an explicit local checkout in the agent skills dirs (dev / manual
  // install), then fall back to the copy bundled as an npm dependency.
  const candidates = [
    defaultSkillPath(),
    join(homedir(), ".claude", "skills", SKILL_NAME)
  ];
  const packaged = packagedSkillPath();
  if (packaged) candidates.push(packaged);
  return candidates;
}

export function findSkill(requiredScript = "rank.mjs") {
  const checked = skillCandidates();
  const found = checked.find((path) => existsSync(join(path, "scripts", requiredScript)));
  return {
    found: Boolean(found),
    path: found || checked[0],
    checked,
    requiredScript
  };
}

export function skillPackageVersion(skillPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(skillPath, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

export function skillSource(skillPath) {
  const packaged = packagedSkillPath();
  if (packaged && skillPath === packaged) return "bundled";
  if (process.env[SKILL_ENV_VAR] && skillPath === process.env[SKILL_ENV_VAR]) return "env-override";
  return "local";
}

export function skillInstallLines() {
  return [
    "The agent-payment skill ships with selat-cli but could not be found.",
    "Reinstall the CLI to restore it:",
    "  npm install -g @selat-ai/selat-cli",
    `Or set ${SKILL_ENV_VAR} to a local checkout of the skill.`
  ];
}
