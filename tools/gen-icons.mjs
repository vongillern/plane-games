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

function snakeLayers(t) {
  // sinuous snake: overlapping circles along an S-curve, tapering to the tail
  const layers = [];
  const N = 26;
  const pos = (k) => [126 + k * 250, 286 + 66 * Math.sin(k * 5.8 - 0.9)];
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1);                       // 0 = tail, 1 = head
    const [x, y] = pos(k);
    const r = 24 + k * 24;
    layers.push({ sdf: sdCircle(t(x), t(y), t(r)), color: solid('#ffffff') });
  }
  const [hx, hy] = pos(1);
  layers.push({ sdf: sdCircle(t(hx + 14), t(hy - 16), t(10)), color: solid('#0b4634') });
  // food dot in the open corner
  layers.push({ sdf: sdCircle(t(146), t(136), t(32)), color: gradient('#fff7f0', '#ffd9a8', t(120), t(110), t(172), t(162)) });
  return layers;
}
function glideLayers(t) {
  // paper dart gliding through a gap between two pillars
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  return [
    { sdf: sdRoundRect(t(388), t(96), t(44), t(96), t(24)), color: solid('#ffffff', 70) },   // top pillar
    { sdf: sdRoundRect(t(388), t(416), t(44), t(96), t(24)), color: solid('#ffffff', 70) },  // bottom pillar
    { sdf: p([[96, 300], [352, 232], [220, 322]]), color: solid('#ffffff') },                // upper wing
    { sdf: p([[220, 322], [352, 232], [268, 352]]), color: solid('#ffffff', 200) },          // lower wing
  ];
}

function bridgeLayers(t) {
  // suspension bridge: catenary cable band, two towers, road deck
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  return [
    { sdf: p([[150, 186], [256, 322], [362, 186], [362, 202], [256, 338], [150, 202]]), color: solid('#ffffff', 150) },
    { sdf: sdRoundRect(t(150), t(272), t(15), t(98), t(11)), color: solid('#ffffff', 225) },
    { sdf: sdRoundRect(t(362), t(272), t(15), t(98), t(11)), color: solid('#ffffff', 225) },
    { sdf: sdRoundRect(t(256), t(364), t(192), t(15), t(13)), color: solid('#ffffff') },
  ];
}
function runwayLayers(t) {
  // runway receding to the horizon with center dashes
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  const layers = [
    { sdf: p([[213, 122], [299, 122], [404, 452], [108, 452]]), color: solid('#ffffff', 44) },
  ];
  const dashes = [[146, 9, 22], [200, 12, 30], [264, 16, 40], [342, 21, 52]];
  for (const [y, hw, hh] of dashes) {
    layers.push({ sdf: sdRoundRect(t(256), t(y + hh), t(hw), t(hh), t(hw * 0.8)), color: solid('#ffffff', 235) });
  }
  return layers;
}
function hopLayers(t) {
  // bouncy ball climbing staggered platforms
  return [
    { sdf: sdRoundRect(t(150), t(198), t(56), t(13), t(13)), color: solid('#ffffff', 90) },
    { sdf: sdRoundRect(t(356), t(294), t(66), t(14), t(14)), color: solid('#ffffff', 145) },
    { sdf: sdRoundRect(t(168), t(394), t(84), t(16), t(16)), color: solid('#ffffff', 235) },
    { sdf: sdCircle(t(168), t(308), t(46)), color: gradient('#ffffff', '#eaffcf', t(130), t(270), t(208), t(348)) },
  ];
}

function novaLayers(t) {
  // sleek ship climbing through a starfield, twin laser trails below
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  const star = (x, y, r, a) => ({ sdf: sdCircle(t(x), t(y), t(r)), color: solid('#ffffff', a) });
  return [
    star(140, 128, 10, 150), star(392, 170, 7, 110), star(352, 96, 12, 200),
    star(112, 300, 8, 90), star(404, 330, 9, 130),
    { sdf: sdRoundRect(t(206), t(420), t(9), t(52), t(9)), color: solid('#ffffff', 120) },  // left laser trail
    { sdf: sdRoundRect(t(306), t(420), t(9), t(52), t(9)), color: solid('#ffffff', 120) },  // right laser trail
    { sdf: p([[256, 130], [332, 340], [256, 296], [180, 340]]), color: solid('#ffffff') },  // ship hull
    { sdf: sdCircle(t(256), t(216), t(24)), color: gradient('#bae6fd', '#38bdf8', t(232), t(192), t(280), t(240)) }, // cockpit
  ];
}
function carveLayers(t) {
  // twin alpine peaks with a carved S-trail sweeping down the slope
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  const layers = [
    { sdf: p([[36, 316], [168, 118], [252, 226], [340, 140], [476, 316]]), color: solid('#ffffff', 92) },
    { sdf: p([[132, 172], [168, 118], [204, 172], [168, 152]]), color: solid('#ffffff', 235) },   // snow cap L
    { sdf: p([[308, 188], [340, 140], [372, 188], [340, 168]]), color: solid('#ffffff', 235) },   // snow cap R
  ];
  const N = 22;
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1);
    const x = 256 + Math.sin(k * 3.6 - 0.35) * (30 + 120 * k);
    const y = 158 + k * 274;
    const r = 6 + 21 * k;
    layers.push({ sdf: sdCircle(t(x), t(y), t(r)), color: solid('#ffffff', 225) });
  }
  return layers;
}
function breakerLayers(t) {
  // brick rows above, ball mid-flight, paddle below
  const brick = (cx, cy, a) => ({ sdf: sdRoundRect(t(cx), t(cy), t(52), t(21), t(12)), color: solid('#ffffff', a) });
  return [
    brick(140, 128, 235), brick(256, 128, 190), brick(372, 128, 235),
    brick(198, 186, 150), brick(314, 186, 150),
    { sdf: sdRoundRect(t(256), t(408), t(96), t(17), t(15)), color: solid('#ffffff', 235) }, // paddle
    { sdf: sdCircle(t(300), t(302), t(34)), color: gradient('#ffffff', '#ffe3c4', t(272), t(274), t(328), t(330)) }, // ball
  ];
}

function sinkLayers(t) {
  // one big opening and one big block going into it — at 48px anything smaller
  // than this turns to noise
  const p = (pts) => sdPolygon(pts.map(([x, y]) => [t(x), t(y)]));
  return [
    // a white ellipse reads as the lit rim, with the opening punched over it —
    // offset downward so the near lip catches more light than the far one
    { sdf: sdEllipse(t(256), t(306), t(176), t(112)), color: solid('#ffffff', 238) },
    { sdf: sdEllipse(t(256), t(296), t(164), t(102)), color: solid('#1a060b', 255) },
    // a block tipping over the far lip, drawn as three faces
    { sdf: p([[236, 214], [330, 176], [400, 208], [306, 246]]), color: gradient('#ffffff', '#ffd0d0', t(236), t(176), t(400), t(246)) },
    { sdf: p([[236, 214], [306, 246], [306, 322], [236, 290]]), color: solid('#e8b8b8', 240) },
    { sdf: p([[306, 246], [400, 208], [400, 284], [306, 322]]), color: solid('#c08d8d', 240) },
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
  {
    dir: 'games/snake', bg0: '#0b4634', bg1: '#34d399', art: snakeLayers,
  },
  {
    dir: 'games/glide', bg0: '#6e1f38', bg1: '#fb7185', art: glideLayers,
  },
  {
    dir: 'games/span', bg0: '#14284f', bg1: '#3b82f6', art: bridgeLayers,
  },
  {
    dir: 'games/runway', bg0: '#3b0a45', bg1: '#d946ef', art: runwayLayers,
  },
  {
    dir: 'games/hop', bg0: '#1b3f22', bg1: '#84cc16', art: hopLayers,
  },
  {
    dir: 'games/nova', bg0: '#101b3f', bg1: '#38bdf8', art: novaLayers,
  },
  {
    dir: 'games/breaker', bg0: '#57150d', bg1: '#f97316', art: breakerLayers,
  },
  {
    dir: 'games/carve', bg0: '#0b3f38', bg1: '#2dd4bf', art: carveLayers,
  },
  {
    dir: 'games/sink', bg0: '#4a0d10', bg1: '#ef4444', art: sinkLayers,
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
