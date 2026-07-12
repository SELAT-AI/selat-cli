import test from "node:test";
import assert from "node:assert/strict";

import { receiptPriceText } from "../lib/commands/run.mjs";

// The `selat run` success line is a human receipt ("paid ~$0.002 to FlightAPI"),
// not a quote dump. These pin the dollar text for the shapes catalog prices take.

test("receiptPriceText formats catalog floor prices for humans", () => {
  assert.equal(receiptPriceText(0.002), "~$0.002");
  assert.equal(receiptPriceText(0.1), "~$0.10");
  assert.equal(receiptPriceText(1), "~$1.00");
  assert.equal(receiptPriceText(null), "the live-quoted price");
  assert.equal(receiptPriceText(undefined), "the live-quoted price");
});
