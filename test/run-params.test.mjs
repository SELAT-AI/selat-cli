import test from "node:test";
import assert from "node:assert/strict";

import {
  applyParamsToBody,
  applyParamsToPayArgs,
  applyParamsToUrl,
  missingPlanParams,
  paramRetryLine,
  parseParamFlags,
  replanUrlParams,
  remainingPathPlaceholders,
  remainingTemplateQueryParams,
} from "../lib/run-params.mjs";

// ---------------------------------------------------------------------
// --param flag parsing
// ---------------------------------------------------------------------

test("parseParamFlags accepts repeated key=value pairs and keeps '=' in values", () => {
  const r = parseParamFlags(["symbols=ETH", "q=a=b", "vs_currency=usd"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, [["symbols", "ETH"], ["q", "a=b"], ["vs_currency", "usd"]]);
});

test("parseParamFlags rejects malformed pairs, bad keys, and control characters", () => {
  assert.equal(parseParamFlags(["novalue"]).ok, false);
  assert.equal(parseParamFlags(["=value"]).ok, false);
  assert.equal(parseParamFlags(["bad key=1"]).ok, false);
  assert.equal(parseParamFlags(["k=a\nb"]).ok, false);
  assert.deepEqual(parseParamFlags([]), { ok: true, params: [] });
});

// ---------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------

test("applyParamsToUrl substitutes path placeholders in every catalog style", () => {
  assert.equal(
    applyParamsToUrl("https://api.example.com/price/{symbol}", [["symbol", "BTC"]]).url,
    "https://api.example.com/price/BTC",
  );
  assert.equal(
    applyParamsToUrl("https://api.example.com/price/%7Bsymbol%7D", [["symbol", "BTC"]]).url,
    "https://api.example.com/price/BTC",
  );
  assert.equal(
    applyParamsToUrl("https://flightapi.example.com/airline/:rest*", [["rest", "AA100"]]).url,
    "https://flightapi.example.com/airline/AA100",
  );
  assert.equal(
    applyParamsToUrl("https://api.example.com/users/:id/posts", [["id", "42"]]).url,
    "https://api.example.com/users/42/posts",
  );
  // ":8080" in the authority must not read as a :port placeholder.
  const port = applyParamsToUrl("https://api.example.com:8080/thing/:id", [["id", "7"]]);
  assert.equal(port.url, "https://api.example.com:8080/thing/7");
});

test("applyParamsToUrl appends new query params and URL-encodes values", () => {
  assert.equal(
    applyParamsToUrl("https://x402.alchemy.com/prices/v1/tokens/by-symbol", [["symbols", "ETH"]]).url,
    "https://x402.alchemy.com/prices/v1/tokens/by-symbol?symbols=ETH",
  );
  assert.equal(
    applyParamsToUrl("https://api.example.com/weather", [["location", "new york"]]).url,
    "https://api.example.com/weather?location=new%20york",
  );
});

test("applyParamsToUrl replaces existing values for the same key instead of duplicating", () => {
  assert.equal(
    applyParamsToUrl("https://api.example.com/price?symbols=", [["symbols", "ETH"]]).url,
    "https://api.example.com/price?symbols=ETH",
  );
  assert.equal(
    applyParamsToUrl("https://api.example.com/price?symbols={symbols}&convert=USD", [["symbols", "BTC"]]).url,
    "https://api.example.com/price?symbols=BTC&convert=USD",
  );
  // Idempotent: applying the same param twice yields the same URL.
  const once = applyParamsToUrl("https://api.example.com/q", [["a", "1"]]).url;
  assert.equal(applyParamsToUrl(once, [["a", "1"]]).url, once);
});

test("remaining* helpers report unfilled placeholders and template query slots", () => {
  assert.deepEqual(remainingPathPlaceholders("https://api.example.com/a/{x}/b/:y"), ["{x}", ":y"]);
  assert.deepEqual(remainingPathPlaceholders("https://api.example.com/a/1/b/2"), []);
  assert.deepEqual(remainingTemplateQueryParams("https://e.com/p?a=&b=1&c={c}"), ["a", "c"]);
  assert.deepEqual(remainingTemplateQueryParams("https://e.com/p?a=1"), []);
});

// ---------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------

test("applyParamsToBody merges params into a JSON object body", () => {
  assert.deepEqual(applyParamsToBody("{}", [["q", "hello"]]), { ok: true, body: '{"q":"hello"}' });
  assert.deepEqual(
    applyParamsToBody('{"existing":true}', [["q", "x"]]),
    { ok: true, body: '{"existing":true,"q":"x"}' },
  );
  assert.equal(applyParamsToBody("not json", [["q", "x"]]).ok, false);
  assert.equal(applyParamsToBody("[1,2]", [["q", "x"]]).ok, false);
});

// ---------------------------------------------------------------------
// selat-pay argv rewriting
// ---------------------------------------------------------------------

const GET_ARGS = ["GET", "https://api.example.com/price", "--chain", "base", "--max-amount", "0.01"];

test("applyParamsToPayArgs sends params to the URL query for GET hints", () => {
  const r = applyParamsToPayArgs(GET_ARGS, [["symbols", "ETH"]], {});
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/price?symbols=ETH");
  assert.deepEqual(r.args.slice(2), GET_ARGS.slice(2), "payment flags are untouched");
});

test("applyParamsToPayArgs substitutes path placeholders before anything else", () => {
  const r = applyParamsToPayArgs(
    ["GET", "https://api.example.com/price/{symbol}", "--chain", "base", "--max-amount", "0.01"],
    [["symbol", "BTC"], ["convert", "USD"]],
    {},
  );
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/price/BTC?convert=USD");
});

test("applyParamsToPayArgs merges non-query params into the body for POST hints that carry one", () => {
  const r = applyParamsToPayArgs(
    ["POST", "https://api.example.com/search", "--chain", "base", "--max-amount", "0.05", "--body", "{}"],
    [["q", "agentic payments"]],
    {},
  );
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/search", "URL untouched");
  assert.equal(r.args[r.args.indexOf("--body") + 1], '{"q":"agentic payments"}');
});

test("applyParamsToPayArgs keeps documented query params on the URL even for POST", () => {
  const plan = { queryParams: [{ name: "convert", type: "string" }] };
  const r = applyParamsToPayArgs(
    ["POST", "https://api.example.com/quotes", "--chain", "base", "--max-amount", "0.05", "--body", "{}"],
    [["convert", "USD"], ["note", "hi"]],
    plan,
  );
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/quotes?convert=USD");
  assert.equal(r.args[r.args.indexOf("--body") + 1], '{"note":"hi"}');
});

test("applyParamsToPayArgs keeps documented body params in the JSON body", () => {
  const plan = {
    bodyParams: [{ name: "query", type: "string" }],
    missingBodyParams: ["query"],
    queryParams: [{ name: "convert", type: "string" }],
  };
  const r = applyParamsToPayArgs(
    ["POST", "https://api.example.com/search", "--chain", "base", "--max-amount", "0.05", "--body", "{}"],
    [["query", "agentic payments"], ["convert", "USD"]],
    plan,
  );
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/search?convert=USD");
  assert.equal(r.args[r.args.indexOf("--body") + 1], '{"query":"agentic payments"}');
});

test("replanUrlParams excludes body-only params from the re-plan URL", () => {
  const plan = {
    requiresBodyParams: true,
    missingBodyParams: ["query"],
    bodyParams: [{ name: "query", type: "string" }],
  };
  assert.deepEqual(replanUrlParams(plan, [["query", "agentic payments"]]), []);
});

test("replanUrlParams keeps only required path/query params for the URL", () => {
  const plan = {
    requiresPathParams: true,
    pathPlaceholders: ["{symbol}"],
    requiresQueryParams: true,
    missingQueryParams: ["convert"],
    requiresBodyParams: true,
    missingBodyParams: ["query"],
  };
  assert.deepEqual(
    replanUrlParams(plan, [["symbol", "ETH"], ["convert", "USD"], ["query", "agentic payments"], ["extra", "x"]]),
    [["symbol", "ETH"], ["convert", "USD"]],
  );
});

test("applyParamsToPayArgs routes missingQueryParams keys to the URL", () => {
  const plan = { missingQueryParams: ["symbols"] };
  const r = applyParamsToPayArgs(
    ["POST", "https://api.example.com/prices", "--chain", "base", "--max-amount", "0.05", "--body", "{}"],
    [["symbols", "ETH"]],
    plan,
  );
  assert.equal(r.ok, true);
  assert.equal(r.args[1], "https://api.example.com/prices?symbols=ETH");
});

// ---------------------------------------------------------------------
// Refusal reporting inputs
// ---------------------------------------------------------------------

test("missingPlanParams reads requiresQueryParams / requiresPathParams plans with metadata", () => {
  const plan = {
    requiresQueryParams: true,
    missingQueryParams: ["symbols"],
    queryParams: [{ name: "symbols", type: "array", description: "Token symbols", example: "ETH" }],
  };
  assert.deepEqual(missingPlanParams(plan), [
    { kind: "query", name: "symbols", type: "array", description: "Token symbols", example: "ETH" },
  ]);

  const templated = {
    requiresPathParams: true,
    pathPlaceholders: ["{symbol}", ":rest*"],
    pathParams: [{ name: "symbol", type: "string", enumValues: ["BTC", "ETH"] }],
  };
  assert.deepEqual(missingPlanParams(templated), [
    { kind: "path", name: "symbol", type: "string", enumValues: ["BTC", "ETH"] },
    { kind: "path", name: "rest" },
  ]);

  const bodyHungry = {
    requiresBodyParams: true,
    missingBodyParams: ["query"],
    bodyParams: [{ name: "query", type: "string", description: "Search query", example: "gold" }],
  };
  assert.deepEqual(missingPlanParams(bodyHungry), [
    { kind: "body", name: "query", type: "string", description: "Search query", example: "gold" },
  ]);

  assert.deepEqual(missingPlanParams({}), []);
  assert.deepEqual(missingPlanParams(null), []);
});

test("paramRetryLine prints the exact copy-pasteable retry command", () => {
  const missing = [
    { kind: "query", name: "symbols", example: "ETH" },
    { kind: "path", name: "country", enumValues: ["us", "uk"] },
    { kind: "query", name: "location" },
  ];
  assert.equal(
    paramRetryLine("current token prices", missing),
    'selat run "current token prices" --param symbols=ETH --param country=us --param location=<location>',
  );
});

// ---------------------------------------------------------------------
// Merged parse shape: --param in parseRunArgs / KNOWN_RUN_FLAGS
// ---------------------------------------------------------------------

test("KNOWN_RUN_FLAGS includes --param and the unknown-flag error lists it", async () => {
  const { parseRunArgs, KNOWN_RUN_FLAGS } = await import("../lib/commands/run.mjs");
  assert.ok(KNOWN_RUN_FLAGS.includes("--param"));
  const got = parseRunArgs(["--pram", "x=1", "weather"]);
  assert.equal(got.ok, false);
  assert.ok(got.error.includes("--param"), "unknown-flag error lists --param");
});

test("parseRunArgs collects repeated --param values and keeps them out of the intent", async () => {
  const { parseRunArgs } = await import("../lib/commands/run.mjs");
  const got = parseRunArgs(["--dry-run", "token", "prices", "--param", "symbols=ETH", "--param", "convert=USD"]);
  assert.equal(got.ok, true);
  assert.equal(got.intent, "token prices");
  assert.equal(got.dryRun, true, "--dry-run coexists with --param");
  assert.deepEqual(got.rawParams, ["symbols=ETH", "convert=USD"]);
});

test("parseRunArgs rejects --param without a value", async () => {
  const { parseRunArgs } = await import("../lib/commands/run.mjs");
  const got = parseRunArgs(["weather", "--param"]);
  assert.equal(got.ok, false);
  assert.match(got.error, /--param requires a key=value/);
});

// Review-#3 #11: PARAM_KEY_RE permits array-param keys (items[0], a.b) whose
// chars are regex metacharacters. They were spliced raw into `new RegExp`, so
// `items[0` threw an unterminated-character-class SyntaxError (crashing
// `selat run`), and `a.b` matched the wrong path segment. Keys are now escaped.

test("bracket/dot param keys don't crash applyParamsToUrl and substitute literally", () => {
  // The crash case (unbalanced bracket the key regex still admits).
  const r1 = parseParamFlags(["items[0=x"]);
  assert.doesNotThrow(() => applyParamsToUrl("https://e.x/{items[0}", r1.params));
  // Balanced array key substitutes its own placeholder.
  const r2 = parseParamFlags(["items[0]=v"]);
  assert.equal(applyParamsToUrl("https://e.x/{items[0]}", r2.params).url, "https://e.x/v");
  // Dot key is matched literally, not as "a<any>b".
  const r3 = parseParamFlags(["a.b=1"]);
  assert.equal(applyParamsToUrl("https://e.x/{a.b}", r3.params).url, "https://e.x/1");
  // ...and a dot key does NOT match a different segment that regex-. would:
  // {aXb} is left intact (not substituted to 1); the unmatched param falls
  // through to a query param, as any non-placeholder param does.
  const r4 = parseParamFlags(["a.b=1"]);
  const out4 = applyParamsToUrl("https://e.x/{aXb}", r4.params).url;
  assert.ok(out4.includes("{aXb}"), out4);        // placeholder untouched (no regex . match)
  assert.ok(!/\/1(\?|$)/.test(out4), out4);        // not substituted into the path
});

test("bracket param key does not crash the :param path-segment form either", () => {
  const r = parseParamFlags(["id[0]=7"]);
  assert.doesNotThrow(() => applyParamsToUrl("https://e.x/:id[0]", r.params));
});
