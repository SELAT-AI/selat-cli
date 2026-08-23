import test from "node:test";
import assert from "node:assert/strict";

import { scoreSkillMatch, findVettedSkillMatch } from "../lib/skill-match.mjs";

// Fixtures are the real registry entries (selat-skills/index.json) for the
// skills this suite discriminates between — not synthetic text — so this test
// is pinned to the actual regression: `selat search "is NVDA stock bullish or
// bearish"` found nothing, because search.mjs never consulted this registry.
const STOCK_DIRECTION_SIGNALS = {
  name: "stock-direction-signals",
  rail: "multi/mixed",
  kind: "multi",
  description:
    "Provider-filtered stock direction research — Alpha Vantage MPP for quote/chart/technicals/news/earnings, SELAT-native Twitter for social chatter, Circle StableEnrich for Reddit, Circle Otto for TradFi macro — fused into a non-advisory bullish/bearish/mixed brief. Paid per call via selat-pay across mixed rails (MPP on Tempo + x402 on Base) via the SELAT Router."
};

const PERPLEXITY_SEARCH = {
  name: "perplexity-search",
  rail: "single/routed",
  kind: "single",
  description:
    "Web search via Perplexity's x402 endpoint (paysponge gateway), routed through the SELAT Router. Returns ranked web results with page content and source URLs for the agent to synthesize into a cited answer. Paid per call (USDC on Base), no API key."
};

const WALLET_DESK_BRIEF = {
  name: "wallet-desk-brief",
  rail: "multi/x402 via Circle Gateway",
  kind: "multi",
  description:
    "Who-is-this-wallet brief for one EVM address — Alchemy token-by-address holdings (x402 via Circle Gateway; verify prints routed-x402) plus Arkham intelligence/address attribution (x402 via Circle Gateway; verify prints routed-x402). Read only. Paid per call via selat-pay (USDC via Circle Gateway)."
};

const FIND_TWITTER_INFLUENCERS = {
  name: "find-twitter-influencers",
  rail: "multi/mixed",
  kind: "multi",
  description:
    "Find Twitter/X influencers (Scrape Creators, Fiber, Exa, Brand.dev, Hunter, Tomba). Paid per call via x402 + MPP."
};

const REGISTRY = [
  STOCK_DIRECTION_SIGNALS,
  PERPLEXITY_SEARCH,
  WALLET_DESK_BRIEF,
  FIND_TWITTER_INFLUENCERS
];

// ── scoreSkillMatch ──────────────────────────────────────────────────────────

test("scoreSkillMatch: the exact regression intent scores well above threshold on its real skill", () => {
  const score = scoreSkillMatch("is NVDA stock bullish or bearish", STOCK_DIRECTION_SIGNALS);
  // "stock" hits the name (3) once deduped; "bullish"/"bearish" hit the description (1 each).
  assert.ok(score >= 3, `expected score >= 3, got ${score}`);
});

test("scoreSkillMatch: a name-token hit alone clears the default threshold", () => {
  const score = scoreSkillMatch("give me a stock report", STOCK_DIRECTION_SIGNALS);
  assert.ok(score >= 3, `expected score >= 3, got ${score}`);
});

test("scoreSkillMatch: unrelated intent scores zero against an unrelated skill", () => {
  assert.equal(scoreSkillMatch("is NVDA stock bullish or bearish", WALLET_DESK_BRIEF), 0);
});

test("scoreSkillMatch: stopwords never contribute to the score", () => {
  assert.equal(scoreSkillMatch("is the a or and for to of in on with", STOCK_DIRECTION_SIGNALS), 0);
});

test("scoreSkillMatch: empty or missing intent scores zero", () => {
  assert.equal(scoreSkillMatch("", STOCK_DIRECTION_SIGNALS), 0);
  assert.equal(scoreSkillMatch("   ", STOCK_DIRECTION_SIGNALS), 0);
});

// ── findVettedSkillMatch ─────────────────────────────────────────────────────

test("findVettedSkillMatch: picks stock-direction-signals for the regression intent, not the other two", () => {
  const match = findVettedSkillMatch("is NVDA stock bullish or bearish", REGISTRY);
  assert.ok(match, "expected a match, got null");
  assert.equal(match.skill.name, "stock-direction-signals");
});

test("findVettedSkillMatch: picks perplexity-search for an unrelated web-search intent", () => {
  const match = findVettedSkillMatch("search the web for recent news", REGISTRY);
  assert.ok(match, "expected a match, got null");
  assert.equal(match.skill.name, "perplexity-search");
});

test("findVettedSkillMatch: returns null when nothing in the registry clears the threshold", () => {
  const match = findVettedSkillMatch("book me a flight to Tokyo", REGISTRY);
  assert.equal(match, null);
});

test("findVettedSkillMatch: returns null on an empty registry", () => {
  assert.equal(findVettedSkillMatch("is NVDA stock bullish or bearish", []), null);
});

// ── Generic-verb and boilerplate stopwords ───────────────────────────────────
// Regression: a throwaway imperative verb ("find") or payment-mechanics
// boilerplate ("paid per call via MPP") scored full match weight, so an intent
// with zero domain overlap could clear the threshold on that alone.

test("a generic verb shared with a skill name is not, by itself, a match", () => {
  // "find a coffee shop near me" scored 4 against find-twitter-influencers
  // purely on the verb "find" before this was fixed.
  assert.equal(scoreSkillMatch("find a coffee shop near me", FIND_TWITTER_INFLUENCERS), 0);
  assert.equal(findVettedSkillMatch("find a coffee shop near me", REGISTRY), null);
});

test("other generic imperative verbs likewise carry no weight", () => {
  for (const intent of ["get me a report", "show me the results", "book a table for two"]) {
    assert.equal(
      findVettedSkillMatch(intent, REGISTRY),
      null,
      `expected no match for ${JSON.stringify(intent)}`
    );
  }
});

test("a real domain term still matches the same skill the generic verb did not", () => {
  const match = findVettedSkillMatch("find twitter influencers in fintech", REGISTRY);
  assert.ok(match, "expected a match, got null");
  assert.equal(match.skill.name, "find-twitter-influencers");
});

test("payment-mechanics boilerplate is not domain signal", () => {
  // Every skill description ends with some form of "Paid per call via
  // x402/MPP…", so these tokens must not let an unrelated payment-flavored
  // intent match an arbitrary skill.
  assert.equal(findVettedSkillMatch("what does this cost paid per call", REGISTRY), null);
  assert.equal(findVettedSkillMatch("pay via mpp on tempo with usdc", REGISTRY), null);
});

test("findVettedSkillMatch: a higher --threshold can suppress a weak match", () => {
  const weakIntent = "bearish";
  const loose = findVettedSkillMatch(weakIntent, REGISTRY, { threshold: 1 });
  const strict = findVettedSkillMatch(weakIntent, REGISTRY, { threshold: 10 });
  assert.ok(loose, "expected the loose threshold to match");
  assert.equal(strict, null);
});
