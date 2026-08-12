import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Per-chain spending-policy truth. Verified live 2026-08-11 (dev wallet
// 0xb291…e4da): Circle stores STABLECOIN_TRANSFER policies as per-(wallet,
// chain) rows with origin CUSTOM|DEFAULT, and the signing service enforces
// whichever row governs the SOURCE chain — including EIP-712/ERC-3009
// typed-data signing (a $6 authorization on BASE was refused under BASE's
// $5/tx CUSTOM cap while a $5.19 deposit on ARB sailed through under ARB's
// $100/mo DEFAULT). These tests pin: the per-chain read, per-chain doctor
// lines with origin, fund's deposit-chain plan line, and setup-policy's
// every-chain write plan.

const dir = mkdtempSync(join(tmpdir(), "selat-per-chain-policy-"));

// Fake Circle CLI mirroring the live wallet: CUSTOM caps on BASE only, the
// $100/mo DEFAULT on ARB, and a hard error on every other chain (the wallet
// doesn't exist there / the read fails).
const fakeCircle = join(dir, "fake-circle");
writeFileSync(fakeCircle, `#!/bin/sh
case "$*" in
  *"limit budget"*) exit 1 ;;
  *"--chain BASE"*)
    echo '{"data":{"policies":[{"origin":"CUSTOM","ruleType":"TRANSFER_LIMIT","perTxLimit":"5","dailyLimit":"50","weeklyLimit":"200","monthlyLimit":"500"}]}}'
    ;;
  *"--chain ARB"*)
    echo '{"data":{"policies":[{"origin":"DEFAULT","ruleType":"TRANSFER_LIMIT","monthlyLimit":"100"}]}}'
    ;;
  *) exit 1 ;;
esac
`);
chmodSync(fakeCircle, 0o755);

// Route circle shell-outs at the fake BEFORE lib/circle.mjs captures
// CIRCLE_BIN at module load (hence the dynamic imports).
process.env.CIRCLE_BIN = fakeCircle;
const {
  policyRowFromLimitPayload,
  chainSpendingPolicy,
  spendingPolicyByChain,
  chainsForAddress,
  describeChainPolicy,
  formatCapList
} = await import("../lib/circle.mjs");
const { policyDoctorLines } = await import("../lib/commands/doctor.mjs");
const { policyPlanLine, circleChainCode, ecoPolygonPolicyNudgeLines } = await import("../lib/commands/fund.mjs");
const { sameCaps, planPolicyWrites, plannedOtpCount, parseSetupPolicyArgs } = await import("../lib/commands/setup-policy.mjs");

const ADDRESS = "0xb291279be48742f0a1e9ed15c8d6d2d09ea9e4da";

const CUSTOM_LIMITS = { perTx: 5, daily: 50, weekly: 200, monthly: 500 };
const DEFAULT_LIMITS = { perTx: null, daily: null, weekly: null, monthly: 100 };
const CUSTOM_ROW = { readable: true, chain: "BASE", origin: "CUSTOM", limits: CUSTOM_LIMITS };
const DEFAULT_ROW = { readable: true, chain: "ARB", origin: "DEFAULT", limits: DEFAULT_LIMITS };

test("policyRowFromLimitPayload: CUSTOM row, DEFAULT row with real limits, precedence, malformed", () => {
  // BASE live shape — the user's custom caps
  assert.deepEqual(
    policyRowFromLimitPayload({ data: { policies: [{ origin: "CUSTOM", ruleType: "TRANSFER_LIMIT", perTxLimit: "5", dailyLimit: "50", weeklyLimit: "200", monthlyLimit: "500" }] } }),
    { origin: "CUSTOM", limits: CUSTOM_LIMITS }
  );
  // ARB live shape — DEFAULT rows carry real, enforced limits and must not be dropped
  assert.deepEqual(
    policyRowFromLimitPayload({ data: { policies: [{ origin: "DEFAULT", ruleType: "TRANSFER_LIMIT", monthlyLimit: "100" }] } }),
    { origin: "DEFAULT", limits: DEFAULT_LIMITS }
  );
  // a CUSTOM row wins when both appear
  assert.equal(
    policyRowFromLimitPayload({ data: { policies: [
      { origin: "DEFAULT", ruleType: "TRANSFER_LIMIT", monthlyLimit: "100" },
      { origin: "CUSTOM", ruleType: "TRANSFER_LIMIT", perTxLimit: "5" }
    ] } }).origin,
    "CUSTOM"
  );
  // non-transfer rules are ignored
  assert.deepEqual(
    policyRowFromLimitPayload({ data: { policies: [{ origin: "CUSTOM", ruleType: "RECIPIENT_BLOCKLIST" }] } }),
    { origin: null, limits: null }
  );
  assert.deepEqual(policyRowFromLimitPayload({ data: { policies: [] } }), { origin: null, limits: null });
  assert.equal(policyRowFromLimitPayload({ data: { policies: "nope" } }), null);
});

test("chainSpendingPolicy / spendingPolicyByChain read the live per-chain split", async () => {
  assert.deepEqual(await chainSpendingPolicy(ADDRESS, "BASE"), CUSTOM_ROW);
  assert.deepEqual(await chainSpendingPolicy(ADDRESS, "ARB"), DEFAULT_ROW);
  // a failing read (wallet absent on the chain) degrades, never throws
  assert.deepEqual(await chainSpendingPolicy(ADDRESS, "ETH"), { readable: false, chain: "ETH" });
  assert.deepEqual(await chainSpendingPolicy(null, "BASE"), { readable: false, chain: "BASE" });
  assert.deepEqual(await chainSpendingPolicy(ADDRESS, null), { readable: false, chain: null });

  const rows = await spendingPolicyByChain(ADDRESS, { chains: ["BASE", "ARB", "ETH"] });
  assert.deepEqual(rows, [CUSTOM_ROW, DEFAULT_ROW, { readable: false, chain: "ETH" }]);
});

test("chainsForAddress finds the discovered wallet's chains, case-insensitively", () => {
  const wallets = [
    { address: ADDRESS.toUpperCase().replace("0X", "0x"), chains: ["BASE", "ARB"] },
    { address: "0x" + "1".repeat(40), chains: ["ETH"] }
  ];
  assert.deepEqual(chainsForAddress(wallets, ADDRESS), ["BASE", "ARB"]);
  assert.deepEqual(chainsForAddress(wallets, "0x" + "2".repeat(40)), []);
  assert.deepEqual(chainsForAddress(null, ADDRESS), []);
});

test("describeChainPolicy names the origin and never claims coverage a chain lacks", () => {
  assert.equal(describeChainPolicy(CUSTOM_ROW), "capped at $5/tx · $50/day · $200/wk · $500/mo (your custom caps)");
  assert.equal(describeChainPolicy(DEFAULT_ROW), "Circle DEFAULT ($100/mo) — your custom caps do not govern here");
  assert.equal(describeChainPolicy({ readable: true, chain: "OP", origin: "DEFAULT", limits: {} }), "Circle DEFAULT — no custom caps govern here");
  assert.equal(describeChainPolicy({ readable: false, chain: "ETH" }), "unknown (could not read this chain's policy)");
  assert.equal(describeChainPolicy(null), "unknown (could not read this chain's policy)");
  assert.equal(formatCapList(DEFAULT_LIMITS), "$100/mo");
  assert.equal(formatCapList({}), null);
});

test("doctor lists per-chain caps with origin; a DEFAULT chain is a warn", () => {
  const lines = policyDoctorLines([CUSTOM_ROW, DEFAULT_ROW, { readable: false, chain: "ETH" }]);
  assert.deepEqual(lines.map((l) => l.level), ["pass", "warn", "dim"]);
  assert.match(lines[0].text, /^BASE: capped at \$5\/tx · \$50\/day · \$200\/wk · \$500\/mo \(your custom caps\)$/);
  assert.match(lines[1].text, /^ARB: Circle DEFAULT \(\$100\/mo\) — your custom caps do not govern here$/);
  assert.match(lines[2].text, /setup-policy/);

  // full coverage: per-chain passes, no nag line
  const covered = policyDoctorLines([CUSTOM_ROW, { ...CUSTOM_ROW, chain: "ARB" }]);
  assert.deepEqual(covered.map((l) => l.level), ["pass", "pass"]);

  // no custom caps anywhere: the drain warning, pointing at setup-policy
  const uncapped = policyDoctorLines([DEFAULT_ROW, { ...DEFAULT_ROW, chain: "OP" }]);
  assert.equal(uncapped[0].level, "warn");
  assert.match(uncapped[0].text, /no custom spending caps on any chain/);
  assert.match(uncapped[1].text, /setup-policy/);

  // nothing readable: one warn, no false claims
  for (const rows of [[], null, [{ readable: false, chain: "BASE" }]]) {
    const l = policyDoctorLines(rows);
    assert.equal(l.length, 1);
    assert.equal(l[0].level, "warn");
    assert.match(l[0].text, /could not read/);
  }
});

test("fund's plan line shows the policy governing the DEPOSIT chain", () => {
  // the exact live gap: depositing on Arbitrum while the caps live on BASE
  assert.equal(
    policyPlanLine({ chainKey: "arbitrum", policy: DEFAULT_ROW }),
    "on arbitrum: Circle DEFAULT ($100/mo) — your custom caps do not govern here"
  );
  assert.equal(
    policyPlanLine({ chainKey: "base", policy: CUSTOM_ROW }),
    "on base: capped at $5/tx · $50/day · $200/wk · $500/mo (your custom caps)"
  );
  // Arc has no Circle chain code → the read degrades to unknown, named as such
  assert.equal(circleChainCode("arc"), null);
  assert.equal(
    policyPlanLine({ chainKey: "arc", policy: { readable: false, chain: null } }),
    "on arc: unknown (could not read this chain's policy)"
  );
});

test("sameCaps: string caps vs numeric limits, null-safe", () => {
  const caps = { perTx: "5", daily: "50", weekly: "200", monthly: "500" };
  assert.equal(sameCaps(CUSTOM_LIMITS, caps), true);
  assert.equal(sameCaps({ ...CUSTOM_LIMITS, daily: 60 }, caps), false);
  assert.equal(sameCaps(DEFAULT_LIMITS, caps), false);
  assert.equal(sameCaps(null, caps), false);
  assert.equal(sameCaps(CUSTOM_LIMITS, { perTx: "5" }), false); // missing caps never match
});

test("planPolicyWrites: skip matching CUSTOM, reset+set differing CUSTOM, set DEFAULT/unreadable", () => {
  const caps = { perTx: "5", daily: "50", weekly: "200", monthly: "500" };
  const plan = planPolicyWrites({
    rows: [
      CUSTOM_ROW,                                                            // matches → skip
      { readable: true, chain: "OP", origin: "CUSTOM", limits: { ...CUSTOM_LIMITS, perTx: 10 } }, // differs → reset+set
      DEFAULT_ROW,                                                           // default → set
      { readable: false, chain: "ETH" }                                      // unreadable → set (attempt)
    ],
    caps
  });
  assert.deepEqual(plan.map((p) => [p.chain, p.action, p.otps]), [
    ["BASE", "skip", 0],
    ["OP", "reset+set", 2],
    ["ARB", "set", 1],
    ["ETH", "set", 1]
  ]);
  assert.equal(plannedOtpCount(plan), 4);
  assert.deepEqual(planPolicyWrites({ rows: [], caps }), []);
});

test("setup-policy defaults to every chain (chain: null); --chain scopes one write", () => {
  assert.equal(parseSetupPolicyArgs([]).chain, null);
  assert.equal(parseSetupPolicyArgs(["--chain", "arb"]).chain, "ARB");
});

// Eco settles into Gateway on Polygon; spends from that balance authorize on
// Polygon, so the completion nudge points there (not the Base/OP/Arb source).
test("eco Polygon nudge: silent when Polygon already carries a CUSTOM policy", () => {
  assert.deepEqual(ecoPolygonPolicyNudgeLines({ readable: true, origin: "CUSTOM", chain: "MATIC" }), []);
});

test("eco Polygon nudge: warns when Polygon is on Circle's DEFAULT (uncapped)", () => {
  const lines = ecoPolygonPolicyNudgeLines({ readable: true, origin: "DEFAULT", chain: "MATIC" });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /settles into Gateway on Polygon.*not the source chain/);
  assert.match(lines[1], /no custom cap.*selat setup-policy/);
});

test("eco Polygon nudge: warns (confirm) when Polygon's policy is unreadable", () => {
  for (const pol of [null, { readable: false }]) {
    const lines = ecoPolygonPolicyNudgeLines(pol);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /Couldn't read Polygon's policy.*selat setup-policy/);
  }
});
