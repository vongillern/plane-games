import { installPause } from './pause.js';
import * as THREE from './vendor/three.module.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';

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

const PICKUP_CADENCE = 20;               // seconds between powerup spawns
const MAGNET_DURATION = 6;
const MAGNET_RADIUS = 4.5;
const JETPACK_DURATION = 5.5;
const JET_HEIGHT = 4.2;                  // cruise altitude while jetpacking
const SNEAKERS_DURATION = 8;
const SNEAKERS_JUMP = 2.7;               // boosted jump clears tankers and lands on roofs
const MULT_DURATION = 15;                // 2x score powerup
const SHIELD_DURATION = 20;              // hoverboard: absorbs one crash
const STUMBLE_WINDOW = 8;                // guard chases this long after a stumble
const KEYS_KEY = 'am.runway.keys';

// trains (Subway-Surfers style trams)
const TRAIN_TOP = 1.5;                   // roof height you run on
const RAMP_LEN = 3.0;                    // z-length of the ramp slope
const CAR_LEN = 3.6;
const WALL_STEP = 0.6;                   // max support rise per frame before it counts as hitting a wall
const GRAVITY = 26;                      // fall accel when running off a train roof
const MOVING_TRAIN_VREL = 10;            // extra approach speed of oncoming trams

const CAM_UP = 3.2;
const CAM_BACK = 5.5;
const BASE_FOV = 68;
const FOV_BONUS = 8;
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
scene.fog = new THREE.Fog(0x431a4a, 26, 130);

// Big soft glow sitting right at the vanishing point, selling the dusk horizon.
const horizonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
}));
horizonGlow.position.set(0, 2.2, -180);
horizonGlow.scale.set(62, 62, 1);
scene.add(horizonGlow);

const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 260);
camera.position.set(0, CAM_UP, CAM_BACK);

const hemi = new THREE.HemisphereLight(0xff9de2, 0x140a1e, 0.9);
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
const coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.07, 24);
const debrisGeo = new THREE.BoxGeometry(0.22, 0.16, 0.16);

const matGround = new THREE.MeshStandardMaterial({ color: 0x171025, roughness: 0.95, metalness: 0.0 });
const matLaneLine = new THREE.MeshBasicMaterial({ color: 0x9b79c0 });
const matEdgeLine = new THREE.MeshBasicMaterial({ color: 0xc45fd8 });
const matTower = new THREE.MeshStandardMaterial({ color: 0x140a22, roughness: 1, emissive: 0x1a0e2c, emissiveIntensity: 0.3 });
const matCoin = new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.7, roughness: 0.3, metalness: 0.4 });
const matWheel = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.7 });
const matHandle = new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.35, metalness: 0.4 });
const matBody = new THREE.MeshStandardMaterial({ color: AMBER, roughness: 0.45, metalness: 0.08, flatShading: true });
const matTrim = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.4, roughness: 0.4, flatShading: true });
const matCart = new THREE.MeshStandardMaterial({ color: 0x55677a, emissive: 0x22303c, emissiveIntensity: 0.5, roughness: 0.7, flatShading: true });
const matLuggage = [
  new THREE.MeshStandardMaterial({ color: 0xef6c8e, emissive: 0xef6c8e, emissiveIntensity: 0.3, roughness: 0.6, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x5aa9e6, emissive: 0x5aa9e6, emissiveIntensity: 0.3, roughness: 0.6, flatShading: true }),
  new THREE.MeshStandardMaterial({ color: 0x74d3a3, emissive: 0x74d3a3, emissiveIntensity: 0.3, roughness: 0.6, flatShading: true }),
];
const matGatePost = new THREE.MeshStandardMaterial({ color: 0x3a3a45, roughness: 0.5, metalness: 0.3 });
const matGateBar = new THREE.MeshStandardMaterial({ color: 0xffb454, emissive: 0xff8a3c, emissiveIntensity: 1.4, roughness: 0.4 });
const matGateStripe = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.4 });
const matTanker = new THREE.MeshStandardMaterial({ color: 0xaab3c2, emissive: 0x4a5060, emissiveIntensity: 0.45, roughness: 0.35, metalness: 0.5 });
const matTankerStripe = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 1.1, roughness: 0.4 });
const matMagnetBody = new THREE.MeshStandardMaterial({ color: 0xb0b4bd, emissive: 0x9aa2b8, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0.7 });
const matMagnetTip = new THREE.MeshStandardMaterial({ color: 0xff4d6d, emissive: 0xff4d6d, emissiveIntensity: 0.6, roughness: 0.4 });
const matBoxGold = new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.5, roughness: 0.4 });
const matBoxRibbon = new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 0.7, roughness: 0.4 });
const matJetMetal = new THREE.MeshStandardMaterial({ color: 0xb0b4bd, emissive: 0x555a66, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.7 });
const matJetNozzle = new THREE.MeshStandardMaterial({ color: 0xff8a3c, emissive: 0xff8a3c, emissiveIntensity: 0.9, roughness: 0.4 });
const matSneaker = new THREE.MeshStandardMaterial({ color: 0xf5f5f7, emissive: 0x9aa0aa, emissiveIntensity: 0.25, roughness: 0.5 });
const matSole = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1.2, roughness: 0.4 });
const matBooster = new THREE.MeshStandardMaterial({ color: GOLD, emissive: 0xffd35e, emissiveIntensity: 1.2, roughness: 0.3 });
const matBoard = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 0.9, roughness: 0.4 });
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

// continuous lane guides: unlit lines read as glowing rails and fade into the
// fog with distance. Dividers mark the 3 lanes; edge rails frame the track.
for (const x of [-1.1, 1.1]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 220), matLaneLine);
  s.rotation.x = -Math.PI / 2;
  s.position.set(x, 0.012, -32);
  scene.add(s);
}
for (const x of [-3.32, 3.32]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 220), matEdgeLine);
  s.rotation.x = -Math.PI / 2;
  s.position.set(x, 0.012, -32);
  scene.add(s);
}

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
// Player: four selectable runners with radically different silhouettes.
// Each builder returns { root, update(dt, speed) }; the root gets the slide
// squash + bank, so any character works with the same action state machine.
// Width budget: no more than 2/3 of a lane (2.2 world units), i.e. keep the
// raw model within ~1.35 units across (player group is scaled by 1.08).
// ---------------------------------------------------------------------------
const matCrab = new THREE.MeshStandardMaterial({ color: 0xda7756, emissive: 0xda7756, emissiveIntensity: 0.22, roughness: 0.55, metalness: 0.05 });
const matCrabDark = new THREE.MeshStandardMaterial({ color: 0xb85c3d, emissive: 0xb85c3d, emissiveIntensity: 0.18, roughness: 0.5, metalness: 0.05 });
const matEyeWhite = new THREE.MeshStandardMaterial({ color: 0xf7f4ef, roughness: 0.35 });
const matEyeDark = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.3 });
const matBotWhite = new THREE.MeshStandardMaterial({ color: 0xe8e8ec, roughness: 0.35, metalness: 0.15 });
const matBotDark = new THREE.MeshStandardMaterial({ color: 0x23252c, roughness: 0.5, metalness: 0.3 });
const matVisor = new THREE.MeshStandardMaterial({ color: 0x0a0a0e, roughness: 0.15, metalness: 0.6 });
const matTronBody = new THREE.MeshStandardMaterial({ color: 0x0b0e14, roughness: 0.25, metalness: 0.7 });
const matTronGlow = new THREE.MeshStandardMaterial({ color: 0x67e8f9, emissive: 0x22d3ee, emissiveIntensity: 2.2, roughness: 0.3 });

function buildSuitcaseChar() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.0, 0.6), matBody);
  body.position.y = 0.58;
  root.add(body);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.15, 0.64), matTrim);
  stripe.position.y = 0.58;
  root.add(stripe);
  const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8), matHandle);
  handleBar.rotation.z = Math.PI / 2;
  handleBar.position.set(0, 1.2, -0.02);
  root.add(handleBar);
  for (const sx of [-0.16, 0.16]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.32, 6), matHandle);
    post.position.set(sx, 1.05, -0.02);
    root.add(post);
  }
  const wheels = [];
  for (const [wx, wz] of [[-0.4, 0.26], [0.4, 0.26], [-0.4, -0.26], [0.4, -0.26]]) {
    const w = new THREE.Mesh(wheelGeo, matWheel);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.12, wz);
    root.add(w);
    wheels.push(w);
  }
  return {
    root,
    update(dt, spd) {
      const spin = spd * dt * 4.2;
      for (const w of wheels) w.rotation.x += spin;
    },
  };
}

// Clawd the crab — crabs run sideways, so this one faces the camera while
// scuttling down the track: eye stalks up top, claws held out front.
function buildCrabChar() {
  const root = new THREE.Group();
  let t = rand(0, Math.PI * 2);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.46, 28, 20), matCrab);
  body.scale.set(1.15, 0.72, 0.95);
  body.position.y = 0.52;
  root.add(body);
  for (const sx of [-0.17, 0.17]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.038, 0.26, 10), matCrab);
    stalk.position.set(sx, 0.9, 0.1);
    stalk.rotation.x = 0.12;
    root.add(stalk);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), matEyeWhite);
    eye.position.set(sx, 1.04, 0.13);
    root.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), matEyeDark);
    pupil.position.set(sx, 1.05, 0.2);
    root.add(pupil);
  }
  const claws = [];
  for (const side of [-1, 1]) {
    const claw = new THREE.Group();
    claw.position.set(side * 0.32, 0.46, 0.34);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.2, 10), matCrab);
    arm.rotation.x = Math.PI / 2 - 0.3;
    arm.position.set(0, 0.02, 0.05);
    claw.add(arm);
    const pincer = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 14), matCrabDark);
    pincer.scale.set(1.05, 0.9, 1.25);
    pincer.position.set(side * 0.02, 0.02, 0.2);
    claw.add(pincer);
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), matCrabDark);
    thumb.scale.set(0.9, 0.8, 1.4);
    thumb.position.set(side * 0.02, 0.14, 0.24);
    claw.add(thumb);
    root.add(claw);
    claws.push(claw);
  }
  const legs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.42, 0.42, (i - 1) * 0.24);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.034, 0.34, 8), matCrabDark);
      seg.position.y = -0.15;
      seg.rotation.z = side * 0.55;
      leg.add(seg);
      root.add(leg);
      legs.push({ leg, phase: i * 2.1 + (side > 0 ? 1.05 : 0), side });
    }
  }
  return {
    root,
    update(dt, spd) {
      t += dt * (5 + spd * 0.45);
      for (const { leg, phase, side } of legs) {
        leg.rotation.x = Math.sin(t + phase) * 0.4;
        leg.rotation.z = side * Math.max(0, Math.sin(t + phase + 1.2)) * 0.18;
      }
      for (let i = 0; i < claws.length; i++) {
        claws[i].rotation.x = Math.sin(t * 0.5 + i * Math.PI) * 0.12 - 0.08;
      }
      root.position.y = Math.abs(Math.sin(t * 0.5)) * 0.035;
    },
  };
}

// Optimus-style humanoid — white panels over a dark under-suit, black visor.
// Articulated run: hip swing with knee flexion on the recovery leg, bent
// elbows pumping opposite the legs, forward torso lean with a counter-twist,
// and a two-beat bob (one per footfall).
function buildOptimusChar() {
  const root = new THREE.Group();
  let t = rand(0, Math.PI * 2);

  // torso group carries the upper body so the whole thing can lean and twist
  const torsoG = new THREE.Group();
  torsoG.position.y = 0.86;
  root.add(torsoG);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), matBotWhite);
  skull.scale.set(1, 1.12, 1.05);
  skull.position.y = 0.68;
  torsoG.add(skull);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 12), matVisor);
  visor.scale.set(0.92, 0.88, 0.62);
  visor.position.set(0, 0.67, -0.075);
  torsoG.add(visor);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.1, 12), matBotDark);
  neck.position.y = 0.55;
  torsoG.add(neck);
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.24), matBotWhite);
  chest.position.y = 0.35;
  torsoG.add(chest);
  const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.03), matBotDark);
  chestPlate.position.set(0, 0.29, -0.13);
  torsoG.add(chestPlate);
  const abdomen = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.2), matBotDark);
  abdomen.position.y = 0.1;
  torsoG.add(abdomen);
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.22), matBotWhite);
  pelvis.position.y = -0.06;
  torsoG.add(pelvis);

  const shoulders = [], elbows = [];
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), matBotWhite);
    pad.position.set(side * 0.29, 0.47, 0);
    torsoG.add(pad);
    const arm = new THREE.Group();
    arm.position.set(side * 0.31, 0.45, 0);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.3, 12), matBotDark);
    upper.position.y = -0.16;
    arm.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.32;
    const joint = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), matBotWhite);
    elbow.add(joint);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 12), matBotWhite);
    fore.position.y = -0.15;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), matBotDark);
    hand.position.y = -0.3;
    elbow.add(hand);
    arm.add(elbow);
    torsoG.add(arm);
    shoulders.push(arm);
    elbows.push(elbow);
  }

  const hips = [], knees = [], feet = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.12, 0.84, 0);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.34, 12), matBotWhite);
    thigh.position.y = -0.18;
    leg.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.37;
    const joint = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), matBotDark);
    knee.add(joint);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.32, 12), matBotDark);
    shin.position.y = -0.17;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.24), matBotWhite);
    foot.position.set(0, -0.35, -0.05);
    knee.add(foot);
    leg.add(knee);
    root.add(leg);
    hips.push(leg);
    knees.push(knee);
    feet.push(foot);
  }

  return {
    root,
    update(dt, spd) {
      t += dt * (5 + spd * 0.5);
      const sw = Math.sin(t);
      for (let i = 0; i < 2; i++) {
        const ph = i * Math.PI; // legs half a cycle apart
        const hipSwing = Math.sin(t + ph) * 0.7;
        hips[i].rotation.x = hipSwing;
        // knee flexes hardest mid-recovery (leg swinging back → forward)
        knees[i].rotation.x = Math.max(0, Math.sin(t + ph + 2.1)) * 1.0;
        // keep the foot roughly level with the ground through the stride
        feet[i].rotation.x = -(hips[i].rotation.x + knees[i].rotation.x) * 0.55;
        // arms pump opposite the same-side leg, elbows stay bent
        shoulders[i].rotation.x = -Math.sin(t + ph) * 0.55;
        elbows[i].rotation.x = 0.65 + Math.max(0, -Math.sin(t + ph)) * 0.25;
      }
      torsoG.rotation.x = -0.14;                 // forward racing lean
      torsoG.rotation.y = sw * 0.09;             // shoulder counter-twist
      root.position.y = Math.abs(Math.sin(t)) * 0.055; // one bob per footfall
    },
  };
}

// Tron-style program — sleek black figure covered in pulsing cyan light
// lines, identity disc on its back (the side the camera sees).
function buildTronChar() {
  const root = new THREE.Group();
  let t = rand(0, Math.PI * 2);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), matTronBody);
  helmet.scale.set(1, 1.1, 1.05);
  helmet.position.y = 1.58;
  root.add(helmet);
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.016, 8, 26), matTronGlow);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 1.58;
  root.add(halo);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.115, 0.44, 16), matTronBody);
  torso.position.y = 1.22;
  root.add(torso);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.36, 0.02), matTronGlow);
  spine.position.set(0, 1.2, 0.145);
  root.add(spine);
  const discRing = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.02, 10, 28), matTronGlow);
  discRing.position.set(0, 1.28, 0.19);
  root.add(discRing);
  const discCore = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.025, 22), matTronBody);
  discCore.rotation.x = Math.PI / 2;
  discCore.position.set(0, 1.28, 0.19);
  root.add(discCore);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.014, 8, 24), matTronGlow);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.98;
  root.add(belt);
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.09, 0.14, 14), matTronBody);
  hips.position.y = 0.9;
  root.add(hips);
  const arms = [];
  for (const side of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 10), matTronBody);
    pad.position.set(side * 0.22, 1.4, 0);
    root.add(pad);
    const padGlow = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.012, 8, 20), matTronGlow);
    padGlow.rotation.y = Math.PI / 2;
    padGlow.position.set(side * 0.235, 1.4, 0);
    root.add(padGlow);
    const arm = new THREE.Group();
    arm.position.set(side * 0.24, 1.38, 0);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.3, 12), matTronBody);
    upper.position.y = -0.17;
    arm.add(upper);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.04, 0.26, 12), matTronBody);
    fore.position.y = -0.45;
    arm.add(fore);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.2, 0.014), matTronGlow);
    strip.position.set(side * 0.042, -0.45, 0);
    arm.add(strip);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), matTronGlow);
    hand.position.y = -0.61;
    arm.add(hand);
    root.add(arm);
    arms.push(arm);
  }
  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.1, 0.86, 0);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.36, 12), matTronBody);
    thigh.position.y = -0.2;
    leg.add(thigh);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.038, 0.34, 12), matTronBody);
    shin.position.y = -0.56;
    leg.add(shin);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.5, 0.012), matTronGlow);
    strip.position.set(side * 0.055, -0.38, 0);
    leg.add(strip);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.22), matTronBody);
    foot.position.set(0, -0.76, -0.04);
    leg.add(foot);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.016, 0.02), matTronGlow);
    heel.position.set(0, -0.76, 0.07);
    leg.add(heel);
    root.add(leg);
    legs.push(leg);
  }
  return {
    root,
    update(dt, spd) {
      t += dt * (4 + spd * 0.55);
      const swing = Math.sin(t);
      arms[0].rotation.x = swing * 0.6;
      arms[1].rotation.x = -swing * 0.6;
      legs[0].rotation.x = -swing * 0.55;
      legs[1].rotation.x = swing * 0.55;
      root.position.y = Math.abs(Math.cos(t)) * 0.05;
      matTronGlow.emissiveIntensity = 1.8 + Math.sin(t * 1.7) * 0.6;
    },
  };
}

const RUNNER_KEY = 'am.runway.runner';
const CHARACTER_BUILDERS = { case: buildSuitcaseChar, crab: buildCrabChar, optimus: buildOptimusChar, tron: buildTronChar };

const player = new THREE.Group();
const characters = {};
for (const [id, build] of Object.entries(CHARACTER_BUILDERS)) {
  const ch = build();
  ch.root.visible = false;
  player.add(ch.root);
  characters[id] = ch;
}
let runnerId = localStorage.getItem(RUNNER_KEY);
if (!characters[runnerId]) runnerId = 'case';
let activeChar = characters[runnerId];
activeChar.root.visible = true;

function selectRunner(id) {
  if (!characters[id] || id === runnerId) return;
  activeChar.root.visible = false;
  activeChar.root.scale.y = 1;
  activeChar.root.rotation.x = 0;
  activeChar.root.position.y = 0;
  runnerId = id;
  activeChar = characters[id];
  activeChar.root.visible = true;
  localStorage.setItem(RUNNER_KEY, id);
}

player.scale.setScalar(1.08);

const magnetRing = new THREE.Mesh(
  new THREE.RingGeometry(1.15, 1.32, 32),
  new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
);
magnetRing.rotation.x = -Math.PI / 2;
magnetRing.position.y = 0.03;
magnetRing.visible = false;
player.add(magnetRing);

// sneaker aura (cyan ring while super sneakers are active)
const sneakerRing = new THREE.Mesh(
  new THREE.RingGeometry(0.7, 0.84, 28),
  new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
);
sneakerRing.rotation.x = -Math.PI / 2;
sneakerRing.position.y = 0.04;
sneakerRing.visible = false;
player.add(sneakerRing);

// hoverboard under the player's feet while the shield is up
const hoverboard = new THREE.Group();
const hbDeck = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.08, 1.35), matBoard);
hoverboard.add(hbDeck);
const hbGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.2, 1.7),
  new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false })
);
hbGlow.rotation.x = -Math.PI / 2;
hbGlow.position.y = -0.08;
hoverboard.add(hbGlow);
hoverboard.position.y = 0.06;
hoverboard.visible = false;
player.add(hoverboard);

// jetpack on the player's back while flying
const jetRig = new THREE.Group();
const jetFlames = [];
for (const sx of [-0.2, 0.2]) {
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.6, 12), matJetMetal);
  tank.position.set(sx, 0.75, 0.42);
  jetRig.add(tank);
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.5, 10),
    new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  flame.rotation.x = Math.PI;
  flame.position.set(sx, 0.25, 0.42);
  jetRig.add(flame);
  jetFlames.push(flame);
}
jetRig.visible = false;
player.add(jetRig);

scene.add(player);

// ---------------------------------------------------------------------------
// The guard (and his dog): chases into view after a stumble; a second slip
// while he's on your tail ends the run.
// ---------------------------------------------------------------------------
const guardGroup = new THREE.Group();
const matGuardSuit = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.6 });
const matGuardSkin = new THREE.MeshStandardMaterial({ color: 0xd9a06b, roughness: 0.6 });
const matGuardCap = new THREE.MeshStandardMaterial({ color: 0x1c2438, roughness: 0.5 });
{
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.26), matGuardSuit);
  torso.position.y = 1.05;
  guardGroup.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), matGuardSkin);
  head.position.y = 1.48;
  guardGroup.add(head);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.09, 14), matGuardCap);
  cap.position.y = 1.6;
  guardGroup.add(cap);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.16), matGuardCap);
  brim.position.set(0, 1.56, -0.14);
  guardGroup.add(brim);
}
const guardArms = [], guardLegs = [];
for (const side of [-1, 1]) {
  const arm = new THREE.Group();
  arm.position.set(side * 0.27, 1.26, 0);
  const armMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.5, 10), matGuardSuit);
  armMesh.position.y = -0.25;
  arm.add(armMesh);
  guardGroup.add(arm);
  guardArms.push(arm);
  const leg = new THREE.Group();
  leg.position.set(side * 0.12, 0.8, 0);
  const legMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.78, 10), matGuardSuit);
  legMesh.position.y = -0.39;
  leg.add(legMesh);
  guardGroup.add(leg);
  guardLegs.push(leg);
}
// the dog
const dogGroup = new THREE.Group();
{
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.44), matGuardCap);
  body.position.y = 0.32;
  dogGroup.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.2), matGuardCap);
  head.position.set(0, 0.44, -0.28);
  dogGroup.add(head);
  for (const [lx, lz] of [[-0.07, 0.16], [0.07, 0.16], [-0.07, -0.16], [0.07, -0.16]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.24, 6), matGuardCap);
    leg.position.set(lx, 0.12, lz);
    dogGroup.add(leg);
  }
  dogGroup.position.set(0.62, 0, 0.3);
}
guardGroup.add(dogGroup);
guardGroup.visible = false;
scene.add(guardGroup);
let guardZ = 7.5; // behind the camera when idle
let guardT = 0;

function updateGuard(dt) {
  const chasing = stumbleTimer > 0 && gameState === 'playing';
  const targetZ = chasing ? 2.7 : 7.5;
  guardZ += (targetZ - guardZ) * Math.min(1, dt * 3);
  guardGroup.visible = guardZ < 7;
  if (!guardGroup.visible) return;
  guardT += dt * (5 + speed * 0.4);
  const sw = Math.sin(guardT);
  guardArms[0].rotation.x = sw * 0.8;
  guardArms[1].rotation.x = -sw * 0.8;
  guardLegs[0].rotation.x = -sw * 0.9;
  guardLegs[1].rotation.x = sw * 0.9;
  dogGroup.position.y = Math.abs(Math.sin(guardT * 1.3)) * 0.12;
  guardGroup.position.set(
    guardGroup.position.x + (laneX - guardGroup.position.x) * Math.min(1, dt * 4),
    Math.abs(Math.sin(guardT)) * 0.05,
    guardZ
  );
}

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

// gate: one solid glowing bar across the whole lane with white hazard
// stripes — reads as "duck under this" from far away
function buildGate() {
  const g = new THREE.Group();
  for (const px of [-0.95, 0.95]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.35, 10), matGatePost);
    post.position.set(px, 0.68, 0);
    g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), matGateBar);
    cap.position.set(px, 1.4, 0);
    g.add(cap);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.34, 0.2), matGateBar);
  bar.position.y = 1.12;
  g.add(bar);
  for (const sx of [-0.62, 0, 0.62]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.36, 0.22), matGateStripe);
    stripe.position.set(sx, 1.12, 0);
    stripe.rotation.z = 0.5;
    g.add(stripe);
  }
  return g;
}

// tanker: sized to its own lane (total span ~2.0 across) but tall enough to
// clearly read as "can't jump this — change lanes"
function buildTanker() {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 18), matTanker);
  tank.rotation.z = Math.PI / 2;
  tank.position.y = 0.95;
  g.add(tank);
  const cap1 = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), matTanker);
  cap1.position.set(0.55, 0.95, 0);
  g.add(cap1);
  const cap2 = cap1.clone();
  cap2.position.x = -0.55;
  g.add(cap2);
  const stripeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.2, 18), matTankerStripe);
  stripeMesh.rotation.z = Math.PI / 2;
  stripeMesh.position.y = 0.95;
  g.add(stripeMesh);
  for (const lx of [-0.42, 0.42]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.9, 0.7), matWheel);
    leg.position.set(lx, 0.45, 0);
    g.add(leg);
  }
  return g;
}

const OBSTACLE_BUILDERS = { cart: buildCart, gate: buildGate, tanker: buildTanker };
const OBSTACLE_POOL_SIZE = { cart: 6, gate: 6, tanker: 4 };
// visual-only enlargement so obstacles read clearly on a phone; collision
// stays lane-based (COLLIDE_X/Z) and action-based (jump/slide), so scale is safe
const OBSTACLE_SCALE = { cart: 1.35, gate: 1.22, tanker: 1.0 };
// ground glow under each obstacle, color-coded by the verb that beats it:
// gold = jump (cart), magenta = slide (gate), red = change lanes (tanker)
const MARKER_COLOR = { cart: GOLD, gate: ACCENT, tanker: 0xff4d6d };
const obstaclePools = { cart: [], gate: [], tanker: [] };

function makeMarkerTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const markerTex = makeMarkerTexture();

for (const type of Object.keys(OBSTACLE_BUILDERS)) {
  for (let i = 0; i < OBSTACLE_POOL_SIZE[type]; i++) {
    const mesh = OBSTACLE_BUILDERS[type]();
    mesh.scale.setScalar(OBSTACLE_SCALE[type]);
    // fog:false keeps the marker readable all the way out at the spawn line
    const marker = new THREE.Mesh(
      new THREE.PlaneGeometry(1.35, 1.9),
      new THREE.MeshBasicMaterial({ map: markerTex, color: MARKER_COLOR[type], transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = 0.02;
    mesh.add(marker);
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
  // stand the cylinder up on its edge, then spin it around the world Y axis
  // like an arcade coin (YXZ order applies the spin before the upright tilt)
  mesh.rotation.order = 'YXZ';
  mesh.rotation.x = Math.PI / 2;
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
// Powerup pickups: magnet, mystery box, 2x booster, super sneakers,
// hoverboard, jetpack. One pooled holder per slot carries all six mini
// models; only the spawned type's model is shown.
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
  g.scale.setScalar(1.6);
  return g;
}

function buildMysteryBox() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), matBoxGold);
  g.add(box);
  const r1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.14), matBoxRibbon);
  g.add(r1);
  const r2 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.6), matBoxRibbon);
  g.add(r2);
  return g;
}

function buildJetpackPickup() {
  const g = new THREE.Group();
  for (const sx of [-0.16, 0.16]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.55, 12), matJetMetal);
    tank.position.set(sx, 0.05, 0);
    g.add(tank);
    const nozzle = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.18, 10), matJetNozzle);
    nozzle.rotation.x = Math.PI;
    nozzle.position.set(sx, -0.32, 0);
    g.add(nozzle);
  }
  return g;
}

function buildSneakersPickup() {
  const g = new THREE.Group();
  for (const sx of [-0.17, 0.17]) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.5), matSneaker);
    shoe.position.set(sx, 0.05, 0);
    g.add(shoe);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.52), matSole);
    sole.position.set(sx, -0.08, 0);
    g.add(sole);
  }
  return g;
}

function buildBoosterPickup() {
  const g = new THREE.Group();
  const star = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), matBooster);
  g.add(star);
  return g;
}

function buildBoardPickup() {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.95), matBoard);
  g.add(deck);
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.6), matWheel);
  core.position.y = -0.08;
  g.add(core);
  return g;
}

const PICKUP_BUILDERS = {
  magnet: buildMagnet, box: buildMysteryBox, x2: buildBoosterPickup,
  sneakers: buildSneakersPickup, board: buildBoardPickup, jetpack: buildJetpackPickup,
};
const pickups = [];
for (let i = 0; i < 4; i++) {
  const holder = new THREE.Group();
  const models = {};
  for (const [type, build] of Object.entries(PICKUP_BUILDERS)) {
    const m = build();
    m.visible = false;
    holder.add(m);
    models[type] = m;
  }
  holder.visible = false;
  scene.add(holder);
  pickups.push({ holder, models, active: false, type: 'magnet', lane: 1, z: SPAWN_Z });
}

function spawnPickup(type, lane, z = SPAWN_Z) {
  const p = pickups.find((p) => !p.active) || pickups[0];
  p.active = true;
  p.type = type;
  p.lane = lane;
  p.z = z;
  for (const [t, m] of Object.entries(p.models)) m.visible = t === type;
  p.holder.visible = true;
  p.holder.position.set(LANES[lane], 0.75, z);
  return p;
}

function deactivateAllPickups() {
  for (const p of pickups) { p.active = false; p.holder.visible = false; }
}

function pickPickupType() {
  const r = Math.random();
  if (r < 0.25) return 'magnet';
  if (r < 0.45) return 'box';
  if (r < 0.6) return 'x2';
  if (r < 0.75) return 'sneakers';
  if (r < 0.9) return 'board';
  return 'jetpack';
}

// ---------------------------------------------------------------------------
// Trains (Subway-Surfers core): long trams with a walkable roof.
//  - parked: blocks the lane; dodge it, or land on its roof from above
//  - moving: comes AT you faster than the world scrolls — headlights blazing
//  - ramp: sloped nose; run straight into it and you ride up onto the roof
// Model origin is the nose (largest z); cars extend toward -z.
// ---------------------------------------------------------------------------
const matTrainParked = new THREE.MeshStandardMaterial({ color: 0x5b84c4, emissive: 0x2c4166, emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.2 });
const matTrainMoving = new THREE.MeshStandardMaterial({ color: 0xc9564a, emissive: 0x6e2521, emissiveIntensity: 0.75, roughness: 0.5, metalness: 0.2 });
const matTrainRamp = new THREE.MeshStandardMaterial({ color: 0x38bfa6, emissive: 0x16594d, emissiveIntensity: 0.7, roughness: 0.5, metalness: 0.2 });
const matTrainRoof = new THREE.MeshStandardMaterial({ color: 0x4a5262, emissive: 0x232a36, emissiveIntensity: 0.6, roughness: 0.8 });
const matTrainDark = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.7 });
const matTrainWin = new THREE.MeshStandardMaterial({ color: 0x1a1c22, emissive: 0xffd9a0, emissiveIntensity: 1.2, roughness: 0.4 });
const matHeadlight = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
const matRampSurf = new THREE.MeshStandardMaterial({ color: 0x6b7480, emissive: 0x2c333d, emissiveIntensity: 0.5, roughness: 0.6 });
const matRampEdge = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 1.6, roughness: 0.4 });
const TRAIN_STRIP_COLOR = { parked: 0xff4d6d, moving: 0xff4d6d, ramp: 0x22d3ee };

function makeTrainCar(matBody) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.14, CAR_LEN - 0.24), matBody);
  body.position.y = 0.78;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.14, CAR_LEN - 0.34), matTrainRoof);
  roof.position.y = 1.42;
  g.add(roof);
  const win = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.3, CAR_LEN - 1.1), matTrainWin);
  win.position.y = 1.0;
  g.add(win);
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, CAR_LEN - 0.9), matTrainDark);
  skirt.position.y = 0.13;
  g.add(skirt);
  return g;
}

// trains scroll with the world, so roof-ride time = length / speed; car
// counts are chosen to give multi-second rides like the real thing
function buildTrain(type) {
  const g = new THREE.Group();
  const matBody = type === 'parked' ? matTrainParked : type === 'moving' ? matTrainMoving : matTrainRamp;
  const carCount = type === 'parked' ? 6 : type === 'ramp' ? 5 : 3;
  const rampOffset = type === 'ramp' ? RAMP_LEN : 0;
  const length = rampOffset + carCount * CAR_LEN;

  for (let k = 0; k < carCount; k++) {
    const car = makeTrainCar(matBody);
    car.position.z = -(rampOffset + k * CAR_LEN + CAR_LEN / 2);
    g.add(car);
  }

  if (type === 'ramp') {
    const slopeLen = Math.hypot(RAMP_LEN, TRAIN_TOP);
    const angle = Math.atan2(TRAIN_TOP, RAMP_LEN);
    const surf = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, slopeLen), matRampSurf);
    surf.rotation.x = angle;
    surf.position.set(0, TRAIN_TOP / 2, -RAMP_LEN / 2);
    g.add(surf);
    for (const sx of [-0.86, 0.86]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, slopeLen), matRampEdge);
      rail.rotation.x = angle;
      rail.position.set(sx, TRAIN_TOP / 2 + 0.06, -RAMP_LEN / 2);
      g.add(rail);
    }
  } else {
    // flat nose face with a light bar
    const face = new THREE.Mesh(new THREE.BoxGeometry(1.84, 1.2, 0.12), matBody);
    face.position.set(0, 0.8, -0.02);
    g.add(face);
    const lightBar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.06), type === 'moving' ? matHeadlight : matTrainWin);
    lightBar.position.set(0, 1.28, 0.03);
    g.add(lightBar);
  }

  if (type === 'moving') {
    for (const sx of [-0.5, 0.5]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), matHeadlight);
      lamp.position.set(sx, 0.62, 0.05);
      g.add(lamp);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: markerTex, color: 0xfff2cc, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    glow.position.set(0, 0.7, 0.4);
    glow.scale.set(3.4, 2.4, 1);
    g.add(glow);
  }

  // color-coded under-glow running the full length (fog-proof, like markers)
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, length + 1.2),
    new THREE.MeshBasicMaterial({ map: markerTex, color: TRAIN_STRIP_COLOR[type], transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.set(0, 0.018, -length / 2);
  g.add(strip);

  return { group: g, length };
}

const trains = [];
const TRAIN_POOL = { parked: 3, moving: 2, ramp: 2 };
for (const type of Object.keys(TRAIN_POOL)) {
  for (let i = 0; i < TRAIN_POOL[type]; i++) {
    const { group, length } = buildTrain(type);
    group.visible = false;
    scene.add(group);
    trains.push({ group, length, type, active: false, lane: 1, z: SPAWN_Z, vRel: type === 'moving' ? MOVING_TRAIN_VREL : 0 });
  }
}

function spawnTrain(type, lane, z = SPAWN_Z) {
  const tr = trains.find((t) => t.type === type && !t.active);
  if (!tr) return null;
  tr.active = true;
  tr.lane = lane;
  tr.z = z;
  tr.group.visible = true;
  tr.group.position.set(LANES[lane], 0, z);
  return tr;
}

function deactivateAllTrains() {
  for (const tr of trains) { tr.active = false; tr.group.visible = false; }
}

// Height of whatever the player could stand on at z=0 in their current x.
function computeSupport() {
  let s = 0;
  for (const tr of trains) {
    if (!tr.active) continue;
    if (Math.abs(laneX - LANES[tr.lane]) >= COLLIDE_X) continue;
    const nose = tr.z;
    const tail = tr.z - tr.length;
    if (tr.type === 'ramp') {
      if (nose >= 0 && nose <= RAMP_LEN) {
        s = Math.max(s, TRAIN_TOP * (nose / RAMP_LEN));
      } else if (nose > RAMP_LEN && tail <= 0) {
        s = Math.max(s, TRAIN_TOP);
      }
    } else if (nose >= 0 && tail <= 0) {
      s = Math.max(s, TRAIN_TOP);
    }
  }
  return s;
}

function updateTrains(dt) {
  for (const tr of trains) {
    if (!tr.active) continue;
    tr.z += (speed + tr.vRel) * dt;
    tr.group.position.z = tr.z;
    if (tr.z - tr.length > DESPAWN_Z) { tr.active = false; tr.group.visible = false; }
  }
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
let pickupCountdown = PICKUP_CADENCE * 0.6;
let waveCountdown = 2.2; // seconds until the first wave, in real time
// world-distance value after which each lane is free again (trains are long,
// so a lane with a train must not receive new spawns until it scrolls by)
const laneClearDist = [0, 0, 0];

function laneBusy(i) { return worldDist < laneClearDist[i]; }

function laneHasActiveObstacles(lane) {
  for (const type of Object.keys(obstaclePools)) {
    for (const o of obstaclePools[type]) if (o.active && o.lane === lane) return true;
  }
  return false;
}

function spawnWaveCoins(laneTypes, z) {
  for (let i = 0; i < 3; i++) {
    const type = laneTypes[i];
    const x = LANES[i];
    if (type === 'tanker') continue;
    if (type === 'cart') {
      if (Math.random() < 0.7) {
        const heights = [0.95, 1.6, 0.95];
        for (let k = 0; k < 3; k++) spawnCoinAt(x, heights[k], z + (k - 1) * 1.5);
      }
    } else if (type === 'gate') {
      if (Math.random() < 0.7) {
        for (let k = 0; k < 3; k++) spawnCoinAt(x, 0.42, z + (k - 1) * 1.3 - 2.2);
      }
    } else if (Math.random() < 0.45) {
      for (let k = 0; k < 5; k++) spawnCoinAt(x, 0.5, z - k * 1.3 + 2.5);
    }
  }
}

function spawnTrainCoins(tr) {
  const x = LANES[tr.lane];
  if (tr.type === 'ramp') {
    // coins climbing the ramp, then a run along the roof
    for (let k = 0; k < 4; k++) {
      const u = (k + 1) / 5;
      spawnCoinAt(x, TRAIN_TOP * u + 0.45, tr.z - RAMP_LEN * u);
    }
  }
  if (tr.type !== 'moving') {
    const roofStart = tr.z - (tr.type === 'ramp' ? RAMP_LEN : 0) - 1.2;
    const roofEnd = tr.z - tr.length + 1.2;
    for (let z = roofStart; z > roofEnd; z -= 2.0) {
      spawnCoinAt(x, TRAIN_TOP + 0.45, z);
    }
  }
}

// A train section: 1-2 lanes get trains (mixed types), always leaving at
// least one train-free lane so every section is survivable at ground level.
function spawnTrainSection(difficulty) {
  const lanes = [0, 1, 2].filter((i) => !laneBusy(i));
  if (lanes.length < 2) return false;
  for (let i = lanes.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
  }
  const count = Math.min(lanes.length - 1, Math.random() < 0.35 + 0.45 * difficulty ? 2 : 1);
  let spawned = 0;
  for (let k = 0; k < count; k++) {
    const lane = lanes[k];
    const r = Math.random();
    let type = r < 0.4 ? 'parked' : r < 0.75 ? 'ramp' : 'moving';
    // an oncoming tram overtakes anything ahead of it in its lane, so it
    // needs the lane visually empty; fall back to a parked one
    if (type === 'moving' && laneHasActiveObstacles(lane)) type = 'parked';
    const z = type === 'moving' ? SPAWN_Z - 24 : SPAWN_Z;
    const tr = spawnTrain(type, lane, z);
    if (!tr) continue;
    spawnTrainCoins(tr);
    let sectionLen = Math.abs(z) + tr.length;
    // SS classic: a second train behind a ramp train, with a roof gap you
    // jump across while riding high
    if (type === 'ramp' && Math.random() < 0.5) {
      const follow = spawnTrain('parked', lane, z - tr.length - 4.5);
      if (follow) {
        spawnTrainCoins(follow);
        sectionLen += follow.length + 4.5;
      }
    }
    laneClearDist[lane] = worldDist + sectionLen + 22;
    spawned++;
  }
  // ground coins in a free lane as a breadcrumb toward safety
  if (spawned > 0 && Math.random() < 0.6) {
    const freeLane = lanes[lanes.length - 1];
    for (let k = 0; k < 5; k++) spawnCoinAt(LANES[freeLane], 0.5, SPAWN_Z + 2 - k * 1.5);
  }
  return spawned > 0;
}

// Waves are generated on a real-time countdown; the minimum gap between
// waves is expressed in world units by waveGap(speed) so the physical
// reaction distance always scales with current speed (see generateWave).
function updateSpawning(dt, speed) {
  difficultyT += dt;
  const difficulty = clamp01(difficultyT / 60);

  waveCountdown -= dt;
  if (waveCountdown <= 0) {
    let trainSection = false;
    if (difficulty > 0.08 && Math.random() < 0.3 + 0.3 * difficulty) {
      trainSection = spawnTrainSection(difficulty);
    }
    if (!trainSection) {
      const lanes = generateWave(difficulty);
      const anyBusy = laneBusy(0) || laneBusy(1) || laneBusy(2);
      for (let i = 0; i < 3; i++) {
        if (!lanes[i]) continue;
        if (laneBusy(i)) { lanes[i] = null; continue; }
        // no un-passable walls in the remaining lanes while a train blocks
        // others — a tanker+train pincer would be an unavoidable death
        if (lanes[i] === 'tanker' && anyBusy) lanes[i] = 'cart';
        spawnObstacle(lanes[i], i, SPAWN_Z);
      }
      spawnWaveCoins(lanes, SPAWN_Z);
    }
    waveCountdown = (waveGap(speed) / Math.max(1, speed)) * (trainSection ? 1.7 : 1);
  }

  pickupCountdown -= dt;
  if (pickupCountdown <= 0) {
    pickupCountdown = PICKUP_CADENCE;
    const freeLanes = [0, 1, 2].filter((i) => !laneBusy(i));
    if (freeLanes.length > 0) spawnPickup(pickPickupType(), pick(freeLanes), SPAWN_Z - 4);
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
let airY = 0;              // jump/slam arc offset above the standing surface
let playerElev = 0;        // height of the surface being stood on (train roofs)
let elevVel = 0;           // vertical velocity while falling off a roof
let playerY = 0;           // derived: playerElev + airY
let slamStartY = 0;
let queuedAction = null;
let queuedAt = 0;

let playT = 0;
let speed = BASE_SPEED;
let distance = 0;        // score meters (multipliers apply)
let worldDist = 0;       // true world units traveled (spawn bookkeeping)
let miles = 0;
let milesThisRun = 0;

let magnetActive = false;
let magnetTimer = 0;
let jetpackTimer = 0;
let sneakersTimer = 0;
let multTimer = 0;
let shieldTimer = 0;
let stumbleTimer = 0;    // guard chase window after a stumble
let graceTimer = 0;      // brief invulnerability (shield break / revive / jetpack landing)
let roofLatch = false;   // for counting distinct roof rides
let jumpH = JUMP_HEIGHT;

let keys = parseInt(localStorage.getItem(KEYS_KEY) || '0', 10) || 0;
function saveKeys() { localStorage.setItem(KEYS_KEY, String(keys)); }

// per-run mission counters
let runCoins = 0, runNearMisses = 0, runJumps = 0, runSlides = 0, runRoofs = 0;

// ---------------------------------------------------------------------------
// Daily missions: 3 per day, seeded by the date; each completed mission adds
// +1 to the base score multiplier for the rest of the day (SS-style).
// ---------------------------------------------------------------------------
const MISSION_POOL = [
  { id: 'coins50', label: 'Collect 50 coins', target: 50, get: () => runCoins },
  { id: 'near10', label: '10 near-misses', target: 10, get: () => runNearMisses },
  { id: 'roof3', label: 'Ride 3 train roofs', target: 3, get: () => runRoofs },
  { id: 'jump40', label: 'Jump 40 times', target: 40, get: () => runJumps },
  { id: 'slide25', label: 'Slide 25 times', target: 25, get: () => runSlides },
  { id: 'dist800', label: 'Run 800m', target: 800, get: () => Math.floor(worldDist) },
];

function missionDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
const MISSIONS_LS_KEY = 'am.runway.missions.' + missionDateKey();
let missionsCompleted = [];
try { missionsCompleted = JSON.parse(localStorage.getItem(MISSIONS_LS_KEY) || '[]'); } catch { /* fresh */ }

const todaysMissions = (() => {
  const dk = missionDateKey();
  let seed = 0;
  for (const ch of dk) seed = ((seed * 31) + ch.charCodeAt(0)) | 0;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pool = [...MISSION_POOL];
  const chosen = [];
  for (let i = 0; i < 3; i++) chosen.push(pool.splice((rng() * pool.length) | 0, 1)[0]);
  return chosen;
})();

function totalMult() {
  return (1 + missionsCompleted.length) * (multTimer > 0 ? 2 : 1);
}

function checkMissions() {
  for (const m of todaysMissions) {
    if (missionsCompleted.includes(m.id)) continue;
    if (m.get() >= m.target) {
      missionsCompleted.push(m.id);
      localStorage.setItem(MISSIONS_LS_KEY, JSON.stringify(missionsCompleted));
      showToast(`Mission done: ${m.label} — score x${1 + missionsCompleted.length}`);
      renderMissions();
    }
  }
}

// ---------------------------------------------------------------------------
// Powerup activation
// ---------------------------------------------------------------------------
function activateMagnet() { magnetActive = true; magnetTimer = MAGNET_DURATION; showToast('Coin magnet!'); }
function activate2x() { multTimer = MULT_DURATION; showToast('2x score!'); }
function activateSneakers() { sneakersTimer = SNEAKERS_DURATION; showToast('Super sneakers!'); }
function activateShield() { shieldTimer = SHIELD_DURATION; showToast('Hoverboard!'); }

function activateJetpack() {
  jetpackTimer = JETPACK_DURATION;
  showToast('Jetpack!');
  // high coin trails to vacuum up while flying
  for (let lane = 0; lane < 3; lane++) {
    if (lane !== laneIndex && Math.random() < 0.4) continue;
    for (let k = 0; k < 26; k++) spawnCoinAt(LANES[lane], JET_HEIGHT + 0.4, -8 - k * 2.6);
  }
}

function grantMysteryReward() {
  const r = Math.random();
  if (r < 0.1) { keys++; saveKeys(); showToast('Found a key!'); }
  else if (r < 0.28) {
    miles += 15; milesThisRun += 15; runCoins += 15;
    milesEl.textContent = miles;
    showToast('+15 coins!');
  }
  else if (r < 0.46) activateMagnet();
  else if (r < 0.62) activate2x();
  else if (r < 0.78) activateSneakers();
  else if (r < 0.92) activateShield();
  else activateJetpack();
}

function applyPickup(type) {
  if (type === 'magnet') activateMagnet();
  else if (type === 'box') grantMysteryReward();
  else if (type === 'x2') activate2x();
  else if (type === 'sneakers') activateSneakers();
  else if (type === 'board') activateShield();
  else if (type === 'jetpack') activateJetpack();
}

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
const x2Pip = document.getElementById('x2-pip');
const x2TimeEl = document.getElementById('x2-time');
const sneakersPip = document.getElementById('sneakers-pip');
const sneakersTimeEl = document.getElementById('sneakers-time');
const shieldPip = document.getElementById('shield-pip');
const shieldTimeEl = document.getElementById('shield-time');
const jetPip = document.getElementById('jet-pip');
const jetTimeEl = document.getElementById('jet-time');
const multBadge = document.getElementById('mult-badge');
const toastEl = document.getElementById('toast');
const missionsEl = document.getElementById('missions');
const reviveBtn = document.getElementById('revive');
const keyCountEl = document.getElementById('key-count');

bestScoreEl.textContent = best;

function setPip(el, timeEl, t) {
  el.hidden = t <= 0;
  if (t > 0) timeEl.textContent = Math.ceil(t);
}

function updatePips() {
  magnetPip.hidden = !magnetActive;
  if (magnetActive) magnetTimeEl.textContent = Math.ceil(magnetTimer);
  setPip(x2Pip, x2TimeEl, multTimer);
  setPip(sneakersPip, sneakersTimeEl, sneakersTimer);
  setPip(shieldPip, shieldTimeEl, shieldTimer);
  setPip(jetPip, jetTimeEl, jetpackTimer);
  const m = totalMult();
  multBadge.hidden = m <= 1;
  if (m > 1) multBadge.textContent = 'x' + m;
}

let toastTimeout = null;
function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth; // restart the CSS transition
  toastEl.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toastEl.classList.remove('show'); toastEl.hidden = true; }, 1900);
}

function renderMissions() {
  const rows = todaysMissions.map((m) => {
    const done = missionsCompleted.includes(m.id);
    const cur = Math.min(m.get(), m.target);
    return `<div class="mission${done ? ' done' : ''}"><span class="mission-check">${done ? '&#10003;' : '&#9675;'}</span><span class="mission-label">${m.label}</span><em>${done ? '' : `${cur}/${m.target}`}</em></div>`;
  }).join('');
  missionsEl.innerHTML = `<p class="missions-title">Daily missions &middot; score x${1 + missionsCompleted.length}</p>${rows}`;
}
renderMissions();

function updateReviveBtn() {
  reviveBtn.hidden = keys < 1;
  keyCountEl.textContent = keys;
}

// SS keys: spend one to keep the run going after a crash
function revive() {
  if (keys < 1 || gameState !== 'over') return;
  keys--;
  saveKeys();
  clearHazardsNearPlayer(true);
  overOverlay.hidden = true;
  hud.classList.remove('dim');
  player.visible = true;
  player.rotation.set(0, 0, 0);
  actionState = 'run'; actionT = 0; airY = 0; playerElev = 0; elevVel = 0;
  stumbleTimer = 0;
  graceTimer = 2;
  gameState = 'playing';
  updateReviveBtn();
  showToast('Revived!');
}

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

function startJump() {
  actionState = 'jump'; actionT = 0;
  jumpH = sneakersTimer > 0 ? SNEAKERS_JUMP : JUMP_HEIGHT;
  runJumps++;
}
function startSlide() { actionState = 'slide'; actionT = 0; runSlides++; }
function startSlam() { actionState = 'slam'; actionT = 0; slamStartY = airY; }

function tryJump() {
  if (gameState !== 'playing' || jetpackTimer > 0) return;
  if (actionState === 'run') startJump();
  else if (actionState === 'slide') queueAction('jump');
}

function trySlide() {
  if (gameState !== 'playing' || jetpackTimer > 0) return;
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
    airY = 4 * jumpH * t * (1 - t);
    if (t >= 1) { actionState = 'run'; actionT = 0; airY = 0; consumeQueue(); }
  } else if (actionState === 'slam') {
    const t = Math.min(actionT / SLAM_DURATION, 1);
    airY = slamStartY * (1 - t);
    if (t >= 1) { airY = 0; startSlide(); }
  } else if (actionState === 'slide') {
    if (actionT >= SLIDE_DURATION) { actionState = 'run'; actionT = 0; consumeQueue(); }
  } else {
    airY = 0;
  }
}

function landFromAir() {
  airY = 0;
  if (actionState === 'slam') startSlide();
  else { actionState = 'run'; actionT = 0; consumeQueue(); }
}

// Reconcile the player's height with whatever is underneath: climb ramps,
// land on roofs (or smack into a train face), fall off the end of a train.
function updateVertical(dt) {
  if (jetpackTimer > 0) {
    // cruise above everything; trains and obstacles pass harmlessly below
    airY = 0;
    if (actionState !== 'run') { actionState = 'run'; actionT = 0; }
    playerElev += (JET_HEIGHT - playerElev) * Math.min(1, dt * 3);
    elevVel = 0;
    roofLatch = false;
    playerY = playerElev;
    return;
  }
  const s = computeSupport();
  const abs = playerElev + airY;
  if (isAirborne()) {
    if (s > playerElev + 0.01) {
      if (abs >= s - 0.45 && abs <= s + 0.1) {
        playerElev = s;
        elevVel = 0;
        landFromAir();
      } else if (abs < s - 0.45) {
        crash(); // jumped straight into the train's face
      }
    }
  } else {
    const d = s - playerElev;
    if (d > WALL_STEP) { crash(); return; } // ran into a wall (train nose/side)
    if (d >= 0) {
      playerElev = s;
      elevVel = 0;
    } else {
      elevVel -= GRAVITY * dt;
      playerElev = Math.max(s, playerElev + elevVel * dt);
      if (playerElev === s) elevVel = 0;
    }
  }
  playerY = playerElev + airY;
  // count distinct roof rides for missions
  if (playerElev >= 1.4 && !roofLatch) { roofLatch = true; runRoofs++; }
  else if (playerElev < 0.5) roofLatch = false;
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
  // tanker: normally fatal, but a super-sneakers jump sails clean over it
  return isAirborne() && airY > 1.7;
}

function nearMiss() {
  distance += 5 * totalMult(); // small bonus, folded into the score readout
  runNearMisses++;
  timeSlowTimer = 0.12;
  navigator.vibrate?.(6);
}

// Clipping the edge of an obstacle: not fatal, but the guard starts chasing.
// Slip again while he's behind you and he catches you.
function stumble() {
  if (jetpackTimer > 0 || graceTimer > 0) return;
  if (stumbleTimer > 0) { crash(); return; }
  stumbleTimer = STUMBLE_WINDOW;
  camShakeAmt = 0.25;
  navigator.vibrate?.(15);
  showToast('Stumbled — guard incoming!');
}

// After a shield save or a revive, sweep the danger out of the player's path
// so they aren't instantly re-killed by the thing they just hit.
function clearHazardsNearPlayer(allLanes = false) {
  for (const type of Object.keys(obstaclePools)) {
    for (const o of obstaclePools[type]) {
      if (!o.active) continue;
      if ((allLanes || o.lane === laneIndex) && o.z > -16) { o.active = false; o.mesh.visible = false; }
    }
  }
  for (const tr of trains) {
    if (!tr.active) continue;
    if ((allLanes || tr.lane === laneIndex) && tr.z > -20) { tr.active = false; tr.group.visible = false; }
  }
}

function collectCoin(c) {
  c.active = false;
  c.mesh.visible = false;
  miles++;
  milesThisRun++;
  runCoins++;
  milesEl.textContent = miles;
  if (milesThisRun > 0 && milesThisRun % 10 === 0) navigator.vibrate?.(10);
}

function updateCollisions(dt) {
  for (const type of Object.keys(obstaclePools)) {
    for (const o of obstaclePools[type]) {
      if (!o.active) continue;
      o.z += speed * dt;
      o.mesh.position.z = o.z;
      if (o.z > DESPAWN_Z) { o.active = false; o.mesh.visible = false; continue; }
      if (o.passed) continue;
      if (playerElev > 1.0) continue; // running on a train roof, above ground obstacles
      const dx = Math.abs(laneX - LANES[o.lane]);
      if (Math.abs(o.z) < COLLIDE_Z) {
        if (dx < COLLIDE_X) {
          o.passed = true;
          if (!resolveObstacle(o)) { crash(); return; }
        } else if (dx < COLLIDE_X + 0.28) {
          o.passed = true;
          stumble(); // clipped the corner mid-lane-change
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
        c.y += (playerY + 0.55 - c.y) * pull;
        pulled = true;
      }
    }
    if (!pulled) c.z += speed * dt;
    c.mesh.position.set(c.x, c.y, c.z);
    c.mesh.rotation.y += c.spin * dt;
    if (c.z > DESPAWN_Z) { c.active = false; c.mesh.visible = false; continue; }
    const dx = Math.abs(laneX - c.x);
    // vertical check keeps roof coins for roof runners and jump-arc coins
    // for jumpers (player "center" sits ~0.55 above their feet)
    if (Math.abs(c.z) < 0.75 && dx < 0.75 && Math.abs(playerY + 0.55 - c.y) < 1.0) collectCoin(c);
  }

  for (const p of pickups) {
    if (!p.active) continue;
    p.z += speed * dt;
    p.holder.position.z = p.z;
    p.holder.rotation.y += 3 * dt;
    if (p.z > DESPAWN_Z) { p.active = false; p.holder.visible = false; continue; }
    if (playerElev > 1.0) continue; // pickups sit at ground level
    const dx = Math.abs(laneX - LANES[p.lane]);
    if (Math.abs(p.z) < 0.65 && dx < 0.85) {
      p.active = false;
      p.holder.visible = false;
      navigator.vibrate?.(10);
      applyPickup(p.type);
    }
  }
}

// ---------------------------------------------------------------------------
// Crash / state transitions
// ---------------------------------------------------------------------------
function crash() {
  if (gameState !== 'playing') return;
  if (jetpackTimer > 0 || graceTimer > 0) return; // untouchable
  if (shieldTimer > 0) {
    // hoverboard takes the hit
    shieldTimer = 0;
    graceTimer = 1.4;
    clearHazardsNearPlayer();
    camShakeAmt = 0.35;
    navigator.vibrate?.(20);
    showToast('Hoverboard smashed!');
    return;
  }
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
  updateReviveBtn();
  overOverlay.hidden = false;
}

function resetWorld() {
  deactivateAllObstacles();
  deactivateAllCoins();
  deactivateAllTrains();
  deactivateAllPickups();
  laneClearDist[0] = laneClearDist[1] = laneClearDist[2] = 0;
  laneIndex = 1;
  laneX = 0;
  laneTargetX = 0;
  bankAngle = 0;
  actionState = 'run';
  actionT = 0;
  airY = 0;
  playerElev = 0;
  elevVel = 0;
  playerY = 0;
  camElev = 0;
  queuedAction = null;
  playT = 0;
  speed = BASE_SPEED;
  distance = 0;
  worldDist = 0;
  miles = 0;
  milesThisRun = 0;
  magnetActive = false;
  magnetTimer = 0;
  jetpackTimer = 0;
  sneakersTimer = 0;
  multTimer = 0;
  shieldTimer = 0;
  stumbleTimer = 0;
  graceTimer = 0;
  roofLatch = false;
  jumpH = JUMP_HEIGHT;
  runCoins = 0; runNearMisses = 0; runJumps = 0; runSlides = 0; runRoofs = 0;
  guardZ = 7.5;
  guardGroup.visible = false;
  timeSlowTimer = 0;
  crashT = 0;
  waveCountdown = 2.2;
  difficultyT = 0;
  pickupCountdown = PICKUP_CADENCE * 0.6;
  milesEl.textContent = '0';
  setDistanceHud(0);
  player.rotation.set(0, 0, 0);
  player.visible = true;
  for (const p of debris) { p.active = false; p.mesh.visible = false; }
}

function startGame() {
  resetWorld();
  renderMissions();
  updatePips();
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
  if (e.target.closest('#install') || e.target.closest('.install-tip') || e.target.closest('#runner-picker')) return;
  handleTapRestart();
});

// Runner picker (start overlay) — swaps the live model behind the overlay
const pickerEl = document.getElementById('runner-picker');
function syncPicker() {
  for (const b of pickerEl.querySelectorAll('.picker-btn')) {
    b.classList.toggle('selected', b.dataset.runner === runnerId);
  }
}
pickerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.picker-btn');
  if (!btn) return;
  selectRunner(btn.dataset.runner);
  syncPicker();
});
syncPicker();
overOverlay.addEventListener('pointerup', (e) => {
  if (e.target.closest('#restart') || e.target.closest('#revive')) return; // handled by their own clicks
  handleTapRestart();
});
restartBtn.addEventListener('click', handleTapRestart);
reviveBtn.addEventListener('click', (e) => { e.stopPropagation(); revive(); });

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
  const charRoot = activeChar.root;
  charRoot.scale.y += (targetScaleY - charRoot.scale.y) * Math.min(1, dt * 14);
  charRoot.rotation.x += ((actionState === 'slide' ? -0.16 : 0) - charRoot.rotation.x) * Math.min(1, dt * 14);

  activeChar.update(dt, speed);

  magnetRing.visible = magnetActive;
  if (magnetActive) {
    const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.08;
    magnetRing.scale.setScalar(pulse);
    magnetRing.material.opacity = 0.35 + 0.2 * Math.sin(performance.now() * 0.012);
  }

  sneakerRing.visible = sneakersTimer > 0;
  hoverboard.visible = shieldTimer > 0;
  jetRig.visible = jetpackTimer > 0;
  if (jetpackTimer > 0) {
    for (const f of jetFlames) f.scale.set(1, 0.7 + Math.random() * 0.5, 1);
  }
  // flicker while briefly invulnerable so the save reads clearly
  const flicker = graceTimer > 0 && (performance.now() / 90 | 0) % 2 === 0;
  activeChar.root.visible = !flicker;
}

function updateEnvironment(dt, envSpeed) {
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
  // ride up smoothly when the player is on a train roof
  camElev += (playerElev * 0.8 - camElev) * Math.min(1, dt * 3.5);

  const speedT = clamp01((speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));
  const fov = BASE_FOV + speedT * FOV_BONUS;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

  camShakeAmt = Math.max(0, camShakeAmt - dt * 3.2);
  const shx = (Math.random() - 0.5) * camShakeAmt;
  const shy = (Math.random() - 0.5) * camShakeAmt;
  camera.position.set(camX + shx, CAM_UP + shy + camElev, CAM_BACK);
  camera.lookAt(camX * 0.5, 1.5 + camElev * 0.85, -13);
}
let camX = 0;
let camElev = 0;

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
  if (pause.active) { last = now; return; }
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
    worldDist += speed * sdt;
    distance += speed * sdt * totalMult();

    updateAction(sdt);
    updateTrains(sdt);
    updateVertical(sdt);
    updateSpawning(sdt, speed);
    updateCollisions(sdt);

    // powerup / status timers
    if (magnetActive) {
      magnetTimer -= sdt;
      if (magnetTimer <= 0) { magnetActive = false; magnetTimer = 0; }
    }
    if (jetpackTimer > 0) {
      jetpackTimer -= sdt;
      if (jetpackTimer <= 0) { jetpackTimer = 0; graceTimer = Math.max(graceTimer, 1.0); }
    }
    if (sneakersTimer > 0) sneakersTimer = Math.max(0, sneakersTimer - sdt);
    if (multTimer > 0) multTimer = Math.max(0, multTimer - sdt);
    if (shieldTimer > 0) shieldTimer = Math.max(0, shieldTimer - sdt);
    if (stumbleTimer > 0) stumbleTimer = Math.max(0, stumbleTimer - sdt);
    if (graceTimer > 0) graceTimer = Math.max(0, graceTimer - sdt);

    updatePips();
    checkMissions();

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
  updateGuard(dt);
  updatePlayerVisual(dt);
  updateCamera(dt);

  renderer.render(scene, camera);
}
let lastDistanceShown = -1;

// ---------------------------------------------------------------------------
// Install button (Add to Home Screen)
// ---------------------------------------------------------------------------
installPrompt();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
resetWorld();
gameState = 'start';
hud.classList.add('dim');
const pause = installPause({
  canPause: () => gameState === 'playing',
  right: 80,                                  // left of the pip stack, which grows downward
});
requestAnimationFrame(tick);

// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => gameState !== 'playing' });

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------
window.__test = {
  getState() {
    return {
      gameState, distance: Math.floor(distance), miles, speed,
      laneIndex, laneX, playerY, actionState, magnetActive, magnetTimer, best,
      runner: runnerId, elevation: playerElev, support: computeSupport(),
      jetpackTimer, sneakersTimer, multTimer, shieldTimer, stumbleTimer, graceTimer,
      keys, mult: totalMult(), worldDist: Math.floor(worldDist),
      missions: { completed: [...missionsCompleted], counters: { runCoins, runNearMisses, runJumps, runSlides, runRoofs } },
    };
  },
  setRunner(id) { selectRunner(id); syncPicker(); },
  listRunners() { return Object.keys(characters); },
  measureRunner() {
    const box = new THREE.Box3().setFromObject(activeChar.root);
    return { width: +(box.max.x - box.min.x).toFixed(3), height: +(box.max.y - box.min.y).toFixed(3) };
  },
  start() { startGame(); },
  restart() { startGame(); },
  moveLeft() { changeLane(-1); },
  moveRight() { changeLane(1); },
  jump() { tryJump(); },
  slide() { trySlide(); },
  forceSpawn(type, lane = laneIndex, z = -1.2) { return spawnObstacle(type, lane, z); },
  forceTrain(type, lane = laneIndex, z = -10) { return spawnTrain(type, lane, z); },
  clearTrains() { deactivateAllTrains(); },
  forceMagnet(lane = laneIndex, z = -1.2) { return spawnPickup('magnet', lane, z); },
  forcePickup(type, lane = laneIndex, z = -1.2) { return spawnPickup(type, lane, z); },
  activate(type) { applyPickup(type); },
  setKeys(n) { keys = n; saveKeys(); updateReviveBtn(); },
  revive() { revive(); },
  stumbleNow() { stumble(); },
  forceCoin(lane = laneIndex, z = -1.2) { return spawnCoinAt(LANES[lane], 0.5, z); },
  clearObstacles() { deactivateAllObstacles(); },
  generateWave(difficulty) { return generateWave(difficulty); },
  waveGap(spd) { return waveGap(spd); },
  debugCoins() { return coins.filter((c) => c.active).map((c) => ({ x: c.x, y: c.y, z: c.z })); },
};
