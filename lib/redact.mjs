/**
 * Key-blind serialization for product surfaces.
 *
 * The Arc fund raw key (and any mnemonic) may exist in-process for a sign
 * call. It must never appear in CLI stdout/stderr, dumped env/argv, serialized
 * errors, copy-debug bundles, or quote/claim/receipt wire types.
 *
 * Identity on those surfaces is an address or a masked fingerprint — never
 * hex/base64 key material. Tx hashes are also 0x + 64 hex, so this module
 * redacts *known* secret values and *named* secret fields rather than every
 * 32-byte hex string.
 */

export const REDACTED = "[redacted]";

/** Env keys whose values are never dumped. */
export const SECRET_ENV_KEY_RE =
  /^(SELAT_PRIVATE_KEY|.*_PRIVATE_KEY|PRIVATE_KEY|MNEMONIC|.*MNEMONIC.*|SEED_PHRASE|SECRET_KEY)$/i;

/** Object fields that must not appear on signer / quote / claim / dump wire types. */
export const SECRET_FIELD_NAMES = new Set([
  "key",
  "privateKey",
  "private_key",
  "rawKey",
  "raw_key",
  "mnemonic",
  "seed",
  "seedPhrase",
  "seed_phrase",
  "SELAT_PRIVATE_KEY"
]);

const SECRET_ARGV_FLAGS = new Set([
  "--raw-key",
  "--private-key",
  "--key",
  "--mnemonic",
  "--seed"
]);

export function isSecretEnvKey(name) {
  return SECRET_ENV_KEY_RE.test(String(name ?? ""));
}

export function isSecretFieldName(name) {
  return SECRET_FIELD_NAMES.has(String(name ?? ""));
}

/**
 * Replace known secret values (the in-process key/mnemonic) in free text.
 * Also strips a 0x-less copy so a hex dump of the same bytes is covered.
 */
export function redactKnownSecrets(text, secrets = []) {
  let s = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    s = s.split(secret).join(REDACTED);
    if (/^0x/i.test(secret) && secret.length > 10) {
      s = s.split(secret.slice(2)).join(REDACTED);
    }
  }
  return s;
}

/**
 * Redact named secret assignments in free text / JSON without needing the
 * live value: `SELAT_PRIVATE_KEY=…`, `"privateKey":"…"`. A generic `"key"`
 * JSON field is only redacted when its value looks like a 32-byte hex key
 * or a 12/24-word mnemonic — ordinary `"key":"q"` query fields stay.
 */
export function redactNamedSecrets(text) {
  let s = String(text ?? "");
  s = s.replace(
    /\b(SELAT_PRIVATE_KEY|PRIVATE_KEY|[A-Z0-9_]*PRIVATE_KEY|[A-Z0-9_]*MNEMONIC)\s*[:=]\s*\S+/gi,
    `$1=${REDACTED}`
  );
  s = s.replace(
    /"(privateKey|private_key|rawKey|raw_key|mnemonic|seed|seedPhrase|seed_phrase|SELAT_PRIVATE_KEY)"\s*:\s*"[^"]*"/gi,
    `"$1":"${REDACTED}"`
  );
  s = s.replace(
    /"(key)"\s*:\s*"(0x[0-9a-fA-F]{64}|[a-z]+(?: [a-z]+){11,23})"/g,
    `"$1":"${REDACTED}"`
  );
  return s;
}

export function redactText(text, secrets = []) {
  return redactKnownSecrets(redactNamedSecrets(text), secrets);
}

/** Drop secret-named fields from a JSON-like value before it hits a wire. */
export function withoutKeyFields(value, { depth = 0 } = {}) {
  if (value == null || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => withoutKeyFields(v, { depth: depth + 1 }));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretFieldName(k)) continue;
    out[k] = withoutKeyFields(v, { depth: depth + 1 });
  }
  return out;
}

export function redactEnvDump(env = {}, secrets = []) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (isSecretEnvKey(k)) {
      out[k] = v == null || v === "" ? v : REDACTED;
      continue;
    }
    out[k] = typeof v === "string" ? redactText(v, secrets) : v;
  }
  return out;
}

export function redactArgvDump(argv = [], secrets = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const prev = i > 0 ? String(argv[i - 1]) : "";
    if (SECRET_ARGV_FLAGS.has(prev) || /(?:^|-)(raw-key|private-key|mnemonic)$/i.test(prev)) {
      out.push(REDACTED);
      continue;
    }
    out.push(redactText(String(argv[i] ?? ""), secrets));
  }
  return out;
}

/**
 * Serialize an error for logs / --json / SELAT_DEBUG. Redacts before the
 * object is built so JSON.stringify cannot echo a key. Upstream 4xx/5xx
 * bodies passed as `err.body` are redacted the same way.
 */
export function serializeError(err, { secrets = [] } = {}) {
  if (err == null) return { name: "Error", message: "unknown error" };
  const rawMessage = err?.message ?? String(err);
  const body = err?.body != null
    ? (typeof err.body === "string" ? err.body : jsonStringifyRedacted(err.body, secrets))
    : null;
  const message = redactText(rawMessage, secrets);
  const stack = typeof err?.stack === "string" ? redactText(err.stack, secrets) : undefined;
  const out = {
    name: err?.name ?? "Error",
    message
  };
  if (err?.code != null) out.code = err.code;
  if (err?.status != null) out.status = err.status;
  if (body != null) out.body = redactText(body, secrets);
  if (stack) out.stack = stack;
  return out;
}

export function jsonStringifyRedacted(value, secrets = []) {
  const cleaned = withoutKeyFields(value);
  return redactText(JSON.stringify(cleaned), secrets);
}

/**
 * Key-blind snapshot of env / argv / error for copy-debug bundles.
 * Never include the raw key: secret env keys are placeholders, argv values
 * after --raw-key/--private-key are placeholders, errors are serializeError().
 */
export function copyDebugBundle({ env, argv, error, extra, secrets = [] } = {}) {
  return {
    argv: redactArgvDump(argv ?? [], secrets),
    env: redactEnvDump(env ?? {}, secrets),
    error: error != null ? serializeError(error, { secrets }) : null,
    ...(extra && typeof extra === "object" ? withoutKeyFields(extra) : {})
  };
}
