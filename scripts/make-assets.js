/*
 * Generates every PWA image asset — app icons and the iOS launch screens —
 * with no image library: polygons are rasterised by hand and encoded straight
 * to PNG with zlib.
 *
 *   node scripts/make-assets.js
 *
 * Why bother: iOS ignores the web manifest when drawing a splash screen. It
 * only uses <link rel="apple-touch-startup-image"> and only when the image
 * matches the device's exact pixel dimensions, so every screen size needs its
 * own file. Android/Chrome, by contrast, composes one from the manifest's
 * name, background_color and 512px icon.
 */
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const SPLASH = path.join(PUBLIC, 'splash');

// Palette, kept in step with styles.css.
const BG_TOP = [17, 26, 46];       // #111a2e
const BG_BOTTOM = [11, 18, 32];    // #0b1220
const GLOW = [251, 191, 36];       // --accent
const BOLT_TOP = [253, 230, 138];
const BOLT_MID = [251, 191, 36];
const BOLT_BOTTOM = [249, 115, 22];

// The bolt, in a 0..512 design space (same geometry as public/icon.svg).
const BOLT = [[297, 20], [133, 287], [231, 287], [205, 492], [379, 215], [277, 215]];

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));

function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundedRect(x, y, w, h, r) {
  if (r <= 0) return x >= 0 && x <= w && y >= 0 && y <= h;
  const inX = x >= r && x <= w - r, inY = y >= r && y <= h - r;
  if (inX || inY) return x >= 0 && x <= w && y >= 0 && y <= h;
  const cx = x < r ? r : w - r, cy = y < r ? r : h - r;
  return Math.hypot(x - cx, y - cy) <= r;
}

/*
 * Draw a bolt (optionally on a rounded panel) centred in a w x h canvas.
 *
 * `panel` is the panel's side length in pixels; null means no panel, just the
 * bolt on the page background — which is what the launch screens use.
 */
function render({ w, h, boltSize, panel = null, panelRadius = 0, cornerRadius = 0, glow = false }) {
  const SS = 3;                       // supersampling, for smooth diagonals
  const px = Buffer.alloc(w * h * 4);

  const cx = w / 2, cy = h / 2;
  const scale = boltSize / 512;
  const bolt = BOLT.map(([x, y]) => [cx + (x - 256) * scale, cy + (y - 256) * scale]);
  const boltTop = Math.min(...bolt.map(p => p[1]));
  const boltBottom = Math.max(...bolt.map(p => p[1]));

  const panelX = cx - (panel || 0) / 2, panelY = cy - (panel || 0) / 2;

  for (let y = 0; y < h; y++) {
    /*
     * Background: a vertical gradient only. Rows differ from their neighbour by
     * a constant, which the Up filter below turns into near-zero bytes.
     *
     * The warm band behind the mark is deliberately a function of y alone. The
     * obvious radial halo looks marginally better and costs eight times the
     * bytes — 154 KB against 19 KB on a 1290x2796 screen — because varying
     * horizontally destroys the row-to-row repetition the filter relies on.
     */
    let base = lerp(BG_TOP, BG_BOTTOM, h === 1 ? 0 : y / (h - 1));
    if (glow === 'vertical') {
      const strength = Math.max(0, 1 - Math.abs(y - h * 0.42) / (h * 0.42)) ** 2 * 0.16;
      base = base.map((v, i) => v + (GLOW[i] - v) * strength);
    }
    const boltT = boltBottom > boltTop ? (y - boltTop) / (boltBottom - boltTop) : 0;
    const boltColour = boltT < 0.5
      ? lerp(BOLT_TOP, BOLT_MID, Math.max(0, boltT) * 2)
      : lerp(BOLT_MID, BOLT_BOTTOM, Math.min(1, (boltT - 0.5) * 2));

    for (let x = 0; x < w; x++) {
      let inPanel = 0, inBolt = 0, inCanvas = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px_ = x + (sx + 0.5) / SS, py_ = y + (sy + 0.5) / SS;
          if (cornerRadius ? insideRoundedRect(px_, py_, w, h, cornerRadius) : true) inCanvas++;
          if (panel && insideRoundedRect(px_ - panelX, py_ - panelY, panel, panel, panelRadius)) inPanel++;
          if (pointInPolygon(bolt, px_, py_)) inBolt++;
        }
      }
      const n = SS * SS;
      let colour = base.slice();

      if (glow === 'radial') {
        // Warm halo behind the mark, strongest just above centre.
        const d = Math.hypot((x - cx) / w, (y - cy * 0.85) / h);
        const strength = Math.max(0, 1 - d / 0.55) ** 2 * 0.30;
        colour = colour.map((v, i) => v + (GLOW[i] - v) * strength);
      }
      if (panel) {
        const a = inPanel / n * 0.10;   // barely-there tile, like the app icon
        colour = colour.map(v => v + (255 - v) * a);
      }
      const boltAlpha = inBolt / n;
      if (boltAlpha) colour = colour.map((v, i) => v + (boltColour[i] - v) * boltAlpha);

      const o = (y * w + x) * 4;
      px[o] = clamp255(colour[0]);
      px[o + 1] = clamp255(colour[1]);
      px[o + 2] = clamp255(colour[2]);
      px[o + 3] = Math.round(255 * (inCanvas / n));
    }
  }
  return encodePng(w, h, px);
}

/*
 * PNG with the Up filter on every row: each byte becomes the difference from
 * the row above. A vertical gradient then deflates to almost nothing, which is
 * what keeps seventeen full-resolution launch screens down to a few hundred KB.
 */
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const out = y * (stride + 1);
    raw[out] = 2;                                   // filter: Up
    for (let i = 0; i < stride; i++) {
      const here = rgba[y * stride + i];
      const above = y === 0 ? 0 : rgba[(y - 1) * stride + i];
      raw[out + 1 + i] = (here - above) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                         // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/*
 * Portrait launch screens. iOS matches on device-width/height and DPR, so a
 * missing size falls back to a white screen — hence the long list. Several
 * devices share dimensions and are covered by one entry.
 */
const DEVICES = [
  { w: 320, h: 568, dpr: 2, note: 'iPhone SE (1st gen)' },
  { w: 375, h: 667, dpr: 2, note: 'iPhone 8, SE (2nd/3rd gen)' },
  { w: 375, h: 812, dpr: 3, note: 'iPhone X, XS, 11 Pro, 12/13 mini' },
  { w: 390, h: 844, dpr: 3, note: 'iPhone 12, 13, 14' },
  { w: 393, h: 852, dpr: 3, note: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { w: 402, h: 874, dpr: 3, note: 'iPhone 16 Pro' },
  { w: 414, h: 896, dpr: 2, note: 'iPhone XR, 11' },
  { w: 414, h: 896, dpr: 3, note: 'iPhone XS Max, 11 Pro Max' },
  { w: 428, h: 926, dpr: 3, note: 'iPhone 12/13 Pro Max, 14 Plus' },
  { w: 430, h: 932, dpr: 3, note: 'iPhone 14/15 Pro Max, 15 Plus, 16 Plus' },
  { w: 440, h: 956, dpr: 3, note: 'iPhone 16 Pro Max' },
  { w: 768, h: 1024, dpr: 2, note: 'iPad, iPad mini' },
  { w: 810, h: 1080, dpr: 2, note: 'iPad 10.2"' },
  { w: 820, h: 1180, dpr: 2, note: 'iPad Air 10.9"' },
  { w: 834, h: 1112, dpr: 2, note: 'iPad Pro 10.5"' },
  { w: 834, h: 1194, dpr: 2, note: 'iPad Pro 11"' },
  { w: 1024, h: 1366, dpr: 2, note: 'iPad Pro 12.9"' }
];

fs.mkdirSync(SPLASH, { recursive: true });

// ---- app icons ---------------------------------------------------------------
const icons = [
  ['icon-192.png', render({ w: 192, h: 192, boltSize: 176, cornerRadius: 42, glow: 'radial' })],
  ['icon-512.png', render({ w: 512, h: 512, boltSize: 470, cornerRadius: 112, glow: 'radial' })],
  // Maskable: full bleed, mark pulled inside the safe zone so a circular crop
  // can't clip it.
  ['icon-maskable.png', render({ w: 512, h: 512, boltSize: 290, cornerRadius: 0, glow: 'radial' })]
];
for (const [name, buffer] of icons) {
  fs.writeFileSync(path.join(PUBLIC, name), buffer);
  console.log(`${name.padEnd(24)} ${(buffer.length / 1024).toFixed(1)} KB`);
}

// ---- launch screens ----------------------------------------------------------
let total = 0;
const links = [];
for (const d of DEVICES) {
  const w = d.w * d.dpr, h = d.h * d.dpr;
  // Mark sized to the narrow edge so phones and tablets look alike.
  const buffer = render({
    w, h,
    boltSize: Math.round(Math.min(w, h) * 0.30),
    panel: Math.round(Math.min(w, h) * 0.52),
    panelRadius: Math.round(Math.min(w, h) * 0.12),
    glow: 'vertical'
  });
  const name = `splash-${w}x${h}.png`;
  fs.writeFileSync(path.join(SPLASH, name), buffer);
  total += buffer.length;
  console.log(`${name.padEnd(24)} ${(buffer.length / 1024).toFixed(1).padStart(7)} KB   ${d.note}`);

  links.push(
    `<link rel="apple-touch-startup-image" href="splash/${name}" ` +
    `media="(device-width: ${d.w}px) and (device-height: ${d.h}px) and ` +
    `(-webkit-device-pixel-ratio: ${d.dpr}) and (orientation: portrait)">`
  );
}
console.log(`\n${DEVICES.length} launch screens, ${(total / 1024).toFixed(0)} KB total`);

// The <link> tags are mechanical and easy to get subtly wrong by hand, so print
// them for pasting into index.html whenever the device list changes.
fs.writeFileSync(path.join(HERE, 'apple-startup-links.html'), links.join('\n') + '\n');
console.log(`Link tags written to scripts/apple-startup-links.html`);
