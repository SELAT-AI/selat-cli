/**
 * Selat skill registry — discover, load, install, compile, and invoke skills.
 *
 * A "skill" is a declarative JSON manifest (manifest.json) describing one or
 * more catalogue endpoint steps. Each step compiles to a single selat-pay argv,
 * which is spawned exactly like lib/commands/run.mjs does (resolveSelatPay() +
 * sh() + the bundled-PATH trick). Manifests are inert data — no executable code
 * — so installing a skill from an untrusted path never runs anything. Because a
 * manifest still controls the payment destination and the declared spend cap,
 * those are validated here: every step url must be https:// (assertSafePaymentUrl),
 * and a manifest-declared maxAmount must be a positive number within
 * MANIFEST_MAX_AMOUNT_CEILING_USD unless the user raises it with an explicit
 * --max-amount (parseMaxAmount).
 *
 * Named `skill-registry` (not `skills`) to avoid a one-letter collision with the
 * existing lib/skill.mjs, which is the unrelated rank.mjs skill-finder.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { sh, shellQuoteForDisplay } from "./sh.mjs";
import { ensureSelatPayHistoryDir, resolveSelatPay, selatPaySpawn } from "./selat-pay.mjs";
import { skillsDir } from "./config.mjs";
import { getAgentAddress, resolveFundedChainKey } from "./circle.mjs";

const SCHEMA = "selat-skill/v1";
const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const BODY_METHODS = ["POST", "PUT", "PATCH"];

// Hard ceiling on a spend cap that a *manifest* (or step) may declare on its
// own. Manifests are untrusted data fetched anonymously from a public,
// community repo, so a manifest-declared --max-amount is treated as a value to
// be bounded, not as the authority. A user who explicitly passes --max-amount
// (overrides.maxAmount) is the authority and may exceed this ceiling.
const MANIFEST_MAX_AMOUNT_CEILING_USD = 1.0;

/**
 * Validate a spend cap and return it as a finite positive number. `source`
 * labels where the value came from for the error message. When `bounded` is
 * true (the value originated from the untrusted manifest, not an explicit user
 * override), it must also fall within MANIFEST_MAX_AMOUNT_CEILING_USD.
 */
function parseMaxAmount(value, { source, bounded }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${source} "${value}" must be a positive number`);
  }
  if (bounded && n > MANIFEST_MAX_AMOUNT_CEILING_USD) {
    throw new Error(
      `${source} $${n} exceeds the per-call ceiling $${MANIFEST_MAX_AMOUNT_CEILING_USD} ` +
        `for manifest-declared caps; pass --max-amount explicitly to authorize a higher cap`
    );
  }
  return n;
}

/**
 * A skill step routes a real USDC payment to whatever URL it names, so the
 * destination must be safe before we hand it to selat-pay: a parseable https://
 * URL (http:// only for loopback, for local development). Rejects everything
 * else so an untrusted manifest cannot redirect a signed payment over plaintext
 * (MITM-rewritable payTo) or to an unexpected scheme.
 */
function assertSafePaymentUrl(url, { source = "step" } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${source} url "${url}" is not a valid URL`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopback) return parsed;
  throw new Error(
    `${source} url "${url}" must use https:// (http:// is allowed only for localhost)`
  );
}

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

export function validateManifest(manifest, { dir, maxAmountOverride, boundMaxAmounts = true } = {}) {
  const declaredCapBounded =
    boundMaxAmounts && maxAmountOverride == null;
  const overrideCap =
    maxAmountOverride == null
      ? null
      : parseMaxAmount(maxAmountOverride, { source: "--max-amount", bounded: false });

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
    // compileStep only forwards a body for BODY_METHODS, so a body declared on
    // GET/DELETE would be silently dropped — the paid call would have different
    // request semantics than the manifest declares. Reject it explicitly.
    if (step.body != null && !BODY_METHODS.includes(method)) {
      throw new Error(`step ${i}: body is not allowed for ${method} (only ${BODY_METHODS.join("/")})`);
    }
    if (typeof step.url !== "string" || !step.url) {
      throw new Error(`step ${i}: url is required`);
    }
    // Validate the scheme early when the url parses to a concrete one. A
    // templated url (e.g. "${base}/x" or "https://${host}/x") may not parse
    // until params are substituted, so compileStep enforces it authoritatively
    // on the compiled url.
    let staticUrl = null;
    try {
      staticUrl = new URL(step.url);
    } catch {
      staticUrl = null;
    }
    if (staticUrl) {
      assertSafePaymentUrl(step.url, { source: `step ${i}` });
    }
    if (step.maxAmount != null) {
      const cap = parseMaxAmount(step.maxAmount, {
        source: `step ${i} maxAmount`,
        bounded: declaredCapBounded
      });
      if (overrideCap != null && cap > overrideCap) {
        throw new Error(`step ${i} maxAmount $${cap} exceeds explicit --max-amount $${overrideCap}`);
      }
    }
  }
  if (manifest.maxAmount != null) {
    const cap = parseMaxAmount(manifest.maxAmount, {
      source: "manifest maxAmount",
      bounded: declaredCapBounded
    });
    if (overrideCap != null && cap > overrideCap) {
      throw new Error(`manifest maxAmount $${cap} exceeds explicit --max-amount $${overrideCap}`);
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
  return validateManifest(parsed, { dir, boundMaxAmounts: false });
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

/**
 * Normalize a URL to a host+path key for matching a catalog serviceUrl against
 * reliability-registry step URLs (query/fragment ignored — registry steps embed
 * sample query params). Returns null for an unparseable URL.
 */
export function reliabilityUrlKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Fetch the reliability registry (reliability.json) published by the selat-skills
 * auto-verify CI. Best-effort: returns { generatedAt, byName, byUrl } where
 * byName maps skill name → { status, reachable, total, livePriceUsd, checkedAt }
 * and byUrl maps reliabilityUrlKey(step url) → { skill, status, reachable,
 * checkedAt } (per-endpoint view; pessimistic when several skills probe the same
 * endpoint). Returns empty maps if the registry is absent or unparseable, so
 * callers degrade cleanly.
 */
export async function fetchReliability() {
  const empty = { generatedAt: null, byName: new Map(), byUrl: new Map() };
  let raw;
  try {
    const dev = devSkillsRoot();
    if (dev && existsSync(join(dev, "reliability.json"))) {
      raw = await readFile(join(dev, "reliability.json"), "utf8");
    } else {
      raw = await fetchSkillFile("reliability.json");
    }
  } catch {
    return empty; // no registry yet — caller shows "unknown"
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  const byName = new Map();
  const byUrl = new Map();
  for (const s of Array.isArray(parsed.skills) ? parsed.skills : []) {
    if (!s || !s.name) continue;
    const steps = Array.isArray(s.steps) ? s.steps : [];
    const prices = steps.map((x) => x?.livePriceUsd).filter((n) => typeof n === "number");
    byName.set(s.name, {
      status: s.status ?? "unknown",
      reachable: steps.filter((x) => x?.reachable).length,
      total: steps.length,
      livePriceUsd: prices.length ? prices.reduce((a, b) => a + b, 0) : null,
      checkedAt: s.checkedAt ?? parsed.generatedAt ?? null,
    });
    for (const st of steps) {
      if (!st?.url) continue;
      const key = reliabilityUrlKey(st.url);
      if (!key) continue;
      const prev = byUrl.get(key);
      const reachable = !!st.reachable && (prev ? prev.reachable : true);
      byUrl.set(key, {
        skill: s.name,
        status: reachable ? "ok" : "down",
        reachable,
        checkedAt: s.checkedAt ?? parsed.generatedAt ?? null,
      });
    }
  }
  return { generatedAt: parsed.generatedAt ?? null, byName, byUrl };
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
export async function installSkill(src, { force = false, maxAmount } = {}) {
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
  const manifest = validateManifest(parsed, { maxAmountOverride: maxAmount });
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
 * `defaultChain` is the last-resort fallback (auto-resolved from the wallet's
 * funded Gateway balance by the caller) used when nothing else pins a chain.
 * Returns { argv, display }.
 */
export function compileStep(manifest, step, params, overrides = {}, defaultChain = null) {
  const method = String(step.method).toUpperCase();
  if (!HTTP_METHODS.includes(method)) {
    throw new Error(`unsupported method: ${step.method}`);
  }
  const chain = overrides.chain ?? step.chain ?? manifest.chain ?? defaultChain;
  if (!chain) throw new Error("no chain set (step, manifest, --chain, or a funded Gateway balance to auto-select)");

  // An explicit --max-amount (override) is user authority and is not bounded
  // by the manifest ceiling; a cap that comes from the untrusted manifest/step
  // is. Either way it must be a positive number.
  let maxAmount;
  if (overrides.maxAmount != null) {
    maxAmount = parseMaxAmount(overrides.maxAmount, { source: "--max-amount", bounded: false });
  } else if (step.maxAmount != null || manifest.maxAmount != null) {
    maxAmount = parseMaxAmount(step.maxAmount ?? manifest.maxAmount, { source: "manifest maxAmount", bounded: true });
  } else {
    throw new Error("no maxAmount set (step, manifest, or --max-amount)");
  }

  const url = substitute(step.url, params, { urlEncode: true });
  assertSafePaymentUrl(url);
  const argv = [method, url, "--chain", String(chain), "--max-amount", String(maxAmount)];

  // --raw-key (override) tells selat-pay to sign locally with SELAT_PRIVATE_KEY
  // instead of the Circle Agent Wallet. Required for chains the Circle CLI can't
  // sign (e.g. Arc mainnet), where the Gateway balance sits under a raw EOA.
  if (overrides.rawKey) argv.push("--raw-key");

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

/**
 * Decide whether a run needs an auto-resolved pay chain — true only when neither
 * --chain (override), the manifest, nor every step already pins one — and, if so,
 * resolve it from the wallet's funded Gateway balance. Returns
 * { needed, chain } where `chain` is a selat-pay key or null (unfunded /
 * unavailable). Lets Eco-funded users (whose balance settles on Polygon) run any
 * chain-agnostic skill without passing --chain.
 */
export async function autoResolveDefaultChain({ overrides = {}, manifest }) {
  const needed =
    overrides.chain == null &&
    manifest.chain == null &&
    manifest.steps.some((s) => s.chain == null);
  if (!needed) return { needed: false, chain: null };
  const address = await getAgentAddress();
  const chain = address ? await resolveFundedChainKey(address) : null;
  return { needed: true, chain };
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

  const params = resolveParams(skill.manifest, cliParams);

  // When nothing pins a pay chain, default to the wallet's funded Gateway chain
  // so chain-agnostic skills work without --chain (e.g. Eco funds on Polygon).
  const auto = await autoResolveDefaultChain({ overrides, manifest: skill.manifest });
  if (auto.needed) {
    if (!auto.chain) {
      throw new Error("no --chain given and no funded Gateway balance to auto-select one — run `selat fund`, or pass --chain <chain>");
    }
    console.error(`[selat] no --chain set; paying on '${auto.chain}' (your funded Gateway chain)`);
  }
  const defaultChain = auto.chain;

  const total = skill.manifest.steps.length;
  const results = [];

  for (const [index, step] of skill.manifest.steps.entries()) {
    const base = { index, label: step.label ?? null, rail: step.rail ?? null };
    try {
      const { argv, display } = compileStep(skill.manifest, step, params, overrides, defaultChain);
      if (onStep) onStep({ index, step, display, total });
      const { cmd, args: spawnArgs } = selatPaySpawn(selatPay, argv);
      await ensureSelatPayHistoryDir();
      const res = await sh(cmd, spawnArgs, { inherit: true });
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
    // No `chain` pinned: the runner pays on the wallet's funded Gateway chain by
    // default. Add `"chain": "<key>"` only if this skill must use a fixed chain.
    maxAmount: "0.01",
    params: {
      example: { required: true, description: "TODO describe this param; reference it as ${example} in url/body" }
    },
    steps: [
      {
        label: "TODO step label — Provider (rail)",
        rail: "routed",
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
compatibility: Requires the selat CLI, selat-pay >= 0.3.2, and a funded Circle Gateway balance (settles on whichever supported chain the balance sits on).
metadata:
  author: TODO
  version: "1.0"
  rail: routed
  kind: single
---

# ${name}

## When To Use

TODO when an agent should pick this skill.

## Workflow

1. Install: \`selat skill install ${name}\`
2. Run: \`selat skill run ${name} --example <value>\`
3. The CLI compiles each step into a \`selat-pay\` call and prints the result.

Step: **Provider** \`METHOD /path\` — routed via the SELAT Router (outbound leg: Gateway-batched or MPP).

## Inputs And Outputs

| Param | Required | Default | Description |
|---|---|---|---|
| \`example\` | yes | — | TODO |

Output: TODO describe the response shape.

## Gotchas

- TODO required params / units / rail dependencies / cost cap.

## Validation

> \`--chain base\` below is only the flag \`selat-pay\` requires for a probe — probing reads a free, chain-independent quote and never settles. A paid run resolves the settlement chain from your funded Circle Gateway balance, not the manifest.

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
| TODO | GET | \`https://TODO-upstream/endpoint\` | routed (Gateway-batched outbound) | $0.00 |

- **Provider:** TODO
- **Payment:** routed via the SELAT Router (outbound leg: TODO Gateway-batched or MPP/erc-3009).
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

// ── Live verification (the wedge): probe + optional capped paid call ─────────

export function parseProbeStdout(stdout) {
  let json = null;
  try { json = JSON.parse(stdout.trim()); }
  catch {
    const a = stdout.indexOf("{"), b = stdout.lastIndexOf("}");
    if (a !== -1 && b > a) { try { json = JSON.parse(stdout.slice(a, b + 1)); } catch {} }
  }
  if (!json || !json.mode) return { mode: null, livePriceUsd: null };
  const amt = json.quote?.price?.amount;
  const livePriceUsd = amt != null && Number.isFinite(Number(amt)) ? Number(amt) / 1_000_000 : null;
  return { mode: json.mode, livePriceUsd };
}

/**
 * Live-verify a skill directory: for each step, probe the upstream 402
 * (selat-pay --probe-only, free) to capture the real price/rail/reachability and
 * check it against the step's maxAmount cap; optionally (pay:true) make a capped
 * real paid call to confirm settlement. Writes a provenance receipt to
 * <dir>/.selat/verify-receipt.json. Returns { ok, steps, receiptPath, name }.
 * `onStep` is an optional UI callback ({ index, total, phase, step, display }).
 */
export async function verifySkillDir(dir, { params = {}, overrides = {}, pay = false, onStep } = {}) {
  const manifest = await loadManifest(dir);          // throws on bad manifest
  const resolved = resolveParams(manifest, params);  // throws (paramKey) on missing required

  const selatPay = await resolveSelatPay();
  if (selatPay.source === null) {
    const err = new Error("selat-pay not found — reinstall selat-cli, or install selat-pay globally.");
    err.selatPayMissing = true;
    throw err;
  }

  // Same chain auto-resolution as a real run; verify probes for free, so fall
  // back to `base` when the wallet isn't funded (the probe doesn't settle).
  const auto = await autoResolveDefaultChain({ overrides, manifest });
  const defaultChain = auto.needed ? (auto.chain ?? "base") : null;

  const total = manifest.steps.length;
  const steps = [];
  for (const [index, step] of manifest.steps.entries()) {
    const { argv, display } = compileStep(manifest, step, resolved, overrides, defaultChain);
    const url = argv[1];
    const cap = Number(overrides.maxAmount ?? step.maxAmount ?? manifest.maxAmount);
    const base = { index, label: step.label ?? null, rail: step.rail ?? null, method: argv[0], url, maxAmount: Number.isFinite(cap) ? cap : null };

    // Phase 1: probe (free)
    if (onStep) onStep({ index, total, phase: "probe", step, display });
    const probe = selatPaySpawn(selatPay, [...argv, "--probe-only"]);
    const pr = await sh(probe.cmd, probe.args);
    const { mode, livePriceUsd } = parseProbeStdout(pr.stdout || "");
    const reachable = pr.code === 0 && mode != null;
    const withinCap = reachable && livePriceUsd != null && Number.isFinite(cap) ? livePriceUsd <= cap : reachable && livePriceUsd == null;
    let error = null;
    if (!reachable) error = (pr.stderr || "").match(/\[selat-pay\] error: (.+)/)?.[1]?.trim() || "no x402/MPP challenge";
    else if (livePriceUsd != null && Number.isFinite(cap) && livePriceUsd > cap) error = `live price $${livePriceUsd} exceeds maxAmount $${cap}`;

    // Phase 2: capped paid call (opt-in)
    let paid = null;
    if (pay && reachable && withinCap) {
      if (onStep) onStep({ index, total, phase: "pay", step, display });
      const t0 = Date.now();
      const paidSpawn = selatPaySpawn(selatPay, argv);
      const rr = await sh(paidSpawn.cmd, paidSpawn.args);
      const latencyMs = Date.now() - t0;
      const status = (rr.stderr || "").match(/status=(\d+)/)?.[1];
      paid = { settled: rr.code === 0, httpStatus: status ? Number(status) : null, amountUsd: livePriceUsd, latencyMs };
      if (!paid.settled && !error) error = `paid call did not settle (status=${paid.httpStatus ?? "?"})`;
    }

    steps.push({ ...base, mode, livePriceUsd, reachable, withinCap, paid, error });
  }

  const ok = steps.every((s) => s.reachable && s.withinCap && (!pay || (s.paid && s.paid.settled)));
  const receipt = {
    schema: "selat-verify/v1",
    verifiedAt: new Date().toISOString(),
    skill: manifest.name,
    paidMode: pay,
    ok,
    steps
  };
  await mkdir(join(dir, ".selat"), { recursive: true });
  const receiptPath = join(dir, ".selat", "verify-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");

  return { ok, steps, receiptPath, name: manifest.name };
}

// ── Register & submit (catalog entry + PR) ──────────────────────────────────

/** Derive the index.json catalog entry from a manifest. */
export function deriveIndexEntry(manifest) {
  const rails = [...new Set((manifest.steps || []).map((s) => s.rail).filter(Boolean))];
  const rail = rails.length === 0 ? "routed" : rails.length === 1 ? rails[0] : "mixed";
  const kind = (manifest.steps || []).length > 1 ? "multi" : "single";
  return { name: manifest.name, rail, kind, description: manifest.description || "" };
}

function findIndexJson(dir) {
  const guess = join(resolve(dir), "..", "..", "index.json"); // skills/<name>/ -> repo root
  return existsSync(guess) ? guess : null;
}

/**
 * Upsert the skill's entry in the selat-skills index.json (derived from the
 * manifest). Returns { indexPath, entry, action: "added"|"updated" }.
 */
export async function registerSkill(dir, { indexPath } = {}) {
  const manifest = await loadManifest(dir);
  const entry = deriveIndexEntry(manifest);
  const idxPath = indexPath || findIndexJson(dir);
  if (!idxPath || !existsSync(idxPath)) {
    throw new Error("could not find index.json — run register inside a selat-skills checkout (skills/<name>/) or pass --index <path>");
  }
  const idx = JSON.parse(await readFile(idxPath, "utf8"));
  if (!Array.isArray(idx.skills)) idx.skills = [];
  const i = idx.skills.findIndex((s) => s.name === entry.name);
  const action = i === -1 ? "added" : "updated";
  if (i === -1) idx.skills.push(entry);
  else idx.skills[i] = { ...idx.skills[i], ...entry };
  await writeFile(idxPath, JSON.stringify(idx, null, 2) + "\n", "utf8");
  return { indexPath: idxPath, entry, action };
}

function buildPrBody(name, entry, receipt) {
  const lines = [
    `Adds the **${name}** skill (${entry.kind}/${entry.rail}).`,
    "",
    entry.description,
    "",
    `## Live verification (selat-verify/v1 · ${receipt.verifiedAt} · ${receipt.paidMode ? "paid" : "probe-only"})`
  ];
  for (const s of receipt.steps) {
    const price = s.livePriceUsd != null ? `$${s.livePriceUsd}` : "(no price)";
    const cap = s.maxAmount != null ? ` / cap $${s.maxAmount}` : "";
    const paid = s.paid ? ` — paid ${s.paid.settled ? "settled 200" : "FAILED"} ${s.paid.latencyMs}ms` : "";
    lines.push(`- step ${s.index + 1} [${s.rail || "?"}] ${s.mode || "?"} ${price}${cap}${paid}`);
  }
  lines.push("", "_Generated by `selat skill submit`. A maintainer should paid-re-verify before merge._");
  return lines.join("\n");
}

/**
 * Submit a verified skill as a PR to the selat-skills repo. Gates on a passing
 * verify receipt. dryRun returns the plan without touching git/index.json.
 * Otherwise: branch -> register (writes index.json) -> commit -> push -> gh pr
 * create.
 *
 * Fork-and-PR is the default flow: unless `gh` confirms push access to the
 * upstream repo, the branch goes to the contributor's own fork (created on
 * demand) and the PR opens cross-fork — most contributors have no write
 * access, and stopping at printed fork instructions is where submissions
 * stalled. `fork: true` forces the fork flow; `fork: false` restores
 * push-to-origin-only (hints on failure). `run` injects the shell for tests.
 */
export async function submitSkill(dir, { dryRun = false, repo = SKILLS_REPO, fork = null, run = sh } = {}) {
  const manifest = await loadManifest(dir);
  const name = manifest.name;
  const entry = deriveIndexEntry(manifest);
  const skillDir = resolve(dir);
  const repoRoot = dirname(dirname(skillDir)); // skills/<name> -> repo root

  const receiptPath = join(skillDir, ".selat", "verify-receipt.json");
  if (!existsSync(receiptPath)) {
    const e = new Error(`no verification receipt — run \`selat skill verify ${dir}\` (add --pay) before submitting`);
    e.needVerify = true;
    throw e;
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (!receipt.ok) throw new Error("verification receipt is not ok — fix the failing step(s) and re-verify before submitting");

  const branch = `add-skill-${name}`;
  const relSkill = `skills/${name}`;
  const title = `Add skill: ${name}`;
  const body = buildPrBody(name, entry, receipt);

  if (dryRun) return { dryRun: true, repoRoot, branch, files: [relSkill, "index.json"], title, body, entry };

  if ((await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot }).catch(() => ({ code: 1 }))).code !== 0) {
    throw new Error(`${repoRoot} is not a git checkout of ${repo}; clone it and place the skill under skills/${name}/`);
  }
  const cb = await run("git", ["checkout", "-b", branch], { cwd: repoRoot });
  if (cb.code !== 0) {
    const fallback = await run("git", ["checkout", branch], { cwd: repoRoot });
    if (fallback.code !== 0) {
      throw new Error(
        `could not switch to branch ${branch} — it may already exist, or the worktree has ` +
          `uncommitted changes blocking checkout: ${((fallback.stderr || cb.stderr) || "").trim()}`
      );
    }
  }
  // Confirm we actually landed on the target branch before mutating files. A
  // discarded checkout failure would otherwise commit the skill to whatever
  // branch (typically main) was already checked out.
  const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }).catch(() => ({ code: 1, stdout: "" }));
  const current = (head.stdout || "").trim();
  if (head.code !== 0 || current !== branch) {
    throw new Error(
      `expected to be on branch ${branch} but HEAD is ${current || "unknown"}; ` +
        `aborting before commit (commit or stash any uncommitted changes and retry)`
    );
  }
  await registerSkill(dir); // writes index.json on the branch
  await run("git", ["add", relSkill, "index.json"], { cwd: repoRoot });
  const c = await run("git", ["commit", "-m", title], { cwd: repoRoot });
  if (c.code !== 0 && !/nothing to commit/i.test((c.stdout || "") + (c.stderr || ""))) {
    throw new Error(`git commit failed: ${((c.stderr || c.stdout) || "").trim()}`);
  }

  // Route: fork by default; push to origin only when gh confirms write access
  // (maintainers keep their same-repo branch workflow). An explicit `fork`
  // option short-circuits the check in either direction. When the probe itself
  // is unusable (gh missing, unauthenticated, offline) try origin FIRST — the
  // fork flow needs gh anyway, so this preserves the pre-fork behavior of a
  // plain git push for gh-less setups, and a contributor's 403 still reaches
  // the fork flow via the push-failure fall-through below.
  let via = "fork";
  if (fork === false) via = "origin";
  else if (fork !== true) {
    const perm = await run("gh", ["api", `repos/${repo}`, "--jq", ".permissions.push"], { cwd: repoRoot })
      .catch(() => ({ code: 1, stdout: "" }));
    if (perm.code !== 0 || (perm.stdout || "").trim() === "true") via = "origin";
  }

  let prHead = branch;
  let forkRepo = null;
  if (via === "origin") {
    const p = await run("git", ["push", "-u", "origin", branch], { cwd: repoRoot });
    if (p.code !== 0) {
      if (fork === false) {
        return { pushed: false, branch, repoRoot, via,
          hint: `push to origin failed (no write access?). Re-run without --no-fork to submit from a fork, or manually:\n  gh repo fork ${repo} --clone=false\n  git push -u <your-fork-remote> ${branch}\n  gh pr create --repo ${repo} --head <you>:${branch}`,
          detail: (p.stderr || "").trim() };
      }
      via = "fork"; // the permission probe was wrong/unavailable — fall through to the fork flow
    }
  }
  if (via === "fork") {
    const forked = await pushViaFork({ repo, branch, repoRoot, run });
    if (!forked.ok) {
      return { pushed: false, branch, repoRoot, via, hint: forked.hint, detail: forked.detail };
    }
    prHead = forked.head;
    forkRepo = forked.forkRepo;
  }

  const pr = await run("gh", ["pr", "create", "--repo", repo, "--head", prHead, "--title", title, "--body", body], { cwd: repoRoot });
  if (pr.code !== 0) {
    return { pushed: true, branch, via, forkRepo, prUrl: null, hint: `branch pushed; open the PR manually: gh pr create --repo ${repo} --head ${prHead}`, detail: (pr.stderr || "").trim() };
  }
  return { pushed: true, branch, via, forkRepo, prUrl: (pr.stdout || "").trim() };
}

/**
 * Push `branch` to the contributor's fork of `repo`, creating the fork on
 * demand (`gh repo fork` is idempotent). Never rewires `origin`: the fork
 * becomes a separate `fork` remote whose URL scheme (ssh/https) matches
 * origin's so existing git credentials keep working; if an unrelated `fork`
 * remote already exists it is left alone and the push goes to the fork URL
 * directly. Returns { ok, head: "<login>:<branch>", forkRepo } or
 * { ok: false, hint, detail }.
 */
async function pushViaFork({ repo, branch, repoRoot, run = sh }) {
  const manualHint =
    `fork-and-push failed. Manually:\n` +
    `  gh repo fork ${repo} --clone=false\n` +
    `  git remote add fork <your-fork-url> && git push -u fork ${branch}\n` +
    `  gh pr create --repo ${repo} --head <you>:${branch}`;

  const who = await run("gh", ["api", "user", "--jq", ".login"], { cwd: repoRoot })
    .catch(() => ({ code: 1, stdout: "", stderr: "gh not available" }));
  const login = (who.stdout || "").trim();
  if (who.code !== 0 || !login) {
    return { ok: false, hint: `could not resolve your GitHub login via gh (needed to fork).\n${manualHint}`, detail: (who.stderr || "").trim() };
  }

  const f = await run("gh", ["repo", "fork", repo, "--clone=false"], { cwd: repoRoot });
  if (f.code !== 0) return { ok: false, hint: manualHint, detail: (f.stderr || "").trim() };

  const forkRepo = `${login}/${repo.split("/")[1]}`;
  const originUrl = ((await run("git", ["remote", "get-url", "origin"], { cwd: repoRoot })
    .catch(() => ({ stdout: "" }))).stdout || "").trim();
  const ssh = originUrl.startsWith("git@") || originUrl.startsWith("ssh://");
  const forkUrl = ssh ? `git@github.com:${forkRepo}.git` : `https://github.com/${forkRepo}.git`;

  let pushTarget = "fork";
  const existing = await run("git", ["remote", "get-url", "fork"], { cwd: repoRoot })
    .catch(() => ({ code: 1, stdout: "" }));
  if (existing.code !== 0) {
    const add = await run("git", ["remote", "add", "fork", forkUrl], { cwd: repoRoot });
    if (add.code !== 0) return { ok: false, hint: manualHint, detail: (add.stderr || "").trim() };
  } else if ((existing.stdout || "").trim() !== forkUrl) {
    pushTarget = forkUrl; // a `fork` remote exists but points elsewhere — don't clobber it
  }

  const p = await run("git", pushTarget === "fork" ? ["push", "-u", "fork", branch] : ["push", pushTarget, branch], { cwd: repoRoot });
  if (p.code !== 0) return { ok: false, hint: manualHint, detail: (p.stderr || "").trim() };
  return { ok: true, head: `${login}:${branch}`, forkRepo };
}
