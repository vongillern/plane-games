// Generates all PWA icons (pure node, no deps): SDF rasterizer -> PNG encoder.
// Usage: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- SDF drawing ----------
// Scene = list of layers: { sdf(x,y) -> signed distance, color(x,y) -> [r,g,b,a] }
const sdRoundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};
const sdCircle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const sdEllipse = (cx, cy, rx, ry) => (x, y) => {
  // approximate: scale y, good enough for icons
  const k = rx / ry;
  return Math.hypot(x - cx, (y - cy) * k) - rx;
};
const sdPolygon = (pts) => (x, y) => {
  let d = Infinity, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    const ex = xj - xi, ey = yj - yi;
    const wx = x - xi, wy = y - yi;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = y >= yi, c2 = y < yj, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const solid = (h, a = 255) => { const [r, g, b] = hex(h); return () => [r, g, b, a]; };
// linear gradient from (x0,y0)->(x1,y1) between two hex colors
const gradient = (h0, h1, x0, y0, x1, y1) => {
  const c0 = hex(h0), c1 = hex(h1);
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
  return (x, y) => {
    let t = ((x - x0) * dx + (y - y0) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t, 255];
  };
};

// Render layers into RGBA buffer at size S with 2x2 supersampling.
function render(layers, S) {
  const buf = Buffer.alloc(S * S * 4);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const x = px + (sx + 0.5) / 2, y = py + (sy + 0.5) / 2;
        // composite layers back-to-front
        let cr = 0, cg = 0, cb = 0, ca = 0;
        for (const L of layers) {
          const d = L.sdf(x, y);
          const cov = Math.max(0, Math.min(1, 0.5 - d)); // 1px AA
          if (cov <= 0) continue;
          const [lr, lg, lb, la] = L.color(x, y);
          const al = (la / 255) * cov;
          cr = lr * al + cr * (1 - al);
          cg = lg * al + cg * (1 - al);
          cb = lb * al + cb * (1 - al);
          ca = al + ca * (1 - al);
        }
        r += cr; g += cg; b += cb; a += ca;
      }
      const i = (py * S + px) * 4;
      buf[i] = Math.round(r / 4); buf[i + 1] = Math.round(g / 4);
      buf[i + 2] = Math.round(b / 4); buf[i + 3] = Math.round((a / 4) * 255);
    }
  }
  return buf;
}

// ---------- Icon art (drawn in a 512-unit space, scale = S/512) ----------
// Each art fn returns layers given a transform t(v) that maps design units -> px,
// plus `full` flag: maskable icons draw art at 80% inside a full-bleed bg.
const ALL = () => () => -1e9; // covers everything

function planeLayers(t) {
  // paper plane pointing NE
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  return [
    { sdf: p([[128, 356], [400, 128], [236, 328]]), color: solid('#ffffff') },          // upper wing
    { sdf: p([[236, 328], [400, 128], [300, 390]]), color: solid('#ffffff', 210) },     // lower wing
    { sdf: p([[236, 328], [262, 352], [252, 398]]), color: solid('#ffffff', 150) },     // fold
  ];
}
function tilesLayers(t) {
  const tile = (cx, cy, hi) => ({
    sdf: sdRoundRect(t(cx), t(cy), t(74), t(74), t(24)),
    color: hi ? gradient('#fff3d6', '#ffffff', t(cx - 74), t(cy - 74), t(cx + 74), t(cy + 74))
              : solid('#ffffff', 64),
  });
  return [tile(174, 174, false), tile(338, 174, false), tile(174, 338, false), tile(338, 338, true)];
}
function helixLayers(t) {
  const disc = (cy, rx, gap) => {
    const layers = [{ sdf: sdEllipse(t(256), t(cy), t(rx), t(rx * 0.34)), color: solid('#ffffff', 58) }];
    if (gap) layers.push({ sdf: sdEllipse(t(256 + rx * 0.62), t(cy - rx * 0.1), t(rx * 0.45), t(rx * 0.2)), color: solid('#0e1220') });
    return layers;
  };
  return [
    ...disc(392, 158, false),
    ...disc(312, 158, true),
    ...disc(232, 158, false),
    { sdf: sdCircle(t(256), t(128), t(46)), color: gradient('#67e8f9', '#22d3ee', t(210), t(82), t(302), t(174)) },
  ];
}

const APPS = [
  {
    dir: '.', bg0: '#2a1e66', bg1: '#7c5cff', art: planeLayers,
  },
  {
    dir: 'games/2048', bg0: '#7a3f0d', bg1: '#f5a623', art: tilesLayers,
  },
  {
    dir: 'games/drop', bg0: '#131629', bg1: '#312a6e', art: helixLayers,
  },
];

function makeIcon(app, S, { maskable }) {
  const scale = S / 512;
  const layers = [];
  if (maskable) {
    // full-bleed bg, art scaled to safe zone (80%)
    layers.push({ sdf: ALL(), color: gradient(app.bg0, app.bg1, 0, 0, S, S) });
    const t = (v) => (v - 256) * 0.72 * scale + S / 2;
    layers.push(...app.art(t));
  } else {
    const r = S * 0.223; // squircle-ish corner radius
    layers.push({ sdf: sdRoundRect(S / 2, S / 2, S / 2, S / 2, r), color: gradient(app.bg0, app.bg1, 0, 0, S, S) });
    const t = (v) => v * scale;
    layers.push(...app.art(t));
  }
  return encodePNG(render(layers, S), S, S);
}

for (const app of APPS) {
  const dir = join(ROOT, app.dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'icon-192.png'), makeIcon(app, 192, { maskable: false }));
  writeFileSync(join(dir, 'icon-512.png'), makeIcon(app, 512, { maskable: false }));
  writeFileSync(join(dir, 'icon-maskable-512.png'), makeIcon(app, 512, { maskable: true }));
  console.log(`✓ ${app.dir}`);
}
