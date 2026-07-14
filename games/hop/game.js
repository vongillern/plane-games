// Hop — a doodle-jump-style vertical bouncer.
// Airplane Mode collection. Fully offline, canvas 2D.
// The hook: the whole world's palette + atmosphere shifts continuously with
// altitude, from a moonlit meadow all the way to the edge of space.

// ---------------------------------------------------------------------------
// Constants (virtual units: physics is authored at a fixed virtual width so
// every screen plays identically; VW/VH map to CSS pixels via `scale`).
// ---------------------------------------------------------------------------
const VW = 400;                 // virtual width, units
const GRAVITY = 2200;           // u/s^2
const BOUNCE_V = -1150;         // u/s, base bounce launch velocity
const SPRING_MULT = 2.5;        // spring pad bounce multiplier
const MAX_VX = 380;             // u/s
const STEER_ACCEL = 1700;       // u/s^2 while holding a direction
const AIR_FRICTION = 1100;      // u/s^2 deceleration with no input
const PLAYER_R = 16;             // virtual units
const PLATFORM_H = 14;
const CAM_ANCHOR = 0.55;        // player stays below this fraction of screen height
const FALL_MARGIN = 60;         // units below screen bottom before game over
const DYING_MS = 260;
const STUN_MS = 520;
const FLOAT_MS = 3000;
const FLOAT_RISE = -230;        // u/s while balloon-floating
const MAX_JUMP_HEIGHT = (BOUNCE_V * BOUNCE_V) / (2 * GRAVITY); // ~300.6 u

const BEST_KEY = 'am.hop.best';
const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;

// Altitude thresholds shared by the (discrete) gameplay generator and the
// (continuous) visual crossfade so difficulty and palette stay in lockstep.
const BAND_ALT = [0, 1200, 6000, 20000, 70000];
const BAND_NAMES = ['meadow', 'sky', 'sunset', 'stratosphere', 'space'];

const GAP_RANGES = [
  [90, 125], [100, 145], [110, 160], [125, 185], [145, 215],
];
const WIDTH_RANGES = [
  [76, 96], [68, 88], [62, 80], [54, 72], [46, 64],
];
// [static, drifter, crumble, spring, cloud]
const TYPE_NAMES = ['static', 'drifter', 'crumble', 'spring', 'cloud'];
const TYPE_WEIGHTS = [
  [0.82, 0.09, 0.07, 0.02, 0.00],
  [0.64, 0.14, 0.12, 0.05, 0.05],
  [0.54, 0.17, 0.13, 0.06, 0.10],
  [0.46, 0.18, 0.14, 0.08, 0.14],
  [0.40, 0.18, 0.14, 0.10, 0.18],
];

const MILESTONES = [
  { m: 1000, label: '1,000 m' },
  { m: 10000, label: '10,000 m' },
  { m: 20000, label: 'Stratosphere' },
  { m: 100000, label: '100 km — Kármán line' },
];

// Band color anchors: vertical gradient stops per band, blended continuously.
const BAND_COLORS = [
  { top: '#03110c', mid: '#0a2620', horizon: '#123a2c' },   // meadow — deep green/teal night
  { top: '#123863', mid: '#3f83c4', horizon: '#a9d8ef' },   // sky — open blue day
  { top: '#2c1a4a', mid: '#a8456b', horizon: '#ffb45c' },   // sunset — amber/coral haze
  { top: '#04071a', mid: '#141b42', horizon: '#3a3f7a' },   // stratosphere — indigo dusk
  { top: '#000004', mid: '#02040c', horizon: '#070a18' },   // space — near black
];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const altitudeValueEl = document.getElementById('altitude-value');
const milestoneEl = document.getElementById('milestone');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const startBestEl = document.getElementById('start-best');
const finalAltEl = document.getElementById('final-alt');
const bestAltEl = document.getElementById('best-alt');
const newBestEl = document.getElementById('new-best');
const restartBtn = document.getElementById('restart');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
const wrap = (x, w) => ((x % w) + w) % w;
const TAU = Math.PI * 2;

function loadBest() {
  const n = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch (_) {}
}
function fmt(n) {
  return Math.floor(n).toLocaleString('en-US');
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const r = Math.round(lerp(A[0], B[0], t));
  const g = Math.round(lerp(A[1], B[1], t));
  const bl = Math.round(lerp(A[2], B[2], t));
  return `rgb(${r},${g},${bl})`;
}

// Continuous band index (0..4) for a given altitude, used to crossfade both
// colors and parallax-layer opacities so nothing ever hard-cuts.
function contIdx(alt) {
  if (alt <= BAND_ALT[0]) return 0;
  for (let i = 0; i < BAND_ALT.length - 1; i++) {
    if (alt <= BAND_ALT[i + 1]) {
      const t = (alt - BAND_ALT[i]) / (BAND_ALT[i + 1] - BAND_ALT[i]);
      return i + smoothstep(clamp(t, 0, 1));
    }
  }
  return BAND_ALT.length - 1;
}
function bandOpacity(ci, k) {
  return clamp(1 - Math.abs(ci - k), 0, 1);
}
// Discrete band used by the gameplay generator (difficulty ramps in steps).
function bandIndexForAlt(alt) {
  let idx = 0;
  for (let i = 0; i < BAND_ALT.length; i++) if (alt >= BAND_ALT[i]) idx = i;
  return idx;
}

// ---------------------------------------------------------------------------
// Canvas sizing (DPR-aware)
// ---------------------------------------------------------------------------
let dpr = 1, scale = 1, VH = 700, cw = 0, ch = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  cw = stage.clientWidth;
  ch = stage.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  scale = cw / VW;
  VH = ch / scale;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Particle pool (bounce dust / pop bursts) — fixed size, no per-frame alloc.
// ---------------------------------------------------------------------------
const MAX_PARTICLES = 80;
const particles = Array.from({ length: MAX_PARTICLES }, () => ({ active: false }));

function addDust(x, y, color, count) {
  let spawned = 0;
  for (let i = 0; i < particles.length && spawned < count; i++) {
    const p = particles[i];
    if (p.active) continue;
    const a = Math.random() * TAU;
    const spd = 60 + Math.random() * 90;
    p.active = true;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * spd;
    p.vy = -Math.abs(Math.sin(a) * spd) - 40;
    p.life = 0;
    p.maxLife = 0.38 + Math.random() * 0.18;
    p.color = color;
    p.size = 2.4 + Math.random() * 2.4;
    spawned++;
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.maxLife) { p.active = false; continue; }
    p.vy += GRAVITY * 0.55 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

function drawParticles() {
  for (const p of particles) {
    if (!p.active) continue;
    const t = p.life / p.maxLife;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
let player, camTop, platforms, storms, balloons, genState;
let maxAltitude, best, fired, particlesActiveCount;
let state; // 'ready' | 'playing' | 'dying' | 'dead'
let deadAt = 0;
let t = 0; // running clock (s), used for idle animation phases
let inputLeft = false, inputRight = false, touchDir = 0;
let satellite;

function makeGenState() { return { highestY: 0, lastUnsafe: false }; }

function pickType(bandIdx, lastUnsafe) {
  const base = TYPE_WEIGHTS[bandIdx];
  const w = lastUnsafe ? [base[0], base[1], 0, base[3], 0] : base;
  const total = w[0] + w[1] + w[2] + w[3] + w[4];
  let r = Math.random() * total;
  for (let i = 0; i < TYPE_NAMES.length; i++) {
    r -= w[i];
    if (r <= 0) return TYPE_NAMES[i];
  }
  return 'static';
}

// Pure generation step shared by live play AND the invariant self-check —
// single source of truth so the test can verify exactly what play uses.
function stepGenerate(gs) {
  const alt = Math.max(0, -gs.highestY);
  const bandIdx = bandIndexForAlt(alt);
  const [gMin, gMax] = GAP_RANGES[bandIdx];
  const gap = gMin + Math.random() * (gMax - gMin);
  const newY = gs.highestY - gap;
  const type = pickType(bandIdx, gs.lastUnsafe);
  const unsafe = type === 'crumble' || type === 'cloud';
  gs.lastUnsafe = unsafe;
  gs.highestY = newY;
  return { bandIdx, gap, newY, type, unsafe };
}

function makePlatform(type, x, y, w) {
  return {
    id: Math.random(),
    type, x, y, w, h: PLATFORM_H,
    phase: Math.random() * TAU,
    baseX: x,
    amp: 40 + Math.random() * 35,
    freq: 0.5 + Math.random() * 0.35,
    bounced: false,
    crumbling: false,
    crumbleAt: 0,
    visible: true,
    alive: true,
    springPop: 0,
  };
}
function makeBalloon(x, y) {
  return { id: Math.random(), x, y, baseX: x, phase: Math.random() * TAU, grabbed: false, popped: false, alive: true };
}
function makeStorm(x, y, bandIdx) {
  const dir = Math.random() < 0.5 ? -1 : 1;
  return {
    id: Math.random(), x, y, w: 58, h: 34,
    baseX: x, amp: 70 + bandIdx * 12, freq: 0.22 + bandIdx * 0.03, phase: Math.random() * TAU,
    dir, wiggle: Math.random() * TAU, alive: true,
  };
}

function generateNext() {
  const rec = stepGenerate(genState);
  const [wMin, wMax] = WIDTH_RANGES[rec.bandIdx];
  const w = wMin + Math.random() * (wMax - wMin);
  const x = Math.random() * VW;
  const plat = makePlatform(rec.type, x, rec.newY, w);
  platforms.push(plat);
  if (rec.bandIdx >= 2 && Math.random() < 0.05) {
    balloons.push(makeBalloon(wrap(x + (Math.random() < 0.5 ? -1 : 1) * (w * 0.9 + 30), VW), rec.newY - 50));
  }
  if (rec.bandIdx >= 1 && Math.random() < 0.02) {
    storms.push(makeStorm(Math.random() * VW, rec.newY - (40 + Math.random() * 60), rec.bandIdx));
  }
  return plat;
}

function ensureGenerated(targetTopY) {
  let guard = 0;
  while (genState.highestY > targetTopY && guard++ < 4000) generateNext();
}

function pruneBelow(y) {
  for (let i = platforms.length - 1; i >= 0; i--) if (platforms[i].y > y) platforms.splice(i, 1);
  for (let i = storms.length - 1; i >= 0; i--) if (storms[i].y > y) storms.splice(i, 1);
  for (let i = balloons.length - 1; i >= 0; i--) if (balloons[i].y > y) balloons.splice(i, 1);
}

// Self-check: runs the exact same generation step in isolation up to a
// target altitude and verifies the reachability invariant. Used by tests.
function checkGeneratorInvariant(targetAltitudeM) {
  const gs = makeGenState();
  const safeMaxGap = MAX_JUMP_HEIGHT * 0.85; // safety margin under max jump arc
  const violations = [];
  let prevUnsafe = false;
  let guard = 0;
  const targetY = -targetAltitudeM;
  while (gs.highestY > targetY && guard++ < 400000) {
    const rec = stepGenerate(gs);
    if (rec.unsafe && prevUnsafe) violations.push({ y: rec.newY, reason: 'two consecutive unsafe platforms', bandIdx: rec.bandIdx });
    if (rec.gap > safeMaxGap) violations.push({ y: rec.newY, reason: 'gap exceeds safe jump height', gap: rec.gap, safeMaxGap });
    prevUnsafe = rec.unsafe;
  }
  return { ok: violations.length === 0, violations: violations.slice(0, 10), steps: guard, safeMaxGap, maxJumpHeight: MAX_JUMP_HEIGHT };
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
function makePlayer() {
  return {
    x: VW / 2, y: -PLAYER_R - 2, vx: 0, vy: 0,
    facing: 1,
    squash: 0,        // current squash amount, eased
    squashPop: 0,      // one-shot hard-squash impulse on bounce, decays
    stunned: false, stunnedUntil: 0,
    floating: false, floatUntil: 0,
    wobble: Math.random() * TAU,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function reset() {
  player = makePlayer();
  camTop = -(VH * 0.82);
  platforms = [];
  storms = [];
  balloons = [];
  genState = makeGenState();
  platforms.push(makePlatform('static', VW / 2, 0, 130));
  genState.highestY = 0;
  ensureGenerated(camTop - VH * 2.2);
  maxAltitude = 0;
  fired = new Set();
  t = 0;
  inputLeft = inputRight = false; touchDir = 0;
  satellite = { x: Math.random() * VW, y: -95000, speed: 12, active: false };
  altitudeValueEl.textContent = '0';
  hideMilestone(true);
  state = 'ready';
  showStart();
}

function showStart() {
  startOverlay.hidden = false;
  overOverlay.hidden = true;
  startBestEl.textContent = fmt(best);
}
function hideStart() { startOverlay.hidden = true; }

function showGameOver() {
  const alt = Math.floor(maxAltitude);
  finalAltEl.textContent = fmt(alt) + ' m';
  const isNew = alt > best;
  if (isNew) { best = alt; saveBest(best); }
  bestAltEl.textContent = fmt(best) + ' m';
  newBestEl.hidden = !isNew;
  overOverlay.hidden = false;
  state = 'dead';
}

function startPlaying() {
  hideStart();
  state = 'playing';
}
function restart() {
  reset();
  startPlaying();
}
function die() {
  if (state !== 'playing') return;
  state = 'dying';
  deadAt = t;
  hideMilestone(true);
  navigator.vibrate?.(30);
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------
let milestoneTimer = null;
function showMilestone(label) {
  milestoneEl.textContent = label;
  milestoneEl.classList.add('show');
  if (milestoneTimer) clearTimeout(milestoneTimer);
  milestoneTimer = setTimeout(() => milestoneEl.classList.remove('show'), 2200);
}
function hideMilestone(instant) {
  milestoneEl.classList.remove('show');
  if (instant) milestoneEl.textContent = '';
  if (milestoneTimer) { clearTimeout(milestoneTimer); milestoneTimer = null; }
}
function checkMilestones() {
  for (const ms of MILESTONES) {
    if (maxAltitude >= ms.m && !fired.has(ms.m)) {
      fired.add(ms.m);
      showMilestone(ms.label);
    }
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function currentDirection() {
  if (touchDir !== 0) return touchDir;
  if (inputLeft && !inputRight) return -1;
  if (inputRight && !inputLeft) return 1;
  return 0;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) { inputLeft = true; e.preventDefault(); }
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) { inputRight = true; e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') startPlaying();
    else if (state === 'dead') restart();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (state !== 'ready') restart();
  }
});
window.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) inputLeft = false;
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) inputRight = false;
});

let ptrId = null;
function updateTouchDir(clientX) {
  const rect = canvas.getBoundingClientRect();
  const localX = clientX - rect.left;
  touchDir = localX < rect.width / 2 ? -1 : 1;
}
stage.addEventListener('pointerdown', (e) => {
  ptrId = e.pointerId;
  if (state === 'ready') { startPlaying(); updateTouchDir(e.clientX); return; }
  if (state === 'dead') { restart(); return; }
  if (state === 'playing') updateTouchDir(e.clientX);
});
stage.addEventListener('pointermove', (e) => {
  if (ptrId !== e.pointerId) return;
  if (state === 'playing') updateTouchDir(e.clientX);
});
function endPointer(e) {
  if (ptrId !== e.pointerId) return;
  ptrId = null;
  touchDir = 0;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('dblclick', (e) => e.preventDefault());
stage.addEventListener('contextmenu', (e) => e.preventDefault());

restartBtn.addEventListener('click', restart);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // pause: nothing time-based accumulates while hidden since we drive off rAF
  }
});

// ---------------------------------------------------------------------------
// Collision helpers
// ---------------------------------------------------------------------------
function platformSolidX() {
  // returns current world x for a platform, honoring drifter sine motion
  return null; // (computed inline per-platform below; kept for clarity)
}

function overlapsX(px, halfW, platX, platHalfW) {
  // check both the primary and the wrapped ghost position
  const d1 = Math.abs(px - platX);
  const d2 = Math.abs(px - (platX + VW));
  const d3 = Math.abs(px - (platX - VW));
  const d = Math.min(d1, d2, d3);
  return d <= halfW + platHalfW;
}

function currentPlatformX(p) {
  if (p.type === 'drifter') return wrap(p.baseX + Math.sin(t * p.freq + p.phase) * p.amp, VW);
  return p.baseX;
}
function cloudVisible(p) {
  const a = 0.5 + 0.5 * Math.sin(t * 1.1 + p.phase);
  return a > 0.42;
}

// ---------------------------------------------------------------------------
// Update (pure logic — used by both the rAF loop and tests via tick())
// ---------------------------------------------------------------------------
function update(dt) {
  t += dt;

  // dying: quick fall-away animation, then show the card
  if (state === 'dying') {
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;
    updateParticles(dt);
    if (t - deadAt > DYING_MS / 1000) showGameOver();
    return;
  }
  if (state !== 'playing') { updateParticles(dt); return; }

  // ---- steering ----
  const dir = currentDirection();
  if (dir !== 0) {
    player.vx += dir * STEER_ACCEL * dt;
    player.facing = dir;
  } else if (player.vx !== 0) {
    const decel = AIR_FRICTION * dt;
    player.vx = Math.abs(player.vx) <= decel ? 0 : player.vx - Math.sign(player.vx) * decel;
  }
  player.vx = clamp(player.vx, -MAX_VX, MAX_VX);
  player.x = wrap(player.x + player.vx * dt, VW);

  // ---- stun timer ----
  if (player.stunned && t >= player.stunnedUntil) player.stunned = false;

  // ---- balloon float ----
  if (player.floating) {
    player.vy = FLOAT_RISE;
    player.x = wrap(player.x + Math.sin(t * 3.2) * 26 * dt, VW);
    player.y += player.vy * dt;
    if (t >= player.floatUntil) {
      player.floating = false;
      player.vy = -200;
    }
  } else {
    // ---- gravity ----
    player.vy += GRAVITY * dt;
    player.y += player.vy * dt;

    // ---- platform collisions (only while falling, only when not stunned) ----
    if (!player.stunned && player.vy > 0) {
      const footPrev = player.y - player.vy * dt + PLAYER_R;
      const footNow = player.y + PLAYER_R;
      for (const p of platforms) {
        if (!p.alive || p.crumbling) continue;
        if (p.type === 'cloud' && !cloudVisible(p)) continue;
        const px = currentPlatformX(p);
        if (footPrev <= p.y && footNow >= p.y && overlapsX(player.x, PLAYER_R * 0.7, px, p.w / 2)) {
          landOn(p, px);
          break;
        }
      }
      // storm-top landing (allowed, satisfying, bounces normally)
      if (!player.floating) {
        for (const s of storms) {
          if (!s.alive) continue;
          const sx = wrap(s.baseX + Math.sin(t * s.freq + s.phase) * s.amp * s.dir, VW);
          const topY = s.y - s.h / 2;
          if (footPrev <= topY && footNow >= topY && overlapsX(player.x, PLAYER_R * 0.7, sx, s.w / 2)) {
            bounceAt(topY, BOUNCE_V);
            break;
          }
        }
      }
    }

    // ---- storm side/bottom hazard ----
    if (!player.stunned && !player.floating) {
      for (const s of storms) {
        if (!s.alive) continue;
        const sx = wrap(s.baseX + Math.sin(t * s.freq + s.phase) * s.amp * s.dir, VW);
        const dx = Math.min(Math.abs(player.x - sx), Math.abs(player.x - sx + VW), Math.abs(player.x - sx - VW));
        const dy = Math.abs(player.y - s.y);
        const onTop = player.vy > 0 && player.y + PLAYER_R < s.y - s.h / 2 + 6;
        if (!onTop && dx < s.w / 2 + PLAYER_R * 0.8 && dy < s.h / 2 + PLAYER_R * 0.8) {
          player.stunned = true;
          player.stunnedUntil = t + STUN_MS / 1000;
          player.vy = Math.max(player.vy, 260);
          navigator.vibrate?.(15);
        }
      }
    }

    // ---- balloon pickup ----
    if (!player.floating) {
      for (const b of balloons) {
        if (!b.alive || b.popped) continue;
        const bx = wrap(b.baseX + Math.sin(t * 0.9 + b.phase) * 14, VW);
        const dx = Math.min(Math.abs(player.x - bx), Math.abs(player.x - bx + VW), Math.abs(player.x - bx - VW));
        const dy = Math.abs(player.y - b.y);
        if (dx < PLAYER_R + 14 && dy < PLAYER_R + 20) {
          b.alive = false;
          player.floating = true;
          player.floatUntil = t + FLOAT_MS / 1000;
          player.stunned = false;
        }
      }
    }
  }

  // ---- altitude / milestones ----
  const alt = Math.max(0, -player.y);
  if (alt > maxAltitude) maxAltitude = alt;
  checkMilestones();
  const rounded = Math.floor(maxAltitude);
  if (altitudeValueEl.textContent !== String(rounded)) altitudeValueEl.textContent = fmt(rounded);

  // ---- camera: only follows upward ----
  const desired = player.y - VH * CAM_ANCHOR;
  if (desired < camTop) camTop = desired;

  // ---- crumble timers ----
  for (const p of platforms) {
    if (p.crumbling && t - p.crumbleAt > 0.35) p.alive = false;
    if (p.springPop > 0) p.springPop = Math.max(0, p.springPop - dt * 3.2);
  }

  // ---- squash easing ----
  const targetSquash = player.floating ? 0 : clamp(-player.vy / 900, -1, 1.4);
  player.squash = lerp(player.squash, targetSquash, Math.min(1, dt * 10));
  if (player.squashPop > 0) player.squashPop = Math.max(0, player.squashPop - dt * 6);

  updateParticles(dt);

  // ---- generation / pruning ----
  ensureGenerated(camTop - VH * 2.2);
  pruneBelow(camTop + VH * 1.8);

  // ---- game over check ----
  if (player.y - camTop > VH + FALL_MARGIN) die();
}

function landOn(p, px) {
  bounceAt(p.y, p.type === 'spring' ? BOUNCE_V * SPRING_MULT : BOUNCE_V);
  if (p.type === 'crumble') {
    if (!p.bounced) { p.bounced = true; p.crumbling = true; p.crumbleAt = t; }
  }
  if (p.type === 'spring') {
    p.springPop = 1;
    navigator.vibrate?.(12);
  }
  addDust(player.x, p.y, p.type === 'spring' ? '#fef08a' : '#d9f99d', p.type === 'spring' ? 14 : 9);
}

function bounceAt(y, vy) {
  player.y = y - PLAYER_R;
  player.vy = vy;
  player.squashPop = 1;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function bgColorsAt(alt) {
  const ci = contIdx(alt);
  const i = Math.min(BAND_COLORS.length - 2, Math.floor(ci));
  const f = clamp(ci - i, 0, 1);
  const a = BAND_COLORS[i], b = BAND_COLORS[i + 1];
  return {
    top: mixHex(a.top, b.top, f),
    mid: mixHex(a.mid, b.mid, f),
    horizon: mixHex(a.horizon, b.horizon, f),
    ci,
  };
}

function drawBackground(alt) {
  const { top, mid, horizon, ci } = bgColorsAt(alt);
  const g = ctx.createLinearGradient(0, 0, 0, VH);
  g.addColorStop(0, top);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, horizon);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);

  drawStars(ci);
  drawMoon(ci);
  drawFireflies(ci);
  drawClouds(ci);
  drawEarthGlow(ci);
  drawSatellite(ci);
}

// Infinite vertical tiling helper for parallax fields: elements live in a
// fixed-size seed tile and scroll at `factor` of the camera speed.
function tileY(seedY, factor, tileH) {
  const scrolled = -camTop * factor;
  return wrap(seedY + scrolled, tileH) - tileH * 0.15;
}

const STAR_FIELD = Array.from({ length: 70 }, () => ({ x: Math.random() * VW, y: Math.random() * 2400, r: 0.6 + Math.random() * 1.6, tw: Math.random() * TAU }));
function drawStars(ci) {
  const op = bandOpacity(ci, 4) * 0.9 + bandOpacity(ci, 3) * 0.25;
  if (op <= 0.01) return;
  ctx.save();
  for (const s of STAR_FIELD) {
    const y = tileY(s.y, 0.5, 2400);
    if (y < -10 || y > VH + 10) continue;
    const twinkle = 0.5 + 0.5 * Math.sin(t * 2 + s.tw);
    ctx.globalAlpha = op * (0.4 + twinkle * 0.6);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.x, y, s.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

const FIREFLY_FIELD = Array.from({ length: 22 }, () => ({ x: Math.random() * VW, y: Math.random() * 1400, r: 1.4 + Math.random() * 1.4, ph: Math.random() * TAU }));
function drawFireflies(ci) {
  const op = bandOpacity(ci, 0);
  if (op <= 0.01) return;
  ctx.save();
  for (const f of FIREFLY_FIELD) {
    const y = tileY(f.y, 0.4, 1400);
    if (y < -10 || y > VH + 10) continue;
    const glow = 0.4 + 0.6 * Math.sin(t * 1.6 + f.ph);
    const x = f.x + Math.sin(t * 0.6 + f.ph) * 8;
    ctx.globalAlpha = op * glow;
    ctx.fillStyle = '#d9f99d';
    ctx.shadowColor = '#a3e635';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, f.r, 0, TAU);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

const CLOUD_FIELD = Array.from({ length: 16 }, () => ({ x: Math.random() * VW, y: Math.random() * 3600, w: 60 + Math.random() * 90, sp: 3 + Math.random() * 10 }));
function drawClouds(ci) {
  const op = Math.max(bandOpacity(ci, 1), bandOpacity(ci, 2) * 0.7, bandOpacity(ci, 3) * 0.5);
  if (op <= 0.01) return;
  ctx.save();
  for (const c of CLOUD_FIELD) {
    const y = tileY(c.y, 0.6, 3600);
    if (y < -40 || y > VH + 40) continue;
    const x = wrap(c.x + t * c.sp, VW + c.w) - c.w / 2;
    ctx.globalAlpha = op * 0.55;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(x, y, c.w / 2, c.w * 0.18, 0, 0, TAU);
    ctx.ellipse(x - c.w * 0.28, y + 3, c.w * 0.3, c.w * 0.14, 0, 0, TAU);
    ctx.ellipse(x + c.w * 0.28, y + 3, c.w * 0.3, c.w * 0.14, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// A huge, mostly off-screen circle whose apex just grazes the bottom of the
// viewport reads as the curved limb of the earth, with a glowing atmosphere
// ring hugging it — visible from the stratosphere up.
function drawEarthGlow(ci) {
  const op = clamp((ci - 2.9) / 1.5, 0, 1);
  if (op <= 0.01) return;
  const R = 720;
  const apexY = VH * 0.9;
  const cx = VW / 2, cy = apexY + R;

  ctx.save();
  ctx.globalAlpha = op;

  const glow = ctx.createRadialGradient(cx, cy, R - 10, cx, cy, R + 110);
  glow.addColorStop(0, 'rgba(140,195,255,0)');
  glow.addColorStop(0.45, 'rgba(140,195,255,.55)');
  glow.addColorStop(0.72, 'rgba(205,230,255,.7)');
  glow.addColorStop(1, 'rgba(205,230,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 110, 0, TAU);
  ctx.fill();

  ctx.fillStyle = `rgba(3,7,16,${0.92 * op})`;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();

  ctx.restore();
}

const MOON_CRATERS = [
  { x: -6, y: -4, r: 3.2 }, { x: 5, y: 2, r: 2.2 }, { x: -1, y: 6, r: 1.8 }, { x: 8, y: -6, r: 1.6 },
];
function drawMoon(ci) {
  const op = bandOpacity(ci, 0);
  if (op <= 0.02) return;
  const mx = VW * 0.74, my = VH * 0.15, r = 24;
  ctx.save();
  ctx.globalAlpha = op;
  const halo = ctx.createRadialGradient(mx, my, r * 0.7, mx, my, r * 3.2);
  halo.addColorStop(0, 'rgba(226,232,240,.4)');
  halo.addColorStop(1, 'rgba(226,232,240,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(mx, my, r * 3.2, 0, TAU); ctx.fill();

  ctx.fillStyle = '#eef2f6';
  ctx.beginPath(); ctx.arc(mx, my, r, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(148,163,184,.35)';
  for (const c of MOON_CRATERS) {
    ctx.beginPath(); ctx.arc(mx + c.x, my + c.y, c.r, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawSatellite(ci) {
  const op = bandOpacity(ci, 4);
  if (op <= 0.3) return;
  const cycle = 26;
  const p = (t % cycle) / cycle;
  const x = p * (VW + 60) - 30;
  const y = VH * 0.22 + Math.sin(p * TAU) * 20;
  ctx.save();
  ctx.globalAlpha = op;
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(x - 5, y - 2, 10, 4);
  ctx.fillStyle = '#60a5fa';
  ctx.fillRect(x - 9, y - 4, 3, 8);
  ctx.fillRect(x + 6, y - 4, 3, 8);
  ctx.restore();
}

function drawPlatform(p) {
  if (!p.alive) return;
  const px = currentPlatformX(p);
  let alpha = 1;
  if (p.type === 'cloud') alpha = cloudVisible(p) ? 1 : 0.28;
  if (p.crumbling) alpha = clamp(1 - (t - p.crumbleAt) / 0.35, 0, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  const x0 = px - p.w / 2, y0 = p.y - p.h / 2;

  let fill = '#84cc16', top = '#bef264';
  if (p.type === 'drifter') { fill = '#38bdf8'; top = '#bae6fd'; }
  if (p.type === 'crumble') { fill = '#c2884a'; top = '#e2b183'; }
  if (p.type === 'spring') { fill = '#f59e0b'; top = '#fde68a'; }
  if (p.type === 'cloud') { fill = '#e2e8f0'; top = '#ffffff'; }

  const r = 6;
  ctx.fillStyle = fill;
  roundRect(x0, y0, p.w, p.h, r);
  ctx.fill();
  ctx.fillStyle = top;
  roundRect(x0 + 2, y0 + 2, p.w - 4, p.h * 0.42, r * 0.7);
  ctx.fill();

  if (p.type === 'crumble') {
    ctx.strokeStyle = 'rgba(60,30,10,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + p.w * 0.3, y0 + 2); ctx.lineTo(x0 + p.w * 0.38, y0 + p.h - 2);
    ctx.moveTo(x0 + p.w * 0.62, y0 + 1); ctx.lineTo(x0 + p.w * 0.55, y0 + p.h - 2);
    ctx.stroke();
  }
  if (p.type === 'spring') {
    const pop = p.springPop || 0;
    const sh = 10 + pop * 6;
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    const cx = px;
    for (let i = 0; i <= 3; i++) {
      const yy = y0 - i * (sh / 3) + pop * 2;
      ctx.moveTo(cx - 7, yy);
      ctx.lineTo(cx + 7, yy - sh / 6);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStorm(s) {
  if (!s.alive) return;
  const sx = wrap(s.baseX + Math.sin(t * s.freq + s.phase) * s.amp * s.dir, VW);
  const wiggle = Math.sin(t * 6 + s.wiggle) * 2;
  ctx.save();
  ctx.translate(sx + wiggle, s.y);
  ctx.fillStyle = 'rgba(71,85,105,.92)';
  ctx.beginPath();
  ctx.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, TAU);
  ctx.ellipse(-s.w * 0.28, 4, s.w * 0.3, s.h * 0.32, 0, 0, TAU);
  ctx.ellipse(s.w * 0.28, 4, s.w * 0.3, s.h * 0.32, 0, 0, TAU);
  ctx.fill();
  // grumpy face
  ctx.fillStyle = '#0f172a';
  ctx.beginPath(); ctx.arc(-9, -2, 3.2, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(9, -2, 3.2, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, -8); ctx.lineTo(-6, -5);
  ctx.moveTo(14, -8); ctx.lineTo(6, -5);
  ctx.moveTo(-9, 8); ctx.quadraticCurveTo(0, 3, 9, 8);
  ctx.stroke();
  ctx.restore();
}

function drawBalloon(b) {
  if (!b.alive || b.popped) return;
  const bx = wrap(b.baseX + Math.sin(t * 0.9 + b.phase) * 14, VW);
  const by = b.y + Math.sin(t * 1.4 + b.phase) * 3;
  ctx.save();
  ctx.translate(bx, by);
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, 24); ctx.stroke();
  ctx.fillStyle = '#fb7185';
  ctx.beginPath(); ctx.ellipse(0, 0, 12, 15, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.beginPath(); ctx.ellipse(-4, -5, 3.4, 5, 0.4, 0, TAU); ctx.fill();
  ctx.restore();
}

function drawPlayer() {
  const alive = state === 'playing' || state === 'ready';
  const dead = state === 'dying' || state === 'dead';
  const squash = clamp(player.squash - player.squashPop * 1.3, -1, 1.4);
  const sx = clamp(1 - squash * 0.32, 0.55, 1.5);
  const sy = clamp(1 + squash * 0.4, 0.55, 1.6);
  const wob = Math.sin(t * 3 + player.wobble) * (state === 'ready' ? 0 : 1.2);

  const draws = [player.x];
  if (player.x < PLAYER_R * 3) draws.push(player.x + VW);
  if (player.x > VW - PLAYER_R * 3) draws.push(player.x - VW);

  for (const gx of draws) {
    ctx.save();
    ctx.translate(gx, player.y);
    ctx.scale(sx, sy);
    ctx.rotate(wob * 0.02);

    ctx.fillStyle = dead ? '#ef4444' : '#a3e635';
    ctx.beginPath();
    ctx.ellipse(0, 0, PLAYER_R, PLAYER_R * 0.94, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath();
    ctx.ellipse(-PLAYER_R * 0.32, -PLAYER_R * 0.4, PLAYER_R * 0.32, PLAYER_R * 0.22, -0.4, 0, TAU);
    ctx.fill();

    const look = clamp(player.facing, -1, 1) * 2.6;
    const eyeR = PLAYER_R * 0.3, pupilR = PLAYER_R * 0.14;
    for (const s of [-1, 1]) {
      const ex = s * PLAYER_R * 0.36, ey = -PLAYER_R * 0.12;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, TAU); ctx.fill();
      ctx.fillStyle = dead ? '#7f1d1d' : '#0c1a06';
      ctx.beginPath(); ctx.arc(ex + look * 0.4, ey + pupilR * 0.2, pupilR, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  void alive;
}

function drawVignette() {
  const g = ctx.createRadialGradient(VW / 2, VH * 0.5, VH * 0.35, VW / 2, VH * 0.5, VH * 0.78);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,.32)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, VW, VH);
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  // background + parallax live in screen space (they scroll themselves via
  // camTop, so they must NOT sit inside the world -camTop translate below)
  ctx.save();
  ctx.scale(scale, scale);
  drawBackground(maxAltitude);
  ctx.restore();

  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(0, -camTop);

  for (const p of platforms) drawPlatform(p);
  for (const b of balloons) drawBalloon(b);
  for (const s of storms) drawStorm(s);
  drawParticles();
  if (state !== 'dead') drawPlayer();

  ctx.restore();

  // vignette in screen space (not world space)
  ctx.save();
  ctx.scale(scale, scale);
  drawVignette();
  ctx.restore();

  // death flash
  if (state === 'dying') {
    const p = (t - deadAt) / (DYING_MS / 1000);
    ctx.fillStyle = `rgba(239,68,68,${Math.max(0, (1 - p) * 0.18)})`;
    ctx.fillRect(0, 0, cw, ch);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastTs = null;
function frame(ts) {
  requestAnimationFrame(frame);
  if (document.hidden) { lastTs = null; return; }
  if (lastTs == null) lastTs = ts;
  let dt = (ts - lastTs) / 1000;
  lastTs = ts;
  if (dt > 0.1) dt = 0.1;

  update(dt);
  render();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
best = loadBest();
resize();
reset();
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Install prompt
// ---------------------------------------------------------------------------
(() => {
  const btn = document.getElementById('install');
  const tip = document.getElementById('install-tip');
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  if (isIOS) btn.hidden = false;
  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === 'accepted') btn.hidden = true;
      deferred = null;
    } else {
      tip.hidden = false;
    }
  });
  document.getElementById('install-tip-close').addEventListener('click', () => { tip.hidden = true; });
  tip.addEventListener('click', (e) => { if (e.target === tip) tip.hidden = true; });
  window.addEventListener('appinstalled', () => { btn.hidden = true; });
})();

// ---------------------------------------------------------------------------
// Test hook — tiny surface for headless verification (no effect on play).
// ---------------------------------------------------------------------------
window.__test = {
  VW, VH: () => VH, MAX_JUMP_HEIGHT, BAND_ALT, TOUCH,
  get state() { return state; },
  get player() { return player; },
  get camTop() { return camTop; },
  get altitude() { return maxAltitude; },
  get best() { return best; },
  get platforms() { return platforms; },
  get storms() { return storms; },
  get balloons() { return balloons; },
  start: () => startPlaying(),
  restart: () => restart(),
  tick(dtMs, times = 1) { for (let i = 0; i < times; i++) update(dtMs / 1000); },
  steer(dir) { touchDir = dir; },
  checkGeneratorInvariant,
  // place a platform of a given type directly in front of the player, within
  // easy reach, for deterministic behavior testing (crumble/spring/cloud/etc).
  placeTestPlatform(type, aheadUnits = 80, w = 80) {
    const y = player.y - aheadUnits;
    const plat = makePlatform(type, player.x, y, w);
    platforms.push(plat);
    return plat;
  },
  placeTestStorm(aheadUnits = 80) {
    const s = makeStorm(player.x, player.y - aheadUnits, 2);
    s.amp = 0; // hold still for deterministic contact tests
    storms.push(s);
    return s;
  },
  placeTestBalloon(aheadUnits = 80) {
    const b = makeBalloon(player.x, player.y - aheadUnits);
    balloons.push(b);
    return b;
  },
  // Deterministic collision setup: places `type` a short fall below the
  // player and puts the player into a slow, guaranteed-to-land fall.
  dropOnto(type, w = 80) {
    const plat = makePlatform(type, player.x, player.y + 36, w);
    platforms.push(plat);
    player.vy = 30;
    player.stunned = false;
    player.floating = false;
    return plat;
  },
  setPlayer(partial) { Object.assign(player, partial); },
  setAltitude(m) {
    player.y = -m;
    if (player.y - VH * CAM_ANCHOR < camTop) camTop = player.y - VH * CAM_ANCHOR;
    if (m > maxAltitude) maxAltitude = m;
    checkMilestones();
    ensureGenerated(camTop - VH * 2.2);
  },
};
