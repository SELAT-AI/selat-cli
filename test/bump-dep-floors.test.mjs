import test from "node:test";
import assert from "node:assert/strict";
import { computeFloorBumps, gt } from "../scripts/bump-dep-floors.mjs";

const deps = { "@selat-ai/selat-discovery": "^0.27.3", "@selat-ai/selat-pay": "^0.12.0", "qrcode-generator": "2.0.4" };

test("raises a floor to the newest published release", () => {
  const { deps: out, bumps } = computeFloorBumps(deps, { "@selat-ai/selat-discovery": "0.27.4", "@selat-ai/selat-pay": "0.12.0" });
  assert.equal(out["@selat-ai/selat-discovery"], "^0.27.4");
  assert.equal(out["@selat-ai/selat-pay"], "^0.12.0");
  assert.deepEqual(bumps, [{ pkg: "@selat-ai/selat-discovery", from: "^0.27.3", to: "^0.27.4" }]);
});

test("bumps both floors at once, so order of publishes does not matter", () => {
  const { bumps } = computeFloorBumps(deps, { "@selat-ai/selat-discovery": "0.28.0", "@selat-ai/selat-pay": "0.13.0" });
  assert.equal(bumps.length, 2);
});

test("never lowers a floor and ignores unrelated deps", () => {
  const { deps: out, bumps } = computeFloorBumps(deps, { "@selat-ai/selat-discovery": "0.27.0", "@selat-ai/selat-pay": "0.11.9", "qrcode-generator": "9.9.9" });
  assert.deepEqual(bumps, []);
  assert.deepEqual(out, deps);
});

test("compares versions numerically, not lexically", () => {
  assert.equal(gt("0.10.0", "0.9.9"), true);
  assert.equal(gt("^0.27.3", "0.27.3"), false);
});
