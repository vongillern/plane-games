import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const ACCENT = 0x22d3ee;
const DANGER = 0xff4d5e;

const SLOTS = 16;
const SLOT_ANGLE = TAU / SLOTS;
const BALL_ANGLE = Math.PI / 2;      // fixed world angle the ball sits at (0,y,+R)

const RING_INNER = 2.4;
const RING_OUTER = 4.4;
const RING_HEIGHT = 0.6;
const RING_GAP = 3.7;                 // vertical spacing between rings
const ORBIT_R = 3.4;                  // ball distance from column centre

const BALL_R = 0.55;
const GRAVITY = -30;
const BOUNCE_V = 11.5;   // apex ~2.2 keeps the ball clear of the ring above (underside at 3.1)

const AHEAD = 7;                      // rings generated below the ball
const KEEP_ABOVE = 2;                 // rings kept above before recycling

const CAM_UP = 6.5;
const CAM_BACK = 7.5;
const BASE_FOV = 55;

const SENS = 0.009;                   // radians per pixel of drag
const KEY_SPEED = 2.6;

const BEST_KEY = 'am.drop.best';

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = makeGradientTexture();
scene.fog = new THREE.Fog(0x0b0b17, 12, 40);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 200);

// Lights
const hemi = new THREE.HemisphereLight(0x9a8cff, 0x0a0a12, 0.85);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xdfe4ff, 1.15);
key.position.set(3, 12, 6);
scene.add(key);
const rim = new THREE.PointLight(ACCENT, 0.6, 30);
scene.add(rim);

// ---------------------------------------------------------------------------
// Shared geometry / materials
// ---------------------------------------------------------------------------
const slotGeo = makeSlotGeo();

const matPlatform = new THREE.MeshStandardMaterial({ color: 0x4a4a6e, roughness: 0.55, metalness: 0.05, flatShading: false });
const matDanger = new THREE.MeshStandardMaterial({ color: DANGER, emissive: DANGER, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.0 });

// Central column (decorative spine)
const column = new THREE.Mesh(
  new THREE.CylinderGeometry(1.9, 1.9, 80, 24, 1, true),
  new THREE.MeshStandardMaterial({ color: 0x1a1a2e, emissive: 0x14142a, emissiveIntensity: 0.4, roughness: 0.8, metalness: 0.0, side: THREE.DoubleSide })
);
scene.add(column);

// Tower group (rotates)
const tower = new THREE.Group();
scene.add(tower);

// Ball
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 32, 24),
  new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.65, roughness: 0.25, metalness: 0.0 })
);
scene.add(ball);

// Halo sprite behind ball
const halo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeHaloTexture(), color: ACCENT, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.9
}));
halo.scale.set(3.2, 3.2, 1);
scene.add(halo);

// Splash ring pool
const splashGeo = new THREE.RingGeometry(0.55, 0.75, 40);
splashGeo.rotateX(-Math.PI / 2);
const splashes = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(splashGeo, new THREE.MeshBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
  }));
  m.visible = false;
  scene.add(m);
  splashes.push({ mesh: m, t: 0 });
}

// Broken pieces (fever smash debris)
const pieces = [];

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const ringMap = new Map();   // index -> ring
let generatedUpTo = 0;
let passIndex = 0;
let score = 0;
let combo = 0;
let fever = false;
let feverAmt = 0;

let state = 'start';         // 'start' | 'playing' | 'over'

let ballY = 2;
let ballVy = 0;
let camY = 2;
let camGoalY = 2;

let bounceAnim = 0;          // squash-and-stretch envelope (1 -> 0)
let camShake = 0;
let fovPulse = 0;

let best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('score');
const bestValEl = document.getElementById('bestVal');
const startEl = document.getElementById('start');
const overEl = document.getElementById('over');
const overScoreEl = document.getElementById('overScore');
const overBestEl = document.getElementById('overBest');
bestValEl.textContent = best;

// ---------------------------------------------------------------------------
// Ring generation
// ---------------------------------------------------------------------------
function makeSlots(index) {
  const slots = new Array(SLOTS).fill(1); // 1 solid, 0 gap, 2 danger
  const gapWidth = Math.max(2, 4 - Math.floor(index / 12));
  const gapStart = (Math.random() * SLOTS) | 0;
  for (let k = 0; k < gapWidth; k++) slots[(gapStart + k) % SLOTS] = 0;

  // occasional second gap once deep
  if (index > 18 && Math.random() < 0.4) {
    const g2 = (gapStart + (SLOTS / 2) + (((Math.random() * 3) | 0) - 1) + SLOTS) % SLOTS;
    for (let k = 0; k < 2; k++) slots[(g2 + k) % SLOTS] = 0;
  }

  // danger ramps in after a short grace period
  if (index > 2) {
    const dFrac = Math.min(0.55, index * 0.02);
    for (let i = 0; i < SLOTS; i++) {
      if (slots[i] === 1 && Math.random() < dFrac) slots[i] = 2;
    }
  }

  // guarantee the very first ring is a safe, obvious landing
  if (index === 0) {
    const under = Math.floor((((BALL_ANGLE) % TAU) + TAU) % TAU / SLOT_ANGLE) % SLOTS;
    slots[under] = 1;
  }
  return slots;
}

function createRing(index) {
  const group = new THREE.Group();
  group.position.y = -index * RING_GAP;
  const slots = makeSlots(index);
  for (let i = 0; i < SLOTS; i++) {
    if (slots[i] === 0) continue;
    const mesh = new THREE.Mesh(slotGeo, slots[i] === 2 ? matDanger : matPlatform);
    mesh.rotation.y = i * SLOT_ANGLE + SLOT_ANGLE * 0.03;
    group.add(mesh);
  }
  tower.add(group);
  const ring = { index, group, slots, y: group.position.y };
  ringMap.set(index, ring);
  return ring;
}

function ensureRings() {
  while (generatedUpTo <= passIndex + AHEAD) {
    createRing(generatedUpTo);
    generatedUpTo++;
  }
  // recycle rings well above the ball
  for (const [idx, ring] of ringMap) {
    if (idx < passIndex - KEEP_ABOVE) {
      tower.remove(ring.group);
      ringMap.delete(idx);
    }
  }
}

function slotTypeAtBall(ring) {
  let local = BALL_ANGLE - tower.rotation.y;
  local = ((local % TAU) + TAU) % TAU;
  const idx = Math.floor(local / SLOT_ANGLE) % SLOTS;
  return ring.slots[idx];
}

// ---------------------------------------------------------------------------
// Fever smash: detach a ring's segments and fling them
// ---------------------------------------------------------------------------
function smashRing(ring) {
  const meshes = ring.group.children.slice();
  for (const mesh of meshes) {
    scene.attach(mesh); // preserve world transform
    const mat = mesh.material.clone();
    mat.transparent = true;
    mesh.material = mat;
    const dir = mesh.position.clone().setY(0).normalize();
    pieces.push({
      mesh,
      vx: dir.x * (3 + Math.random() * 4) + (Math.random() - 0.5) * 2,
      vy: 2 + Math.random() * 4,
      vz: dir.z * (3 + Math.random() * 4) + (Math.random() - 0.5) * 2,
      rx: (Math.random() - 0.5) * 8,
      rz: (Math.random() - 0.5) * 8,
      life: 0.75
    });
  }
  tower.remove(ring.group);
  ringMap.delete(ring.index);
  camShake = 0.55;
  fovPulse = 7;
  navigator.vibrate?.(20);
}

function updatePieces(dt) {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    p.vy += GRAVITY * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.rotation.x += p.rx * dt;
    p.mesh.rotation.z += p.rz * dt;
    p.life -= dt;
    p.mesh.material.opacity = Math.max(0, p.life / 0.75);
    if (p.life <= 0) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      pieces.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------
function spawnSplash(y, color) {
  const s = splashes.find((x) => !x.mesh.visible) || splashes[0];
  s.mesh.visible = true;
  s.mesh.position.set(0, y + 0.02, ORBIT_R);
  s.mesh.scale.setScalar(0.4);
  s.mesh.material.color.setHex(color);
  s.mesh.material.opacity = 0.85;
  s.t = 0.001;
}

function updateSplashes(dt) {
  for (const s of splashes) {
    if (!s.mesh.visible) continue;
    s.t += dt;
    const k = Math.min(1, s.t / 0.4);
    s.mesh.scale.setScalar(0.4 + k * 1.6);
    s.mesh.material.opacity = 0.85 * (1 - k);
    if (k >= 1) { s.mesh.visible = false; s.t = 0; }
  }
}

// ---------------------------------------------------------------------------
// Bounce / pass resolution
// ---------------------------------------------------------------------------
function bounce(ring) {
  ballY = ring.y + BALL_R;
  ballVy = BOUNCE_V;
  bounceAnim = 1;
  combo = 0;
  fever = false;
  spawnSplash(ring.y, ACCENT);
}

function passRing() {
  score++;
  combo++;
  passIndex++;
  if (combo >= 3) fever = true;
  navigator.vibrate?.(10);
  setScore(score);
  popScore();
}

let popTimer = 0;
function popScore() {
  scoreEl.classList.add('pop');
  clearTimeout(popTimer);
  popTimer = setTimeout(() => scoreEl.classList.remove('pop'), 180);
}

function resolveCollisions() {
  const ring = ringMap.get(passIndex);
  if (!ring) return;
  const contactY = ring.y + BALL_R;
  if (ballVy < 0 && ballY <= contactY) {
    const type = slotTypeAtBall(ring);
    if (type === 0) {
      // gap: fall through
      passRing();
    } else if (fever) {
      // blaze through the next platform, danger or not — then fever is spent
      smashRing(ring);
      score++;
      passIndex++;
      combo = 0;
      fever = false;
      navigator.vibrate?.(10);
      setScore(score);
      popScore();
    } else if (type === 2) {
      die();
    } else {
      bounce(ring);
    }
  }
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
function setScore(v) { scoreEl.textContent = v; }

function resetGame() {
  // clear rings
  for (const [, ring] of ringMap) tower.remove(ring.group);
  ringMap.clear();
  // clear pieces
  for (const p of pieces) { scene.remove(p.mesh); p.mesh.material.dispose(); }
  pieces.length = 0;

  tower.rotation.y = 0;
  rotVel = 0;
  generatedUpTo = 0;
  passIndex = 0;
  score = 0;
  combo = 0;
  fever = false;
  feverAmt = 0;
  ballY = 2;
  ballVy = 0;
  camY = 2;
  camGoalY = 2;
  bounceAnim = 0;
  camShake = 0;
  fovPulse = 0;
  setScore(0);
  ensureRings();
}

function startGame() {
  resetGame();
  state = 'playing';
  startEl.classList.add('hidden');
  overEl.classList.add('hidden');
  hud.classList.remove('dim');
}

function die() {
  state = 'over';
  navigator.vibrate?.(30);
  if (score > best) {
    best = score;
    localStorage.setItem(BEST_KEY, String(best));
    bestValEl.textContent = best;
  }
  overScoreEl.textContent = score;
  overBestEl.textContent = best;
  hud.classList.add('dim');
  overEl.classList.remove('hidden');
}

function handleTap() {
  if (state === 'start' || state === 'over') startGame();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let rotVel = 0;
let dragging = false;
let lastX = 0;
let lastT = 0;
let downX = 0, downY = 0;
let keyLeft = false, keyRight = false;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastT = performance.now();
  downX = e.clientX; downY = e.clientY;
  rotVel = 0;
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  const dx = e.clientX - lastX;
  const d = dx * SENS;
  tower.rotation.y += d;
  if (dt > 0.0001) rotVel = Math.max(-12, Math.min(12, d / dt));
  lastX = e.clientX;
  lastT = now;
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
  if (moved < 9) handleTap();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', () => { dragging = false; });

startEl.addEventListener('pointerup', handleTap);
overEl.addEventListener('pointerup', handleTap);

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyLeft = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyRight = true;
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'r' || e.key === 'R') {
    if (state !== 'playing') { e.preventDefault(); handleTap(); }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') keyLeft = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyRight = false;
});

// ---------------------------------------------------------------------------
// Resize / visibility
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  if (hidden) return;
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.033); // clamp to avoid teleport after tab switch

  updateInput(dt);

  if (state === 'playing') {
    ballVy += GRAVITY * dt;
    ballY += ballVy * dt;
    resolveCollisions();
    ensureRings();
    // safety: fell into the void (shouldn't happen, gaps lead to next ring)
    if (ballY < camY - 40) die();
  } else if (state === 'start') {
    idleBounce(dt);
    tower.rotation.y += 0.12 * dt;
  }

  updateVisuals(dt);
  renderer.render(scene, camera);
}

function updateInput(dt) {
  if (keyLeft) tower.rotation.y += KEY_SPEED * dt;
  if (keyRight) tower.rotation.y -= KEY_SPEED * dt;
  if (!dragging) {
    tower.rotation.y += rotVel * dt;
    rotVel *= Math.exp(-dt * 5);
    if (Math.abs(rotVel) < 0.0005) rotVel = 0;
  }
}

function idleBounce(dt) {
  ballVy += GRAVITY * dt;
  ballY += ballVy * dt;
  const ring = ringMap.get(0);
  const contactY = (ring ? ring.y : 0) + BALL_R;
  if (ballVy < 0 && ballY <= contactY) {
    ballY = contactY;
    ballVy = BOUNCE_V;
    bounceAnim = 1;
    spawnSplash(ring ? ring.y : 0, ACCENT);
  }
}

function updateVisuals(dt) {
  // fever amount smoothing
  feverAmt += (( fever ? 1 : 0) - feverAmt) * Math.min(1, dt * 10);

  // ball position + squash
  ball.position.set(0, ballY, ORBIT_R);
  bounceAnim = Math.max(0, bounceAnim - dt * 5.5);
  const sq = bounceAnim;
  const fScale = 1 + 0.28 * feverAmt;
  ball.scale.set((1 + 0.22 * sq) * fScale, (1 - 0.30 * sq) * fScale, (1 + 0.22 * sq) * fScale);
  ball.material.emissiveIntensity = 0.65 + 1.2 * feverAmt;
  ball.material.color.setHex(ACCENT).lerp(new THREE.Color(0xffffff), 0.5 * feverAmt);
  ball.material.emissive.setHex(ACCENT).lerp(new THREE.Color(0xffffff), 0.35 * feverAmt);

  // halo
  halo.position.copy(ball.position);
  halo.scale.setScalar((3.0 + 1.6 * feverAmt) + 0.4 * sq);
  halo.material.opacity = 0.55 + 0.4 * feverAmt;

  rim.position.set(0, ballY + 0.5, ORBIT_R);
  rim.intensity = 0.5 + 1.4 * feverAmt;

  // column follows
  column.position.y = camY;

  updateSplashes(dt);
  updatePieces(dt);

  // camera: follow ball downward only (monotonic), smooth
  camGoalY = Math.min(camGoalY, ballY);
  camY += (camGoalY - camY) * Math.min(1, dt * 6.5);

  camShake = Math.max(0, camShake - dt * 2.2);
  fovPulse = Math.max(0, fovPulse - dt * 22);
  const shx = (Math.random() - 0.5) * camShake;
  const shy = (Math.random() - 0.5) * camShake;
  camera.position.set(shx, camY + CAM_UP + shy, ORBIT_R + CAM_BACK);
  camera.lookAt(0, camY - 4.2, 0);
  const fov = BASE_FOV + fovPulse;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------------------
// Texture helpers
// ---------------------------------------------------------------------------
function makeGradientTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#181633');
  grad.addColorStop(0.45, '#101026');
  grad.addColorStop(1, '#08080f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHaloTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(34,211,238,0.55)');
  grad.addColorStop(1, 'rgba(34,211,238,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSlotGeo() {
  const shape = new THREE.Shape();
  const span = SLOT_ANGLE * 0.94;
  shape.absarc(0, 0, RING_OUTER, 0, span, false);
  shape.absarc(0, 0, RING_INNER, span, 0, true);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: RING_HEIGHT, bevelEnabled: false, curveSegments: 20 });
  geo.rotateX(Math.PI / 2);   // lay flat, thickness hangs below y=0, top face at y=0
  return geo;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
resetGame();
state = 'start';
requestAnimationFrame(tick);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
