/**
 * Read/write $XDG_CONFIG_HOME/juris-pay/.env so that the juris-pay CLI works
 * from any directory after `juris init` finishes.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "juris-pay");
}

export function configPath() {
  return join(configDir(), ".env");
}

export async function readConfig() {
  try {
    const raw = await readFile(configPath(), "utf8");
    return parseEnv(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

export async function writeConfig(record) {
  await mkdir(configDir(), { recursive: true });
  const lines = [
    "# Auto-managed by `juris init`. Edit manually if you know what you're doing.",
    "# Layered: shell env > cwd .env > this file.",
    ""
  ];
  for (const [k, v] of Object.entries(record)) {
    if (v == null || v === "") continue;
    lines.push(`${k}=${v}`);
  }
  await writeFile(configPath(), lines.join("\n") + "\n", "utf8");
  await chmod(configPath(), 0o600);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}
