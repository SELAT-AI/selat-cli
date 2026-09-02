import test from "node:test";
import assert from "node:assert/strict";

import { paramsNextStepLines } from "../lib/commands/search.mjs";

// `selat search` ends with a probe-first next step derived from the ranker's
// --pick plan. When the top pick's indexed URL needs query params it doesn't
// carry, the ranker withholds the exec hint (paying the bare URL buys an error
// response) — and the footer used to print NOTHING, dead-ending the funnel
// (live: "summarize the latest news on gold prices" → Gloria AI needs
// `ticker`). Name the params and the run flag instead.

const gloriaPlan = {
  intent: "summarize the latest news on gold prices",
  service: { id: "itsgloria.ai", name: "Gloria AI" },
  exec_hints: [],
  requiresQueryParams: true,
  missingQueryParams: ["ticker"],
  queryParams: [
    { name: "ticker", type: "string", description: "Token symbol or name (e.g. `ZRO`)", required: true },
  ],
  docs: { docsUrl: "https://gloriaai.gitbook.io/gloria/docs/x402-integration" },
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("a top pick with missing query params gets a fill-then-run footer", () => {
  const lines = paramsNextStepLines(gloriaPlan, 'selat run "summarize the latest news on gold prices"').map(strip);
  assert.ok(lines.length > 0);
  assert.match(lines.join("\n"), /Gloria AI needs a parameter/);
  assert.match(lines.join("\n"), /ticker \(string\) — Token symbol/);
  assert.ok(
    lines.some((l) => l.includes('selat run "summarize the latest news on gold prices" --param ticker=<ticker> --dry-run')),
    "footer names the exact run command with a --param placeholder"
  );
  assert.match(lines.join("\n"), /gloriaai\.gitbook\.io/);
});

test("several missing params produce one --param per name and plural wording", () => {
  const plan = { ...gloriaPlan, missingQueryParams: ["ticker", "days"], queryParams: [] };
  const text = paramsNextStepLines(plan, "selat run \"x\"").map(strip).join("\n");
  assert.match(text, /needs parameters/);
  assert.match(text, /--param ticker=<ticker> --param days=<days>/);
});

test("no missing params → no footer (an unrelated missing exec hint stays silent)", () => {
  assert.deepEqual(paramsNextStepLines({ ...gloriaPlan, missingQueryParams: [] }, "selat run \"x\""), []);
  assert.deepEqual(paramsNextStepLines({ exec_hints: [] }, "selat run \"x\""), []);
  assert.deepEqual(paramsNextStepLines(null, "selat run \"x\""), []);
});
