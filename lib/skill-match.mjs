/**
 * Lightweight vetted-skill matching for `selat search`.
 *
 * `selat search` only ever ranks the federated catalog (see search.mjs) — it
 * has no path back to the vetted-skills registry, so an intent that's a
 * strong match for an installed/available skill (e.g. "is NVDA stock bullish
 * or bearish" vs. the stock-direction-signals skill) surfaces zero signal
 * that a vetted skill exists at all. This module adds that signal as a
 * best-effort, additive suggestion — it never replaces or reorders the
 * federated shortlist search.mjs already prints.
 *
 * Scoring is plain token overlap (no embeddings, no new dependency): every
 * intent token that also appears in the skill's name scores 3, every one
 * that appears only in the description scores 1. A single name-token hit
 * clears the default threshold; three overlapping description-only tokens
 * do too.
 */

import { listAvailable } from "./skill-registry.mjs";

const STOPWORDS = new Set([
  "is", "the", "a", "an", "or", "and", "for", "to", "of", "in", "on", "with",
  "this", "that", "will", "can", "do", "does", "it", "its", "my", "your",

  // Generic imperative verbs: they open almost any user intent ("find a
  // coffee shop", "get me a report") without naming a domain, and several
  // also happen to open a skill name or its description's restated first
  // line (e.g. "Find Twitter/X influencers…") — so without this list a
  // single throwaway verb clears the name-token threshold on its own.
  // Confirmed regression: "find a coffee shop near me" was matching
  // find-twitter-influencers on "find" alone, score 4, zero domain overlap.
  "find", "get", "give", "show", "tell", "need", "want", "use", "help",
  "check", "make", "book", "send", "create", "build", "look", "let", "try",

  // Payment/settlement-mechanics boilerplate: nearly every skill description
  // ends with some form of "Paid per call via x402/MPP…", so these score as
  // false domain signal for any unrelated intent that happens to mention
  // payment. Verified empirically: "call"/"via"/"paid"/"per" each appear in
  // 18-19 of 20 registry entries — pure infrastructure vocabulary, not a
  // discriminating capability description.
  "paid", "pay", "per", "via", "mpp", "x402", "tempo", "usdc", "circle",
  "gateway", "call", "rail", "rails", "routed", "router", "selat"
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and short noise tokens. */
function tokenize(text) {
  return [...new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
  )];
}

/** Score one skill against an intent. Exported for direct unit testing (no network). */
export function scoreSkillMatch(intent, skill) {
  const intentTokens = new Set(tokenize(intent));
  if (intentTokens.size === 0) return 0;
  const nameTokens = tokenize(String(skill?.name ?? "").replace(/-/g, " "));
  const descTokens = tokenize(skill?.description);
  let score = 0;
  for (const t of nameTokens) if (intentTokens.has(t)) score += 3;
  for (const t of descTokens) if (intentTokens.has(t)) score += 1;
  return score;
}

/**
 * Best-scoring skill for an intent, or null below threshold. Exported for
 * direct unit testing against a fixture list — no network involved.
 */
export function findVettedSkillMatch(intent, skills, { threshold = 3 } = {}) {
  let best = null;
  for (const skill of skills ?? []) {
    const score = scoreSkillMatch(intent, skill);
    if (score >= threshold && (!best || score > best.score)) best = { skill, score };
  }
  return best;
}

/**
 * Fetch the vetted-skills registry and return the best match for `intent`,
 * or null. Never throws — callers get a clean "no suggestion" on any
 * registry fetch failure (offline, GitHub hiccup, malformed index.json),
 * matching the rest of this CLI's best-effort footers (see
 * printProbeNextStep in commands/search.mjs).
 */
export async function matchVettedSkill(intent, { threshold = 3 } = {}) {
  try {
    const skills = await listAvailable();
    return findVettedSkillMatch(intent, skills, { threshold });
  } catch {
    return null;
  }
}
