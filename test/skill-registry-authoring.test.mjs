import test from "node:test";
import assert from "node:assert/strict";

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  resolveParams,
  scaffoldSkill,
  substitute,
  validateSkillDir
} from "../lib/skill-registry.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "selat-authoring-"));

// ── resolveParams: the gate between CLI flags and a signed payment ──────────

test("resolveParams layers CLI values over manifest defaults", () => {
  const manifest = { params: { handle: { required: true }, limit: { default: 10 } } };
  assert.deepEqual(resolveParams(manifest, { handle: "openai" }), { handle: "openai", limit: 10 });
  assert.deepEqual(resolveParams(manifest, { handle: "openai", limit: 3 }), { handle: "openai", limit: 3 });
});

test("resolveParams throws a flag-shaped error naming the missing required param", () => {
  const manifest = { params: { handle: { required: true, description: "Twitter handle" } } };
  assert.throws(() => resolveParams(manifest, {}), (err) => {
    assert.match(err.message, /missing required --handle/);
    assert.equal(err.paramKey, "handle");
    assert.equal(err.paramDescription, "Twitter handle");
    return true;
  });
});

test("resolveParams treats a defaulted param as satisfied and omits an optional one", () => {
  const manifest = { params: { limit: { default: 5 }, cursor: {} } };
  assert.deepEqual(resolveParams(manifest, {}), { limit: 5 });
});

test("resolveParams passes undeclared CLI params through", () => {
  assert.deepEqual(resolveParams({ params: {} }, { extra: "x" }), { extra: "x" });
  assert.deepEqual(resolveParams({}, {}), {}, "a param-less manifest is valid");
});

// ── substitute: template expansion into URLs and bodies ─────────────────────

test("substitute expands every occurrence of a token", () => {
  assert.equal(substitute("https://x/${a}?q=${a}", { a: "1" }), "https://x/1?q=1");
});

test("substitute joins an array only for the |join form", () => {
  assert.equal(substitute("${syms|join}", { syms: ["ETH", "USDC"] }), "ETH,USDC");
  assert.equal(substitute("${syms}", { syms: ["ETH", "USDC"] }), "ETH,USDC", "String() on an array");
});

test("substitute url-encodes the substituted value, not the surrounding template", () => {
  assert.equal(
    substitute("https://x/api?q=${q}", { q: "a b&c" }, { urlEncode: true }),
    "https://x/api?q=a%20b%26c"
  );
});

test("substitute refuses an unknown or null token instead of interpolating 'undefined'", () => {
  assert.throws(() => substitute("${missing}", {}), /unknown parameter \$\{missing\}/);
  assert.throws(() => substitute("${a}", { a: null }), /unknown parameter/);
});

test("substitute coerces non-string values and leaves non-token text alone", () => {
  assert.equal(substitute("limit=${n}", { n: 7 }), "limit=7");
  assert.equal(substitute("$notatoken ${ spaced }", {}), "$notatoken ${ spaced }");
});

// ── scaffoldSkill / validateSkillDir: the authoring SOP ─────────────────────

test("scaffoldSkill writes the four SOP files", async () => {
  const dir = await tmp();
  const res = await scaffoldSkill("my-skill", { dir });
  assert.equal(res.dir, join(dir, "my-skill"));
  assert.deepEqual(res.files, [
    "manifest.json",
    "SKILL.md",
    join("references", "endpoints.md"),
    join("evals", "evals.json")
  ]);
  for (const rel of res.files) assert.ok(existsSync(join(res.dir, rel)), `${rel} should exist`);
  const manifest = JSON.parse(await readFile(join(res.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "my-skill");
  assert.equal(manifest.chain, undefined, "no chain is pinned; the funded Gateway chain decides");
});

test("scaffoldSkill enforces kebab-case names", async () => {
  const dir = await tmp();
  for (const bad of ["My-Skill", "my skill", "-leading", "", null]) {
    await assert.rejects(scaffoldSkill(bad, { dir }), /kebab-case/);
  }
});

test("scaffoldSkill refuses to clobber an existing skill unless forced", async () => {
  const dir = await tmp();
  await scaffoldSkill("my-skill", { dir });
  await writeFile(join(dir, "my-skill", "manifest.json"), '{"name":"edited"}', "utf8");
  await assert.rejects(scaffoldSkill("my-skill", { dir }), /--force/);

  await scaffoldSkill("my-skill", { dir, force: true });
  const manifest = JSON.parse(await readFile(join(dir, "my-skill", "manifest.json"), "utf8"));
  assert.equal(manifest.name, "my-skill", "--force rewrites the scaffold");
});

test("a freshly scaffolded skill passes validation, warning only about its TODOs", async () => {
  const dir = await tmp();
  const { dir: skillDir } = await scaffoldSkill("my-skill", { dir });
  const res = await validateSkillDir(skillDir);
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.equal(res.name, "my-skill");
  assert.ok(res.warnings.some((w) => /TODO/.test(w)), "the placeholders must be flagged before submission");
});

test("validateSkillDir requires manifest.name, frontmatter name and folder to agree", async () => {
  const dir = await tmp();
  const { dir: skillDir } = await scaffoldSkill("my-skill", { dir });
  const manifest = JSON.parse(await readFile(join(skillDir, "manifest.json"), "utf8"));
  manifest.name = "other-skill";
  await writeFile(join(skillDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  const md = await readFile(join(skillDir, "SKILL.md"), "utf8");
  await writeFile(join(skillDir, "SKILL.md"), md.replace("name: my-skill", "name: renamed"), "utf8");

  const res = await validateSkillDir(skillDir);
  assert.equal(res.ok, false);
  assert.equal(basename(skillDir), "my-skill");
  assert.ok(res.errors.some((e) => /manifest\.name 'other-skill'/.test(e)));
  assert.ok(res.errors.some((e) => /frontmatter name 'renamed'/.test(e)));
});

test("validateSkillDir reports an empty dir as missing every required file", async () => {
  const dir = await tmp();
  const res = await validateSkillDir(dir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("missing manifest.json"));
  assert.ok(res.errors.includes("missing SKILL.md"));
  assert.ok(res.warnings.includes("missing evals/evals.json"));
  assert.ok(res.warnings.includes("missing references/endpoints.md"));
  assert.equal(res.name, basename(dir), "falls back to the folder name");
});

test("validateSkillDir surfaces unparseable JSON in the manifest and the evals", async () => {
  const dir = await tmp();
  const { dir: skillDir } = await scaffoldSkill("my-skill", { dir });
  await writeFile(join(skillDir, "manifest.json"), "{not json", "utf8");
  await writeFile(join(skillDir, "evals", "evals.json"), "{not json", "utf8");
  const res = await validateSkillDir(skillDir);
  assert.ok(res.errors.includes("manifest.json is not valid JSON"));
  assert.ok(res.errors.includes("evals/evals.json is not valid JSON"));
});

test("validateSkillDir rejects an evals file that names a different skill", async () => {
  const dir = await tmp();
  const { dir: skillDir } = await scaffoldSkill("my-skill", { dir });
  await mkdir(join(skillDir, "evals"), { recursive: true });
  await writeFile(
    join(skillDir, "evals", "evals.json"),
    JSON.stringify({ skill_name: "other-skill", evals: [] }),
    "utf8"
  );
  const res = await validateSkillDir(skillDir);
  assert.ok(res.errors.some((e) => /evals\.json skill_name 'other-skill'/.test(e)));
  assert.ok(res.warnings.includes("evals.json has no evals"));
});

test("validateSkillDir propagates manifest validation failures (e.g. plain-http step)", async () => {
  const dir = await tmp();
  const { dir: skillDir } = await scaffoldSkill("my-skill", { dir });
  const manifest = JSON.parse(await readFile(join(skillDir, "manifest.json"), "utf8"));
  manifest.steps[0].url = "http://upstream.example/endpoint";
  await writeFile(join(skillDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  const res = await validateSkillDir(skillDir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /^manifest: /.test(e) && /https/.test(e)));
});
