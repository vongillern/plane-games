import * as THREE from './vendor/three.module.js';
import { installPause } from './pause.js';
import { installUpdates } from './update.js';

// ---------------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;

const ARENA = 200;                 // playfield is a square this many metres wide
const HALF = ARENA / 2;
const CELL = 6;                    // broadphase cell size (m)
const GRID_N = Math.ceil(ARENA / CELL) + 2;

const HOLE_MAX = 6;                // shader slots: player + 3 rivals + margin
const RIVALS = 3;
const MATCH_TIME = 120;            // seconds

const START_R = 0.95;              // hole radius at the gun
const START_AREA = Math.PI * START_R * START_R;
const EAT_RATIO = 0.92;            // eligible when objR <= holeR * EAT_RATIO
const TIP_BITE = 0.25;             // rim must pass this far under the footprint
const SHAFT_DEPTH = 26;
const G = 30;                      // gravity for the fall (m/s²) — arcade-heavy

// A hole is a mass, not a cursor: it starts nimble and gets heavy. Growth
// buys reach and menu, never pace — so a late lead has to be steered, and a
// small hole can always outrun a big one.
const BASE_SPEED = 12.5;           // m/s at START_R
const SPEED_FALL = 0.34;           // speed *= (r / START_R) ^ -SPEED_FALL
const SPEED_FLOOR = 0.52;          // ...but never below this fraction of base
const ACCEL = 9;                   // damp rate toward the commanded velocity
const ACCEL_HEAVY = 0.55;          // big holes also take longer to change course

const STICK_MAX = 90;              // px of drag for full tilt
const STICK_DEAD = 6;

// ~63°: steep enough that a tower next to you never hides your own hole, but
// not so steep that the pit loses its depth
const CAM_PITCH = 1.10;
const CAM_YAW = -0.38;
const CAM_NEAR_D = 30;
const CAM_FAR_D = 82;
const CAM_R_FAR = 17;              // hole radius at which the camera is fully out
const FOV = 55;

const EAT_HOLE_RATIO = 1.15;       // how much bigger you must be to swallow a rival
const EAT_PLAYER_RATIO = 1.45;     // ...and how much bigger a rival must be to take
                                   // you: the house tilts the table your way
const EAT_HOLE_REACH = 0.75;       // ...and how close, as a fraction of your radius
const RESPAWN_DELAY = 2.5;

// Rival handicaps. They should feel like opponents with a plan, not solvers:
// slower, slower to decide, and they bank less from every bite.
const RIVAL_SKILL = [0.60, 0.78];  // fraction of full speed they command
const RIVAL_GROWTH = 0.82;         // area they bank per prop, vs the player's 1.0
const RIVAL_THINK = [0.9, 1.9];    // seconds between re-appraisals (÷ skill)
const RIVAL_DAWDLE = 0.34;         // chance a re-appraisal turns into a wander
const RIVAL_REACH = 13;            // + drawR * 5.5 — how far they look for prey

// See-through blockers: anything standing between the camera and your hole
// dissolves to this much of itself, so the pit is never hidden by a tower.
const FADE_MIN = 0.24;
const FADE_RATE = 9;               // how fast a blocker fades in / back out
const FADE_MIN_H = 1.6;            // props shorter than this never occlude

const BEST_KEY = 'am.sink.best';
const MUTE_KEY = 'am.sink.muted';
const MAP_KEY = 'am.sink.map';

const PLAYER_COLOR = '#ef4444';
const RIVAL_COLORS = ['#22d3ee', '#a3e635', '#a78bfa', '#fbbf24', '#f472b6'];
const RIVAL_NAMES = ['Gulp', 'Nix', 'Vex', 'Rook', 'Dune', 'Moss', 'Pike', 'Wren'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const hash2 = (a, b) => {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
};

// smooth value noise — used to mottle ground textures so nothing is flat
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

let best = 0;
try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch {}

// ---------------------------------------------------------------------------
// Renderer / scene / camera / lights
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fb6cc, 90, 340);

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.5, 1200);

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x4a4a52, 1.15);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3dd, 1.85);
sun.position.set(-60, 110, 48);
scene.add(sun);

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  return t;
}

// soft round sprite — dust puffs and the rim glow both ride on this
const puffTex = canvasTex(64, 64, (g, w) => {
  const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,.42)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, w);
});

// ---------------------------------------------------------------------------
// Geometry: everything is boxes and cylinders baked into one vertex-coloured mesh
// ---------------------------------------------------------------------------
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const HIDE_M = new THREE.Matrix4().makeScale(0, 0, 0);

function part(geo, color, x, y, z, rx, ry, rz, sx, sy, sz) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(x || 0, y || 0, z || 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
    new THREE.Vector3(sx === undefined ? 1 : sx, sy === undefined ? 1 : sy, sz === undefined ? 1 : sz)
  );
  return { geo, color, m };
}

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg) => new THREE.CylinderGeometry(rt, rb, h, seg || 10);
const cone = (r, h, seg) => new THREE.ConeGeometry(r, h, seg || 8);
const sph = (r, seg) => new THREE.SphereGeometry(r, seg || 8, (seg || 8) - 2);

// bake parts into a single non-indexed, vertex-coloured geometry
function mergeParts(parts) {
  let total = 0;
  const baked = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.m);
    total += g.attributes.position.count;
    return { g, color: p.color };
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const b of baked) {
    const P = b.g.attributes.position.array;
    const N = b.g.attributes.normal.array;
    _col.set(b.color);
    for (let i = 0; i < P.length; i += 3) {
      pos[o] = P[i]; pos[o + 1] = P[i + 1]; pos[o + 2] = P[i + 2];
      nor[o] = N[i]; nor[o + 1] = N[i + 1]; nor[o + 2] = N[i + 2];
      col[o] = _col.r; col[o + 1] = _col.g; col[o + 2] = _col.b;
      o += 3;
    }
    b.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// shade a hex colour by a factor — keeps prop palettes to one source value
function shade(hex, f) {
  _col.set(hex);
  _col.multiplyScalar(f);
  return '#' + _col.getHexString();
}

// ---------------------------------------------------------------------------
// Prop archetypes — rebuilt per map so each world restyles its own props
// ---------------------------------------------------------------------------
// spec.r is the footprint radius at unit scale: the size gate compares it to
// the hole radius, so it decides *when* a thing becomes edible.
const SPECS = {
  person:  { r: 0.32, growth: 0.30, pts: 20,   max: 300 },
  hydrant: { r: 0.34, growth: 0.26, pts: 15,   max: 90 },
  sign:    { r: 0.34, growth: 0.30, pts: 18,   max: 110 },
  bush:    { r: 0.75, growth: 0.55, pts: 26,   max: 220 },
  rock:    { r: 0.80, growth: 0.60, pts: 24,   max: 120 },
  bench:   { r: 0.95, growth: 0.70, pts: 35,   max: 130 },
  light:   { r: 0.50, growth: 0.85, pts: 40,   max: 150 },
  parasol: { r: 1.05, growth: 0.90, pts: 45,   max: 90 },
  planter: { r: 1.20, growth: 1.10, pts: 55,   max: 100 },
  palm:    { r: 1.00, growth: 1.30, pts: 55,   max: 110 },
  tree:    { r: 1.15, growth: 1.50, pts: 60,   max: 300 },
  car:     { r: 1.30, growth: 1.90, pts: 75,   max: 160 },
  van:     { r: 1.70, growth: 3.00, pts: 110,  max: 80 },
  fountain:{ r: 2.60, growth: 5.50, pts: 190,  max: 16 },
  hut:     { r: 2.40, growth: 5.00, pts: 180,  max: 80 },
  bus:     { r: 2.70, growth: 6.00, pts: 200,  max: 34 },
  block:   { r: 5.00, growth: 22.0, pts: 800,  max: 64 },
  tower:   { r: 7.00, growth: 48.0, pts: 1900, max: 28 },
};
const KINDS = Object.keys(SPECS);

// window ribbons: one thin band wrapped around the whole storey reads as a
// row of lit windows from this camera distance, for 1 box instead of 40
// Storeys are stacked boxes alternating wall and glass, all exactly the same
// footprint — the window bands are flush, so the silhouette stays a clean
// slab instead of a stack of trays.
function facade(parts, w, d, h, y0, floors, wall, win) {
  const fh = h / floors;
  for (let i = 0; i < floors; i++) {
    const y = y0 + i * fh;
    parts.push(part(box(w, fh * 0.6, d), wall, 0, y + fh * 0.3, 0));
    parts.push(part(box(w, fh * 0.4, d), win, 0, y + fh * 0.8, 0));
  }
}

function buildArchetypes(P) {
  const A = {};

  A.person = () => {
    const shirt = pick(P.people);
    return mergeParts([
      part(box(0.16, 0.44, 0.16), '#31313c', -0.09, 0.22, 0),
      part(box(0.16, 0.44, 0.16), '#31313c', 0.09, 0.22, 0),
      part(box(0.36, 0.44, 0.24), shirt, 0, 0.66, 0),
      part(box(0.22, 0.22, 0.22), '#d9a689', 0, 0.99, 0),
    ]);
  };

  A.hydrant = () => mergeParts([
    part(cyl(0.15, 0.17, 0.52, 8), P.hydrant, 0, 0.26, 0),
    part(cyl(0.09, 0.11, 0.12, 8), P.hydrant, 0, 0.57, 0),
    part(box(0.44, 0.11, 0.11), P.hydrant, 0, 0.42, 0),
  ]);

  A.sign = () => mergeParts([
    part(cyl(0.05, 0.05, 2.1, 6), '#4a4a55', 0, 1.05, 0),
    part(box(0.56, 0.46, 0.05), P.sign, 0, 1.92, 0.04),
  ]);

  A.bush = () => mergeParts([
    part(sph(0.5), P.foliage, -0.2, 0.42, 0.1),
    part(sph(0.42), shade(P.foliage, 1.14), 0.24, 0.5, -0.12),
    part(sph(0.36), shade(P.foliage, 0.86), 0.05, 0.34, 0.3),
  ]);

  A.rock = () => mergeParts([
    part(box(0.9, 0.62, 0.8), P.rock, 0, 0.28, 0, 0.2, 0.6, 0.1),
    part(box(0.6, 0.44, 0.55), shade(P.rock, 1.15), 0.3, 0.2, 0.22, 0, 1.1, 0.25),
  ]);

  A.bench = () => mergeParts([
    part(box(1.8, 0.09, 0.52), P.wood, 0, 0.44, 0),
    part(box(1.8, 0.44, 0.08), P.wood, 0, 0.66, -0.22),
    part(box(0.09, 0.44, 0.5), '#3d3d46', -0.76, 0.22, 0),
    part(box(0.09, 0.44, 0.5), '#3d3d46', 0.76, 0.22, 0),
  ]);

  A.light = () => mergeParts([
    part(cyl(0.07, 0.1, 4.2, 8), P.metal, 0, 2.1, 0),
    part(box(0.09, 0.09, 1.0), P.metal, 0, 4.18, 0.45),
    part(box(0.42, 0.16, 0.62), P.lamp, 0, 4.06, 0.9),
  ]);

  A.parasol = () => mergeParts([
    part(cyl(0.05, 0.05, 2.2, 6), '#c8b48e', 0, 1.1, 0),
    part(cone(1.15, 0.55, 8), P.parasol, 0, 2.25, 0),
    part(cone(1.15, 0.5, 8), shade(P.parasol, 0.8), 0, 2.2, 0, 0, TAU / 16, 0),
  ]);

  A.planter = () => mergeParts([
    part(box(2.3, 0.55, 1.15), P.stone, 0, 0.28, 0),
    part(box(2.1, 0.12, 0.95), '#3c2f22', 0, 0.58, 0),
    part(sph(0.44), P.foliage, -0.62, 0.78, 0),
    part(sph(0.5), shade(P.foliage, 1.1), 0.18, 0.84, 0.05),
    part(sph(0.4), shade(P.foliage, 0.9), 0.76, 0.74, -0.04),
  ]);

  A.palm = () => {
    const parts = [
      part(cyl(0.13, 0.2, 3.4, 7), P.trunk, 0, 1.7, 0, 0.06, 0, 0.03),
      part(sph(0.22), P.trunk, 0.22, 3.35, 0.1),
    ];
    // a crown of overlapping mass with a few frond tips out of it — bare
    // radiating spokes read as a pinwheel from a top-down camera
    parts.push(part(sph(0.78), P.foliage, 0.22, 3.42, 0.1, 0, 0, 0, 1, 0.52, 1));
    parts.push(part(sph(0.6), shade(P.foliage, 1.14), 0.5, 3.5, -0.18, 0, 0, 0, 1, 0.5, 1));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.4;
      const len = rand(1.0, 1.4);
      parts.push(part(
        box(len, 0.09, 0.38), i % 2 ? P.foliage : shade(P.foliage, 1.2),
        0.22 + Math.cos(a) * len * 0.52, 3.3, 0.1 + Math.sin(a) * len * 0.52,
        0, -a, -rand(0.6, 0.95)
      ));
    }
    return mergeParts(parts);
  };

  A.tree = () => {
    const g = pick([1, 1.14, 0.88]);
    return mergeParts([
      part(cyl(0.15, 0.22, 1.5, 7), P.trunk, 0, 0.75, 0),
      part(sph(0.95), shade(P.foliage, g), 0, 2.25, 0, 0, 0, 0, 1, 0.92, 1),
      part(sph(0.68), shade(P.foliage, g * 1.12), 0.42, 2.95, -0.2),
      part(sph(0.55), shade(P.foliage, g * 0.88), -0.44, 2.7, 0.28),
    ]);
  };

  A.car = () => {
    const c = pick(P.cars);
    return mergeParts([
      part(box(1.86, 0.52, 4.1), c, 0, 0.62, 0),
      part(box(1.66, 0.5, 2.1), shade(c, 1.08), 0, 1.1, -0.16),
      part(box(1.7, 0.34, 2.0), '#1a1e28', 0, 1.14, -0.16),
      part(box(1.9, 0.16, 1.0), shade(c, 0.8), 0, 0.9, 1.6),
      part(cyl(0.35, 0.35, 0.24, 8), '#16161b', -0.9, 0.35, 1.3, 0, 0, Math.PI / 2),
      part(cyl(0.35, 0.35, 0.24, 8), '#16161b', 0.9, 0.35, 1.3, 0, 0, Math.PI / 2),
      part(cyl(0.35, 0.35, 0.24, 8), '#16161b', -0.9, 0.35, -1.3, 0, 0, Math.PI / 2),
      part(cyl(0.35, 0.35, 0.24, 8), '#16161b', 0.9, 0.35, -1.3, 0, 0, Math.PI / 2),
    ]);
  };

  A.van = () => {
    const c = pick(P.cars);
    return mergeParts([
      part(box(2.2, 1.5, 5.2), c, 0, 1.2, 0),
      part(box(2.24, 0.5, 1.5), '#1a1e28', 0, 1.5, -1.9),
      part(box(2.0, 0.2, 5.2), shade(c, 0.82), 0, 0.5, 0),
      part(cyl(0.4, 0.4, 0.26, 8), '#16161b', -1.05, 0.4, 1.7, 0, 0, Math.PI / 2),
      part(cyl(0.4, 0.4, 0.26, 8), '#16161b', 1.05, 0.4, 1.7, 0, 0, Math.PI / 2),
      part(cyl(0.4, 0.4, 0.26, 8), '#16161b', -1.05, 0.4, -1.7, 0, 0, Math.PI / 2),
      part(cyl(0.4, 0.4, 0.26, 8), '#16161b', 1.05, 0.4, -1.7, 0, 0, Math.PI / 2),
    ]);
  };

  A.bus = () => {
    const c = Array.isArray(P.bus) ? pick(P.bus) : P.bus;
    return mergeParts([
    part(box(2.6, 2.1, 9.4), c, 0, 1.6, 0),
    part(box(2.66, 0.66, 8.0), '#1a1e28', 0, 2.25, 0),
    part(box(2.66, 0.24, 9.4), shade(c, 0.78), 0, 0.7, 0),
    part(box(2.4, 0.3, 0.3), '#f2f2f2', 0, 3.4, 0),
    part(cyl(0.48, 0.48, 0.3, 8), '#16161b', -1.25, 0.48, 3.1, 0, 0, Math.PI / 2),
    part(cyl(0.48, 0.48, 0.3, 8), '#16161b', 1.25, 0.48, 3.1, 0, 0, Math.PI / 2),
    part(cyl(0.48, 0.48, 0.3, 8), '#16161b', -1.25, 0.48, -2.9, 0, 0, Math.PI / 2),
    part(cyl(0.48, 0.48, 0.3, 8), '#16161b', 1.25, 0.48, -2.9, 0, 0, Math.PI / 2),
    ]);
  };

  A.fountain = () => mergeParts([
    part(cyl(2.6, 2.7, 0.7, 16), P.stone, 0, 0.35, 0),
    part(cyl(2.35, 2.35, 0.12, 16), P.water, 0, 0.68, 0),
    part(cyl(0.34, 0.44, 1.5, 10), shade(P.stone, 1.1), 0, 1.1, 0),
    part(cyl(1.0, 0.5, 0.24, 12), shade(P.stone, 1.16), 0, 1.9, 0),
    part(cyl(0.14, 0.14, 0.7, 6), P.water, 0, 2.3, 0),
  ]);

  A.hut = () => {
    const parts = [
      part(box(4.4, 2.7, 4.4), P.hut, 0, 1.35, 0),
      part(box(0.9, 1.7, 0.12), '#3a2c22', 0, 0.85, 2.2),
      part(box(1.5, 0.9, 0.12), P.win, -1.4, 1.8, 2.2),
      part(box(1.5, 0.9, 0.12), P.win, 1.4, 1.8, 2.2),
    ];
    parts.push(part(cone(3.6, 1.7, 4), P.roof, 0, 3.55, 0, 0, Math.PI / 4, 0));
    return mergeParts(parts);
  };

  A.block = () => {
    const w = 8.2, d = 8.2, h = 13;
    const wall = pick(P.walls);
    const parts = [part(box(w, 1.1, d), shade(wall, 0.86), 0, 0.55, 0)];  // plinth
    facade(parts, w, d, h - 1.1, 1.1, 5, wall, P.win);
    parts.push(part(box(w + 0.5, 0.5, d + 0.5), shade(wall, 0.8), 0, h + 0.2, 0));
    parts.push(part(box(2.2, 0.9, 2.0), shade(wall, 0.9), -1.6, h + 0.9, 1.2));
    return mergeParts(parts);
  };

  A.tower = () => {
    const wall = pick(P.walls);
    const parts = [part(box(11, 1.4, 11), shade(wall, 0.86), 0, 0.7, 0)];
    facade(parts, 11, 11, 15.6, 1.4, 6, wall, P.win);
    facade(parts, 8.4, 8.4, 13, 17.3, 5, shade(wall, 1.06), P.win);
    facade(parts, 5.4, 5.4, 10, 30.2, 4, shade(wall, 1.12), P.win);
    parts.push(part(box(11.6, 0.5, 11.6), shade(wall, 0.78), 0, 17.1, 0));
    parts.push(part(box(9, 0.5, 9), shade(wall, 0.78), 0, 30.1, 0));
    parts.push(part(box(5.8, 0.5, 5.8), shade(wall, 0.78), 0, 40.3, 0));
    parts.push(part(cyl(0.16, 0.24, 6, 6), '#8a8a95', 0, 43.4, 0));
    parts.push(part(sph(0.34), '#ff4d4d', 0, 46.5, 0));
    return mergeParts(parts);
  };

  return A;
}

// ---------------------------------------------------------------------------
// Maps — three worlds, one generator. A map supplies a palette, a road/path
// network, a ground painter and a density table; nothing else differs.
// ---------------------------------------------------------------------------
const MAPS = [
  {
    key: 'city',
    name: 'Downtown',
    sky: ['#2b4a80', '#f4bd85'],
    fog: 0xd6b79a, fogNear: 80, fogFar: 330,
    sunColor: 0xffe0b0, sunI: 2.0, hemiSky: 0x9fc4ff, hemiGround: 0x3a3038, hemiI: 1.2,
    ground: { base: '#3a3a44', road: '#2b2b33', walk: '#83838f', line: '#efe6cd', grass: '#4e7a45' },
    outer: '#2a2a34',
    border: { color: '#6a6a76', h: 0.9 },
    surround: 'towers',
    palette: {
      people: ['#e05f5f', '#4f8fd0', '#e8c05a', '#5fb98a', '#d9d9e2', '#b06fc4'],
      cars: ['#d8443f', '#3d6fbd', '#e0e0e6', '#4a4e5c', '#e2a33c', '#4fa87c'],
      walls: ['#b9b2a6', '#9aa3ad', '#c4a894', '#8f9298', '#cbbfae'],
      win: '#7a7e8c', roof: '#8a5a48', hut: '#c2b39c',
      foliage: '#4b7d3f', trunk: '#6b503a', wood: '#a9814f', metal: '#5a5a66',
      lamp: '#ffdca8', stone: '#a8a29a', water: '#5aa8c8', rock: '#8a8a92',
      sign: '#dcdce4', hydrant: '#d2493f', bus: ['#e0b23c', '#c8503f', '#4a7fc0'], parasol: '#d8654f',
    },
    density: {
      tower: 22, block: 46, hut: 26, fountain: 4, bus: 16, van: 34, car: 96,
      tree: 130, palm: 0, planter: 34, parasol: 0, light: 108, bench: 52,
      rock: 12, bush: 74, sign: 62, hydrant: 54, person: 190,
    },
  },
  {
    key: 'park',
    name: 'Bayside',
    sky: ['#3f86d8', '#c8e4f6'],
    fog: 0xc6e0f0, fogNear: 95, fogFar: 350,
    sunColor: 0xfff6e0, sunI: 2.1, hemiSky: 0xbfe0ff, hemiGround: 0x4a5a3a, hemiI: 1.25,
    ground: { base: '#5d8f4d', road: '#bda57c', walk: '#cbb68d', line: '#e8dcc0', grass: '#5d8f4d' },
    outer: '#2f7fb5',
    border: { color: '#d9c896', h: 0.55 },
    surround: 'islands',
    palette: {
      people: ['#f0f0f4', '#59b0e0', '#f2c14e', '#e8776a', '#7fd0a8', '#c78fd8'],
      cars: ['#e4e4ea', '#4f8fd0', '#d8544c', '#5fb98a'],
      walls: ['#e6dcc6', '#d6c6a8', '#cfd8dc'],
      win: '#9fd8e8', roof: '#c06a4c', hut: '#e2d6bc',
      foliage: '#3f8f42', trunk: '#7a5b3c', wood: '#b8934f', metal: '#6a7078',
      lamp: '#fff0c8', stone: '#c8c2b2', water: '#3f9fd0', rock: '#9a968e',
      sign: '#e8e8ee', hydrant: '#d2493f', bus: '#5fb0d8', parasol: '#e8705c',
    },
    density: {
      tower: 0, block: 16, hut: 40, fountain: 12, bus: 0, van: 6, car: 18,
      tree: 240, palm: 74, planter: 26, parasol: 62, light: 58, bench: 84,
      rock: 74, bush: 150, sign: 30, hydrant: 18, person: 220,
    },
  },
  {
    key: 'plaza',
    name: 'Skydeck',
    sky: ['#17264d', '#86aede'],
    fog: 0xa8bede, fogNear: 85, fogFar: 320,
    sunColor: 0xffd8e0, sunI: 1.7, hemiSky: 0x9fb8e8, hemiGround: 0x3a3a48, hemiI: 1.15,
    ground: { base: '#9a9aa4', road: '#c8c8d4', walk: '#7e7e88', line: '#e2e2ea', grass: '#5f8a58' },
    outer: '#dce6f2',
    border: { color: '#b0b0ba', h: 1.25 },
    surround: 'spires',
    palette: {
      people: ['#f4f4f8', '#5f8fd0', '#e8b84c', '#e0706a', '#6fc8a8', '#b78fd8'],
      cars: ['#dcdce4', '#48485a', '#8f9fb8'],
      walls: ['#c8ccd4', '#aab2c0', '#dcd6cc'],
      win: '#93b6cc', roof: '#7a8390', hut: '#cdd2da',
      foliage: '#4f8f5c', trunk: '#6e5a44', wood: '#9a8f7c', metal: '#7a8090',
      lamp: '#fff2d0', stone: '#c0c4cc', water: '#6fb8d8', rock: '#9aa0a8',
      sign: '#e4e8f0', hydrant: '#c4544a', bus: '#8f9fb8', parasol: '#e08a6a',
    },
    density: {
      tower: 8, block: 30, hut: 34, fountain: 14, bus: 0, van: 6, car: 14,
      tree: 96, palm: 40, planter: 78, parasol: 44, light: 84, bench: 96,
      rock: 40, bush: 108, sign: 44, hydrant: 20, person: 240,
    },
  },
];

// which zones each prop may stand in — one table, all three maps
const ZONES = {
  car: ['road'], van: ['road'], bus: ['road'],
  light: ['walk'], hydrant: ['walk'], sign: ['walk'], planter: ['walk'],
  bench: ['walk', 'open'], person: ['walk', 'open', 'sand'],
  parasol: ['sand', 'open'], rock: ['open', 'sand'], palm: ['open', 'sand'],
  tree: ['open'], bush: ['open'], hut: ['open'], block: ['open'],
  tower: ['open'], fountain: ['open'],
};

// ---------------------------------------------------------------------------
// Road networks — segments and rings, shared by the painter and the placer
// ---------------------------------------------------------------------------
function makeRoads(def) {
  const roads = [];
  if (def.key === 'city') {
    const g = [-100, -60, -20, 20, 60, 100];
    for (const v of g) {
      roads.push({ t: 'seg', ax: v, az: -HALF, bx: v, bz: HALF, w: 9 });
      roads.push({ t: 'seg', ax: -HALF, az: v, bx: HALF, bz: v, w: 9 });
    }
    // one wide avenue through the middle to break the uniformity
    roads.push({ t: 'seg', ax: -HALF, az: 0, bx: HALF, bz: 0, w: 15 });
  } else if (def.key === 'plaza') {
    for (const r of [24, 48, 72, 94]) roads.push({ t: 'ring', r, w: 5.5 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      roads.push({ t: 'seg', ax: 0, az: 0, bx: Math.cos(a) * HALF, bz: Math.sin(a) * HALF, w: 5 });
    }
  } else {
    // park: three meandering paths sampled from sine curves
    for (let k = 0; k < 3; k++) {
      const pts = [];
      const phase = k * 2.1;
      const off = -60 + k * 58;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const x = -HALF + t * ARENA;
        pts.push([x, off + Math.sin(t * 4.2 + phase) * 26 + Math.sin(t * 9 + phase) * 7]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        roads.push({ t: 'seg', ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], w: 4.5 });
      }
    }
    // a crossing promenade
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const z = -HALF + t * ARENA;
      pts.push([Math.sin(t * 3.4) * 34 - 6, z]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      roads.push({ t: 'seg', ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], w: 5 });
    }
  }
  return roads;
}

// signed distance to the nearest road surface: <0 means "on the road"
function roadDist(x, z, roads) {
  let best = 1e9;
  for (const r of roads) {
    let d;
    if (r.t === 'ring') {
      d = Math.abs(Math.hypot(x, z) - r.r);
    } else {
      const ex = r.bx - r.ax, ez = r.bz - r.az;
      const wx = x - r.ax, wz = z - r.az;
      const t = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1);
      d = Math.hypot(wx - ex * t, wz - ez * t);
    }
    best = Math.min(best, d - r.w / 2);
  }
  return best;
}

// the beach: a wavy band along the far edge of the park map
const sandAt = (x, z) => z > 44 + Math.sin(x * 0.045) * 12 + Math.sin(x * 0.11) * 4;

function zoneOf(x, z, def, roads) {
  const d = roadDist(x, z, roads);
  if (d < 0) return 'road';
  if (d < 3.4) return 'walk';
  if (def.key === 'park' && sandAt(x, z)) return 'sand';
  return 'open';
}

// ---------------------------------------------------------------------------
// Ground texture — painted once per map from the same road network
// ---------------------------------------------------------------------------
const TEX_SIZE = 2048;
const PPM = TEX_SIZE / ARENA;
const px = (v) => (v + HALF) * PPM;

function strokeRoads(g, roads, width, color, dashed) {
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const r of roads) {
    g.lineWidth = (r.w + width) * PPM;
    if (dashed) {
      g.lineWidth = Math.max(1.5, 0.4 * PPM);
      g.setLineDash([3.4 * PPM, 3.4 * PPM]);
    }
    g.beginPath();
    if (r.t === 'ring') g.arc(px(0), px(0), r.r * PPM, 0, TAU);
    else { g.moveTo(px(r.ax), px(r.az)); g.lineTo(px(r.bx), px(r.bz)); }
    g.stroke();
  }
  g.setLineDash([]);
}

// low-frequency value noise keeps big flat areas from reading as plastic.
// Painted small and scaled up: 64k typed-array writes instead of 65k fillRects.
function mottle(g, S, alpha, scale) {
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const d = img.data;
  const k = (S / N) * scale;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const n = vnoise(x * k, y * k);
      const i = (y * N + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = n > 0.5 ? 255 : 0;
      d[i + 3] = Math.abs(n - 0.5) * 2 * alpha * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  g.drawImage(c, 0, 0, S, S);
}

function paintGround(def, roads) {
  return canvasTex(TEX_SIZE, TEX_SIZE, (g, S) => {
    const C = def.ground;
    g.fillStyle = C.base;
    g.fillRect(0, 0, S, S);

    if (def.key === 'city') {
      // a couple of green blocks so downtown isn't wall-to-wall grey
      g.fillStyle = C.grass;
      for (const [bx, bz] of [[-80, 40], [40, -80], [80, 80]]) {
        g.fillRect(px(bx - 15.5), px(bz - 15.5), 31 * PPM, 31 * PPM);
      }
      mottle(g, S, 0.16, 0.006);
      strokeRoads(g, roads, 6.6, C.walk);
      strokeRoads(g, roads, 0, C.road);
      strokeRoads(g, roads, 0, 'rgba(239,230,205,.55)', true);
    } else if (def.key === 'plaza') {
      mottle(g, S, 0.1, 0.01);
      // tile grid
      g.strokeStyle = 'rgba(0,0,0,.14)';
      g.lineWidth = Math.max(1, 0.09 * PPM);
      for (let i = 0; i <= 40; i++) {
        const p = (i / 40) * S;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
      }
      strokeRoads(g, roads, 2.4, C.walk);
      strokeRoads(g, roads, 0, C.road);
      // centre medallion
      g.fillStyle = C.road;
      g.beginPath(); g.arc(px(0), px(0), 13 * PPM, 0, TAU); g.fill();
      g.strokeStyle = C.line;
      g.lineWidth = 0.5 * PPM;
      for (const rr of [6, 10, 12.4]) { g.beginPath(); g.arc(px(0), px(0), rr * PPM, 0, TAU); g.stroke(); }
    } else {
      mottle(g, S, 0.22, 0.011);
      // shoreline: sand band along the +z edge, drawn as a filled wave
      g.fillStyle = '#e2cf9e';
      g.beginPath();
      g.moveTo(0, S);
      for (let i = 0; i <= 96; i++) {
        const x = -HALF + (i / 96) * ARENA;
        const z = 44 + Math.sin(x * 0.045) * 12 + Math.sin(x * 0.11) * 4;
        g.lineTo(px(x), px(z));
      }
      g.lineTo(S, S);
      g.closePath();
      g.fill();
      // wet sand darkening at the very edge
      g.fillStyle = 'rgba(150,130,86,.28)';
      g.fillRect(0, px(HALF - 9), S, 9 * PPM);
      strokeRoads(g, roads, 1.6, C.walk);
      strokeRoads(g, roads, 0, C.road);
    }
  });
}

// ---------------------------------------------------------------------------
// The ground, and the holes punched through it
// ---------------------------------------------------------------------------
// One vec3 per hole: xy = centre in world XZ, z = radius. Parked far away with
// radius 0 when a slot is unused. The array is mutated in place every frame —
// the shader never recompiles.
const holeU = [];
for (let i = 0; i < HOLE_MAX; i++) holeU.push(new THREE.Vector3(1e5, 1e5, 0));

function makeGroundMaterial(tex) {
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoles = { value: holeU };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uHoles[${HOLE_MAX}];
        varying vec3 vWPos;`)
      .replace('#include <map_fragment>', `
        float dmin = 1e9;
        float lip = 0.0;
        for (int i = 0; i < ${HOLE_MAX}; i++) {
          float d = length(vWPos.xz - uHoles[i].xy) - uHoles[i].z;
          dmin = min(dmin, d);
          // the shadow band scales with the hole, so a small pit doesn't wear
          // a halo three times its own width
          lip = max(lip, 1.0 - smoothstep(0.0, max(0.35, uHoles[i].z * 0.42), d));
        }
        if (dmin < 0.0) discard;
        #include <map_fragment>
        diffuseColor.rgb *= mix(1.0, 0.14, lip);`);
  };
  return mat;
}

// the shaft you see down through the opening: an inward-facing cone, capped so
// you never see daylight through the bottom. It is flat black — a hole is an
// absence, and any wall shading at all made it read as a grey bowl painted on
// the ground rather than a pit. Unlit and unfogged, so a hole across the
// arena is exactly as black as the one at your feet, and the props tumbling
// down it are the only thing in there catching light.
function makeShaftGeo() {
  const g = new THREE.CylinderGeometry(1, 0.72, 1, 28, 4, true);
  g.translate(0, -0.5, 0);
  return g;
}

const SHAFT_GEO = makeShaftGeo();
const SHAFT_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, fog: false });
const CAP_GEO = new THREE.CircleGeometry(0.72, 28).rotateX(-Math.PI / 2);
const CAP_MAT = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });
// RingGeometry's own UVs are square-mapped; re-map them radially so a simple
// 1D gradient fades outward from the rim
function radialRing(inner, outer, seg) {
  const g = new THREE.RingGeometry(inner, outer, seg).rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const d = Math.hypot(p.getX(i), p.getZ(i));
    uv.setXY(i, 0.5, clamp((d - inner) / (outer - inner), 0, 1));
  }
  return g;
}

const RIM_GEO = new THREE.RingGeometry(1, 1.055, 56).rotateX(-Math.PI / 2);
const GLOW_GEO = radialRing(1, 1.5, 56);

// radial falloff for the ember glow that hugs the rim: opaque at v=0 (the rim)
// fading to nothing at v=1. CanvasTexture flips Y, so v=0 is the last row.
const glowTex = canvasTex(8, 64, (g, w, h) => {
  const grd = g.createLinearGradient(0, h, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
});

function makeHoleVisual(colorHex) {
  const grp = new THREE.Group();
  const shaft = new THREE.Mesh(SHAFT_GEO, SHAFT_MAT);
  shaft.scale.set(1, SHAFT_DEPTH, 1);
  grp.add(shaft);
  const cap = new THREE.Mesh(CAP_GEO, CAP_MAT);
  cap.position.y = -SHAFT_DEPTH;
  grp.add(cap);
  const rim = new THREE.Mesh(RIM_GEO, new THREE.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 0.95, depthWrite: false, fog: false,
  }));
  rim.position.y = 0.02;
  grp.add(rim);
  const glow = new THREE.Mesh(GLOW_GEO, new THREE.MeshBasicMaterial({
    color: colorHex, map: glowTex, transparent: true, opacity: 0.26,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  glow.position.y = 0.015;
  grp.add(glow);
  return grp;
}

// ---------------------------------------------------------------------------
// World: ground mesh, sky dome, distant surround, border, props
// ---------------------------------------------------------------------------
const world = new THREE.Group();
scene.add(world);

// Props carry a per-instance fade so anything standing between the camera and
// your hole can dissolve out of the way. It is *dithered*, not blended: the
// material stays in the opaque pass, keeps writing depth, and needs no
// sorting — a transparent instanced mesh would have to pick one draw order for
// a thousand buildings and get it wrong for most of them.
const PROP_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
PROP_MAT.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute float aFade;
      varying float vFade;`)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFade = aFade;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying float vFade;
      // interleaved gradient noise: a fine, non-repeating screen-door pattern
      float sinkDither(vec2 p) {
        return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
      }`)
    .replace('#include <map_fragment>', `
      if (vFade < 0.995 && sinkDither(gl_FragCoord.xy) > vFade) discard;
      #include <map_fragment>`);
};
const VARIANTS = { person: 3, car: 3, van: 2, tree: 3, bush: 3, block: 3, tower: 2 };

let mapDef = null;
let groundTex = null;
let groundMesh = null;
const meshesByKind = {};
const objs = [];
// everything tall enough to be worth hiding behind — the occluder pass walks
// this directly rather than the broadphase grid, which only ever knew where a
// prop's footprint was
const tall = [];
let grid = [];
let disposables = [];

const gridIdx = (x, z) => {
  const cx = clamp(Math.floor((x + HALF) / CELL) + 1, 0, GRID_N - 1);
  const cz = clamp(Math.floor((z + HALF) / CELL) + 1, 0, GRID_N - 1);
  return cz * GRID_N + cx;
};

function spaceFree(x, z, r) {
  const span = Math.ceil((r + 8) / CELL);
  const cx = Math.floor((x + HALF) / CELL) + 1;
  const cz = Math.floor((z + HALF) / CELL) + 1;
  for (let j = cz - span; j <= cz + span; j++) {
    if (j < 0 || j >= GRID_N) continue;
    for (let i = cx - span; i <= cx + span; i++) {
      if (i < 0 || i >= GRID_N) continue;
      const bucket = grid[j * GRID_N + i];
      for (let k = 0; k < bucket.length; k++) {
        const o = bucket[k];
        const dx = o.x - x, dz = o.z - z;
        const min = o.r + r + 0.55;
        if (dx * dx + dz * dz < min * min) return false;
      }
    }
  }
  return true;
}

function sampleRoad(roads) {
  const r = pick(roads);
  const off = (Math.random() < 0.5 ? -1 : 1) * r.w * 0.23;
  if (r.t === 'ring') {
    // +Z of the model runs along the tangent, which is -a in this convention
    const a = rand(0, TAU);
    return { x: Math.cos(a) * (r.r + off), z: Math.sin(a) * (r.r + off), rot: -a + (off > 0 ? 0 : Math.PI) };
  }
  const t = Math.random();
  const ang = Math.atan2(r.bx - r.ax, r.bz - r.az);
  const nx = Math.cos(ang), nz = -Math.sin(ang);
  return {
    x: lerp(r.ax, r.bx, t) + nx * off,
    z: lerp(r.az, r.bz, t) + nz * off,
    rot: ang + (off > 0 ? 0 : Math.PI),
  };
}

function disposeWorld() {
  for (const d of disposables) {
    if (d.geometry) d.geometry.dispose();
    if (d.material && d.material.dispose && d.material !== PROP_MAT) d.material.dispose();
    if (d.isTexture) d.dispose();
  }
  disposables = [];
  world.clear();
  objs.length = 0;
  tall.length = 0;
  falling.length = 0;
  wobbling.length = 0;
  fading.clear();
  for (const k of Object.keys(meshesByKind)) delete meshesByKind[k];
}

function buildWorld(def) {
  disposeWorld();
  mapDef = def;

  scene.fog.color.set(def.fog);
  scene.fog.near = def.fogNear;
  scene.fog.far = def.fogFar;
  sun.color.set(def.sunColor);
  sun.intensity = def.sunI;
  hemi.color.set(def.hemiSky);
  hemi.groundColor.set(def.hemiGround);
  hemi.intensity = def.hemiI;

  const roads = makeRoads(def);
  const archetypes = buildArchetypes(def.palette);

  // sky dome
  const skyTex = canvasTex(4, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, def.sky[0]);
    grd.addColorStop(1, def.sky[1]);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(560, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  world.add(sky);
  disposables.push(sky, skyTex);

  // ground + the shader that opens it
  groundTex = paintGround(def, roads);
  const gGeo = new THREE.PlaneGeometry(ARENA, ARENA, 72, 72).rotateX(-Math.PI / 2);
  groundMesh = new THREE.Mesh(gGeo, makeGroundMaterial(groundTex));
  groundMesh.renderOrder = -1;
  world.add(groundMesh);
  disposables.push(groundMesh, groundTex);

  // everything beyond the playfield — unlit so it stays a predictable backdrop
  // instead of catching the sun and reading as more playable ground
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: def.outer })
  );
  outer.position.y = def.key === 'plaza' ? -44 : -0.06;
  world.add(outer);
  disposables.push(outer);
  buildSurround(def);
  buildBorder(def);

  // props, biggest first so the towers get the room they need
  grid = new Array(GRID_N * GRID_N);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  const order = KINDS.slice().sort((a, b) => SPECS[b].r - SPECS[a].r);
  for (const k of order) {
    const want = def.density[k] | 0;
    if (!want) continue;
    const spec = SPECS[k];
    const nv = VARIANTS[k] || 1;
    const meshes = [];
    const heights = [];
    for (let v = 0; v < nv; v++) {
      const geo = archetypes[k]();
      const cap = Math.ceil(want / nv) + 8;
      const m = new THREE.InstancedMesh(geo, PROP_MAT, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      // every geometry drawn with PROP_MAT must carry aFade — a missing
      // attribute reads as 0 in GLSL, which would dither the prop away entirely
      const fades = new Float32Array(cap).fill(1);
      geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(fades, 1));
      geo.computeBoundingBox();
      heights.push(geo.boundingBox.max.y);
      world.add(m);
      disposables.push(m);
      meshes.push(m);
    }
    meshesByKind[k] = meshes;

    const zones = ZONES[k];
    const onRoad = zones[0] === 'road';
    const bulky = spec.r > 2;
    for (let n = 0; n < want; n++) {
      let x = 0, z = 0, rotY = 0, ok = false;
      const s = rand(0.88, 1.18) * (spec.r > 4 ? rand(0.85, 1.15) : 1);
      const r = spec.r * s;
      for (let tries = 0; tries < 40; tries++) {
        if (onRoad) {
          const p = sampleRoad(roads);
          x = p.x; z = p.z; rotY = p.rot;
        } else {
          x = rand(-HALF + 2.5, HALF - 2.5);
          z = rand(-HALF + 2.5, HALF - 2.5);
          if (zones.indexOf(zoneOf(x, z, def, roads)) === -1) continue;
          // a building's whole footprint has to clear the kerb, not just its centre
          if (bulky && roadDist(x, z, roads) < r * 0.85) continue;
          // buildings line up with the street grid; nature does not
          rotY = bulky ? Math.round(rand(0, 4)) * (Math.PI / 2) : rand(0, TAU);
        }
        if (Math.abs(x) > HALF - r - 1.5 || Math.abs(z) > HALF - r - 1.5) continue;
        if (!spaceFree(x, z, r)) continue;
        ok = true;
        break;
      }
      if (!ok) continue;

      const mi = n % nv;
      const mesh = meshes[mi];
      const idx = mesh.count++;
      const o = {
        k, x, z, y: 0, r, s, rotY, mesh, idx,
        h: heights[mi] * s,
        growth: spec.growth * s * s,
        pts: Math.round(spec.pts * s * s),
        state: 0, vy: 0, vx: 0, vz: 0, tiltX: 0, tiltZ: 0, spin: 0, wob: 0,
        tilt: 0, av: 0, tipping: 0, tipRate: 0, axX: 0, axZ: 0, swirl: 0,
        fade: 1, fadeT: 1, fmark: -1,
        fscale: 1, hole: null, counted: 0,
      };
      objs.push(o);
      if (o.h >= FADE_MIN_H) tall.push(o);
      grid[gridIdx(x, z)].push(o);
      writeMatrix(o);
      _col.set('#ffffff').multiplyScalar(rand(0.86, 1.1));
      mesh.setColorAt(idx, _col);
    }
    for (const m of meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
}

function writeMatrix(o) {
  const s = o.s * o.fscale;
  _q.setFromEuler(_e.set(o.tiltX, o.rotY, o.tiltZ, 'YXZ'));
  _m4.compose(_v3.set(o.x, o.y, o.z), _q, _scl.set(s, s, s));
  o.mesh.setMatrixAt(o.idx, _m4);
  o.mesh.instanceMatrix.needsUpdate = true;
}

function buildSurround(def) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  let n, mat, lo, hi;
  // kept close enough that the horizon is never empty from inside the arena
  if (def.surround === 'towers') {
    n = 150; lo = 112; hi = 330;
    mat = new THREE.MeshLambertMaterial({ color: '#3d4657' });
  } else if (def.surround === 'islands') {
    n = 44; lo = 130; hi = 320;
    mat = new THREE.MeshLambertMaterial({ color: '#4c7a52' });
  } else {
    n = 110; lo = 108; hi = 320;
    mat = new THREE.MeshLambertMaterial({ color: '#6c7c96' });
  }
  const mesh = new THREE.InstancedMesh(g, mat, n);
  mesh.frustumCulled = false;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand(-0.03, 0.03);
    const d = rand(lo, hi);
    let sx, sy, sz, y;
    if (def.surround === 'islands') {
      sx = rand(22, 70); sy = rand(3, 11); sz = rand(22, 70); y = sy / 2 - 1;
    } else if (def.surround === 'spires') {
      sx = rand(9, 20); sy = rand(30, 110); sz = rand(9, 20); y = -44 + sy / 2;
    } else {
      sx = rand(9, 22); sy = rand(18, 90); sz = rand(9, 22); y = sy / 2;
    }
    _m4.compose(
      _v3.set(Math.cos(a) * d, y, Math.sin(a) * d),
      _q.setFromEuler(_e.set(0, rand(0, TAU), 0)),
      _scl.set(sx, sy, sz)
    );
    mesh.setMatrixAt(i, _m4);
  }
  world.add(mesh);
  disposables.push(mesh);
}

function buildBorder(def) {
  const mat = new THREE.MeshLambertMaterial({ color: def.border.color });
  const h = def.border.h;
  const parts = [
    [ARENA + 1.2, h, 0.6, 0, h / 2, -HALF],
    [ARENA + 1.2, h, 0.6, 0, h / 2, HALF],
    [0.6, h, ARENA + 1.2, -HALF, h / 2, 0],
    [0.6, h, ARENA + 1.2, HALF, h / 2, 0],
  ];
  for (const [w, hh, d, x, y, z] of parts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat);
    m.position.set(x, y, z);
    world.add(m);
    disposables.push(m);
  }
}

// ---------------------------------------------------------------------------
// Holes
// ---------------------------------------------------------------------------
const holes = [];
let player = null;
let tNow = 0;

// Bigger is slower — the core trade the whole match is built on.
const speedFor = (r) => BASE_SPEED * clamp(Math.pow(r / START_R, -SPEED_FALL), SPEED_FLOOR, 1);
const accelFor = (r) => ACCEL * lerp(1, ACCEL_HEAVY, clamp((r - START_R) / 9, 0, 1));

function makeHole(name, color, isPlayer) {
  const h = {
    name, color, isPlayer,
    x: 0, z: 0, area: START_AREA, drawR: START_R, targetR: START_R,
    vx: 0, vz: 0, score: 0, alive: true, dead: 0, skill: 1,
    target: null, retarget: 0, dawdle: 0, wobble: rand(0, TAU),
    vis: makeHoleVisual(color),
  };
  scene.add(h.vis);
  return h;
}

function growHole(h, area) {
  h.area += area;
  h.targetR = Math.sqrt(h.area / Math.PI);
}

function placeHole(h, awayFromOthers) {
  for (let tries = 0; tries < 60; tries++) {
    const x = rand(-HALF + 14, HALF - 14);
    const z = rand(-HALF + 14, HALF - 14);
    let ok = true;
    if (awayFromOthers) {
      for (const o of holes) {
        if (o === h || !o.alive) continue;
        if (Math.hypot(o.x - x, o.z - z) < 34) { ok = false; break; }
      }
    }
    if (!ok) continue;
    h.x = x;
    h.z = z;
    return;
  }
  h.x = rand(-60, 60);
  h.z = rand(-60, 60);
}

function stepHole(h, dt, dirX, dirZ) {
  const sp = speedFor(h.drawR);
  const k = accelFor(h.drawR);
  h.vx = damp(h.vx, dirX * sp, k, dt);
  h.vz = damp(h.vz, dirZ * sp, k, dt);
  h.x += h.vx * dt;
  h.z += h.vz * dt;
  const lim = HALF - h.drawR - 0.5;
  if (h.x < -lim || h.x > lim) {
    h.x = clamp(h.x, -lim, lim);
    h.vx *= -0.15;
    if (h.isPlayer) edgeBump();
  }
  if (h.z < -lim || h.z > lim) {
    h.z = clamp(h.z, -lim, lim);
    h.vz *= -0.15;
    if (h.isPlayer) edgeBump();
  }
}

let edgeCool = 0;
function edgeBump() {
  if (edgeCool > 0) return;
  edgeCool = 0.5;
  navigator.vibrate?.(8);
  AudioFX.thud(0.3, 90);
}

function syncHoleVisual(h) {
  const v = h.vis;
  v.visible = h.alive;
  v.position.set(h.x, 0, h.z);
  // the group scales in XZ only — the shaft keeps its own full-depth Y scale
  v.scale.set(h.drawR, 1, h.drawR);
}

// push the live holes into the ground shader; unused slots park off-map
function pushHoleUniforms() {
  let n = 0;
  for (const h of holes) {
    if (!h.alive || !h.vis.visible) continue;
    holeU[n].set(h.x, h.z, h.drawR);
    n++;
    if (n >= HOLE_MAX) break;
  }
  for (let i = n; i < HOLE_MAX; i++) holeU[i].set(1e5, 1e5, 0);
}

// ---------------------------------------------------------------------------
// Swallowing
// ---------------------------------------------------------------------------
const falling = [];
const wobbling = [];

function removeFromGrid(o) {
  const b = grid[gridIdx(o.x, o.z)];
  const i = b.indexOf(o);
  if (i >= 0) {
    b[i] = b[b.length - 1];
    b.pop();
  }
}

// A thing does not drop the moment the rim reaches it: it overbalances, tips
// over the edge, *then* falls — and once it's in the shaft it spirals down the
// wall rather than sliding down a drainpipe. Everything below is scaled by the
// prop's size, so a bench whips over and a tower groans.
//
// What it must never do is *hover*. The ground under it is already gone by the
// time this runs, so it leaves with weight: a real downward push, full gravity
// from the first frame, and only a nudge inward. Starting from rest and easing
// gravity in is what used to make props look untethered — sliding across the
// opening for a beat before remembering to fall.
function startFall(o, h) {
  o.state = 1;
  o.hole = h;
  o.counted = 0;
  const dx = h.x - o.x, dz = h.z - o.z;
  const d = Math.max(0.001, Math.hypot(dx, dz));
  const nx = dx / d, nz = dz / d;

  // heavy things carry their weight into the pit; light things get flung
  const heft = clamp(o.r / 3.2, 0.12, 1);
  const kick = lerp(1.7, 0.55, heft);
  // inherit a share of the hole's own motion — being swallowed by a moving
  // hole should throw you the way it's travelling
  o.vx = nx * kick * rand(0.7, 1.15) + h.vx * 0.3;
  o.vz = nz * kick * rand(0.7, 1.15) + h.vz * 0.3;
  o.vy = -lerp(2.6, 1.0, heft) * rand(0.85, 1.15);

  // tangential kick: which way it swirls depends on which side of centre it
  // went in, so the shaft reads as a funnel and not a chute
  const side = Math.sign(-nz * (o.x - h.x) + nx * (o.z - h.z)) || (Math.random() < 0.5 ? -1 : 1);
  o.swirl = side * lerp(3.2, 1.0, heft) * rand(0.6, 1.2);

  // it pivots about the rim: axis is horizontal, perpendicular to the fall
  o.axX = nx;
  o.axZ = nz;
  o.tilt = 0;
  o.tipRate = lerp(15, 3.4, heft) * rand(0.85, 1.15);   // rad/s² over the edge
  o.av = 0;
  o.tipping = 1;
  o.spin = rand(-1, 1) * lerp(4.5, 0.9, heft);          // yaw tumble
  o.fscale = 1;
  // a blocker that gets swallowed must go back to solid on the way down —
  // nothing should tumble into the pit half-dithered
  if (o.fade !== 1) {
    o.fade = 1;
    o.fadeT = 1;
    fading.delete(o);
    writeFade(o);
  }
  removeFromGrid(o);
  falling.push(o);

  // the dust belongs to the collapse, which happens now; the points do not
  puff(o.x, o.z, o.r);
}

// Swallowed means swallowed. A prop that has only just tipped in could still
// be sitting proud of the rim, and paying out then is what made growth feel
// like it happened at arm's length — the hole banks it once half of it is
// under the ground, and not before.
function bank(o) {
  const h = o.hole;
  o.counted = 1;
  h.score += o.pts;
  growHole(h, o.growth * (h.isPlayer ? 1 : RIVAL_GROWTH));
  if (h.isPlayer) onPlayerEat(o);
}

function updateFalling(dt) {
  for (let i = falling.length - 1; i >= 0; i--) {
    const o = falling[i];
    const h = o.hole;

    // gravity is never held back: the tipping phase is a torque, not a reprieve
    o.vy -= G * dt;
    if (o.tipping) {
      o.av += o.tipRate * dt;
      o.tilt += o.av * dt;
      if (o.tilt > 1.25) o.tipping = 0;
    } else {
      o.tilt += o.av * dt;
      o.av *= 1 - 0.6 * dt;            // air drag on the tumble
    }

    // the funnel pulls harder the deeper you are, and spins you as it does
    const dx = h.x - o.x, dz = h.z - o.z;
    const d = Math.max(0.001, Math.hypot(dx, dz));
    const depth = clamp(-o.y / SHAFT_DEPTH, 0, 1);
    const pull = (12 + depth * 26) * dt;
    o.vx += (dx / d) * pull;
    o.vz += (dz / d) * pull;
    // swirl acts along the tangent and bleeds off as it descends
    const tx = -dz / d, tz = dx / d;
    o.vx += tx * o.swirl * dt * 6;
    o.vz += tz * o.swirl * dt * 6;
    o.swirl *= 1 - 1.1 * dt;

    o.x += o.vx * dt;
    o.z += o.vz * dt;
    o.y += o.vy * dt;

    // ride the shaft wall in instead of clipping through it: reflect only the
    // radial part of the velocity so the object keeps orbiting on the way down
    const wall = Math.max(0.15, h.drawR * (1 + (o.y / SHAFT_DEPTH) * 0.28) - o.r * 0.45);
    const dd = Math.hypot(o.x - h.x, o.z - h.z);
    if (dd > wall) {
      const ux = (o.x - h.x) / dd, uz = (o.z - h.z) / dd;
      o.x = h.x + ux * wall;
      o.z = h.z + uz * wall;
      const vr = o.vx * ux + o.vz * uz;
      if (vr > 0) {
        o.vx -= vr * 1.35 * ux;        // 0.35 restitution off the dirt
        o.vz -= vr * 1.35 * uz;
        o.av += vr * 0.35 * (Math.random() < 0.5 ? -1 : 1);  // scraping torque
      }
      o.vx *= 0.97;                    // wall friction, tangential only
      o.vz *= 0.97;
    }

    // pivoting toward the hole: rotate about the axis perpendicular to the fall
    o.tiltX = o.axZ * o.tilt;
    o.tiltZ = -o.axX * o.tilt;
    o.rotY += o.spin * dt;

    // half of it under the ground is the moment it stops being a thing on the
    // street and starts being score
    if (!o.counted && o.y <= -o.h * 0.5) bank(o);

    // the funnel narrows with depth, so anything still riding it down tapers —
    // but only once it is a full body-length under, so nothing visibly shrinks
    // while part of it is still standing above the rim
    o.fscale = clamp(1 - (-o.y - o.h) / 14, 0.25, 1);

    // ...and it dissolves as the last of it drops past the rim, instead of
    // being switched off at a fixed depth. A tower and a bench both vanish at
    // the same moment in their own fall: the moment you can no longer see them.
    const top = o.y + o.h * o.fscale;
    const fade = Math.min(
      clamp(1 + top / 3.5, 0, 1),
      clamp((o.y + SHAFT_DEPTH) / 5, 0, 1),   // and never in time to hit the floor
    );
    if (fade !== o.fade) {
      o.fade = fade;
      writeFade(o);
    }

    if (o.fade <= 0.01 || o.y < -SHAFT_DEPTH) {
      o.state = 2;
      o.mesh.setMatrixAt(o.idx, HIDE_M);
      o.mesh.instanceMatrix.needsUpdate = true;
      if (!o.counted) bank(o);   // it is gone; it counted
      falling[i] = falling[falling.length - 1];
      falling.pop();
      continue;
    }
    writeMatrix(o);
  }
}

function updateWobble(dt) {
  for (let i = wobbling.length - 1; i >= 0; i--) {
    const o = wobbling[i];
    o.wob -= dt * 1.9;
    if (o.wob <= 0 || o.state !== 0) {
      o.wob = 0;
      o.tiltX = 0;
      o.tiltZ = 0;
      if (o.state === 0) writeMatrix(o);
      wobbling[i] = wobbling[wobbling.length - 1];
      wobbling.pop();
      continue;
    }
    const a = Math.sin(tNow * 17 + o.idx) * 0.022 * o.wob;
    o.tiltX = a;
    o.tiltZ = a * 0.6;
    writeMatrix(o);
  }
}

// ---------------------------------------------------------------------------
// See-through blockers
// ---------------------------------------------------------------------------
// Anything standing on the line between the camera and your hole dissolves
// until it is out of the way. Only the player's view is worth protecting, so
// this walks a thin tube along one ray — a few dozen distance tests a frame.
const fading = new Set();
let fadeStamp = 0;

function writeFade(o) {
  const a = o.mesh.geometry.attributes.aFade;
  a.array[o.idx] = o.fade;
  a.needsUpdate = true;
}

// Closest approach between the sightline and a prop's *whole* column — base to
// roof, as one segment. Sampling a few heights on the axis and looking the prop
// up by the grid cell its footprint sits in meant a tower only counted while
// its feet were near the line; the part actually covering the hole was often
// the part that was never asked about. `_hitS` reports how far along the
// sightline the closest approach happened.
let _hitS = 0;
function rayVsColumn(cx0, cy0, cz0, ux, uy, uz, len, ox, oh, oz) {
  const ax = cx0 - ox, az = cz0 - oz;
  let bestD = Infinity;
  _hitS = 0;

  const consider = (s0, t0) => {
    const s = clamp(s0, 0, len);
    const t = clamp(t0, 0, oh);
    const ex = ax + s * ux;
    const ey = cy0 + s * uy - t;
    const ez = az + s * uz;
    const d = Math.hypot(ex, ey, ez);
    if (d < bestD) { bestD = d; _hitS = s; }
  };

  // where the sightline passes the column's axis in plan — the usual answer,
  // exact whenever that happens between the prop's feet and its roof
  const hh = ux * ux + uz * uz;
  if (hh > 1e-6) {
    const s = clamp(-(ax * ux + az * uz) / hh, 0, len);
    consider(s, cy0 + s * uy);
  }
  // ...and the two ends, for a sightline that clears the roof or dives under
  consider((ox - cx0) * ux + (0 - cy0) * uy + (oz - cz0) * uz, 0);
  consider((ox - cx0) * ux + (oh - cy0) * uy + (oz - cz0) * uz, oh);
  return bestD;
}

function markOccluders(h) {
  fadeStamp++;
  const cx0 = camera.position.x, cy0 = camera.position.y, cz0 = camera.position.z;
  const dx = h.x - cx0, dy = -cy0, dz = h.z - cz0;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // the sightline has to clear the whole opening, not just its centre
  const tube = h.drawR * 1.1 + 1.6;
  const planLen2 = dx * dx + dz * dz || 1;

  // Every standing prop, every frame. A few hundred distance tests is cheaper
  // than the broadphase that used to filter them, and it cannot miss one.
  for (let i = 0; i < tall.length; i++) {
    const o = tall[i];
    if (o.state !== 0) continue;
    const reach = o.r + tube;

    // plan-view reject first: flattening can only ever shrink the gap, so
    // anything this discards was never within `reach` in three dimensions
    let t = ((o.x - cx0) * dx + (o.z - cz0) * dz) / planLen2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const gx = o.x - (cx0 + dx * t), gz = o.z - (cz0 + dz * t);
    if (gx * gx + gz * gz > reach * reach) continue;

    if (rayVsColumn(cx0, cy0, cz0, ux, uy, uz, len, o.x, o.h, o.z) > reach) continue;
    // in front of the hole, not behind it — and anything right on top of the
    // camera stays in: that is precisely the tower whose footprint is off-screen
    if (_hitS > len - h.drawR * 0.35) continue;
    o.fadeT = FADE_MIN;
    o.fmark = fadeStamp;
    fading.add(o);
  }
}

function updateFades(dt) {
  for (const o of fading) {
    if (o.fmark !== fadeStamp) o.fadeT = 1;
    o.fade = damp(o.fade, o.fadeT, FADE_RATE, dt);
    if (o.fadeT >= 1 && o.fade > 0.995) {
      o.fade = 1;
      fading.delete(o);
    }
    writeFade(o);
  }
}

// walk only the grid cells the hole actually overlaps
function scanHole(h) {
  const r = h.drawR;
  const span = Math.ceil((r + 8) / CELL);
  const cx = Math.floor((h.x + HALF) / CELL) + 1;
  const cz = Math.floor((h.z + HALF) / CELL) + 1;
  const eatable = r * EAT_RATIO;
  for (let j = cz - span; j <= cz + span; j++) {
    if (j < 0 || j >= GRID_N) continue;
    for (let i = cx - span; i <= cx + span; i++) {
      if (i < 0 || i >= GRID_N) continue;
      const bucket = grid[j * GRID_N + i];
      for (let k = bucket.length - 1; k >= 0; k--) {
        const o = bucket[k];
        if (o.state !== 0) continue;
        const dx = o.x - h.x, dz = o.z - h.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > (r + o.r) * (r + o.r)) continue;
        if (o.r <= eatable) {
          const trig = r - o.r * TIP_BITE;
          if (d2 < trig * trig) startFall(o, h);
        } else if (o.wob <= 0 && d2 < r * r) {
          // too big to take: shiver so "not yet" reads as feedback, not a bug
          o.wob = 1;
          wobbling.push(o);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------
const PMAX = 300;
const pPos = new Float32Array(PMAX * 3);
const pCol = new Float32Array(PMAX * 3);
const pVel = new Float32Array(PMAX * 3);
const pLife = new Float32Array(PMAX);
let pHead = 0;

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
  map: puffTex, size: 0.85, sizeAttenuation: true, transparent: true,
  blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true, fog: false,
}));
points.frustumCulled = false;
scene.add(points);
for (let i = 0; i < PMAX; i++) pPos[i * 3 + 1] = -9999;

function puff(x, z, r) {
  const n = clamp(Math.round(3 + r * 2.2), 3, 14);
  for (let i = 0; i < n; i++) {
    const p = pHead;
    pHead = (pHead + 1) % PMAX;
    const a = rand(0, TAU);
    const sp = rand(0.6, 2.4) * (0.6 + r * 0.25);
    pPos[p * 3] = x + Math.cos(a) * r * 0.5;
    pPos[p * 3 + 1] = rand(0.1, 0.6);
    pPos[p * 3 + 2] = z + Math.sin(a) * r * 0.5;
    pVel[p * 3] = Math.cos(a) * sp;
    pVel[p * 3 + 1] = rand(1.0, 3.2);
    pVel[p * 3 + 2] = Math.sin(a) * sp;
    pLife[p] = rand(0.45, 0.9);
  }
}

function updateDust(dt) {
  for (let i = 0; i < PMAX; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) {
      pPos[i * 3 + 1] = -9999;
      pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0;
      continue;
    }
    pVel[i * 3 + 1] -= 5.5 * dt;
    pPos[i * 3] += pVel[i * 3] * dt;
    pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
    pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    // additive blending means fading the colour to black is the fade-out;
    // keep it near-neutral so it reads as dust, not embers
    const f = clamp(pLife[i] * 1.6, 0, 1) * 0.34;
    pCol[i * 3] = f;
    pCol[i * 3 + 1] = f * 0.98;
    pCol[i * 3 + 2] = f * 0.94;
  }
  pGeo.attributes.position.needsUpdate = true;
  pGeo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Rival AI — cheap, but it hunts
// ---------------------------------------------------------------------------
// how much bigger `a` has to be before it may swallow `b` — the player is
// given a wider margin than the rivals grant each other
const eatRatioFor = (b) => (b.isPlayer ? EAT_PLAYER_RATIO : EAT_HOLE_RATIO);

function pickTarget(h) {
  const reach = RIVAL_REACH + h.drawR * 5.5;
  const span = Math.ceil(reach / CELL);
  const cx = Math.floor((h.x + HALF) / CELL) + 1;
  const cz = Math.floor((h.z + HALF) / CELL) + 1;
  const eatable = h.drawR * EAT_RATIO * 0.95;
  let bestScore = 0, bestT = null;
  for (let j = cz - span; j <= cz + span; j++) {
    if (j < 0 || j >= GRID_N) continue;
    for (let i = cx - span; i <= cx + span; i++) {
      if (i < 0 || i >= GRID_N) continue;
      const bucket = grid[j * GRID_N + i];
      for (let k = 0; k < bucket.length; k++) {
        const o = bucket[k];
        if (o.state !== 0 || o.r > eatable) continue;
        const d = Math.hypot(o.x - h.x, o.z - h.z);
        // jitter the appraisal hard, so rivals make human-ish choices instead
        // of perfectly solving the map every time they re-target
        const s = (o.pts / (d + 6)) * rand(0.45, 1.55);
        if (s > bestScore) { bestScore = s; bestT = o; }
      }
    }
  }
  // a rival worth eating beats any pile of benches — but only one it can
  // actually catch, and only if it happens to notice
  for (const o of holes) {
    if (o === h || !o.alive) continue;
    if (h.drawR < o.drawR * eatRatioFor(o) * 1.12) continue;
    const d = Math.hypot(o.x - h.x, o.z - h.z);
    if (d > 52) continue;
    // a hole that outruns you is not worth chasing
    if (speedFor(o.drawR) > speedFor(h.drawR) * h.skill * 0.98) continue;
    const s = (o.area * 18 + 220) / (d + 8) * rand(0.6, 1.2);
    if (s > bestScore) { bestScore = s; bestT = o; }
  }
  return bestT;
}

function updateAI(h, dt) {
  h.retarget -= dt;
  if (h.dawdle > 0) h.dawdle -= dt;
  const lost = !h.target || (h.target.state !== undefined && h.target.state !== 0) ||
    (h.target.alive === false);
  if (h.retarget <= 0 || lost) {
    h.retarget = rand(RIVAL_THINK[0], RIVAL_THINK[1]) / h.skill;
    h.target = pickTarget(h);
    // every so often a rival simply mooches for a beat instead of committing
    if (Math.random() < RIVAL_DAWDLE) h.dawdle = rand(0.35, 1.1);
  }
  let tx, tz;
  if (h.target) {
    tx = h.target.x;
    tz = h.target.z;
  } else {
    // nothing nearby: drift toward the middle and re-scan
    tx = rand(-40, 40);
    tz = rand(-40, 40);
  }
  h.wobble += dt * 1.6;
  const throttle = h.skill * (h.dawdle > 0 ? 0.45 : 1);
  const a = Math.atan2(tz - h.z, tx - h.x) + Math.sin(h.wobble) * 0.3;
  stepHole(h, dt, Math.cos(a) * throttle, Math.sin(a) * throttle);
}

function holeVsHole() {
  for (const a of holes) {
    if (!a.alive) continue;
    for (const b of holes) {
      if (a === b || !b.alive) continue;
      if (a.drawR < b.drawR * eatRatioFor(b)) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > a.drawR * EAT_HOLE_REACH) continue;
      swallowHole(a, b);
    }
  }
}

function swallowHole(a, b) {
  const gained = b.area * 0.55;
  a.area += gained;
  a.targetR = Math.sqrt(a.area / Math.PI);
  a.score += Math.round(b.score * 0.22) + 200;
  b.alive = false;
  b.dead = RESPAWN_DELAY;
  b.area = Math.max(START_AREA, b.area * 0.35);
  b.targetR = Math.sqrt(b.area / Math.PI);
  b.drawR = b.targetR;
  b.vx = b.vz = 0;
  b.target = null;
  b.vis.visible = false;
  puff(b.x, b.z, Math.max(2, b.drawR));
  if (a.isPlayer) {
    toast(`swallowed ${b.name}! <b>+${Math.round(b.score * 0.22) + 200}</b>`);
    AudioFX.chime(1.5);
    shake = 0.7;
    navigator.vibrate?.([12, 40, 22]);
  } else if (b.isPlayer) {
    toast(`${a.name} swallowed you`, true);
    AudioFX.crash();
    shake = 1.1;
    navigator.vibrate?.([28, 60, 28]);
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const camTarget = new THREE.Vector3();
const camDir = new THREE.Vector3(
  Math.sin(CAM_YAW) * Math.cos(CAM_PITCH),
  Math.sin(CAM_PITCH),
  Math.cos(CAM_YAW) * Math.cos(CAM_PITCH)
);
const fwd = new THREE.Vector3(-camDir.x, 0, -camDir.z).normalize();
const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
let camDist = CAM_NEAR_D;
let shake = 0;
let attractA = 0;

function updateCamera(dt) {
  const want = lerp(CAM_NEAR_D, CAM_FAR_D, smoothstep(START_R, CAM_R_FAR, player.drawR));
  camDist = damp(camDist, want, 1.7, dt);
  camTarget.x = damp(camTarget.x, player.x + player.vx * 0.2, 7, dt);
  camTarget.z = damp(camTarget.z, player.z + player.vz * 0.2, 7, dt);
  camera.position.copy(camTarget).addScaledVector(camDir, camDist);
  if (shake > 0) {
    shake = Math.max(0, shake - dt * 2.6);
    const k = shake * shake * 0.7;
    camera.position.x += Math.sin(tNow * 61) * k;
    camera.position.y += Math.sin(tNow * 47) * k;
  }
  camera.lookAt(camTarget);
}

function updateAttractCamera(dt) {
  // a slow orbit well inside the border, so the demo always frames city and
  // never the empty ground beyond the arena
  attractA += dt * 0.06;
  camDist = damp(camDist, 52, 1.2, dt);
  camTarget.x = damp(camTarget.x, Math.cos(attractA) * 26, 1.2, dt);
  camTarget.z = damp(camTarget.z, Math.sin(attractA) * 26, 1.2, dt);
  camera.position.copy(camTarget).addScaledVector(camDir, camDist);
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const scoreEl = document.getElementById('score');
const sizeChipEl = document.getElementById('sizeChip');
const timerEl = document.getElementById('timer');
const boardEl = document.getElementById('board');
const toastsEl = document.getElementById('toasts');
const startEl = document.getElementById('start');
const overEl = document.getElementById('over');
const startMapEl = document.getElementById('startMap');
const overPlaceEl = document.getElementById('overPlace');
const overScoreEl = document.getElementById('overScore');
const overBestEl = document.getElementById('overBest');
const overMapEl = document.getElementById('overMap');
const overBoardEl = document.getElementById('overBoard');
const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('knob');
const muteBtn = document.getElementById('mute');

const ORD = ['1st', '2nd', '3rd', '4th', '5th'];

let shownScore = -1;
function setScore(v) {
  if (v === shownScore) return;   // never touch the DOM for an unchanged value
  shownScore = v;
  scoreEl.textContent = v.toLocaleString();
}

let shownSize = '';
function setSize(r) {
  const s = (r * 2).toFixed(1) + ' m';
  if (s === shownSize) return;
  shownSize = s;
  sizeChipEl.textContent = s;
}

let shownTime = -1;
function setTime(t) {
  const s = Math.max(0, Math.ceil(t));
  if (s === shownTime) return;
  shownTime = s;
  timerEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  timerEl.classList.toggle('urgent', s <= 10);
}

function toast(html, minor) {
  const el = document.createElement('div');
  el.className = 'toast' + (minor ? ' minor' : '');
  el.innerHTML = html;
  toastsEl.appendChild(el);
  while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  el.addEventListener('animationend', (e) => { if (e.animationName === 'fade') el.remove(); });
}

const boardRows = [];
function buildBoard() {
  boardEl.innerHTML = '';
  boardRows.length = 0;
  for (const h of holes) {
    const el = document.createElement('div');
    el.className = 'row' + (h.isPlayer ? ' you' : '');
    el.innerHTML = '<span class="rank">1</span><span class="dot"></span>' +
      '<span class="nm"></span><span class="pts">0</span>';
    el.querySelector('.dot').style.background = h.color;
    el.querySelector('.nm').textContent = h.isPlayer ? 'You' : h.name;
    // seed the row's slot: they are absolutely placed, so without this they
    // all stack at the top until the first standings change
    el.style.transform = `translateY(${boardRows.length * 30}px)`;
    el.querySelector('.rank').textContent = boardRows.length + 1;
    boardEl.appendChild(el);
    boardRows.push({ h, el, rank: el.querySelector('.rank'), pts: el.querySelector('.pts') });
  }
}

let boardT = 0;
let boardKey = '';
function updateBoard(dt) {
  boardT -= dt;
  if (boardT > 0) return;
  boardT = 0.2;
  const sorted = holes.slice().sort((a, b) => b.score - a.score);
  let key = '';
  for (const h of sorted) key += h.name + ':' + h.score + '|';
  if (key === boardKey) return;
  boardKey = key;
  for (let i = 0; i < sorted.length; i++) {
    const row = boardRows[holes.indexOf(sorted[i])];
    row.el.style.transform = `translateY(${i * 30}px)`;
    row.rank.textContent = i + 1;
    row.pts.textContent = sorted[i].score.toLocaleString();
  }
}

const playerRank = () => {
  let n = 1;
  for (const h of holes) if (h !== player && h.score > player.score) n++;
  return n;
};

// ---------------------------------------------------------------------------
// Audio — all synthesized, nothing downloaded
// ---------------------------------------------------------------------------
const AudioFX = {
  ctx: null,
  muted: false,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // low bed that deepens as the hole grows
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 150;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    this.bed = { f, g };
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  toggle() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 1;
    muteBtn.classList.toggle('muted', this.muted);
    try { localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch {}
  },
  setBed(v01) {
    if (!this.bed) return;
    const t = this.ctx.currentTime;
    this.bed.g.gain.setTargetAtTime(v01 * 0.16, t, 0.3);
    this.bed.f.frequency.setTargetAtTime(90 + v01 * 130, t, 0.4);
  },
  thud(gain, freq) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.45, t + 0.16);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.22);
  },
  chime(mult) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = 520 * (mult || 1) * (i ? 1.5 : 1);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.05);
      o.stop(t + 0.5);
    }
  },
  crash() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    s.stop(t + 0.62);
  },
  beep(freq) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.18);
  },
};
try { AudioFX.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch {}
muteBtn.classList.toggle('muted', AudioFX.muted);
muteBtn.addEventListener('click', () => { AudioFX.init(); AudioFX.toggle(); });
for (const t of ['pointerdown', 'pointerup']) {
  muteBtn.addEventListener(t, (e) => e.stopPropagation());
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------
const TIER_ORDER = ['person', 'bench', 'light', 'car', 'tree', 'van', 'bus', 'hut', 'block', 'tower'];
const TIER_LABEL = {
  person: 'people', bench: 'benches', light: 'street lights', car: 'cars', tree: 'trees',
  van: 'vans', bus: 'buses', hut: 'cabins', block: 'buildings', tower: 'towers',
};

let state = 'start';   // start | playing | over
let timeLeft = MATCH_TIME;
let mapIndex = 0;
let tierIdx = -1;
let overShownAt = 0;
let lastBeep = 99;

try { mapIndex = (parseInt(localStorage.getItem(MAP_KEY), 10) || 0) % MAPS.length; } catch {}

function setupHoles() {
  for (const h of holes) scene.remove(h.vis);
  holes.length = 0;
  player = makeHole('You', PLAYER_COLOR, true);
  holes.push(player);
  const names = RIVAL_NAMES.slice().sort(() => Math.random() - 0.5);
  const colors = RIVAL_COLORS.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < RIVALS; i++) {
    const h = makeHole(names[i], colors[i], false);
    // rivals cap out below the player's top speed: they never waste a metre,
    // so matching their speed too would make them unbeatable
    h.skill = rand(RIVAL_SKILL[0], RIVAL_SKILL[1]);
    holes.push(h);
  }
  for (const h of holes) placeHole(h, true);
  buildBoard();
}

function loadMap(i) {
  mapIndex = ((i % MAPS.length) + MAPS.length) % MAPS.length;
  buildWorld(MAPS[mapIndex]);
  startMapEl.textContent = MAPS[mapIndex].name;
  try { localStorage.setItem(MAP_KEY, String(mapIndex)); } catch {}
}

// every match gets a freshly generated world — the attract screen's rivals have
// been eating this one, and the map advances between matches
function startMatch(advance) {
  loadMap(advance ? mapIndex + 1 : mapIndex);
  for (const h of holes) {
    h.area = START_AREA;
    h.targetR = START_R;
    h.drawR = START_R;
    h.score = 0;
    h.vx = h.vz = 0;
    h.alive = true;
    h.dead = 0;
    h.target = null;
    h.retarget = 0;
  }
  for (const h of holes) placeHole(h, true);
  camTarget.set(player.x, 0, player.z);
  camDist = CAM_NEAR_D;
  timeLeft = MATCH_TIME;
  tierIdx = -1;
  lastBeep = 99;
  shownScore = -1;
  shownTime = -1;
  boardKey = '';
  setScore(0);
  setSize(START_R);
  setTime(MATCH_TIME);
  startEl.classList.add('hidden');
  overEl.classList.add('hidden');
  state = 'playing';
  AudioFX.chime(1);
}

function endMatch() {
  state = 'over';
  AudioFX.setBed(0);
  const rank = playerRank();
  overPlaceEl.textContent = ORD[rank - 1];
  overScoreEl.textContent = player.score.toLocaleString();
  if (player.score > best) {
    best = player.score;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch {}
  }
  overBestEl.textContent = best.toLocaleString();
  overMapEl.textContent = MAPS[mapIndex].name;
  const sorted = holes.slice().sort((a, b) => b.score - a.score);
  overBoardEl.innerHTML = '';
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    const el = document.createElement('div');
    el.className = 'row' + (h.isPlayer ? ' you' : '');
    el.innerHTML = '<span class="rank"></span><span class="dot"></span>' +
      '<span class="nm"></span><span class="pts"></span>';
    el.querySelector('.rank').textContent = i + 1;
    el.querySelector('.dot').style.background = h.color;
    el.querySelector('.nm').textContent = h.isPlayer ? 'You' : h.name;
    el.querySelector('.pts').textContent = h.score.toLocaleString();
    overBoardEl.appendChild(el);
  }
  overEl.classList.remove('hidden');
  overShownAt = performance.now();
  AudioFX.chime(rank === 1 ? 2 : 0.7);
  navigator.vibrate?.(rank === 1 ? [20, 50, 20, 50, 30] : 25);
}

function onPlayerEat(o) {
  setScore(player.score);
  AudioFX.thud(clamp(0.06 + o.r * 0.05, 0.06, 0.35), clamp(240 - o.r * 26, 60, 240));
  if (o.r > 3) {
    shake = Math.min(1, shake + 0.35);
    navigator.vibrate?.(14);
  }
}

function checkTier() {
  while (tierIdx < TIER_ORDER.length - 1) {
    const k = TIER_ORDER[tierIdx + 1];
    if (player.drawR * EAT_RATIO < SPECS[k].r) break;
    tierIdx++;
    if (tierIdx > 0) {
      toast(`${TIER_LABEL[k]} are on the menu`);
      AudioFX.chime(1.2);
      navigator.vibrate?.(12);
    }
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let dragging = false;
let dragId = -1;
let originX = 0, originY = 0;
let stickX = 0, stickY = 0;
let dragMoved = 0;
let downAt = 0;
let keyL = false, keyR = false, keyU = false, keyD = false;

function primaryAction() {
  AudioFX.init();
  AudioFX.resume();
  if (state === 'start') {
    startMatch(false);
  } else if (state === 'over') {
    // ignore the tail of a drag that was still in flight when time ran out
    if (performance.now() - overShownAt < 400) return;
    startMatch(true);
  }
}

function setStick(cx, cy) {
  let dx = cx - originX, dy = cy - originY;
  const len = Math.hypot(dx, dy);
  // clamp the gesture at the limit rather than letting it run away
  const cl = Math.min(len, STICK_MAX);
  if (len > 0.001) {
    dx = (dx / len) * cl;
    dy = (dy / len) * cl;
  }
  knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  const mag = len < STICK_DEAD ? 0 : smoothstep(STICK_DEAD, STICK_MAX, len);
  if (cl > 0.001) {
    stickX = (dx / cl) * mag;
    stickY = (dy / cl) * mag;
  } else {
    stickX = stickY = 0;
  }
}

canvas.addEventListener('pointerdown', (e) => {
  AudioFX.init();
  AudioFX.resume();
  if (dragging) return;
  dragging = true;
  dragId = e.pointerId;
  originX = e.clientX;
  originY = e.clientY;
  dragMoved = 0;
  downAt = performance.now();
  stickX = stickY = 0;
  knobEl.style.transform = 'translate(0px, 0px)';
  stickEl.style.left = originX + 'px';
  stickEl.style.top = originY + 'px';
  if (state === 'playing') stickEl.classList.add('on');
  canvas.setPointerCapture?.(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragId) return;
  dragMoved = Math.max(dragMoved, Math.hypot(e.clientX - originX, e.clientY - originY));
  if (state === 'playing') setStick(e.clientX, e.clientY);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  dragId = -1;
  stickX = stickY = 0;
  stickEl.classList.remove('on');
}

canvas.addEventListener('pointerup', (e) => {
  if (e.pointerId !== dragId) return;
  const quick = performance.now() - downAt < 300;
  endDrag();
  if (dragMoved < 12 && quick) primaryAction();
});
canvas.addEventListener('pointercancel', endDrag);

startEl.addEventListener('pointerup', primaryAction);
overEl.addEventListener('pointerup', primaryAction);

window.addEventListener('keydown', (e) => {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') keyL = true;
  if (k === 'ArrowRight' || k === 'd' || k === 'D') keyR = true;
  if (k === 'ArrowUp' || k === 'w' || k === 'W') keyU = true;
  if (k === 'ArrowDown' || k === 's' || k === 'S') keyD = true;
  if (k === ' ' || k === 'Enter') {
    e.preventDefault();
    primaryAction();
  }
  if (k === 'r' || k === 'R') {
    AudioFX.init();
    AudioFX.resume();
    if (state !== 'start') startMatch(false);
  }
  if (k === 'm' || k === 'M') { AudioFX.init(); AudioFX.toggle(); }
});

window.addEventListener('keyup', (e) => {
  const k = e.key;
  if (k === 'ArrowLeft' || k === 'a' || k === 'A') keyL = false;
  if (k === 'ArrowRight' || k === 'd' || k === 'D') keyR = false;
  if (k === 'ArrowUp' || k === 'w' || k === 'W') keyU = false;
  if (k === 'ArrowDown' || k === 's' || k === 'S') keyD = false;
});

const _dir = { x: 0, z: 0 };
function inputDir() {
  let sx = stickX, sy = stickY;
  if (keyL || keyR || keyU || keyD) {
    sx = (keyR ? 1 : 0) - (keyL ? 1 : 0);
    sy = (keyD ? 1 : 0) - (keyU ? 1 : 0);
    const m = Math.hypot(sx, sy);
    if (m > 0) { sx /= m; sy /= m; }
  }
  _dir.x = right.x * sx + fwd.x * -sy;
  _dir.z = right.z * sx + fwd.z * -sy;
  return _dir;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function updateHoles(dt, playerDriven) {
  for (const h of holes) {
    if (!h.alive) {
      h.dead -= dt;
      if (h.dead <= 0) {
        h.alive = true;
        placeHole(h, true);
        if (h.isPlayer) {
          camTarget.set(h.x, 0, h.z);
          toast('back in', true);
        }
      }
      continue;
    }
    h.drawR = damp(h.drawR, h.targetR, 11, dt);
    if (h.isPlayer) {
      if (playerDriven) {
        const d = inputDir();
        stepHole(h, dt, d.x, d.z);
      }
    } else {
      updateAI(h, dt);
    }
    scanHole(h);
    syncHoleVisual(h);
  }
  holeVsHole();
  pushHoleUniforms();
}

function updatePlaying(dt) {
  timeLeft -= dt;
  updateHoles(dt, true);
  if (player.alive) markOccluders(player);
  setScore(player.score);
  setSize(player.drawR);
  setTime(timeLeft);
  checkTier();
  updateBoard(dt);
  AudioFX.setBed(clamp(player.drawR / 9, 0.1, 1));
  const s = Math.ceil(timeLeft);
  if (s <= 5 && s !== lastBeep && s > 0) {
    lastBeep = s;
    AudioFX.beep(660 + (5 - s) * 60);
  }
  if (timeLeft <= 0) {
    timeLeft = 0;
    setTime(0);
    endMatch();
  }
}

// on the start screen the rivals keep eating, so the world is alive before
// the first input; starting a match rebuilds the map from scratch anyway
function updateAttract(dt) {
  for (const h of holes) {
    if (h.isPlayer) { h.vis.visible = false; continue; }
    // recycle a rival once it outgrows the frame, so the demo never stalls
    if (h.targetR > 5.5) {
      h.area = START_AREA;
      h.targetR = START_R;
      h.drawR = START_R;
      h.target = null;
      placeHole(h, true);
    }
    h.drawR = damp(h.drawR, h.targetR, 11, dt);
    updateAI(h, dt);
    scanHole(h);
    syncHoleVisual(h);
  }
  pushHoleUniforms();
}

// once the clock stops, the standings are final — freeze the sim and let the
// last few props finish falling
function updateFrozen() {
  for (const h of holes) if (h.alive) syncHoleVisual(h);
  pushHoleUniforms();
}

// ---------------------------------------------------------------------------
// Bootstrap + loop
// ---------------------------------------------------------------------------
setupHoles();
loadMap(mapIndex);
setScore(0);
setSize(START_R);
setTime(MATCH_TIME);
player.vis.visible = false;

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
  dt = Math.min(dt, 0.033);      // clamp to avoid teleporting after a tab switch
  tNow = now / 1000;

  if (edgeCool > 0) edgeCool -= dt;

  if (state === 'playing') {
    updatePlaying(dt);
    updateCamera(dt);
  } else if (state === 'over') {
    updateFrozen();
    updateCamera(dt);
  } else {
    updateAttract(dt);
    updateAttractCamera(dt);
  }

  updateFalling(dt);
  updateWobble(dt);
  updateFades(dt);
  updateDust(dt);

  renderer.render(scene, camera);
}
const pause = installPause({
  canPause: () => state === 'playing',
  right: 68,                                  // clear of the mute button
  onPause: () => AudioFX.setBed(0),
});

requestAnimationFrame(tick);

// tiny debug/test handle (not used by the game itself)
window.__sink = {
  get state() { return state; },
  get score() { return player.score; },
  get radius() { return player.drawR; },
  get pos() { return { x: player.x, z: player.z }; },
  get map() { return MAPS[mapIndex].key; },
  get objects() { return objs.length; },
  get info() { return renderer.info.render; },
  get standings() { return holes.map((h) => ({ name: h.name, score: h.score, r: h.drawR })); },
  get speed() { return speedFor(player.drawR); },
  get faded() { return fading.size; },
  clock(t) { timeLeft = t; },
  grow(area) { growHole(player, area); },
  place(x, z) { player.x = x; player.z = z; player.vx = player.vz = 0; camTarget.set(x, 0, z); },
};

// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'playing' });
