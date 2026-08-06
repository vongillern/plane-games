import * as THREE from './vendor/three.module.js';
import { installPause } from './pause.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';
import {
  TAU, clamp, lerp, len3,
  CELL, cityBox, cellOf, depenetrate, rayCity,
  aimVector, pickAnchor, attachWeb, coneSpread, CONE_MIN,
  stepPlayer, speedOf, MAX_LEN,
  TIME_START, timeForBeacon, nextBeacon, reachedBeacon, BEACON_R,
  assist, RUN_NAG_AFTER, formatClock,
  START_HEIGHT, START_SPEED, V_CAP,
  newPilot, autoPilot,
} from './rules.js';

// ---------------------------------------------------------------------------
// Constants / tuning
//
// World is metres, y up, street at y = 0. `heading` is atan2(vx, vz), the same
// convention rules.js uses, so a heading can be handed straight to aimVector
// without a conversion anywhere.
// ---------------------------------------------------------------------------
const DRAG_FULL = 110;           // px of horizontal drag for full aim lock
const KEY_RATE = 2.8;            // how fast a held arrow reaches full lock
const AIM_RATE = 9.0;            // how fast the aim follows the finger

// The camera is most of what sells speed — Fristrom's point about cosmetics
// doing the work that physics cannot. It pulls back and the lens widens the
// faster you go, so 40 m/s feels different from 20 rather than merely being it.
const CAM_BACK_MIN = 13;
const CAM_BACK_MAX = 25;
const CAM_UP = 7.5;
const CAM_LOOK = 16;
const CAM_FOLLOW = 4.2;
const FOV_MIN = 62;
const FOV_MAX = 86;

const CITY_R = 22;               // cells drawn each way from the player
const CITY_REBUILD = 3;          // ...rebuilt once he has moved this many
const FOG_NEAR = 90;
const FOG_FAR = 780;
const FOG_COLOR = 0x171a3a;

const TRAIL_LEN = 90;            // contrail samples

const BEST_KEY = 'am.web.best';

// The camera jolts are the one thing a vestibular-sensitive player must not
// get. Scaling them where they are read leaves every site that adds to them
// alone.
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const JOLT = REDUCED ? 0 : 1;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const elHud = document.getElementById('hud');
const elClock = document.getElementById('clock');
const elReach = document.getElementById('reachNum');
const elSpeed = document.getElementById('speedVal');
const elPointer = document.getElementById('pointer');
const elPointerDist = document.getElementById('pointerDist');
const elToasts = document.getElementById('toasts');
const startOverlay = document.getElementById('start');
const overOverlay = document.getElementById('over');
const elOverScore = document.getElementById('overScore');
const elOverBest = document.getElementById('overBest');
const elOverDist = document.getElementById('overDist');
const elOverFlag = document.getElementById('overFlag');

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
scene.background = skyTexture();

const camera = new THREE.PerspectiveCamera(FOV_MIN, 1, 0.5, 3000);

scene.add(new THREE.HemisphereLight(0x9db3ff, 0x141838, 1.75));
const sun = new THREE.DirectionalLight(0xffd7b0, 1.25);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

// A dusk gradient, generated rather than fetched — offline is sacred, so every
// pixel in this game is computed on the device.
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#0a0c22');
  grad.addColorStop(0.52, '#232a63');
  grad.addColorStop(0.78, '#4a3f7a');
  grad.addColorStop(1, '#8d5f82');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

// Lit windows. One small canvas, repeated over every façade — at dusk the
// windows are what tell you a box is a building and, more usefully, they are
// what makes speed legible when you pass one at forty metres a second.
function windowTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#0e1030';
  g.fillRect(0, 0, S, S);
  let seed = 1337;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const r = rnd();
      if (r < 0.42) continue;                       // a dark flat
      const warm = r > 0.82;
      g.fillStyle = warm ? 'rgba(255,214,150,.95)' : 'rgba(150,178,255,.72)';
      g.fillRect(x * 8 + 2, y * 8 + 2, 4, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// The city.
//
// One InstancedMesh for every building on screen, rebuilt only when the player
// has crossed a few cells. rules.js hashes the city from cell coordinates, so
// there is nothing to store and no edge: the renderer just asks for whatever
// happens to be around him now.
// ---------------------------------------------------------------------------
const CITY_N = (CITY_R * 2 + 1) * (CITY_R * 2 + 1);
// The instanced boxes carry the geometry's own UVs, so one repeat spans a
// whole façade and the window grid smears into metre-wide bands. Repeating it
// several times over is the cheap fix; matching each building's real size would
// need a per-instance attribute and a custom shader for no visible gain.
const cityTex = windowTexture();
cityTex.repeat.set(3, 7);
const wallMat = new THREE.MeshLambertMaterial({ map: cityTex, emissive: 0x2b3272, emissiveIntensity: 0.9 });
// Roofs get their own plain material. BoxGeometry ships six groups in the order
// +x, -x, +y, -y, +z, -z, so slots 2 and 3 are the top and bottom — without
// this, every rooftop in the city is tiled with lit office windows facing the
// sky, which is the first thing you notice from above and impossible to unsee.
const roofMat = new THREE.MeshLambertMaterial({ color: 0x2a3060, emissive: 0x14183c, emissiveIntensity: 0.6 });
const cityMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  [wallMat, wallMat, roofMat, roofMat, wallMat, wallMat],
  CITY_N
);
cityMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
cityMesh.frustumCulled = false;
cityMesh.receiveShadow = false;
scene.add(cityMesh);

// The street. One big plate under everything — cheaper than a plane per cell
// and, at these speeds, indistinguishable.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000),
  new THREE.MeshLambertMaterial({ color: 0x0b0d1e })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
let builtI = Infinity, builtJ = Infinity;

function buildCity(force = false) {
  const ci = cellOf(player.x), cj = cellOf(player.z);
  if (!force && Math.abs(ci - builtI) < CITY_REBUILD && Math.abs(cj - builtJ) < CITY_REBUILD) return;
  builtI = ci; builtJ = cj;

  let n = 0;
  const box = {};
  for (let i = ci - CITY_R; i <= ci + CITY_R; i++) {
    for (let j = cj - CITY_R; j <= cj + CITY_R; j++) {
      const b = cityBox(SEED, i, j, box);
      if (!b) continue;
      _p.set(b.x, b.h / 2, b.z);
      _s.set(b.w, b.h, b.d);
      _m.compose(_p, _q.identity(), _s);
      cityMesh.setMatrixAt(n, _m);
      // Taller buildings sit further back in the haze, so the skyline reads as
      // depth rather than as a wall of identical boxes.
      const tint = clamp(b.h / 200, 0, 1);
      _c.setHSL(0.66 - tint * 0.06, 0.34, 0.30 + tint * 0.14);
      cityMesh.setColorAt(n, _c);
      n++;
    }
  }
  cityMesh.count = n;
  cityMesh.instanceMatrix.needsUpdate = true;
  if (cityMesh.instanceColor) cityMesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// The hero.
//
// A jointed figure and not a sphere, and that is Fristrom's point about
// cosmetics doing work physics cannot: you feel nothing when a pendulum bob
// drops past a rooftop, and you feel it in your gut when a person does.
// ---------------------------------------------------------------------------
const hero = new THREE.Group();
const suit = new THREE.MeshLambertMaterial({ color: 0x4453ff, emissive: 0x2f3ac2, emissiveIntensity: 0.85 });
const trim = new THREE.MeshLambertMaterial({ color: 0xe8ecff, emissive: 0x6366f1, emissiveIntensity: 0.65 });

const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.95, 3, 8), suit);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), trim);
head.position.y = 0.95;
const armL = limb(suit), armR = limb(suit);
const legL = limb(suit), legR = limb(suit);
hero.add(torso, head, armL.pivot, armR.pivot, legL.pivot, legR.pivot);
armL.pivot.position.set(-0.42, 0.6, 0);
armR.pivot.position.set(0.42, 0.6, 0);
legL.pivot.position.set(-0.22, -0.6, 0);
legR.pivot.position.set(0.22, -0.6, 0);
scene.add(hero);

// A limb is a pivot with the mesh hung below it, so rotating the pivot swings
// it from the shoulder or hip instead of about its own middle.
function limb(mat) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.78, 3, 6), mat);
  mesh.position.y = -0.5;
  pivot.add(mesh);
  return { pivot, mesh };
}

// The web line: one thin cylinder, stretched between hand and anchor each
// frame. A THREE.Line would be one pixel wide on every platform that matters.
const webLine = new THREE.Mesh(
  new THREE.CylinderGeometry(0.075, 0.075, 1, 5),
  new THREE.MeshBasicMaterial({ color: 0xeef1ff, transparent: true, opacity: 0.92 })
);
webLine.geometry.translate(0, -0.5, 0);   // origin at the top, so scale.y = length
webLine.visible = false;
scene.add(webLine);

// ---------------------------------------------------------------------------
// The beacon.
// ---------------------------------------------------------------------------
const beaconGroup = new THREE.Group();
const beam = new THREE.Mesh(
  new THREE.CylinderGeometry(2.2, 5.5, 190, 12, 1, true),
  new THREE.MeshBasicMaterial({
    color: 0x8b93ff, transparent: true, opacity: 0.16,
    side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
  })
);
beam.position.y = 95;
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(BEACON_R * 0.72, 0.5, 8, 28),
  new THREE.MeshBasicMaterial({ color: 0xa5b4fc, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
);
ring.rotation.x = Math.PI / 2;
const core = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 12, 10),
  new THREE.MeshBasicMaterial({ color: 0xdfe3ff, blending: THREE.AdditiveBlending, depthWrite: false })
);
beaconGroup.add(beam, ring, core);
scene.add(beaconGroup);

// ---------------------------------------------------------------------------
// The contrail — the cheapest way to make a fast arc look fast.
// ---------------------------------------------------------------------------
const trailPos = new Float32Array(TRAIL_LEN * 3);
const trailAlpha = new Float32Array(TRAIL_LEN);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute('alpha', new THREE.BufferAttribute(trailAlpha, 1));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
  color: 0xa5b4fc, transparent: true, opacity: 0.5, depthWrite: false,
}));
trail.frustumCulled = false;
scene.add(trail);
let trailHead = 0;

function pushTrail() {
  for (let k = TRAIL_LEN - 1; k > 0; k--) {
    trailPos[k * 3] = trailPos[(k - 1) * 3];
    trailPos[k * 3 + 1] = trailPos[(k - 1) * 3 + 1];
    trailPos[k * 3 + 2] = trailPos[(k - 1) * 3 + 2];
  }
  trailPos[0] = player.x; trailPos[1] = player.y; trailPos[2] = player.z;
  trailGeo.attributes.position.needsUpdate = true;
  trailHead++;
}
function resetTrail() {
  for (let k = 0; k < TRAIL_LEN; k++) {
    trailPos[k * 3] = player.x; trailPos[k * 3 + 1] = player.y; trailPos[k * 3 + 2] = player.z;
  }
  trailGeo.attributes.position.needsUpdate = true;
  trailHead = 0;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const SEED = 20260806;

let state = 'ready';             // ready | swinging | over
const player = { x: 0, y: START_HEIGHT, z: 0, vx: 0, vy: 0, vz: START_SPEED, heading: 0, grounded: false };
const swing = { anchor: null, ropeLen: 0, gravity: 0, drag: 0, coneFloor: CONE_MIN, pump: 0 };
const beacon = { x: 0, y: 0, z: 0 };
const stepOut = {};

let held = 0;                    // seconds the web button has been down
let webHeld = false;
let aim = 0;                     // -1..1, where the cone is pointed
let aimTarget = 0;
let timeLeft = TIME_START;
let reached = 0;
let distance = 0;                // metres swung, for the results card
let groundedFor = 0;
let nagged = false;
let attractT = 0;
let camShake = 0;
let best = Number(store.get(BEST_KEY)) || 0;

let autopilot = false;
const pilot = newPilot();

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------
function beginRun() {
  // Start on a rooftop, already moving. A swinging game that opens with the
  // player standing still has to teach the verb before anything is fun; opening
  // mid-arc means the first thing that happens is the thing the game is about.
  const b = cityBox(SEED, 0, 0, {}) || { x: 0, z: 0, h: 60 };
  player.x = b.x; player.z = b.z; player.y = b.h + START_HEIGHT;
  player.vx = 0; player.vy = -6; player.vz = START_SPEED;
  player.heading = 0; player.grounded = false;
  depenetrate(SEED, player);

  releaseWeb();
  pilot.anchor = null; pilot.ropeLen = 0; pilot.held = 0; pilot.descended = false;

  timeLeft = TIME_START;
  reached = 0;
  distance = 0;
  groundedFor = 0;
  nagged = false;
  aim = aimTarget = 0;
  camShake = 0;
  held = 0;

  nextBeacon(SEED, 0, player.x, player.z, player.heading, beacon);
  buildCity(true);
  resetTrail();
  updateCamera(0.016, true);

  state = 'swinging';
  startOverlay.classList.add('hidden');
  overOverlay.classList.add('hidden');
  elHud.hidden = false;
  updateHUD();
}

function endRun() {
  state = 'over';
  releaseWeb();
  elHud.hidden = true;

  const isBest = reached > best;
  if (isBest) { best = reached; store.set(BEST_KEY, String(best)); }
  elOverScore.textContent = String(reached);
  elOverScore.classList.toggle('win', isBest && reached > 0);
  elOverBest.textContent = String(best);
  elOverDist.textContent = (distance / 1000).toFixed(2);
  elOverFlag.hidden = !(isBest && reached > 0);
  overOverlay.classList.remove('hidden');
}

// The primary verb gets the whole screen: a tap anywhere on either overlay
// starts or restarts, not just the words that say so.
function beginOrRestart() {
  if (state === 'swinging') return false;
  beginRun();
  return true;
}

// ---------------------------------------------------------------------------
// The web
// ---------------------------------------------------------------------------
const _aimVec = {};

function tryWeb(dt) {
  held += dt;
  const a = assist(reached);
  const anchor = pickAnchor(SEED, player, aimVector(player.heading, aim, undefined, _aimVec), held, {
    coneFloor: a.coneFloor,
  });
  if (!anchor) return;
  swing.anchor = anchor;
  swing.ropeLen = attachWeb(player, anchor);
  held = 0;
  webLine.visible = true;
  navigator.vibrate?.(8);
}

function releaseWeb() {
  swing.anchor = null;
  swing.ropeLen = 0;
  held = 0;
  webLine.visible = false;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function simulate(dt) {
  if (state !== 'swinging') { attractT += dt; return; }

  // The aim eases toward the finger rather than snapping to it, so a shaky
  // thumb does not shake the cone.
  aim = lerp(aim, aimTarget, 1 - Math.exp(-AIM_RATE * dt));

  if (autopilot) {
    // Steer at the beacon. Without this the autopilot swings beautifully and
    // wanders, which reads as "the physics work" while proving nothing about
    // the game — a headless run reached zero beacons in thirty seconds.
    let off = Math.atan2(beacon.x - player.x, beacon.z - player.z) - player.heading;
    while (off > Math.PI) off -= TAU;
    while (off < -Math.PI) off += TAU;
    pilot.lateral = clamp(off / 0.9, -1, 1);
    aim = aimTarget = pilot.lateral;
    autoPilot(SEED, pilot, player, stepOut.dropWeb, dt, { coneFloor: assist(reached).coneFloor });
    swing.anchor = pilot.anchor;
    swing.ropeLen = pilot.ropeLen;
    webLine.visible = !!pilot.anchor;
  } else {
    if (webHeld && !swing.anchor) tryWeb(dt);
    else if (!webHeld && swing.anchor) releaseWeb();
  }

  const a = assist(reached);
  swing.gravity = a.gravity;
  swing.drag = a.drag;
  swing.pump = a.pump;
  swing.steer = aim;

  const px = player.x, py = player.y, pz = player.z;
  stepPlayer(SEED, player, swing, dt, stepOut);
  if (autopilot) pilot.ropeLen = swing.ropeLen;
  distance += len3(player.x - px, player.y - py, player.z - pz);

  if (stepOut.dropWeb && !autopilot) releaseWeb();
  if (stepOut.wall && JOLT) camShake = Math.min(1, camShake + 0.35);

  // The Running Man. Fristrom's testers stopped swinging and jogged to the
  // objective; Spider-Man 2 detected it and had Bruce Campbell mock them until
  // they went back up. We have no audio, so it is a toast — but the point is
  // the same, and it is the difference between a player who has decided not to
  // play the game and a player nobody told.
  if (player.grounded) {
    groundedFor += dt;
    if (groundedFor > RUN_NAG_AFTER && !nagged) {
      nagged = true;
      toast('you are <span class="hot">Spider</span>, not a pedestrian', 'minor');
    }
  } else {
    groundedFor = 0;
    nagged = false;
  }

  if (reachedBeacon(player, beacon)) {
    reached++;
    const bonus = timeForBeacon(reached);
    timeLeft += bonus;
    nextBeacon(SEED, reached, player.x, player.z, player.heading, beacon);
    toast(`+${bonus.toFixed(0)}s`);
    navigator.vibrate?.(16);
  }

  timeLeft -= dt;
  if (timeLeft <= 0) { timeLeft = 0; endRun(); return; }

  camShake = Math.max(0, camShake - dt * 2.4);
  buildCity();
  pushTrail();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const camPos = new THREE.Vector3();
const camAim = new THREE.Vector3();

function updateCamera(dt, snap = false) {
  if (state === 'ready') {
    // Attract mode: a slow arc around the skyline, so the city is on show
    // before the first input.
    const r = 240;
    const a = attractT * 0.14;
    camera.position.set(Math.sin(a) * r, 150 + Math.sin(a * 0.7) * 30, Math.cos(a) * r);
    camera.lookAt(0, 70, 0);
    camera.fov = FOV_MIN;
    camera.updateProjectionMatrix();
    return;
  }

  const v = speedOf(player);
  const t = clamp(v / V_CAP, 0, 1);
  const back = lerp(CAM_BACK_MIN, CAM_BACK_MAX, t);

  // Sit behind the direction of travel, not behind the facing: in a swing they
  // differ constantly, and chasing the facing makes the camera wag.
  const hl = Math.hypot(player.vx, player.vz) || 1;
  const bx = player.x - (player.vx / hl) * back;
  const bz = player.z - (player.vz / hl) * back;
  const by = player.y + CAM_UP + clamp(-player.vy * 0.12, -3, 6);

  camAim.set(bx, by, bz);
  if (snap) camPos.copy(camAim);
  else camPos.lerp(camAim, 1 - Math.exp(-CAM_FOLLOW * dt));

  // Pull in past anything solid between the player and the camera. Swinging
  // down a street puts a tower behind you constantly, and a chase camera that
  // ignores it spends half the run inside a wall watching the back of a
  // building while the player it is meant to be following is on the far side.
  const dx = camPos.x - player.x, dy = camPos.y - player.y, dz = camPos.z - player.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > 1e-3) {
    const blocked = rayCity(SEED, player.x, player.y, player.z, dx / d, dy / d, dz / d, d, _camHit);
    if (blocked) {
      const keep = Math.max(2.5, _camHit.t - 1.2);
      camPos.set(player.x + (dx / d) * keep, player.y + (dy / d) * keep, player.z + (dz / d) * keep);
    }
  }
  // Never let the camera end up under the pavement either.
  camPos.y = Math.max(camPos.y, 2.5);
  camera.position.copy(camPos);
  if (camShake > 0) {
    const k = camShake * camShake * 0.7;
    camera.position.x += (Math.sin(attractT * 91) * k);
    camera.position.y += (Math.sin(attractT * 77) * k);
  }
  camera.lookAt(
    player.x + (player.vx / hl) * CAM_LOOK * 0.35,
    player.y + 1.5,
    player.z + (player.vz / hl) * CAM_LOOK * 0.35
  );

  const fov = lerp(FOV_MIN, FOV_MAX, t * t);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------
const _hand = new THREE.Vector3();
const _to = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ndc = new THREE.Vector3();
const _camHit = {};

function draw() {
  hero.position.set(player.x, player.y, player.z);

  // Face along travel, and roll into the swing. The lean is cosmetic and it is
  // most of what makes an arc read as an arc.
  const hl = Math.hypot(player.vx, player.vz) || 1;
  hero.rotation.set(0, Math.atan2(player.vx, player.vz), 0);
  const pitch = clamp(-player.vy / 60, -0.7, 0.7);
  hero.rotateX(pitch);

  const reaching = !!swing.anchor;
  if (reaching) {
    _hand.set(player.x, player.y + 0.8, player.z);
    _to.set(swing.anchor.x - _hand.x, swing.anchor.y - _hand.y, swing.anchor.z - _hand.z);
    const L = _to.length() || 1;
    webLine.position.copy(swing.anchor);
    webLine.scale.set(1, L, 1);
    // The geometry was shifted to hang below its origin, so local +Y has to
    // point from the hand *up to* the anchor: the cylinder then grows downward
    // from the anchor and lands on the hand. Negating this instead draws the
    // line out of the anchor's far side, which looks like a web fired at
    // nothing and is very hard to spot as a sign error.
    webLine.quaternion.setFromUnitVectors(_up, _to.multiplyScalar(1 / L));
  }

  // Arms up and together when a line is out, spread when he is falling free.
  const armSwing = reaching ? -2.5 : -0.5 + Math.sin(attractT * 6) * 0.25;
  armL.pivot.rotation.x = armSwing;
  armR.pivot.rotation.x = armSwing;
  armL.pivot.rotation.z = reaching ? 0.35 : 1.1;
  armR.pivot.rotation.z = reaching ? -0.35 : -1.1;
  const legTuck = player.grounded ? Math.sin(attractT * 14) * 0.8 : (reaching ? 0.5 : -0.2);
  legL.pivot.rotation.x = legTuck;
  legR.pivot.rotation.x = -legTuck * 0.6;

  beaconGroup.position.set(beacon.x, beacon.y, beacon.z);
  ring.rotation.z = attractT * 1.6;
  const pulse = 1 + Math.sin(attractT * 4) * 0.12;
  core.scale.setScalar(pulse);

  hero.visible = state !== 'ready';
  trail.visible = state === 'swinging' && trailHead > 3;
  beaconGroup.visible = state === 'swinging';

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHUD() {
  elClock.textContent = formatClock(timeLeft);
  elClock.classList.toggle('low', timeLeft < 10);
  elClock.setAttribute('aria-live', timeLeft < 10 ? 'polite' : 'off');
  elReach.textContent = String(reached);
  elSpeed.textContent = String(Math.round(speedOf(player) * 3.6));

  // The beacon can be behind a tower, and a clock counting down toward a target
  // the player cannot find is not a challenge — it is a countdown for no
  // reason. The arrow only appears when the beacon is off screen.
  if (state !== 'swinging') { elPointer.classList.remove('on'); return; }
  _ndc.set(beacon.x, beacon.y, beacon.z).project(camera);
  const behind = _ndc.z > 1;
  let bx = _ndc.x, by = _ndc.y;
  if (behind) { bx = -bx; by = -by; }
  const onScreen = !behind && Math.abs(bx) < 0.88 && Math.abs(by) < 0.88;
  if (onScreen) {
    elPointer.classList.remove('on');
  } else {
    elPointer.classList.add('on');
    elPointer.style.setProperty('--a', `${Math.atan2(bx, by)}rad`);
    elPointerDist.textContent = `${Math.round(len3(beacon.x - player.x, beacon.y - player.y, beacon.z - player.z))}m`;
  }
}

function toast(html, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`.trim();
  el.innerHTML = html;
  elToasts.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

// ---------------------------------------------------------------------------
// Input
//
// One verb: hold anywhere to cast a web, drag from where you touched down to
// aim it, let go to fly. The offset-from-touchdown idiom is the same position
// control Wake steers with — a held finger holds a line, and a correction is
// 1:1 rather than a rate.
// ---------------------------------------------------------------------------
let webPointer = null;
let aimOrigin = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (beginOrRestart()) return;
  if (webPointer !== null) return;
  webPointer = e.pointerId;
  aimOrigin = e.clientX;
  aimTarget = 0;
  webHeld = true;
  held = 0;
  canvas.setPointerCapture?.(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== webPointer) return;
  aimTarget = clamp((e.clientX - aimOrigin) / DRAG_FULL, -1, 1);
});

function endPointer(e) {
  if (e.pointerId !== webPointer) return;
  webPointer = null;
  webHeld = false;
  aimTarget = 0;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// The overlays cover the canvas, so "tap anywhere to swing" has to be caught on
// them too — otherwise the only thing that starts the game is the one word that
// says so.
for (const el of [startOverlay, overOverlay]) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#install, .install-btn')) return;
    beginOrRestart();
  });
}

let keyAim = 0;
addEventListener('keydown', (e) => {
  if (e.repeat) {
    if (e.code === 'Space') e.preventDefault();
    return;
  }
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (beginOrRestart()) return;
      webHeld = true; held = 0;
      break;
    case 'ArrowLeft': case 'KeyA': keyAim = -1; break;
    case 'ArrowRight': case 'KeyD': keyAim = 1; break;
    case 'KeyR': if (state !== 'ready') beginRun(); break;
    default: break;
  }
});

addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'Space': webHeld = false; break;
    case 'ArrowLeft': case 'KeyA': if (keyAim < 0) keyAim = 0; break;
    case 'ArrowRight': case 'KeyD': if (keyAim > 0) keyAim = 0; break;
    default: break;
  }
});

// A blur mid-swing must not leave the web welded on — the key never comes back
// up, so nothing else would ever clear it.
addEventListener('blur', () => { webHeld = false; keyAim = 0; aimTarget = 0; webPointer = null; });

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let hidden = document.hidden;
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

  // A held key has no travel, so it ramps rather than snapping to full lock.
  if (keyAim !== 0) aimTarget = clamp(aimTarget + keyAim * KEY_RATE * dt, -1, 1);
  else if (webPointer === null) aimTarget = lerp(aimTarget, 0, 1 - Math.exp(-KEY_RATE * dt));

  simulate(dt);
  updateCamera(dt);
  updateHUD();
  draw();
}

// ---------------------------------------------------------------------------
// Test hook
//
// A run is thirty seconds of real time and the interesting parts are a web
// catching and a beacon being reached, neither of which a headless test should
// have to wait for. This freezes the rAF loop so a test can step the simulation
// at a fixed dt — on autopilot, a whole run takes well under a second.
// ---------------------------------------------------------------------------
window.__test = {
  player, swing, beacon,
  rules: { TIME_START, BEACON_R, MAX_LEN, CELL },
  get state() { return state; },
  get reached() { return reached; },
  get timeLeft() { return timeLeft; },
  get attached() { return !!swing.anchor; },
  get anchor() { return swing.anchor; },
  start: () => beginRun(),
  freeze: (on = true) => { frozen = on; },
  autopilot: (on = true) => { autopilot = on; },
  hold: (on = true) => { webHeld = on; if (on) held = 0; },
  setAim: (v) => { aim = aimTarget = clamp(v, -1, 1); },
  // The camera advances with the simulation, not with the screenshot. It eases
  // toward its target, so stepping two hundred frames and then moving it once
  // leaves it hundreds of metres behind the player — a headless run would be
  // framed nothing like the real game, which makes every visual check a lie.
  step(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) { simulate(dt); updateCamera(dt); } },
  paint() { updateHUD(); draw(); },
  // Drop him somewhere specific — a rooftop, a street, next to the beacon —
  // without swinging there.
  teleport(x, y, z, vz = START_SPEED) {
    player.x = x; player.y = y; player.z = z;
    player.vx = 0; player.vy = 0; player.vz = vz;
    player.heading = 0; player.grounded = false;
    depenetrate(SEED, player);
    releaseWeb();
    buildCity(true);
    resetTrail();
    updateCamera(0.016, true);
  },
  coneSpread,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
buildCity(true);
nextBeacon(SEED, 0, 0, 0, 0, beacon);
resetTrail();
updateCamera(0.016, true);

const pause = installPause({ canPause: () => state === 'swinging' });
requestAnimationFrame(tick);

// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'swinging' });
installPrompt();
