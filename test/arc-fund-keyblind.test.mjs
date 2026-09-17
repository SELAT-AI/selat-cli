import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  maskedFingerprint,
  signArcFund,
  toArcFundSignerWire,
} from "../lib/arc-fund-signer.mjs";
import {
  REDACTED,
  copyDebugBundle,
  jsonStringifyRedacted,
  redactArgvDump,
  redactEnvDump,
  redactText,
  serializeError,
  withoutKeyFields,
} from "../lib/redact.mjs";
import {
  arcDepositSpawnEnv,
  fund,
  reprintRedacted,
  resolveArcDepositEnv,
} from "../lib/commands/fund.mjs";
import { refundPayArgv } from "../lib/commands/refund.mjs";

// SELAT-AI/selat-cli#189 — Arc fund raw-key cleanup. P0 = any raw key or
// mnemonic on these surfaces: signer wire, CLI stdout/stderr, serialized
// errors, env/argv dumps, copy-debug bundles, quote/claim objects.

const KEY = "0x" + "ab".repeat(32);
const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const RPC = "https://example.arc-mainnet.invalid/token";
const ADDRESS = "0x" + "11".repeat(20);
const SIGNATURE = "0x" + "cd".repeat(65);

function quiet(t) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  t.after(() => {
    console.log = log;
    console.error = error;
  });
}

function captureStdio(t) {
  let out = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    out += String(chunk);
    return true;
  };
  t.after(() => {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  });
  return () => out;
}

function withArcFundEnv(t) {
  const dir = mkdtempSync(join(tmpdir(), "selat-arc-keyblind-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "setup.mjs"), "process.exit(0);\n");
  const freeze = join(dir, "no-freeze.json");
  const xdg = mkdtempSync(join(tmpdir(), "selat-arc-cfg-"));
  const prev = {
    SELAT_SKILL_PATH: process.env.SELAT_SKILL_PATH,
    SELAT_PAY_FREEZE_PATH: process.env.SELAT_PAY_FREEZE_PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    SELAT_PRIVATE_KEY: process.env.SELAT_PRIVATE_KEY,
    ARC_RPC_URL: process.env.ARC_RPC_URL,
    SELAT_AGENT_WALLET_ADDRESS: process.env.SELAT_AGENT_WALLET_ADDRESS,
    CIRCLE_BIN: process.env.CIRCLE_BIN,
  };
  process.env.SELAT_SKILL_PATH = dir;
  process.env.SELAT_PAY_FREEZE_PATH = freeze;
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.SELAT_PRIVATE_KEY = KEY;
  process.env.ARC_RPC_URL = RPC;
  delete process.env.SELAT_AGENT_WALLET_ADDRESS;
  const stub = join(dir, "circle-stub");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  process.env.CIRCLE_BIN = stub;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("signer wire is signature + address only — no key field", async () => {
  const wire = await signArcFund({
    digest: "0x" + "11".repeat(32),
    privateKey: KEY,
    address: ADDRESS,
    sign: async () => SIGNATURE,
  });
  assert.deepEqual(wire, { signature: SIGNATURE, address: ADDRESS });
  assert.equal("key" in wire, false);
  assert.equal("privateKey" in wire, false);
  assert.equal("mnemonic" in wire, false);
  assert.doesNotMatch(JSON.stringify(wire), KEY);
});

test("signer wire falls back to a masked fingerprint, never the hex key", async () => {
  const wire = await signArcFund({
    digest: "0x" + "11".repeat(32),
    privateKey: KEY,
    sign: async () => SIGNATURE,
  });
  assert.equal(wire.signature, SIGNATURE);
  assert.equal(wire.fingerprint, maskedFingerprint(KEY));
  assert.equal(wire.address, undefined);
  assert.notEqual(wire.fingerprint, KEY);
  assert.doesNotMatch(wire.fingerprint, /0x[0-9a-fA-F]{64}/);
  assert.doesNotMatch(JSON.stringify(wire), KEY);
});

test("toArcFundSignerWire drops an invented key field", () => {
  const wire = toArcFundSignerWire({
    signature: SIGNATURE,
    address: ADDRESS,
    key: KEY,
    privateKey: KEY,
    mnemonic: MNEMONIC,
  });
  assert.deepEqual(wire, { signature: SIGNATURE, address: ADDRESS });
  assert.doesNotMatch(JSON.stringify(wire), KEY);
  assert.doesNotMatch(JSON.stringify(wire), MNEMONIC);
});

test("thrown signer errors redact the key before they serialize", async () => {
  await assert.rejects(
    () => signArcFund({
      digest: "0x11",
      privateKey: KEY,
      sign: async () => {
        throw new Error(`sign failed for ${KEY}`);
      },
    }),
    (err) => {
      const serialized = JSON.stringify(serializeError(err, { secrets: [KEY] }));
      assert.doesNotMatch(err.message, KEY);
      assert.doesNotMatch(serialized, KEY);
      assert.match(serialized, new RegExp(REDACTED));
      return true;
    }
  );
});

test("upstream 4xx/5xx bodies redact named key fields before serialize", () => {
  const err = Object.assign(new Error("Gateway 500"), {
    status: 500,
    body: JSON.stringify({ error: "bad key", privateKey: KEY, key: KEY }),
  });
  const serialized = JSON.stringify(serializeError(err, { secrets: [KEY] }));
  assert.doesNotMatch(serialized, KEY);
  assert.match(serialized, /500/);
  assert.match(serialized, new RegExp(REDACTED));
});

test("env dump and argv dump and copy-debug bundle never echo the raw key", () => {
  const env = {
    SELAT_PRIVATE_KEY: KEY,
    ARC_RPC_URL: RPC,
    PATH: "/usr/bin",
    MNEMONIC: MNEMONIC,
  };
  const argv = ["node", "setup.mjs", "deposit", "--raw-key", KEY, "--chain", "arc"];
  const dumpedEnv = redactEnvDump(env, [KEY, MNEMONIC]);
  const dumpedArgv = redactArgvDump(argv, [KEY]);
  const bundle = copyDebugBundle({
    env,
    argv,
    error: new Error(`fatal: ${KEY}`),
    extra: { quoteId: "selatx123", key: KEY },
    secrets: [KEY, MNEMONIC],
  });
  const blob = JSON.stringify({ dumpedEnv, dumpedArgv, bundle });
  assert.equal(dumpedEnv.SELAT_PRIVATE_KEY, REDACTED);
  assert.equal(dumpedEnv.MNEMONIC, REDACTED);
  assert.equal(dumpedEnv.ARC_RPC_URL, RPC);
  assert.equal(dumpedArgv[dumpedArgv.indexOf("--raw-key") + 1], REDACTED);
  assert.equal("key" in bundle, false);
  assert.doesNotMatch(blob, KEY);
  assert.doesNotMatch(blob, MNEMONIC);
});

test("quote/claim client objects do not invent or keep a key field", () => {
  const quote = withoutKeyFields({
    quoteId: "selatx123",
    price: { amount: "0.01", currency: "USDC" },
    payTo: ADDRESS,
    key: KEY,
    privateKey: KEY,
  });
  const claim = withoutKeyFields({
    action: "claim",
    quoteId: "selatx123",
    mnemonic: MNEMONIC,
  });
  assert.equal("key" in quote, false);
  assert.equal("privateKey" in quote, false);
  assert.equal(quote.quoteId, "selatx123");
  assert.equal("mnemonic" in claim, false);
  assert.doesNotMatch(jsonStringifyRedacted(quote, [KEY]), KEY);
  assert.doesNotMatch(JSON.stringify(claim), MNEMONIC);
  const payArgv = refundPayArgv({ action: "claim", quoteId: "selatx123", rest: ["--chain", "base"] });
  assert.ok(!payArgv.includes("--raw-key"));
  assert.ok(!payArgv.includes(KEY));
  assert.ok(!payArgv.includes("key"));
});

test("resolveArcDepositEnv JSON and fingerprints stay key-blind", () => {
  const res = resolveArcDepositEnv({
    method: "direct",
    env: { SELAT_PRIVATE_KEY: KEY, ARC_RPC_URL: RPC },
  });
  const wire = JSON.stringify(res);
  assert.doesNotMatch(wire, KEY);
  assert.equal(JSON.parse(wire).env.SELAT_PRIVATE_KEY, undefined);
  assert.equal(res.fingerprint, maskedFingerprint(KEY));
  // In-process overlay still has the key so setup.mjs can sign — this object
  // is not a wire type and must not be serialized by the CLI.
  const overlay = arcDepositSpawnEnv(res);
  assert.equal(overlay.SELAT_PRIVATE_KEY, KEY);
  assert.doesNotMatch(JSON.stringify(redactEnvDump(overlay, [KEY])), KEY);
});

test("reprintRedacted strips a known key from child stdout/stderr", () => {
  const chunks = [];
  const stream = { write: (c) => chunks.push(String(c)) };
  reprintRedacted(`ok ${KEY} deposited\n`, stream, [KEY]);
  const text = chunks.join("");
  assert.doesNotMatch(text, KEY);
  assert.match(text, /ok \[redacted\] deposited/);
});

test("Arc fund reprints child streams key-free (verbose/debug + happy path)", async (t) => {
  quiet(t);
  withArcFundEnv(t);
  const captured = captureStdio(t);
  let spawnOpts;
  const code = await fund(["--chain", "arc", "--amount", "0.25", "--yes"], {
    interactive: false,
    run: async (_cmd, args, opts) => {
      spawnOpts = { args, opts };
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, tx: "0x" + "ee".repeat(32), key: KEY, signature: SIGNATURE }) + "\n",
        stderr: `SELAT_DEBUG key=${KEY}\n`,
      };
    },
  });
  assert.equal(code, 0);
  const printed = captured();
  assert.doesNotMatch(printed, KEY);
  assert.ok(!spawnOpts.args.includes(KEY), "raw key must not appear on deposit argv");
  assert.equal(spawnOpts.opts.inherit, false, "Arc captures streams so they can be redacted");
  assert.equal(spawnOpts.opts.env.SELAT_PRIVATE_KEY, KEY, "in-process child overlay still signs");
  assert.match(printed, /\[redacted\]/);
});

test("Arc fund 5xx child output is redacted before it hits stderr", async (t) => {
  quiet(t);
  withArcFundEnv(t);
  const captured = captureStdio(t);
  const code = await fund(["--chain", "arc", "--amount", "0.25", "--yes"], {
    interactive: false,
    run: async () => ({
      code: 1,
      stdout: "",
      stderr: `Fatal: privateKey=${KEY} upstream 502\n`,
    }),
  });
  assert.equal(code, 1);
  assert.doesNotMatch(captured(), KEY);
});

test("redactText catches a mnemonic echoed in an error string", () => {
  const text = redactText(`backup phrase: ${MNEMONIC}`, [MNEMONIC]);
  assert.doesNotMatch(text, MNEMONIC);
  assert.match(text, new RegExp(REDACTED));
});
