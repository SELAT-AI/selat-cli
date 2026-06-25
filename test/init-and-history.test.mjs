import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { init } from "../lib/commands/init.mjs";
import { ensureSelatPayHistoryDir } from "../lib/selat-pay.mjs";

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
