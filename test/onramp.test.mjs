import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ONRAMP_SESSION_URL,
  ONRAMP_CHAIN_KEYS,
  ONRAMP_TOKENS,
  createOnrampSession,
  onrampExpiryMinutes,
  onrampSessionLines,
  parseOnrampSession
} from "../lib/onramp.mjs";
import { sendUsdcLines } from "../lib/commands/init.mjs";
import { FUND_QR_CHAINS } from "../lib/qr.mjs";

const WIDGET =
  "https://onramp.arc.io/launch/onramp/v1?sessionToken=tok&destinationWallet=0xabc";

test("parseOnrampSession accepts a well-formed session", () => {
  const s = parseOnrampSession({ widgetUrl: WIDGET, expiresAt: "2026-08-12T05:17:38.000Z" });
  assert.equal(s.widgetUrl, WIDGET);
  assert.equal(s.expiresAt, "2026-08-12T05:17:38.000Z");
});

test("parseOnrampSession rejects missing or non-https widget URLs", () => {
  assert.equal(parseOnrampSession(null), null);
  assert.equal(parseOnrampSession({}), null);
  assert.equal(parseOnrampSession({ widgetUrl: "http://onramp.evil.example/launch" }), null);
  assert.equal(parseOnrampSession({ widgetUrl: "javascript:alert(1)" }), null);
  assert.equal(parseOnrampSession({ widgetUrl: "--output=/tmp/x" }), null);
});

test("parseOnrampSession treats a malformed expiresAt as unknown, not fatal", () => {
  const s = parseOnrampSession({ widgetUrl: WIDGET, expiresAt: "soon-ish" });
  assert.equal(s.widgetUrl, WIDGET);
  assert.equal(s.expiresAt, null);
});

test("onrampExpiryMinutes rounds to whole minutes and floors at 1", () => {
  const now = Date.parse("2026-08-12T00:00:00.000Z");
  assert.equal(onrampExpiryMinutes("2026-08-12T00:30:00.000Z", now), 30);
  assert.equal(onrampExpiryMinutes("2026-08-12T00:00:20.000Z", now), 1);
  assert.equal(onrampExpiryMinutes("2026-08-11T23:59:00.000Z", now), null); // past
  assert.equal(onrampExpiryMinutes(null, now), null);
});

test("onrampSessionLines carry the URL, expiry, and the Gateway follow-up", () => {
  const lines = onrampSessionLines({ widgetUrl: WIDGET, minutesLeft: 30 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /card/i);
  assert.equal(lines[1].trim(), WIDGET);
  assert.match(lines[2], /~30 min/);
  assert.match(lines[2], /selat fund/);
  const noExpiry = onrampSessionLines({ widgetUrl: WIDGET });
  assert.match(noExpiry[2], /one-time/);
  assert.match(noExpiry[2], /selat fund/);
});

test("createOnrampSession posts the address and returns the parsed session", async () => {
  let captured;
  const session = await createOnrampSession({
    address: "0xabc",
    userId: "test-user",
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        status: 200,
        json: async () => ({ widgetUrl: WIDGET, expiresAt: "2026-08-12T05:17:38.000Z" })
      };
    }
  });
  assert.equal(captured.url, DEFAULT_ONRAMP_SESSION_URL);
  assert.equal(captured.opts.method, "POST");
  assert.deepEqual(JSON.parse(captured.opts.body), {
    destinationAddress: "0xabc",
    userId: "test-user",
    tokens: ["USDC"],
    chains: ONRAMP_CHAIN_KEYS
  });
  assert.equal(session.widgetUrl, WIDGET);
});

// Onramp is chain-specific: an UNSCOPED session defaults to USDC on Arc and
// offers chains (Celo, Linea, Ronin, HyperEVM, …) and tokens (ETH, USDT, …)
// this CLI has no Gateway deposit path for — a purchase there strands at the
// address. The default scope must therefore be USDC-only on exactly the
// chains `selat fund` can deposit from (the widget drops any it doesn't
// carry, e.g. optimism — verified live 2026-08-11).
test("default session scope is USDC on the fund-capable chains only", () => {
  assert.deepEqual(ONRAMP_TOKENS, ["USDC"]);
  assert.deepEqual(ONRAMP_CHAIN_KEYS, FUND_QR_CHAINS.map((c) => c.key));
  assert.ok(ONRAMP_CHAIN_KEYS.includes("base"));
  assert.ok(!ONRAMP_CHAIN_KEYS.includes("arc"));
});

test("sendUsdcLines carry the address, the chain boundary, and the deposit follow-up", () => {
  const text = sendUsdcLines("0xabc").join("\n");
  assert.match(text, /0xabc/);
  assert.match(text, /same address on every listed chain/);
  for (const c of FUND_QR_CHAINS) assert.match(text, new RegExp(c.key));
  assert.match(text, /only these; elsewhere funds can strand/);
  assert.match(text, /selat fund --amount 2/);
});

test("createOnrampSession fails closed on HTTP errors and bad payloads", async () => {
  await assert.rejects(
    createOnrampSession({
      address: "0xabc",
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) })
    }),
    /HTTP 503/
  );
  await assert.rejects(
    createOnrampSession({
      address: "0xabc",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ widgetUrl: "http://onramp.evil.example/launch" })
      })
    }),
    /unexpected session response/
  );
  await assert.rejects(
    createOnrampSession({
      address: "0xabc",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      }
    }),
    /unreachable/
  );
});

test("createOnrampSession refuses a plaintext session endpoint override", async () => {
  await assert.rejects(
    createOnrampSession({
      address: "0xabc",
      sessionUrl: "http://catalog.evil.example/onramp/session",
      fetchImpl: async () => {
        throw new Error("must not be called");
      }
    }),
    /https/
  );
});
