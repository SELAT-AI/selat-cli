import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { init, noUsdcHintLines, walletArg, resolveWalletPreset } from "../lib/commands/init.mjs";
import { ensureSelatPayHistoryDir } from "../lib/selat-pay.mjs";

// Non-interactive wallet selection (--wallet / SELAT_WALLET) — the escape that
// lets an agent shell / CI pick a wallet without the TTY prompt, so a Hermes
// runner no longer has to fake a pseudo-terminal to pipe a digit in.
const RANKED = [
  { address: "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa" },
  { address: "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb" },
  { address: "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc" },
];

test("walletArg reads --wallet, --wallet=, then SELAT_WALLET, else null", () => {
  assert.equal(walletArg(["--wallet", "2"]), "2");
  assert.equal(walletArg(["--wallet=0xabc"]), "0xabc");
  assert.equal(walletArg(["--wallet", "new"]), "new");
  // a following flag is not the value
  assert.equal(walletArg(["--wallet", "--force"]), process.env.SELAT_WALLET || null);
  // env fallback
  const prev = process.env.SELAT_WALLET;
  process.env.SELAT_WALLET = "3";
  try {
    assert.equal(walletArg([]), "3");
    // an explicit flag still wins over the env var
    assert.equal(walletArg(["--wallet", "1"]), "1");
  } finally {
    if (prev === undefined) delete process.env.SELAT_WALLET; else process.env.SELAT_WALLET = prev;
  }
});

test("resolveWalletPreset maps index, address, and 'new'; null on no match", () => {
  assert.equal(resolveWalletPreset("1", RANKED), RANKED[0].address);
  assert.equal(resolveWalletPreset("3", RANKED), RANKED[2].address);
  assert.equal(resolveWalletPreset("new", RANKED), "new");
  assert.equal(resolveWalletPreset("n", RANKED), "new");
  // address match is case-insensitive
  assert.equal(resolveWalletPreset(RANKED[1].address.toUpperCase(), RANKED), RANKED[1].address);
  // out-of-range index, unknown address, and empty all fail closed (→ caller errors)
  assert.equal(resolveWalletPreset("0", RANKED), null);
  assert.equal(resolveWalletPreset("4", RANKED), null);
  assert.equal(resolveWalletPreset("0xdead", RANKED), null);
  assert.equal(resolveWalletPreset("", RANKED), null);
  assert.equal(resolveWalletPreset(null, RANKED), null);
});

// Stage-aware funding hint: on a wallet with zero/unknown on-chain USDC,
// `selat fund` does NOT deposit right away — it first shows a QR / address
// details to top up the wallet (Step 1); only a re-run deposits into Gateway
// (Step 2). init's closing hint must say so, or it points users at a command
// that appears to refuse them (live onboarding feedback).
test("init's no-USDC hint explains the QR-first, deposit-second flow", () => {
  const text = noUsdcHintLines().join("\n");
  assert.match(text, /selat fund --amount 2/);
  assert.match(text, /first show a QR \/ address details to top up your wallet/);
  assert.match(text, /then deposit into Gateway/);
  assert.match(text, /one spendable Gateway balance/);
  assert.doesNotMatch(text, /base|polygon|optimism|arbitrum/i); // no chain enumeration
});

test("init --help returns help without running setup", async () => {
  const oldLog = console.log;
  const oldError = console.error;
  let output = "";
  console.log = (msg = "") => { output += `${msg}\n`; };
  console.error = (msg = "") => { output += `${msg}\n`; };
  try {
    const code = await init(["--help"]);
    assert.equal(code, 0);
    assert.match(output, /selat init/);
    assert.match(output, /--force/);
    assert.doesNotMatch(output, /Checking Circle CLI/);
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
});

test("ensureSelatPayHistoryDir creates the configured history directory", async () => {
  const oldPath = process.env.SELAT_PAY_HISTORY_PATH;
  const root = await mkdtemp(join(tmpdir(), "selat-history-test-"));
  const historyPath = join(root, "state", "selat-pay", "gateway-history.jsonl");
  process.env.SELAT_PAY_HISTORY_PATH = historyPath;
  try {
    await ensureSelatPayHistoryDir();
    assert.ok(existsSync(join(root, "state", "selat-pay")));
  } finally {
    if (oldPath == null) delete process.env.SELAT_PAY_HISTORY_PATH;
    else process.env.SELAT_PAY_HISTORY_PATH = oldPath;
  }
});

test("init reuses configured wallet when Circle wallet listing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "selat-init-fallback-"));
  const binDir = join(root, "bin");
  const xdg = join(root, "xdg");
  const configuredWallet = "0xb291279be48742f0a1e9ed15c8d6d2d09ea9e4da";

  await mkdir(binDir, { recursive: true });
  await mkdir(join(xdg, "selat-pay"), { recursive: true });
  await writeFile(
    join(xdg, "selat-pay", ".env"),
    [
      "SELAT_ROUTER_URL=https://router.selat.ai",
      `SELAT_AGENT_WALLET_ADDRESS=${configuredWallet}`,
      ""
    ].join("\n"),
    "utf8"
  );

  const fakeCircle = join(binDir, "circle");
  await writeFile(
    fakeCircle,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "wallet" && "\${2:-}" == "status" ]]; then
  printf 'Type:     agent\\nEmail:    test@example.com\\nStatus:   VALID\\n'
  exit 0
fi
if [[ "\${1:-}" == "wallet" && "\${2:-}" == "list" ]]; then
  printf 'simulated Circle list outage\\n' >&2
  exit 1
fi
if [[ "\${1:-}" == "wallet" && "\${2:-}" == "create" ]]; then
  printf 'wallet create should not be called\\n' >&2
  exit 99
fi
printf 'unexpected circle command: %s\\n' "$*" >&2
exit 2
`,
    "utf8"
  );
  await chmod(fakeCircle, 0o755);

  const result = await runNode(["bin/selat.mjs", "init"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdg,
      PATH: `${binDir}:${process.env.PATH}`
    }
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Circle wallet lookup failed; reusing configured wallet/);
  assert.match(result.stdout, new RegExp(configuredWallet));

  const written = await readFile(join(xdg, "selat-pay", ".env"), "utf8");
  assert.match(written, new RegExp(`SELAT_AGENT_WALLET_ADDRESS=${configuredWallet}`));
});

function runNode(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
