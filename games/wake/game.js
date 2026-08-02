import * as THREE from './vendor/three.module.js';
import { installPause } from './pause.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';
import {
  TAU, clamp, lerp, normAngle,
  buildCourse, racingLine, TRACK_HALF, LAPS, GRID,
  stepProgress, raceOrder, isFinished,
  V_MAX, V_BOOST, HIT_LOSS, speedStep, yawRate,
  BOOST_MAX, BOOST_ARM, boostStep, boostActive, draftFactor, DRAFT_LEN,
  waveHeight, waveSlope, waveRow, launchSpeed, SWELL_MAX,
  RIVALS, PLAYER_NAME, PLAYER_HUE, aiPace,
  formatTime, ordinal,
} from './rules.js';

// ---------------------------------------------------------------------------
// Constants / tuning
//
// World is metres, y up, water at y ≈ 0. A ski's heading `h` means it points
// along (cos h, sin h) in the XZ plane, which is the same convention
// course.ang uses — so a heading can be compared with the course direction
// without a conversion anywhere.
// ---------------------------------------------------------------------------
const GRAVITY = 17;              // arcade gravity for swell jumps (m/s²)
const DRAG_FULL = 96;            // px of horizontal drag for full lock
const STEER_RATE = 6.4;          // how fast the bars reach the input
const KEY_RATE = 3.4;            // ...from a held arrow key, which has no travel
const SLIP = 4.6;                // how fast the hull stops sliding sideways
const LEAN_MAX = 0.62;           // rad of roll at full lock

const CAM_BACK = 11.6;
const CAM_UP = 5.4;
const CAM_LOOK = 20;
const CAM_FOLLOW = 6.5;          // how hard the camera chases position
const CAM_HEAVE = 2.4;           // ...and how lazily it follows the swell

// The grid: four rows of two, ahead of the line the way a real standing start
// is. The player is on the back row — the whole boost economy is built on
// riding someone's wake, and starting last is what teaches it in the first
// corner instead of the third lap.
const ROW_GAP = 7.5;
const GRID_LATERAL = 8.5;
const PLAYER_GRID = 7;           // 0-based: last

const BUOY_SPACING = 40;
const BUOY_R = 0.62;

// The near grid has to reach past the islands (they start at 320 m) or the
// seam where it meets the flat deep water reads as a line on the sea, and it
// has to stay finer than the shortest swell or the crests crawl. 8 m cells out
// to 320 m is both.
const WATER_CELLS = 80;
const WATER_SPAN = 640;
const FOG_COLOR = 0xc8e9f2;

const BEST_LAP_KEY = 'am.wake.bestlap';
const BEST_POS_KEY = 'am.wake.bestpos';

// The camera jolts are the one thing a vestibular-sensitive player must not
// get. Scaling them where they are read leaves every site that adds to them
// alone.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const JOLT = REDUCED ? 0 : 1;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
// deterministic scatter for scenery — an island that moves between reloads
// stops being a landmark, and landmarks are how you learn a circuit
let seed = 20260801;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const rrnd = (a, b) => a + rnd() * (b - a);

// ---------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------
const course = buildCourse(1024);
const LEN = course.length;
const LINE = racingLine(course);

// world point at (arc distance, lateral offset)
function coursePos(s, lat, out = { x: 0, z: 0, ang: 0 }) {
  const p = course.sample(s);
  out.x = p.x + Math.sin(p.ang) * lat;
  out.z = p.z - Math.cos(p.ang) * lat;
  out.ang = p.ang;
  return out;
}

// ---------------------------------------------------------------------------
// Renderer / scene / camera / lights
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(FOG_COLOR, 190, 980);

// Portrait is the point of this game, and a chase camera in a tall frame sees
// a keyhole: at 390×844 a 60° vertical FOV is barely 30° across. Widening the
// vertical angle in portrait buys back the horizontal view a racer needs to
// see a rival drawing alongside, and the extra sky and foreground it costs is
// exactly what a phone frame has spare.
const fovFor = (aspect) => (aspect < 1 ? 68 : 60);
const camera = new THREE.PerspectiveCamera(
  fovFor(window.innerWidth / window.innerHeight),
  window.innerWidth / window.innerHeight, 0.5, 3600
);

const hemi = new THREE.HemisphereLight(0xdcf2ff, 0x1d7f9c, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4dc, 1.85);
sun.position.set(-120, 160, 90);
scene.add(sun);

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

// Sky: a vertical gradient that meets the fog exactly at the horizon, so the
// far water dissolves into the sky rather than ending at a line.
{
  const skyTex = canvasTex(2, 512, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#1668c8');
    g.addColorStop(0.36, '#5eaeee');
    g.addColorStop(0.68, '#a9dcf5');
    g.addColorStop(1, '#c8e9f2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  scene.background = skyTex;
}

// Ripple/caustic texture — one tile is exactly one water cell, which is what
// lets the grid slide under the camera without the pattern swimming.
const rippleTex = canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  // low-contrast banding: at speed this reads as moving water, and at rest it
  // does not turn the lagoon into a chequerboard
  for (let i = 0; i < 150; i++) {
    const x = Math.random() * w, y = Math.random() * h;
    const r = 5 + Math.random() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + Math.random() * 0.06;
    g.addColorStop(0, `rgba(214,246,255,${a})`);
    g.addColorStop(1, 'rgba(214,246,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
}, true);

const sprayTex = canvasTex(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(233,250,255,0.66)');
  g.addColorStop(1, 'rgba(210,244,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});

const cloudTex = canvasTex(256, 128, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    const x = rrnd(30, w - 30), y = rrnd(h * 0.42, h * 0.86);
    const r = rrnd(16, 40);
    const g = ctx.createRadialGradient(x, y - r * 0.2, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
});

// The trackside banner. Text on a canvas is the one place in this project
// where a font matters, and the system stack is the only one available —
// which is fine, because at fifty metres it is a shape, not a word.
const bannerTex = canvasTex(128, 512, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#ff2e88');
  g.addColorStop(0.55, '#c81f9e');
  g.addColorStop(1, '#22b8e6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.font = '800 64px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('W A K E', 0, 4);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.fillRect(0, h - 10, w, 4);
});

const checkerTex = canvasTex(64, 16, (ctx, w, h) => {
  for (let x = 0; x < w; x += 8) {
    for (let y = 0; y < h; y += 8) {
      ctx.fillStyle = ((x + y) / 8) % 2 ? '#111820' : '#ffffff';
      ctx.fillRect(x, y, 8, 8);
    }
  }
}, true);

// ---------------------------------------------------------------------------
// Geometry merge helper — bakes coloured parts into one vertex-coloured
// geometry, so a whole ski and its rider cost a single draw call.
// ---------------------------------------------------------------------------
function mergeParts(parts) {
  const pos = [], nor = [], col = [], uv = [];
  const c = new THREE.Color();
  for (const p of parts) {
    const src = p.geo;
    if (p.matrix) src.applyMatrix4(p.matrix);
    const g = src.index ? src.toNonIndexed() : src;
    if (!g.attributes.normal) g.computeVertexNormals();
    const pa = g.attributes.position, na = g.attributes.normal, ua = g.attributes.uv;
    c.set(p.color);
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      nor.push(na.getX(i), na.getY(i), na.getZ(i));
      col.push(c.r, c.g, c.b);
      if (ua) uv.push(ua.getX(i), ua.getY(i)); else uv.push(0, 0);
    }
    g.dispose();
    if (g !== src) src.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}
const mat4 = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz)
  );
  return m;
};
const boxPart = (w, h, d, color, m) => ({ geo: new THREE.BoxGeometry(w, h, d), color, matrix: m });
function capsuleBetween(p1, p2, r, color) {
  const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
  const len = a.distanceTo(b);
  const geo = new THREE.CapsuleGeometry(r, len, 5, 10);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()
  );
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)
  );
  return { geo, color, matrix: m };
}
function prismGeo(w, h, d) {
  const hw = w / 2, hd = d / 2;
  const v = [
    -hw, 0, hd, hw, 0, hd, 0, h, hd,
    hw, 0, -hd, -hw, 0, -hd, 0, h, -hd,
    -hw, 0, hd, 0, h, hd, 0, h, -hd, -hw, 0, hd, 0, h, -hd, -hw, 0, -hd,
    hw, 0, hd, hw, 0, -hd, 0, h, -hd, hw, 0, hd, 0, h, -hd, 0, h, hd,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

const lambertVC = new THREE.MeshLambertMaterial({ vertexColors: true });
const basicVC = new THREE.MeshBasicMaterial({ vertexColors: true });

// ---------------------------------------------------------------------------
// The water
//
// One grid that follows the camera, snapped to whole cells so the swell does
// not swim under it, and one flat plane out to the horizon behind it. The
// heights and slopes come from rules.waveRow — the same water the skis ride.
// ---------------------------------------------------------------------------
const waterSeg = WATER_SPAN / WATER_CELLS;
const waterGeo = new THREE.PlaneGeometry(WATER_SPAN, WATER_SPAN, WATER_CELLS, WATER_CELLS);
waterGeo.rotateX(-Math.PI / 2);
{
  const n = waterGeo.attributes.position.count;
  waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
}
rippleTex.repeat.set(WATER_CELLS, WATER_CELLS);
const water = new THREE.Mesh(waterGeo, new THREE.MeshLambertMaterial({
  map: rippleTex, vertexColors: true,
}));
water.frustumCulled = false;
scene.add(water);

// Deep water to the horizon; the fog washes it into the sky. It has to sit
// below the deepest trough the near grid can reach — put it at mean water
// level and every trough in front of the camera is filled in by the plane
// behind it, which looks like the sea has holes in it.
const deep = new THREE.Mesh(
  new THREE.PlaneGeometry(7000, 7000),
  new THREE.MeshBasicMaterial({ color: 0x1687a8 })
);
deep.rotation.x = -Math.PI / 2;
deep.position.y = -(SWELL_MAX + 0.25);
scene.add(deep);

const rowY = new Float64Array(WATER_CELLS + 1);
const rowSx = new Float64Array(WATER_CELLS + 1);
const rowSz = new Float64Array(WATER_CELLS + 1);

const C_DEEP = [0.03, 0.40, 0.55];
const C_MID = [0.10, 0.70, 0.80];
const C_CREST = [0.62, 0.95, 0.97];
const C_SHOAL = [0.42, 0.92, 0.88];

function updateWater(t) {
  // snap to whole cells: the pattern then repeats exactly as the grid slides
  const ox = Math.round(camera.position.x / waterSeg) * waterSeg;
  const oz = Math.round(camera.position.z / waterSeg) * waterSeg;
  water.position.set(ox, 0, oz);

  const pos = waterGeo.attributes.position.array;
  const nor = waterGeo.attributes.normal.array;
  const col = waterGeo.attributes.color.array;
  const n = WATER_CELLS + 1;
  const x0 = ox - WATER_SPAN / 2;

  for (let iy = 0; iy < n; iy++) {
    const z = oz + iy * waterSeg - WATER_SPAN / 2;
    waveRow(x0, waterSeg, n, z, t, rowY, rowSx, rowSz);
    const base = iy * n;
    for (let ix = 0; ix < n; ix++) {
      const j = base + ix;
      const y = rowY[ix];
      pos[j * 3 + 1] = y;

      const nx = -rowSx[ix], nz = -rowSz[ix];
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nor[j * 3] = nx * inv; nor[j * 3 + 1] = inv; nor[j * 3 + 2] = nz * inv;

      // crest highlight, then a wash toward pale shallows near the shore
      const k = clamp((y + SWELL_MAX * 0.55) / (SWELL_MAX * 1.35), 0, 1);
      const a = k < 0.62 ? C_DEEP : C_MID;
      const b = k < 0.62 ? C_MID : C_CREST;
      const f = k < 0.62 ? k / 0.62 : (k - 0.62) / 0.38;
      const wx = x0 + ix * waterSeg;
      // a long, gentle wash into the shallows — a short one draws a visible
      // ring on the sea around the whole circuit
      const shoal = clamp((Math.hypot(wx, z) - 225) / 210, 0, 1) * 0.55;
      for (let c = 0; c < 3; c++) {
        col[j * 3 + c] = lerp(lerp(a[c], b[c], f), C_SHOAL[c], shoal);
      }
    }
  }
  waterGeo.attributes.position.needsUpdate = true;
  waterGeo.attributes.normal.needsUpdate = true;
  waterGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Scenery — everything outside the channel. Built once and never touched
// again: it is a fixed circuit, so there is nothing to stream.
// ---------------------------------------------------------------------------
const scenery = new THREE.Group();
scene.add(scenery);

function palm(x, y, z, sc, parts) {
  const h = 5.4 * sc;
  parts.push({
    geo: new THREE.CylinderGeometry(0.14 * sc, 0.26 * sc, h, 6),
    color: 0x8a6a44, matrix: mat4(x, y + h / 2, z, 0.06, 0, rrnd(-0.12, 0.12)),
  });
  const fronds = 6;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * TAU + rrnd(0, 1);
    parts.push({
      geo: new THREE.ConeGeometry(0.42 * sc, 3.1 * sc, 4),
      color: i % 2 ? 0x2f8f52 : 0x37a75f,
      matrix: mat4(
        x + Math.cos(a) * 1.1 * sc, y + h - 0.2 * sc, z + Math.sin(a) * 1.1 * sc,
        Math.cos(a) * 1.15, -a, Math.sin(a) * 1.15
      ),
    });
  }
}

// an island: a sand skirt, a rocky hump, and a few palms
function island(cx, cz, r, hgt, palms, parts) {
  parts.push({
    geo: new THREE.CylinderGeometry(r * 1.24, r * 1.5, 1.1, 14),
    color: 0xf2e2b8, matrix: mat4(cx, -0.1, cz),
  });
  parts.push({
    geo: new THREE.ConeGeometry(r, hgt, 9),
    color: 0x3f7d4a, matrix: mat4(cx, 0.3, cz, 0, rrnd(0, TAU), 0, 1, 1, rrnd(0.8, 1.25)),
  });
  parts.push({
    geo: new THREE.ConeGeometry(r * 0.62, hgt * 0.66, 8),
    color: 0x59915d, matrix: mat4(cx + r * 0.32, 0.3, cz - r * 0.2, 0, rrnd(0, TAU), 0),
  });
  for (let i = 0; i < palms; i++) {
    const a = rrnd(0, TAU), d = r * rrnd(0.85, 1.25);
    palm(cx + Math.cos(a) * d, 0.35, cz + Math.sin(a) * d, rrnd(0.8, 1.3), parts);
  }
}

{
  const parts = [];
  // a broken atoll ring, with two wide gaps so the horizon is not a wall
  for (let i = 0; i < 15; i++) {
    const a = (i / 15) * TAU + rrnd(-0.06, 0.06);
    if ((a > 1.1 && a < 1.9) || (a > 4.2 && a < 4.7)) continue;   // open water
    // wide and low: a tall narrow cone on the horizon reads as a fir tree,
    // not as land
    const d = rrnd(325, 410);
    island(Math.cos(a) * d, Math.sin(a) * d, rrnd(26, 52), rrnd(9, 21), 5, parts);
  }
  scenery.add(new THREE.Mesh(mergeParts(parts), lambertVC));
}

// The headland and its lighthouse: the one landmark you can navigate by, so
// it sits where the course's longest straight points at it.
{
  const parts = [];
  const ha = 0.62, hd = 330;
  const hx = Math.cos(ha) * hd, hz = Math.sin(ha) * hd;
  parts.push({ geo: new THREE.CylinderGeometry(46, 62, 26, 12), color: 0x6d7a5e, matrix: mat4(hx, 1, hz, 0, 0, 0, 1, 1, 0.8) });
  parts.push({ geo: new THREE.CylinderGeometry(30, 44, 14, 12), color: 0x4f7f4e, matrix: mat4(hx + 6, 22, hz - 4, 0, 0, 0, 1, 1, 0.8) });
  const ly = 28;
  parts.push({ geo: new THREE.CylinderGeometry(3.1, 4.2, 22, 14), color: 0xf7f7f2, matrix: mat4(hx, ly + 11, hz) });
  for (let i = 0; i < 3; i++) {
    parts.push({ geo: new THREE.CylinderGeometry(3.35, 3.7, 3.4, 14), color: 0xe23b3b, matrix: mat4(hx, ly + 4 + i * 7.4, hz) });
  }
  parts.push({ geo: new THREE.CylinderGeometry(4.3, 3.6, 1.4, 14), color: 0x30404e, matrix: mat4(hx, ly + 22.4, hz) });
  parts.push({ geo: new THREE.CylinderGeometry(2.5, 2.5, 3.2, 12), color: 0xfff0b0, matrix: mat4(hx, ly + 24.6, hz) });
  parts.push({ geo: new THREE.ConeGeometry(4.2, 3.4, 14), color: 0xe23b3b, matrix: mat4(hx, ly + 27.8, hz) });
  for (let i = 0; i < 7; i++) palm(hx + rrnd(-40, 40), 24, hz + rrnd(-30, 30), rrnd(0.9, 1.4), parts);
  scenery.add(new THREE.Mesh(mergeParts(parts), lambertVC));
}

// The town — pastel blocks stacked up a slope, the way the reference shot has
// a resort behind the far turn.
{
  const parts = [];
  const ta = 3.5, td = 350;
  const tx = Math.cos(ta) * td, tz = Math.sin(ta) * td;
  parts.push({ geo: new THREE.CylinderGeometry(74, 92, 12, 16), color: 0x8fa06a, matrix: mat4(tx, -1, tz, 0, 0, 0, 1.3, 1, 1) });
  const wall = [0xfdf1e0, 0xffe6d0, 0xf6dfd4, 0xfff5e6, 0xffdcc4];
  for (let i = 0; i < 34; i++) {
    const a = rrnd(0, TAU), d = rrnd(6, 78);
    const bx = tx + Math.cos(a) * d * 1.25, bz = tz + Math.sin(a) * d;
    const w = rrnd(6, 12), h = rrnd(6, 15), dd = rrnd(6, 11);
    const ry = rrnd(0, 0.7);
    parts.push(boxPart(w, h, dd, wall[i % wall.length], mat4(bx, 5 + h / 2, bz, 0, ry, 0)));
    parts.push({ geo: prismGeo(w * 1.06, 3.4, dd * 1.06), color: 0xc4553f, matrix: mat4(bx, 5 + h, bz, 0, ry, 0) });
  }
  for (let i = 0; i < 12; i++) palm(tx + rrnd(-88, 88), 5, tz + rrnd(-70, 70), rrnd(0.9, 1.5), parts);
  scenery.add(new THREE.Mesh(mergeParts(parts), lambertVC));
}

// Distant ridge: unlit, painterly, and outside the fog so it stays a backdrop
// rather than a place. Two bands, the far one hazier, which is the whole trick.
{
  const geo = new THREE.BufferGeometry();
  const v = [], c = [];
  const push = (x1, z1, x2, z2, x3, z3, y1, y2, y3, col) => {
    v.push(x1, y1, z1, x2, y2, z2, x3, y3, z3);
    for (let i = 0; i < 3; i++) c.push(col[0], col[1], col[2]);
  };
  // Three bands, each hazier and paler than the one in front of it — aerial
  // perspective is what makes a flat silhouette read as distance. Peaks get a
  // random width and an off-centre apex, because evenly spaced triangles of
  // the same size read as a picket fence rather than a ridge.
  for (const band of [
    { d: 1900, h: 215, col: [0.66, 0.75, 0.84], n: 26 },
    { d: 1560, h: 168, col: [0.52, 0.65, 0.76], n: 30 },
    { d: 1230, h: 118, col: [0.36, 0.54, 0.60], n: 28 },
  ]) {
    for (let i = 0; i < band.n; i++) {
      const a = (i / band.n) * TAU + rrnd(-0.07, 0.07);
      const w = rrnd(0.55, 1.7) * (TAU / band.n);
      const skew = rrnd(-0.45, 0.45) * w;
      const h = band.h * rrnd(0.38, 1.2);
      push(
        Math.cos(a - w) * band.d, Math.sin(a - w) * band.d,
        Math.cos(a + w) * band.d, Math.sin(a + w) * band.d,
        Math.cos(a + skew) * band.d, Math.sin(a + skew) * band.d,
        -20, -20, h, band.col
      );
    }
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  const ridge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, fog: false, side: THREE.DoubleSide,
  }));
  ridge.renderOrder = -1;
  scenery.add(ridge);
}

// Clouds
const clouds = [];
for (let i = 0; i < 12; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: cloudTex, transparent: true, depthWrite: false, opacity: rrnd(0.5, 0.85), fog: false,
  }));
  const a = rrnd(0, TAU), d = rrnd(500, 1500);
  sp.position.set(Math.cos(a) * d, rrnd(150, 330), Math.sin(a) * d);
  const s = rrnd(180, 420);
  sp.scale.set(s, s * 0.42, 1);
  scene.add(sp);
  clouds.push(sp);
}

// ---------------------------------------------------------------------------
// Course furniture — buoys, the start gantry, banners
// ---------------------------------------------------------------------------
const buoys = [];
{
  const geo = mergeParts([
    { geo: new THREE.SphereGeometry(BUOY_R, 12, 10), color: 0xffffff, matrix: mat4(0, 0, 0, 0, 0, 0, 1, 1.15, 1) },
    { geo: new THREE.CylinderGeometry(BUOY_R * 0.95, BUOY_R * 0.95, 0.26, 12), color: 0x21313f, matrix: mat4(0, 0.12, 0) },
    { geo: new THREE.ConeGeometry(BUOY_R * 0.62, 0.85, 10), color: 0xffffff, matrix: mat4(0, 0.78, 0) },
    { geo: new THREE.SphereGeometry(0.13, 8, 6), color: 0x21313f, matrix: mat4(0, 1.24, 0) },
  ]);
  const count = Math.floor(LEN / BUOY_SPACING);
  const mesh = new THREE.InstancedMesh(geo, lambertVC, count * 2);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const colL = new THREE.Color(0xffc23d), colR = new THREE.Color(0xff3d5e);
  const p = { x: 0, z: 0, ang: 0 };
  for (let i = 0; i < count; i++) {
    for (let side = 0; side < 2; side++) {
      const s = i * BUOY_SPACING;
      const lat = side ? TRACK_HALF : -TRACK_HALF;
      coursePos(s, lat, p);
      const idx = i * 2 + side;
      buoys.push({ x: p.x, z: p.z, s, lat, idx, bob: 0, hit: 0 });
      mesh.setColorAt(idx, side ? colR : colL);
    }
  }
  mesh.instanceColor.needsUpdate = true;
  buoys.mesh = mesh;
  buoys.count = count;
}

// pontoons, masts, banner and the checkered line at s = 0
{
  const parts = [];
  const p = { x: 0, z: 0, ang: 0 };
  coursePos(0, 0, p);
  const rx = Math.sin(p.ang), rz = -Math.cos(p.ang);      // course right
  const yaw = Math.PI / 2 - p.ang;
  for (const side of [-1, 1]) {
    const bx = p.x + rx * TRACK_HALF * side, bz = p.z + rz * TRACK_HALF * side;
    parts.push(boxPart(3.4, 1.1, 5.2, 0xf4f6f8, mat4(bx, 0.25, bz, 0, yaw, 0)));
    parts.push(boxPart(3.6, 0.3, 5.4, 0xff2e88, mat4(bx, 0.8, bz, 0, yaw, 0)));
    parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.24, 11, 8), color: 0xe8ecf0, matrix: mat4(bx, 6, bz) });
  }
  // the banner spans the channel overhead
  parts.push(boxPart(TRACK_HALF * 2, 0.5, 0.5, 0xe8ecf0, mat4(p.x, 11.2, p.z, 0, yaw, 0)));
  const gantry = new THREE.Mesh(mergeParts(parts), lambertVC);
  scene.add(gantry);

  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 4.4),
    new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.DoubleSide })
  );
  sign.position.set(p.x, 8.6, p.z);
  sign.rotation.y = yaw;
  scene.add(sign);

  // start/finish line painted on the water
  const stripeTex = checkerTex.clone();
  stripeTex.needsUpdate = true;
  stripeTex.repeat.set(18, 1);
  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(TRACK_HALF * 2, 2.6),
    new THREE.MeshBasicMaterial({ map: stripeTex, transparent: true, opacity: 0.85, depthWrite: false })
  );
  stripe.rotation.set(-Math.PI / 2, 0, -yaw);
  stripe.position.set(p.x, 0.12, p.z);
  stripe.renderOrder = 1;
  scene.add(stripe);
}

// feather flags on floats, at the start and at two corners
{
  const parts = [];
  const p = { x: 0, z: 0, ang: 0 };
  for (const [s, side] of [[6, -1], [12, 1], [LEN * 0.3, -1], [LEN * 0.55, 1], [LEN * 0.78, -1]]) {
    coursePos(s, (TRACK_HALF + 7) * side, p);
    parts.push({ geo: new THREE.CylinderGeometry(1.5, 1.8, 0.7, 10), color: 0xf4f6f8, matrix: mat4(p.x, 0.1, p.z) });
    parts.push({ geo: new THREE.CylinderGeometry(0.09, 0.12, 9, 6), color: 0xdfe6ec, matrix: mat4(p.x, 4.6, p.z) });
  }
  scene.add(new THREE.Mesh(mergeParts(parts), lambertVC));

  const flagGeo = new THREE.PlaneGeometry(2.6, 6.4);
  for (const [s, side] of [[6, -1], [12, 1], [LEN * 0.3, -1], [LEN * 0.55, 1], [LEN * 0.78, -1]]) {
    coursePos(s, (TRACK_HALF + 7) * side, p);
    const f = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({
      map: bannerTex, side: THREE.DoubleSide,
    }));
    f.position.set(p.x + 1.2, 5.6, p.z);
    f.rotation.y = Math.PI / 2 - p.ang;
    scene.add(f);
  }
}

// ---------------------------------------------------------------------------
// The skis
// ---------------------------------------------------------------------------
const skiGeoCache = new Map();

function makeSki(hue) {
  if (skiGeoCache.has(hue)) return new THREE.Mesh(skiGeoCache.get(hue), lambertVC);
  const body = new THREE.Color().setHSL(hue, 0.85, 0.55).getHex();
  const dark = new THREE.Color().setHSL(hue, 0.7, 0.22).getHex();
  const suit = new THREE.Color().setHSL(hue, 0.55, 0.32).getHex();
  // Hair is a pale wash of the racer's own colour rather than its complement:
  // a complement puts green hair on the magenta ski, which reads as a bug.
  const hair = new THREE.Color().setHSL(hue, 0.28, 0.82).getHex();
  const HULL = 0x12161f, SKIN = 0xf3c8a4;

  const parts = [
    // hull: a flattened capsule with a wedge nose
    { geo: new THREE.CapsuleGeometry(0.5, 1.5, 5, 14), color: HULL, matrix: mat4(0, 0.3, -0.1, Math.PI / 2, 0, 0, 1.06, 1, 0.6) },
    { geo: new THREE.ConeGeometry(0.5, 1.0, 12), color: HULL, matrix: mat4(0, 0.34, 1.18, Math.PI / 2, 0, 0, 1.06, 1, 0.6) },
    // livery: a bright flank the colour of the racer, which is what the
    // standings swatch is matched to
    { geo: new THREE.CapsuleGeometry(0.4, 1.4, 5, 12), color: body, matrix: mat4(0, 0.44, -0.05, Math.PI / 2, 0, 0, 1.12, 1, 0.42) },
    { geo: new THREE.ConeGeometry(0.4, 0.9, 10), color: body, matrix: mat4(0, 0.46, 1.12, Math.PI / 2, 0, 0, 1.12, 1, 0.42) },
    // seat and console
    { geo: new THREE.CapsuleGeometry(0.3, 0.8, 5, 10), color: dark, matrix: mat4(0, 0.66, -0.35, Math.PI / 2, 0, 0, 1, 1, 0.5) },
    boxPart(0.52, 0.36, 0.52, dark, mat4(0, 0.78, 0.55, -0.42, 0, 0)),
    boxPart(0.14, 0.34, 0.14, 0x2a3140, mat4(0, 0.96, 0.5)),
    { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.78, 8), color: 0x2a3140, matrix: mat4(0, 1.13, 0.44, 0, 0, Math.PI / 2) },
    { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.17, 8), color: 0x11151c, matrix: mat4(0.32, 1.13, 0.44, 0, 0, Math.PI / 2) },
    { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.17, 8), color: 0x11151c, matrix: mat4(-0.32, 1.13, 0.44, 0, 0, Math.PI / 2) },
    // sponsons and rear step
    boxPart(0.26, 0.16, 0.9, body, mat4(0.55, 0.16, -0.62, 0, 0, -0.3)),
    boxPart(0.26, 0.16, 0.9, body, mat4(-0.55, 0.16, -0.62, 0, 0, 0.3)),
    boxPart(0.86, 0.12, 0.5, dark, mat4(0, 0.34, -1.24)),
  ];

  // the rider: crouched forward over the bars, hands on the grips
  const hipY = 1.12, shoulder = [0, 1.5, 0.1];
  for (const s of [-1, 1]) {
    const foot = [s * 0.26, 0.52, -0.5];
    const knee = [s * 0.3, 0.86, -0.1];
    const hip = [s * 0.15, hipY, -0.24];
    parts.push(capsuleBetween(foot, knee, 0.1, suit));
    parts.push(capsuleBetween(knee, hip, 0.115, suit));
    parts.push({ geo: new THREE.SphereGeometry(0.13, 10, 8), color: 0x1b2230, matrix: mat4(foot[0], foot[1] - 0.03, foot[2], 0, 0, 0, 1.1, 0.7, 1.5) });
    const sh = [s * 0.2, shoulder[1] - 0.06, shoulder[2]];
    const elbow = [s * 0.3, 1.28, 0.3];
    const hand = [s * 0.32, 1.14, 0.44];
    parts.push(capsuleBetween(sh, elbow, 0.075, suit));
    parts.push(capsuleBetween(elbow, hand, 0.065, SKIN));
    parts.push({ geo: new THREE.SphereGeometry(0.08, 8, 6), color: 0x11151c, matrix: mat4(...hand) });
  }
  parts.push({ geo: new THREE.SphereGeometry(0.17, 12, 10), color: suit, matrix: mat4(0, hipY, -0.24, 0, 0, 0, 1.1, 0.8, 1) });
  parts.push(capsuleBetween([0, hipY, -0.24], shoulder, 0.21, suit));
  parts.push({ geo: new THREE.CylinderGeometry(0.215, 0.2, 0.14, 12), color: body, matrix: mat4(0, 1.36, -0.02, -0.32, 0, 0) });
  // A bright panel down the rider's back. From a chase camera you see almost
  // nothing else of them, and without it the torso is a featureless cylinder
  // in the same colour as the suit.
  parts.push(boxPart(0.2, 0.44, 0.1, body, mat4(0, 1.3, -0.28, -0.3, 0, 0)));
  // head, tipped up so the face looks down the course rather than at the deck
  parts.push({ geo: new THREE.SphereGeometry(0.19, 14, 12), color: SKIN, matrix: mat4(0, 1.72, 0.16) });
  parts.push({ geo: new THREE.SphereGeometry(0.195, 14, 12), color: hair, matrix: mat4(0, 1.75, 0.13, 0, 0, 0, 1.02, 1, 1.02) });
  // hair streaming back — the one piece of motion the model implies at rest.
  // Kept slim: at full size it swallowed the head and the shoulders with it.
  parts.push({ geo: new THREE.CapsuleGeometry(0.105, 0.42, 5, 10), color: hair, matrix: mat4(0, 1.72, -0.2, 1.3, 0, 0, 1.1, 1, 0.8) });

  const geo = mergeParts(parts);
  skiGeoCache.set(hue, geo);
  return new THREE.Mesh(geo, lambertVC);
}

// ---------------------------------------------------------------------------
// Wake ribbons — the game's namesake, and the only thing that shows a player
// where the draft is. Every racer gets one.
// ---------------------------------------------------------------------------
const WAKE_MAX = 44;
const WAKE_STEP = 1.4;           // metres between points

// Four vertices across, not two. A two-vertex ribbon is a quad with one alpha
// all the way across it, and eight of those overlapping turned the lagoon into
// drifting ice floes — hard-edged white slabs with visible polygon corners.
// Feathering the outer pair to zero makes the same geometry read as foam: a
// bright churned middle that dissolves into the water at its edges.
const WAKE_FEATHER = 0.42;       // where the opaque core ends, as a fraction of the half-width

function makeWake() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAKE_MAX * 4 * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(WAKE_MAX * 4 * 4), 4));
  const idx = [];
  for (let i = 0; i < WAKE_MAX - 1; i++) {
    const a = i * 4, b = a + 4;
    for (let k = 0; k < 3; k++) {
      idx.push(a + k, a + k + 1, b + k + 1, a + k, b + k + 1, b + k);
    }
  }
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    transparent: true, vertexColors: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return { geo, mesh, pts: [], lastX: 0, lastZ: 0, has: false };
}

function pushWake(w, x, z, dirX, dirZ, width, foam) {
  const px = -dirZ, pz = dirX;
  const hw = width / 2, cw = hw * WAKE_FEATHER;
  w.pts.push({
    x, z, px, pz, hw, cw, foam,
  });
  if (w.pts.length > WAKE_MAX) w.pts.shift();
}

function updateWakeMesh(w, t) {
  const pa = w.geo.attributes.position.array;
  const ca = w.geo.attributes.color.array;
  const n = w.pts.length;
  const OFF = [-1, -WAKE_FEATHER, WAKE_FEATHER, 1];
  for (let i = 0; i < n; i++) {
    const p = w.pts[i];
    const age = (n - 1 - i) / WAKE_MAX;
    const a = clamp(0.34 * (1 - age * 1.05), 0, 1) * p.foam;
    for (let k = 0; k < 4; k++) {
      const d = OFF[k] * p.hw;
      const x = p.x + p.px * d, z = p.z + p.pz * d;
      const o = (i * 4 + k) * 3;
      // the foam sits on the water, so its height is re-read every frame — a
      // ribbon pinned at the height it was laid down floats or sinks as the
      // swell rolls through it
      pa[o] = x; pa[o + 1] = waveHeight(x, z, t) + 0.07; pa[o + 2] = z;
      const co = (i * 4 + k) * 4;
      ca[co] = 0.93; ca[co + 1] = 0.99; ca[co + 2] = 1;
      ca[co + 3] = (k === 0 || k === 3) ? 0 : a;
    }
  }
  w.geo.attributes.position.needsUpdate = true;
  w.geo.attributes.color.needsUpdate = true;
  w.geo.setDrawRange(0, Math.max(0, (n - 1) * 18));
}

// ---------------------------------------------------------------------------
// Spray
// ---------------------------------------------------------------------------
const SPRAY_N = 460;
const sprayGeo = new THREE.BufferGeometry();
const sprayPos = new Float32Array(SPRAY_N * 3);
const sprayCol = new Float32Array(SPRAY_N * 4);
sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
sprayGeo.setAttribute('color', new THREE.BufferAttribute(sprayCol, 4));
const spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
  size: 0.85, map: sprayTex, transparent: true, depthWrite: false,
  vertexColors: true, sizeAttenuation: true,
}));
spray.frustumCulled = false;
scene.add(spray);
const sprayP = Array.from({ length: SPRAY_N }, () => ({ life: 0, max: 1, vx: 0, vy: 0, vz: 0 }));
let sprayCursor = 0;

function emitSpray(x, y, z, vx, vy, vz, life, col) {
  const i = sprayCursor;
  sprayCursor = (sprayCursor + 1) % SPRAY_N;
  const p = sprayP[i];
  p.life = life; p.max = life;
  p.vx = vx; p.vy = vy; p.vz = vz;
  sprayPos[i * 3] = x; sprayPos[i * 3 + 1] = y; sprayPos[i * 3 + 2] = z;
  sprayCol[i * 4] = col ? col[0] : 0.95;
  sprayCol[i * 4 + 1] = col ? col[1] : 0.99;
  sprayCol[i * 4 + 2] = col ? col[2] : 1;
  sprayCol[i * 4 + 3] = 0.85;
}

function updateSpray(dt) {
  for (let i = 0; i < SPRAY_N; i++) {
    const p = sprayP[i];
    if (p.life <= 0) { sprayCol[i * 4 + 3] = 0; continue; }
    p.life -= dt;
    p.vy -= 11 * dt;
    p.vx *= 1 - 1.9 * dt;
    p.vz *= 1 - 1.9 * dt;
    sprayPos[i * 3] += p.vx * dt;
    sprayPos[i * 3 + 1] += p.vy * dt;
    sprayPos[i * 3 + 2] += p.vz * dt;
    sprayCol[i * 4 + 3] = clamp((p.life / p.max) * 0.9, 0, 1);
  }
  sprayGeo.attributes.position.needsUpdate = true;
  sprayGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------
const SAND = [0.86, 0.78, 0.6];

function makeRacer(i, def, isPlayer) {
  const mesh = makeSki(def.hue);
  const tilt = new THREE.Group();
  tilt.add(mesh);
  const group = new THREE.Group();
  group.add(tilt);
  scene.add(group);
  const swatch = new THREE.Color().setHSL(def.hue, 0.85, 0.55);
  return {
    i, name: def.name, isPlayer,
    hue: def.hue, css: `#${swatch.getHexString()}`,
    pace: def.pace, lineSkill: def.line, lineBias: 0,
    group, tilt, wake: makeWake(),
    x: 0, z: 0, y: 0, heading: 0, v: 0, vy: 0, air: 0,
    steer: 0, steerIn: 0, slip: 0,
    s: 0, lap: 0, progress: 0, hint: 0, lateral: 0, off: false,
    boost: 0, boosting: false, draft: 0, aiBoostUntil: 0,
    lapStart: 0, bestLap: null, lastLap: null, finishedAt: null, place: i + 1,
    prevPlace: i + 1, hitCool: 0,
  };
}

const racers = [];
{
  // the player takes the accent's own hue so the ski, the HUD row and the app
  // icon are all one colour
  const playerDef = { name: PLAYER_NAME, pace: 1, line: 1, hue: PLAYER_HUE };
  const defs = [];
  for (let g = 0; g < GRID; g++) defs.push(g === PLAYER_GRID ? playerDef : null);
  let r = 0;
  for (let g = 0; g < GRID; g++) {
    if (defs[g] === null) defs[g] = RIVALS[r++];
  }
  for (let g = 0; g < GRID; g++) racers.push(makeRacer(g, defs[g], g === PLAYER_GRID));
}
const player = racers[PLAYER_GRID];

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = $('hud');
const elPos = $('posNum'), elPosOf = $('posOf'), elPosBlock = document.querySelector('.pos');
const elClock = $('clock'), elLapNum = $('lapNum'), elLapTotal = $('lapTotal');
const elBestLap = $('bestLap'), elBestBlock = document.querySelector('.best-lap');
const elStandings = $('standings');
const elSpeed = $('speedVal');
const elBoost = $('boostBtn');
const elCount = $('count');
const elToasts = $('toasts');
const startOverlay = $('start'), overOverlay = $('over');
const elOverLabel = $('overLabel'), elOverPos = $('overPos'), elOverTime = $('overTime');
const elOverLap = $('overLap'), elOverFlag = $('overFlag'), elOverList = $('overList');

elPosOf.textContent = String(GRID);
elLapTotal.textContent = String(LAPS);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let bestLapEver = Number(store.get(BEST_LAP_KEY)) || null;
let bestPosEver = Number(store.get(BEST_POS_KEY)) || null;

// one row per racer, built once and reordered by index — rebuilding eight
// nodes every frame is the kind of churn that shows up as jank on a phone
const rows = racers.map((r) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="rank"></span><span class="chip"></span><span class="who"></span>`;
  li.querySelector('.chip').style.background = r.css;
  li.querySelector('.who').textContent = r.name;
  if (r.isPlayer) li.classList.add('me');
  elStandings.appendChild(li);
  return li;
});

function toast(text, minor) {
  const el = document.createElement('div');
  el.className = minor ? 'toast minor' : 'toast';
  el.innerHTML = text;
  elToasts.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// --- the gauge: speed as an arc, boost as the arc inside it
const gauge = $('gauge');
const gctx = gauge.getContext('2d');
let gaugeSide = 104;
function sizeGauge() {
  gaugeSide = gauge.clientWidth || 104;
  const dpr = Math.min(window.devicePixelRatio, 2);
  gauge.width = gaugeSide * dpr;
  gauge.height = gaugeSide * dpr;
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawGauge(speed01, boost01, firing) {
  const S = gaugeSide, c = S / 2;
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
  gctx.clearRect(0, 0, S, S);
  const ring = (r, w, from, to, style) => {
    gctx.beginPath();
    gctx.arc(c, c, r, from, to);
    gctx.strokeStyle = style;
    gctx.lineWidth = w;
    gctx.lineCap = 'round';
    gctx.stroke();
  };
  ring(c - 7, 6, A0, A1, 'rgba(6,26,44,.45)');
  ring(c - 7, 6, A0, A0 + (A1 - A0) * clamp(speed01, 0, 1), firing ? '#ff2e88' : '#eaf7ff');
  ring(c - 16, 4, A0, A1, 'rgba(6,26,44,.4)');
  if (boost01 > 0) ring(c - 16, 4, A0, A0 + (A1 - A0) * clamp(boost01, 0, 1), '#ff2e88');
}

// --- the minimap
const map = $('map');
const mctx = map.getContext('2d');
let mapSide = 84;
const mapPts = [];
{
  // one point every sixteen samples is plenty at 84 px, and it means the whole
  // outline is a single path rather than a thousand line segments a frame
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < course.samples; i += 16) {
    mapPts.push([course.xs[i], course.zs[i]]);
    minX = Math.min(minX, course.xs[i]); maxX = Math.max(maxX, course.xs[i]);
    minZ = Math.min(minZ, course.zs[i]); maxZ = Math.max(maxZ, course.zs[i]);
  }
  mapPts.bounds = { minX, maxX, minZ, maxZ };
}
function sizeMap() {
  mapSide = map.clientWidth || 84;
  const dpr = Math.min(window.devicePixelRatio, 2);
  map.width = mapSide * dpr;
  map.height = mapSide * dpr;
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function mapProject(x, z) {
  const b = mapPts.bounds;
  const pad = 9;
  const sc = Math.min((mapSide - pad * 2) / (b.maxX - b.minX), (mapSide - pad * 2) / (b.maxZ - b.minZ));
  return [
    (x - (b.minX + b.maxX) / 2) * sc + mapSide / 2,
    (z - (b.minZ + b.maxZ) / 2) * sc + mapSide / 2,
  ];
}
function drawMap() {
  mctx.clearRect(0, 0, mapSide, mapSide);
  mctx.beginPath();
  for (let i = 0; i < mapPts.length; i++) {
    const [px, py] = mapProject(mapPts[i][0], mapPts[i][1]);
    if (i === 0) mctx.moveTo(px, py); else mctx.lineTo(px, py);
  }
  mctx.closePath();
  mctx.strokeStyle = 'rgba(6,26,44,.5)';
  mctx.lineWidth = 7;
  mctx.lineJoin = 'round';
  mctx.stroke();
  mctx.strokeStyle = 'rgba(255,255,255,.55)';
  mctx.lineWidth = 3.5;
  mctx.stroke();

  // the start/finish line
  const [sx, sy] = mapProject(course.xs[0], course.zs[0]);
  mctx.fillStyle = '#fff';
  mctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);

  for (const r of racers) {
    if (r.isPlayer) continue;
    const [px, py] = mapProject(r.x, r.z);
    mctx.beginPath(); mctx.arc(px, py, 2.6, 0, TAU);
    mctx.fillStyle = r.css; mctx.fill();
  }
  const [px, py] = mapProject(player.x, player.z);
  mctx.beginPath(); mctx.arc(px, py, 4.4, 0, TAU);
  mctx.fillStyle = '#fff'; mctx.fill();
  mctx.beginPath(); mctx.arc(px, py, 2.6, 0, TAU);
  mctx.fillStyle = '#ff2e88'; mctx.fill();
}

// ---------------------------------------------------------------------------
// Input
//
// Steering is a drag from wherever the finger landed, so there is no on-screen
// stick to hunt for and no dead zone at the edge of the screen. Boost is the
// one real button, because it is the one input that must not fire by accident
// while steering.
// ---------------------------------------------------------------------------
let steerPointer = null;
let steerOrigin = 0;
let dragSteer = 0;
let keySteer = 0;
let boostHeld = false;
let keyBoost = false;

function beginOrRestart() {
  if (state === 'ready' || state === 'finished') { startRace(); return true; }
  return false;
}

canvas.addEventListener('pointerdown', (e) => {
  if (beginOrRestart()) return;
  if (steerPointer !== null) return;
  steerPointer = e.pointerId;
  steerOrigin = e.clientX;
  dragSteer = 0;
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== steerPointer) return;
  dragSteer = clamp((e.clientX - steerOrigin) / DRAG_FULL, -1, 1);
});
function endSteer(e) {
  if (e.pointerId !== steerPointer) return;
  steerPointer = null;
  dragSteer = 0;
}
canvas.addEventListener('pointerup', endSteer);
canvas.addEventListener('pointercancel', endSteer);

// The overlays cover the canvas, so the "tap anywhere" that starts a race has
// to be caught on them too — a primary verb that only works on the button is
// the trap DESIGN.md calls out.
for (const el of [startOverlay, overOverlay]) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#install, .install-btn')) return;
    beginOrRestart();
  });
}

function setBoostHeld(on) {
  boostHeld = on;
  // Let go and the burst is over now, not at the top of the next frame.
  // `boosting` is what the button's own lit state and the FOV punch read, and
  // a frame of lag between releasing and looking released is visible.
  if (!on) player.boosting = false;
  // Every registered input answers back: a stab at a bar that cannot fire has
  // to look like a refusal, not like a dead button.
  if (on && state === 'racing' && player.boost < BOOST_ARM && !player.boosting) {
    elBoost.classList.remove('deny');
    void elBoost.offsetWidth;
    elBoost.classList.add('deny');
    navigator.vibrate?.(8);
  }
}
elBoost.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  setBoostHeld(true);
  elBoost.setPointerCapture?.(e.pointerId);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  elBoost.addEventListener(ev, () => setBoostHeld(false));
}
elBoost.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') { keySteer = -1; e.preventDefault(); }
  else if (k === 'arrowright' || k === 'd') { keySteer = 1; e.preventDefault(); }
  else if (k === ' ' || k === 'spacebar') {
    e.preventDefault();
    if (!beginOrRestart()) { keyBoost = true; setBoostHeld(true); }
  } else if (k === 'r') {
    if (state === 'racing' || state === 'countdown' || state === 'finished') startRace();
  }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if ((k === 'arrowleft' || k === 'a') && keySteer < 0) keySteer = 0;
  else if ((k === 'arrowright' || k === 'd') && keySteer > 0) keySteer = 0;
  else if (k === ' ' || k === 'spacebar') { keyBoost = false; setBoostHeld(false); }
});
// a key held while the tab goes away would otherwise still be held on return
window.addEventListener('blur', () => { keySteer = 0; keyBoost = false; boostHeld = false; });

// ---------------------------------------------------------------------------
// Race state
// ---------------------------------------------------------------------------
let state = 'ready';             // ready | countdown | racing | finished
let raceT = 0;                   // seconds since GO
let waterT = 0;                  // the swell's own clock, which never stops
let countdown = 0;
let shake = 0;
let attractA = 0;
let autopilot = false;           // headless tests drive the player with the AI
let finishDelay = 0;

function placeOnGrid() {
  for (let i = 0; i < racers.length; i++) {
    const r = racers[i];
    const row = Math.floor(i / 2), col = i % 2 ? 1 : -1;
    // front row furthest up the course, so grid slot 0 is pole
    const s = 30 - row * ROW_GAP;
    const lat = col * GRID_LATERAL;
    const p = coursePos(s, lat);
    r.x = p.x; r.z = p.z; r.heading = p.ang;
    r.v = 0; r.vy = 0; r.air = 0; r.y = waveHeight(r.x, r.z, waterT);
    r.steer = 0; r.steerIn = 0; r.slip = 0;
    r.s = s; r.lap = 0; r.progress = s; r.hint = course.index(s);
    r.lateral = lat; r.off = false;
    r.boost = 0; r.boosting = false; r.draft = 0; r.aiBoostUntil = 0;
    r.lapStart = 0; r.bestLap = null; r.lastLap = null; r.finishedAt = null;
    r.place = i + 1; r.prevPlace = i + 1; r.hitCool = 0;
    r.lineBias = r.isPlayer ? 0 : rand(-4, 4);
    r.wake.pts.length = 0;
    r.wake.has = false;
    r.group.position.set(r.x, r.y, r.z);
    r.group.rotation.y = Math.PI / 2 - r.heading;
    r.tilt.rotation.set(0, 0, 0);
  }
  for (const b of buoys) { b.bob = 0; b.hit = 0; }
  for (const p of sprayP) p.life = 0;
}

function startRace() {
  placeOnGrid();
  raceT = 0;
  countdown = 3.6;
  state = 'countdown';
  finishDelay = 0;
  shake = 0;
  elCount.hidden = false;
  hud.hidden = false;
  startOverlay.classList.add('hidden');
  overOverlay.classList.add('hidden');
  elBestLap.textContent = formatTime(bestLapEver);
  elBestBlock.classList.remove('fresh');
  updateHUD();
}

function endRace() {
  state = 'finished';
  const order = raceOrder(racers);
  const place = order.indexOf(player) + 1;

  elOverPos.textContent = ordinal(place - 1);
  elOverPos.classList.toggle('win', place === 1);
  elOverLabel.textContent = place === 1 ? 'you won' : 'finished';
  elOverTime.textContent = formatTime(player.finishedAt * 1000);
  elOverLap.textContent = formatTime(player.bestLap == null ? null : player.bestLap * 1000);

  const freshLap = player.bestLap != null &&
    (bestLapEver == null || player.bestLap * 1000 < bestLapEver);
  if (freshLap) {
    bestLapEver = Math.round(player.bestLap * 1000);
    store.set(BEST_LAP_KEY, String(bestLapEver));
  }
  elOverFlag.hidden = !freshLap;
  if (bestPosEver == null || place < bestPosEver) {
    bestPosEver = place;
    store.set(BEST_POS_KEY, String(place));
  }

  elOverList.innerHTML = '';
  const leader = order[0].finishedAt;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    const li = document.createElement('li');
    if (r.isPlayer) li.classList.add('me');
    const gap = r.finishedAt == null ? '—'
      : i === 0 ? formatTime(r.finishedAt * 1000)
        : `+${(r.finishedAt - leader).toFixed(2)}`;
    li.innerHTML = `<span class="rank">${i + 1}</span><span class="chip"></span>` +
      `<span class="who"></span><span class="gap"></span>`;
    li.querySelector('.chip').style.background = r.css;
    li.querySelector('.who').textContent = r.name;
    li.querySelector('.gap').textContent = gap;
    elOverList.appendChild(li);
  }

  hud.hidden = true;
  overOverlay.classList.remove('hidden');
  navigator.vibrate?.(place === 1 ? [18, 60, 18] : 14);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
const tmp = { x: 0, z: 0, ang: 0 };

// How much of a wake this racer is sitting in, and who is towing them.
function draftAmount(r) {
  let best = 0;
  for (const o of racers) {
    if (o === r) continue;
    const dx = r.x - o.x, dz = r.z - o.z;
    const cs = Math.cos(o.heading), sn = Math.sin(o.heading);
    const back = -(dx * cs + dz * sn);
    if (back <= 0 || back > DRAFT_LEN) continue;
    const side = dx * sn - dz * cs;
    const f = draftFactor(back, side);
    if (f > best) best = f;
  }
  return best;
}

function driveAI(r, dt) {
  const look = 13 + r.v * 0.55;
  const ahead = course.sample(r.s + look);
  const lat = LINE[course.index(r.s + look)] * r.lineSkill + r.lineBias;
  const tx = ahead.x + Math.sin(ahead.ang) * lat;
  const tz = ahead.z - Math.cos(ahead.ang) * lat;

  // steer at the point on their line, then bend away from anyone in the way
  let want = normAngle(Math.atan2(tz - r.z, tx - r.x) - r.heading);
  for (const o of racers) {
    if (o === r) continue;
    const dx = o.x - r.x, dz = o.z - r.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 220) continue;
    const cs = Math.cos(r.heading), sn = Math.sin(r.heading);
    const fwd = dx * cs + dz * sn;
    if (fwd < 0) continue;                                  // behind: not my problem
    const side = dx * sn - dz * cs;
    const urgency = (1 - Math.sqrt(d2) / 15) * 0.55;
    want -= Math.sign(side || (r.i % 2 ? 1 : -1)) * urgency;
  }
  // damped, not snapped: an AI that reaches full lock in one frame saws at the
  // bars, and eight of them doing it looks like a bug rather than a race
  r.steerIn = damp(r.steerIn, clamp(want * 2.3, -1, 1), 8, dt);

  // spend boost on the exits, where it is worth the most, and never in a
  // hairpin where it would just push them wide
  const curvAhead = Math.abs(course.curv[course.index(r.s + 40)]);
  if (raceT < r.aiBoostUntil) {
    if (r.boost <= 0) r.aiBoostUntil = 0;
  } else if (r.boost > 82 && curvAhead < 0.006) {
    r.aiBoostUntil = raceT + 3.2;
  }
  r.boosting = raceT < r.aiBoostUntil && r.boost > 0;
}

function stepRacer(r, dt) {
  const wasBoosting = r.boosting;

  if (r.isPlayer && !autopilot) {
    // A finger on the glass wins over a key: the drag has real travel and a
    // real zero, so it should not have to fight a key that is stuck down.
    const dragging = steerPointer !== null;
    r.steerIn = damp(r.steerIn, dragging ? dragSteer : keySteer,
      dragging ? STEER_RATE : KEY_RATE, dt);
    r.boosting = boostActive(r.boost, boostHeld, wasBoosting);
  } else {
    driveAI(r, dt);
  }
  r.steer = r.steerIn;

  // --- boost economy
  r.draft = draftAmount(r);
  r.boost = boostStep(r.boost, {
    holding: r.boosting, drafting: r.draft, airborne: r.air > 0,
  }, dt);
  if (r.boost <= 0) r.boosting = false;

  // --- speed
  const paceMul = r.isPlayer ? 1 : aiPace(r.pace, leaderProgress - r.progress);
  r.v = speedStep(r.v, {
    steer: Math.abs(r.steer), boosting: r.boosting, offTrack: r.off,
    drafting: r.draft, pace: paceMul,
  }, dt);

  // --- heading. In the air the hull has nothing to bite on, so steering
  // authority collapses — which is what makes a jump a commitment.
  const auth = r.air > 0 ? 0.25 : 1;
  r.heading += yawRate(r.v, r.steer) * auth * dt;

  // A jet ski does not go where it points; the tail steps out and catches up.
  // `slip` is that lag, and it is the whole reason the thing feels like it is
  // on water rather than rails.
  const slipTarget = -r.steer * clamp(r.v / V_MAX, 0, 1.3) * 0.34;
  r.slip = damp(r.slip, slipTarget, SLIP, dt);
  const dir = r.heading + r.slip;

  r.x += Math.cos(dir) * r.v * dt;
  r.z += Math.sin(dir) * r.v * dt;

  // --- where that leaves them on the course
  const near = course.nearest(r.x, r.z, r.hint);
  r.hint = near.i;
  r.lateral = near.lateral;
  const wasOff = r.off;
  r.off = Math.abs(near.lateral) > TRACK_HALF;
  if (r.isPlayer && r.off && !wasOff && state === 'racing') {
    toast('off course', true);
    navigator.vibrate?.(12);
  }

  const wasLap = r.lap;
  stepProgress(r, near.s, LEN);
  if (r.lap > wasLap && state === 'racing') onLap(r);
  else if (r.lap < wasLap) r.lapStart = raceT;   // spun back over the line

  // --- the water underneath
  const surf = waveHeight(r.x, r.z, waterT);
  if (r.air > 0) {
    r.vy -= GRAVITY * dt;
    r.y += r.vy * dt;
    r.air += dt;
    if (r.y <= surf) {
      r.y = surf; r.vy = 0;
      if (r.air > 0.25) landed(r);
      r.air = 0;
    }
  } else {
    const sl = waveSlope(r.x, r.z, waterT);
    const along = -(sl.dx * Math.cos(dir) + sl.dz * Math.sin(dir));
    const vy = launchSpeed(r.v, along);
    if (vy > 0) {
      r.vy = vy; r.air = 0.0001; r.y = surf;
    } else {
      // ride the surface, but let the hull plane over the short chop instead
      // of tracing every ripple
      r.y = damp(r.y, surf, 9, dt);
    }
  }

  // --- hitting things
  if (r.hitCool > 0) r.hitCool -= dt;
  hitBuoys(r);
}

function onLap(r) {
  const t = raceT - r.lapStart;
  r.lastLap = t;
  if (r.bestLap == null || t < r.bestLap) r.bestLap = t;
  r.lapStart = raceT;
  if (isFinished(r)) {
    r.finishedAt = raceT;
    if (r.isPlayer) finishDelay = 1.1;
  } else if (r.isPlayer) {
    const fresh = bestLapEver == null || t * 1000 < bestLapEver;
    toast(fresh ? `lap ${formatTime(t * 1000)} <span class="hot">best</span>`
      : `lap ${formatTime(t * 1000)}`, true);
    elLapNum.textContent = String(clamp(r.lap + 1, 1, LAPS));
    navigator.vibrate?.(10);
  }
}

function landed(r) {
  const n = r.isPlayer ? 14 : 5;
  for (let i = 0; i < n; i++) {
    emitSpray(
      r.x + rand(-0.7, 0.7), r.y + 0.2, r.z + rand(-0.7, 0.7),
      rand(-3, 3), rand(1.5, 5.5), rand(-3, 3), rand(0.4, 0.8)
    );
  }
  if (r.isPlayer) {
    shake += 0.22 * JOLT;
    navigator.vibrate?.(8);
  }
}

function hitBuoys(r) {
  if (r.hitCool > 0) return;
  if (Math.abs(r.lateral) < TRACK_HALF - 2.2 || Math.abs(r.lateral) > TRACK_HALF + 3) return;
  const i = Math.round(r.s / BUOY_SPACING);
  for (let k = i - 1; k <= i + 1; k++) {
    const idx = ((k % buoys.count) + buoys.count) % buoys.count;
    for (const side of [0, 1]) {
      const b = buoys[idx * 2 + side];
      const d = Math.hypot(r.x - b.x, r.z - b.z);
      if (d > BUOY_R + 0.85) continue;
      r.v *= HIT_LOSS;
      r.hitCool = 0.4;
      b.bob = 1;
      if (r.isPlayer) {
        shake += 0.4 * JOLT;
        navigator.vibrate?.(20);
        toast('buoy', true);
      }
      return;
    }
  }
}

function separate() {
  for (let i = 0; i < racers.length; i++) {
    for (let j = i + 1; j < racers.length; j++) {
      const a = racers[i], b = racers[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.4 || d < 1e-4) continue;
      const push = (2.4 - d) / 2;
      const nx = dx / d, nz = dz / d;
      a.x -= nx * push; a.z -= nz * push;
      b.x += nx * push; b.z += nz * push;
      // a nudge costs a little speed but never a race — bumping is racing,
      // and a hard penalty here would make the pack unplayable
      a.v *= 0.985; b.v *= 0.985;
      if ((a.isPlayer || b.isPlayer) && push > 0.2) {
        shake += 0.12 * JOLT;
      }
    }
  }
}

let leaderProgress = 0;

function updateStandings() {
  const order = raceOrder(racers);
  leaderProgress = order[0].progress;
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    r.prevPlace = r.place;
    r.place = i + 1;
  }
  if (player.place < player.prevPlace && state === 'racing') navigator.vibrate?.(6);
  return order;
}

function updateRacers(dt) {
  // a finisher keeps riding — their result is already written, but a lake that
  // empties out the moment someone crosses looks broken
  for (const r of racers) stepRacer(r, dt);
  separate();
}

// ---------------------------------------------------------------------------
// Visuals that follow the simulation
// ---------------------------------------------------------------------------
function updateSkis(dt) {
  for (const r of racers) {
    r.group.position.set(r.x, r.y + 0.06, r.z);
    r.group.rotation.y = Math.PI / 2 - r.heading;

    // roll into the turn, pitch up on the throttle and off a swell face
    const roll = -r.steer * LEAN_MAX * clamp(r.v / V_MAX, 0.25, 1);
    const pitch = r.air > 0 ? clamp(-r.vy * 0.05, -0.3, 0.28)
      : clamp((r.v / V_MAX) * 0.14 - r.slip * 0.2, -0.2, 0.24);
    r.tilt.rotation.z = damp(r.tilt.rotation.z, roll, 7, dt);
    r.tilt.rotation.x = damp(r.tilt.rotation.x, -pitch, 7, dt);

    // wake: laid down every WAKE_STEP metres so its density does not depend
    // on the frame rate
    const w = r.wake;
    const moved = w.has ? Math.hypot(r.x - w.lastX, r.z - w.lastZ) : Infinity;
    if (moved >= WAKE_STEP && r.air <= 0) {
      const cs = Math.cos(r.heading), sn = Math.sin(r.heading);
      const foam = clamp(r.v / V_MAX, 0, 1);
      pushWake(w, r.x - cs * 1.3, r.z - sn * 1.3, cs, sn, 1.6 + foam * 2.6, foam);
      w.lastX = r.x; w.lastZ = r.z; w.has = true;
    }
    updateWakeMesh(w, waterT);

    // rooster tail
    if (r.v > 6 && r.air <= 0) {
      const cs = Math.cos(r.heading), sn = Math.sin(r.heading);
      const rate = r.isPlayer ? 3 : 1;
      const col = r.off ? SAND : null;
      for (let i = 0; i < rate; i++) {
        if (Math.random() > clamp(r.v / V_MAX, 0.2, 1)) continue;
        emitSpray(
          r.x - cs * 1.5 + rand(-0.4, 0.4), r.y + 0.25, r.z - sn * 1.5 + rand(-0.4, 0.4),
          -cs * rand(1, 4) + rand(-1.5, 1.5), rand(2.5, 6.5) * (0.5 + r.v / V_MAX),
          -sn * rand(1, 4) + rand(-1.5, 1.5), rand(0.35, 0.75), col
        );
      }
      // the hard edge of a turn throws a sheet sideways
      if (Math.abs(r.steer) > 0.55 && Math.random() < 0.6) {
        const px = sn, pz = -cs;
        const s = Math.sign(r.steer);
        emitSpray(
          r.x + px * s * 0.8, r.y + 0.2, r.z + pz * s * 0.8,
          px * s * rand(2, 6), rand(1, 4), pz * s * rand(2, 6), rand(0.3, 0.6), col
        );
      }
    }
  }
}

const buoyM = new THREE.Matrix4();
const buoyQ = new THREE.Quaternion();
const buoyP = new THREE.Vector3();
const buoyS = new THREE.Vector3(1, 1, 1);
const buoyE = new THREE.Euler();
function updateBuoys(dt) {
  for (const b of buoys) {
    if (b.bob > 0) b.bob = Math.max(0, b.bob - dt * 1.6);
    const y = waveHeight(b.x, b.z, waterT);
    const sl = waveSlope(b.x, b.z, waterT);
    const wob = b.bob * Math.sin(waterT * 22) * 0.5;
    buoyE.set(-sl.dz * 1.6 + wob, 0, sl.dx * 1.6 + wob);
    buoyQ.setFromEuler(buoyE);
    buoyP.set(b.x, y - 0.15 + b.bob * 0.2, b.z);
    buoyM.compose(buoyP, buoyQ, buoyS);
    buoys.mesh.setMatrixAt(b.idx, buoyM);
  }
  buoys.mesh.instanceMatrix.needsUpdate = true;
}

const camLook = new THREE.Vector3();
let camY = 4;
function updateCamera(dt) {
  if (state === 'ready') {
    // Attract: a slow arc around the grid, so the start screen is the game.
    // The orbit has to be wide enough to hold all four rows and the gantry —
    // close in, it swung through empty water for half of every revolution.
    attractA += dt * 0.12;
    const p = coursePos(19, 0, tmp);
    const d = 56;
    camera.position.set(
      p.x + Math.cos(attractA) * d, 20 + Math.sin(attractA * 1.7) * 2.5, p.z + Math.sin(attractA) * d
    );
    // aim above the grid, not at it: the start panel owns the middle of the
    // screen, so the skis belong in the band underneath it
    camLook.set(p.x, 9, p.z);
    camera.lookAt(camLook);
    camera.fov = fovFor(camera.aspect);
    camera.updateProjectionMatrix();
    return;
  }

  const cs = Math.cos(player.heading), sn = Math.sin(player.heading);
  const back = CAM_BACK + player.v * 0.06;
  const tx = player.x - cs * back;
  const tz = player.z - sn * back;
  camera.position.x = damp(camera.position.x, tx, CAM_FOLLOW, dt);
  camera.position.z = damp(camera.position.z, tz, CAM_FOLLOW, dt);
  // vertical follow is deliberately lazy: tracking a 2 m swell one-for-one
  // turns a race into a rowing boat
  camY = damp(camY, player.y + CAM_UP + player.air * 2.2, CAM_HEAVE, dt);
  camera.position.y = camY;

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 1.8);
    const k = shake * shake;
    camera.position.x += rand(-1, 1) * k;
    camera.position.y += rand(-1, 1) * k;
    camera.position.z += rand(-1, 1) * k;
  }

  camLook.set(
    player.x + cs * CAM_LOOK - Math.sin(player.heading) * player.steer * 3.5,
    player.y + 1.9,
    player.z + sn * CAM_LOOK + Math.cos(player.heading) * player.steer * 3.5
  );
  camera.lookAt(camLook);

  // speed reads as field of view; the boost punch is the loudest thing here,
  // so it is scaled by JOLT along with the shake
  const want = fovFor(camera.aspect) + (player.v / V_BOOST) * 5 * JOLT +
    (player.boosting ? 6 * JOLT : 0);
  camera.fov = damp(camera.fov, want, 4, dt);
  camera.updateProjectionMatrix();
}

function updateClouds(dt) {
  for (const c of clouds) {
    c.position.x += dt * 1.6;
    if (c.position.x > 1600) c.position.x = -1600;
  }
}

// ---------------------------------------------------------------------------
// HUD refresh
// ---------------------------------------------------------------------------
let hudAcc = 0;
function updateHUD() {
  const order = raceOrder(racers);
  elPos.textContent = String(player.place);
  elPosBlock.classList.toggle('p1', player.place === 1);
  elClock.textContent = formatTime(raceT * 1000);
  elLapNum.textContent = String(clamp(player.lap + 1, 1, LAPS));

  const lapShown = player.bestLap != null ? player.bestLap * 1000 : bestLapEver;
  elBestLap.textContent = formatTime(lapShown);
  elBestBlock.classList.toggle('fresh',
    player.bestLap != null && (bestLapEver == null || player.bestLap * 1000 <= bestLapEver));

  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    const li = rows[r.i];
    li.style.order = String(i);
    li.querySelector('.rank').textContent = String(i + 1);
    li.classList.toggle('done', r.finishedAt != null);
  }

  elSpeed.textContent = String(Math.round(player.v * 3.6));
  drawGauge(player.v / V_BOOST, player.boost / BOOST_MAX, player.boosting);
  elBoost.classList.toggle('armed', player.boost >= BOOST_ARM && !player.boosting);
  elBoost.classList.toggle('firing', player.boosting);
  drawMap();
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------
function simulate(dt) {
  waterT += dt;

  if (state === 'countdown') {
    countdown -= dt;
    const n = Math.ceil(countdown - 0.6);
    if (countdown <= 0.6 && countdown > 0) {
      if (elCount.dataset.n !== 'go') {
        elCount.dataset.n = 'go';
        elCount.className = 'count go';
        elCount.innerHTML = '<span>GO</span>';
        navigator.vibrate?.(24);
      }
    } else if (n >= 1 && elCount.dataset.n !== String(n)) {
      elCount.dataset.n = String(n);
      elCount.className = 'count';
      elCount.innerHTML = `<span>${n}</span>`;
      navigator.vibrate?.(8);
    }
    if (countdown <= 0) {
      state = 'racing';
      raceT = 0;
      for (const r of racers) r.lapStart = 0;
      setTimeout(() => { elCount.innerHTML = ''; elCount.dataset.n = ''; }, 500);
    }
    // engines idle on the grid: no motion, but the swell still rolls under
    for (const r of racers) {
      r.y = damp(r.y, waveHeight(r.x, r.z, waterT), 8, dt);
      r.group.position.y = r.y + 0.06;
    }
  } else if (state === 'racing') {
    raceT += dt;
    updateStandings();
    updateRacers(dt);
    updateSkis(dt);
    if (finishDelay > 0) {
      finishDelay -= dt;
      if (finishDelay <= 0) endRace();
    }
  } else if (state === 'finished') {
    // the field keeps racing behind the results card
    updateStandings();
    updateRacers(dt);
    updateSkis(dt);
  }

  updateBuoys(dt);
  updateSpray(dt);
  updateCamera(dt);
  updateClouds(dt);

  if (state === 'racing' || state === 'countdown') {
    hudAcc += dt;
    if (hudAcc > 1 / 30) { hudAcc = 0; updateHUD(); }
  }
}

function draw() {
  updateWater(waterT);
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = fovFor(camera.aspect);
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sizeGauge();
  sizeMap();
});

let hidden = false;
document.addEventListener('visibilitychange', () => {
  hidden = document.hidden;
  if (!hidden) last = performance.now();
});

let last = performance.now();
let frozen = false;              // headless tests drive the simulation themselves
function tick(now) {
  requestAnimationFrame(tick);
  if (hidden) return;
  if (frozen || pause.active) { last = now; return; }
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.033);

  simulate(dt);
  draw();
}

// ---------------------------------------------------------------------------
// Test hook
//
// A race is three laps long and the interesting parts are the finish and the
// lap counter, neither of which a headless test can reach by waiting. This
// freezes the rAF loop so a test can step the whole simulation at a fixed dt —
// with the player on autopilot, a full race runs in well under a second.
// ---------------------------------------------------------------------------
window.__test = {
  player, racers, course,
  rules: { LAPS, GRID, TRACK_HALF, V_MAX, BOOST_MAX, BOOST_ARM },
  get state() { return state; },
  get raceT() { return raceT; },
  get standings() { return raceOrder(racers).map((r) => r.name); },
  get place() { return player.place; },
  waterAt: (x, z) => waveHeight(x, z, waterT),
  start: () => startRace(),
  freeze: (on = true) => { frozen = on; },
  autopilot: (on = true) => { autopilot = on; },
  // skip the lights: a test that wants to race should not spend 3.6 s of
  // simulated time watching a countdown
  go() { if (state === 'countdown') { countdown = 0.001; simulate(0.002); } },
  step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) simulate(dt); },
  paint() { updateHUD(); draw(); },
  // Drop the player somewhere specific — the lap line, the shallows, a rival's
  // wake — without driving there. Named `teleport` and not `place` because
  // `place` is already this object's "what position am I?" getter, and the
  // method silently shadowed it.
  teleport(s, lateral = 0, v = 20) {
    const p = coursePos(s, lateral);
    player.x = p.x; player.z = p.z; player.heading = p.ang; player.v = v;
    const near = course.nearest(player.x, player.z, -1);
    player.hint = near.i; player.lateral = near.lateral;
    player.s = near.s; player.progress = player.lap * LEN + near.s;
    player.y = waveHeight(player.x, player.z, waterT);
    player.group.position.set(player.x, player.y, player.z);
  },
  setBoost(v) { player.boost = clamp(v, 0, BOOST_MAX); },
  holdBoost(on = true) { setBoostHeld(on); },
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
sizeGauge();
sizeMap();
placeOnGrid();
updateCamera(0.016);     // before the water: the grid is placed under the camera
updateWater(0);
elBestLap.textContent = formatTime(bestLapEver);

const pause = installPause({
  canPause: () => state === 'racing' || state === 'countdown',
});
requestAnimationFrame(tick);

// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'racing' && state !== 'countdown' });
installPrompt();
