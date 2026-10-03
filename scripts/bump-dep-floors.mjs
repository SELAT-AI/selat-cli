#!/usr/bin/env node
/**
 * Raise the selat-discovery / selat-pay dependency floors in package.json to
 * the newest published release. selat-cli is the propagation vehicle for both
 * (the plugins runner only refreshes when selat-cli's npm `latest` moves), so a
 * discovery or pay publish must be followed by a CLI release raising the floor.
 *
 * Idempotent and order-independent: it always moves BOTH floors to the newest
 * published version, so two near-simultaneous publishes yield the same result.
 *
 * Usage: node scripts/bump-dep-floors.mjs   (writes package.json; prints a summary,
 *        and "changed=true|false" for CI)
 * Env:   SELAT_FLOOR_LATEST='{"@selat-ai/selat-pay":"0.12.1"}' overrides npm lookups (tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const FLOOR_PACKAGES = ["@selat-ai/selat-discovery", "@selat-ai/selat-pay"];

const parse = (v) => String(v).replace(/^[\^~>=v\s]+/, "").split(".").map(Number);
export function gt(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/** Pure: returns { deps, bumps:[{pkg,from,to}] }. Never lowers a floor. */
export function computeFloorBumps(dependencies, latest) {
  const deps = { ...dependencies };
  const bumps = [];
  for (const pkg of FLOOR_PACKAGES) {
    const current = deps[pkg];
    const newest = latest[pkg];
    if (!current || !newest) continue;
    if (gt(newest, current)) {
      deps[pkg] = `^${newest}`;
      bumps.push({ pkg, from: current, to: `^${newest}` });
    }
  }
  return { deps, bumps };
}

function npmLatest(pkg) {
  return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).trim();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const path = join(root, "package.json");
  const text = readFileSync(path, "utf8");
  const pkg = JSON.parse(text);
  const override = process.env.SELAT_FLOOR_LATEST ? JSON.parse(process.env.SELAT_FLOOR_LATEST) : null;
  const latest = override ?? Object.fromEntries(FLOOR_PACKAGES.map((p) => [p, npmLatest(p)]));
  const { deps, bumps } = computeFloorBumps(pkg.dependencies, latest);
  if (bumps.length) {
    pkg.dependencies = deps;
    writeFileSync(path, JSON.stringify(pkg, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  }
  for (const b of bumps) console.log(`${b.pkg}: ${b.from} -> ${b.to}`);
  if (!bumps.length) console.log("floors already current");
  console.log(`changed=${bumps.length > 0}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
