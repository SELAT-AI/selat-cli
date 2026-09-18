import test from "node:test";
import assert from "node:assert/strict";

import { MIN_CIRCLE_CLI_VERSION, versionAtLeast, circleInstallPlan } from "../lib/circle.mjs";

// The stack needs Circle CLI >= 1.1.1 (first release that lists Arc mainnet).
// ensureCircle() decides install / upgrade / ok from this pure plan so an
// existing older install is upgraded instead of silently kept.

test("floor is 1.1.1", () => {
  assert.equal(MIN_CIRCLE_CLI_VERSION, "1.1.1");
});

test("versionAtLeast compares dotted numerics, rejects garbage", () => {
  assert.equal(versionAtLeast("1.1.1", "1.1.1"), true);
  assert.equal(versionAtLeast("1.2.0", "1.1.1"), true);
  assert.equal(versionAtLeast("2.0.0", "1.1.1"), true);
  assert.equal(versionAtLeast("1.1.0", "1.1.1"), false);
  assert.equal(versionAtLeast("1.0.0", "1.1.1"), false);
  assert.equal(versionAtLeast(null, "1.1.1"), false);
  assert.equal(versionAtLeast("1.1.1-canary", "1.1.1"), false);
});

test("circleInstallPlan: absent → install, old → upgrade, current → ok", () => {
  assert.equal(circleInstallPlan({ installed: false, version: null }), "install");
  assert.equal(circleInstallPlan({ installed: true, version: "1.0.0" }), "upgrade");
  // Unreadable version on an installed binary is treated as old (reinstall).
  assert.equal(circleInstallPlan({ installed: true, version: null }), "upgrade");
  assert.equal(circleInstallPlan({ installed: true, version: "1.1.1" }), "ok");
  assert.equal(circleInstallPlan({ installed: true, version: "1.3.0" }), "ok");
});
