import test from "node:test";
import assert from "node:assert/strict";

// Colors are decided once at import time from stdout.isTTY / NO_COLOR, so pin
// the plain-text branch before loading the module: that is the branch agent
// harnesses and CI actually render, and the one that must stay parseable.
process.env.NO_COLOR = "1";
const { fmt, progress, stdinIsInteractive, promptHidden } = await import("../lib/ui.mjs");

const ANSI = /\x1b\[/;

test("fmt colors degrade to plain text under NO_COLOR", () => {
  for (const key of ["bold", "dim", "red", "green", "yellow", "blue", "cyan"]) {
    assert.equal(fmt[key]("text"), "text", `${key} should not wrap under NO_COLOR`);
  }
});

test("fmt status helpers keep their glyphs without escape codes", () => {
  assert.equal(fmt.ok("wallet funded"), "✓ wallet funded");
  assert.equal(fmt.err("no balance"), "✗ no balance");
  assert.equal(fmt.warn("degraded"), "⚠ degraded");
  assert.equal(fmt.error("no balance"), "✗ no balance");
  assert.equal(fmt.header("Wallet"), "\n▸ Wallet");
  for (const s of [fmt.ok("a"), fmt.err("a"), fmt.warn("a"), fmt.error("a"), fmt.header("a")]) {
    assert.doesNotMatch(s, ANSI);
  }
});

test("fmt coerces non-string values instead of printing [object]", () => {
  assert.equal(fmt.dim(3), "3");
  assert.equal(fmt.bold(null), "null");
});

test("step/progress render an [n/total] prefix and are the same renderer", () => {
  assert.equal(fmt.step(2, 8, "Checking Circle CLI"), "[2/8] Checking Circle CLI");
  assert.equal(progress(2, 8, "Checking Circle CLI"), fmt.step(2, 8, "Checking Circle CLI"));
});

test("stdinIsInteractive reports stdin's TTY-ness as a boolean", () => {
  assert.equal(typeof stdinIsInteractive(), "boolean");
  assert.equal(stdinIsInteractive(), !!process.stdin.isTTY);
});

/**
 * Drive promptHidden()'s raw-mode branch: pretend stdin is a TTY, capture the
 * keypress handler it registers, and collect what it echoes. The module holds
 * process.stdin/stdout directly, so patching those objects is the only seam.
 */
function fakeTty() {
  const stdin = process.stdin;
  const patched = ["isTTY", "setRawMode", "resume", "pause", "setEncoding", "on", "removeListener"];
  const saved = Object.fromEntries(patched.map((k) => [k, stdin[k]]));
  const savedWrite = process.stdout.write;

  let handler = null;
  const rawModes = [];
  let echoed = "";

  stdin.isTTY = true;
  stdin.setRawMode = (on) => {
    rawModes.push(on);
    return stdin;
  };
  stdin.resume = () => stdin;
  stdin.pause = () => stdin;
  stdin.setEncoding = () => stdin;
  stdin.on = (event, fn) => {
    if (event === "data") handler = fn;
    return stdin;
  };
  stdin.removeListener = () => stdin;
  process.stdout.write = (chunk) => {
    echoed += chunk;
    return true;
  };

  return {
    press: (...keys) => keys.forEach((k) => handler(k)),
    rawModes,
    echoed: () => echoed,
    restore() {
      Object.assign(stdin, saved);
      process.stdout.write = savedWrite;
    }
  };
}

test("promptHidden masks the typed answer and restores raw mode on Enter", async () => {
  const fake = fakeTty();
  try {
    const answer = promptHidden("One-time code:");
    fake.press("1", "2", "3", "\x7f", "4", "\r");
    assert.equal(await answer, "124", "backspace removes the last character");
    assert.deepEqual(fake.rawModes, [true, false], "raw mode is always handed back");
    const echoed = fake.echoed();
    assert.doesNotMatch(echoed, /123/, "the code itself is never echoed");
    assert.equal((echoed.match(/•/g) ?? []).length, 4);
  } finally {
    fake.restore();
  }
});

test("promptHidden accepts an empty answer and treats Ctrl-D as Enter", async () => {
  const fake = fakeTty();
  try {
    const answer = promptHidden("One-time code:");
    fake.press("\x04");
    assert.equal(await answer, "");
  } finally {
    fake.restore();
  }
});

test("promptHidden ignores a backspace on an empty buffer", async () => {
  const fake = fakeTty();
  try {
    const answer = promptHidden("One-time code:");
    fake.press("\b", "\b", "x", "\n");
    assert.equal(await answer, "x");
  } finally {
    fake.restore();
  }
});

test("promptHidden inherits prompt()'s fail-fast on a non-TTY stdin", async (t) => {
  if (process.stdin.isTTY) return t.skip("stdin is a TTY here; the non-TTY path can't be exercised");
  await assert.rejects(promptHidden("One-time code:"), (err) => {
    assert.equal(err.nonInteractive, true);
    assert.match(err.message, /One-time code/);
    return true;
  });
});
