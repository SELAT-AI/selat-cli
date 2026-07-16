import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_WAIT_TIMEOUT_MS,
  circleChainCode,
  depositCredited,
  formatElapsed,
  formatUsdc,
  fundingStageLines,
  qrFundArgs,
  qrShortfall,
  resolveWaitTimeout,
  unifiedBalanceLines,
  waitForGatewayCredit
} from "../lib/commands/fund.mjs";

// `selat fund` adopted Circle's unified-balance model (docs/ubk-spike.md):
// --wait polls the unified Gateway balance until the deposit is actually
// credited (success used to be reported 5–10 min early), every deposit prints
// the one-balance display so an on-chain drop doesn't read as lost funds, and
// an empty wallet gets a `circle wallet fund --method crypto --open` QR offer.
// These tests exercise the pure/injected helpers only — nothing here touches
// the Circle CLI or moves money (same pattern as fund-arc.test.mjs).

const ADDR = "0x" + "ab".repeat(20);

// --- resolveWaitTimeout -----------------------------------------------------

test("wait timeout defaults to 15 minutes", () => {
  assert.deepEqual(resolveWaitTimeout(null), { ok: true, ms: DEFAULT_WAIT_TIMEOUT_MS });
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 15 * 60_000);
});

test("wait timeout accepts seconds", () => {
  assert.deepEqual(resolveWaitTimeout("600"), { ok: true, ms: 600_000 });
});

test("wait timeout rejects zero, negatives, and junk", () => {
  for (const raw of ["0", "-5", "abc", ""]) {
    const res = resolveWaitTimeout(raw);
    assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
    assert.match(res.error, /--timeout/);
  }
});

// --- circleChainCode ---------------------------------------------------------

test("maps selat chain keys to Circle CLI chain codes", () => {
  assert.equal(circleChainCode("base"), "BASE");
  assert.equal(circleChainCode("optimism"), "OP");
  assert.equal(circleChainCode("arbitrum"), "ARB");
  assert.equal(circleChainCode("polygon"), "MATIC"); // Circle's Polygon code; "POLY" silently returns nothing
  assert.equal(circleChainCode("ethereum"), "ETH");
  assert.equal(circleChainCode("avalanche"), "AVAX");
  assert.equal(circleChainCode("unichain"), "UNI");
});

test("chain codes are case/whitespace tolerant", () => {
  assert.equal(circleChainCode(" Base "), "BASE");
  assert.equal(circleChainCode("POLYGON"), "MATIC");
});

test("returns null for chains the Circle CLI can't address", () => {
  // Arc mainnet deposits use the raw-EOA path; the QR branch must not fire.
  assert.equal(circleChainCode("arc"), null);
  assert.equal(circleChainCode("solana"), null);
  assert.equal(circleChainCode(null), null);
  assert.equal(circleChainCode(""), null);
});

// --- qrShortfall / qrFundArgs (empty-wallet QR branch) ------------------------

test("shortfall is the missing on-chain amount, rounded up to 6 decimals", () => {
  assert.equal(qrShortfall(2, 0.5), 1.5);
  assert.equal(qrShortfall(2, null), 2); // unreadable → treat as empty
  assert.equal(qrShortfall(2, 0), 2);
  assert.equal(qrShortfall(2, 5), 0); // already funded
  // 0.1 + 0.2 style float dust must round UP so the deposit never comes up short.
  assert.equal(qrShortfall(0.3, 0.1), 0.2);
  assert.ok(qrShortfall(1, 0.9999999) >= 0.0000001);
});

test("QR funding argv is the documented crypto+open flow and carries no secrets", () => {
  const args = qrFundArgs({ address: ADDR, chainCode: "BASE", amount: 1.5 });
  assert.deepEqual(args, [
    "wallet", "fund",
    "--address", ADDR,
    "--chain", "BASE",
    "--amount", "1.5",
    "--method", "crypto",
    "--open"
  ]);
  // The QR flow is pay-from-external-wallet: no key material may ever appear.
  assert.ok(!args.some((a) => /key|secret/i.test(a)));
});

// --- depositCredited ----------------------------------------------------------

test("credited when the total clears baseline + 90% of the deposit", () => {
  // Eco deposits deduct a fee, so face value is NOT required.
  assert.equal(depositCredited({ baselineTotal: 1, currentTotal: 2.8, amount: 2 }), true);
  assert.equal(depositCredited({ baselineTotal: 1, currentTotal: 2.79, amount: 2 }), false);
  assert.equal(depositCredited({ baselineTotal: 1, currentTotal: 3, amount: 2 }), true);
});

test("float dust at the exact threshold still counts as credited", () => {
  assert.equal(depositCredited({ baselineTotal: 0.1, currentTotal: 0.1 + 0.2 * 0.9, amount: 0.2 }), true);
});

test("pre-existing funds alone never count as the new credit", () => {
  assert.equal(depositCredited({ baselineTotal: 5, currentTotal: 5, amount: 2 }), false);
});

test("unreadable current balance is never credited", () => {
  assert.equal(depositCredited({ baselineTotal: 1, currentTotal: null, amount: 2 }), false);
});

test("missing baseline falls back to zero", () => {
  assert.equal(depositCredited({ baselineTotal: null, currentTotal: 1.8, amount: 2 }), true);
  assert.equal(depositCredited({ baselineTotal: null, currentTotal: 1.7, amount: 2 }), false);
});

// --- waitForGatewayCredit -----------------------------------------------------

/** Fake clock: sleep() advances now() — the poll loop runs without real time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("resolves credited once the polled total reflects the deposit", async () => {
  const { now, sleep } = fakeClock();
  const reads = [
    { total: 1, perChain: [] },
    { total: 1, perChain: [] },
    { total: 3, perChain: [{ network: "Base", domain: 6, usdc: 3 }] }
  ];
  let polls = 0;
  const res = await waitForGatewayCredit({
    address: ADDR,
    amount: 2,
    baselineTotal: 1,
    timeoutMs: 60_000,
    intervalMs: 10_000,
    readBalances: async () => reads.shift(),
    sleep,
    now,
    onPoll: () => { polls += 1; }
  });
  assert.equal(res.credited, true);
  assert.equal(res.balances.total, 3);
  assert.equal(res.elapsedMs, 20_000); // two sleeps before the crediting read
  assert.equal(polls, 2); // progress rendered before each sleep, not after success
});

test("times out (not credited) when the credit never lands", async () => {
  const { now, sleep } = fakeClock();
  let readCount = 0;
  const res = await waitForGatewayCredit({
    address: ADDR,
    amount: 2,
    baselineTotal: 1,
    timeoutMs: 30_000,
    intervalMs: 15_000,
    readBalances: async () => { readCount += 1; return { total: 1, perChain: [] }; },
    sleep,
    now
  });
  assert.equal(res.credited, false);
  assert.equal(readCount, 3); // 0s, 15s, 30s — reads at least once and up to the timeout
  assert.equal(res.elapsedMs, 30_000);
  assert.equal(res.balances.total, 1); // last read returned so the caller can display it
});

test("polls at least once even with a zero-ish timeout and keeps going on null reads", async () => {
  const { now, sleep } = fakeClock();
  const res = await waitForGatewayCredit({
    address: ADDR,
    amount: 2,
    baselineTotal: null,
    timeoutMs: 1,
    intervalMs: 15_000,
    readBalances: async () => null, // Circle CLI read failed
    sleep,
    now
  });
  assert.equal(res.credited, false);
  assert.equal(res.balances, null);
});

// --- display helpers ------------------------------------------------------------

test("formatUsdc renders cents, keeps sub-cent dust visible", () => {
  assert.equal(formatUsdc(2.5), "$2.50");
  assert.equal(formatUsdc(0.01), "$0.01");
  assert.equal(formatUsdc(0.001), "$0.001000"); // never "$0.00" — that reads as lost funds
  assert.equal(formatUsdc(0), "$0.00");
  assert.equal(formatUsdc(null), "$?");
  assert.equal(formatUsdc("nope"), "$?");
});

test("formatElapsed renders seconds and minutes", () => {
  assert.equal(formatElapsed(45_000), "45s");
  assert.equal(formatElapsed(90_000), "1m30s");
  assert.equal(formatElapsed(900_000), "15m0s");
  assert.equal(formatElapsed(0), "0s");
});

test("balance display is ONE figure with no chain enumeration by default", () => {
  const lines = unifiedBalanceLines({
    total: 4.04,
    perChain: [
      { network: "Base", domain: 6, usdc: 0 },
      { network: "Polygon", domain: 7, usdc: 4.04 }
    ]
  });
  assert.match(lines[0], /Gateway balance: \$4\.04/);
  assert.match(lines[0], /spendable on any supported chain/);
  // Chain enumeration confuses (live onboarding feedback): NO per-chain rows
  // by default — Gateway is one balance, not per-chain buckets.
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotMatch(line, /Base|Polygon/);
  }
  // The "funds look lost" moment: the by-design note must always be present.
  assert.match(lines.at(-1), /by design/);
  assert.match(lines.at(-1), /not lost/);
});

test("--by-chain opts into the per-chain routing detail", () => {
  const lines = unifiedBalanceLines({
    total: 4.04,
    perChain: [
      { network: "Base", domain: 6, usdc: 0 },
      { network: "Polygon", domain: 7, usdc: 4.04 }
    ]
  }, { byChain: true });
  // Eco settles on Polygon; the per-chain row stays demoted to a routing
  // detail (and zero-balance chains are not listed).
  assert.match(lines[1], /Polygon \$4\.04/);
  assert.doesNotMatch(lines[1], /Base/);
  assert.match(lines[1], /routing detail/);
  assert.match(lines.at(-1), /by design/);
});

test("balance display omits per-chain rows even with --by-chain when nothing is funded", () => {
  const lines = unifiedBalanceLines(
    { total: 0, perChain: [{ network: "Base", domain: 6, usdc: 0 }] },
    { byChain: true }
  );
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\$0\.00/);
  assert.match(lines[1], /by design/);
});

test("unreadable balances explain themselves without failing the deposit", () => {
  for (const input of [null, {}, { total: null }]) {
    const lines = unifiedBalanceLines(input);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /unreadable/);
    assert.match(lines[0], /deposit is unaffected/);
  }
});

// --- fundingStageLines (stage-explicit empty-wallet framing) --------------------

test("empty-wallet funding is framed as two explicit steps", () => {
  const lines = fundingStageLines({ shortfall: 2 });
  const text = lines.join("\n");
  assert.match(text, /two steps/i);
  assert.match(text, /Step 1 of 2 — get \$2\.00 USDC to your agent wallet address/);
  assert.match(text, /QR \/ manual details below/);
  assert.match(text, /Step 2 of 2 — re-run `selat fund` to deposit/);
  assert.match(text, /one spendable Gateway balance/);
});

test("fundingStageLines tolerates a missing shortfall", () => {
  const text = fundingStageLines({}).join("\n");
  assert.match(text, /Step 1 of 2 — get USDC to your agent wallet address/);
});
