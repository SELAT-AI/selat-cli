// Capability-catalog status: what `selat init` warms and `selat doctor`
// reports. Offline — the skill is a stub directory on disk, so every tier
// (hosted / stale / unsupported / failure) is exercised without a network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fetchCatalogStatus, catalogStatusLines, hostedCatalogModulePath } from "../lib/catalog.mjs";

// A fake installed skill whose scripts/lib/hosted-catalog.mjs is `body`.
// Omit body to model a skill that predates the hosted tier.
let seq = 0;
function stubSkill(body) {
  const root = mkdtempSync(join(tmpdir(), "selat-skill-"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  writeFileSync(join(root, "scripts", "rank.mjs"), "export const rank = 1;\n");
  if (body != null) writeFileSync(hostedCatalogModulePath(root), body);
  seq += 1;
  return { found: true, path: root, checked: [root], requiredScript: "rank.mjs" };
}

const CATALOG_BODY = (extra = "") => `
export function hostedCachePath() { return "/tmp/state/selat/federated-hosted.json"; }
export async function loadOrFetchHostedCatalog() {
  return {
    tier: "hosted",
    generatedAt: "2026-09-11T02:02:12.607Z",
    catalog: { services: [
      { id: "a", endpoints: [{ inputSchema: { source: "mpp-openapi" } }, { inputSchema: null }] },
      { id: "b", endpoints: [{ inputSchema: { source: "docs-derived" } }] },
    ] },
    ${extra}
  };
}
`;

test("hosted tier: counts services, endpoints, and the share carrying request schemas", async () => {
  const s = await fetchCatalogStatus({ skill: stubSkill(CATALOG_BODY()) });
  assert.equal(s.ok, true);
  assert.equal(s.tier, "hosted");
  assert.equal(s.services, 2);
  assert.equal(s.endpoints, 3);
  assert.equal(s.withSchema, 2);
  assert.equal(s.cachePath, "/tmp/state/selat/federated-hosted.json");

  const out = catalogStatusLines(s);
  assert.equal(out.kind, "ok");
  assert.match(out.lines[0], /2 services, 3 endpoints \(67% with request schemas\)/);
  assert.match(out.lines[1], /built 2026-09-11T02:02:12\.607Z by catalog\.selat\.ai/);
});

test("stale tier warns and reports the age instead of claiming freshness", () => {
  const out = catalogStatusLines({
    ok: true, tier: "hosted-stale", ageHours: 30, generatedAt: "2026-09-10T02:02:04.971Z",
    services: 1212, endpoints: 4487, withSchema: 3590, error: "ECONNREFUSED",
  });
  assert.equal(out.kind, "warn");
  assert.match(out.lines[0], /1212 services, 4487 endpoints \(80% with request schemas\)/);
  assert.match(out.lines[1], /cached copy \(~30h old\).*live fetch failed: ECONNREFUSED/);
});

test("a skill that predates the hosted tier is a note, not a failure", async () => {
  const s = await fetchCatalogStatus({ skill: stubSkill(null) });
  assert.deepEqual(s, { ok: false, reason: "unsupported" });
  const out = catalogStatusLines(s);
  assert.equal(out.kind, "info");
  assert.match(out.lines[0], /builds the catalog locally on first use/);
  assert.match(out.lines[1], /update @selat-ai\/selat-discovery/);
});

test("a module without the expected export is also 'unsupported', not a crash", async () => {
  const s = await fetchCatalogStatus({ skill: stubSkill("export const nope = 1;\n") });
  assert.equal(s.reason, "unsupported");
});

test("a fetch failure degrades to a warning that says discovery still works", async () => {
  const skill = stubSkill(`
    export async function loadOrFetchHostedCatalog() { throw new Error("ENOTFOUND catalog.selat.ai"); }
  `);
  const s = await fetchCatalogStatus({ skill });
  assert.equal(s.ok, false);
  assert.equal(s.reason, "fetch-failed");
  const out = catalogStatusLines(s);
  assert.equal(out.kind, "warn");
  assert.match(out.lines[0], /could not fetch the catalog: ENOTFOUND/);
  assert.match(out.lines[1], /discovery still works/);
});

test("an unparseable catalog module is reported, not thrown", async () => {
  const s = await fetchCatalogStatus({ skill: stubSkill("this is not javascript !!!\n") });
  assert.equal(s.reason, "load-failed");
  assert.equal(catalogStatusLines(s).kind, "warn");
});

test("no skill installed is reported without touching the network", async () => {
  const s = await fetchCatalogStatus({ skill: { found: false, path: "/nonexistent", checked: [], requiredScript: "rank.mjs" } });
  assert.deepEqual(s, { ok: false, reason: "no-skill" });
  assert.match(catalogStatusLines(s).lines[0], /agent-payment skill is not installed/);
});

test("an empty catalog does not divide by zero", () => {
  const out = catalogStatusLines({ ok: true, tier: "hosted", services: 0, endpoints: 0, withSchema: 0, generatedAt: null });
  assert.match(out.lines[0], /0 services, 0 endpoints \(0% with request schemas\)/);
});
