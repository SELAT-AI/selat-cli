/**
 * Read-through TTL cache for slow Circle CLI lookups.
 *
 * Every `circle` invocation costs 4–17 s on a typical host (the bundle also
 * checks npm for a newer version at startup), and `selat run` spawned it fresh
 * before every payment just to ask which Gateway chain holds the funds.
 * Successful reads are kept here — one JSON file under the per-user STATE dir
 * plus an in-process memo so a single command never re-reads or re-spawns.
 *
 * INVARIANT — never a spending gate. A cached value only affects WHICH funded
 * chain `--chain` is set to and what balances are DISPLAYED. Freeze, the
 * session budget, --max-amount and Circle wallet policy never read this file;
 * a stale balance that picks an unfunded chain fails loudly and unpaid in
 * selat-pay (settle rejected, nothing charged). Nothing here is trusted for
 * "may this payment happen".
 *
 * Trust boundary: the file lives under `XDG_STATE_HOME || ~/.local/state`
 * resolved from process.env ONLY. selat-cli loads no dotenv, so a
 * directory-local ./.env cannot retarget it (selat-pay isolates the same key
 * via CWD_ISOLATED_ENV_KEYS). Failures are never cached: a null / undefined /
 * Error result is passed through untouched, so a Circle burst can't be frozen
 * for the TTL. Corrupt or missing files read as empty (fail OPEN — the worst
 * case is one more spawn).
 *
 * Knobs (shell env only): SELAT_NO_CIRCLE_CACHE=1 bypasses lookup AND store;
 * SELAT_CIRCLE_CACHE_TTL_MS overrides every caller's TTL.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = "selat.circle-cache/v1";

function stateHome() {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}
/** `<state>/selat/circle-cache.json` — CLI-owned, hence `selat/` not `selat-pay/`. */
export function circleCachePath() {
  return join(stateHome(), "selat", "circle-cache.json");
}

export function circleCacheDisabled(env = process.env) {
  const v = String(env.SELAT_NO_CIRCLE_CACHE ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

function effectiveTtl(ttlMs, env = process.env) {
  // A blank or whitespace-only value is "unset", not zero: Number("") === 0,
  // which would silently make every lookup miss while every read still
  // rewrote the file.
  const raw = String(env.SELAT_CIRCLE_CACHE_TTL_MS ?? "").trim();
  if (raw === "") return ttlMs;
  const override = Number(raw);
  return Number.isFinite(override) && override >= 0 ? override : ttlMs;
}

// In-process memo, keyed by file path so a test that repoints XDG_STATE_HOME
// starts from a clean slate. Holds the same { value, storedAt } rows as disk.
const memo = new Map();
const memoKey = (path, key) => `${path}\0${key}`;

function readFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema !== SCHEMA || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e) => e && typeof e.key === "string" && Number.isFinite(e.storedAt) && e.value != null
    );
  } catch {
    return [];
  }
}

// tmp + rename so a crash mid-write never leaves a torn file for the next
// process to trip on (the reader would recover, but a whole-file rewrite is
// cheap enough to do properly). Best-effort: a write failure only costs the
// next spawn.
function writeFile(path, entries) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Random suffix + "wx" so the write fails rather than following a
    // pre-planted symlink of a guessable name (mode alone only applies on
    // create). Reachable only via a shared XDG_STATE_HOME, but it is free.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, entries }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch { /* cache is an optimisation */ }
}

function lookup(path, key, ttlMs, now) {
  const fresh = (e) => e && now - e.storedAt >= 0 && now - e.storedAt < ttlMs;
  const inMemory = memo.get(memoKey(path, key));
  if (fresh(inMemory)) return inMemory.value;
  const onDisk = readFile(path).find((e) => e.key === key);
  if (fresh(onDisk)) {
    memo.set(memoKey(path, key), { value: onDisk.value, storedAt: onDisk.storedAt });
    return onDisk.value;
  }
  return undefined;
}

function store(path, key, value, now) {
  memo.set(memoKey(path, key), { value, storedAt: now });
  const entries = readFile(path).filter((e) => e.key !== key);
  entries.push({ key, value, storedAt: now });
  writeFile(path, entries);
}

/**
 * Return the cached value for `key` when younger than `ttlMs`, else call `fn`
 * and remember its result — but only a real one: null, undefined and Error
 * instances are returned as-is and never stored, and `cacheable(value)` lets
 * a caller veto storing a partial result (e.g. a wallet list with per-chain
 * failures). `cachePath` / `now` are injectable for tests.
 */
export async function cachedCall(key, ttlMs, fn, { cacheable = () => true, cachePath = circleCachePath(), now = Date.now() } = {}) {
  if (circleCacheDisabled()) return fn();
  const hit = lookup(cachePath, key, effectiveTtl(ttlMs), now);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value != null && !(value instanceof Error) && cacheable(value)) store(cachePath, key, value, now);
  return value;
}

/**
 * Drop every entry whose key starts with `keyPrefix` (all of them for ""),
 * in memory and on disk. Called after anything that moves money or changes
 * the wallet set. Best-effort, never throws.
 */
/**
 * Rewrite the cached values under `keyPrefix` through `mapFn`, KEEPING each
 * entry's original `storedAt` — an adjustment corrects a value, it does not
 * buy it a fresh lifetime. `mapFn` returning null/undefined drops the entry.
 *
 * This is how a spend is accounted for without throwing the cache away: see
 * debitCachedGatewayBalance in circle.mjs.
 */
export function adjustCircleCache(keyPrefix, mapFn, { cachePath = circleCachePath() } = {}) {
  if (circleCacheDisabled()) return 0;
  const entries = readFile(cachePath);
  let changed = 0;
  const next = [];
  for (const e of entries) {
    if (!e.key.startsWith(keyPrefix)) { next.push(e); continue; }
    let updated;
    try {
      updated = mapFn(e.value, e.key);
    } catch {
      updated = null; // a mapper that throws drops the entry: never serve a half-adjusted value
    }
    if (updated == null) { memo.delete(memoKey(cachePath, e.key)); changed += 1; continue; }
    next.push({ key: e.key, value: updated, storedAt: e.storedAt });
    memo.set(memoKey(cachePath, e.key), { value: updated, storedAt: e.storedAt });
    changed += 1;
  }
  if (changed) writeFile(cachePath, next);
  return changed;
}

export function invalidateCircleCache(keyPrefix = "", { cachePath = circleCachePath() } = {}) {
  for (const k of [...memo.keys()]) {
    if (k.startsWith(memoKey(cachePath, keyPrefix))) memo.delete(k);
  }
  const before = readFile(cachePath);
  const kept = before.filter((e) => !e.key.startsWith(keyPrefix));
  if (kept.length === before.length) return;
  if (kept.length === 0) {
    try { rmSync(cachePath, { force: true }); } catch { /* best-effort */ }
    return;
  }
  writeFile(cachePath, kept);
}

/**
 * Age of the stored entry for `key`, for diagnostics: { storedAt, ageMs } or
 * null when nothing is cached. Reads disk (not just the memo) so `selat
 * doctor` reports what the NEXT `selat run` would actually see.
 */
export function circleCacheStatus(key, { cachePath = circleCachePath(), now = Date.now() } = {}) {
  const e = readFile(cachePath).find((x) => x.key === key);
  return e ? { storedAt: e.storedAt, ageMs: Math.max(0, now - e.storedAt) } : null;
}
