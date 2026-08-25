import test from "node:test";
import assert from "node:assert/strict";

import { applyFundedGatewayChain } from "../lib/commands/run.mjs";

// The ranker's --chain is funds-blind (CIRCLE_CHAIN → catalog network →
// "base") and never asks Gateway where the wallet's USDC sits. The payer-side
// --chain selects the Gateway SOURCE domain the batched burn draws from, so
// after an Eco deposit (balance lands on Polygon) a catalog-suggested
// `--chain base` would sign a burn against a $0 Base balance. `selat run`
// re-resolves at the pay boundary the way `selat skill run` always has;
// applyFundedGatewayChain is the argv rewrite that lands the resolved chain.

test("replaces the catalog-suggested chain with the funded Gateway chain", () => {
  const got = applyFundedGatewayChain(
    ["GET", "https://api.example/v1", "--chain", "base", "--max-amount", "0.05"],
    "polygon"
  );
  assert.equal(got.changed, true);
  assert.equal(got.from, "base");
  assert.deepEqual(got.args, ["GET", "https://api.example/v1", "--max-amount", "0.05", "--chain", "polygon"]);
});

test("no-op when the hint already names the funded chain", () => {
  const argv = ["GET", "https://api.example/v1", "--chain", "polygon", "--max-amount", "0.05"];
  const got = applyFundedGatewayChain(argv, "polygon");
  assert.equal(got.changed, false);
  assert.equal(got.from, "polygon");
  assert.deepEqual(got.args, argv);
});

test("strips every prior --chain pair and appends exactly one (last-wins hygiene)", () => {
  const got = applyFundedGatewayChain(
    ["GET", "https://api.example/v1", "--chain", "base", "--chain", "ethereum", "--max-amount", "0.05"],
    "polygon"
  );
  assert.equal(got.changed, true);
  // `from` is the last-wins value the hint would have paid on.
  assert.equal(got.from, "ethereum");
  assert.equal(got.args.filter((a) => a === "--chain").length, 1);
  assert.deepEqual(got.args.slice(-2), ["--chain", "polygon"]);
});

test("adds --chain when the hint carries none", () => {
  const got = applyFundedGatewayChain(
    ["GET", "https://api.example/v1", "--max-amount", "0.05"],
    "polygon"
  );
  assert.equal(got.changed, true);
  assert.equal(got.from, null);
  assert.deepEqual(got.args.slice(-2), ["--chain", "polygon"]);
});

test("no-op on a null funded chain (resolution failed — keep the hint's chain)", () => {
  const argv = ["GET", "https://api.example/v1", "--chain", "base", "--max-amount", "0.05"];
  for (const bad of [null, undefined, ""]) {
    const got = applyFundedGatewayChain(argv, bad);
    assert.equal(got.changed, false);
    assert.deepEqual(got.args, argv);
  }
});

test("no-op on a non-array argv", () => {
  const got = applyFundedGatewayChain("not-an-array", "polygon");
  assert.equal(got.changed, false);
  assert.equal(got.args, "not-an-array");
});
