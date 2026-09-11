/**
 * Capability-catalog status — the install-time warm and the doctor readout.
 *
 * Discovery ranks over the federated catalog. Since selat-discovery 0.24.13
 * that catalog is pulled as one ~1.2 MB envelope from catalog.selat.ai,
 * already merged and schema-enriched by the hosted builder, and cached per
 * USER (under $XDG_STATE_HOME/selat) rather than per project directory. Two
 * things follow, and this module exists for both:
 *
 *   - `selat init` can warm it once, at install time, and every later `selat
 *     search` / `selat run` in any directory starts warm. Without the warm the
 *     first command a user runs pays for the pull (and, on an older skill that
 *     builds locally from eight registries, ~50 s of registry crawling).
 *   - `selat doctor` can say which tier answered (hosted / stale copy / local
 *     build), how old it is, and how much of it carries request schemas —
 *     the difference between "the ranker had data" and "the ranker guessed".
 *
 * Resolution goes through the installed skill, not a package import, so a
 * SELAT_SKILL_PATH checkout and the bundled dependency behave identically
 * (same seam as run.mjs's ranker import). An older skill without the hosted
 * module is not an error here: discovery still works by building locally, so
 * this degrades to a note rather than a failure.
 *
 * Nothing here is a payment path. The catalog decides what an agent can find
 * and what a plan quotes as a floor; the live 402, --max-amount, the session
 * budget, freeze and Circle policy decide what may actually be spent.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findSkill } from "./skill.mjs";

/** Where the hosted-catalog module lives inside an installed skill. */
export function hostedCatalogModulePath(skillPath) {
  return join(skillPath, "scripts", "lib", "hosted-catalog.mjs");
}

/**
 * Fetch (or read) the hosted catalog and summarize it. Never throws: every
 * failure becomes `{ ok: false, reason }` so a warm step or a doctor line can
 * report it without breaking the command it runs inside.
 *
 * reasons: "no-skill" | "unsupported" (skill predates the hosted tier) |
 *          "load-failed" | "fetch-failed"
 */
export async function fetchCatalogStatus({ refresh = false, skill = findSkill("rank.mjs") } = {}) {
  if (!skill.found) return { ok: false, reason: "no-skill" };
  const modPath = hostedCatalogModulePath(skill.path);
  if (!existsSync(modPath)) return { ok: false, reason: "unsupported" };

  let mod;
  try {
    mod = await import(pathToFileURL(modPath).href);
  } catch (err) {
    return { ok: false, reason: "load-failed", error: err?.message ?? String(err) };
  }
  if (typeof mod.loadOrFetchHostedCatalog !== "function") return { ok: false, reason: "unsupported" };

  try {
    const res = await mod.loadOrFetchHostedCatalog({ refresh, warn: () => {} });
    const services = res?.catalog?.services ?? [];
    let endpoints = 0;
    let withSchema = 0;
    for (const s of services) {
      for (const e of s.endpoints ?? []) {
        endpoints += 1;
        if (e.inputSchema) withSchema += 1;
      }
    }
    return {
      ok: true,
      tier: res.tier ?? "hosted",
      generatedAt: res.generatedAt ?? null,
      ageHours: res.ageHours ?? null,
      services: services.length,
      endpoints,
      withSchema,
      cachePath: typeof mod.hostedCachePath === "function" ? mod.hostedCachePath() : null,
      ...(res.error ? { error: res.error } : {}),
    };
  } catch (err) {
    return { ok: false, reason: "fetch-failed", error: err?.message ?? String(err) };
  }
}

/**
 * Render a status as display lines: `[head, ...detail]`. Pure, so the wording
 * is unit-tested without a network or a skill on disk. `kind` tells the caller
 * whether to print the head as ok / warn / info.
 */
export function catalogStatusLines(status) {
  if (status?.ok) {
    const pct = status.endpoints > 0 ? Math.round((status.withSchema / status.endpoints) * 100) : 0;
    const head = `${status.services} services, ${status.endpoints} endpoints (${pct}% with request schemas)`;
    const detail = [];
    if (status.tier === "hosted-stale") {
      detail.push(
        `served from a cached copy${status.ageHours != null ? ` (~${status.ageHours}h old)` : ""} — the live fetch failed${status.error ? `: ${status.error}` : ""}`,
      );
    } else if (status.generatedAt) {
      detail.push(`built ${status.generatedAt} by catalog.selat.ai`);
    }
    return { kind: status.tier === "hosted-stale" ? "warn" : "ok", lines: [head, ...detail] };
  }

  switch (status?.reason) {
    case "no-skill":
      return { kind: "warn", lines: ["skipped — the agent-payment skill is not installed"] };
    case "unsupported":
      return {
        kind: "info",
        lines: [
          "skipped — this skill builds the catalog locally on first use",
          "update @selat-ai/selat-discovery to fetch the pre-enriched catalog instead",
        ],
      };
    case "load-failed":
      return { kind: "warn", lines: [`could not load the catalog module${status.error ? `: ${status.error}` : ""}`] };
    default:
      return {
        kind: "warn",
        lines: [
          `could not fetch the catalog${status?.error ? `: ${status.error}` : ""}`,
          "discovery still works — the catalog is built on first search instead",
        ],
      };
  }
}
