/**
 * Arc fund signer — in-process secret load, key-blind wire type.
 *
 * See-boundary (CTO+Security, SELAT-AI/selat-cli#189): this module MAY see
 * the raw key in memory for the sign call. The return value is the ship
 * contract: `{ signature, address }` or `{ signature, fingerprint }`. No
 * `key` / `privateKey` / `mnemonic` field. The key must not be threaded
 * into the router, quotes, claims, receipts, or CLI dumps.
 */

import { createHash } from "node:crypto";
import { serializeError, withoutKeyFields } from "./redact.mjs";

/** 0x-prefixed 32-byte secp256k1 private key. */
export const ARC_PRIVATE_KEY_HEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Identity surface when an address is not yet derived: SHA-256 of the
 * secret, first 6 + last 4 hex chars. Not reversible to the key, and not
 * the key itself.
 */
export function maskedFingerprint(secret) {
  const hex = createHash("sha256").update(String(secret ?? ""), "utf8").digest("hex");
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * The only wire shape this signer is allowed to return. Extra fields —
 * especially `key` / `privateKey` / `mnemonic` — are dropped, not copied.
 */
export function toArcFundSignerWire(result = {}) {
  const cleaned = withoutKeyFields(result ?? {});
  const out = {};
  if (cleaned.signature != null) out.signature = cleaned.signature;
  if (cleaned.address != null) out.address = cleaned.address;
  else if (cleaned.fingerprint != null) out.fingerprint = cleaned.fingerprint;
  return out;
}

/**
 * Sign `digest` in-process. `privateKey` is an argument (secret-load path)
 * and is never copied onto the returned object. `sign` is injectable so
 * tests pin the wire shape without a live chain or viem.
 *
 * Returns `{ signature, address }` when `address` is provided, otherwise
 * `{ signature, fingerprint }`.
 */
export async function signArcFund({ digest, privateKey, address, sign } = {}) {
  const secrets = typeof privateKey === "string" && privateKey.length >= 8 ? [privateKey] : [];
  if (typeof sign !== "function") {
    throw new Error("Arc fund signer requires an in-process sign function");
  }
  let signature;
  try {
    signature = await sign(digest, privateKey);
  } catch (err) {
    const safe = serializeError(err, { secrets });
    const wrapped = new Error(safe.message);
    wrapped.name = safe.name;
    if (safe.code != null) wrapped.code = safe.code;
    throw wrapped;
  }
  return toArcFundSignerWire({
    signature,
    address: address || undefined,
    fingerprint: address ? undefined : maskedFingerprint(privateKey)
  });
}
