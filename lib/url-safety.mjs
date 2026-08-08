/**
 * Shared URL safety checks for every destination this CLI can be pointed at:
 * skill step urls, catalog serviceUrls, exec hints, the SELAT Router, and the
 * Arc RPC endpoint used for raw-key deposits.
 *
 * All of those carry money or a signature, so the destination must be a
 * parseable https:// URL (http:// only for loopback, for local development).
 * Anything else — another scheme, a plaintext remote host, or a string that
 * curl/selat-pay would read as a flag — is rejected before it reaches a
 * subprocess or a signed payment.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname ?? "").toLowerCase());
}

/**
 * Parsed URL when `url` is a safe https:// (or loopback http://) destination,
 * else null. A leading "-" is refused too: such a string becomes an option
 * rather than a URL when passed as an argv element to curl or selat-pay.
 */
export function safeHttpUrl(url) {
  if (typeof url !== "string" || url === "" || url.startsWith("-")) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return parsed;
  return null;
}

/** safeHttpUrl(), throwing the reason instead of returning null. */
export function assertSafeHttpUrl(url, { source = "url" } = {}) {
  const parsed = safeHttpUrl(url);
  if (parsed) return parsed;
  let valid = false;
  try {
    new URL(url);
    valid = true;
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(`${source} url "${url}" is not a valid URL`);
  throw new Error(`${source} url "${url}" must use https:// (http:// is allowed only for localhost)`);
}
