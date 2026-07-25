import { installPause } from './pause.js';
import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// Constants / tuning
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const ACCENT = 0x22d3ee;
const DANGER = 0xff4d5e;
const GOLD = 0xffc24d;

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

const LEVEL_LEN = 12;                 // rings per level
const SLOW_SCALE = 0.55;              // physics speed while slow-mo is active
const SLOW_TIME = 6;                  // seconds granted per slow-mo token

const BEST_KEY = 'am.drop.best';
const SAVE_KEY = 'am.drop.save';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadSave() {
  const defaults = {
    stars: 0,
    ball: 'comet',
    maxLevel: 1,
    done: {},               // challenge id -> true
    unlocked: {},           // ball id -> true (unlock toast already shown)
    stats: { bounces: 0, smashes: 0, tokens: 0 },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!raw || typeof raw !== 'object') return defaults;
    return {
      ...defaults,
      ...raw,
      done: { ...(raw.done || {}) },
      unlocked: { ...(raw.unlocked || {}) },
      stats: { ...defaults.stats, ...(raw.stats || {}) },
    };
  } catch {
    return defaults;
  }
}

const save = loadSave();

function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {}
}

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

// ---------------------------------------------------------------------------
// Ball skins
// ---------------------------------------------------------------------------
const sphereGeo = new THREE.SphereGeometry(BALL_R, 32, 24);
const icoGeo = new THREE.IcosahedronGeometry(BALL_R, 0);

const BALLS = [
  {
    id: 'comet', name: 'Comet', cost: 0, halo: ACCENT, spin: 0,
    make: () => new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.65, roughness: 0.25, metalness: 0.0
    })),
  },
  {
    id: 'soccer', name: 'Soccer', cost: 3, halo: 0xe8f2ff, spin: 1.4,
    make: () => new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      map: texSoccer(), emissive: 0xbfd2e6, emissiveIntensity: 0.14, roughness: 0.5, metalness: 0.0
    })),
  },
  {
    id: 'basket', name: 'Basketball', cost: 6, halo: 0xff9a3c, spin: 1.4,
    make: () => new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      map: texBasketball(), emissive: 0xff8c3a, emissiveIntensity: 0.16, roughness: 0.6, metalness: 0.0
    })),
  },
  {
    id: 'prism', name: 'Prism', cost: 10, halo: 0xa78bfa, spin: 0.9,
    make: () => new THREE.Mesh(icoGeo, new THREE.MeshStandardMaterial({
      color: 0x9d8bff, emissive: 0x7c5cff, emissiveIntensity: 0.5, roughness: 0.15, metalness: 0.35, flatShading: true
    })),
  },
  {
    id: 'dragon', name: 'Dragon Orb', cost: 15, halo: 0xffb020, spin: 0.8,
    make: () => new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      map: texDragon(), emissive: 0xffb020, emissiveIntensity: 0.38, roughness: 0.12, metalness: 0.1
    })),
  },
];

function ballDef(id) { return BALLS.find((b) => b.id === id) || BALLS[0]; }
function ballUnlocked(def) { return def.cost <= save.stars || def.id === save.ball; }

// Ball: wrapper handles position + squash, inner mesh handles skin spin
const ballWrap = new THREE.Group();
scene.add(ballWrap);
let ball = null;
let curBall = null;
let baseEmissive = 0.65;

function applyBall(id) {
  const def = ballDef(id);
  if (ball) {
    ballWrap.remove(ball);
    ball.material.dispose();
  }
  ball = def.make();
  baseEmissive = ball.material.emissiveIntensity;
  ballWrap.add(ball);
  curBall = def;
  halo.material.color.setHex(def.halo);
  save.ball = def.id;
  persist();
}

// Halo sprite behind ball
const halo = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeHaloTexture(), color: ACCENT, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.9
}));
halo.scale.set(3.2, 3.2, 1);
scene.add(halo);

// Shield bubble around the ball
const shieldMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R * 1.5, 24, 18),
  new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
);
shieldMesh.visible = false;
scene.add(shieldMesh);

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
// Power-ups
// ---------------------------------------------------------------------------
const POWERS = {
  shield: { name: 'SHIELD', color: 0x34d399, geo: new THREE.TorusGeometry(0.3, 0.12, 12, 24) },
  slow:   { name: 'SLOW-MO', color: 0x60a5fa, geo: new THREE.OctahedronGeometry(0.4, 0) },
  blaze:  { name: 'BLAZE', color: 0xf59e0b, geo: new THREE.TetrahedronGeometry(0.46, 0) },
};

let shieldOn = false;
let slowT = 0;
let nextTokenAt = 0;

function pickPower() {
  const keys = Object.keys(POWERS);
  return keys[(Math.random() * keys.length) | 0];
}

function addToken(ring, slots) {
  const gaps = [];
  for (let i = 0; i < SLOTS; i++) if (slots[i] === 0) gaps.push(i);
  if (!gaps.length) return;
  const slot = gaps[(Math.random() * gaps.length) | 0];
  const type = pickPower();
  const p = POWERS[type];
  const pivot = new THREE.Group();
  pivot.rotation.y = slot * SLOT_ANGLE + SLOT_ANGLE * 0.03;
  const mid = SLOT_ANGLE * 0.47;
  const mesh = new THREE.Mesh(p.geo, new THREE.MeshStandardMaterial({
    color: p.color, emissive: p.color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.1
  }));
  mesh.position.set(Math.cos(mid) * ORBIT_R, 1.05, Math.sin(mid) * ORBIT_R);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeHaloTexture(), color: p.color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.7
  }));
  glow.scale.set(1.8, 1.8, 1);
  glow.position.copy(mesh.position);
  pivot.add(mesh);
  pivot.add(glow);
  ring.group.add(pivot);
  ring.token = { type, slot, pivot, mesh };
}

function collectToken(ring) {
  const t = ring.token;
  if (!t || t.slot !== slotIndexAtBall()) return;
  ring.group.remove(t.pivot);
  t.mesh.material.dispose();
  ring.token = null;
  run.tokens++;
  save.stats.tokens++;
  const p = POWERS[t.type];
  if (t.type === 'shield') setShield(true);
  else if (t.type === 'slow') slowT = Math.min(10, slowT + SLOW_TIME);
  else if (t.type === 'blaze') fever = true;
  toast(p.name + '!', 'toast-power', '#' + p.color.toString(16).padStart(6, '0'));
  spawnSplash(ring.y, p.color);
  navigator.vibrate?.(15);
  checkChallenges();
}

function setShield(on) {
  shieldOn = on;
  shieldMesh.visible = on;
  chipShield.hidden = !on;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------
const CHALLENGES = [
  { id: 'score10',  name: 'Warming Up',     desc: 'Score 10 in one run',            stars: 1, target: 10,  get: () => run.score },
  { id: 'fall5',    name: 'Free Fall',      desc: 'Pass 5 rings in one drop',       stars: 1, target: 5,   get: () => run.maxStreak },
  { id: 'smash1',   name: 'First Smash',    desc: 'Smash a platform with fever',    stars: 1, target: 1,   get: () => run.smashes },
  { id: 'level3',   name: 'Going Down',     desc: 'Reach level 3',                  stars: 2, target: 3,   get: () => run.level },
  { id: 'score25',  name: 'In the Zone',    desc: 'Score 25 in one run',            stars: 2, target: 25,  get: () => run.score },
  { id: 'token5',   name: 'Collector',      desc: 'Grab 5 power-ups in total',      stars: 2, target: 5,   get: () => save.stats.tokens },
  { id: 'smash3',   name: 'Demolition',     desc: 'Smash 3 platforms in one run',   stars: 2, target: 3,   get: () => run.smashes },
  { id: 'bounce200', name: 'Bouncy',        desc: 'Bounce 200 times in total',      stars: 2, target: 200, get: () => save.stats.bounces },
  { id: 'level5',   name: 'Deep Cut',       desc: 'Reach level 5',                  stars: 3, target: 5,   get: () => run.level },
  { id: 'score50',  name: 'Unstoppable',    desc: 'Score 50 in one run',            stars: 3, target: 50,  get: () => run.score },
  { id: 'shield1',  name: 'Guardian',       desc: 'Block a red slot with a shield', stars: 2, target: 1,   get: () => run.shieldSaves },
  { id: 'fall8',    name: 'Skydiver',       desc: 'Pass 8 rings in one drop',       stars: 3, target: 8,   get: () => run.maxStreak },
  { id: 'smash25',  name: 'Wrecking Ball',  desc: 'Smash 25 platforms in total',    stars: 3, target: 25,  get: () => save.stats.smashes },
  { id: 'level8',   name: 'Into the Abyss', desc: 'Reach level 8',                  stars: 4, target: 8,   get: () => run.level },
  { id: 'score100', name: 'Century',        desc: 'Score 100 in one run',           stars: 5, target: 100, get: () => run.score },
];

function activeChallenges() {
  return CHALLENGES.filter((c) => !save.done[c.id]).slice(0, 3);
}

function checkChallenges() {
  let earned = 0;
  for (const c of activeChallenges()) {
    if (c.get() >= c.target) {
      save.done[c.id] = true;
      earned += c.stars;
      run.starsEarned += c.stars;
      toast('★ ' + c.name + '  +' + c.stars + '★', 'toast-star');
    }
  }
  if (earned) addStars(earned);
}

function addStars(n) {
  save.stars += n;
  persist();
  starsValEl.textContent = save.stars;
  for (const def of BALLS) {
    if (def.cost > 0 && def.cost <= save.stars && !save.unlocked[def.id]) {
      save.unlocked[def.id] = true;
      persist();
      toast('New ball unlocked: ' + def.name + '!', 'toast-unlock');
    }
  }
}

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
let worldT = 0;              // running clock for token bobbing

let best = parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;

// per-run counters feeding challenges
const run = { score: 0, smashes: 0, maxStreak: 0, level: 1, tokens: 0, shieldSaves: 0, starsEarned: 0 };
function resetRun() {
  run.score = 0; run.smashes = 0; run.maxStreak = 0; run.level = 1;
  run.tokens = 0; run.shieldSaves = 0; run.starsEarned = 0;
}

function curLevel() { return Math.floor(passIndex / LEVEL_LEN) + 1; }

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
const scoreEl = document.getElementById('score');
const bestValEl = document.getElementById('bestVal');
const starsValEl = document.getElementById('starsVal');
const lvlCurEl = document.getElementById('lvlCur');
const lvlNextEl = document.getElementById('lvlNext');
const lvlFillEl = document.getElementById('lvlFill');
const chipShield = document.getElementById('chipShield');
const chipSlow = document.getElementById('chipSlow');
const chipSlowFill = document.getElementById('chipSlowFill');
const chipBlaze = document.getElementById('chipBlaze');
const slowFx = document.getElementById('slowfx');
const toastsEl = document.getElementById('toasts');
const startEl = document.getElementById('start');
const overEl = document.getElementById('over');
const overScoreEl = document.getElementById('overScore');
const overBestEl = document.getElementById('overBest');
const overLevelEl = document.getElementById('overLevel');
const overStarsEl = document.getElementById('overStars');
bestValEl.textContent = best;
starsValEl.textContent = save.stars;

function toast(text, cls, color) {
  const div = document.createElement('div');
  div.className = 'toast ' + (cls || '');
  div.textContent = text;
  if (color) div.style.color = color;
  toastsEl.appendChild(div);
  while (toastsEl.children.length > 3) toastsEl.removeChild(toastsEl.firstChild);
  setTimeout(() => { div.classList.add('out'); }, 1700);
  setTimeout(() => { div.remove(); }, 2100);
}

function setLevelBar() {
  const lvl = curLevel();
  lvlCurEl.textContent = lvl;
  lvlNextEl.textContent = lvl + 1;
  lvlFillEl.style.width = ((passIndex % LEVEL_LEN) / LEVEL_LEN * 100).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Ball picker + challenge list UI (rendered into both overlays)
// ---------------------------------------------------------------------------
const previews = {};

function buildPreviews() {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  r.setPixelRatio(1);
  r.setSize(112, 112);
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xbfc4ff, 0x11101c, 1.1));
  const d = new THREE.DirectionalLight(0xffffff, 1.6);
  d.position.set(2, 3, 4);
  sc.add(d);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 10);
  cam.position.set(0, 0.35, 2.45);
  cam.lookAt(0, 0, 0);
  for (const def of BALLS) {
    const mesh = def.make();
    mesh.rotation.set(0.35, -0.7, 0);
    sc.add(mesh);
    r.render(sc, cam);
    previews[def.id] = r.domElement.toDataURL();
    sc.remove(mesh);
    mesh.material.dispose();
  }
  r.dispose();
  r.forceContextLoss?.();
}

function renderPickers() {
  for (const el of document.querySelectorAll('.picker')) {
    el.innerHTML = '';
    for (const def of BALLS) {
      const unlocked = ballUnlocked(def);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ball-btn' + (def.id === save.ball ? ' sel' : '') + (unlocked ? '' : ' locked');
      const img = document.createElement('img');
      img.src = previews[def.id] || '';
      img.alt = def.name;
      img.draggable = false;
      btn.appendChild(img);
      const tag = document.createElement('span');
      tag.className = 'ball-tag';
      tag.textContent = unlocked ? def.name : def.cost + '★';
      btn.appendChild(tag);
      for (const t of ['pointerdown', 'pointerup', 'click']) {
        btn.addEventListener(t, (e) => e.stopPropagation());
      }
      btn.addEventListener('click', () => {
        if (unlocked) {
          applyBall(def.id);
          renderPickers();
        } else {
          toast('Earn ' + (def.cost - save.stars) + '★ more to unlock ' + def.name, 'toast-dim');
          btn.classList.add('shake');
          setTimeout(() => btn.classList.remove('shake'), 350);
        }
      });
      el.appendChild(btn);
    }
  }
}

function renderChallenges() {
  const active = activeChallenges();
  for (const el of document.querySelectorAll('.ch-list')) {
    el.innerHTML = '';
    if (!active.length) {
      const donEl = document.createElement('p');
      donEl.className = 'ch-done-all';
      donEl.textContent = 'All challenges complete!';
      el.appendChild(donEl);
      continue;
    }
    for (const c of active) {
      const v = Math.min(c.target, c.get());
      const row = document.createElement('div');
      row.className = 'ch-row';
      row.innerHTML =
        '<div class="ch-top"><span class="ch-name">' + c.name + '</span>' +
        '<span class="ch-val">' + v + '/' + c.target + ' · ' + c.stars + '★</span></div>' +
        '<div class="ch-desc">' + c.desc + '</div>' +
        '<div class="ch-bar"><div class="ch-fill" style="width:' + (v / c.target * 100).toFixed(0) + '%"></div></div>';
      el.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------------
// Ring generation
// ---------------------------------------------------------------------------
function makeSlots(index) {
  const slots = new Array(SLOTS).fill(1); // 1 solid, 0 gap, 2 danger
  const lvl = Math.floor(index / LEVEL_LEN) + 1;
  const pos = index % LEVEL_LEN;

  const gapWidth = Math.max(2, 4 - Math.floor((lvl - 1) / 3));
  const gapStart = (Math.random() * SLOTS) | 0;
  for (let k = 0; k < gapWidth; k++) slots[(gapStart + k) % SLOTS] = 0;

  // occasional second gap once the tower deepens
  if (lvl >= 2 && Math.random() < Math.min(0.5, 0.1 + lvl * 0.06)) {
    const g2 = (gapStart + (SLOTS / 2) + (((Math.random() * 3) | 0) - 1) + SLOTS) % SLOTS;
    for (let k = 0; k < 2; k++) slots[(g2 + k) % SLOTS] = 0;
  }

  // danger ramps with level; the first two rings of each level are a breather
  if (index > 2 && pos >= 2) {
    const dFrac = Math.min(0.55, 0.04 + (lvl - 1) * 0.055 + pos * 0.004);
    for (let i = 0; i < SLOTS; i++) {
      if (slots[i] === 1 && Math.random() < dFrac) slots[i] = 2;
    }
  }

  // guarantee the very first ring is a safe, obvious landing
  if (index === 0) {
    slots[slotIndexAtBall()] = 1;
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
  const ring = { index, group, slots, y: group.position.y, token: null };
  if (index >= nextTokenAt && index > 2) {
    addToken(ring, slots);
    nextTokenAt = index + 8 + ((Math.random() * 7) | 0);
  }
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

function slotIndexAtBall() {
  // A positive rotation.y moves geometry toward negative atan2(z,x), so slot i
  // (mesh.rotation.y = (i + 0.03) * SLOT_ANGLE, arc span 0.94 * SLOT_ANGLE)
  // covers world angle -(i + 0.03)…-(i - 0.91) slots; invert the ball angle to
  // match, and nudge by 0.94 so the 6% margin between segments splits evenly.
  let local = -(BALL_ANGLE + tower.rotation.y);
  local = ((local % TAU) + TAU) % TAU;
  return Math.floor(local / SLOT_ANGLE + 0.94) % SLOTS;
}

function slotTypeAtBall(ring) {
  return ring.slots[slotIndexAtBall()];
}

// ---------------------------------------------------------------------------
// Fever smash: detach a ring's segments and fling them
// ---------------------------------------------------------------------------
function smashRing(ring) {
  if (ring.token) {
    ring.group.remove(ring.token.pivot);
    ring.token.mesh.material.dispose();
    ring.token = null;
  }
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
  run.smashes++;
  save.stats.smashes++;
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
  save.stats.bounces++;
  spawnSplash(ring.y, curBall.halo);
  checkChallenges();
}

function afterPass() {
  run.score = score;
  run.maxStreak = Math.max(run.maxStreak, combo);
  const lvl = curLevel();
  if (lvl > run.level) {
    run.level = lvl;
    let msg = 'LEVEL ' + lvl;
    if (lvl > save.maxLevel) {
      save.maxLevel = lvl;
      run.starsEarned += 1;
      addStars(1);
      msg += '  +1★';
    }
    toast(msg, 'toast-level');
    spawnSplash(ballY - BALL_R, GOLD);
    fovPulse = 6;
    navigator.vibrate?.([15, 40, 15]);
  }
  setLevelBar();
  checkChallenges();
}

function passRing() {
  score++;
  combo++;
  passIndex++;
  if (combo >= 3) fever = true;
  navigator.vibrate?.(10);
  setScore(score);
  popScore();
  afterPass();
}

function smashPass(ring) {
  smashRing(ring);
  score++;
  passIndex++;
  combo = 0;
  fever = false;
  navigator.vibrate?.(10);
  setScore(score);
  popScore();
  afterPass();
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
      // gap: fall through (and maybe scoop up a power-up on the way)
      collectToken(ring);
      passRing();
    } else if (fever) {
      // blaze through the next platform, danger or not — then fever is spent
      smashPass(ring);
    } else if (type === 2) {
      if (shieldOn) {
        setShield(false);
        run.shieldSaves++;
        toast('SHIELD SAVED YOU', 'toast-power', '#34d399');
        smashPass(ring);
      } else {
        die();
      }
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
  slowT = 0;
  setShield(false);
  nextTokenAt = 5 + ((Math.random() * 4) | 0);
  resetRun();
  setScore(0);
  setLevelBar();
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
  persist();
  overScoreEl.textContent = score;
  overBestEl.textContent = best;
  overLevelEl.textContent = run.level;
  overStarsEl.textContent = run.starsEarned > 0 ? '+' + run.starsEarned + '★ earned' : '';
  overStarsEl.hidden = run.starsEarned === 0;
  renderPickers();
  renderChallenges();
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
  if (pause.active) { last = now; return; }
  let dt = (now - last) / 1000;
  last = now;
  dt = Math.min(dt, 0.033); // clamp to avoid teleport after tab switch
  worldT += dt;

  updateInput(dt);

  if (state === 'playing') {
    const wasSlow = slowT > 0;
    slowT = Math.max(0, slowT - dt);
    if (wasSlow !== (slowT > 0)) slowFx.classList.toggle('on', slowT > 0);
    const pdt = dt * (slowT > 0 ? SLOW_SCALE : 1);
    ballVy += GRAVITY * pdt;
    ballY += ballVy * pdt;
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
    spawnSplash(ring ? ring.y : 0, curBall.halo);
  }
}

function updateVisuals(dt) {
  // fever amount smoothing
  feverAmt += ((fever ? 1 : 0) - feverAmt) * Math.min(1, dt * 10);

  // ball position + squash on the wrapper, skin spin on the mesh
  ballWrap.position.set(0, ballY, ORBIT_R);
  bounceAnim = Math.max(0, bounceAnim - dt * 5.5);
  const sq = bounceAnim;
  const fScale = 1 + 0.28 * feverAmt;
  ballWrap.scale.set((1 + 0.22 * sq) * fScale, (1 - 0.30 * sq) * fScale, (1 + 0.22 * sq) * fScale);
  if (curBall.spin) {
    ball.rotation.x -= curBall.spin * dt;
    if (curBall.id === 'prism') ball.rotation.y += 0.6 * dt;
  }
  if (curBall.id === 'comet') {
    ball.material.emissiveIntensity = 0.65 + 1.2 * feverAmt;
    ball.material.color.setHex(ACCENT).lerp(new THREE.Color(0xffffff), 0.5 * feverAmt);
    ball.material.emissive.setHex(ACCENT).lerp(new THREE.Color(0xffffff), 0.35 * feverAmt);
  } else {
    ball.material.emissiveIntensity = baseEmissive + 1.1 * feverAmt;
  }

  // fever chip (armed by combo or a blaze token)
  chipBlaze.hidden = !fever;

  // slow-mo chip
  chipSlow.hidden = slowT <= 0;
  if (slowT > 0) chipSlowFill.style.width = (Math.min(1, slowT / SLOW_TIME) * 100).toFixed(0) + '%';

  // halo
  halo.position.copy(ballWrap.position);
  halo.scale.setScalar((3.0 + 1.6 * feverAmt) + 0.4 * sq);
  halo.material.opacity = 0.55 + 0.4 * feverAmt;

  // shield bubble
  if (shieldOn) {
    shieldMesh.position.copy(ballWrap.position);
    shieldMesh.scale.setScalar(1 + Math.sin(worldT * 5) * 0.06);
    shieldMesh.material.opacity = 0.24 + Math.sin(worldT * 5) * 0.06;
  }

  // power-up tokens: spin and bob
  for (const [, ring] of ringMap) {
    if (!ring.token) continue;
    ring.token.mesh.rotation.y += 2.4 * dt;
    ring.token.mesh.rotation.x = Math.sin(worldT * 2 + ring.index) * 0.4;
    ring.token.mesh.position.y = 1.05 + Math.sin(worldT * 3 + ring.index) * 0.14;
  }

  rim.color.setHex(slowT > 0 ? 0x60a5fa : curBall.halo);
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

function ballCanvas() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  return c;
}

function canvasTex(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function drawStar(g, cx, cy, r, color) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

function drawPentagon(g, cx, cy, r, rot, color) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = rot + (i * TAU) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
}

let _texSoccer = null;
function texSoccer() {
  if (_texSoccer) return _texSoccer;
  const c = ballCanvas();
  const g = c.getContext('2d');
  g.fillStyle = '#f2f3f7';
  g.fillRect(0, 0, 512, 256);
  // faint seams
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 3;
  for (let x = 0; x < 512; x += 85) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 40, 128); g.lineTo(x, 256); g.stroke();
  }
  // pentagons in two offset rows (wraps horizontally: 512/85 ≈ 6 columns)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 6; col++) {
      const cx = col * 85 + (row === 0 ? 22 : 64);
      const cy = row === 0 ? 74 : 182;
      drawPentagon(g, cx, cy, 26, row * 0.6 + col * 0.3, '#17171f');
    }
  }
  _texSoccer = canvasTex(c);
  return _texSoccer;
}

let _texBasket = null;
function texBasketball() {
  if (_texBasket) return _texBasket;
  const c = ballCanvas();
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#e87a2a');
  grad.addColorStop(0.5, '#e06a1e');
  grad.addColorStop(1, '#c85a18');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  // pebble specks
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let i = 0; i < 500; i++) {
    g.fillRect((Math.random() * 512) | 0, (Math.random() * 256) | 0, 2, 2);
  }
  g.strokeStyle = '#1d130c';
  g.lineWidth = 7;
  // equator
  g.beginPath(); g.moveTo(0, 128); g.lineTo(512, 128); g.stroke();
  // two vertical seams (u=0 and u=0.5 so the texture wraps cleanly)
  g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 256); g.stroke();
  g.beginPath(); g.moveTo(512, 0); g.lineTo(512, 256); g.stroke();
  g.beginPath(); g.moveTo(256, 0); g.lineTo(256, 256); g.stroke();
  // side curves
  g.beginPath(); g.ellipse(128, 128, 88, 120, 0, 0, TAU); g.stroke();
  g.beginPath(); g.ellipse(384, 128, 88, 120, 0, 0, TAU); g.stroke();
  _texBasket = canvasTex(c);
  return _texBasket;
}

let _texDragon = null;
function texDragon() {
  if (_texDragon) return _texDragon;
  const c = ballCanvas();
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#ffd75e');
  grad.addColorStop(0.5, '#ffb92e');
  grad.addColorStop(1, '#f59300');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  // soft inner glow at the front of the ball (u=0.25 faces the camera start)
  const rg = g.createRadialGradient(128, 128, 10, 128, 128, 130);
  rg.addColorStop(0, 'rgba(255,255,255,0.5)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 512, 256);
  // four red stars clustered on the front (classic four-star ball)
  drawStar(g, 108, 104, 26, '#e0202e');
  drawStar(g, 152, 118, 26, '#e0202e');
  drawStar(g, 112, 152, 26, '#e0202e');
  drawStar(g, 156, 160, 26, '#e0202e');
  // mirrored cluster on the far side so it reads while spinning
  drawStar(g, 364, 110, 26, '#e0202e');
  drawStar(g, 404, 130, 26, '#e0202e');
  drawStar(g, 370, 156, 26, '#e0202e');
  _texDragon = canvasTex(c);
  return _texDragon;
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
applyBall(ballDef(save.ball).cost <= save.stars ? save.ball : 'comet');
// balls the player could already afford shouldn't re-toast later
for (const def of BALLS) if (def.cost <= save.stars) save.unlocked[def.id] = true;
buildPreviews();
renderPickers();
renderChallenges();
resetGame();
state = 'start';
const pause = installPause({ canPause: () => state === 'playing' });
requestAnimationFrame(tick);

// tiny debug/test handle (not used by the game itself)
window.__drop = {
  get state() { return state; },
  get save() { return save; },
  get run() { return run; },
  addStars,
  renderPickers,
  renderChallenges,
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
