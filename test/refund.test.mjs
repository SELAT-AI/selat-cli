import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { selatPaySpawn } from "../lib/selat-pay.mjs";
import {
  parseRefundArgs,
  refund,
  refundPayArgv,
  REFUND_QUOTE_ID_RE,
} from "../lib/commands/refund.mjs";

const pexec = promisify(execFile);
const selatBin = fileURLToPath(new URL("../bin/selat.mjs", import.meta.url));

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

async function runBin(args) {
  try {
    const { stdout, stderr } = await pexec("node", [selatBin, ...args], { input: "" });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// ── parse / argv ────────────────────────────────────────────────────────────

test("parseRefundArgs treats --help / -h as inert help", () => {
  assert.deepEqual(parseRefundArgs(["--help"]), { ok: true, help: true });
  assert.deepEqual(parseRefundArgs(["-h"]), { ok: true, help: true });
  assert.deepEqual(parseRefundArgs(["claim", "selatx123", "--help"]), { ok: true, help: true });
  assert.deepEqual(parseRefundArgs(["query", "-h"]), { ok: true, help: true });
});

test("parseRefundArgs requires claim|query and a selatx quote id", () => {
  assert.equal(parseRefundArgs([]).ok, false);
  assert.match(parseRefundArgs([]).error, /action is required/);
  assert.equal(parseRefundArgs(["frobnicate", "selatx123"]).ok, false);
  assert.match(parseRefundArgs(["frobnicate", "selatx123"]).error, /unknown refund action/);
  assert.equal(parseRefundArgs(["claim"]).ok, false);
  assert.match(parseRefundArgs(["claim"]).error, /quote id is required/);
  assert.equal(parseRefundArgs(["claim", "--chain", "base"]).ok, false);
  assert.match(parseRefundArgs(["query", "q_123"]).error, /invalid refund quote id/);
  assert.equal(REFUND_QUOTE_ID_RE.test("selatx123"), true);
  assert.equal(REFUND_QUOTE_ID_RE.test("q_123"), false);
});

test("parseRefundArgs keeps remaining flags for passthrough", () => {
  const parsed = parseRefundArgs([
    "claim",
    "selatxabc",
    "--chain", "base",
    "--router-url", "https://router.selat.ai",
    "--raw-key",
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, "claim");
  assert.equal(parsed.quoteId, "selatxabc");
  assert.deepEqual(parsed.rest, [
    "--chain", "base",
    "--router-url", "https://router.selat.ai",
    "--raw-key",
  ]);
});

test("refundPayArgv is refund claim|query <quoteId> …", () => {
  assert.deepEqual(
    refundPayArgv({ action: "claim", quoteId: "selatx123", rest: ["--chain", "base"] }),
    ["refund", "claim", "selatx123", "--chain", "base"]
  );
  assert.deepEqual(
    refundPayArgv({ action: "query", quoteId: "selatxabc" }),
    ["refund", "query", "selatxabc"]
  );
});

test("selatPaySpawn keeps refund argv after the resolved binary", () => {
  const payArgs = refundPayArgv({
    action: "claim",
    quoteId: "selatx123",
    rest: ["--chain", "base"],
  });
  const bundled = selatPaySpawn({ source: "bundled", bin: "/n/sp.mjs" }, payArgs);
  assert.equal(bundled.cmd, process.execPath);
  assert.deepEqual(bundled.args, ["/n/sp.mjs", "refund", "claim", "selatx123", "--chain", "base"]);

  const global = selatPaySpawn({ source: "global", bin: "selat-pay" }, payArgs);
  assert.equal(global.cmd, "selat-pay");
  assert.deepEqual(global.args, ["refund", "claim", "selatx123", "--chain", "base"]);
});

// ── command dispatch ────────────────────────────────────────────────────────

test("refund --help exits 0 without resolving or spawning selat-pay", async (t) => {
  quiet(t);
  let resolved = false;
  let spawned = false;
  for (const args of [["--help"], ["-h"], ["claim", "--help"], ["query", "selatx123", "-h"]]) {
    const code = await refund(args, {
      resolve: async () => { resolved = true; return { source: null }; },
      run: async () => { spawned = true; return { code: 0 }; },
    });
    assert.equal(code, 0, `${args.join(" ")} should be help`);
  }
  assert.equal(resolved, false);
  assert.equal(spawned, false);
});

test("refund claim|query hands selat-pay argv refund <action> <quoteId> …", async (t) => {
  quiet(t);
  const calls = [];
  const resolved = { source: "bundled", bin: "/n/sp.mjs" };
  const code = await refund(
    ["claim", "selatx123", "--chain", "base", "--router-url", "https://router.selat.ai"],
    {
      resolve: async () => resolved,
      spawn: selatPaySpawn,
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { code: 0 };
      },
    }
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [
    "/n/sp.mjs",
    "refund", "claim", "selatx123",
    "--chain", "base",
    "--router-url", "https://router.selat.ai",
  ]);
  assert.equal(calls[0].opts.inherit, true, "Circle signing prompts need inherited stdio");

  const queryCalls = [];
  const queryCode = await refund(["query", "selatxabc", "--chain", "base"], {
    resolve: async () => ({ source: "global", bin: "selat-pay" }),
    spawn: selatPaySpawn,
    run: async (cmd, args) => {
      queryCalls.push({ cmd, args });
      return { code: 3 };
    },
  });
  assert.equal(queryCode, 3, "child exit code is propagated");
  assert.deepEqual(queryCalls[0], {
    cmd: "selat-pay",
    args: ["refund", "query", "selatxabc", "--chain", "base"],
  });
});

test("refund errors clearly when selat-pay is missing and does not spawn", async (t) => {
  const errs = [];
  const error = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(" ")); };
  t.after(() => { console.error = error; });

  let spawned = false;
  const code = await refund(["claim", "selatx123"], {
    resolve: async () => ({ source: null }),
    run: async () => { spawned = true; return { code: 0 }; },
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(errs.join("\n"), /selat-pay not found/);
  assert.match(errs.join("\n"), /@selat-ai\/selat-cli/);
});

test("unknown refund action fails without resolving selat-pay", async (t) => {
  const errs = [];
  const error = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(" ")); };
  t.after(() => { console.error = error; });

  let resolved = false;
  const code = await refund(["status", "selatx123"], {
    resolve: async () => { resolved = true; return { source: "bundled", bin: "/n/sp.mjs" }; },
    run: async () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.equal(resolved, false);
  assert.match(errs.join("\n"), /unknown refund action/);
});

// ── bin wiring ──────────────────────────────────────────────────────────────

test("selat --help lists refund claim|query", async () => {
  const { code, stdout } = await runBin(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /refund claim\|query/);
  assert.match(stdout, /selat refund claim selatx/);
  assert.match(stdout, /selat refund query selatx/);
});

test("selat refund --help prints local usage and exits 0", async () => {
  const { code, stdout, stderr } = await runBin(["refund", "--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /selat refund claim selatx/);
  assert.match(stdout, /selat refund query selatx/);
  assert.match(stdout, /SIWx/);
  assert.match(stdout, /does not consume session/);
  assert.doesNotMatch(stdout + stderr, /selat-pay not found/);
});

test("selat refund with an unknown action exits 1", async () => {
  const { code, stderr } = await runBin(["refund", "status", "selatx123"]);
  assert.equal(code, 1);
  assert.match(stderr, /unknown refund action/);
});
