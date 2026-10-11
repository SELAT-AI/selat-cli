import test from "node:test";
import assert from "node:assert/strict";

import { defaultFundChain, methodPlanLines, fundingDetailLines } from "../lib/commands/fund.mjs";

// Direct deposits lead with Arc (eco settles there; USDC is Arc's gas token,
// and a 2026-10-11 direct deposit of $0.728922 credited in full with the
// wallet left at exactly $0). Eco can't source from Arc, so it keeps Base.
test("default deposit chain follows the method", () => {
  assert.equal(defaultFundChain(), "arc");
  assert.equal(defaultFundChain("direct"), "arc");
  assert.equal(defaultFundChain("eco"), "base");
});

test("a direct Arc plan says gas is USDC, not a separate native token", () => {
  const arc = methodPlanLines({ method: "direct", chainKey: "arc", amount: 2 }).join("\n");
  assert.match(arc, /fee\s+none — direct deposits credit at face value/);
  assert.match(arc, /Arc's gas token is USDC/);
  assert.doesNotMatch(arc, /native arc gas/);
  // other chains keep the native-gas note
  assert.match(methodPlanLines({ method: "direct", chainKey: "base", amount: 2 }).join("\n"), /native base gas/);
});

test("an Arc shortfall names the two routes that always get USDC onto Arc", () => {
  const text = fundingDetailLines({ address: "0xabc", chainKey: "arc", shortfall: 1.5, uri: null }).join("\n");
  assert.match(text, /selat fund --onramp/);
  assert.match(text, /circle bridge transfer ARC --amount 1\.50 --address 0xabc --chain <BASE\|ARB\|OP\|…>/);
  assert.doesNotMatch(text, /URI/); // no EIP-681 for Arc's native-gas USDC
  // other chains are unchanged
  const base = fundingDetailLines({ address: "0xabc", chainKey: "base", shortfall: 1.5, uri: "ethereum:x" }).join("\n");
  assert.doesNotMatch(base, /bridge transfer ARC/);
});
