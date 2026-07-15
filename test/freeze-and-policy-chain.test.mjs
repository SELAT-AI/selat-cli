import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { freezeFilePath, readFreeze, freezeStatusLine, noteArg, freeze, unfreeze } from "../lib/commands/freeze.mjs";
import { policyChainDecision } from "../lib/commands/init.mjs";
import { sessionSpendLine } from "../lib/commands/budget.mjs";

// WS4 remainder: instant local kill switch (`selat freeze`/`unfreeze`),
// init→setup-policy chaining, confirmation-time session spend line.
// Enforcement of the freeze flag lives in selat-pay (pre-signature).

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
    "FROZEN since 2026-07-14T01:02:03.000Z — runaway loop · all payments refused · resume: selat unfreeze"
  );
  assert.equal(
    freezeStatusLine({ frozenAt: null, note: null }),
    "FROZEN since unknown time · all payments refused · resume: selat unfreeze"
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
