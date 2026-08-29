// `selat run --dry-run --live-probe --json` passes the challenge-published
// request schema (quote.inputSchema in selat-pay's --probe-only stdout)
// through as challengeInputSchema, so an agent can fill --param values before
// any payment exists. These pin the stdout parsing seam. The shape is owned by
// selat-pay's harvestChallengeInputSchema; we pass it through opaquely.

import test from "node:test";
import assert from "node:assert/strict";

import { challengeInputSchemaFromStdout } from "../lib/commands/run.mjs";

const probeStdoutWith = (inputSchema) =>
  JSON.stringify(
    {
      mode: "routed",
      selectedProtocol: "mpp",
      detected: { protocols: ["mpp"] },
      quote: {
        quoteId: "q_123",
        price: { amount: "66000", formatted: "$0.066000 USDC" },
        network: "eip155:137",
        payTo: "0xabc",
        scheme: "exact",
        ...(inputSchema !== undefined ? { inputSchema } : {}),
      },
    },
    null,
    2
  ) + "\n";

// Re-encodes the live mpp.orthogonal.com/fundable/company harvest (2026-08-29):
// union-style alternatives, all required:false — surfacing, not refusing.
const SAMPLE_SCHEMA = {
  sources: ["mpp-opaque"],
  queryParams: [
    { name: "id", type: "string", description: "Company UUID", required: false },
    { name: "domain", type: "string", description: "Company domain or URL (e.g. stripe.com)", required: false },
    { name: "linkedin", type: "string", description: "LinkedIn company URL", required: false },
    { name: "crunchbase", type: "string", description: "Crunchbase organization URL", required: false },
  ],
};

test("parses quote.inputSchema out of --probe-only stdout, passthrough opaque", () => {
  const schema = challengeInputSchemaFromStdout(probeStdoutWith(SAMPLE_SCHEMA));
  assert.deepEqual(schema, SAMPLE_SCHEMA);
});

test("a quote without an inputSchema yields null, not an error", () => {
  assert.equal(challengeInputSchemaFromStdout(probeStdoutWith(undefined)), null);
});

test("non-JSON, empty, or missing stdout yields null", () => {
  assert.equal(challengeInputSchemaFromStdout("routed free passthrough\n"), null);
  assert.equal(challengeInputSchemaFromStdout(""), null);
  assert.equal(challengeInputSchemaFromStdout(undefined), null);
  assert.equal(challengeInputSchemaFromStdout(null), null);
});
