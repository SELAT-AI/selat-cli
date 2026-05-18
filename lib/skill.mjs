import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILL_NAME = "runtime-integration-and-discovery";
export const SKILL_REPO_URL = "https://github.com/MyJuris/juris-agent-payments";
export const SKILL_ENV_VAR = "JURIS_SKILL_PATH";

export function defaultSkillPath() {
  return join(homedir(), ".codex", "skills", SKILL_NAME);
}

export function skillCandidates() {
  if (process.env[SKILL_ENV_VAR]) return [process.env[SKILL_ENV_VAR]];
  return [
    defaultSkillPath(),
    join(homedir(), ".claude", "skills", SKILL_NAME)
  ];
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

export function skillInstallLines(path = defaultSkillPath()) {
  return [
    "Install the agent-payment skill first:",
    `  git clone ${SKILL_REPO_URL} ${path}`,
    `  cd ${path} && npm install`,
    `Or set ${SKILL_ENV_VAR} to its installed location.`
  ];
}
