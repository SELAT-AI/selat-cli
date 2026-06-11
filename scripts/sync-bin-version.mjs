#!/usr/bin/env node
/**
 * Keep the VERSION constant in bin/selat.mjs in sync with package.json.
 *
 * Run automatically by the npm "version" lifecycle, so `npm version <x>` bumps
 * both files in one commit. The publish workflow verifies they match, so this
 * prevents a release from failing that check (see the v0.5.6 release).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const binPath = join(root, "bin", "selat.mjs");
const src = readFileSync(binPath, "utf8");
const re = /^(const\s+VERSION\s*=\s*")[^"]+(";)/m;

if (!re.test(src)) {
  console.error("sync-bin-version: VERSION constant not found in bin/selat.mjs");
  process.exit(1);
}

const updated = src.replace(re, `$1${version}$2`);
if (updated !== src) {
  writeFileSync(binPath, updated);
  console.error(`sync-bin-version: bin/selat.mjs VERSION -> ${version}`);
} else {
  console.error(`sync-bin-version: bin/selat.mjs VERSION already ${version}`);
}
