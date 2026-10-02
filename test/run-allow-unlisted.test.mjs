// --allow-unlisted: explicit per-call opt-out of the catalog gate for a
// pinned URL. Seam tests pin the parse and the rank.mjs argv so the flag
// cannot drift from the spawn, and the guards that make it safe to offer:
// never without --endpoint, never implied.
import test from "node:test";
import assert from "node:assert/strict";

import { parseRunArgs, rankPickArgv, KNOWN_RUN_FLAGS, pinRefusal, withDocsCheck } from "../lib/commands/run.mjs";

test("--allow-unlisted is a known flag and parses with --endpoint", () => {
  assert.ok(KNOWN_RUN_FLAGS.includes("--allow-unlisted"));
  const parsed = parseRunArgs(["paid delivery check", "--endpoint", "https://api.x.dev/v1", "--allow-unlisted"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.allowUnlisted, true);
  assert.equal(parsed.endpoint, "https://api.x.dev/v1");
});

test("--allow-unlisted without --endpoint is refused at parse time", () => {
  const parsed = parseRunArgs(["paid delivery check", "--allow-unlisted"]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /--allow-unlisted requires --endpoint/);
});

test("rankPickArgv forwards --allow-unlisted only alongside a pin", () => {
  assert.deepEqual(
    rankPickArgv({ intent: "x", endpoint: "https://api.x.dev/v1", allowUnlisted: true }),
    ["x", "--pick", "--endpoint", "https://api.x.dev/v1", "--allow-unlisted"],
  );
  // Defensive: even if a caller sets the flag without a pin, it is not emitted.
  assert.deepEqual(rankPickArgv({ intent: "x", allowUnlisted: true }), ["x", "--pick"]);
  // Absent by default.
  assert.deepEqual(
    rankPickArgv({ intent: "x", endpoint: "https://api.x.dev/v1" }),
    ["x", "--pick", "--endpoint", "https://api.x.dev/v1"],
  );
});

// The merchant's published docs are the only request contract an unlisted
// pin has — the paid command must carry --docs-check so selat-pay refuses a
// body missing a documented-required field before signing.
test("withDocsCheck appends --docs-check for unlisted pins only, idempotently", () => {
  const base = ["POST", "https://api.x.dev/v1", "--chain", "base", "--max-amount", "0.1"];
  assert.deepEqual(withDocsCheck(base, { allowUnlisted: true }), [...base, "--docs-check"]);
  assert.deepEqual(withDocsCheck(base, { allowUnlisted: false }), base);
  assert.deepEqual(withDocsCheck(base, {}), base);
  const already = [...base, "--docs-check"];
  assert.deepEqual(withDocsCheck(already, { allowUnlisted: true }), already);
});

test("the not-in-catalog refusal names the flag", () => {
  const refusal = pinRefusal(4, "https://api.x.dev/v1");
  assert.equal(refusal.reason, "endpoint-not-in-catalog");
  assert.match(refusal.error, /--allow-unlisted/);
});

// Re-planning a body-param refusal after --param must keep the unlisted-pin
// marker: the ranker only synthesizes a live-402 exec hint for an endpoint
// stamped `unlisted: true`, so dropping it left every unlisted POST with no
// runnable hint and --param could never unblock it (api.ceramic.ai/search).
// The stub ranker mirrors that contract.
async function stubSkill() {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "selat-replan-"));
  await mkdir(join(dir, "scripts", "lib"), { recursive: true });
  await writeFile(join(dir, "scripts", "lib", "rank.mjs"), `
    export function buildPaymentPlan(intent, result, { providedParams = [] } = {}) {
      const ep = result.endpoint;
      const required = ep.inputSchema?.body?.required ?? [];
      const missing = required.filter((n) => !providedParams.includes(n));
      if (missing.length > 0) {
        return { requiresBodyParams: true, missingBodyParams: missing, note: "needs body", exec_hints: [] };
      }
      const exec_hints = ep.unlisted === true
        ? [{ cmd: "selat-pay " + ep.method + " " + ep.fullUrl + " --body {}" }]
        : [];
      return { exec_hints, note: exec_hints.length ? undefined : "no hint", endpoint: ep };
    }
  `);
  return { path: dir };
}

const unlistedBodyPlan = (extra = {}) => ({
  service: { name: "api.ceramic.ai" },
  endpoint: {
    method: "POST",
    url: "https://api.ceramic.ai/search",
    path: "/search",
    unlisted: true,
    inputSchema: { body: { required: ["query"] } },
    ...extra,
  },
  requiresBodyParams: true,
  missingBodyParams: ["query"],
});

test("replanWithParams keeps the unlisted marker so an unlisted body-param pick becomes runnable", async () => {
  const { replanWithParams } = await import("../lib/commands/run.mjs");
  const out = await replanWithParams({
    plan: unlistedBodyPlan(), skill: await stubSkill(), intent: "web search", params: [["query", "x402"]],
  });
  assert.equal(out.ok, true);
  assert.match(out.plan.exec_hints[0].cmd, /selat-pay POST https:\/\/api\.ceramic\.ai\/search/);
});

test("replanWithParams does not mark a listed endpoint as unlisted", async () => {
  const { replanWithParams } = await import("../lib/commands/run.mjs");
  const plan = unlistedBodyPlan({ unlisted: undefined });
  const out = await replanWithParams({
    plan, skill: await stubSkill(), intent: "web search", params: [["query", "x402"]],
  });
  assert.equal(out.ok, false);
  assert.equal(out.missing, undefined, "a non-params failure must not carry a missing list");
});

test("replanWithParams still reports params that were not supplied", async () => {
  const { replanWithParams } = await import("../lib/commands/run.mjs");
  const out = await replanWithParams({
    plan: unlistedBodyPlan(), skill: await stubSkill(), intent: "web search", params: [["other", "1"]],
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing.map((m) => m.name), ["query"]);
});
