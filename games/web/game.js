import { installPause } from './pause.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';
import {
  clamp,
  MAX_ROPE, V_MAX, IDEAL_ANG,
  speed, integrate, applyRope, settleRope, swingAssist, releaseBoost,
  pickAnchor, makeRng, createCity, hits, START,
} from './rules.js';

// Web — swing a city on a held thread.
// Airplane Mode collection. Fully offline, canvas 2D.
//
// Everything that decides a run lives in rules.js and is checked by
// tools/web-rules.mjs. This file owns the look, the camera and the one verb.

// ---------- DOM ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const scoreEl = document.getElementById('score');
const scoreNumEl = document.getElementById('score-num');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const finalScoreEl = document.getElementById('final-score');
const bestScoreEl = document.getElementById('best-score');
const newBestEl = document.getElementById('new-best');

const BEST_KEY = 'am.web.best';
const ACCENT = '#4f7cff';

const rand = (a, b) => a + Math.random() * (b - a);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function loadBest() {
  const v = parseInt(localStorage.getItem(BEST_KEY) || '0', 10);
  return Number.isFinite(v) ? v : 0;
}
function saveBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch (e) {}
}
function vibrate(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
}

// Deterministic sparkle for windows and far-city detail: the same building
// always lights the same rooms, so nothing flickers as the camera moves.
function hash2(a, b) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------- View ----------
let W = 0, H = 0, dpr = 1, SC = 10;      // SC = pixels per metre
let viewW = 40, viewH = 88;

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // A web reaches 26 m and the anchors stand up to 80 m over the street, so the
  // view has to hold roughly a full swing in both directions or the player is
  // aiming at something off-screen. In landscape the height clamp takes over
  // and the world simply gets wider.
  SC = clamp(Math.min(H / 78, W / 35), 7, 16);
  viewW = W / SC;
  viewH = H / SC;

  buildFarCity();
}

// world -> screen
const X = (wx) => (wx - cam.x) * SC + W / 2 + shakeX;
const Y = (wy) => H / 2 - (wy - cam.y) * SC + shakeY;

// ---------- Parallax city ----------
// Two distant layers, in screen pixels rather than world metres: they are
// scenery, never touched by physics, and keeping them out of world space means
// their density does not change when the zoom does.
const FAR_FIELD = 2400;                  // px of layer before it repeats
let farLayers = [];

function buildFarCity() {
  const rng = makeRng(0x5eed);
  farLayers = [0.18, 0.42].map((k, li) => {
    const items = [];
    let x = 0;
    while (x < FAR_FIELD) {
      const w = (18 + rng() * 46) * (0.7 + k);
      const h = H * (0.05 + rng() * (li ? 0.20 : 0.13)) * (0.6 + k);
      items.push({ x, w, h, lit: rng() });
      x += w + (4 + rng() * 16) * (0.7 + k);
    }
    return { k, items, field: x };
  });
}

let stars = [];
function buildStars() {
  stars = [];
  const n = clamp(Math.round((W * H) / 6200), 40, 150);
  const rng = makeRng(0xa11ce);
  for (let i = 0; i < n; i++) {
    const bright = rng() > 0.9;
    stars.push({
      x: rng() * W,
      y: rng() * H * 0.78,
      r: bright ? 1.3 + rng() * 1.2 : 0.4 + rng() * 1.0,
      a: bright ? 0.75 + rng() * 0.25 : 0.16 + rng() * 0.5,
    });
  }

  // Soft haze banks, low in the sky. The city only fills the bottom third of a
  // portrait screen — the sky above it is most of the frame, and empty sky at
  // this scale reads as an unfinished background rather than as height.
  clouds = [];
  for (let i = 0; i < 7; i++) {
    clouds.push({
      x: rng() * W * 2.4,
      y: H * (0.30 + rng() * 0.42),
      rx: W * (0.30 + rng() * 0.5),
      ry: H * (0.03 + rng() * 0.05),
      a: 0.035 + rng() * 0.055,
    });
  }
  cloudField = W * 2.4;
}
let clouds = [], cloudField = 1;

// ---------- Game state ----------
const S_START = 'start', S_PLAY = 'playing', S_DYING = 'dying', S_OVER = 'over';
let state = S_START;

let city = null;
let p = { ...START };
let anchor = null, rope = 0;
let held = false;
let score = 0, best = loadBest();
let cam = { x: 0, y: 0 };
let shakeX = 0, shakeY = 0, shakeAmp = 0;
let flash = 0, dyingT = 0, spin = 0, tumble = 0;
let reachT = 0;                          // how long a web has been reaching for nothing
let missNoted = false;
let trail = [];
let ghosts = [];                         // released web lines, fading
let perfectGlow = 0;
let idleT = 0;

function resetPlay() {
  city = createCity(makeRng((Math.random() * 0xffffffff) >>> 0));
  p = { ...START };
  anchor = null;
  rope = 0;
  score = 0;
  trail = [];
  ghosts = [];
  dyingT = 0;
  spin = 0;
  tumble = 0;
  reachT = 0;
  missNoted = false;
  perfectGlow = 0;
  milestone = 0;
  city.ensure(p.x + viewW + 80);
  cam.x = p.x + viewW * 0.14;
  cam.y = Math.max(p.y, viewH * 0.5 - 9);
  scoreNumEl.textContent = '0';
}

function startGame() {
  resetPlay();
  state = S_PLAY;
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  scoreEl.classList.add('show');
  vibrate(10);
}

function die() {
  if (state !== S_PLAY) return;
  state = S_DYING;
  dyingT = 0;
  flash = 0.85;
  shakeAmp = reduceMotion.matches ? 0 : 9;
  spin = (p.vx >= 0 ? 1 : -1) * rand(6, 10);
  anchor = null;
  held = false;
  vibrate(30);
}

function gameOver() {
  state = S_OVER;
  if (score > best) {
    best = score;
    saveBest(best);
    newBestEl.hidden = false;
  } else {
    newBestEl.hidden = true;
  }
  finalScoreEl.textContent = String(score);
  bestScoreEl.textContent = String(best);
  scoreEl.classList.remove('show');
  overOverlay.hidden = false;
}

// Distance climbs about twenty-five times a second, so the counter is written
// silently and only *marks* the round hundreds. A pop animation on every metre
// is a number that never stops moving, which is unreadable and, on a swing that
// is going well, actively distracting.
const MILESTONE = 250;
let milestone = 0;
function showScore() {
  scoreNumEl.textContent = String(score);
  if (score < milestone + MILESTONE) return;
  milestone = Math.floor(score / MILESTONE) * MILESTONE;
  scoreEl.classList.remove('pop');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('pop');
  vibrate(10);
}

// ---------- Input ----------
// One verb, held. Press fires a web and keeps reaching until something is in
// range; release lets go. Nothing else is bound, so there is nothing to explain
// beyond the four words on the title card.
const pointers = new Set();

function press() {
  switch (state) {
    case S_START: startGame(); held = true; break;
    case S_PLAY: held = true; break;
    case S_OVER: startGame(); held = true; break;
    // S_DYING swallows input: a player mid-swing would otherwise mash straight
    // past their own score screen
  }
}

function release() {
  if (state === S_PLAY && anchor) {
    if (releaseBoost(p, anchor)) {
      perfectGlow = 1;
      vibrate(12);
    }
    ghosts.push({ x0: p.x, y0: p.y, x1: anchor.x, y1: anchor.y, life: 0.26 });
    anchor = null;
  }
  held = false;
  reachT = 0;
  missNoted = false;
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pointers.add(e.pointerId);
  press();
}, { passive: false });

const lift = (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) release();
};
stage.addEventListener('pointerup', lift);
stage.addEventListener('pointercancel', lift);
// a pointer that leaves the window never reports up — without this the web
// stays stuck on and the run flies itself
window.addEventListener('pointerup', lift);
window.addEventListener('blur', () => { pointers.clear(); release(); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
    e.preventDefault();
    if (!e.repeat) press();
  } else if (e.code === 'KeyR' && state === S_OVER) {
    startGame();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') release();
});

// ---------- Simulation ----------
// Fixed 120 Hz substeps, which is exactly the step tools/web-rules.mjs runs its
// autopilots at: the swing the assertions fly is the swing the player gets,
// whatever the display is doing.
const STEP = 1 / 120;
let acc = 0;

function substep(dt) {
  if (anchor) {
    rope = settleRope(rope, dt, anchor.clear);
    swingAssist(p, anchor, dt);
  } else if (held) {
    const a = pickAnchor(city.anchors, p.x, p.y);
    if (a) {
      anchor = a;
      rope = Math.hypot(p.x - a.x, p.y - a.y);
      reachT = 0;
      missNoted = false;
      vibrate(8);
    } else {
      reachT += dt;
    }
  }

  integrate(p, dt);
  if (anchor) applyRope(p, anchor, rope);

  city.ensure(p.x + viewW + 80);
  city.prune(p.x - viewW);

  const m = Math.max(0, Math.floor(p.x));
  if (m > score) { score = m; }

  if (hits(city, p.x, p.y)) die();
}

function update(dt) {
  idleT += dt;

  // the title screen drifts through a city it is not flying yet
  if (state === S_START) {
    cam.x += 7 * dt;
    const ty = Math.max(28, viewH * 0.5 - 9);
    cam.y += (ty - cam.y) * (1 - Math.exp(-dt * 1.5));
    city.ensure(cam.x + viewW + 80);
    city.prune(cam.x - viewW);
    return;
  }

  if (state === S_PLAY) {
    acc = Math.min(acc + dt, 0.1);
    while (acc >= STEP && state === S_PLAY) {
      substep(STEP);
      acc -= STEP;
    }
    if (scoreNumEl.textContent !== String(score)) showScore();

    // an unanswered web gets one buzz, not a buzz per frame
    if (held && !anchor && reachT > 0.22 && !missNoted) {
      missNoted = true;
      vibrate(6);
    }

    trail.push({ x: p.x, y: p.y, life: 0.34 });
  } else if (state === S_DYING) {
    dyingT += dt;
    integrate(p, Math.min(dt, 0.033));
    tumble += spin * dt;
    if (dyingT >= 0.45) gameOver();
  }

  for (const t of trail) t.life -= dt;
  while (trail.length && trail[0].life <= 0) trail.shift();
  for (const g of ghosts) g.life -= dt;
  while (ghosts.length && ghosts[0].life <= 0) ghosts.shift();

  // camera: a little ahead of the player, and never so low that the street
  // fills the screen
  const lead = clamp(p.vx * 0.25, -4, 7);
  const tx = p.x + viewW * 0.14 + lead;
  const ty = Math.max(p.y + viewH * 0.05, viewH * 0.5 - 9);
  const k = 1 - Math.exp(-dt * 5.5);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;

  if (flash > 0) flash = Math.max(0, flash - dt * 4.2);
  if (perfectGlow > 0) perfectGlow = Math.max(0, perfectGlow - dt * 2.4);
  if (shakeAmp > 0) {
    shakeAmp = Math.max(0, shakeAmp - dt * 34);
    shakeX = rand(-shakeAmp, shakeAmp);
    shakeY = rand(-shakeAmp, shakeAmp);
  } else {
    shakeX = shakeY = 0;
  }
}

// ---------- Rendering ----------
function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#05070f');
  g.addColorStop(0.42, '#0b1230');
  g.addColorStop(0.76, '#182050');
  g.addColorStop(1, '#3b2b55');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // stars drift a hair against the camera so the sky has depth without motion
  const so = cam.x * SC * 0.05;
  for (const s of stars) {
    const sx = ((s.x - so) % W + W) % W;
    const sy = s.y - cam.y * SC * 0.05;
    if (sy < -4 || sy > H) continue;
    ctx.globalAlpha = s.a;
    ctx.fillStyle = '#dfe6ff';
    ctx.beginPath();
    ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // moon, low and hazy — small and soft-edged, so it reads as distance rather
  // than as a white circle stuck to the glass
  const mx = ((W * 0.76 - cam.x * SC * 0.03) % (W * 2.4) + W * 2.4) % (W * 2.4);
  const my = H * 0.17 - cam.y * SC * 0.03;
  const mr = clamp(H * 0.036, 15, 42);
  const halo = ctx.createRadialGradient(mx, my, mr * 0.7, mx, my, mr * 6);
  halo.addColorStop(0, 'rgba(168,192,255,0.20)');
  halo.addColorStop(0.45, 'rgba(150,175,255,0.06)');
  halo.addColorStop(1, 'rgba(150,175,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(mx - mr * 6, my - mr * 6, mr * 12, mr * 12);
  const disc = ctx.createRadialGradient(mx - mr * 0.3, my - mr * 0.35, 0, mx, my, mr);
  disc.addColorStop(0, '#fbfcff');
  disc.addColorStop(0.72, '#dfe6fb');
  disc.addColorStop(1, 'rgba(190,203,235,0.55)');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();

  const co = cam.x * SC * 0.12;
  for (const c of clouds) {
    const cx = ((c.x - co) % cloudField + cloudField) % cloudField;
    const cy = c.y - cam.y * SC * 0.12;
    if (cy < -H * 0.3 || cy > H * 1.2) continue;
    for (let rep = -1; rep <= 1; rep++) {
      const px = cx + rep * cloudField;
      if (px + c.rx < 0 || px - c.rx > W) continue;
      const g2 = ctx.createRadialGradient(px, cy, 0, px, cy, c.rx);
      g2.addColorStop(0, `rgba(122,146,220,${c.a})`);
      g2.addColorStop(1, 'rgba(122,146,220,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.ellipse(px, cy, c.rx, c.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFarCity() {
  for (let li = 0; li < farLayers.length; li++) {
    const L = farLayers[li];
    const base = H / 2 + cam.y * SC * L.k;
    if (base < -20 || base > H + 240) continue;
    const off = ((cam.x * SC * L.k) % L.field + L.field) % L.field;
    ctx.fillStyle = li === 0 ? 'rgba(20,29,64,0.62)' : 'rgba(15,22,50,0.8)';
    for (const b of L.items) {
      for (let rep = -1; rep <= 1; rep++) {
        const sx = b.x - off + rep * L.field;
        if (sx + b.w < 0 || sx > W) continue;
        ctx.fillRect(sx, base - b.h, b.w, b.h + 40);
        // a few lit rooms, brighter on the nearer layer
        if (b.lit > 0.45 && b.w > 14) {
          ctx.fillStyle = li === 0 ? 'rgba(120,150,230,0.07)' : 'rgba(150,175,235,0.10)';
          const cols = Math.floor(b.w / 9);
          const rows = Math.floor(b.h / 12);
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
              if (hash2(Math.round(b.x) * 31 + c, r * 7 + li) < 0.68) continue;
              ctx.fillRect(sx + 3 + c * 9, base - b.h + 5 + r * 12, 3, 4);
            }
          }
          ctx.fillStyle = li === 0 ? 'rgba(20,29,64,0.62)' : 'rgba(15,22,50,0.8)';
        }
      }
    }
  }
}

// The anchor masts stand behind the near city, so a building can pass in front
// of one — that is what sells them as being further away than the roofs the
// player has to clear.
function drawMasts() {
  const y0 = Y(0);
  for (const a of city.anchors) {
    const sx = X(a.x);
    if (sx < -30 || sx > W + 30) continue;
    const sy = Y(a.y);
    ctx.strokeStyle = 'rgba(96,126,196,0.42)';
    ctx.lineWidth = Math.max(1, SC * 0.16);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, y0);
    ctx.stroke();
    // a crossbar, so the mast reads as a structure rather than a stray line
    const cw = SC * 0.9;
    ctx.lineWidth = Math.max(1, SC * 0.11);
    ctx.beginPath();
    ctx.moveTo(sx - cw, sy + SC * 1.6);
    ctx.lineTo(sx + cw, sy + SC * 1.6);
    ctx.stroke();
  }
}

function drawAnchorTips(candidate) {
  for (const a of city.anchors) {
    const sx = X(a.x), sy = Y(a.y);
    if (sx < -30 || sx > W + 30 || sy > H + 30) continue;
    const live = a === anchor || a === candidate;
    const r = Math.max(2, SC * (live ? 0.34 : 0.24));
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * (live ? 7 : 4));
    glow.addColorStop(0, live ? 'rgba(120,160,255,0.55)' : 'rgba(120,160,255,0.22)');
    glow.addColorStop(1, 'rgba(120,160,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(sx, sy, r * (live ? 7 : 4), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = live ? '#dce7ff' : 'rgba(190,210,255,0.8)';
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    // the one a web would take right now wears a ring: the aim rule is never
    // explained anywhere, so it has to be visible instead
    if (live && !anchor) {
      ctx.strokeStyle = 'rgba(140,175,255,0.75)';
      ctx.lineWidth = Math.max(1, SC * 0.1);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2.6 + Math.sin(idleT * 6) * SC * 0.08, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawCity() {
  const y0 = Y(0);
  const cellW = 2.4 * SC, cellH = 3.1 * SC;
  const windows = cellW >= 4.5;
  for (const b of city.buildings) {
    const sx = X(b.x), sw = b.w * SC;
    if (sx + sw < -10 || sx > W + 10) continue;
    const top = Y(b.h);
    const hgt = y0 - top;
    if (hgt <= 0) continue;

    const g = ctx.createLinearGradient(sx, top, sx, y0);
    g.addColorStop(0, '#161d33');
    g.addColorStop(0.55, '#0d1223');
    g.addColorStop(1, '#070a14');
    ctx.fillStyle = g;
    ctx.fillRect(sx, top, sw, hgt + 2);

    if (windows) {
      const cols = Math.max(1, Math.floor(sw / cellW));
      const rows = Math.max(1, Math.floor(hgt / cellH));
      const padX = (sw - cols * cellW) / 2;
      const key = Math.round(b.x * 4);
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const v = hash2(key + c * 131, r * 17);
          if (v < 0.4) continue;
          const warm = v > 0.74;
          ctx.fillStyle = warm
            ? `rgba(255,198,124,${0.26 + (v - 0.74) * 1.9})`
            : `rgba(148,178,244,${0.05 + v * 0.11})`;
          ctx.fillRect(
            sx + padX + c * cellW + cellW * 0.22,
            top + cellH * 0.5 + r * cellH,
            cellW * 0.5,
            cellH * 0.42
          );
        }
      }
    }

    // the roof edge is the line the player is actually flying against, so it
    // gets the only cool rim light in the scene, and a bloom above it — near
    // the top of a swing a roof is a long way off and still has to read as the
    // thing you must not touch
    const bloom = ctx.createLinearGradient(0, top - SC * 1.6, 0, top);
    bloom.addColorStop(0, 'rgba(124,162,255,0)');
    bloom.addColorStop(1, 'rgba(124,162,255,0.16)');
    ctx.fillStyle = bloom;
    ctx.fillRect(sx, top - SC * 1.6, sw, SC * 1.6);
    ctx.strokeStyle = 'rgba(150,182,255,0.8)';
    ctx.lineWidth = Math.max(1.2, SC * 0.15);
    ctx.beginPath();
    ctx.moveTo(sx, top);
    ctx.lineTo(sx + sw, top);
    ctx.stroke();
  }

  // the street: a warm haze the player must never reach
  const sg = ctx.createLinearGradient(0, y0 - SC * 3, 0, y0 + SC * 6);
  sg.addColorStop(0, 'rgba(255,170,110,0)');
  sg.addColorStop(0.55, 'rgba(255,168,104,0.16)');
  sg.addColorStop(1, 'rgba(120,60,40,0.5)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, y0 - SC * 3, W, SC * 9 + 4);
}

function drawTrail() {
  if (trail.length < 2) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const t = b.life / 0.34;
    ctx.globalAlpha = t * 0.32;
    ctx.strokeStyle = '#9fc0ff';
    ctx.lineWidth = Math.max(1, SC * 0.3 * t);
    ctx.beginPath();
    ctx.moveTo(X(a.x), Y(a.y));
    ctx.lineTo(X(b.x), Y(b.y));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function handPoint() {
  // where the web leaves the figure: toward the anchor if attached, otherwise
  // along the aim the game would actually take
  const ang = anchor
    ? Math.atan2(anchor.y - p.y, anchor.x - p.x)
    : (p.vx < 0 ? Math.PI - IDEAL_ANG : IDEAL_ANG);
  return { ang, x: p.x + Math.cos(ang) * 1.05, y: p.y + Math.sin(ang) * 1.05 };
}

function strokeWeb(x0, y0, x1, y1, alpha, width) {
  ctx.save();
  ctx.strokeStyle = `rgba(222,233,255,${alpha})`;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(110,150,255,0.85)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function drawWeb() {
  const hand = handPoint();
  const lw = Math.max(1.4, SC * 0.14);

  for (const g of ghosts) {
    strokeWeb(X(g.x0), Y(g.y0), X(g.x1), Y(g.y1), (g.life / 0.26) * 0.5, lw * 0.8);
  }

  if (anchor) {
    strokeWeb(X(hand.x), Y(hand.y), X(anchor.x), Y(anchor.y), 0.92, lw);
  } else if (held && state === S_PLAY) {
    // reaching for nothing: the line casts out and snaps back on a loop, so a
    // held web with no anchor in range never reads as a dead control
    const cycle = (reachT % 0.42) / 0.42;
    const out = Math.sin(cycle * Math.PI);
    const len = MAX_ROPE * 0.5 * out;
    strokeWeb(
      X(hand.x), Y(hand.y),
      X(hand.x + Math.cos(hand.ang) * len), Y(hand.y + Math.sin(hand.ang) * len),
      0.34 * out + 0.1, lw * 0.7
    );
  }
}

function drawPlayer() {
  const hand = handPoint();
  const travel = Math.atan2(p.vy, p.vx);
  const lean = state === S_DYING ? tumble : 0;
  const torso = (anchor || held ? hand.ang : travel + 0.5) + lean;
  const back = travel + Math.PI + lean;

  // The figure is drawn about half again as large as PLAYER_R, which is the
  // forgiving-hitbox rule from DESIGN.md turned into pixels: a body the size of
  // its own collision circle would be 17 px tall on a phone and unreadable, and
  // every graze would look like a hit.
  const F = 1.4;
  const hx = p.x + Math.cos(torso) * 0.75 * F, hy = p.y + Math.sin(torso) * 0.75 * F;
  const headX = p.x + Math.cos(torso) * 0.34 * F, headY = p.y + Math.sin(torso) * 0.34 * F;
  const hipX = p.x - Math.cos(torso) * 0.55 * F, hipY = p.y - Math.sin(torso) * 0.55 * F;

  const legs = [0.3, -0.22].map((spread) => {
    const kx = hipX + Math.cos(back + spread) * 0.7 * F;
    const ky = hipY + Math.sin(back + spread) * 0.7 * F;
    return {
      kx, ky,
      fx: kx + Math.cos(back + spread * 0.2 - 0.35) * 0.72 * F,
      fy: ky + Math.sin(back + spread * 0.2 - 0.35) * 0.72 * F,
    };
  });

  const limb = (pass) => {
    ctx.lineWidth = Math.max(2, SC * (pass === 0 ? 0.52 : 0.3) * F);
    ctx.strokeStyle = pass === 0 ? 'rgba(4,7,18,0.92)' : '#eef3ff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(X(hipX), Y(hipY));
    ctx.lineTo(X(hx), Y(hy));
    for (const L of legs) {
      ctx.moveTo(X(hipX), Y(hipY));
      ctx.lineTo(X(L.kx), Y(L.ky));
      ctx.lineTo(X(L.fx), Y(L.fy));
    }
    ctx.stroke();
    ctx.fillStyle = pass === 0 ? 'rgba(4,7,18,0.92)' : '#f6f9ff';
    ctx.beginPath();
    ctx.arc(X(headX), Y(headY), SC * (pass === 0 ? 0.5 : 0.36) * F, 0, Math.PI * 2);
    ctx.fill();
  };

  // a dark pass under a light pass: the figure stays legible over lit windows
  // and over open sky alike
  limb(0);
  limb(1);

  // the mark on the back, in the game's own accent
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(X(p.x), Y(p.y), Math.max(1.4, SC * 0.17 * F), 0, Math.PI * 2);
  ctx.fill();

  if (perfectGlow > 0) {
    const r = SC * (1.6 + (1 - perfectGlow) * 3.4);
    ctx.strokeStyle = `rgba(140,180,255,${perfectGlow * 0.6})`;
    ctx.lineWidth = Math.max(1, SC * 0.16);
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawSpeedLines() {
  const v = speed(p);
  if (v < V_MAX * 0.74 || state !== S_PLAY) return;
  const t = (v - V_MAX * 0.74) / (V_MAX * 0.26);
  const ang = Math.atan2(p.vy, p.vx);
  ctx.save();
  ctx.strokeStyle = `rgba(190,215,255,${0.05 + t * 0.09})`;
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const d = hash2(i, Math.floor(idleT * 12));
    const off = (d - 0.5) * H * 0.7;
    const sx = X(p.x) - Math.cos(ang) * (SC * 3 + d * SC * 9) - Math.sin(ang) * off;
    const sy = Y(p.y) + Math.sin(ang) * (SC * 3 + d * SC * 9) - Math.cos(ang) * off;
    const len = SC * (2 + d * 4) * (0.5 + t);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx - Math.cos(ang) * len, sy + Math.sin(ang) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawSky();
  drawFarCity();
  if (city) {
    const candidate = !anchor && state === S_PLAY ? pickAnchor(city.anchors, p.x, p.y) : null;
    drawMasts();
    drawCity();
    drawAnchorTips(candidate);
    // on the title screen the city drifts by on its own — a figure parked in
    // mid-air while the camera pulls away from it reads as a stuck game
    if (state !== S_START) {
      drawSpeedLines();
      drawTrail();
      drawWeb();
      drawPlayer();
    }
  }
  drawVignette();

  if (flash > 0) {
    ctx.fillStyle = `rgba(255,235,225,${flash})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------- Loop ----------
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - lastT) / 1000;
  lastT = now;
  if (pause.active || document.hidden) return;
  update(clamp(raw, 0, 0.033));
  render();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) lastT = performance.now();
  else { pointers.clear(); release(); }
});
window.addEventListener('resize', () => { resize(); buildStars(); });

// ---------- Boot ----------
resize();
buildStars();
bestScoreEl.textContent = String(best);
// the title screen watches a city it is not flying through yet
resetPlay();
state = S_START;

const pause = installPause({
  canPause: () => state === S_PLAY,
  // a web held through a pause would still be held on the other side of it
  onPause: () => { pointers.clear(); release(); },
});
// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== S_PLAY });
installPrompt();
requestAnimationFrame(frame);
