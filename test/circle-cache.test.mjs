import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// The Circle CLI costs 4–17 s per spawn and `selat run` spawned it before
// every payment just to pick the funded --chain. lib/circle-cache.mjs keeps
// successful reads (state-dir JSON + in-process memo). These tests pin the
// cache contract — spawn once, reuse within TTL, never cache a failure, honor
// the bypass, invalidate on money movement — and that the reads which ARE the
// proof (fund's baseline/credit, doctor) stay live.

const dir = mkdtempSync(join(tmpdir(), "selat-circle-cache-"));
const stateHome = join(dir, "state");
const configHome = join(dir, "config");
const log = join(dir, "calls.log");
const ADDR = "0xb291279be48742f0a1e9ed15c8d6d2d09ea9e4da";

// Fake Circle CLI: logs every argv line, answers the reads the cache wraps.
// FAKE_CIRCLE_MODE=fail makes `gateway balance` fail; =list-fail makes the
// MONAD `wallet list` fail (a partial listing).
const fakeCircle = join(dir, "fake-circle");
writeFileSync(fakeCircle, `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"gateway balance"*)
    if [ "$FAKE_CIRCLE_MODE" = "fail" ]; then echo 'Error: 503' >&2; exit 1; fi
    echo '{"data":{"total":"4.04","token":"USDC","balances":[{"network":"Base","domain":6,"balance":"0"},{"network":"Polygon","domain":7,"balance":"4.04"}]}}'
    ;;
  *"wallet list"*"--chain MONAD"*)
    if [ "$FAKE_CIRCLE_MODE" = "list-fail" ]; then echo 'Error: 503' >&2; exit 1; fi
    echo '{"data":{"wallets":[{"type":"agent","address":"${ADDR}","blockchain":"MONAD"}]}}'
    ;;
  *"wallet list"*) echo '{"data":{"wallets":[{"type":"agent","address":"${ADDR}","blockchain":"BASE"}]}}' ;;
  *"wallet status"*) printf 'Type:     agent\\nEmail:    test@example.com\\nStatus:   VALID\\n' ;;
  *"wallet balance"*) echo '{"data":{"balances":[{"amount":"5","token":{"symbol":"USDC"}}]}}' ;;
  *"wallet limit budget"*) exit 1 ;;
  *"wallet limit"*) echo '{"data":{"policies":[{"origin":"CUSTOM","ruleType":"TRANSFER_LIMIT","perTxLimit":"5"}]}}' ;;
  *"wallet create"*) ;;
  *) echo '{}' ;;
esac
`);
chmodSync(fakeCircle, 0o755);
writeFileSync(log, "");

const calls = (re) => readFileSync(log, "utf8").split("\n").filter((l) => re.test(l)).length;
const resetLog = () => writeFileSync(log, "");
const cachePath = join(stateHome, "selat", "circle-cache.json");
const readCache = () => JSON.parse(readFileSync(cachePath, "utf8"));
const cachedKeys = () => (existsSync(cachePath) ? readCache().entries.map((e) => e.key) : []);

// CIRCLE_BIN is captured at module load; the cache path is derived from
// process.env at call time. Both set BEFORE the imports so nothing here ever
// touches the developer's real ~/.local/state.
process.env.CIRCLE_BIN = fakeCircle;
process.env.XDG_STATE_HOME = stateHome;
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.SELAT_AGENT_WALLET_ADDRESS;
delete process.env.SELAT_NO_CIRCLE_CACHE;
delete process.env.SELAT_CIRCLE_CACHE_TTL_MS;
const circle = await import("../lib/circle.mjs");
const cache = await import("../lib/circle-cache.mjs");
const { gatewayCacheLines } = await import("../lib/commands/doctor.mjs");

const GW = /^gateway balance/;

test("fresh gateway read spawns once and persists under $XDG_STATE_HOME/selat", async () => {
  resetLog();
  assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
  assert.equal(calls(GW), 1);
  assert.equal(cache.circleCachePath(), cachePath);
  const file = readCache();
  assert.equal(file.schema, "selat.circle-cache/v1");
  const entry = file.entries.find((e) => e.key === circle.gatewayBalanceCacheKey(ADDR));
  assert.equal(entry.value.total, 4.04);
  assert.ok(Number.isFinite(entry.storedAt));
});

test("second read within the TTL does not spawn (memo + disk)", async () => {
  resetLog();
  assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
  assert.equal((await circle.gatewayBalance(ADDR)), 4.04);
  assert.equal(calls(GW), 0);
  // A fresh process (empty memo) is served from disk too.
  let spawned = 0;
  const value = await cache.cachedCall("probe:disk", 60_000, async () => { spawned++; return { n: 1 }; }, { cachePath, now: 1000 });
  assert.deepEqual(value, { n: 1 });
  const again = await cache.cachedCall("probe:disk", 60_000, async () => { spawned++; return { n: 2 }; }, { cachePath, now: 1000 + 59_999 });
  assert.deepEqual(again, { n: 1 });
  assert.equal(spawned, 1);
});

test("an expired entry re-spawns (injected clock, and the TTL env override)", async () => {
  let spawned = 0;
  const fn = async () => { spawned++; return { n: spawned }; };
  await cache.cachedCall("probe:ttl", 1000, fn, { cachePath, now: 5000 });
  await cache.cachedCall("probe:ttl", 1000, fn, { cachePath, now: 6000 });
  assert.equal(spawned, 2);
  await cache.cachedCall("probe:ttl", 1000, fn, { cachePath, now: 6500 });
  assert.equal(spawned, 2);

  resetLog();
  process.env.SELAT_CIRCLE_CACHE_TTL_MS = "0";
  try {
    await circle.gatewayBalancesByChain(ADDR);
    await circle.gatewayBalancesByChain(ADDR);
    assert.equal(calls(GW), 2);
  } finally {
    delete process.env.SELAT_CIRCLE_CACHE_TTL_MS;
  }
});

test("SELAT_NO_CIRCLE_CACHE=1 bypasses lookup and store", async () => {
  resetLog();
  const storedAtBefore = readCache().entries.find((e) => e.key === circle.gatewayBalanceCacheKey(ADDR)).storedAt;
  process.env.SELAT_NO_CIRCLE_CACHE = "1";
  try {
    assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
    assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
    assert.equal(calls(GW), 2);
  } finally {
    delete process.env.SELAT_NO_CIRCLE_CACHE;
  }
  assert.equal(readCache().entries.find((e) => e.key === circle.gatewayBalanceCacheKey(ADDR)).storedAt, storedAtBefore);
  assert.equal(cache.circleCacheDisabled({ SELAT_NO_CIRCLE_CACHE: "0" }), false);
  assert.equal(cache.circleCacheDisabled({}), false);
});

test("null and failed reads are never cached; lastCircleReadError still reflects the spawn", async () => {
  cache.invalidateCircleCache(circle.GATEWAY_BALANCE_KEY_PREFIX);
  resetLog();
  process.env.FAKE_CIRCLE_MODE = "fail";
  try {
    assert.equal(await circle.gatewayBalancesByChain(ADDR), null);
    assert.equal(await circle.gatewayBalancesByChain(ADDR), null);
    assert.equal(calls(GW), 2);
    assert.match(circle.lastCircleReadError(), /^circle gateway balance: .*503/);
  } finally {
    delete process.env.FAKE_CIRCLE_MODE;
  }
  assert.ok(!cachedKeys().includes(circle.gatewayBalanceCacheKey(ADDR)));
  // Errors and undefined pass through cachedCall untouched as well.
  const err = new Error("boom");
  assert.equal(await cache.cachedCall("probe:err", 60_000, async () => err, { cachePath }), err);
  assert.equal(await cache.cachedCall("probe:err", 60_000, async () => undefined, { cachePath }), undefined);
  assert.ok(!cachedKeys().includes("probe:err"));
  // The read recovers on the next healthy spawn.
  assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
  assert.equal(calls(GW), 3);
});

test("invalidateCircleCache(prefix) forces a re-spawn and leaves other keys alone", async () => {
  resetLog();
  await circle.gatewayBalancesByChain(ADDR);
  assert.equal(calls(GW), 0);
  assert.ok(cachedKeys().includes("probe:disk"));
  cache.invalidateCircleCache(circle.GATEWAY_BALANCE_KEY_PREFIX);
  assert.ok(!cachedKeys().includes(circle.gatewayBalanceCacheKey(ADDR)));
  assert.ok(cachedKeys().includes("probe:disk"));
  await circle.gatewayBalancesByChain(ADDR);
  assert.equal(calls(GW), 1);
  cache.invalidateCircleCache();
  assert.equal(existsSync(cachePath), false);
});

test("a corrupt cache file is tolerated and rewritten on the next store", async () => {
  cache.invalidateCircleCache();
  mkdirSync(join(stateHome, "selat"), { recursive: true });
  writeFileSync(cachePath, "{not json");
  resetLog();
  assert.equal(await circle.resolveFundedChainKey(ADDR), "polygon");
  assert.equal(calls(GW), 1);
  assert.equal(readCache().schema, "selat.circle-cache/v1");
  writeFileSync(cachePath, JSON.stringify({ schema: "something-else/v9", entries: "nope" }));
  assert.equal(cache.circleCacheStatus(circle.gatewayBalanceCacheKey(ADDR), { cachePath }), null);
  cache.invalidateCircleCache();
});

test("the `wallet list` fallback of getAgentAddress is cached; a partial listing is not; createWallets invalidates", async () => {
  cache.invalidateCircleCache();
  resetLog();
  const LIST = /^wallet list/;
  assert.equal(await circle.getAgentAddress(), ADDR);
  assert.equal(calls(LIST), 8);
  assert.equal(await circle.getAgentAddress(), ADDR);
  assert.equal(calls(LIST), 8);
  assert.ok(cachedKeys().some((k) => k.startsWith("wallet-list:agent:")));

  await circle.createWallets();
  assert.ok(!cachedKeys().some((k) => k.startsWith("wallet-list:")));
  assert.equal(await circle.getAgentAddress(), ADDR);
  assert.equal(calls(LIST), 16);
  // doctor's live listing bypasses the (now warm) entry.
  await circle.listAgentWallets({ cache: false });
  assert.equal(calls(LIST), 24);

  cache.invalidateCircleCache();
  resetLog();
  process.env.FAKE_CIRCLE_MODE = "list-fail";
  try {
    const first = await circle.listAgentWalletsDetailed();
    assert.equal(first.failures.length, 1);
    await circle.listAgentWalletsDetailed();
    assert.equal(calls(LIST), 16);
  } finally {
    delete process.env.FAKE_CIRCLE_MODE;
  }
  cache.invalidateCircleCache();
});

test("gatewayCacheLines: one line for each cache state", () => {
  assert.equal(gatewayCacheLines(null).length, 1);
  assert.match(gatewayCacheLines(null)[0], /balance cache: empty/);
  assert.match(gatewayCacheLines(null, { disabled: true })[0], /off \(SELAT_NO_CIRCLE_CACHE\)/);
  assert.match(gatewayCacheLines({ ageMs: 42_000 })[0], /42s old \(5 min ttl\)/);
  assert.match(gatewayCacheLines({ ageMs: 6 * 60_000 })[0], /6 min old \(expired/);
});

// ── End-to-end through bin/selat.mjs ─────────────────────────────────────────

const pexecFile = promisify(execFile);
const selatBin = fileURLToPath(new URL("../bin/selat.mjs", import.meta.url));
const runSelat = (args, extraEnv = {}) =>
  pexecFile(process.execPath, [selatBin, ...args], {
    env: {
      ...process.env,
      CIRCLE_BIN: fakeCircle,
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      SELAT_AGENT_WALLET_ADDRESS: ADDR,
      SELAT_PAY_HISTORY_PATH: join(dir, "history.jsonl"),
      SELAT_PAY_FREEZE_PATH: join(dir, "no-freeze.json"),
      NO_COLOR: "1",
      ...extraEnv
    }
  }).catch((e) => e);

// A stale-looking entry that says Base holds the funds; the fake circle says
// Polygon. Whoever reads live sees Polygon; whoever trusts the cache sees Base.
function seedBaseFundedEntry() {
  mkdirSync(join(stateHome, "selat"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    schema: "selat.circle-cache/v1",
    entries: [{
      key: circle.gatewayBalanceCacheKey(ADDR),
      value: { total: 9, perChain: [{ network: "Base", domain: 6, usdc: 9 }] },
      storedAt: Date.now() - 30_000
    }]
  }));
}

// Fake agent-payment skill: rank.mjs emits one runnable x402 pick; setup.mjs
// "deposits" by exiting 0. Fake selat-pay exits 0 with an empty payload.
const skillDir = join(dir, "skill", "scripts");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "rank.mjs"), `process.stdout.write(JSON.stringify({
  service: { name: "Example API" }, minAmountUsd: 0.01,
  exec_hints: [{ argv: ["selat-pay", "GET", "https://api.example/v1", "--max-amount", "0.05", "--chain", "base"] }]
}));\n`);
writeFileSync(join(skillDir, "setup.mjs"), "process.exit(0);\n");
const fakePay = join(dir, "fake-selat-pay.mjs");
writeFileSync(fakePay, "process.stdout.write('{}');\n");
const sessionPath = join(dir, "session.json");
writeFileSync(sessionPath, JSON.stringify({ sessionId: "s-cache", budgetUsd: 2 }));

test("`selat doctor` reads live, reports the cache age, and does not consume the entry", async () => {
  seedBaseFundedEntry();
  resetLog();
  const r = await runSelat(["doctor"]);
  assert.match(r.stdout, /Gateway balance: 4\.040000 USDC/, r.stdout + r.stderr);
  assert.match(r.stdout, /balance cache: \d+s old \(5 min ttl\)/);
  assert.ok(calls(GW) >= 1, "doctor must spawn a live gateway read");
  // Doctor neither consumed nor rewrote the run-time entry.
  assert.equal(readCache().entries[0].value.perChain[0].network, "Base");
});

test("`selat run` steers --chain by the cached balance, then invalidates after the paid attempt", async () => {
  seedBaseFundedEntry();
  resetLog();
  const r = await runSelat(["run", "--json", "--max-amount", "0.05", "weather"], {
    SELAT_SKILL_PATH: join(dir, "skill"),
    SELAT_PAY_BIN: fakePay,
    SELAT_PAY_SESSION_PATH: sessionPath
  });
  assert.equal(r.code ?? 0, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true, r.stdout);
  assert.equal(calls(GW), 0, "the pay-boundary chain resolution must come from the cache");
  assert.ok(!cachedKeys().includes(circle.gatewayBalanceCacheKey(ADDR)), "payment attempt must drop the balance entry");
});

test("`selat fund` reads the baseline and post-deposit balance live and invalidates after the deposit", async () => {
  seedBaseFundedEntry();
  resetLog();
  const r = await runSelat(["fund", "--amount", "1", "--chain", "base", "--yes"], {
    SELAT_SKILL_PATH: join(dir, "skill"),
    SELAT_PAY_SESSION_PATH: join(dir, "no-session.json")
  });
  assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
  assert.ok(calls(GW) >= 2, `baseline + post-deposit reads must be live (saw ${calls(GW)})`);
  assert.match(r.stdout, /4\.04/, "the displayed balance is the live one, not the cached Base row");
  assert.ok(!cachedKeys().includes(circle.gatewayBalanceCacheKey(ADDR)), "a completed deposit must drop the balance entry");
});

test("invokeSkill auto-resolves --chain from the cache and invalidates after each paid step", async () => {
  process.env.SELAT_PAY_BIN = fakePay;
  process.env.SELAT_PAY_SESSION_PATH = sessionPath;
  process.env.SELAT_PAY_FREEZE_PATH = join(dir, "no-freeze.json");
  process.env.SELAT_PAY_HISTORY_PATH = join(dir, "history.jsonl");
  process.env.SELAT_AGENT_WALLET_ADDRESS = ADDR;
  const { invokeSkill } = await import("../lib/skill-registry.mjs");
  const skillHome = join(configHome, "selat", "skills", "cache-demo");
  mkdirSync(skillHome, { recursive: true });
  writeFileSync(join(skillHome, "manifest.json"), JSON.stringify({
    schema: "selat-skill/v1",
    name: "cache-demo",
    description: "cache demo",
    steps: [{ method: "GET", url: "https://api.example.com/data", maxAmount: "0.05" }]
  }));
  try {
    seedBaseFundedEntry();
    cache.invalidateCircleCache("probe:"); // clear the memo namespace without touching the seeded entry
    resetLog();
    const stderr = [];
    const origErr = console.error;
    console.error = (...a) => stderr.push(a.join(" "));
    let res;
    try {
      res = await invokeSkill("cache-demo", {}, { capture: true });
    } finally {
      console.error = origErr;
    }
    assert.equal(res.code, 0, JSON.stringify(res.steps));
    assert.ok(stderr.some((l) => /paying on 'base'/.test(l)), "chain came from the seeded cache entry");
    assert.equal(calls(GW), 0);
    assert.ok(!cachedKeys().includes(circle.gatewayBalanceCacheKey(ADDR)), "each paid step must drop the balance entry");
  } finally {
    delete process.env.SELAT_AGENT_WALLET_ADDRESS;
    cache.invalidateCircleCache();
  }
});
