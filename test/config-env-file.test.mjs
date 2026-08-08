import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configDir, configPath, skillsDir, readConfig, writeConfig } from "../lib/config.mjs";

// `selat init` writes the selat-pay env file every later command reads, so the
// XDG resolution, the 0600 mode (it holds a wallet address), and the parser's
// tolerance for hand edits are all load-bearing.

async function withXdg(dir, fn) {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
}

test("paths follow XDG_CONFIG_HOME when it is set", async () => {
  await withXdg("/xdg", () => {
    assert.equal(configDir(), join("/xdg", "selat-pay"));
    assert.equal(configPath(), join("/xdg", "selat-pay", ".env"));
    assert.equal(skillsDir(), join("/xdg", "selat", "skills"), "skills live under selat/, not selat-pay/");
  });
});

test("paths fall back to ~/.config when XDG_CONFIG_HOME is unset", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(configDir(), join(homedir(), ".config", "selat-pay"));
    assert.equal(skillsDir(), join(homedir(), ".config", "selat", "skills"));
  } finally {
    if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev;
  }
});

test("readConfig returns an empty record when the file was never written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-cfg-"));
  await withXdg(dir, async () => {
    assert.deepEqual(await readConfig(), {});
  });
});

test("writeConfig round-trips through readConfig, dropping empty values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-cfg-"));
  await withXdg(dir, async () => {
    await writeConfig({
      SELAT_ROUTER_URL: "https://router.selat.ai",
      SELAT_AGENT_WALLET_ADDRESS: "0xabc",
      SELAT_EMPTY: "",
      SELAT_NULL: null
    });
    const cfg = await readConfig();
    assert.deepEqual(cfg, {
      SELAT_ROUTER_URL: "https://router.selat.ai",
      SELAT_AGENT_WALLET_ADDRESS: "0xabc"
    });
    const raw = await readFile(configPath(), "utf8");
    assert.match(raw, /^# Auto-managed by `selat init`/, "keeps the do-not-hand-edit header");
  });
});

test("writeConfig creates the config dir and restricts the file to the owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-cfg-"));
  await withXdg(join(dir, "nested"), async () => {
    await writeConfig({ SELAT_AGENT_WALLET_ADDRESS: "0xabc" });
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  });
});

test("readConfig tolerates hand edits: comments, quotes, blanks and '=' in values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selat-cfg-"));
  await withXdg(dir, async () => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), [
      "# a comment",
      "",
      "  SELAT_ROUTER_URL = https://router.selat.ai  ",
      'SELAT_QUOTED="0xabc"',
      "SELAT_SINGLE='0xdef'",
      "SELAT_TOKEN=a=b=c",
      "not-an-assignment",
      "=leading-equals"
    ].join("\n"), "utf8");

    assert.deepEqual(await readConfig(), {
      SELAT_ROUTER_URL: "https://router.selat.ai",
      SELAT_QUOTED: "0xabc",
      SELAT_SINGLE: "0xdef",
      SELAT_TOKEN: "a=b=c"
    });
  });
});
