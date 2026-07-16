import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FUND_QR_CHAINS,
  fundQrPath,
  qrPngBuffer,
  toUsdcUnits,
  usdcTransferUri,
  writeFundQr
} from "../lib/qr.mjs";
import { fundingDetailLines } from "../lib/commands/fund.mjs";

// Step-1 funding output must let a chat-harness agent hand the user something
// scannable directly: the raw EIP-681 URI plus a PNG we generate ourselves —
// the Circle CLI only writes an HTML page under /tmp, which the live Hermes
// test showed agents have to improvise around. No ANSI/terminal QR (Circle's
// own guidance: unscannable in agent UIs).

const WALLET = "0xb291279be48742f0a1e9ed15c8d6d2d09ea9e4da";

// --- EIP-681 URI --------------------------------------------------------------

// USDC contracts + chain ids mirror the selat-discovery skill's
// scripts/chains.mjs registry (Circle-issued USDC per chain).
const EXPECTED_CHAINS = {
  base: [8453, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  optimism: [10, "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  arbitrum: [42161, "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  polygon: [137, "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
  ethereum: [1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  avalanche: [43114, "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"],
  unichain: [130, "0x078d782b760474a361dda0af3839290b0ef57ad6"]
};

test("EIP-681 URI carries the right USDC contract and chain id for every fundable chain", () => {
  for (const [key, [chainId, usdc]] of Object.entries(EXPECTED_CHAINS)) {
    assert.equal(
      usdcTransferUri({ chainKey: key, address: WALLET, amountUsdc: 2 }),
      `ethereum:${usdc}@${chainId}/transfer?address=${WALLET}&uint256=2000000`,
      `wrong URI for ${key}`
    );
  }
  // The registry and the expectation table must cover the same chains.
  assert.deepEqual(
    FUND_QR_CHAINS.map((c) => c.key).sort(),
    Object.keys(EXPECTED_CHAINS).sort()
  );
});

test("URI amounts are USDC base units (6 decimals)", () => {
  assert.equal(toUsdcUnits(2), "2000000");
  assert.equal(toUsdcUnits(1.5), "1500000");
  assert.equal(toUsdcUnits(0.000001), "1");
  // qrShortfall() rounds up to 6 decimals before this; float dust must not
  // shave a unit off.
  assert.equal(toUsdcUnits(0.2), "200000");
  assert.equal(toUsdcUnits(0), null);
  assert.equal(toUsdcUnits(-1), null);
  assert.equal(toUsdcUnits("nope"), null);
});

test("unknown chains and bad amounts degrade to no URI, never a wrong one", () => {
  assert.equal(usdcTransferUri({ chainKey: "arc", address: WALLET, amountUsdc: 2 }), null);
  assert.equal(usdcTransferUri({ chainKey: "", address: WALLET, amountUsdc: 2 }), null);
  assert.equal(usdcTransferUri({ chainKey: "base", address: null, amountUsdc: 2 }), null);
  assert.equal(usdcTransferUri({ chainKey: "base", address: WALLET, amountUsdc: 0 }), null);
  // Chain keys are case/whitespace tolerant like circleChainCode().
  assert.match(usdcTransferUri({ chainKey: " Base ", address: WALLET, amountUsdc: 2 }), /@8453\//);
});

// --- QR image file ------------------------------------------------------------

function pngDimensions(buf) {
  // Bytes 16–23 of a PNG are IHDR width/height (big-endian).
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("qrPngBuffer produces a real PNG with non-trivial dimensions", () => {
  const uri = usdcTransferUri({ chainKey: "base", address: WALLET, amountUsdc: 2 });
  const png = qrPngBuffer(uri);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG magic bytes"
  );
  const { width, height } = pngDimensions(png);
  assert.equal(width, height);
  // Smallest QR is 21 modules; with the 4-module quiet zone at 8px/module the
  // image must be comfortably scannable, not a thumbnail.
  assert.ok(width >= (21 + 8) * 8, `width ${width} too small to scan`);
  assert.ok(png.length > 200, "suspiciously tiny PNG payload");
});

test("writeFundQr writes the per-chain file and returns its path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "selat-fund-qr-"));
  const uri = usdcTransferUri({ chainKey: "base", address: WALLET, amountUsdc: 1.5 });
  const path = writeFundQr({ chainKey: "base", uri, dir });
  assert.equal(path, join(dir, "fund-qr-base.png"));
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(pngDimensions(bytes).width > 100);
  assert.ok(statSync(path).size > 200);
  // Overwrites per run: same stable path on a second write.
  assert.equal(writeFundQr({ chainKey: "base", uri, dir }), path);
});

test("fundQrPath is stable per chain and normalizes the key", () => {
  assert.match(fundQrPath("base"), /selat-pay\/fund-qr-base\.png$/);
  assert.match(fundQrPath(" Base ", { dir: "/x" }), /^\/x\/fund-qr-base\.png$/);
});

// --- Step-1 detail lines --------------------------------------------------------

test("funding details always print address/network/token/amount, URI when known", () => {
  const uri = usdcTransferUri({ chainKey: "base", address: WALLET, amountUsdc: 1.5 });
  const lines = fundingDetailLines({ address: WALLET, chainKey: "base", shortfall: 1.5, uri });
  const text = lines.join("\n");
  assert.match(text, new RegExp(`Address\\s+${WALLET}`));
  assert.match(text, /Network\s+base \(chain id 8453\)/);
  assert.match(text, /Token\s+USDC/);
  assert.match(text, /Amount\s+\$1\.50 USDC/);
  assert.match(text, /URI\s+ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453\/transfer\?address=/);
});

test("funding details degrade to address-only on an unknown chain (no wrong URI)", () => {
  const lines = fundingDetailLines({ address: WALLET, chainKey: "arc", shortfall: 2, uri: null });
  const text = lines.join("\n");
  assert.match(text, new RegExp(`Address\\s+${WALLET}`));
  assert.doesNotMatch(text, /URI/);
});
