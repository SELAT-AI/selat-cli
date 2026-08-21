import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SKILL_NAME = "selat-discovery";
export const SKILL_PACKAGE = "@selat-ai/selat-discovery";
export const SKILL_ENV_VAR = "SELAT_SKILL_PATH";
// The plugin runtime has a reviewed discovery dependency alongside selat-pay.
// A local checkout is useful during development, but must not silently replace
// that reviewed planner in a payment-capable host integration.
export const PLUGIN_RUNTIME_ENV_VAR = "SELAT_PLUGIN_RUNTIME";
export const ALLOW_LOCAL_SKILL_ENV_VAR = "SELAT_ALLOW_LOCAL_SKILL";

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
  const packaged = packagedSkillPath();
  const pluginRuntime = process.env[PLUGIN_RUNTIME_ENV_VAR] === "1";
  const localOverride = process.env[SKILL_ENV_VAR];

  // A plugin installs a reviewed CLI + discovery + payment closure. Preserve
  // that closure by selecting its bundled planner unless a developer sets BOTH
  // the local path and a separate acknowledgement. SELAT_SKILL_PATH alone
  // remains sufficient outside plugin mode for existing local workflows.
  if (pluginRuntime) {
    if (localOverride && process.env[ALLOW_LOCAL_SKILL_ENV_VAR] === "1") return [localOverride];
    return packaged ? [packaged] : [];
  }

  if (localOverride) return [localOverride];
  // Prefer an explicit local checkout in ordinary development/manual installs,
  // then fall back to the copy bundled as an npm dependency.
  const candidates = [
    defaultSkillPath(),
    join(homedir(), ".claude", "skills", SKILL_NAME)
  ];
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
