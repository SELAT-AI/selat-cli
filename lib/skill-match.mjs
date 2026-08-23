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
  "this", "that", "will", "can", "do", "does", "it", "its", "my", "your"
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
