/**
 * EIP-681 payment URIs + a scannable QR image for `selat fund`'s Step 1
 * (get USDC to the agent wallet address).
 *
 * Why generate an image file ourselves: the Circle CLI's QR flow writes an
 * HTML page under /tmp and opens a browser — useless in chat-first agent
 * harnesses (live Hermes test: the agent had to improvise rendering that HTML
 * before the user could scan anything). So the funding output prints the raw
 * EIP-681 URI (any agent can render its own QR from it) AND writes a PNG the
 * agent can send directly into the chat.
 *
 * No ANSI/terminal QR on purpose — terminal QRs are unscannable in agent UIs.
 *
 * QR matrix comes from `qrcode-generator` (zero runtime dependencies); the
 * PNG bytes are encoded here by hand (grayscale 8-bit, node:zlib deflate) to
 * keep the dependency tree tiny.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import qrcodeFactory from "qrcode-generator";
import { TARGET_USDC_CHAINS } from "./circle.mjs";
import { selatPayStateDir } from "./paths.mjs";

// Chains the Circle CLI can address beyond the Eco deposit sources (they map
// via fund.mjs's EXTRA_CHAIN_CODES). USDC contracts mirror the selat-discovery
// skill's scripts/chains.mjs registry, same as TARGET_USDC_CHAINS.
const EXTRA_FUND_CHAINS = [
  { key: "ethereum", circleCode: "ETH", id: 1, usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
  { key: "avalanche", circleCode: "AVAX", id: 43114, usdc: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e" },
  { key: "unichain", circleCode: "UNI", id: 130, usdc: "0x078d782b760474a361dda0af3839290b0ef57ad6" }
];

/** Every chain a funding URI/QR can be built for. */
export const FUND_QR_CHAINS = [...TARGET_USDC_CHAINS, ...EXTRA_FUND_CHAINS];

/**
 * USDC base units (6 decimals) for an amount, as a decimal string for the
 * URI's uint256 param. Returns null for zero/negative/non-finite amounts.
 */
export function toUsdcUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * 1e6));
}

/**
 * EIP-681 token-transfer URI:
 *   ethereum:<usdc-contract>@<chainId>/transfer?address=<wallet>&uint256=<units>
 * Scannable by any wallet app; any agent can also render its own QR from it.
 * Returns null when the chain is unknown or the amount doesn't convert — the
 * caller degrades to address-only output rather than a wrong URI.
 */
export function usdcTransferUri({ chainKey, address, amountUsdc, chains = FUND_QR_CHAINS }) {
  const key = String(chainKey ?? "").trim().toLowerCase();
  const chain = chains.find((c) => c.key === key);
  if (!chain?.usdc || !chain.id || !address) return null;
  const units = toUsdcUnits(amountUsdc);
  if (units == null) return null;
  return `ethereum:${chain.usdc}@${chain.id}/transfer?address=${address}&uint256=${units}`;
}

// --- PNG encoding (monochrome, grayscale 8-bit, no interlace) ----------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/**
 * Encode a QR module matrix as PNG bytes. `moduleCount`/`isDark(row, col)`
 * match qrcode-generator's API. `scale` is pixels per module; `margin` is the
 * quiet zone in modules (the QR spec asks for 4).
 */
export function qrMatrixToPng({ moduleCount, isDark, scale = 8, margin = 4 }) {
  const px = (moduleCount + margin * 2) * scale;
  // Each scanline: 1 filter byte (0 = None) + px grayscale bytes.
  const raw = Buffer.alloc((px + 1) * px, 0xff);
  for (let y = 0; y < px; y++) {
    const rowStart = y * (px + 1);
    raw[rowStart] = 0;
    const row = Math.floor(y / scale) - margin;
    for (let x = 0; x < px; x++) {
      const col = Math.floor(x / scale) - margin;
      const dark =
        row >= 0 && row < moduleCount && col >= 0 && col < moduleCount && isDark(row, col);
      if (dark) raw[rowStart + 1 + x] = 0x00;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0); // width
  ihdr.writeUInt32BE(px, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  // bytes 10-12 (compression, filter, interlace) stay 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** PNG bytes of a QR code for arbitrary text (error correction M). */
export function qrPngBuffer(text, { scale = 8, margin = 4 } = {}) {
  const qr = qrcodeFactory(0, "M"); // type 0 = smallest version that fits
  qr.addData(String(text));
  qr.make();
  return qrMatrixToPng({
    moduleCount: qr.getModuleCount(),
    isDark: (row, col) => qr.isDark(row, col),
    scale,
    margin
  });
}

/** Stable-ish per-chain QR path, overwritten on every run. */
export function fundQrPath(chainKey, { dir = selatPayStateDir() } = {}) {
  const key = String(chainKey ?? "chain").trim().toLowerCase() || "chain";
  return join(dir, `fund-qr-${key}.png`);
}

/**
 * Write the funding QR image for an EIP-681 URI and return its path.
 * Throws on I/O failure — callers treat the QR as best-effort and fall back
 * to the printed address + URI.
 */
export function writeFundQr({ chainKey, uri, dir } = {}) {
  const path = fundQrPath(chainKey, dir ? { dir } : {});
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, qrPngBuffer(uri));
  return path;
}
