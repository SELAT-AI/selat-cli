/**
 * `selat run --param key=value` passthrough helpers (pure; unit-tested).
 *
 * A ranked pick can be refused because its successful call needs parameters
 * the indexed URL doesn't carry — a route-template path (`/price/{symbol}`,
 * flagged `requiresPathParams` since discovery 0.10.0) or required query
 * params (`?symbols=` on Alchemy prices, flagged `requiresQueryParams`).
 * These helpers make such picks usable:
 *
 *   - parseParamFlags:     validate repeated `--param key=value` flags
 *   - missingPlanParams:   which params a refused pick still needs
 *   - paramRetryLine:      the exact `selat run … --param` line to suggest
 *   - applyParamsToUrl:    substitute path placeholders + set query params
 *   - applyParamsToBody:   merge params into a JSON body (POST/PUT/PATCH)
 *   - applyParamsToPayArgs: rewrite a validated selat-pay argv with params
 *
 * None of these touch payment caps or chains — a refused pick is re-planned
 * through the discovery skill's own buildPaymentPlan (see run.mjs), so the
 * skill's --max-amount ceiling and chain-resolution logic stay authoritative.
 */

const PARAM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\[\]-]*$/;

// PARAM_KEY_RE intentionally allows array-param keys (items[0], a.b), whose
// chars ([ ] . -) are regex metacharacters. Escape a key before splicing it
// into `new RegExp` — otherwise `items[0` threw an unterminated-character-class
// SyntaxError (crashing `selat run`), and `a.b` matched the wrong segment.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Validate raw `--param` values ("key=value" strings) into [key, value] pairs. */
export function parseParamFlags(raw = []) {
  const params = [];
  for (const kv of raw) {
    const s = String(kv ?? "");
    const eq = s.indexOf("=");
    if (eq <= 0) {
      return { ok: false, error: `--param expects key=value, got ${JSON.stringify(s)}` };
    }
    const key = s.slice(0, eq).trim();
    const value = s.slice(eq + 1);
    if (!PARAM_KEY_RE.test(key)) {
      return { ok: false, error: `--param key ${JSON.stringify(key)} is not a valid parameter name` };
    }
    if (/[\0\r\n]/.test(value)) {
      return { ok: false, error: `--param ${key} contains a control character` };
    }
    params.push([key, value]);
  }
  return { ok: true, params };
}

// ":rest*" / "{symbol}" / ":id" → bare param name.
function placeholderName(placeholder) {
  return String(placeholder || "")
    .replace(/^[:{\s]+/, "")
    .replace(/[}*\s]+$/, "");
}

/**
 * Params a refused pick still needs, with any catalog metadata the plan
 * carries (description/example/enumValues from pathParams / queryParams).
 * Returns [{ kind: "path"|"query", name, description?, example?, enumValues? }].
 */
export function missingPlanParams(plan) {
  const out = [];
  const seen = new Set();
  if (plan?.requiresPathParams) {
    const metas = new Map((plan.pathParams || []).map((p) => [p.name, p]));
    for (const ph of plan.pathPlaceholders || []) {
      const name = placeholderName(ph);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ kind: "path", name, ...(metas.get(name) || {}) });
    }
  }
  if (plan?.requiresQueryParams) {
    const metas = new Map((plan.queryParams || []).map((p) => [p.name, p]));
    for (const name of plan.missingQueryParams || []) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ kind: "query", name, ...(metas.get(name) || {}) });
    }
  }
  if (plan?.requiresBodyParams) {
    const metas = new Map((plan.bodyParams || []).map((p) => [p.name, p]));
    for (const name of plan.missingBodyParams || []) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ kind: "body", name, ...(metas.get(name) || {}) });
    }
  }
  return out;
}

function exampleValueFor(param) {
  if (param.example != null && param.example !== "") return String(param.example);
  if (Array.isArray(param.enumValues) && param.enumValues.length > 0) return String(param.enumValues[0]);
  return `<${param.name}>`;
}

/** The exact retry command to print when a pick was refused for missing params. */
export function paramRetryLine(intent, missing) {
  const flags = missing.map((m) => `--param ${m.name}=${exampleValueFor(m)}`);
  return `selat run ${JSON.stringify(String(intent))} ${flags.join(" ")}`.trim();
}

// Split a URL into path part and raw query entries, tolerating template
// braces that the WHATWG URL parser would percent-encode.
function splitUrl(url) {
  const s = String(url || "");
  const hashIdx = s.indexOf("#");
  const noHash = hashIdx === -1 ? s : s.slice(0, hashIdx);
  const qIdx = noHash.indexOf("?");
  const base = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : noHash.slice(qIdx + 1);
  const entries = query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq === -1 ? [pair, null] : [pair.slice(0, eq), pair.slice(eq + 1)];
    });
  return { base, entries };
}

function isTemplateQueryValue(v) {
  if (v == null || v === "") return true;
  const d = String(v).replace(/%7B/gi, "{").replace(/%2A/gi, "*").replace(/%3C/gi, "<");
  return /^[{<:*]/.test(d);
}

/**
 * Substitute path placeholders ({key}, %7Bkey%7D, :key, :key*) and set/append
 * query params on a URL. Path placeholders matching a param key are replaced
 * with the encoded value; every remaining param is set on the query string
 * (replacing template/empty values, appending otherwise). Returns
 * { url, usedPath: Set<key> }.
 */
export function applyParamsToUrl(url, params) {
  const { base, entries } = splitUrl(url);
  let path = base;
  const usedPath = new Set();

  for (const [key, value] of params) {
    const enc = encodeURIComponent(value);
    let replaced = false;
    for (const pattern of [
      `{${key}}`,
      `%7B${key}%7D`,
    ]) {
      if (path.includes(pattern)) {
        path = path.split(pattern).join(enc);
        replaced = true;
      }
    }
    // ":key" / ":key*" must match a whole path segment, not "host:8080".
    const segRe = new RegExp(`(/):${escapeRegExp(key)}\\*?(?=/|$)`, "g");
    if (segRe.test(path)) {
      path = path.replace(segRe, `$1${enc}`);
      replaced = true;
    }
    if (replaced) usedPath.add(key);
  }

  // Remaining params → query string. Replace an existing entry only when its
  // value is a template/empty slot or the caller supplies the same key.
  const queryEntries = entries.slice();
  for (const [key, value] of params) {
    if (usedPath.has(key)) continue;
    const entry = [encodeURIComponent(key), encodeURIComponent(value)];
    const idx = queryEntries.findIndex(([k]) => decodeSafe(k) === key);
    if (idx === -1) queryEntries.push(entry);
    else queryEntries[idx] = entry;
  }

  const query = queryEntries
    .map(([k, v]) => (v == null ? k : `${k}=${v}`))
    .join("&");
  return { url: query ? `${path}?${query}` : path, usedPath };
}

function decodeSafe(s) {
  try { return decodeURIComponent(String(s)); } catch { return String(s); }
}

/** Path placeholders still present in a URL after substitution (path part only). */
export function remainingPathPlaceholders(url) {
  const { base } = splitUrl(url);
  const decoded = base.replace(/%7B/gi, "{").replace(/%7D/gi, "}").replace(/%2A/gi, "*");
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(decoded);
  const path = authority ? decoded.slice(authority[0].length) : decoded;
  const found = [];
  for (const seg of path.split("/")) {
    if (!seg) continue;
    if (seg.startsWith(":") || seg.includes("*") || /\{[^{}]*\}/.test(seg)) found.push(seg);
  }
  return found;
}

/** Query params in a URL that still carry template/empty values. */
export function remainingTemplateQueryParams(url) {
  const { entries } = splitUrl(url);
  return entries
    .filter(([, v]) => isTemplateQueryValue(v))
    .map(([k]) => decodeSafe(k));
}

/**
 * Merge params into a JSON object body string ("{}" default). Values stay
 * strings — upstream JSON schemas that need numbers should get them via a
 * catalog-described query param instead. Non-object bodies are left alone
 * (returns { ok: false }).
 */
export function applyParamsToBody(bodyStr, params) {
  let body;
  try {
    body = JSON.parse(bodyStr || "{}");
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "body is not a JSON object" };
  }
  for (const [key, value] of params) body[key] = value;
  return { ok: true, body: JSON.stringify(body) };
}

/**
 * Params that belong in the endpoint URL during a refusal re-plan. Body params
 * are deliberately excluded here; the final argv rewrite merges them into
 * --body after discovery rebuilds a runnable hint.
 */
export function replanUrlParams(plan, params) {
  const urlNames = new Set(
    missingPlanParams(plan)
      .filter((m) => m.kind === "path" || m.kind === "query")
      .map((m) => m.name)
  );
  return params.filter(([k]) => urlNames.has(k));
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Rewrite a validated selat-pay args array ([METHOD, URL, ...flags]) with
 * `--param` pairs:
 *   1. path placeholders matching a key are substituted in the URL;
 *   2. keys the plan documents as query params (queryParams metadata or
 *      missingQueryParams) go to the URL query string;
 *   3. keys the plan documents as body params (bodyParams metadata or
 *      missingBodyParams) merge into the JSON body;
 *   4. for POST/PUT/PATCH hints that carry --body, remaining keys merge into
 *      the JSON body; otherwise they also go to the query string.
 * Returns { ok, args } or { ok: false, reason }.
 */
export function applyParamsToPayArgs(argsIn, params, plan = {}) {
  if (!Array.isArray(argsIn) || argsIn.length < 2) {
    return { ok: false, reason: "selat-pay args must be [METHOD, URL, ...]" };
  }
  const args = argsIn.slice();
  const method = String(args[0] || "").toUpperCase();
  const bodyIdx = args.indexOf("--body");
  const hasBody = bodyIdx !== -1 && bodyIdx + 1 < args.length;

  const queryNames = new Set([
    ...((plan.queryParams || []).map((p) => p?.name).filter(Boolean)),
    ...((plan.missingQueryParams || []).filter(Boolean)),
  ]);
  const bodyNames = new Set([
    ...((plan.bodyParams || []).map((p) => p?.name).filter(Boolean)),
    ...((plan.missingBodyParams || []).filter(Boolean)),
  ]);

  // Pass 1: path placeholders.
  const pathPass = applyParamsToUrl(args[1], params.filter(([k]) => {
    const { base } = splitUrl(args[1]);
    return base.includes(`{${k}}`) || base.includes(`%7B${k}%7D`) || new RegExp(`/:${escapeRegExp(k)}\\*?(?=/|$)`).test(base);
  }));
  args[1] = pathPass.url;

  const rest = params.filter(([k]) => !pathPass.usedPath.has(k));
  const toQuery = [];
  const toBody = [];
  for (const [k, v] of rest) {
    if (queryNames.has(k) || !(BODY_METHODS.has(method) && hasBody)) toQuery.push([k, v]);
    else if (bodyNames.has(k)) toBody.push([k, v]);
    else toBody.push([k, v]);
  }

  if (toQuery.length > 0) {
    args[1] = applyParamsToUrl(args[1], toQuery).url;
  }
  if (toBody.length > 0) {
    const merged = applyParamsToBody(args[bodyIdx + 1], toBody);
    if (!merged.ok) return { ok: false, reason: `cannot merge --param into request body: ${merged.reason}` };
    args[bodyIdx + 1] = merged.body;
  }
  return { ok: true, args };
}
