import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------------
const ACCENT = 0xe879f9;      // neon magenta
const GOLD = 0xffc857;
const AMBER = 0xffb454;

const LANES = [-2.2, 0, 2.2];
const LANE_RATE = 16;                    // exp-ease rate for lane x (settles ~0.19s)
const BANK_ANGLE = THREE.MathUtils.degToRad(12);

const BASE_SPEED = 14;
const MAX_SPEED = 30;
const SPEED_TAU = 34;                    // asymptotic ramp time-constant (s)

const JUMP_DURATION = 0.55;
const JUMP_HEIGHT = 1.6;
const SLIDE_DURATION = 0.6;
const SLAM_DURATION = 0.14;
const ACTION_BUFFER_WINDOW = 0.25;

const SWIPE_THRESHOLD = 24;

const SPAWN_Z = -72;                     // obstacles/coins appear here (far ahead)
const DESPAWN_Z = 8;                     // recycle once past the camera
const COLLIDE_Z = 0.55;
const COLLIDE_X = 0.85;
const NEARMISS_X = 1.6;

const MAGNET_CADENCE = 30;               // seconds between magnet spawns
const MAGNET_DURATION = 6;
const MAGNET_RADIUS = 4.5;

const CAM_UP = 4.3;
const CAM_BACK = 6.8;
const BASE_FOV = 64;
const FOV_BONUS = 9;
const CAM_LAG_RATE = 4.5;

const BEST_KEY = 'am.runway.best';

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = makeSkyTexture();
scene.fog = new THREE.Fog(0x431a4a, 20, 88);

// Big soft glow sitting right at the vanishing point, selling the dusk horizon.
const horizonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
}));
horizonGlow.position.set(0, 2.2, -180);
horizonGlow.scale.set(62, 62, 1);
scene.add(horizonGlow);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 260);
camera.position.set(0, CAM_UP, CAM_BACK);

const hemi = new THREE.HemisphereLight(0xff9de2, 0x140a1e, 0.75);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffe3f6, 1.05);
key.position.set(-4, 10, 4);
scene.add(key);
const rim = new THREE.PointLight(ACCENT, 0.9, 20);
rim.position.set(0, 2.5, -1);
scene.add(rim);

// ---------------------------------------------------------------------------
// Shared geometries / materials
// ---------------------------------------------------------------------------
const wheelGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.09, 10);
const coinGeo = new THREE.OctahedronGeometry(0.26, 0);
const debrisGeo = new THREE.BoxGeometry(0.22, 0.16, 0.16);

const matGround = new THREE.MeshStandardMaterial({ color: 0x171025, roughness: 0.95, metalness: 0.0 });
const matStripe = new THREE.MeshStandardMaterial({ color: 0x241535, roughness: 0.9 });
const matDash = new THREE.MeshStandardMaterial({ color: 0xffe9c7, emissive: 0xffb85e, emissiveIntensity: 0.8, roughness: 0.6 });
const matEdgeA = new THREE.MeshStandardMaterial({ color: 0x1a0a1a, emissive: ACCENT, emissiveIntensity: 1.4, roughness: 0.6 });
const matEdgeB = new THREE.MeshStandardMaterial({ color: 0x1a1408, emissive: GOLD, emissiveIntensity: 1.1, roughness: 0.6 });
const matTower = new THREE.MeshStandardMaterial({ color: 0x140a22, roughness: 1, emissive: 0x1a0e2c, emissiveIntensity: 0.3 });
const matCoin = new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.4 });
const matWheel = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.7 });
const matHandle = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.35, metalness: 0.4 });
const matBody = new THREE.MeshStandardMaterial({ color: AMBER, roughness: 0.45, metalness: 0.08, flatShading: true });
const matTrim = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.4, roughness: 0.4, flatShading: true });
const matCart = new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 0.7, flatShading: true });
const matLuggage = [
  new THREE.MeshStandardMaterial({ color: 0xef6c8e, roughness: 0.6, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x5aa9e6, roughness: 0.6, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x74d3a3, roughness: 0.6, flatShading: true }),
];
const matGatePost = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.5, metalness: 0.3 });
const matGateBar = new THREE.MeshStandardMaterial({ color: 0xffb454, emissive: 0xff8a3c, emissiveIntensity: 0.65, roughness: 0.4 });
const matGateBarDark = new THREE.MeshStandardMaterial({ color: 0x171018, roughness: 0.5 });
const matTanker = new THREE.MeshStandardMaterial({ color: 0x8b93a0, roughness: 0.35, metalness: 0.5 });
const matTankerStripe = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.6, roughness: 0.4 });
const matMagnetBody = new THREE.MeshStandardMaterial({ color: 0xb0b4bd, roughness: 0.3, metalness: 0.7 });
const matMagnetTip = new THREE.MeshStandardMaterial({ color: 0xff4d6d, emissive: 0xff4d6d, emissiveIntensity: 0.6, roughness: 0.4 });
const debrisColors = [0xff6b81, 0x4fd1c5, 0xffe66d, 0xf5f5f7, 0x9d8cff];

// ---------------------------------------------------------------------------
// Sky + fog helper texture
// ---------------------------------------------------------------------------
function makeSkyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0a0616');
  grad.addColorStop(0.3, '#1a0c30');
  grad.addColorStop(0.58, '#3c1250');
  grad.addColorStop(0.8, '#93316f');
  grad.addColorStop(1, '#ff9fd4');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGlowTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255, 200, 235, 0.95)');
  grad.addColorStop(0.35, 'rgba(248, 140, 210, 0.55)');
  grad.addColorStop(0.7, 'rgba(200, 80, 170, 0.18)');
  grad.addColorStop(1, 'rgba(200, 80, 170, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Ground + runway decoration (wrap-around conveyor, zero per-frame allocation)
// ---------------------------------------------------------------------------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(11, 220), matGround);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, 0, -32);
scene.add(ground);

// faint lane dividers
const laneStripes = [];
for (const x of [-1.1, 1.1]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 220), matStripe);
  s.rotation.x = -Math.PI / 2;
  s.position.set(x, 0.01, -32);
  scene.add(s);
  laneStripes.push(s);
}

const WRAP_RANGE = DESPAWN_Z - SPAWN_Z;

function makeWrapPool(count, spacing, build) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const mesh = build(i);
    scene.add(mesh);
    items.push({ mesh, z: SPAWN_Z + i * spacing });
  }
  return items;
}

const edgeLights = [];
for (const side of [-1, 1]) {
  const spacing = 3.6;
  const count = Math.ceil(WRAP_RANGE / spacing);
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.5), i % 2 === 0 ? matEdgeA : matEdgeB);
    mesh.position.set(side * 4.3, 0.11, SPAWN_Z + i * spacing);
    scene.add(mesh);
    edgeLights.push({ mesh, z: mesh.position.z, side, phase: rand(0, Math.PI * 2) });
  }
}

const dashes = makeWrapPool(Math.ceil(WRAP_RANGE / 4.5), 4.5, () => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 1.0), matDash);
  m.position.y = 0.011;
  return m;
});

// distant control-tower silhouettes (slow parallax)
const TOWER_SPACING = 46;
const TOWER_COUNT = 6;
const TOWER_RANGE = TOWER_COUNT * TOWER_SPACING;
const towers = [];
for (let i = 0; i < TOWER_COUNT; i++) {
  const g = new THREE.Group();
  const side = i % 2 === 0 ? -1 : 1;
  const baseH = rand(4, 9);
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, baseH, 2.6), matTower);
  base.position.y = baseH / 2;
  g.add(base);
  if (Math.random() < 0.5) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 3.4, 8), matTower);
    stem.position.y = baseH + 1.7;
    g.add(stem);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.1, 1.1, 8), matTower);
    cab.position.y = baseH + 3.9;
    g.add(cab);
  }
  g.position.set(side * rand(20, 34), 0, SPAWN_Z + i * TOWER_SPACING);
  scene.add(g);
  towers.push({ group: g, z: g.position.z });
}

// occasional climbing plane silhouette with blinking wingtip light
const planeGroup = new THREE.Group();
const planeMat = new THREE.MeshBasicMaterial({ color: 0x180a26 });
const fuselage = new THREE.Mesh(new THREE.ConeGeometry(0.18, 1.4, 6), planeMat);
fuselage.rotation.x = Math.PI / 2;
planeGroup.add(fuselage);
const wing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.28), planeMat);
planeGroup.add(wing);
const wingLight = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff4d6d }));
wingLight.position.set(0.78, 0, 0);
planeGroup.add(wingLight);
planeGroup.visible = false;
scene.add(planeGroup);
let planeActive = false;
let planeT = 0;
let planeCountdown = rand(14, 26);
let planeDur = 16;
let planeStartX = 0, planeStartY = 0, planeEndX = 0, planeEndY = 0, planeZ = -140;

function updatePlane(dt) {
  if (!planeActive) {
    planeCountdown -= dt;
    if (planeCountdown <= 0) {
      planeActive = true;
      planeT = 0;
      planeDur = rand(14, 20);
      planeZ = -rand(120, 170);
      const dir = Math.random() < 0.5 ? -1 : 1;
      planeStartX = -dir * 34; planeEndX = dir * 34;
      planeStartY = rand(10, 14); planeEndY = planeStartY + rand(10, 16);
      planeGroup.visible = true;
      planeGroup.rotation.y = dir > 0 ? Math.PI / 2 + 0.25 : -Math.PI / 2 - 0.25;
    }
    return;
  }
  planeT += dt;
  const t = clamp01(planeT / planeDur);
  planeGroup.position.set(
    planeStartX + (planeEndX - planeStartX) * t,
    planeStartY + (planeEndY - planeStartY) * t,
    planeZ
  );
  wingLight.material.color.setHex(Math.floor(planeT * 2.2) % 2 === 0 ? 0xff4d6d : 0x4a1420);
  if (t >= 1) {
    planeActive = false;
    planeGroup.visible = false;
    planeCountdown = rand(22, 42);
  }
}

// ---------------------------------------------------------------------------
// Player: rolling suitcase
// ---------------------------------------------------------------------------
const player = new THREE.Group();
const chassis = new THREE.Group();
const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.0, 0.6), matBody);
body.position.y = 0.58;
chassis.add(body);
const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.15, 0.64), matTrim);
stripe.position.y = 0.58;
chassis.add(stripe);
const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8), matHandle);
handleBar.rotation.z = Math.PI / 2;
handleBar.position.set(0, 1.2, -0.02);
chassis.add(handleBar);
for (const sx of [-0.16, 0.16]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 6), matHandle);
  post.position.set(sx, 1.05, -0.02);
  chassis.add(post);
}
player.add(chassis);

const wheelsGroup = new THREE.Group();
const wheels = [];
for (const [wx, wz] of [[-0.4, 0.26], [0.4, 0.26], [-0.4, -0.26], [0.4, -0.26]]) {
  const w = new THREE.Mesh(wheelGeo, matWheel);
  w.rotation.z = Math.PI / 2;
  w.position.set(wx, 0.12, wz);
  wheelsGroup.add(w);
  wheels.push(w);
}
player.add(wheelsGroup);

const magnetRing = new THREE.Mesh(
  new THREE.RingGeometry(1.15, 1.32, 32),
  new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
);
magnetRing.rotation.x = -Math.PI / 2;
magnetRing.position.y = 0.03;
magnetRing.visible = false;
player.add(magnetRing);

scene.add(player);

// ---------------------------------------------------------------------------
// Debris pool (crash burst)
// ---------------------------------------------------------------------------
const debris = [];
for (let i = 0; i < 9; i++) {
  const mat = new THREE.MeshStandardMaterial({ color: debrisColors[i % debrisColors.length], roughness: 0.6, flatShading: true, transparent: true });
  const mesh = new THREE.Mesh(debrisGeo, mat);
  mesh.visible = false;
  scene.add(mesh);
  debris.push({ mesh, mat, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, life: 0, active: false });
}

function burstDebris() {
  for (const p of debris) {
    p.active = true;
    p.mesh.visible = true;
    p.mesh.position.set(laneX, 0.5, 0);
    p.mat.opacity = 1;
    const a = rand(0, Math.PI * 2);
    p.vx = Math.cos(a) * rand(1.5, 4);
    p.vy = rand(3, 6.5);
    p.vz = Math.sin(a) * rand(1.5, 4);
    p.rx = rand(-9, 9);
    p.rz = rand(-9, 9);
    p.life = 0.9;
  }
}

function updateDebris(dt) {
  for (const p of debris) {
    if (!p.active) continue;
    p.vy += -18 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.rotation.x += p.rx * dt;
    p.mesh.rotation.z += p.rz * dt;
    p.life -= dt;
    p.mat.opacity = Math.max(0, p.life / 0.9);
    if (p.life <= 0) { p.active = false; p.mesh.visible = false; }
  }
}

// ---------------------------------------------------------------------------
// Obstacle factories + pools
// ---------------------------------------------------------------------------
function buildCart() {
  const g = new THREE.Group();
  const platform = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.42, 0.95), matCart);
  platform.position.y = 0.4;
  g.add(platform);
  for (const [lx, lz] of [[-0.5, 0.42], [0.5, -0.42], [0.5, 0.42]]) {
    const luggage = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.3), pick(matLuggage));
    luggage.position.set(lx, 0.76, lz);
    g.add(luggage);
  }
  for (const wx of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 10), matWheel);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.16, 0.5);
    g.add(w);
    const w2 = w.clone();
    w2.position.z = -0.5;
    g.add(w2);
  }
  return g;
}

function buildGate() {
  const g = new THREE.Group();
  for (const px of [-0.95, 0.95]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.35, 8), matGatePost);
    post.position.set(px, 0.68, 0);
    g.add(post);
  }
  const segW = 0.34;
  for (let i = -2; i <= 2; i++) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.22, 0.16), i % 2 === 0 ? matGateBar : matGateBarDark);
    seg.position.set(i * segW, 1.1, 0);
    g.add(seg);
  }
  return g;
}

function buildTanker() {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.85, 14), matTanker);
  tank.rotation.z = Math.PI / 2;
  tank.position.y = 1.05;
  g.add(tank);
  const cap1 = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 8), matTanker);
  cap1.position.set(0.92, 1.05, 0);
  g.add(cap1);
  const cap2 = cap1.clone();
  cap2.position.x = -0.92;
  g.add(cap2);
  const stripeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.22, 14), matTankerStripe);
  stripeMesh.rotation.z = Math.PI / 2;
  stripeMesh.position.y = 1.05;
  g.add(stripeMesh);
  for (const lx of [-0.55, 0.55]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.85), matWheel);
    leg.position.set(lx, 0.28, 0);
    g.add(leg);
  }
  return g;
}

const OBSTACLE_BUILDERS = { cart: buildCart, gate: buildGate, tanker: buildTanker };
const OBSTACLE_POOL_SIZE = { cart: 6, gate: 6, tanker: 4 };
const obstaclePools = { cart: [], gate: [], tanker: [] };

for (const type of Object.keys(OBSTACLE_BUILDERS)) {
  for (let i = 0; i < OBSTACLE_POOL_SIZE[type]; i++) {
    const mesh = OBSTACLE_BUILDERS[type]();
    mesh.visible = false;
    scene.add(mesh);
    obstaclePools[type].push({ mesh, active: false, lane: 1, z: SPAWN_Z, passed: false, type });
  }
}

function spawnObstacle(type, lane, z = SPAWN_Z) {
  const pool = obstaclePools[type];
  if (!pool) return null;
  const o = pool.find((o) => !o.active) || pool[0];
  o.active = true;
  o.lane = lane;
  o.z = z;
  o.passed = false;
  o.mesh.visible = true;
  o.mesh.position.set(LANES[lane], 0, z);
  return o;
}

function deactivateAllObstacles() {
  for (const type of Object.keys(obstaclePools)) {
    for (const o of obstaclePools[type]) { o.active = false; o.mesh.visible = false; }
  }
}

// ---------------------------------------------------------------------------
// Coins
// ---------------------------------------------------------------------------
const COIN_POOL_SIZE = 64;
const coins = [];
for (let i = 0; i < COIN_POOL_SIZE; i++) {
  const mesh = new THREE.Mesh(coinGeo, matCoin);
  mesh.visible = false;
  scene.add(mesh);
  coins.push({ mesh, active: false, x: 0, y: 0.5, z: SPAWN_Z, spin: rand(2, 4) });
}

function spawnCoinAt(x, y, z) {
  const c = coins.find((c) => !c.active) || coins[0];
  c.active = true;
  c.x = x; c.y = y; c.z = z;
  c.mesh.visible = true;
  c.mesh.position.set(x, y, z);
  return c;
}

function deactivateAllCoins() {
  for (const c of coins) { c.active = false; c.mesh.visible = false; }
}

// ---------------------------------------------------------------------------
// Magnet pickups
// ---------------------------------------------------------------------------
function buildMagnet() {
  const g = new THREE.Group();
  const torus = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.09, 8, 16, Math.PI * 1.5), matMagnetBody);
  torus.rotation.z = Math.PI * 0.25;
  g.add(torus);
  for (const a of [0.15, Math.PI * 1.5 + Math.PI * 0.25 - 0.15]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), matMagnetTip);
    tip.position.set(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0);
    g.add(tip);
  }
  return g;
}

const magnetPickups = [];
for (let i = 0; i < 2; i++) {
  const mesh = buildMagnet();
  mesh.visible = false;
  scene.add(mesh);
  magnetPickups.push({ mesh, active: false, lane: 1, z: SPAWN_Z });
}

function spawnMagnetPickup(lane, z = SPAWN_Z) {
  const m = magnetPickups.find((m) => !m.active) || magnetPickups[0];
  m.active = true;
  m.lane = lane;
  m.z = z;
  m.mesh.visible = true;
  m.mesh.position.set(LANES[lane], 0.75, z);
  return m;
}

// ---------------------------------------------------------------------------
// Pattern generator (pure — exposed for fuzz testing)
// ---------------------------------------------------------------------------
function generateWave(difficulty) {
  const d = clamp01(difficulty);
  const lanes = [null, null, null];
  const density = 0.22 + 0.5 * d;
  const tankerChance = 0.12 + 0.3 * d;
  let tankerPlaced = false;
  for (let i = 0; i < 3; i++) {
    if (Math.random() > density) continue;
    const r = Math.random();
    if (!tankerPlaced && r < tankerChance) { lanes[i] = 'tanker'; tankerPlaced = true; }
    else if (r < tankerChance + 0.46) lanes[i] = 'cart';
    else lanes[i] = 'gate';
  }
  // gentle opening: keep one lane empty during the first stretch of a run
  if (d < 0.12) {
    const filled = lanes.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
    if (filled.length === 3) lanes[pick(filled)] = null;
  }
  return lanes;
}

function waveGap(speed) {
  const REACTION = 0.55; // seconds: perception + lane-change settle time
  return Math.max(9, speed * REACTION + 5);
}

// ---------------------------------------------------------------------------
// Spawn scheduling
// ---------------------------------------------------------------------------
let difficultyT = 0;
let magnetCountdown = MAGNET_CADENCE * 0.6;
let waveCountdown = 2.2; // seconds until the first wave, in real time

function spawnWaveCoins(laneTypes, z) {
  for (let i = 0; i < 3; i++) {
    const type = laneTypes[i];
    const x = LANES[i];
    if (type === 'tanker') continue;
    if (type === 'cart') {
      if (Math.random() < 0.7) {
        const heights = [0.85, 1.35, 0.85];
        for (let k = 0; k < 3; k++) spawnCoinAt(x, heights[k], z + (k - 1) * 1.5);
      }
    } else if (type === 'gate') {
      if (Math.random() < 0.7) {
        for (let k = 0; k < 3; k++) spawnCoinAt(x, 0.18, z + (k - 1) * 1.3 - 2.2);
      }
    } else if (Math.random() < 0.45) {
      for (let k = 0; k < 5; k++) spawnCoinAt(x, 0.5, z - k * 1.3 + 2.5);
    }
  }
}

// Waves are generated on a real-time countdown; the minimum gap between
// waves is expressed in world units by waveGap(speed) so the physical
// reaction distance always scales with current speed (see generateWave).
function updateSpawning(dt, speed) {
  difficultyT += dt;
  const difficulty = clamp01(difficultyT / 60);

  waveCountdown -= dt;
  if (waveCountdown <= 0) {
    const lanes = generateWave(difficulty);
    for (let i = 0; i < 3; i++) {
      if (lanes[i]) spawnObstacle(lanes[i], i, SPAWN_Z);
    }
    spawnWaveCoins(lanes, SPAWN_Z);
    waveCountdown = waveGap(speed) / Math.max(1, speed);
  }

  magnetCountdown -= dt;
  if (magnetCountdown <= 0) {
    magnetCountdown = MAGNET_CADENCE;
    spawnMagnetPickup((Math.random() * 3) | 0, SPAWN_Z - 4);
  }
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let gameState = 'start';   // 'start' | 'playing' | 'crashing' | 'over'
let laneIndex = 1;
let laneX = 0;
let laneTargetX = 0;
let bankAngle = 0;

let actionState = 'run';   // 'run' | 'jump' | 'slide' | 'slam'
let actionT = 0;
let playerY = 0;
let slamStartY = 0;
let queuedAction = null;
let queuedAt = 0;

let playT = 0;
let speed = BASE_SPEED;
let distance = 0;
let miles = 0;
let milesThisRun = 0;

let magnetActive = false;
let magnetTimer = 0;

let timeSlowTimer = 0;
let crashT = 0;
let camShakeAmt = 0;

let best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;

let runCycle = 0;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const distanceEl = document.getElementById('distance');
const milesEl = document.getElementById('miles');
const magnetPip = document.getElementById('magnet-pip');
const magnetTimeEl = document.getElementById('magnet-time');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const finalDistanceEl = document.getElementById('final-distance');
const finalMilesEl = document.getElementById('final-miles');
const bestScoreEl = document.getElementById('best-score');
const newBestEl = document.getElementById('new-best');
const restartBtn = document.getElementById('restart');

bestScoreEl.textContent = best;

function setDistanceHud(v) {
  distanceEl.firstChild.textContent = String(Math.floor(v));
}
function popDistance() {
  distanceEl.classList.add('pop');
  clearTimeout(popDistance._t);
  popDistance._t = setTimeout(() => distanceEl.classList.remove('pop'), 160);
}

// ---------------------------------------------------------------------------
// Action state machine
// ---------------------------------------------------------------------------
function queueAction(type) { queuedAction = type; queuedAt = playT; }
function consumeQueue() {
  if (queuedAction && (playT - queuedAt) < ACTION_BUFFER_WINDOW) {
    const a = queuedAction;
    queuedAction = null;
    if (a === 'jump') startJump();
    else if (a === 'slide') startSlide();
  } else {
    queuedAction = null;
  }
}

function startJump() { actionState = 'jump'; actionT = 0; }
function startSlide() { actionState = 'slide'; actionT = 0; }
function startSlam() { actionState = 'slam'; actionT = 0; slamStartY = playerY; }

function tryJump() {
  if (gameState !== 'playing') return;
  if (actionState === 'run') startJump();
  else if (actionState === 'slide') queueAction('jump');
}

function trySlide() {
  if (gameState !== 'playing') return;
  if (actionState === 'run') startSlide();
  else if (actionState === 'jump') startSlam();
  else if (actionState === 'slam') { /* already slamming */ }
}

function changeLane(dir) {
  if (gameState !== 'playing') return;
  const next = laneIndex + dir;
  if (next < 0 || next > 2) return;
  laneIndex = next;
  laneTargetX = LANES[laneIndex];
}

function updateAction(dt) {
  actionT += dt;
  if (actionState === 'jump') {
    const t = Math.min(actionT / JUMP_DURATION, 1);
    playerY = 4 * JUMP_HEIGHT * t * (1 - t);
    if (t >= 1) { actionState = 'run'; actionT = 0; playerY = 0; consumeQueue(); }
  } else if (actionState === 'slam') {
    const t = Math.min(actionT / SLAM_DURATION, 1);
    playerY = slamStartY * (1 - t);
    if (t >= 1) { playerY = 0; startSlide(); }
  } else if (actionState === 'slide') {
    if (actionT >= SLIDE_DURATION) { actionState = 'run'; actionT = 0; consumeQueue(); }
  } else {
    playerY = 0;
  }
}

// ---------------------------------------------------------------------------
// Collision / scoring
// ---------------------------------------------------------------------------
function isAirborne() { return actionState === 'jump' || actionState === 'slam'; }
function isSliding() { return actionState === 'slide'; }

function resolveObstacle(o) {
  if (o.type === 'cart') {
    if (isAirborne()) return true;
    return false;
  }
  if (o.type === 'gate') {
    if (isSliding()) return true;
    return false;
  }
  // tanker: reaching here means x-proximity already matched -> always fatal
  return false;
}

function nearMiss() {
  distance += 5; // small bonus, folded into the distance/score readout
  timeSlowTimer = 0.12;
  navigator.vibrate?.(6);
}

function collectCoin(c) {
  c.active = false;
  c.mesh.visible = false;
  miles++;
  milesThisRun++;
  milesEl.textContent = miles;
  if (milesThisRun > 0 && milesThisRun % 10 === 0) navigator.vibrate?.(10);
}

function collectMagnet(m) {
  m.active = false;
  m.mesh.visible = false;
  magnetActive = true;
  magnetTimer = MAGNET_DURATION;
  navigator.vibrate?.(10);
}

function updateCollisions(dt) {
  for (const type of Object.keys(obstaclePools)) {
    for (const o of obstaclePools[type]) {
      if (!o.active) continue;
      o.z += speed * dt;
      o.mesh.position.z = o.z;
      if (o.z > DESPAWN_Z) { o.active = false; o.mesh.visible = false; continue; }
      if (o.passed) continue;
      const dx = Math.abs(laneX - LANES[o.lane]);
      if (Math.abs(o.z) < COLLIDE_Z) {
        if (dx < COLLIDE_X) {
          o.passed = true;
          if (!resolveObstacle(o)) { crash(); return; }
        } else if (dx < NEARMISS_X) {
          o.passed = true;
          nearMiss();
        }
      }
    }
  }

  for (const c of coins) {
    if (!c.active) continue;
    let pulled = false;
    if (magnetActive) {
      const dxp = laneX - c.x, dzp = 0 - c.z;
      if (Math.hypot(dxp, dzp) < MAGNET_RADIUS) {
        // Seek the player point directly — this must fully replace the
        // normal forward scroll, not add to it, or the coin settles into a
        // stable equilibrium just past the pickup window and is never collected.
        const pull = Math.min(1, dt * 9);
        c.x += dxp * pull;
        c.z += dzp * pull;
        c.y += (0.55 - c.y) * pull;
        pulled = true;
      }
    }
    if (!pulled) c.z += speed * dt;
    c.mesh.position.set(c.x, c.y, c.z);
    c.mesh.rotation.y += c.spin * dt;
    if (c.z > DESPAWN_Z) { c.active = false; c.mesh.visible = false; continue; }
    const dx = Math.abs(laneX - c.x);
    if (Math.abs(c.z) < 0.6 && dx < 0.65) collectCoin(c);
  }

  for (const m of magnetPickups) {
    if (!m.active) continue;
    m.z += speed * dt;
    m.mesh.position.z = m.z;
    m.mesh.rotation.y += 3 * dt;
    if (m.z > DESPAWN_Z) { m.active = false; m.mesh.visible = false; continue; }
    const dx = Math.abs(laneX - LANES[m.lane]);
    if (Math.abs(m.z) < 0.65 && dx < 0.85) collectMagnet(m);
  }
}

// ---------------------------------------------------------------------------
// Crash / state transitions
// ---------------------------------------------------------------------------
function crash() {
  if (gameState !== 'playing') return;
  gameState = 'crashing';
  crashT = 0;
  navigator.vibrate?.(30);
  burstDebris();
  hud.classList.add('dim');
}

function finishCrash() {
  gameState = 'over';
  const score = Math.floor(distance) + miles * 10;
  const isNew = score > best;
  if (isNew) { best = score; localStorage.setItem(BEST_KEY, String(best)); }
  bestScoreEl.textContent = best;
  finalDistanceEl.textContent = Math.floor(distance);
  finalMilesEl.textContent = miles;
  newBestEl.hidden = !isNew;
  overOverlay.hidden = false;
}

function resetWorld() {
  deactivateAllObstacles();
  deactivateAllCoins();
  for (const m of magnetPickups) { m.active = false; m.mesh.visible = false; }
  laneIndex = 1;
  laneX = 0;
  laneTargetX = 0;
  bankAngle = 0;
  actionState = 'run';
  actionT = 0;
  playerY = 0;
  queuedAction = null;
  playT = 0;
  speed = BASE_SPEED;
  distance = 0;
  miles = 0;
  milesThisRun = 0;
  magnetActive = false;
  magnetTimer = 0;
  timeSlowTimer = 0;
  crashT = 0;
  waveCountdown = 2.2;
  difficultyT = 0;
  magnetCountdown = MAGNET_CADENCE * 0.6;
  milesEl.textContent = '0';
  setDistanceHud(0);
  player.rotation.set(0, 0, 0);
  player.visible = true;
  for (const p of debris) { p.active = false; p.mesh.visible = false; }
}

function startGame() {
  resetWorld();
  gameState = 'playing';
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  hud.classList.remove('dim');
}

function handleTapRestart() {
  if (gameState === 'start' || gameState === 'over') startGame();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let downX = 0, downY = 0, downT = 0, tracking = false;

canvas.addEventListener('pointerdown', (e) => {
  tracking = true;
  downX = e.clientX; downY = e.clientY; downT = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (!tracking) return;
  tracking = false;
  if (gameState !== 'playing') return;
  const dx = e.clientX - downX, dy = e.clientY - downY;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (Math.max(adx, ady) < SWIPE_THRESHOLD) return; // tap does nothing mid-run
  if (adx > ady) changeLane(dx > 0 ? 1 : -1);
  else if (dy < 0) tryJump();
  else trySlide();
});
canvas.addEventListener('pointercancel', () => { tracking = false; });

startOverlay.addEventListener('pointerup', (e) => {
  if (e.target.closest('#install') || e.target.closest('.install-tip')) return;
  handleTapRestart();
});
overOverlay.addEventListener('pointerup', (e) => {
  if (e.target.closest('#restart')) return; // handled by its own click
  handleTapRestart();
});
restartBtn.addEventListener('click', handleTapRestart);

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key;
  if (gameState === 'playing') {
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') changeLane(-1);
    else if (k === 'ArrowRight' || k === 'd' || k === 'D') changeLane(1);
    else if (k === 'ArrowUp' || k === 'w' || k === 'W') tryJump();
    else if (k === 'ArrowDown' || k === 's' || k === 'S') trySlide();
  }
  if (k === ' ' || k === 'Enter' || k === 'r' || k === 'R') {
    if (gameState !== 'playing') { e.preventDefault(); handleTapRestart(); }
  }
});

// ---------------------------------------------------------------------------
// Visual update
// ---------------------------------------------------------------------------
function updatePlayerVisual(dt) {
  laneX += (laneTargetX - laneX) * Math.min(1, dt * LANE_RATE);
  const dxTarget = laneTargetX - laneX;
  const desiredBank = THREE.MathUtils.clamp(dxTarget * -2.6, -1, 1) * BANK_ANGLE;
  bankAngle += (desiredBank - bankAngle) * Math.min(1, dt * 10);

  runCycle += dt * (2.4 + speed * 0.12) * (gameState === 'playing' && actionState === 'run' ? 1 : 0);
  const bob = actionState === 'run' ? Math.sin(runCycle * Math.PI * 2) * 0.035 : 0;

  player.position.set(laneX, playerY + bob, 0);
  player.rotation.z = bankAngle;

  const targetScaleY = actionState === 'slide' ? 0.42 : 1;
  chassis.scale.y += (targetScaleY - chassis.scale.y) * Math.min(1, dt * 14);
  chassis.rotation.x += ((actionState === 'slide' ? -0.16 : 0) - chassis.rotation.x) * Math.min(1, dt * 14);

  const wheelSpin = speed * dt * 4.2;
  for (const w of wheels) w.rotation.x += wheelSpin;

  magnetRing.visible = magnetActive;
  if (magnetActive) {
    const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.08;
    magnetRing.scale.setScalar(pulse);
    magnetRing.material.opacity = 0.35 + 0.2 * Math.sin(performance.now() * 0.012);
  }
}

function updateEnvironment(dt, envSpeed) {
  for (const e of edgeLights) {
    e.z += envSpeed * dt;
    if (e.z > DESPAWN_Z) e.z -= WRAP_RANGE;
    e.mesh.position.z = e.z;
    const pulse = 0.85 + 0.35 * Math.sin(performance.now() * 0.003 + e.phase);
    e.mesh.scale.setScalar(pulse);
  }
  for (const d of dashes) {
    d.z += envSpeed * dt;
    if (d.z > DESPAWN_Z) d.z -= WRAP_RANGE;
    d.mesh.position.z = d.z;
  }
  for (const t of towers) {
    t.z += envSpeed * 0.22 * dt;
    if (t.z > 40) t.z -= TOWER_RANGE;
    t.group.position.z = t.z;
  }
  updatePlane(dt);
}

function updateCamera(dt) {
  const camGoalX = laneX * 0.6;
  camX += (camGoalX - camX) * Math.min(1, dt * CAM_LAG_RATE);

  const speedT = clamp01((speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
  const fov = BASE_FOV + speedT * FOV_BONUS;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

  camShakeAmt = Math.max(0, camShakeAmt - dt * 3.2);
  const shx = (Math.random() - 0.5) * camShakeAmt;
  const shy = (Math.random() - 0.5) * camShakeAmt;
  camera.position.set(camX + shx, CAM_UP + shy, CAM_BACK);
  camera.lookAt(camX * 0.5, 2.0, -16);
}
let camX = 0;

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let hidden = false;
document.addEventListener('visibilitychange', () => {
  hidden = document.hidden;
  if (!hidden) last = performance.now();
});
window.addEventListener('resize', onResize);
function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  if (hidden) return;
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.033);

  let scale = 1;
  if (timeSlowTimer > 0) { scale = 0.9; timeSlowTimer = Math.max(0, timeSlowTimer - dt); }
  const sdt = dt * scale;

  let envSpeed = 0;

  if (gameState === 'playing') {
    playT += sdt;
    speed = MAX_SPEED - (MAX_SPEED - BASE_SPEED) * Math.exp(-playT / SPEED_TAU);
    envSpeed = speed;
    distance += speed * sdt;

    updateAction(sdt);
    updateSpawning(sdt, speed);
    updateCollisions(sdt);

    if (magnetActive) {
      magnetTimer -= sdt;
      if (magnetTimer <= 0) { magnetActive = false; magnetTimer = 0; }
      magnetPip.hidden = false;
      magnetTimeEl.textContent = Math.ceil(magnetTimer);
    } else {
      magnetPip.hidden = true;
    }

    const df = Math.floor(distance);
    if (df !== lastDistanceShown) { setDistanceHud(distance); lastDistanceShown = df; if (df % 25 === 0 && df > 0) popDistance(); }
  } else if (gameState === 'crashing') {
    crashT += dt;
    camShakeAmt = 0.6 * (1 - crashT / 0.28);
    player.rotation.x += dt * 14;
    player.rotation.z += dt * 10;
    updateDebris(dt);
    if (crashT >= 0.28) { player.visible = false; finishCrash(); }
  } else if (gameState === 'start') {
    envSpeed = BASE_SPEED * 0.45;
    runCycle += 0; // idle: no bob
  } else if (gameState === 'over') {
    envSpeed = 0;
    updateDebris(dt);
  }

  updateEnvironment(dt, envSpeed);
  updatePlayerVisual(dt);
  updateCamera(dt);

  renderer.render(scene, camera);
}
let lastDistanceShown = -1;

// ---------------------------------------------------------------------------
// Install button (Add to Home Screen)
// ---------------------------------------------------------------------------
(() => {
  const btn = document.getElementById('install');
  const tip = document.getElementById('install-tip');
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  if (isIOS) btn.hidden = false;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') btn.hidden = true;
      deferred = null;
    } else {
      tip.hidden = false;
    }
  });
  document.getElementById('install-tip-close').addEventListener('click', (e) => { e.stopPropagation(); tip.hidden = true; });
  tip.addEventListener('pointerup', (e) => { if (e.target === tip) tip.hidden = true; });
  addEventListener('appinstalled', () => { btn.hidden = true; });
})();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
resetWorld();
gameState = 'start';
hud.classList.add('dim');
requestAnimationFrame(tick);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------
window.__test = {
  getState() {
    return {
      gameState, distance: Math.floor(distance), miles, speed,
      laneIndex, laneX, playerY, actionState, magnetActive, magnetTimer, best,
    };
  },
  start() { startGame(); },
  restart() { startGame(); },
  moveLeft() { changeLane(-1); },
  moveRight() { changeLane(1); },
  jump() { tryJump(); },
  slide() { trySlide(); },
  forceSpawn(type, lane = laneIndex, z = -1.2) { return spawnObstacle(type, lane, z); },
  forceMagnet(lane = laneIndex, z = -1.2) { return spawnMagnetPickup(lane, z); },
  forceCoin(lane = laneIndex, z = -1.2) { return spawnCoinAt(LANES[lane], 0.5, z); },
  clearObstacles() { deactivateAllObstacles(); },
  generateWave(difficulty) { return generateWave(difficulty); },
  waveGap(spd) { return waveGap(spd); },
  debugCoins() { return coins.filter((c) => c.active).map((c) => ({ x: c.x, y: c.y, z: c.z })); },
};
