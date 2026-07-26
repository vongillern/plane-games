import * as THREE from './vendor/three.module.js';
import { installPause } from './pause.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';

// ---------------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

// Mountain coordinates: `s` is metres travelled down the fall line (s >= 0,
// increasing downhill). World z = -s; world y descends with GRADE.
const GRADE = 0.22;              // fall-line gradient (~12.5°)
const G = 26;                    // gravity (m/s²) — tuned for arcade arcs
const START_V = 17;              // downhill speed at the gate (m/s)
const MAX_V = 40;                // terminal speed
// How hard the mountain pulls. The old ramp had a ~17s time constant, so the
// first half of every run was spent waiting to get going; this reaches cruising
// speed in about six seconds and keeps a floor under it at the top end.
const PULL = 0.16;               // accel = (MAX_V - v) * PULL
const PULL_MIN = 0.9;            // ...never less than this (m/s²)
const STEER_MAX = 0.60;          // max |vx| as a fraction of v
const DRAG_FULL = 140;           // px of horizontal drag for full carve lock
const SPIN_PER_PX = 0.016;       // rad of air-spin per px of drag
const SPIN_KEY = 5.6;            // rad/s of air-spin from held arrow keys
const OLLIE_VY = 6.2;
const ALIGN_TOL = 0.96;          // rad (~55°) landing alignment tolerance

const PISTE_HALF = 13;           // rideable half-width
const FENCE_X = 13.8;            // safety netting
const SIDE_FAR = 52;             // off-piste ground extends this far

const CHUNK_LEN = 90;            // ground chunk length (m)
const CHUNKS = 5;                // one behind the camera + 360 m in front
const VIEW_AHEAD = 300;          // spawn horizon
const KILL_BEHIND = 18;

const CAM_BACK = 8.3;
const CAM_UP = 3.6;
const BASE_FOV = 60;

const BEST_KEY = 'am.carve.best';
const MUTE_KEY = 'am.carve.muted';

// The camera jolts — shake on a landing or a clip, the FOV punch off a kicker —
// are the one thing here a vestibular-sensitive player must not get. Scaling
// them where they are *read* leaves every site that adds to them alone.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const JOLT = REDUCED ? 0 : 1;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const randSign = () => (Math.random() < 0.5 ? -1 : 1);
const hash2 = (a, b) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
// smooth value noise + ridged fBm — the basis for organic mountain shapes
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), w = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), w);
}
function ridged(x, z) {
  let amp = 1, freq = 1, sum = 0, tot = 0;
  for (let o = 0; o < 4; o++) {
    const n = vnoise(x * freq + o * 13.7, z * freq + o * 7.3);
    const r = 1 - Math.abs(2 * n - 1);
    sum += r * amp; // linear ridging keeps crease lines sharp
    tot += amp;
    amp *= 0.5;
    freq *= 2.13;
  }
  return sum / tot;
}

let best = 0;
try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch {}

// ---------------------------------------------------------------------------
// Terrain — one analytic height field shared by physics and meshes
// ---------------------------------------------------------------------------
function reliefBowl(x) {
  const ax = Math.abs(x);
  if (ax <= 16) return x * x * 0.004;
  return 16 * 16 * 0.004 + (ax - 16) * 0.128; // C1 linear extension up the banks
}
function baseGround(x, s) {
  return -GRADE * s
    + 1.9 * Math.sin(s * 0.045 + 1.4 * Math.sin(s * 0.011))
    + 0.8 * Math.sin(s * 0.021 + x * 0.045 + 1.7)
    + reliefBowl(x);
}
function groundNormal(x, s, out) {
  const e = 0.6;
  const hx = (baseGround(x + e, s) - baseGround(x - e, s)) / (2 * e);
  const hs = (baseGround(x, s + e) - baseGround(x, s - e)) / (2 * e);
  out.set(-hx, 1, hs).normalize(); // +z points uphill (-s)
  return out;
}

// Kickers overlay the base terrain with a rigid ramp anchored at entry height.
const KICK_LEN = 3.0, KICK_HALF = 1.7, KICK_LIP = 1.15;
function groundYFull(x, s) {
  let y = baseGround(x, s);
  for (const k of kickers) {
    if (Math.abs(x - k.x) > KICK_HALF) continue;
    const t = (s - (k.s - KICK_LEN)) / KICK_LEN;
    if (t < 0 || t > 1) continue;
    const yr = baseGround(x, k.s - KICK_LEN) + KICK_LIP * t * t;
    if (yr > y) y = yr;
  }
  return y;
}
function onRampLipCross(prevS, newS, x) {
  for (const k of kickers) {
    if (Math.abs(x - k.x) <= KICK_HALF && prevS < k.s && newS >= k.s) return k;
  }
  return null;
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
const FOG_COLOR = 0xe3eefa;
scene.fog = new THREE.Fog(FOG_COLOR, 42, 295);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 1400);

// sun shines from up-left BEHIND the camera so the mountain faces the
// player looks at catch direct light instead of sitting in flat shade
const hemi = new THREE.HemisphereLight(0xcfe5ff, 0xcddcec, 1.35);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff0d6, 2.0);
sun.position.set(-60, 90, 55);
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

// sky — vertical gradient used as screen-space background
const skyTex = canvasTex(2, 512, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3f86d4');
  g.addColorStop(0.38, '#8fc0ef');
  g.addColorStop(0.66, '#d5e9fa');
  g.addColorStop(1, '#e3eefa'); // meets the fog exactly
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});
scene.background = skyTex;

// groomed corduroy — one tile covers 4 m × 4 m
const cordTex = canvasTex(512, 512, (ctx, w, h) => {
  ctx.fillStyle = '#e7f0fa';
  ctx.fillRect(0, 0, w, h);
  const stripes = 24, sw = w / stripes;
  for (let i = 0; i < stripes; i++) {
    for (let y = 0; y < h; y += 4) {
      const wob = Math.sin(y * 0.016 + i * 1.7) * 3.0;
      ctx.fillStyle = '#fafcff';
      ctx.fillRect(i * sw + wob, y, sw * 0.44, 4);
      ctx.fillStyle = '#d2e2f3';
      ctx.fillRect(i * sw + sw * 0.6 + wob, y, sw * 0.28, 4);
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  for (let i = 0; i < 46; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
}, true);

// off-piste powder — soft blotches, one tile covers 6 m × 6 m
const powderTex = canvasTex(256, 256, (ctx, w, h) => {
  ctx.fillStyle = '#e6eff9';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = rand(10, 34);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const c = Math.random() < 0.5 ? '247,251,255' : '214,229,244';
    g.addColorStop(0, `rgba(${c},.5)`);
    g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  for (let i = 0; i < 24; i++) ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
}, true);

// orange safety netting (alpha-tested)
const netTex = canvasTex(128, 64, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ff6d2e';
  for (let x = 0; x < w; x += 12) ctx.fillRect(x, 0, 3.4, h);
  for (let y = 2; y < h; y += 14) ctx.fillRect(0, y, w, 3);
}, true);

// soft round particle
const sprayTex = canvasTex(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});

// sun glow sprite
const sunTex = canvasTex(256, 256, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,250,225,.95)');
  g.addColorStop(0.25, 'rgba(255,246,210,.5)');
  g.addColorStop(1, 'rgba(255,246,210,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});

// puffy cumulus sprites — a few variants with domed tops and flat bases
function makeCloudTex(seed) {
  return canvasTex(256, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const blob = (x, y, r, a) => {
      const g = ctx.createRadialGradient(x, y - r * 0.15, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(0.72, `rgba(251,253,255,${a * 0.85})`);
      g.addColorStop(1, 'rgba(248,252,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    };
    const n = 5 + (seed % 3);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = 30 + t * 196 + Math.sin(seed * 5 + i * 3.1) * 12;
      const r = 26 + 26 * Math.sin(t * Math.PI) + (hash2(seed, i) - 0.5) * 10;
      blob(x, 96 - r * 0.55, r, 0.96);
    }
    // flat base
    const g = ctx.createLinearGradient(0, 78, 0, 112);
    g.addColorStop(0, 'rgba(255,255,255,.9)');
    g.addColorStop(1, 'rgba(244,250,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(128, 92, 100, 18, 0, 0, TAU); ctx.fill();
  });
}
const cloudTexes = [makeCloudTex(1), makeCloudTex(2), makeCloudTex(3)];

// ---------------------------------------------------------------------------
// Geometry merge helper — bakes colored parts into one vertex-colored geometry
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
const M4 = new THREE.Matrix4();
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
// a capsule limb stretched between two joints — the basis of the rider pose
function capsuleBetween(p1, p2, r, color) {
  const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
  const len = a.distanceTo(b);
  const geo = new THREE.CapsuleGeometry(r, len, 6, 12);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    b.clone().sub(a).normalize()
  );
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)
  );
  return { geo, color, matrix: m };
}

// triangular gable prism: width w (x), apex height h, depth d (z)
function prismGeo(w, h, d) {
  const hw = w / 2, hd = d / 2;
  const v = [
    -hw, 0, hd, hw, 0, hd, 0, h, hd,                                   // front
    hw, 0, -hd, -hw, 0, -hd, 0, h, -hd,                                // back
    -hw, 0, hd, 0, h, hd, 0, h, -hd, -hw, 0, hd, 0, h, -hd, -hw, 0, -hd, // left slope
    hw, 0, hd, hw, 0, -hd, 0, h, -hd, hw, 0, hd, 0, h, -hd, 0, h, hd,    // right slope
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Horizon — painterly peaks, treeline, valley village, sun, clouds
// ---------------------------------------------------------------------------
const horizon = new THREE.Group();
scene.add(horizon);

const ridgeMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });

// A real 3D mountain range: a smooth ridged-noise heightfield rising from
// the valley floor, with soft vertex normals lit by the scene sun. Snow and
// blue rock blend continuously by altitude and steepness, aerial haze grows
// with depth, and white ski runs are painted into the front faces.
{
  const COLS = 200, ROWS = 20;
  const X0 = -950, X1 = 950, Z0 = -330, Z1 = -880;
  const BASE_Y = -36.5;
  // tall massifs separated by lower passes, so the skyline has drama
  const peakMask = (x) => 0.45 + 0.95 * Math.pow(vnoise(x * 0.0011, 9.2), 1.4);
  const height = (x, z) => {
    const tz = clamp((z - Z0) / (Z1 - Z0), 0, 1);
    let p = clamp(tz / 0.45, 0, 1);
    p = p * p * (3 - 2 * p);
    const r = ridged(x * 0.0055, z * 0.0055);
    const r2 = ridged(x * 0.013 + 7, z * 0.013);
    return p * (16 + peakMask(x) * 260 * Math.pow(r, 1.2) + 26 * r2);
  };
  const runPath = (k, z) => [-260, 40, 320][k] + Math.sin(z * 0.012 + k * 2.1) * 30;

  const verts = (COLS + 1) * (ROWS + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const fogC = new THREE.Color(FOG_COLOR);
  // painterly palette: shadowed snow is BLUE, like the reference painting
  const snowLitC = new THREE.Color(0xffffff);
  const snowShadC = new THREE.Color(0x7ea6d8);
  const rockLitC = new THREE.Color(0x87a6cf);
  const rockShadC = new THREE.Color(0x3a5f96);
  // baking sun kept mostly LATERAL so each peak splits into a bright
  // left face and a blue right face — vertical light washes everything
  const SUNX = -0.72, SUNY = 0.52, SUNZ = 0.16;
  const cT = new THREE.Color(), cR = new THREE.Color();
  let vi = 0;
  for (let r = 0; r <= ROWS; r++) {
    const z = Z0 + ((Z1 - Z0) * r) / ROWS;
    const tz = r / ROWS;
    for (let c = 0; c <= COLS; c++) {
      const x = X0 + ((X1 - X0) * c) / COLS;
      const h = height(x, z);
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = BASE_Y + h;
      pos[vi * 3 + 2] = z;
      const e = 9;
      const sx = (height(x + e, z) - height(x - e, z)) / (2 * e);
      const sz = (height(x, z + e) - height(x, z - e)) / (2 * e);
      const slope = Math.hypot(sx, sz);
      // baked sun: surface normal · sun dir, with a punchy two-tone curve
      const inv = 1 / Math.hypot(sx, 1, sz);
      const d = clamp((-sx * SUNX + SUNY - sz * SUNZ) * inv, 0, 1);
      const light = clamp((d - 0.3) / 0.42, 0, 1);
      // snow blankets the tops and benches; rock breaks through steeps
      let snow = clamp(0.72 - slope * 0.5 + h / 340, 0, 1);
      snow = snow * snow * (3 - 2 * snow);
      // painted ski runs wind down the front faces
      if (tz < 0.6 && h > 22) {
        for (let k = 0; k < 3; k++) {
          if (Math.abs(x - runPath(k, z)) < 9) snow = 1;
        }
      }
      cR.copy(rockShadC).lerp(rockLitC, light);
      cT.copy(snowShadC).lerp(snowLitC, light);
      cR.lerp(cT, snow);
      const haze = clamp(0.06 + tz * 0.5, 0, 0.65);
      cR.lerp(fogC, haze);
      col[vi * 3] = cR.r; col[vi * 3 + 1] = cR.g; col[vi * 3 + 2] = cR.b;
      vi++;
    }
  }
  const idx = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const a = r * (COLS + 1) + c, b = a + 1, d = a + COLS + 1, e2 = d + 1;
      idx.push(a, b, d, b, e2, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  // unlit: the baked painterly shading IS the look — smooth, never grey
  const range = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  range.frustumCulled = false;
  horizon.add(range);
}

// snowy valley floor — fills the wedge between the fogged piste horizon
// and the mountain bases, so the village and forest sit on real ground
{
  const g = new THREE.PlaneGeometry(1400, 620, 1, 6);
  g.rotateX(-Math.PI / 2);
  const pa = g.attributes.position;
  const col = [];
  const near = new THREE.Color(FOG_COLOR);
  const far = new THREE.Color(0xcbdff2);
  const cT = new THREE.Color();
  for (let i = 0; i < pa.count; i++) {
    const t = clamp((-pa.getZ(i) + 310) / 620, 0, 1); // 0 at near edge
    cT.copy(near).lerp(far, t * t);
    col.push(cT.r, cT.g, cT.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // near edge tucks under the fogged piste horizon so no sky gap shows
  const m = new THREE.Mesh(g, ridgeMat);
  m.position.set(0, -36.5, -430);
  m.frustumCulled = false;
  horizon.add(m);
}

// dense conifer forest filling the valley floor, two overlapping bands
function forestBand(z, yBase, n, haze, c0, c1) {
  const pos = [], col = [];
  const fogC = new THREE.Color(FOG_COLOR);
  const cA = new THREE.Color(c0).lerp(fogC, haze);
  const cB = new THREE.Color(c1).lerp(fogC, haze);
  const cT = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = rand(-560, 560), w = rand(2.5, 5.5), h = rand(8, 18);
    const yb = yBase + rand(-2.5, 2.5), zj = rand(-6, 6);
    cT.copy(cA).lerp(cB, Math.random());
    pos.push(x - w, yb, zj, x + w, yb, zj, x, yb + h, zj);
    for (let k = 0; k < 3; k++) col.push(cT.r, cT.g, cT.b);
    // snowy tip on some trees
    if (Math.random() < 0.4) {
      const tw = w * 0.3, th = h * 0.28;
      pos.push(x - tw, yb + h - th, zj + 0.5, x + tw, yb + h - th, zj + 0.5, x, yb + h, zj + 0.5);
      const s = 0.85 + Math.random() * 0.15;
      for (let k = 0; k < 3; k++) col.push(s, s * 1.01, Math.min(1, s * 1.04));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, ridgeMat);
  m.position.set(0, 0, z);
  m.frustumCulled = false;
  horizon.add(m);
}
forestBand(-430, -36.4, 130, 0.5, 0x3a6553, 0x4e7a68);
forestBand(-368, -36.4, 170, 0.4, 0x35604e, 0x487462);
forestBand(-342, -36.4, 150, 0.26, 0x2c5445, 0x3d6854);
forestBand(-275, -36.4, 60, 0.5, 0x3a6553, 0x4e7a68); // sparse clumps break up the haze line

// tiny valley village vignette
{
  const parts = [];
  const hazeHex = (hex, t) => new THREE.Color(hex).lerp(new THREE.Color(FOG_COLOR), t).getHex();
  for (let i = 0; i < 11; i++) {
    const x = rand(-150, 110) + (i % 2 ? 40 : -40), z = rand(-16, 16);
    const w = rand(7, 11), d = rand(6, 9), h = rand(4, 5.6);
    const y = -36.2;
    parts.push(boxPart(w, h, d, hazeHex(0xe8dcc8, 0.38), mat4(x, y + h / 2, z)));
    parts.push({ geo: prismGeo(w * 1.14, h * 0.62, d * 1.14), color: hazeHex(0xa35633, 0.38), matrix: mat4(x, y + h, z) });
    parts.push({ geo: prismGeo(w * 1.18, h * 0.24, d * 1.18), color: hazeHex(0xffffff, 0.12), matrix: mat4(x, y + h * 1.36, z) });
    parts.push(boxPart(0.9, 0.9, 0.1, 0xffcf7a, mat4(x - w * 0.2, y + h * 0.5, z + d / 2 + 0.06)));
    parts.push(boxPart(0.9, 0.9, 0.1, 0xffcf7a, mat4(x + w * 0.25, y + h * 0.5, z + d / 2 + 0.06)));
  }
  const m = new THREE.Mesh(mergeParts(parts), ridgeMat);
  m.position.set(0, 0, -330);
  m.frustumCulled = false;
  horizon.add(m);
}

// sun + clouds
{
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false }));
  sunSprite.scale.set(190, 190, 1);
  sunSprite.position.set(-250, 170, -640);
  horizon.add(sunSprite);
}
const clouds = [];
for (let i = 0; i < 8; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: cloudTexes[i % 3], transparent: true, depthWrite: false, fog: false, opacity: rand(0.8, 1),
  }));
  const sc = rand(70, 170);
  sp.scale.set(sc, sc * 0.5, 1);
  sp.position.set(rand(-640, 640), rand(70, 200), rand(-680, -560));
  sp.userData.spd = rand(1.2, 3.2) * randSign();
  horizon.add(sp);
  clouds.push(sp);
}

// ---------------------------------------------------------------------------
// Ground chunks (piste + two off-piste shoulders per chunk)
// ---------------------------------------------------------------------------
const pisteMat = new THREE.MeshLambertMaterial({ map: cordTex, vertexColors: true });
const sideMat = new THREE.MeshLambertMaterial({ map: powderTex, vertexColors: true });

function makeGridMesh(x0, x1, cols, rows, mat) {
  const g = new THREE.BufferGeometry();
  const verts = (cols + 1) * (rows + 1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(verts * 2), 2));
  const idx = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, mat);
  mesh.userData = { x0, x1, cols, rows };
  scene.add(mesh);
  return mesh;
}

const N_TMP = new THREE.Vector3();
function fillGridMesh(mesh, s0, uvScale) {
  const { x0, x1, cols, rows } = mesh.userData;
  const g = mesh.geometry;
  const pa = g.attributes.position.array;
  const na = g.attributes.normal.array;
  const ca = g.attributes.color.array;
  const ua = g.attributes.uv.array;
  let i3 = 0, i2 = 0;
  for (let r = 0; r <= rows; r++) {
    const s = s0 + (r * CHUNK_LEN) / rows;
    for (let c = 0; c <= cols; c++) {
      const x = x0 + ((x1 - x0) * c) / cols;
      pa[i3] = x;
      pa[i3 + 1] = baseGround(x, s);
      pa[i3 + 2] = -(s - s0);
      groundNormal(x, s, N_TMP);
      na[i3] = N_TMP.x; na[i3 + 1] = N_TMP.y; na[i3 + 2] = N_TMP.z;
      const j = 0.965 + 0.035 * hash2(Math.round(x * 2.7), Math.round(s * 2.3));
      // slopes facing away from the sun read cool blue, not grey
      const sunDot = N_TMP.x * -0.48 + N_TMP.y * 0.72 + N_TMP.z * 0.48;
      const cool = clamp(0.8 - sunDot, 0, 1) * 0.6;
      ca[i3] = j * (1 - cool * 0.10);
      ca[i3 + 1] = j * (1 - cool * 0.045);
      ca[i3 + 2] = Math.min(1, j * 1.01);
      ua[i2] = x / uvScale;
      ua[i2 + 1] = s / uvScale;
      i3 += 3; i2 += 2;
    }
  }
  g.attributes.position.needsUpdate = true;
  g.attributes.normal.needsUpdate = true;
  g.attributes.color.needsUpdate = true;
  g.attributes.uv.needsUpdate = true;
  g.computeBoundingSphere();
  mesh.position.set(0, 0, -s0);
}

const chunks = [];
for (let i = 0; i < CHUNKS; i++) {
  chunks.push({
    piste: makeGridMesh(-14.4, 14.4, 24, 60, pisteMat),
    left: makeGridMesh(-SIDE_FAR, -14.4, 19, 45, sideMat),
    right: makeGridMesh(14.4, SIDE_FAR, 19, 45, sideMat),
    s0: -1,
  });
}
function assignChunk(chunk, s0) {
  fillGridMesh(chunk.piste, s0, 4);
  fillGridMesh(chunk.left, s0, 6);
  fillGridMesh(chunk.right, s0, 6);
  chunk.s0 = s0;
}

// ---------------------------------------------------------------------------
// Instanced scenery
// ---------------------------------------------------------------------------
const HIDE_M = mat4(0, -500, 0, 0, 0, 0, 0.0001, 0.0001, 0.0001);

function makeInstanced(geo, mat, count) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < count; i++) m.setMatrixAt(i, HIDE_M);
  m.instanceMatrix.needsUpdate = true;
  m.frustumCulled = false;
  scene.add(m);
  return m;
}
const lambertVC = new THREE.MeshLambertMaterial({ vertexColors: true });

// trees: snow mound, trunk, five frond tiers each draped with snow
const treeParts = [
  { geo: new THREE.ConeGeometry(1.75, 0.55, 16), color: 0xe9f0f8, matrix: mat4(0, 0.24, 0) },
  { geo: new THREE.CylinderGeometry(0.13, 0.21, 1.15, 10), color: 0x5d4030, matrix: mat4(0, 0.58, 0) },
];
{
  const tiers = [
    [1.18, 1.58, 0x2b5c44], [1.82, 1.34, 0x316049],
    [2.44, 1.08, 0x366752], [3.02, 0.82, 0x3b6e57], [3.55, 0.56, 0x40755c],
  ];
  for (const [i, [y, r, c]] of tiers.entries()) {
    treeParts.push({ geo: new THREE.ConeGeometry(r, 1.3, 14), color: c, matrix: mat4(0, y, 0, 0, i * 0.35, 0) });
    treeParts.push({ geo: new THREE.ConeGeometry(r * 0.8, 0.48, 14), color: 0xf7fbff, matrix: mat4(0, y + 0.52, 0, 0, i * 0.35 + 0.17, 0) });
  }
  treeParts.push({ geo: new THREE.ConeGeometry(0.3, 0.5, 12), color: 0xffffff, matrix: mat4(0, 4.05, 0) });
}
const treeGeo = mergeParts(treeParts);
const trees = makeInstanced(treeGeo, lambertVC, 150);

// rocks: smooth lumpy boulder + snow cap + drift mound
function boulderGeo(r, seed) {
  const g = new THREE.SphereGeometry(r, 14, 11);
  const pa = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) {
    v.fromBufferAttribute(pa, i).normalize();
    // displacement keyed to direction so the sphere's seam verts stay welded
    const n = 1 + (vnoise(v.x * 2.4 + seed, v.y * 1.9 + v.z * 2.2) - 0.5) * 0.5;
    pa.setXYZ(i, v.x * r * n, v.y * r * n, v.z * r * n);
  }
  g.computeVertexNormals();
  return g;
}
const rockGeo = mergeParts([
  { geo: new THREE.ConeGeometry(1.35, 0.38, 14), color: 0xe9f0f8, matrix: mat4(0, 0.16, 0) },
  { geo: boulderGeo(0.8, 3.1), color: 0x8fa0b4, matrix: mat4(0, 0.42, 0, 0.3, 0.5, 0, 1, 0.72, 1) },
  { geo: boulderGeo(0.55, 7.7), color: 0xf4f9fe, matrix: mat4(0.04, 0.78, 0.02, 0.2, 0.9, 0, 1, 0.55, 1) },
]);
const rocks = makeInstanced(rockGeo, lambertVC, 56);

// fence: pole + netting panel; one segment covers 4 m of slope
const FENCE_SEG = 4;
const poleGeo = mergeParts([
  { geo: new THREE.BoxGeometry(0.08, 1.15, 0.08), color: 0x51617a, matrix: mat4(0, 0.55, 0) },
]);
const fencePoles = makeInstanced(poleGeo, lambertVC, 200);
const netGeo = new THREE.PlaneGeometry(FENCE_SEG, 0.8);
netGeo.rotateY(Math.PI / 2);
netGeo.translate(0, 0.62, -FENCE_SEG / 2);
const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
const fenceNets = makeInstanced(netGeo, netMat, 200);

// chalets (lit) + glowing windows (unlit) sharing instance transforms.
// Honey-wood walls, deep roof overhangs stacked with snow, a drift skirt.
const chaletGeo = mergeParts([
  { geo: new THREE.ConeGeometry(3.3, 0.5, 18), color: 0xe9f0f8, matrix: mat4(0, 0.2, 0) },
  boxPart(3.6, 2.3, 3.0, 0xb08152, mat4(0, 1.15, 0)),
  { geo: prismGeo(3.6, 1.35, 3.0), color: 0xa87a4d, matrix: mat4(0, 2.3, 0) },
  boxPart(3.62, 0.1, 3.02, 0x8a6440, mat4(0, 1.72, 0)),                     // log seam
  boxPart(2.35, 0.15, 3.7, 0x6e4a30, mat4(-1.02, 2.82, 0, 0, 0, 0.63)),
  boxPart(2.35, 0.15, 3.7, 0x6e4a30, mat4(1.02, 2.82, 0, 0, 0, -0.63)),
  boxPart(2.3, 0.28, 3.8, 0xf7fbff, mat4(-1.06, 2.98, 0, 0, 0, 0.63)),
  boxPart(2.3, 0.28, 3.8, 0xf7fbff, mat4(1.06, 2.98, 0, 0, 0, -0.63)),
  boxPart(0.42, 1.0, 0.42, 0x9a9ba3, mat4(0.9, 3.3, -0.7)),
  boxPart(0.52, 0.18, 0.52, 0xffffff, mat4(0.9, 3.86, -0.7)),
  boxPart(0.7, 1.25, 0.08, 0x54381f, mat4(-0.8, 0.63, 1.53)),
  boxPart(1.0, 0.1, 0.3, 0xf7fbff, mat4(-0.8, 1.32, 1.56)),                 // snow lip over door
  boxPart(3.7, 0.5, 3.1, 0x6f4f38, mat4(0, 0.25, 0)),
]);
const chalets = makeInstanced(chaletGeo, lambertVC, 16);
const windowGeo = mergeParts([
  boxPart(0.55, 0.6, 0.06, 0xffc463, mat4(0.55, 1.5, 1.52)),
  boxPart(0.55, 0.6, 0.06, 0xffc463, mat4(1.82, 1.4, 0, 0, Math.PI / 2, 0)),
  boxPart(0.45, 0.5, 0.06, 0xffd88a, mat4(0, 2.75, 1.51)),
]);
const chaletWindows = makeInstanced(windowGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), 16);

// kickers: snow wedge with curved face + orange lip flags
function kickerGeo() {
  const parts = [];
  const stepN = 12;
  for (let i = 0; i < stepN; i++) {
    const t0 = i / stepN, t1 = (i + 1) / stepN;
    const z0 = KICK_LEN / 2 - t0 * KICK_LEN, z1 = KICK_LEN / 2 - t1 * KICK_LEN;
    const h0 = KICK_LIP * t0 * t0, h1 = KICK_LIP * t1 * t1;
    const zm = (z0 + z1) / 2, hm = (h0 + h1) / 2;
    const ang = Math.atan2(h1 - h0, z0 - z1);
    const len = Math.hypot(z0 - z1, h1 - h0);
    parts.push(boxPart(KICK_HALF * 2, 0.22, len + 0.05, i % 2 ? 0xf4f9fe : 0xeff6fc,
      mat4(0, hm - 0.05, zm, ang, 0, 0)));
  }
  parts.push(boxPart(0.18, KICK_LIP * 0.94, KICK_LEN * 0.62, 0xdfeaf5, mat4(-KICK_HALF + 0.09, KICK_LIP * 0.4, -KICK_LEN * 0.16, -0.35, 0, 0)));
  parts.push(boxPart(0.18, KICK_LIP * 0.94, KICK_LEN * 0.62, 0xdfeaf5, mat4(KICK_HALF - 0.09, KICK_LIP * 0.4, -KICK_LEN * 0.16, -0.35, 0, 0)));
  parts.push(boxPart(KICK_HALF * 2, KICK_LIP, 0.16, 0xd7e4f2, mat4(0, KICK_LIP / 2 - 0.06, -KICK_LEN / 2 + 0.02)));
  for (const sx of [-1, 1]) {
    parts.push(boxPart(0.06, 1.15, 0.06, 0x51617a, mat4(sx * (KICK_HALF - 0.05), KICK_LIP + 0.5, -KICK_LEN / 2 + 0.1)));
    parts.push(boxPart(0.34, 0.26, 0.04, 0xff6d2e, mat4(sx * (KICK_HALF - 0.05) + (sx > 0 ? -0.2 : 0.2), KICK_LIP + 0.92, -KICK_LEN / 2 + 0.1)));
  }
  return mergeParts(parts);
}
const kickersMesh = makeInstanced(kickerGeo(), lambertVC, 10);

// ---------------------------------------------------------------------------
// Pools / active lists
// ---------------------------------------------------------------------------
function makePool(mesh, n, linked) {
  return { mesh, linked, free: Array.from({ length: n }, (_, i) => n - 1 - i), active: [] };
}
const poolTrees = makePool(trees, 150);
const poolRocks = makePool(rocks, 56);
const poolPoles = makePool(fencePoles, 200);
const poolNets = makePool(fenceNets, 200);
const poolChalets = makePool(chalets, 16, chaletWindows);
const poolKickers = makePool(kickersMesh, 10);

const obstacles = [];   // { x, s, r, h, passed, pool, i }
const kickers = [];     // { x, s }

const Q_TMP = new THREE.Quaternion();
const E_TMP = new THREE.Euler();
const V_TMP = new THREE.Vector3();
const S_TMP = new THREE.Vector3();

// track=false leaves lifecycle to the caller (used for piste obstacles)
function place(pool, x, y, s, yaw, pitch, sc, track = true) {
  if (!pool.free.length) return -1;
  const i = pool.free.pop();
  E_TMP.set(pitch, yaw, 0);
  Q_TMP.setFromEuler(E_TMP);
  V_TMP.set(x, y, -s);
  S_TMP.set(sc, sc, sc);
  M4.compose(V_TMP, Q_TMP, S_TMP);
  pool.mesh.setMatrixAt(i, M4);
  pool.mesh.instanceMatrix.needsUpdate = true;
  if (pool.linked) {
    pool.linked.setMatrixAt(i, M4);
    pool.linked.instanceMatrix.needsUpdate = true;
  }
  if (track) pool.active.push({ i, s });
  return i;
}
function recyclePool(pool, minS) {
  let dirty = false;
  for (let k = pool.active.length - 1; k >= 0; k--) {
    if (pool.active[k].s < minS) {
      const it = pool.active[k];
      pool.mesh.setMatrixAt(it.i, HIDE_M);
      if (pool.linked) pool.linked.setMatrixAt(it.i, HIDE_M);
      pool.free.push(it.i);
      pool.active[k] = pool.active[pool.active.length - 1];
      pool.active.pop();
      dirty = true;
    }
  }
  if (dirty) {
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.linked) pool.linked.instanceMatrix.needsUpdate = true;
  }
}
function removeObstacle(k) {
  const o = obstacles[k];
  o.pool.mesh.setMatrixAt(o.i, HIDE_M);
  o.pool.mesh.instanceMatrix.needsUpdate = true;
  o.pool.free.push(o.i);
  obstacles[k] = obstacles[obstacles.length - 1];
  obstacles.pop();
}

// ---------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------
// world generation starts one chunk uphill so the camera (which rides
// behind the player) never looks into ungenerated void at the gate
let genS = -CHUNK_LEN;
let nextObstacleS = 0;
let nextKickerS = 0;
let nextChaletS = 0;
let corridorX = 0;

function difficulty(s) { return clamp(s / 2600, 0, 1); }

function spawnFenceRow(s) {
  for (const sx of [-1, 1]) {
    const x = FENCE_X * sx;
    const y0 = baseGround(x, s), y1 = baseGround(x, s + FENCE_SEG);
    const pitch = Math.atan2(y1 - y0, FENCE_SEG);
    place(poolPoles, x, y0 - 0.06, s, 0, 0, 1);
    place(poolNets, x, y0 - 0.02, s, 0, pitch, 1);
  }
}

function spawnDecorTree(x, s, sc) {
  place(poolTrees, x, baseGround(x, s) - 0.12, s, rand(0, TAU), 0, sc);
}
function spawnObstacleTree(x, s, sc) {
  const i = place(poolTrees, x, baseGround(x, s) - 0.12, s, rand(0, TAU), 0, sc, false);
  if (i >= 0) obstacles.push({ x, s, r: 0.62 * sc + 0.28, h: 99, passed: false, pool: poolTrees, i });
}
function spawnObstacleRock(x, s, sc) {
  const i = place(poolRocks, x, baseGround(x, s) - 0.1, s, rand(0, TAU), 0, sc, false);
  if (i >= 0) obstacles.push({ x, s, r: 0.72 * sc + 0.2, h: 0.95 * sc, passed: false, pool: poolRocks, i });
}

function clearOfKickers(s) {
  for (const k of kickers) {
    if (s > k.s - 10 && s < k.s + 30) return false;
  }
  return true;
}

function spawnObstacleRow(s) {
  corridorX = clamp(corridorX + rand(-2.4, 2.4), -8.5, 8.5);
  if (!clearOfKickers(s)) return;
  const d = difficulty(s);
  const n = Math.random() < 0.72 ? (1 + (Math.random() < d * 0.85 ? 1 : 0) + (Math.random() < d * 0.4 ? 1 : 0)) : 0;
  const placed = [];
  for (let i = 0; i < n; i++) {
    let x = 0, ok = false;
    for (let tries = 0; tries < 8 && !ok; tries++) {
      x = rand(-PISTE_HALF + 0.8, PISTE_HALF - 0.8);
      ok = Math.abs(x - corridorX) > 2.6 && placed.every((p) => Math.abs(p - x) > 2.6);
    }
    if (!ok) continue;
    placed.push(x);
    if (Math.random() < 0.62) spawnObstacleTree(x, s + rand(-2, 2), rand(0.8, 1.15));
    else spawnObstacleRock(x, s + rand(-2, 2), rand(0.8, 1.25));
  }
}

function spawnKicker(s) {
  const x = clamp(corridorX + rand(-2, 2), -8.5, 8.5);
  const yEntry = baseGround(x, s - KICK_LEN), yLip = baseGround(x, s);
  const pitch = Math.atan2(yLip - yEntry, KICK_LEN);
  const i = place(poolKickers, x, (yEntry + yLip) / 2 - 0.04, s - KICK_LEN / 2, 0, pitch, 1);
  if (i < 0) return;
  kickers.push({ x, s });
  // keep the approach and landing honest
  for (let k = obstacles.length - 1; k >= 0; k--) {
    const o = obstacles[k];
    if (o.s > s - 12 && o.s < s + 32 && Math.abs(o.x - x) < 5) removeObstacle(k);
  }
}

function spawnChaletCluster(s) {
  const side = randSign();
  const n = 2 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const x = side * rand(17.5, 27);
    const cs = s + i * rand(9, 14);
    const yaw = (side > 0 ? Math.PI / 2 : -Math.PI / 2) + rand(-0.35, 0.35);
    place(poolChalets, x, baseGround(x, cs) - 0.3, cs, yaw, 0, rand(0.85, 1.15));
    for (let t = 0; t < 2; t++) {
      const tx = x + rand(-5, 5) * (Math.random() < 0.5 ? 1 : 1.6);
      if (Math.abs(tx) < 15.2) continue; // never drop décor inside the fences
      spawnDecorTree(tx, cs + rand(-6, 6), rand(1.0, 1.4));
    }
  }
}

function spawnSideTrees(s) {
  for (const side of [-1, 1]) {
    if (Math.random() < 0.55) {
      const n = Math.random() < 0.25 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        spawnDecorTree(side * rand(15.5, 40), s + rand(-3, 3), rand(0.9, 1.5));
      }
    }
  }
}

function generateTo(sMax) {
  while (genS < sMax) {
    spawnFenceRow(genS);
    if (genS % 8 < FENCE_SEG) spawnSideTrees(genS);
    genS += FENCE_SEG;
  }
  while (nextKickerS < sMax) {
    if (nextKickerS > 90) spawnKicker(nextKickerS);
    nextKickerS += rand(115, 175);
  }
  // The first obstacle used to wait until 60m — at START_V that is three and a
  // half seconds of empty groomer before the game asks anything of you, long
  // enough to wonder whether it is broken. Measured over 10 seeds: first
  // obstacle 69.9m/3.19s -> 34.2m/1.73s, and the opening stays sparse (every
  // row in the first 100m places exactly one obstacle, >2.6m off the corridor).
  while (nextObstacleS < sMax) {
    if (nextObstacleS > 28) spawnObstacleRow(nextObstacleS);
    // spacing is in metres but difficulty is felt in seconds: the run is ~25%
    // quicker than it was, so the rows move ~25% further apart to match
    nextObstacleS += rand(8, 12);
  }
  while (nextChaletS < sMax) {
    if (nextChaletS > 40) spawnChaletCluster(nextChaletS);
    nextChaletS += rand(130, 260);
  }
}

function recycleWorld(ps) {
  const minS = ps - KILL_BEHIND;
  recyclePool(poolTrees, minS);
  recyclePool(poolRocks, minS);
  recyclePool(poolPoles, minS);
  recyclePool(poolNets, minS);
  recyclePool(poolChalets, minS);
  recyclePool(poolKickers, minS - 6);
  for (let i = obstacles.length - 1; i >= 0; i--) {
    if (obstacles[i].s < minS) removeObstacle(i);
  }
  for (let i = kickers.length - 1; i >= 0; i--) {
    if (kickers[i].s < minS - 6) { kickers[i] = kickers[kickers.length - 1]; kickers.pop(); }
  }
}

function streamWorld(ps) {
  generateTo(ps + VIEW_AHEAD);
  recycleWorld(ps);
  for (const c of chunks) {
    if (c.s0 + CHUNK_LEN < ps - KILL_BEHIND) {
      const maxS0 = Math.max(...chunks.map((k) => k.s0));
      assignChunk(c, maxS0 + CHUNK_LEN);
    }
  }
}

// ---------------------------------------------------------------------------
// Trail ribbon (carve grooves)
// ---------------------------------------------------------------------------
const TRAIL_MAX = 110;
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 2 * 3), 3));
trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 2 * 4), 4));
{
  const idx = [];
  for (let i = 0; i < TRAIL_MAX - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  trailGeo.setIndex(idx);
}
const trailMat = new THREE.MeshBasicMaterial({ transparent: true, vertexColors: true, depthWrite: false });
const trail = new THREE.Mesh(trailGeo, trailMat);
trail.frustumCulled = false;
scene.add(trail);
const trailPts = [];
let trailLastS = -99;

function pushTrailPoint(px, ps, dirX, dirZ, width) {
  const perpX = -dirZ, perpZ = dirX;
  const hw = width / 2;
  trailPts.push({
    lx: px - perpX * hw, ly: baseGround(px - perpX * hw, ps) + 0.04, lz: -ps - perpZ * hw,
    rx: px + perpX * hw, ry: baseGround(px + perpX * hw, ps) + 0.04, rz: -ps + perpZ * hw,
  });
  if (trailPts.length > TRAIL_MAX) trailPts.shift();
}
function updateTrailMesh() {
  const pa = trailGeo.attributes.position.array;
  const ca = trailGeo.attributes.color.array;
  const n = trailPts.length;
  for (let i = 0; i < n; i++) {
    const p = trailPts[i];
    const o = i * 6;
    pa[o] = p.lx; pa[o + 1] = p.ly; pa[o + 2] = p.lz;
    pa[o + 3] = p.rx; pa[o + 4] = p.ry; pa[o + 5] = p.rz;
    const age = (n - 1 - i) / TRAIL_MAX;
    const a = clamp(0.5 * (1 - age * 1.15), 0, 1);
    const co = i * 8;
    ca[co] = 0.72; ca[co + 1] = 0.81; ca[co + 2] = 0.9; ca[co + 3] = a;
    ca[co + 4] = 0.72; ca[co + 5] = 0.81; ca[co + 6] = 0.9; ca[co + 7] = a;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailGeo.attributes.color.needsUpdate = true;
  trailGeo.setDrawRange(0, Math.max(0, (n - 1) * 6));
}

// ---------------------------------------------------------------------------
// Snow spray particles
// ---------------------------------------------------------------------------
const SPRAY_N = 420;
const sprayGeo = new THREE.BufferGeometry();
const sprayPos = new Float32Array(SPRAY_N * 3);
const sprayCol = new Float32Array(SPRAY_N * 4);
sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
sprayGeo.setAttribute('color', new THREE.BufferAttribute(sprayCol, 4));
const sprayMat = new THREE.PointsMaterial({
  size: 0.72, map: sprayTex, transparent: true, depthWrite: false,
  vertexColors: true, sizeAttenuation: true,
});
const spray = new THREE.Points(sprayGeo, sprayMat);
spray.frustumCulled = false;
scene.add(spray);
const sprayP = Array.from({ length: SPRAY_N }, () => ({ life: 0, max: 1, vx: 0, vy: 0, vz: 0 }));
let sprayCursor = 0;

function emitSpray(x, y, z, vx, vy, vz, life) {
  const i = sprayCursor;
  sprayCursor = (sprayCursor + 1) % SPRAY_N;
  const p = sprayP[i];
  p.life = life; p.max = life;
  p.vx = vx; p.vy = vy; p.vz = vz;
  sprayPos[i * 3] = x; sprayPos[i * 3 + 1] = y; sprayPos[i * 3 + 2] = z;
  sprayCol[i * 4] = 0.96; sprayCol[i * 4 + 1] = 0.98; sprayCol[i * 4 + 2] = 1;
  sprayCol[i * 4 + 3] = 0.8;
}
function updateSpray(dt) {
  for (let i = 0; i < SPRAY_N; i++) {
    const p = sprayP[i];
    if (p.life <= 0) { sprayCol[i * 4 + 3] = 0; continue; }
    p.life -= dt;
    p.vy -= 9.5 * dt;
    p.vx *= 1 - 1.6 * dt;
    p.vz *= 1 - 1.6 * dt;
    sprayPos[i * 3] += p.vx * dt;
    sprayPos[i * 3 + 1] += p.vy * dt;
    sprayPos[i * 3 + 2] += p.vz * dt;
    sprayCol[i * 4 + 3] = clamp((p.life / p.max) * 0.95, 0, 1);
  }
  sprayGeo.attributes.position.needsUpdate = true;
  sprayGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The rider
// ---------------------------------------------------------------------------
const rider = new THREE.Group();
scene.add(rider);

// Rounded character: capsules and spheres only — no boxes.
// Board: a flattened capsule reads as a rounded deck with kicked ends.
const boardMesh = new THREE.Mesh(mergeParts([
  { geo: new THREE.CapsuleGeometry(0.2, 1.16, 8, 20), color: 0x153a5e, matrix: mat4(0, 0.07, 0, Math.PI / 2, 0, 0, 1, 1, 0.32) },
  { geo: new THREE.CapsuleGeometry(0.155, 0.5, 6, 16), color: 0x2dd4bf, matrix: mat4(0, 0.115, 0, Math.PI / 2, 0, 0, 1, 1, 0.14) },
  { geo: new THREE.CylinderGeometry(0.1, 0.12, 0.06, 14), color: 0x101820, matrix: mat4(0, 0.15, 0.27, 0, 0, 0, 1.2, 1, 1.5) },
  { geo: new THREE.CylinderGeometry(0.1, 0.12, 0.06, 14), color: 0x101820, matrix: mat4(0, 0.15, -0.27, 0, 0, 0, 1.2, 1, 1.5) },
]), lambertVC);
rider.add(boardMesh);

// legs in a real riding stance: both knees bent toward the board's nose,
// hips narrower than the bindings. Origin is the hip plane so the crouch
// squash deepens the knee bend naturally.
const legParts = [];
for (const s of [-1, 1]) {
  const hip = [0, 0, s * 0.13];
  const knee = [s * 0.02, -0.24, s * 0.27 - 0.15];
  const boot = [0, -0.44, s * 0.27];
  legParts.push(capsuleBetween(hip, knee, 0.1, 0xf05030));
  legParts.push(capsuleBetween(knee, boot, 0.085, 0xf05030));
  legParts.push({ geo: new THREE.SphereGeometry(0.1, 14, 12), color: 0xf05030, matrix: mat4(...knee) });
  legParts.push({ geo: new THREE.SphereGeometry(0.115, 16, 12), color: 0x1c2b47, matrix: mat4(boot[0], boot[1] - 0.02, boot[2], 0, 0, 0, 1.1, 0.75, 1.4) });
}
legParts.push({ geo: new THREE.SphereGeometry(0.155, 16, 14), color: 0xe64c2b, matrix: mat4(0, 0.02, 0, 0, 0, 0, 1.0, 0.75, 1.15) }); // pelvis
const legs = new THREE.Mesh(mergeParts(legParts), lambertVC);
legs.position.y = 0.6;
rider.add(legs);

// torso pivots at the hip and carries a baked forward lean (see updateRider)
const torso = new THREE.Group();
torso.position.y = 0.62;
rider.add(torso);
torso.add(new THREE.Mesh(mergeParts([
  { geo: new THREE.CapsuleGeometry(0.235, 0.16, 10, 22), color: 0xff5a36, matrix: mat4(0, 0.22, 0, 0, 0, 0, 1.05, 1, 0.85) },
  { geo: new THREE.CylinderGeometry(0.24, 0.252, 0.1, 22), color: 0xd94a2a, matrix: mat4(0, 0.04, 0, 0, 0, 0, 1, 1, 0.82) },
  { geo: new THREE.CylinderGeometry(0.243, 0.243, 0.09, 22), color: 0xffd23f, matrix: mat4(0, 0.28, 0, 0, 0, 0, 1, 1, 0.82) },
]), lambertVC));

// arms hang with a relaxed elbow bend, hands drifting slightly forward
function makeArm(s) {
  const g = new THREE.Group();
  const elbow = [s * 0.05, -0.17, -0.02];
  const wrist = [s * 0.03, -0.3, -0.1];
  g.add(new THREE.Mesh(mergeParts([
    { geo: new THREE.SphereGeometry(0.085, 14, 10), color: 0xff5a36, matrix: mat4(0, 0, 0) },
    capsuleBetween([0, 0, 0], elbow, 0.072, 0xff5a36),
    capsuleBetween(elbow, wrist, 0.062, 0xff5a36),
    { geo: new THREE.SphereGeometry(0.09, 14, 10), color: 0x2f6bed, matrix: mat4(...wrist) },
  ]), lambertVC));
  return g;
}
const armL = makeArm(-1), armR = makeArm(1);
armL.position.set(-0.27, 0.42, 0);
armR.position.set(0.27, 0.42, 0);
torso.add(armL, armR);

// big head, counter-pitched so the face looks downhill, not at the snow
const head = new THREE.Group();
head.position.set(0, 0.56, 0.02);
torso.add(head);
head.add(new THREE.Mesh(mergeParts([
  { geo: new THREE.SphereGeometry(0.19, 22, 18), color: 0xf5c9a2, matrix: mat4(0, 0, 0) },
  { geo: new THREE.CapsuleGeometry(0.055, 0.19, 6, 14), color: 0x16233c, matrix: mat4(0, 0.03, -0.16, 0, 0, Math.PI / 2, 1, 1, 0.6) },
  { geo: new THREE.CylinderGeometry(0.198, 0.203, 0.09, 22), color: 0x2f6bed, matrix: mat4(0, 0.1, 0) },
  { geo: new THREE.CylinderGeometry(0.187, 0.196, 0.072, 22), color: 0xffd23f, matrix: mat4(0, 0.18, 0) },
  { geo: new THREE.SphereGeometry(0.18, 20, 16), color: 0x2f6bed, matrix: mat4(0, 0.19, 0, 0, 0, 0, 1, 0.72, 1) },
  { geo: new THREE.SphereGeometry(0.082, 12, 10), color: 0xffffff, matrix: mat4(0, 0.34, 0) },
]), lambertVC));

const blobShadow = new THREE.Mesh(
  new THREE.CircleGeometry(0.62, 22),
  new THREE.MeshBasicMaterial({ color: 0x33507a, transparent: true, opacity: 0.11, depthWrite: false })
);
blobShadow.rotation.x = -Math.PI / 2;
scene.add(blobShadow);

// ---------------------------------------------------------------------------
// Audio — fully synthesized, nothing to download
// ---------------------------------------------------------------------------
const muteBtn = document.getElementById('mute');
const AudioFX = {
  ctx: null, master: null, wind: null, carve: null, noiseBuf: null,
  muted: false, scrapeAt: 0,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start();
      return { f, g };
    };
    this.wind = loop('lowpass', 300, 0.6);
    this.carve = loop('bandpass', 800, 0.9);
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  setWind(v01) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind.g.gain.setTargetAtTime(0.02 + 0.13 * v01, t, 0.12);
    this.wind.f.frequency.setTargetAtTime(260 + 900 * v01, t, 0.12);
  },
  setCarve(v01) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.carve.g.gain.setTargetAtTime(0.3 * v01, t, 0.05);
    this.carve.f.frequency.setTargetAtTime(650 + 700 * v01, t, 0.05);
  },
  burst(freq, type, dur, gain, sweep) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },
  thump(mag) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(105, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * mag, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.2);
    this.burst(420, 'lowpass', 0.22, 0.4 * mag);
  },
  whoosh() { this.burst(600, 'bandpass', 0.28, 0.22, 1900); },
  scrape(now) {
    if (now - this.scrapeAt < 0.09) return;
    this.scrapeAt = now;
    this.burst(1500, 'bandpass', 0.07, 0.12);
  },
  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [587.33, 880].forEach((fq, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = fq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.07);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.07 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.22);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.25);
    });
  },
  crash() { this.thump(1.5); this.burst(260, 'lowpass', 0.5, 0.5); },
  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch {}
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.02);
    muteBtn.classList.toggle('muted', this.muted);
  },
};
try { AudioFX.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}
muteBtn.classList.toggle('muted', AudioFX.muted);

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const player = {
  s: 0, x: 0, y: 0, vy: 0, vx: 0, v: START_V,
  grounded: true, heading: 0, spin: 0, spinVis: 0, spinTotal: 0,
  airStart: 0, lean: 0, crouch: 0, slopePitch: 0,
  stumbleT: 0, tumbleT: 0,
};
let state = 'start'; // start | playing | crashed | over
let bonus = 0;
let runStartS = 0;
let bestTrickLabel = '';
let bestTrickPts = 0;
let elapsed = 0;
let camShake = 0;
let fovKick = 0;
let jumpBufferedAt = -9;
let camY = null;
let overShownAt = 0;

const scoreEl = document.getElementById('score');
const bestValEl = document.getElementById('bestVal');
const startEl = document.getElementById('start');
const overEl = document.getElementById('over');
const overScoreEl = document.getElementById('overScore');
const overBestEl = document.getElementById('overBest');
const overDistEl = document.getElementById('overDist');
const overTrickEl = document.getElementById('overTrick');
const toastsEl = document.getElementById('toasts');

let shownScore = -1;
function setScore(v) {
  if (v === shownScore) return;
  shownScore = v;
  scoreEl.textContent = v.toLocaleString();
}
bestValEl.textContent = best.toLocaleString();

function toast(html, minor) {
  const el = document.createElement('div');
  el.className = 'toast' + (minor ? ' minor' : '');
  el.innerHTML = html;
  toastsEl.appendChild(el);
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  el.addEventListener('animationend', () => el.remove());
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------
function startRun() {
  state = 'playing';
  runStartS = player.s;
  bonus = 0;
  bestTrickLabel = ''; bestTrickPts = 0;
  player.v = START_V;
  player.vx = 0; player.vy = 0;
  player.grounded = true;
  player.spin = 0; player.spinVis = 0; player.spinTotal = 0;
  player.stumbleT = 0; player.tumbleT = 0;
  player.y = groundYFull(player.x, player.s);
  rider.rotation.set(0, 0, 0);
  startEl.classList.add('hidden');
  overEl.classList.add('hidden');
  setScore(0);
  AudioFX.init();
  AudioFX.resume();
  // clear a fair runway out of the gate
  for (let k = obstacles.length - 1; k >= 0; k--) {
    const o = obstacles[k];
    if (o.s > player.s && o.s < player.s + 80 && Math.abs(o.x) < 5.5) removeObstacle(k);
  }
}

function endRun() {
  state = 'over';
  const total = Math.floor(player.s - runStartS) + bonus;
  setScore(total);
  if (total > best) {
    best = total;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch {}
    bestValEl.textContent = best.toLocaleString();
  }
  overScoreEl.textContent = total.toLocaleString();
  overBestEl.textContent = best.toLocaleString();
  overDistEl.textContent = `${Math.floor(player.s - runStartS).toLocaleString()} m`;
  overTrickEl.textContent = bestTrickPts > 0 ? ` · best trick ${bestTrickLabel}` : '';
  overEl.classList.remove('hidden');
  overShownAt = performance.now();
}

function crash() {
  if (state !== 'playing') return;
  state = 'crashed';
  player.tumbleT = 0;
  camShake = Math.min(camShake + 1, 1.3);
  AudioFX.crash();
  AudioFX.setCarve(0);
  navigator.vibrate?.(35);
  for (let i = 0; i < 90; i++) {
    emitSpray(
      player.x + rand(-0.6, 0.6), player.y + rand(0, 1), -player.s + rand(-0.6, 0.6),
      rand(-5, 5), rand(2, 9), rand(-3, 6), rand(0.5, 1.1)
    );
  }
}

// ---------------------------------------------------------------------------
// Tricks
// ---------------------------------------------------------------------------
function normAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

function takeOff(vy) {
  player.grounded = false;
  player.vy = vy;
  player.spinTotal = 0;
  player.airStart = elapsed;
}

function land() {
  player.grounded = true;
  player.vy = 0;
  const airTime = elapsed - player.airStart;
  // nearest 180° counts as straight — riding switch is style, not a fall
  let mis = normAngle(player.spin);
  if (mis > Math.PI / 2) mis -= Math.PI;
  if (mis < -Math.PI / 2) mis += Math.PI;
  const aligned = Math.abs(mis) < ALIGN_TOL;
  const spins = Math.round(Math.abs(player.spinTotal) / Math.PI);
  player.spin = 0;
  player.spinTotal = 0;
  dragX0 = dragX; // re-anchor the carve so landing doesn't jerk sideways

  const burst = Math.floor(clamp(airTime * 26, 8, 46));
  for (let i = 0; i < burst; i++) {
    emitSpray(
      player.x + rand(-0.7, 0.7), player.y + 0.1, -player.s + rand(-0.5, 0.9),
      rand(-3.4, 3.4), rand(1.5, 4.5), rand(-1, 4), rand(0.4, 0.9)
    );
  }
  camShake = Math.min(camShake + clamp(airTime * 0.3, 0.08, 0.5), 1.2);
  AudioFX.thump(clamp(0.4 + airTime * 0.4, 0.4, 1));

  if (!aligned) {
    player.stumbleT = 0.85;
    player.v *= 0.68;
    toast('sketchy landing', true);
    navigator.vibrate?.(20);
    return;
  }
  let pts = 0, label = '';
  if (spins >= 1) {
    const deg = spins * 180;
    pts = spins === 1 ? 40 : spins === 2 ? 100 : spins === 3 ? 180 : 100 * spins - 120;
    label = `${deg}!`;
  } else if (airTime > 0.85) {
    pts = 25;
    label = 'clean air';
  }
  if (pts > 0) {
    bonus += pts;
    if (pts >= bestTrickPts) {
      bestTrickPts = pts;
      bestTrickLabel = spins >= 1 ? `${spins * 180}°` : 'clean air';
    }
    toast(`${label} <span class="pts">+${pts}</span>`);
    AudioFX.chime();
    navigator.vibrate?.(8);
    player.v = Math.min(player.v + 1.2, MAX_V + 2);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let dragging = false;
let dragX0 = 0, dragY0 = 0, dragX = 0;
let dragMoved = 0;
let downAt = 0;
let steerKey = 0, keyL = false, keyR = false;

function tryJump() {
  if (state !== 'playing') return;
  if (player.grounded) {
    takeOff(OLLIE_VY);
    AudioFX.whoosh();
    for (let i = 0; i < 8; i++) {
      emitSpray(player.x + rand(-0.4, 0.4), player.y + 0.05, -player.s + rand(-0.2, 0.6),
        rand(-1.5, 1.5), rand(1, 2.5), rand(0, 2), rand(0.3, 0.6));
    }
  } else {
    jumpBufferedAt = elapsed;
  }
}

function primaryAction() {
  if (state === 'over') {
    // swallow the tail of a drag that was in flight when the crash happened
    if (performance.now() - overShownAt < 400) return;
    startRun();
  } else if (state === 'start') {
    startRun();
  } else if (state === 'playing') {
    tryJump();
  }
}

canvas.addEventListener('pointerdown', (e) => {
  AudioFX.init();
  AudioFX.resume();
  dragging = true;
  dragX0 = e.clientX; dragY0 = e.clientY;
  dragX = e.clientX;
  dragMoved = 0;
  downAt = performance.now();
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragX;
  dragX = e.clientX;
  dragMoved = Math.max(dragMoved, Math.hypot(e.clientX - dragX0, e.clientY - dragY0));
  if (state === 'playing' && !player.grounded) {
    player.spin += dx * SPIN_PER_PX;
    player.spinTotal += dx * SPIN_PER_PX;
  }
});
canvas.addEventListener('pointerup', () => {
  if (!dragging) return;
  dragging = false;
  const quick = performance.now() - downAt < 260;
  if (dragMoved < 12 && quick) primaryAction();
});
canvas.addEventListener('pointercancel', () => { dragging = false; });

startEl.addEventListener('pointerup', () => primaryAction());
overEl.addEventListener('pointerup', () => primaryAction());

for (const t of ['pointerdown', 'pointerup', 'click']) {
  muteBtn.addEventListener(t, (e) => e.stopPropagation());
}
muteBtn.addEventListener('click', () => { AudioFX.init(); AudioFX.toggle(); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyL = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyR = true;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    AudioFX.init(); AudioFX.resume();
    primaryAction();
  }
  if (e.key === 'r' || e.key === 'R') {
    AudioFX.init(); AudioFX.resume();
    startRun();
  }
  if (e.key === 'm' || e.key === 'M') { AudioFX.init(); AudioFX.toggle(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyL = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyR = false;
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function steerInput(dt) {
  const keyDir = (keyR ? 1 : 0) - (keyL ? 1 : 0);
  if (keyDir !== 0) {
    steerKey = clamp(steerKey + keyDir * 3.6 * dt, -1, 1);
    return steerKey;
  }
  if (dragging) {
    steerKey = 0;
    return clamp((dragX - dragX0) / DRAG_FULL, -1, 1);
  }
  steerKey = damp(steerKey, 0, 8, dt);
  return steerKey;
}

function updatePlaying(dt) {
  elapsed += dt;
  const p = player;

  const accel = Math.max(PULL_MIN, (MAX_V - p.v) * PULL);
  p.v = Math.min(p.v + accel * dt, MAX_V + 2);

  const prevS = p.s;
  p.s += p.v * dt;

  const steer = steerInput(dt);
  const maxVx = STEER_MAX * p.v;
  if (p.grounded && p.stumbleT <= 0) {
    p.vx = damp(p.vx, steer * maxVx, 6.5, dt);
  } else if (p.grounded) {
    p.vx = damp(p.vx, 0, 2.5, dt); // stumbling: mushy control
  }
  p.x += p.vx * dt;

  // fence clamp — a soft bounce, never a wall of death
  if (Math.abs(p.x) > FENCE_X - 0.45) {
    p.x = clamp(p.x, -(FENCE_X - 0.45), FENCE_X - 0.45);
    if (Math.abs(p.vx) > 0.5) {
      p.vx *= -0.25;
      camShake = Math.min(camShake + 0.12, 1);
      AudioFX.scrape(elapsed);
      navigator.vibrate?.(5);
      for (let i = 0; i < 5; i++) {
        emitSpray(p.x + Math.sign(p.x) * 0.3, p.y + rand(0.1, 0.6), -p.s + rand(-0.3, 0.3),
          -Math.sign(p.x) * rand(1, 3), rand(1, 3), rand(0, 2), rand(0.3, 0.6));
      }
    }
  }

  // vertical
  if (p.grounded) {
    const lip = onRampLipCross(prevS, p.s, p.x);
    if (lip) {
      takeOff(Math.min(2.2 + p.v * 0.3, 11));
      p.y = baseGround(p.x, lip.s - KICK_LEN) + KICK_LIP;
      fovKick = 6;
      AudioFX.whoosh();
      camShake = Math.min(camShake + 0.1, 1);
    } else {
      p.y = groundYFull(p.x, p.s);
      if (elapsed - jumpBufferedAt < 0.14) {
        jumpBufferedAt = -9;
        tryJump();
      }
    }
  }
  if (!p.grounded) {
    p.vy -= G * dt;
    p.y += p.vy * dt;
    const keyDir = (keyR ? 1 : 0) - (keyL ? 1 : 0);
    if (keyDir !== 0) {
      p.spin += keyDir * SPIN_KEY * dt;
      p.spinTotal += keyDir * SPIN_KEY * dt;
    }
    const gy = groundYFull(p.x, p.s);
    if (p.y <= gy && p.vy < 0) {
      p.y = gy;
      land();
    }
  }

  if (p.stumbleT > 0) p.stumbleT -= dt;

  // collisions — near the ground only, so you can ollie clean over rocks
  const hAbove = p.y - baseGround(p.x, p.s);
  for (const o of obstacles) {
    const ds = o.s - p.s;
    if (ds < -2 || ds > 3) continue;
    const dist = Math.hypot(o.x - p.x, ds);
    if (dist < o.r + 0.42 && hAbove < o.h) {
      crash();
      break;
    }
    if (!o.passed && ds < 0.4) {
      o.passed = true;
      if (dist < o.r + 1.5 && p.grounded) {
        bonus += 15;
        toast('close! <span class="pts">+15</span>', true);
      }
    }
  }
  if (state !== 'playing') return;

  // heading & lean
  p.heading = Math.atan2(-p.vx, p.v);
  const leanT = p.grounded ? clamp(p.vx / maxVx, -1, 1) : 0;
  p.lean = damp(p.lean, leanT, 8, dt);
  const crouchT = p.grounded ? clamp(Math.abs(p.lean) * 0.55, 0, 0.6) : 0.85;
  p.crouch = damp(p.crouch, crouchT, 7, dt);

  // carve spray + trail + sound
  const carveMag = p.grounded && p.stumbleT <= 0 ? Math.abs(p.vx) / Math.max(maxVx, 1) : 0;
  if (p.grounded && carveMag > 0.12) {
    const rate = carveMag * 130 * dt;
    const n = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const side = -Math.sign(p.vx);
      emitSpray(
        p.x + side * rand(0.1, 0.45), p.y + 0.06, -p.s + rand(0.2, 0.9),
        side * rand(0.8, 2.8) * (0.5 + carveMag) + p.vx * 0.25,
        rand(0.8, 2.6) * (0.5 + carveMag * 1.4),
        rand(0.5, 2.5),
        rand(0.35, 0.75)
      );
    }
  }
  // faint powder dust kicked up at speed even when riding flat
  if (p.grounded && p.v > 19 && Math.random() < dt * (p.v - 19) * 0.5) {
    emitSpray(p.x + rand(-0.25, 0.25), p.y + 0.05, -p.s + rand(0.6, 1.2),
      rand(-0.6, 0.6), rand(0.5, 1.4), rand(1, 3), rand(0.3, 0.6));
  }
  if (p.grounded && p.s - trailLastS > 0.55) {
    const dLen = Math.hypot(p.vx, p.v);
    pushTrailPoint(p.x, p.s, p.vx / dLen, -p.v / dLen, p.stumbleT > 0 ? 0.2 : 0.5);
    trailLastS = p.s;
  }
  AudioFX.setCarve(carveMag * clamp(p.v / MAX_V, 0.3, 1));
  AudioFX.setWind(clamp(p.v / MAX_V, 0, 1));

  setScore(Math.floor(p.s - runStartS) + bonus);
  streamWorld(p.s);
}

function updateCrashed(dt) {
  elapsed += dt;
  const p = player;
  p.tumbleT += dt;
  p.v = Math.max(0, p.v - 26 * dt);
  p.s += p.v * dt;
  p.y = groundYFull(p.x, p.s);
  AudioFX.setWind(0.08);
  AudioFX.setCarve(0);
  if (p.v > 4 && Math.random() < 0.5) {
    emitSpray(p.x + rand(-0.5, 0.5), p.y + rand(0, 0.5), -p.s + rand(-0.5, 0.5),
      rand(-2, 2), rand(1, 4), rand(-1, 3), rand(0.3, 0.8));
  }
  if (state === 'crashed' && p.tumbleT > 0.3) endRun();
}

// idle attract mode behind the start panel: a slow cruise down the fall line
function updateAttract(dt) {
  elapsed += dt;
  const p = player;
  p.v = 7;
  p.s += p.v * dt;
  let tx = Math.sin(elapsed * 0.5) * 3.2;
  for (const o of obstacles) {
    const ds = o.s - p.s;
    if (ds > 2 && ds < 30 && Math.abs(o.x - p.x) < 3.4) tx = p.x + (p.x < o.x ? -3.4 : 3.4);
  }
  for (const k of kickers) {
    const ds = k.s - p.s;
    if (ds > 2 && ds < 30 && Math.abs(k.x - p.x) < 3.4) tx = p.x + (p.x < k.x ? -3.4 : 3.4);
  }
  tx = clamp(tx, -9, 9);
  const nx = damp(p.x, tx, 1.4, dt);
  p.vx = (nx - p.x) / Math.max(dt, 1e-4);
  p.x = nx;
  p.heading = Math.atan2(-p.vx, p.v);
  p.lean = damp(p.lean, clamp(p.vx / 6, -1, 1), 4, dt);
  p.y = groundYFull(p.x, p.s);
  p.grounded = true;
  p.crouch = damp(p.crouch, 0.15, 4, dt);
  if (p.s - trailLastS > 0.6) {
    pushTrailPoint(p.x, p.s, 0, -1, 0.5);
    trailLastS = p.s;
  }
  AudioFX.setWind(0.12);
  AudioFX.setCarve(0.04);
  streamWorld(p.s);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
function updateRider(dt) {
  const p = player;
  rider.position.set(p.x, p.y, -p.s);
  if (state === 'crashed' || state === 'over') {
    rider.rotation.y += 9 * dt;
    rider.rotation.z = Math.min(rider.rotation.z + 6 * dt, Math.PI / 2 + 0.2);
    rider.rotation.x = 0;
  } else {
    p.spinVis = damp(p.spinVis, p.spin, 14, dt);
    const styleYaw = 0.26 * (p.grounded ? 1 : 0.4);
    rider.rotation.y = p.heading + p.spinVis + styleYaw;
    let roll = -p.lean * 0.5;
    let pitch;
    if (p.grounded) {
      // board follows the terrain (and rides up kicker faces)
      const gA = groundYFull(p.x, p.s + 0.9), gB = groundYFull(p.x, p.s - 0.9);
      p.slopePitch = damp(p.slopePitch, Math.atan2(gA - gB, 1.8), 9, dt);
      pitch = p.slopePitch;
    } else {
      pitch = clamp(-p.vy * 0.02, -0.28, 0.34);
    }
    if (p.stumbleT > 0) {
      roll += Math.sin(elapsed * 26) * 0.3 * (p.stumbleT / 0.85);
      pitch += 0.25 * (p.stumbleT / 0.85);
    }
    rider.rotation.z = roll;
    rider.rotation.x = pitch;
  }

  const cr = p.crouch;
  legs.scale.y = 1 - cr * 0.35;
  legs.position.y = 0.6 - cr * 0.13;
  boardMesh.position.y = p.grounded ? 0 : 0.13 * cr; // board tucks up with the knees mid-air
  torso.position.y = 0.62 - cr * 0.13;
  torso.rotation.x = -(0.34 + cr * 0.3); // athletic forward lean, deeper in the crouch
  torso.rotation.y = -p.lean * 0.25;
  head.rotation.x = 0.3 + cr * 0.24;     // eyes stay on the fall line

  const spread = p.grounded ? Math.abs(p.lean) : 0.25;
  const grab = !p.grounded ? clamp((elapsed - p.airStart) * 4, 0, 1) : 0;
  armL.rotation.z = -(0.18 + spread * 0.75);
  armR.rotation.z = 0.18 + spread * 0.75;
  armL.rotation.x = grab * 0.5;
  armR.rotation.x = -grab * 1.1; // rear hand reaches for the board
  head.rotation.y = -0.28 - torso.rotation.y;

  const gy = groundYFull(p.x, p.s);
  blobShadow.position.set(p.x, gy + 0.05, -p.s);
  const h = clamp(p.y - gy, 0, 6);
  const sc = 1 + h * 0.12;
  blobShadow.scale.set(sc, sc, sc);
  blobShadow.material.opacity = clamp(0.26 - h * 0.03, 0.08, 0.26);
}

function updateCamera(dt) {
  const p = player;
  // clear the roller crest the camera itself sits on, not just the player's
  const gCam = baseGround(p.x * 0.78, p.s - CAM_BACK);
  const targetCamY = Math.max(baseGround(p.x * 0.78, p.s) + CAM_UP, gCam + 2.4);
  camY = camY === null ? targetCamY : damp(camY, targetCamY, 5.5, dt);

  camShake = Math.max(0, camShake - camShake * 4.5 * dt - 0.02 * dt);
  const sh = camShake * JOLT;
  const shX = sh * 0.15 * Math.sin(elapsed * 47);
  const shY = sh * 0.12 * Math.sin(elapsed * 39 + 1.3);

  camera.position.set(p.x * 0.78 + shX, camY + shY, -p.s + CAM_BACK);
  const lookS = p.s + 12.5;
  camera.lookAt(p.x * 0.92, baseGround(p.x * 0.92, lookS) + 1.3, -lookS);
  camera.rotation.z += p.lean * -0.10 + sh * 0.04 * Math.sin(elapsed * 53);

  fovKick = Math.max(0, fovKick - 9 * dt);
  const speedNorm = clamp(p.v / MAX_V, 0, 1);
  // portrait phones get a wider vertical FOV so the horizontal view still
  // spans the piste — otherwise a tall screen crops both fences out
  const aspectBoost = camera.aspect < 1 ? (1 - camera.aspect) * 17 : 0;
  const fov = BASE_FOV + aspectBoost + 12 * speedNorm * speedNorm + fovKick * JOLT;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  // the horizon rides along with the player so it reads as infinitely far
  horizon.position.set(p.x * 0.75, camY - CAM_UP + 10, -p.s);
}

function updateClouds(dt) {
  for (const c of clouds) {
    c.position.x += c.userData.spd * dt;
    if (c.position.x > 700) c.position.x = -700;
    if (c.position.x < -700) c.position.x = 700;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap + loop
// ---------------------------------------------------------------------------
generateTo(VIEW_AHEAD);
for (let i = 0; i < CHUNKS; i++) assignChunk(chunks[i], (i - 1) * CHUNK_LEN);
player.y = groundYFull(0, 0);
setScore(0);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let hidden = false;
document.addEventListener('visibilitychange', () => {
  hidden = document.hidden;
  if (!hidden) last = performance.now();
});

let last = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  if (hidden) return;
  if (pause.active) { last = now; return; }
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.033);

  if (state === 'playing') updatePlaying(dt);
  else if (state === 'crashed' || state === 'over') updateCrashed(dt);
  else updateAttract(dt);

  updateRider(dt);
  updateCamera(dt);
  updateClouds(dt);
  updateSpray(dt);
  updateTrailMesh();

  renderer.render(scene, camera);
}
const pause = installPause({
  canPause: () => state === 'playing',
  right: 68,                                  // clear of the mute button
  onPause: () => { AudioFX.setCarve(0); AudioFX.setWind(0); },
});
requestAnimationFrame(tick);

// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'playing' });
installPrompt();
