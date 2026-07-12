import test from "node:test";
import assert from "node:assert/strict";

import { prompt, promptYesNo } from "../lib/ui.mjs";
import { resolveFundInputs } from "../lib/commands/fund.mjs";
import { emailArg } from "../lib/commands/init.mjs";

// Agent shells / CI / pipes have no TTY on stdin; readline there never delivers
// an answer, so every interactive prompt used to hang the whole command (the
// exact `selat init` / `selat fund` stall from user feedback). These pin the
// fail-fast behavior instead.

test("prompt() fails fast instead of hanging when stdin is not a TTY", async (t) => {
  if (process.stdin.isTTY) return t.skip("stdin is a TTY here; the non-TTY path can't be exercised");
  await assert.rejects(prompt("Email for your Circle agent account:"), (err) => {
    assert.equal(err.nonInteractive, true);
    assert.match(err.message, /not a TTY/);
    assert.match(err.message, /Email for your Circle agent account/);
    return true;
  });
});

test("promptYesNo() inherits the fail-fast (a confirmation can never silently hang)", async (t) => {
  if (process.stdin.isTTY) return t.skip("stdin is a TTY here; the non-TTY path can't be exercised");
  await assert.rejects(promptYesNo("Proceed with deposit?"), (err) => err.nonInteractive === true);
});

// `selat fund` non-interactive gate: money moves, so a non-TTY run must be
// fully explicit — amount and --yes required, only the chain may default.

test("fund inputs: non-TTY without --amount fails with flag guidance", () => {
  const res = resolveFundInputs({ args: [], interactive: false });
  assert.equal(res.ok, false);
  assert.match(res.error, /--amount/);
});

test("fund inputs: non-TTY with --amount but no --yes refuses to deposit", () => {
  const res = resolveFundInputs({ args: ["--amount", "2"], interactive: false });
  assert.equal(res.ok, false);
  assert.match(res.error, /--yes/);
});

test("fund inputs: non-TTY with --amount and --yes proceeds, chain defaults to base", () => {
  const res = resolveFundInputs({ args: ["--amount", "2", "--yes"], interactive: false });
  assert.deepEqual(res, { ok: true, chain: "base", amount: "2", confirmed: true });
});

test("fund inputs: -y is accepted as --yes and --chain overrides the default", () => {
  const res = resolveFundInputs({ args: ["--amount", "5", "-y", "--chain", "polygon"], interactive: false });
  assert.deepEqual(res, { ok: true, chain: "polygon", amount: "5", confirmed: true });
});

test("fund inputs: interactive keeps the prompt flow; --yes still pre-confirms", () => {
  const ask = resolveFundInputs({ args: [], interactive: true });
  assert.deepEqual(ask, { ok: true, chain: null, amount: null, confirmed: null });
  const preconfirmed = resolveFundInputs({ args: ["--yes"], interactive: true });
  assert.equal(preconfirmed.confirmed, true);
});

// `selat init --email` parsing (both space and = forms, like --router-url=).

test("emailArg parses --email <addr> and --email=<addr>", () => {
  assert.equal(emailArg(["--email", "a@b.co"]), "a@b.co");
  assert.equal(emailArg(["--email=a@b.co"]), "a@b.co");
  assert.equal(emailArg(["--force"]), null);
  assert.equal(emailArg(["--email", "--force"]), null, "a following flag is not an email value");
  assert.equal(emailArg(["--email="]), null);
});
