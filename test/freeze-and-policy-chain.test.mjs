import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { freezeFilePath, readFreeze, freezeStatusLine, noteArg, freeze, unfreeze, frozenMoneyMove } from "../lib/commands/freeze.mjs";
import { fund } from "../lib/commands/fund.mjs";
import { policyChainDecision } from "../lib/commands/init.mjs";
import { sessionSpendLine } from "../lib/commands/budget.mjs";

// Local kill switch (`selat freeze`/`unfreeze`): this CLI refuses fund + pay.
// selat-pay also checks the same flag file pre-signature.

const dir = mkdtempSync(join(tmpdir(), "selat-freeze-cli-"));

function withFreezePath(path, fn) {
  const prev = process.env.SELAT_PAY_FREEZE_PATH;
  process.env.SELAT_PAY_FREEZE_PATH = path;
  const restore = () => {
    if (prev === undefined) delete process.env.SELAT_PAY_FREEZE_PATH;
    else process.env.SELAT_PAY_FREEZE_PATH = prev;
  };
  const out = fn();
  if (out && typeof out.finally === "function") return out.finally(restore);
  restore();
  return out;
}

test("freezeFilePath: env override wins, default lives under selat-pay state dir", () => {
  const p = join(dir, "flag.json");
  withFreezePath(p, () => assert.equal(freezeFilePath(), p));
  assert.match(freezeFilePath(), /selat-pay[\\/]frozen\.json$/);
});

test("readFreeze: absent → null; present → metadata; malformed → frozen (fail closed)", () => {
  assert.equal(readFreeze({ path: join(dir, "nope.json") }), null);

  const f = join(dir, "flag-read.json");
  writeFileSync(f, JSON.stringify({ frozenAt: "2026-07-14T01:02:03.000Z", note: "runaway loop" }));
  assert.deepEqual(readFreeze({ path: f }), { frozenAt: "2026-07-14T01:02:03.000Z", note: "runaway loop" });

  const bad = join(dir, "flag-bad.json");
  writeFileSync(bad, "not json{{");
  assert.deepEqual(readFreeze({ path: bad }), { frozenAt: null, note: null });
});

test("freezeStatusLine: prominent when frozen, null when not", () => {
  assert.equal(freezeStatusLine(null), null);
  assert.equal(
    freezeStatusLine({ frozenAt: "2026-07-14T01:02:03.000Z", note: "runaway loop" }),
    "FROZEN since 2026-07-14T01:02:03.000Z — runaway loop · fund + pay from this CLI refused · resume: selat unfreeze"
  );
  assert.equal(
    freezeStatusLine({ frozenAt: null, note: null }),
    "FROZEN since unknown time · fund + pay from this CLI refused · resume: selat unfreeze"
  );
});

test("noteArg: --note <text>, --note=<text>, absent, and flag-eating guard", () => {
  assert.equal(noteArg(["--note", "why not"]), "why not");
  assert.equal(noteArg(["--note=inline note"]), "inline note");
  assert.equal(noteArg([]), null);
  assert.equal(noteArg(["--note", "--json"]), null); // next flag isn't a note
  assert.equal(noteArg(["--note"]), null);
});

test("freeze writes the flag file (0600, schema, note) and unfreeze removes it", async () => {
  const p = join(dir, "flag-cmd.json");
  await withFreezePath(p, async () => {
    assert.equal(await freeze(["--note", "pause while I check spend"]), 0);
    assert.ok(existsSync(p));
    const written = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(written.schema, "selat-pay.freeze/v1");
    assert.equal(written.note, "pause while I check spend");
    assert.match(written.frozenAt, /^\d{4}-\d{2}-\d{2}T/);

    // re-freeze refreshes rather than failing
    assert.equal(await freeze([]), 0);
    assert.ok(existsSync(p));
    assert.equal(JSON.parse(readFileSync(p, "utf8")).note, undefined);

    assert.equal(await unfreeze([]), 0);
    assert.ok(!existsSync(p));

    // idempotent: unfreezing when not frozen is a calm no-op
    assert.equal(await unfreeze([]), 0);
  });
});

test("policyChainDecision: only an uncapped readable policy triggers the offer", () => {
  // interactive + uncapped → yes/no prompt (default YES lives at the call site)
  assert.deepEqual(
    policyChainDecision({ policy: { readable: true, custom: false }, interactive: true }),
    { recommend: true, mode: "prompt" }
  );
  // non-TTY + uncapped → print the verbatim command (Circle's OTP prompt
  // belongs to the user's own terminal)
  assert.deepEqual(
    policyChainDecision({ policy: { readable: true, custom: false }, interactive: false }),
    { recommend: true, mode: "print" }
  );
  // caps already set → silent
  assert.deepEqual(
    policyChainDecision({ policy: { readable: true, custom: true, limits: { perTx: 5 } }, interactive: true }),
    { recommend: false, mode: null }
  );
  // best-effort: unreadable policy stays silent instead of nagging on a hiccup
  assert.deepEqual(
    policyChainDecision({ policy: { readable: false }, interactive: true }),
    { recommend: false, mode: null }
  );
  assert.deepEqual(policyChainDecision({ policy: null, interactive: true }), { recommend: false, mode: null });
});

test("frozenMoneyMove: absent → null; present → refuse payload that names fund or pay", () => {
  assert.equal(frozenMoneyMove("fund", { path: join(dir, "nope.json") }), null);

  const f = join(dir, "flag-money.json");
  writeFileSync(f, JSON.stringify({ frozenAt: "2026-08-21T10:00:00.000Z", note: "stop" }));
  const pay = frozenMoneyMove("pay", { path: f });
  assert.match(pay.error, /frozen since 2026-08-21T10:00:00.000Z — stop/);
  assert.match(pay.error, /will not pay until you run selat unfreeze/);
  assert.match(pay.hint, /local kill switch for fund \+ pay from this CLI/);
  assert.match(pay.hint, /does not change Circle wallet policy/);

  const fundBlock = frozenMoneyMove("fund", { path: f });
  assert.match(fundBlock.error, /will not fund \(deposits \/ onramp\)/);
});

test("selat fund refuses while frozen, including --onramp; --help stays inert", async () => {
  const p = join(dir, "flag-fund.json");
  writeFileSync(p, JSON.stringify({ schema: "selat-pay.freeze/v1", frozenAt: "2026-08-21T10:00:00.000Z" }));

  const capture = () => {
    const lines = [];
    const orig = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    return { lines, restore: () => Object.assign(console, orig) };
  };

  await withFreezePath(p, async () => {
    const help = capture();
    try {
      const code = await fund(["--help"], { interactive: false });
      assert.equal(code, 0);
      assert.ok(help.lines.join("\n").includes("Usage: selat fund"));
    } finally { help.restore(); }

    const deposit = capture();
    try {
      const code = await fund(["--amount", "2", "--yes", "--chain", "base"], { interactive: false });
      assert.equal(code, 1);
      const joined = deposit.lines.join("\n");
      assert.match(joined, /will not fund \(deposits \/ onramp\)/);
      assert.match(joined, /local kill switch for fund \+ pay from this CLI/);
      assert.doesNotMatch(joined, /no TTY to prompt/);
      assert.doesNotMatch(joined, /agent-payment skill not found/);
    } finally { deposit.restore(); }

    const onramp = capture();
    try {
      const code = await fund(["--onramp"], { interactive: false });
      assert.equal(code, 1);
      assert.match(onramp.lines.join("\n"), /will not fund \(deposits \/ onramp\)/);
    } finally { onramp.restore(); }
  });
});

test("sessionSpendLine: armed budget → 'session: $X spent of $Y'; none → null", () => {
  assert.equal(
    sessionSpendLine({ session: { budgetUsd: 2, sessionId: "s1", source: "file" }, spentUsd: 0.0125 }),
    "session: $0.0125 spent of $2"
  );
  assert.equal(
    sessionSpendLine({ session: { budgetUsd: 5, sessionId: "s2", source: "env" }, spentUsd: 0 }),
    "session: $0.0000 spent of $5"
  );
  assert.equal(sessionSpendLine({ session: null }), null);
});
