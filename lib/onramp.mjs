/**
 * Circle Onramp (fiat → USDC) sessions, minted via the SELAT catalog proxy.
 *
 * The proxy (`https://catalog.selat.ai/onramp/session`, free) holds the
 * server-only Circle Onramp Kit key, so the CLI never touches it. We POST the
 * destination wallet address and get back a one-time browser widget URL the
 * user opens to buy USDC with a card — nothing here signs or moves money; the
 * purchase happens entirely inside Circle's widget under the user's control.
 *
 * The widget delivers USDC on-chain to the wallet address. That's Step 1 of
 * funding: a `selat fund` re-run then deposits it into Gateway (Step 2), same
 * as crypto funding.
 */

import { safeHttpUrl } from "./url-safety.mjs";
import { sh, isWindows } from "./sh.mjs";

export const DEFAULT_ONRAMP_SESSION_URL = "https://catalog.selat.ai/onramp/session";

/** Session mint is a single small POST; fail fast rather than stall init. */
export const ONRAMP_SESSION_TIMEOUT_MS = 10_000;

/**
 * Validate a session response into { widgetUrl, expiresAt } or null. The
 * widget URL is a destination the user will open and type card details into,
 * so it gets the same https-only gate as every other money-adjacent URL —
 * a proxied/tampered response must not hand the user a plaintext or non-http
 * launch link. `expiresAt` is advisory (null when absent/malformed). Pure.
 */
export function parseOnrampSession(json) {
  const widget = safeHttpUrl(json?.widgetUrl);
  if (!widget) return null;
  const expiresAt =
    typeof json.expiresAt === "string" && !Number.isNaN(Date.parse(json.expiresAt))
      ? json.expiresAt
      : null;
  return { widgetUrl: widget.href, expiresAt };
}

/** Whole minutes until `expiresAt`, or null when unknown/past. Pure. */
export function onrampExpiryMinutes(expiresAt, now = Date.now()) {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t) || t <= now) return null;
  return Math.max(1, Math.round((t - now) / 60_000));
}

/**
 * Mint a Circle Onramp session for `address`. Returns { widgetUrl, expiresAt }
 * or throws with a one-line reason. Overridable endpoint via SELAT_ONRAMP_URL
 * (https-only, loopback http allowed for local development, same rule as the
 * router). `fetchImpl` is injectable for tests.
 */
export async function createOnrampSession({
  address,
  userId = "selat-cli",
  sessionUrl = process.env.SELAT_ONRAMP_URL || DEFAULT_ONRAMP_SESSION_URL,
  timeoutMs = ONRAMP_SESSION_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  if (!safeHttpUrl(sessionUrl)) {
    throw new Error(`onramp session url "${sessionUrl}" must be https:// (http:// only for localhost)`);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(sessionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationAddress: address, userId }),
      signal: ac.signal
    });
  } catch {
    throw new Error("catalog.selat.ai unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`session mint failed (HTTP ${res.status})`);
  const session = parseOnrampSession(await res.json().catch(() => null));
  if (!session) throw new Error("unexpected session response");
  return session;
}

/**
 * The lines init prints for a minted session — the widget URL an agent can
 * relay straight into chat, plus expiry and the Gateway-deposit follow-up.
 * Pure; exported for tests.
 */
export function onrampSessionLines({ widgetUrl, minutesLeft = null }) {
  return [
    "Buy USDC with a card (Circle Onramp) — open in a browser:",
    `  ${widgetUrl}`,
    (minutesLeft != null
      ? `Link expires in ~${minutesLeft} min (re-run selat init for a fresh one).`
      : "Link is one-time (re-run selat init for a fresh one).") +
      " After the purchase lands on-chain, deposit into Gateway: selat fund"
  ];
}

/**
 * Best-effort open of `url` in the user's default browser. Only ever called
 * with an https widget URL that parseOnrampSession already vetted. Returns
 * true when the opener exited 0; false means "print the URL instead".
 */
export async function openInBrowser(url) {
  const [bin, args] = isWindows
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    const r = await sh(bin, args);
    return r.code === 0;
  } catch {
    return false;
  }
}
