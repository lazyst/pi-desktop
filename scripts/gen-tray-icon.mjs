// Generates a crisp 256x256 RGBA PNG tray icon (a white π on a violet rounded
// tile) without any external dependency — only Node's built-in zlib is used.
// Run with: node scripts/gen-tray-icon.mjs
// The output (src/main/assets/tray-icon.png) is committed; scripts/copy-assets.mjs
// then copies it into the build output so the main process can load it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '..', 'src', 'main', 'assets', 'tray-icon.png');

const SIZE = 256;
const buf = new Uint8Array(SIZE * SIZE * 4);

// --- draw helpers ---------------------------------------------------------
function setPx(x, y, [r, g, b, a]) {
  const i = (y * SIZE + x) * 4;
  // alpha blend over transparent background
  const sa = a / 255;
  buf[i] = Math.round(r * sa + buf[i] * (1 - sa));
  buf[i + 1] = Math.round(g * sa + buf[i + 1] * (1 - sa));
  buf[i + 2] = Math.round(b * sa + buf[i + 2] * (1 - sa));
  buf[i + 3] = Math.max(buf[i + 3], a);
}

// inside a rounded rectangle?
function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + rad ? x0 + rad : x > x1 - rad ? x1 - rad : x;
  const cy = y < y0 + rad ? y0 + rad : y > y1 - rad ? y1 - rad : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// anti-aliased filled rectangle (soft edges) by sampling coverage
function fillRoundRect(x0, y0, x1, y1, rad, color) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      // 2x2 supersampling for smooth edges
      let cover = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (inRoundRect(x + sx, y + sy, x0, y0, x1, y1, rad)) cover++;
      }
      if (cover > 0) setPx(x, y, [color[0], color[1], color[2], Math.round(color[3] * (cover / 4))]);
    }
  }
}

function fillRectAA(x0, y0, x1, y1, color) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let cover = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (x + sx >= x0 && x + sx <= x1 && y + sy >= y0 && y + sy <= y1) cover++;
      }
      if (cover > 0) setPx(x, y, [color[0], color[1], color[2], Math.round(color[3] * (cover / 4))]);
    }
  }
}

const VIOLET = [124, 58, 237, 255]; // #7C3AED
const WHITE = [255, 255, 255, 255];

// tile background
fillRoundRect(16, 16, 240, 240, 48, VIOLET);

// π glyph (white): top bar + two legs
fillRectAA(64, 72, 192, 100, WHITE); // top bar
fillRectAA(64, 72, 96, 184, WHITE); // left leg
fillRectAA(160, 72, 192, 184, WHITE); // right leg

// --- PNG encode (RGBA, zlib deflate) -------------------------------------
function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// raw image: each row prefixed with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  buf.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[y * (SIZE * 4 + 1) + 1 + i] = v;
  });
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`[gen-tray-icon] wrote ${outPath} (${png.length} bytes)`);
