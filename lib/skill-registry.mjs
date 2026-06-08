/**
 * Selat skill registry — discover, load, install, compile, and invoke skills.
 *
 * A "skill" is a declarative JSON manifest (manifest.json) describing one or
 * more catalogue endpoint steps. Each step compiles to a single selat-pay argv,
 * which is spawned exactly like lib/commands/run.mjs does (resolveSelatPay() +
 * sh() + the bundled-PATH trick). Manifests are inert data — no executable code
 * — so installing a skill from an untrusted path never runs anything; the worst
 * a bad manifest can do is point at a URL, still bounded by --max-amount and
 * selat-pay's own https warning.
 *
 * Named `skill-registry` (not `skills`) to avoid a one-letter collision with the
 * existing lib/skill.mjs, which is the unrelated rank.mjs skill-finder.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";

import { sh } from "./sh.mjs";
import { resolveSelatPay } from "./selat-pay.mjs";
import { skillsDir } from "./config.mjs";

const SCHEMA = "selat-skill/v1";
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const BODY_METHODS = ["POST", "PUT", "PATCH"];

// Skill *content* lives in a separate, public repo (SELAT-AI/selat-skills);
// this CLI only lists, installs, and runs skills. Skills are installed on demand
// into the user skills dir by fetching the manifest anonymously over
// raw.githubusercontent.com — no GitHub auth required. For local development,
// point SELAT_SKILLS_DIR at a checkout of the repo to skip the network.
const SKILLS_REPO = process.env.SELAT_SKILLS_REPO || "SELAT-AI/selat-skills";
const SKILLS_REF = process.env.SELAT_SKILLS_REF || "main";
const SKILLS_RAW_BASE = process.env.SELAT_SKILLS_RAW_BASE || "https://raw.githubusercontent.com";

/** Skills the user installed, under $XDG_CONFIG_HOME/selat/skills. */
export function userSkillsDir() {
  return skillsDir();
}

/** Optional local checkout of the selat-skills repo (dev override). */
function devSkillsRoot() {
  return process.env.SELAT_SKILLS_DIR || null;
}

/**
 * Fetch a file from the public selat-skills repo over raw.githubusercontent.com.
 * Anonymous — no GitHub auth required. Returns the raw file contents.
 */
async function fetchSkillFile(repoPath) {
  const rawUrl = `${SKILLS_RAW_BASE}/${SKILLS_REPO}/${SKILLS_REF}/${repoPath}`;
  let res;
  try {
    res = await fetch(rawUrl);
  } catch (e) {
    throw new Error(`could not reach ${rawUrl}: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    throw new Error(`could not fetch ${repoPath} from ${SKILLS_REPO} (HTTP ${res.status}) — check the skill name`);
  }
  return await res.text();
}

// ── Manifest loading & validation ──────────────────────────────────────────

export function validateManifest(manifest, { dir } = {}) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest.json is not a JSON object");
  }
  if (manifest.schema !== SCHEMA) {
    throw new Error(`unsupported skill schema ${manifest.schema ?? "(none)"}; expected ${SCHEMA}`);
  }
  if (typeof manifest.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
    throw new Error("manifest.name must be a kebab-case identifier");
  }
  if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) {
    throw new Error("manifest.steps must be a non-empty array");
  }
  for (const [i, step] of manifest.steps.entries()) {
    if (!step || typeof step !== "object") throw new Error(`step ${i} is not an object`);
    const method = String(step.method ?? "").toUpperCase();
    if (!HTTP_METHODS.includes(method)) {
      throw new Error(`step ${i}: method must be one of ${HTTP_METHODS.join(", ")}`);
    }
    if (typeof step.url !== "string" || !step.url) {
      throw new Error(`step ${i}: url is required`);
    }
  }
  if (manifest.params && typeof manifest.params !== "object") {
    throw new Error("manifest.params must be an object");
  }
  return manifest;
}

export async function loadManifest(dir) {
  const raw = await readFile(join(dir, "manifest.json"), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${join(dir, "manifest.json")}`);
  }
  return validateManifest(parsed, { dir });
}

async function readSkillsFrom(baseDir, source) {
  if (!existsSync(baseDir)) return [];
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(baseDir, ent.name);
    if (!existsSync(join(dir, "manifest.json"))) continue;
    try {
      const manifest = await loadManifest(dir);
      out.push({
        name: manifest.name,
        description: manifest.description ?? "",
        source,
        dir,
        manifest
      });
    } catch {
      // skip malformed skill folders rather than failing the whole list
    }
  }
  return out;
}

/**
 * List installed skills (user skills dir). When SELAT_SKILLS_DIR is set, its
 * skills are also listed (as a dev convenience); installed skills win on a
 * name clash.
 */
export async function listSkills() {
  const byName = new Map();
  const dev = devSkillsRoot();
  if (dev) {
    for (const s of await readSkillsFrom(join(dev, "skills"), "dev")) byName.set(s.name, s);
  }
  for (const s of await readSkillsFrom(userSkillsDir(), "user")) byName.set(s.name, s); // installed wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a single installed skill by name (user dir first, then dev dir). */
export async function resolveSkill(name) {
  const all = await listSkills();
  return all.find((s) => s.name === name) ?? null;
}

/**
 * List skills *available* to install from the selat-skills registry (its
 * index.json). Uses SELAT_SKILLS_DIR when set, otherwise fetches via `gh`.
 * Returns the catalog array ([{ name, rail, kind, description }]).
 */
export async function listAvailable() {
  let raw;
  const dev = devSkillsRoot();
  if (dev && existsSync(join(dev, "index.json"))) {
    raw = await readFile(join(dev, "index.json"), "utf8");
  } else {
    raw = await fetchSkillFile("index.json");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("selat-skills index.json is not valid JSON");
  }
  return Array.isArray(parsed.skills) ? parsed.skills : [];
}

// ── Install ─────────────────────────────────────────────────────────────────

// A src is treated as a local path (not a registry skill name) when it looks
// like one: contains a slash, ends in .json, starts with . or ~, or exists.
function looksLikePath(src) {
  return src.includes("/") || src.includes("\\") || src.endsWith(".json") ||
    src.startsWith(".") || src.startsWith("~") || existsSync(src);
}

/**
 * Install a skill into the user skills dir, either:
 *   - by name from the selat-skills registry (install-on-demand: SELAT_SKILLS_DIR
 *     if set, otherwise fetched via `gh` from the private repo), or
 *   - from a local path (a folder containing manifest.json, or a manifest.json).
 * Validates before writing; refuses to overwrite unless force. Returns { name, dir, source }.
 */
export async function installSkill(src, { force = false } = {}) {
  if (!src) throw new Error("install requires a skill name or a path to a manifest.json");

  let raw;
  let source;
  if (looksLikePath(src)) {
    const manifestPath = src.endsWith(".json") ? src : join(src, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`no manifest.json found at ${manifestPath}`);
    raw = await readFile(manifestPath, "utf8");
    source = "path";
  } else {
    const dev = devSkillsRoot();
    const devPath = dev ? join(dev, "skills", src, "manifest.json") : null;
    if (devPath && existsSync(devPath)) {
      raw = await readFile(devPath, "utf8");
      source = "dev";
    } else {
      raw = await fetchSkillFile(`skills/${src}/manifest.json`);
      source = SKILLS_REPO;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in skill manifest for '${src}'`);
  }
  const manifest = validateManifest(parsed);
  if (!looksLikePath(src) && manifest.name !== src) {
    throw new Error(`manifest name '${manifest.name}' does not match requested skill '${src}'`);
  }

  const destDir = join(userSkillsDir(), manifest.name);
  if (existsSync(join(destDir, "manifest.json")) && !force) {
    throw new Error(`skill '${manifest.name}' is already installed; pass --force to overwrite`);
  }
  await mkdir(destDir, { recursive: true });
  // Re-serialize the validated manifest (canonical, pretty) rather than copying
  // bytes, so only well-formed data lands in the user dir.
  await writeFile(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { name: manifest.name, dir: destDir, source };
}

// ── Param substitution & compilation ────────────────────────────────────────

/**
 * Merge CLI-supplied params over manifest defaults, enforcing required params.
 * Throws an Error (with .paramKey / .paramDescription) on a missing required
 * param so the command layer can print a friendly message.
 */
export function resolveParams(manifest, cliParams = {}) {
  const specs = manifest.params ?? {};
  const merged = {};
  for (const [key, spec] of Object.entries(specs)) {
    if (cliParams[key] != null) {
      merged[key] = cliParams[key];
    } else if (spec && spec.default != null) {
      merged[key] = spec.default;
    } else if (spec && spec.required) {
      const err = new Error(`missing required --${key}`);
      err.paramKey = key;
      err.paramDescription = spec?.description ?? "";
      throw err;
    }
  }
  // Allow params not declared in the manifest (pass-through), CLI value wins.
  for (const [key, value] of Object.entries(cliParams)) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

/**
 * Replace ${key} / ${key|join} tokens in a template string. When urlEncode is
 * true, each substituted VALUE is encodeURIComponent'd (the surrounding
 * template is left untouched) — correct for query values like ETH,USDC.
 */
export function substitute(template, params, { urlEncode = false } = {}) {
  return String(template).replace(/\$\{([a-zA-Z0-9_]+)(\|join)?\}/g, (_, key, join) => {
    let value = params[key];
    if (value == null) {
      throw new Error(`unknown parameter \${${key}} in template`);
    }
    if (join && Array.isArray(value)) value = value.join(",");
    value = String(value);
    return urlEncode ? encodeURIComponent(value) : value;
  });
}

function substituteDeep(value, params) {
  if (typeof value === "string") return substitute(value, params, { urlEncode: false });
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, params);
    return out;
  }
  return value;
}

/**
 * Compile a single manifest step into a selat-pay argv (without the leading
 * "selat-pay"). Mirrors the safety checks in run.mjs validateSelatPayArgv:
 * known method, no control characters. `overrides` (from reserved CLI flags)
 * take precedence over per-step then manifest-level chain / maxAmount.
 * Returns { argv, display }.
 */
export function compileStep(manifest, step, params, overrides = {}) {
  const method = String(step.method).toUpperCase();
  if (!HTTP_METHODS.includes(method)) {
    throw new Error(`unsupported method: ${step.method}`);
  }
  const chain = overrides.chain ?? step.chain ?? manifest.chain;
  const maxAmount = overrides.maxAmount ?? step.maxAmount ?? manifest.maxAmount;
  if (!chain) throw new Error("no chain set (step, manifest, or --chain)");
  if (maxAmount == null) throw new Error("no maxAmount set (step, manifest, or --max-amount)");

  const url = substitute(step.url, params, { urlEncode: true });
  const argv = [method, url, "--chain", String(chain), "--max-amount", String(maxAmount)];

  if (step.body != null && BODY_METHODS.includes(method)) {
    const body =
      typeof step.body === "string"
        ? substitute(step.body, params, { urlEncode: false })
        : JSON.stringify(substituteDeep(step.body, params));
    argv.push("--body", body);
  }

  for (const a of argv) {
    if (/[\0\r\n]/.test(a)) throw new Error("compiled argv contains a control character");
  }
  return { argv, display: argv.map(shellQuoteForDisplay).join(" ") };
}

// ── Invocation ───────────────────────────────────────────────────────────────

/**
 * Run a skill: resolve it, merge params, then run each step's compiled
 * selat-pay command. By default every step runs even if an earlier one fails
 * (continueOnError), so a multi-rail showcase always exercises all rails; set
 * continueOnError:false to abort on the first failure.
 *
 * `onStep` is an optional callback ({ index, step, display, total }) for UI.
 * Returns { code, steps } where code is 0 only if every step succeeded and
 * steps is a per-step result array ({ index, label, rail, code, ok, error? }).
 */
export async function invokeSkill(name, cliParams = {}, { overrides = {}, onStep, continueOnError = true } = {}) {
  const skill = await resolveSkill(name);
  if (!skill) throw new Error(`skill '${name}' is not installed — run \`selat skill install ${name}\``);

  const selatPay = await resolveSelatPay();
  if (selatPay.source === null) {
    const err = new Error("selat-pay not found — reinstall selat-cli, or install selat-pay globally.");
    err.selatPayMissing = true;
    throw err;
  }
  const env =
    selatPay.source === "bundled"
      ? { PATH: `${selatPay.binDir}${delimiter}${process.env.PATH ?? ""}` }
      : {};

  const params = resolveParams(skill.manifest, cliParams);
  const total = skill.manifest.steps.length;
  const results = [];

  for (const [index, step] of skill.manifest.steps.entries()) {
    const base = { index, label: step.label ?? null, rail: step.rail ?? null };
    try {
      const { argv, display } = compileStep(skill.manifest, step, params, overrides);
      if (onStep) onStep({ index, step, display, total });
      const res = await sh("selat-pay", argv, { inherit: true, env });
      results.push({ ...base, code: res.code, ok: res.code === 0 });
    } catch (err) {
      console.error(`  step ${index + 1}/${total} failed: ${err.message ?? err}`);
      results.push({ ...base, code: 1, ok: false, error: err.message ?? String(err) });
    }
    if (!results[results.length - 1].ok && !continueOnError) break;
  }

  const code = results.every((r) => r.ok) ? 0 : 1;
  return { code, steps: results };
}

function shellQuoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── Authoring: scaffold & validate (contribution flow) ──────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Required SKILL.md body sections per the Agent Skill SOP. */
const REQUIRED_SECTIONS = [
  "When To Use",
  "Workflow",
  "Inputs And Outputs",
  "Gotchas",
  "Validation",
  "References"
];

function scaffoldManifest(name) {
  return JSON.stringify({
    schema: SCHEMA,
    name,
    description: `TODO one-line description of ${name} (shown in the catalog)`,
    chain: "base",
    maxAmount: "0.01",
    params: {
      example: { required: true, description: "TODO describe this param; reference it as ${example} in url/body" }
    },
    steps: [
      {
        label: "TODO step label — Provider (rail)",
        rail: "direct",
        method: "GET",
        url: "https://TODO-upstream/endpoint?q=${example}"
      }
    ]
  }, null, 2) + "\n";
}

function scaffoldSkillMd(name) {
  return `---
name: ${name}
description: Use this skill when the user wants TODO — e.g. "TODO trigger phrase", "TODO another phrasing". TODO one sentence on what it does and which rail it pays over. (Keep under 1024 chars.)
license: Apache-2.0
compatibility: Requires the selat CLI, selat-pay >= 0.3.2, and a funded Circle Agent Wallet on Base.
metadata:
  author: TODO
  version: "1.0"
  rail: direct
  kind: single
---

# ${name}

## When To Use

TODO when an agent should pick this skill.

## Workflow

1. Install: \`selat skill install ${name}\`
2. Run: \`selat skill run ${name} --example <value>\`
3. The CLI compiles each step into a \`selat-pay\` call and prints the result.

Step: **Provider** \`METHOD /path\` — DIRECT or ROUTED.

## Inputs And Outputs

| Param | Required | Default | Description |
|---|---|---|---|
| \`example\` | yes | — | TODO |

Output: TODO describe the response shape.

## Gotchas

- TODO required params / units / rail dependencies / cost cap.

## Validation

- Probe (no pay): \`selat-pay GET "https://TODO-upstream/endpoint" --chain base --probe-only\`
- A successful run prints \`status=200\`.

## References

- \`manifest.json\` — the machine-readable payment recipe this skill runs.
- [\`references/endpoints.md\`](references/endpoints.md) — the catalogue endpoint(s) this skill calls.
- [\`references/agent-skill-authoring-sop.md\`](../../references/agent-skill-authoring-sop.md) — authoring standard.
- selat-pay — https://github.com/SELAT-AI/selat-pay
`;
}

function scaffoldEndpointsMd(name) {
  return `# Endpoints — ${name}

| Step | Method | URL | Rail | ~Price |
|---|---|---|---|---|
| TODO | GET | \`https://TODO-upstream/endpoint\` | direct (Gateway-batched) | $0.00 |

- **Provider:** TODO
- **Payment:** TODO (direct Circle nanopayment, or routed via the SELAT Router).
`;
}

function scaffoldEvalsJson(name) {
  return JSON.stringify({
    skill_name: name,
    evals: [
      { id: "trigger-1", prompt: "TODO a request that SHOULD trigger this skill", expected_output: "TODO", assertions: ["TODO"] },
      { id: "notrigger-1", prompt: "TODO a request that should NOT trigger this skill", expected_output: "Skill does not trigger.", assertions: [`${name} is not selected`] }
    ]
  }, null, 2) + "\n";
}

/**
 * Scaffold a new skill folder per the SOP (manifest.json + SKILL.md +
 * references/endpoints.md + evals/evals.json). Returns { dir, files }.
 */
export async function scaffoldSkill(name, { dir = ".", force = false } = {}) {
  if (!name || !NAME_RE.test(name)) {
    throw new Error("skill name must be kebab-case (lowercase letters, numbers, hyphens)");
  }
  const target = resolve(dir, name);
  if (existsSync(join(target, "manifest.json")) && !force) {
    throw new Error(`${join(target, "manifest.json")} already exists; pass --force to overwrite`);
  }
  await mkdir(join(target, "references"), { recursive: true });
  await mkdir(join(target, "evals"), { recursive: true });
  const files = [
    ["manifest.json", scaffoldManifest(name)],
    ["SKILL.md", scaffoldSkillMd(name)],
    [join("references", "endpoints.md"), scaffoldEndpointsMd(name)],
    [join("evals", "evals.json"), scaffoldEvalsJson(name)]
  ];
  for (const [rel, content] of files) await writeFile(join(target, rel), content, "utf8");
  return { dir: target, files: files.map(([rel]) => rel) };
}

function parseFrontmatterName(skillMd) {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const nm = m[1].match(/^name:\s*(.+)$/m);
  return nm ? nm[1].trim() : null;
}

/**
 * Validate a skill directory against the SOP. Returns
 * { ok, name, errors[], warnings[] }. Errors block; warnings are advisory.
 */
export async function validateSkillDir(dir) {
  const errors = [];
  const warnings = [];
  const folder = basename(resolve(dir));

  // manifest.json (required)
  let manifest = null;
  if (!existsSync(join(dir, "manifest.json"))) {
    errors.push("missing manifest.json");
  } else {
    try {
      manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    } catch {
      errors.push("manifest.json is not valid JSON");
    }
    if (manifest) {
      try {
        validateManifest(manifest);
        if (manifest.name !== folder) errors.push(`manifest.name '${manifest.name}' must equal folder name '${folder}'`);
      } catch (e) {
        errors.push(`manifest: ${e.message ?? e}`);
      }
    }
  }

  // SKILL.md (required by SOP)
  if (!existsSync(join(dir, "SKILL.md"))) {
    errors.push("missing SKILL.md");
  } else {
    const md = await readFile(join(dir, "SKILL.md"), "utf8");
    const fmName = parseFrontmatterName(md);
    if (!fmName) errors.push("SKILL.md missing YAML frontmatter with a name");
    else if (fmName !== folder) errors.push(`SKILL.md frontmatter name '${fmName}' must equal folder name '${folder}'`);
    if (!/^description:\s*\S/m.test(md)) errors.push("SKILL.md frontmatter missing description");
    for (const s of REQUIRED_SECTIONS) {
      if (!new RegExp(`^##\\s+${s}\\s*$`, "m").test(md)) warnings.push(`SKILL.md missing section: ## ${s}`);
    }
    if (/\bTODO\b/.test(md)) warnings.push("SKILL.md still contains TODO placeholders");
  }

  // evals/evals.json (required by SOP)
  if (!existsSync(join(dir, "evals", "evals.json"))) {
    warnings.push("missing evals/evals.json");
  } else {
    try {
      const ev = JSON.parse(await readFile(join(dir, "evals", "evals.json"), "utf8"));
      if (ev.skill_name && ev.skill_name !== folder) errors.push(`evals.json skill_name '${ev.skill_name}' must equal folder name '${folder}'`);
      if (!Array.isArray(ev.evals) || ev.evals.length === 0) warnings.push("evals.json has no evals");
    } catch {
      errors.push("evals/evals.json is not valid JSON");
    }
  }

  // references/endpoints.md (recommended)
  if (!existsSync(join(dir, "references", "endpoints.md"))) {
    warnings.push("missing references/endpoints.md");
  }

  return { ok: errors.length === 0, name: manifest?.name ?? folder, errors, warnings };
}
