import { installPause } from './pause.js';
import { installUpdates } from './update.js';
// Nova — a vertical galaxy shooter.
// Airplane Mode collection. Fully offline, canvas 2D.
// Autofiring lasers, alien formations that vary by level, glowing power-ups,
// a three-layer parallax starfield. All glow is pre-rendered to offscreen
// sprites at init — the frame loop never touches shadowBlur.

// ---------------------------------------------------------------------------
// Constants (world units: fixed 400x700 internal world, letterboxed to fit)
// ---------------------------------------------------------------------------
const VW = 400, VH = 700;
const PLAYER_MAX_Y = VH - 84;   // lowest the ship flies (bottom margin)
const PLAYER_MIN_Y = Math.round(VH * 2 / 3); // never higher than the bottom third
const PLAYER_R = 14;            // ship hit radius (forgiving on purpose)
const PLAYER_HALF = 18;         // horizontal clamp margin
const PLAYER_SPEED = 360;       // u/s with keys / buttons
const DRAG_EASE = 14;           // exponential chase rate toward the finger
const DRAG_LIFT = 90;           // ship rides this far above the finger (world u)
const FIRE_INTERVAL = 0.21;     // s between autofire volleys
const BULLET_SPEED = 640;       // u/s upward
const ENEMY_R = 15;             // enemy hit radius
const ENTER_DUR = 0.85;         // s for an enemy to swoop into formation
const INVADE_Y = VH - 120;      // enemies past this line hit the ship
const POWERUP_FALL = 96;        // u/s
const POWERUP_R = 17;           // pickup radius (added to PLAYER_R)
const INVINCIBLE_S = 1.6;       // post-hit mercy window
const DYING_MS = 240;           // explosion beat before the game-over card
const CLEAR_DELAY = 1.1;        // s between wave cleared and next wave
const MAX_LIVES = 3;

const BEST_KEY = 'am.nova.best';
const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;
const TAU = Math.PI * 2;

const VARIANT_COLORS = [
  { body: '#f0abfc', deep: '#c026d3', glow: '#e879f9' },  // magenta
  { body: '#fcd34d', deep: '#d97706', glow: '#fbbf24' },  // amber
  { body: '#6ee7b7', deep: '#059669', glow: '#34d399' },  // emerald
  { body: '#fda4af', deep: '#e11d48', glow: '#fb7185' },  // rose
];

const POWER_COLORS = {
  double: '#38bdf8',
  triple: '#818cf8',
  shield: '#34d399',
  life: '#fb7185',
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const frameEl = document.getElementById('frame');
const scoreEl = document.getElementById('score');
const levelIndEl = document.getElementById('level-ind');
const heartEls = Array.from(document.querySelectorAll('#lives .heart'));
const bannerEl = document.getElementById('level-banner');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const startBestEl = document.getElementById('start-best');
const finalScoreEl = document.getElementById('final-score');
const bestScoreEl = document.getElementById('best-score');
const finalLevelEl = document.getElementById('final-level');
const newBestEl = document.getElementById('new-best');
const restartBtn = document.getElementById('restart');
const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

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
function swapRemove(arr, i) {
  arr[i] = arr[arr.length - 1];
  arr.pop();
}

// ---------------------------------------------------------------------------
// Canvas sizing (DPR-aware, letterboxed 400x700 world)
// ---------------------------------------------------------------------------
let dpr = 1, s = 1, ox = 0, oy = 0, cw = 0, ch = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  cw = stage.clientWidth;
  ch = stage.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  s = Math.min(cw / VW, ch / VH);
  ox = (cw - VW * s) / 2;
  oy = (ch - VH * s) / 2;
  frameEl.style.left = ox + 'px';
  frameEl.style.top = oy + 'px';
  frameEl.style.width = (VW * s) + 'px';
  frameEl.style.height = (VH * s) + 'px';
}
window.addEventListener('resize', resize);

function toWorldX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return clamp((clientX - rect.left - ox) / s, 0, VW);
}
function toWorldY(clientY) {
  const rect = canvas.getBoundingClientRect();
  return clamp((clientY - rect.top - oy) / s, 0, VH);
}

// ---------------------------------------------------------------------------
// Pre-rendered glow sprites (shadowBlur only ever runs here, at init)
// ---------------------------------------------------------------------------
const SS = 3; // supersample factor so sprites stay crisp when scaled up

function makeSprite(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * SS);
  c.height = Math.ceil(h * SS);
  const g = c.getContext('2d');
  g.scale(SS, SS);
  draw(g, w, h);
  return { c, w, h };
}

function drawSprite(sp, x, y) {
  ctx.drawImage(sp.c, x - sp.w / 2, y - sp.h / 2, sp.w, sp.h);
}

const shipSprite = makeSprite(56, 60, (g, w, h) => {
  g.translate(w / 2, h / 2);
  g.shadowColor = '#38bdf8';
  g.shadowBlur = 12;
  // wings
  g.fillStyle = '#075985';
  g.beginPath();
  g.moveTo(5, -1); g.lineTo(19, 11); g.lineTo(16, 16); g.lineTo(4, 10); g.closePath();
  g.moveTo(-5, -1); g.lineTo(-19, 11); g.lineTo(-16, 16); g.lineTo(-4, 10); g.closePath();
  g.fill();
  // fuselage
  const grad = g.createLinearGradient(0, -20, 0, 18);
  grad.addColorStop(0, '#e0f2fe');
  grad.addColorStop(0.45, '#38bdf8');
  grad.addColorStop(1, '#075985');
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, -21);
  g.quadraticCurveTo(7, -8, 6, 8);
  g.lineTo(4, 15); g.lineTo(-4, 15); g.lineTo(-6, 8);
  g.quadraticCurveTo(-7, -8, 0, -21);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  // canopy
  g.fillStyle = 'rgba(224,242,254,.92)';
  g.beginPath();
  g.ellipse(0, -6, 2.6, 6.5, 0, 0, TAU);
  g.fill();
  // engine nacelles
  g.fillStyle = '#0c4a6e';
  g.fillRect(-8, 11, 4, 6);
  g.fillRect(4, 11, 4, 6);
});

const laserSprite = makeSprite(12, 24, (g, w, h) => {
  g.translate(w / 2, h / 2);
  g.shadowColor = '#38bdf8';
  g.shadowBlur = 6;
  g.fillStyle = '#7dd3fc';
  g.beginPath();
  g.roundRect(-2.2, -9, 4.4, 18, 2.2);
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(-1, -7.5, 2, 15, 1);
  g.fill();
});

const enemyBulletSprite = makeSprite(14, 14, (g, w, h) => {
  g.translate(w / 2, h / 2);
  g.shadowColor = '#fb7185';
  g.shadowBlur = 6;
  g.fillStyle = '#fda4af';
  g.beginPath();
  g.arc(0, 0, 4, 0, TAU);
  g.fill();
  g.shadowBlur = 0;
  g.fillStyle = '#fff1f2';
  g.beginPath();
  g.arc(0, 0, 1.8, 0, TAU);
  g.fill();
});

const enemySprites = VARIANT_COLORS.map((col) => makeSprite(40, 34, (g, w, h) => {
  g.translate(w / 2, h / 2);
  g.shadowColor = col.glow;
  g.shadowBlur = 9;
  // swept wings
  g.fillStyle = col.deep;
  g.beginPath();
  g.moveTo(-3, -3); g.lineTo(-16, 3); g.lineTo(-13, 9); g.lineTo(-3, 5); g.closePath();
  g.moveTo(3, -3); g.lineTo(16, 3); g.lineTo(13, 9); g.lineTo(3, 5); g.closePath();
  g.fill();
  // body (points down, toward the player)
  g.fillStyle = col.body;
  g.beginPath();
  g.moveTo(0, 12);
  g.quadraticCurveTo(7, 4, 6, -6);
  g.quadraticCurveTo(4, -12, 0, -12);
  g.quadraticCurveTo(-4, -12, -6, -6);
  g.quadraticCurveTo(-7, 4, 0, 12);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  // eye
  g.fillStyle = '#0a0a0f';
  g.beginPath();
  g.ellipse(0, -2, 3.2, 4.4, 0, 0, TAU);
  g.fill();
  g.fillStyle = col.glow;
  g.beginPath();
  g.arc(0, -3, 1.4, 0, TAU);
  g.fill();
}));

function drawPowerGlyph(g, type) {
  g.fillStyle = '#f8fafc';
  if (type === 'double') {
    g.beginPath();
    g.roundRect(-4.6, -5.5, 3, 11, 1.5);
    g.roundRect(1.6, -5.5, 3, 11, 1.5);
    g.fill();
  } else if (type === 'triple') {
    g.beginPath();
    g.roundRect(-7.2, -4, 2.6, 8, 1.3);
    g.roundRect(-1.3, -6, 2.6, 12, 1.3);
    g.roundRect(4.6, -4, 2.6, 8, 1.3);
    g.fill();
  } else if (type === 'shield') {
    g.strokeStyle = '#f8fafc';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -6);
    g.quadraticCurveTo(5.5, -4.5, 5.5, -1.5);
    g.quadraticCurveTo(5.5, 3.6, 0, 6.4);
    g.quadraticCurveTo(-5.5, 3.6, -5.5, -1.5);
    g.quadraticCurveTo(-5.5, -4.5, 0, -6);
    g.closePath();
    g.stroke();
  } else if (type === 'life') {
    g.beginPath();
    g.moveTo(0, 6);
    g.bezierCurveTo(-7, 0, -6, -6, -2.6, -6);
    g.bezierCurveTo(-1, -6, 0, -4.6, 0, -3.6);
    g.bezierCurveTo(0, -4.6, 1, -6, 2.6, -6);
    g.bezierCurveTo(6, -6, 7, 0, 0, 6);
    g.closePath();
    g.fill();
  }
}

const powerupSprites = {};
for (const type of Object.keys(POWER_COLORS)) {
  const color = POWER_COLORS[type];
  powerupSprites[type] = makeSprite(38, 38, (g, w, h) => {
    g.translate(w / 2, h / 2);
    g.shadowColor = color;
    g.shadowBlur = 10;
    // hex badge
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * TAU;
      const px = Math.cos(a) * 12.5, py = Math.sin(a) * 12.5;
      i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    g.closePath();
    g.fillStyle = 'rgba(10,10,15,.72)';
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.stroke();
    g.shadowBlur = 0;
    drawPowerGlyph(g, type);
  });
}

// Soft radial nebula blobs for the background (drawn dim, composite 'lighter')
function makeNebula(size, color) {
  return makeSprite(size, size, (g, w, h) => {
    const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });
}
const nebulaSprites = [
  makeNebula(300, 'rgba(49,46,129,.34)'),
  makeNebula(240, 'rgba(14,116,144,.26)'),
  makeNebula(260, 'rgba(134,25,143,.22)'),
];

// ---------------------------------------------------------------------------
// Starfield (3 parallax layers drifting downward; pure function of t)
// ---------------------------------------------------------------------------
function makeLayer(count, speed, rMin, rMax, alpha) {
  return {
    speed, alpha,
    stars: Array.from({ length: count }, () => ({
      x: Math.random() * VW,
      y: Math.random() * VH,
      r: rMin + Math.random() * (rMax - rMin),
      tw: Math.random() * TAU,
    })),
  };
}
const starLayers = [
  makeLayer(56, 13, 0.5, 1.1, 0.4),
  makeLayer(36, 30, 0.8, 1.6, 0.65),
  makeLayer(22, 58, 1.1, 2.2, 0.95),
];
const nebulae = Array.from({ length: 3 }, (_, i) => ({
  sprite: nebulaSprites[i],
  x: Math.random() * VW,
  y: Math.random() * VH,
  speed: 5 + i * 3,
}));

// ---------------------------------------------------------------------------
// Particle pool (explosions / sparks) — fixed size, no per-frame alloc
// ---------------------------------------------------------------------------
const MAX_PARTICLES = 160;
const particles = Array.from({ length: MAX_PARTICLES }, () => ({ active: false }));

function addBurst(x, y, color, count, speed = 200) {
  let spawned = 0;
  for (let i = 0; i < particles.length && spawned < count; i++) {
    const p = particles[i];
    if (p.active) continue;
    const a = Math.random() * TAU;
    const spd = speed * (0.35 + Math.random() * 0.75);
    p.active = true;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * spd;
    p.vy = Math.sin(a) * spd;
    p.life = 0;
    p.maxLife = 0.4 + Math.random() * 0.35;
    p.color = color;
    p.size = 1.8 + Math.random() * 2.6;
    spawned++;
  }
}

function updateParticles(dt) {
  const drag = Math.exp(-2.6 * dt);
  for (const p of particles) {
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.maxLife) { p.active = false; continue; }
    p.vx *= drag;
    p.vy = p.vy * drag + 26 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

function drawParticles() {
  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    if (!p.active) continue;
    const t01 = p.life / p.maxLife;
    ctx.globalAlpha = 1 - t01;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (1 - t01 * 0.6), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state;                // 'ready' | 'playing' | 'dying' | 'over'
let t = 0;                // running clock (s)
let score, shownScore, best, lives, level, weapon, shield;
let player;               // { x, tilt }
let playerBullets, enemyBullets, enemies, powerups;
let fireCd, enemyFireCd, invUntil, shake, deadAt;
let waveMode, clearT, formT, wave;
let keyLeft = false, keyRight = false, keyUp = false, keyDown = false;
let btnDir = 0, testDir = 0, testDirY = 0, dragX = null, dragY = null;

const bulletPool = [];
function spawnBullet(arr, x, y, vx, vy) {
  const b = bulletPool.pop() || { x: 0, y: 0, vx: 0, vy: 0 };
  b.x = x; b.y = y; b.vx = vx; b.vy = vy;
  arr.push(b);
  return b;
}
function releaseBullet(arr, i) {
  bulletPool.push(arr[i]);
  swapRemove(arr, i);
}

// ---------------------------------------------------------------------------
// Waves / formations
// ---------------------------------------------------------------------------
const WAVE_KINDS = ['grid', 'vee', 'weave', 'sweep'];

function makeEnemy(fx, fy, sx, sy, row, delay, wamp, phase) {
  return {
    fx, fy, sx, sy, row, delay, wamp, phase,
    x: sx, y: sy,
    variant: row % 4,
    points: row === 0 ? 20 : 10,
    state: 'enter',
    prog: 0,
    swoop: (Math.random() < 0.5 ? -1 : 1) * (24 + Math.random() * 26),
  };
}

function spawnWave(lv) {
  const kind = WAVE_KINDS[(lv - 1) % WAVE_KINDS.length];
  formT = 0;
  wave = {
    kind,
    swayAmp: kind === 'weave' ? 10 : 22 + Math.min(14, lv * 2),
    swayFreq: 0.8 + Math.min(0.7, lv * 0.06),
    weaveFreq: 1.1 + Math.min(0.8, lv * 0.07),
    descend: Math.min(18, 4.5 + lv * 1.1),
  };
  enemies.length = 0;

  if (kind === 'grid') {
    const cols = Math.min(7, 4 + Math.floor(lv / 3));
    const rows = Math.min(4, 2 + Math.floor(lv / 4));
    const sx = Math.min(58, (VW - 80) / Math.max(1, cols - 1));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const fx = VW / 2 + (c - (cols - 1) / 2) * sx;
        const fy = 64 + r * 48;
        enemies.push(makeEnemy(fx, fy, fx, -46 - r * 24, r, (r * cols + c) * 0.05, 0, c * 0.9));
      }
    }
  } else if (kind === 'vee') {
    const n = Math.min(7, 4 + Math.floor(lv / 3));
    enemies.push(makeEnemy(VW / 2, 176, VW / 2, -46, 0, 0, 0, 0));
    for (let k = 1; k <= n; k++) {
      const dy = 176 - k * 26;
      for (const side of [-1, 1]) {
        const fx = VW / 2 + side * k * 30;
        enemies.push(makeEnemy(fx, dy, fx + side * 40, -46 - k * 18, k % 4 === 0 ? 0 : k % 4, k * 0.07, 0, k * 0.8));
      }
    }
  } else if (kind === 'weave') {
    const cols = Math.min(5, 3 + Math.floor(lv / 4));
    const spread = Math.min(72, (VW - 170) / Math.max(1, cols - 1));
    for (let c = 0; c < cols; c++) {
      const fx = VW / 2 + (c - (cols - 1) / 2) * spread;
      for (let i = 0; i < 4; i++) {
        enemies.push(makeEnemy(fx, 60 + i * 48, fx, -46 - i * 26, i, i * 0.09 + c * 0.24, 42, c * 1.7 + i * 0.5));
      }
    }
  } else { // sweep
    const cols = Math.min(8, 5 + Math.floor(lv / 4));
    const sx = Math.min(48, (VW - 90) / Math.max(1, cols - 1));
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cols; c++) {
        const fx = VW / 2 + (c - (cols - 1) / 2) * sx;
        const fromLeft = r % 2 === 0;
        enemies.push(makeEnemy(
          fx, 70 + r * 50,
          fromLeft ? -40 - c * 30 : VW + 40 + c * 30, 40 + r * 46,
          r, c * 0.06, 0, c * 0.7
        ));
      }
    }
  }
}

// Slot position for an enemy in the swaying / creeping formation.
// Written into _ex/_ey to avoid per-frame object allocation.
let _ex = 0, _ey = 0;
function slotPos(e) {
  let x = e.fx + Math.sin(formT * wave.swayFreq + e.row * 0.6) * wave.swayAmp;
  if (e.wamp) x += Math.sin(formT * wave.weaveFreq + e.phase) * e.wamp;
  _ex = clamp(x, 22, VW - 22);
  _ey = e.fy + formT * wave.descend + Math.cos(formT * 0.8 + e.row) * 4;
}

function enemyFireInterval() {
  return Math.max(0.32, 1.2 - level * 0.07);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function reset() {
  score = 0; shownScore = -1;
  lives = MAX_LIVES;
  level = 1;
  weapon = 1;
  shield = false;
  invUntil = 0;
  shake = 0;
  t = 0;
  fireCd = 0;
  enemyFireCd = 1.5;
  player = { x: VW / 2, y: PLAYER_MAX_Y, tilt: 0 };
  playerBullets = [];
  enemyBullets = [];
  enemies = [];
  powerups = [];
  for (const p of particles) p.active = false;
  waveMode = 'active';
  clearT = 0;
  wave = { kind: 'grid', swayAmp: 0, swayFreq: 1, weaveFreq: 1, descend: 0 };
  formT = 0;
  keyLeft = keyRight = keyUp = keyDown = false;
  btnDir = 0; testDir = 0; testDirY = 0; dragX = null; dragY = null;
  updateHud(true);
  state = 'ready';
  syncStageClass();
  showStart();
}

function showStart() {
  startOverlay.hidden = false;
  overOverlay.hidden = true;
  startBestEl.textContent = fmt(best);
}

function startPlaying() {
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  state = 'playing';
  syncStageClass();
  spawnWave(level);
  showBanner(level);
}

function restart() {
  reset();
  startPlaying();
}

function die() {
  state = 'dying';
  deadAt = t;
  addBurst(player.x, player.y, '#7dd3fc', 30, 280);
  addBurst(player.x, player.y, '#e0f2fe', 18, 170);
  shake = 1;
  syncStageClass();
  navigator.vibrate?.(30);
}

function showGameOver() {
  finalScoreEl.textContent = fmt(score);
  const isNew = score > best;
  if (isNew) { best = score; saveBest(best); }
  bestScoreEl.textContent = fmt(best);
  finalLevelEl.textContent = String(level);
  newBestEl.hidden = !isNew;
  overOverlay.hidden = false;
  state = 'over';
  syncStageClass();
}

function syncStageClass() {
  stage.classList.toggle('playing', state === 'playing');
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function updateHud(force) {
  if (force || score !== shownScore) {
    shownScore = score;
    scoreEl.textContent = fmt(score);
  }
  if (force) levelIndEl.textContent = 'LV ' + level;
  for (let i = 0; i < heartEls.length; i++) {
    heartEls[i].classList.toggle('lost', i >= lives);
  }
}

let bannerTimer = null;
function showBanner(lv) {
  bannerEl.textContent = 'LEVEL ' + lv;
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth; // restart the CSS animation
  bannerEl.classList.add('show');
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 1600);
  levelIndEl.textContent = 'LV ' + lv;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function currentDir() {
  if (btnDir !== 0) return btnDir;
  if (testDir !== 0) return testDir;
  if (keyLeft && !keyRight) return -1;
  if (keyRight && !keyLeft) return 1;
  return 0;
}
function currentDirY() {
  if (testDirY !== 0) return testDirY;
  if (keyUp && !keyDown) return -1;
  if (keyDown && !keyUp) return 1;
  return 0;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) { keyLeft = true; e.preventDefault(); }
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) { keyRight = true; e.preventDefault(); }
  else if (['ArrowUp', 'w', 'W'].includes(e.key)) { keyUp = true; e.preventDefault(); }
  else if (['ArrowDown', 's', 'S'].includes(e.key)) { keyDown = true; e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') startPlaying();
    else if (state === 'over') restart();
    // during play: lasers already autofire — Space is simply satisfied
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (state !== 'ready') restart();
  }
});
window.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) keyLeft = false;
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) keyRight = false;
  else if (['ArrowUp', 'w', 'W'].includes(e.key)) keyUp = false;
  else if (['ArrowDown', 's', 'S'].includes(e.key)) keyDown = false;
});

// Direct drag on the canvas: the ship rides DRAG_LIFT above the finger and
// chases it on both axes (clamped live to the bottom-third flight band).
let ptrId = null;
function updateDragTarget(e) {
  dragX = toWorldX(e.clientX);
  dragY = clamp(toWorldY(e.clientY) - DRAG_LIFT, PLAYER_MIN_Y, PLAYER_MAX_Y);
}
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  if (state === 'ready') { startPlaying(); return; }
  if (state === 'over') { restart(); return; }
  if (state === 'playing') {
    ptrId = e.pointerId;
    updateDragTarget(e);
  }
});
stage.addEventListener('pointermove', (e) => {
  if (ptrId !== e.pointerId) return;
  if (state === 'playing') updateDragTarget(e);
});
function endPointer(e) {
  if (ptrId !== e.pointerId) return;
  ptrId = null;
  dragX = null;
  dragY = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('dblclick', (e) => e.preventDefault());
stage.addEventListener('contextmenu', (e) => e.preventDefault());

// On-screen ◀ ▶ hold buttons (touch devices)
function bindHold(el, dir) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    btnDir = dir;
  });
  const release = () => { if (btnDir === dir) btnDir = 0; };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
}
bindHold(btnLeft, -1);
bindHold(btnRight, 1);

restartBtn.addEventListener('click', restart);

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------
function firePlayer() {
  const y = player.y - 24;
  if (weapon === 1) {
    spawnBullet(playerBullets, player.x, y, 0, -BULLET_SPEED);
  } else if (weapon === 2) {
    spawnBullet(playerBullets, player.x - 7, y, 0, -BULLET_SPEED);
    spawnBullet(playerBullets, player.x + 7, y, 0, -BULLET_SPEED);
  } else {
    spawnBullet(playerBullets, player.x, y - 4, 0, -BULLET_SPEED);
    spawnBullet(playerBullets, player.x - 10, y, -85, -BULLET_SPEED);
    spawnBullet(playerBullets, player.x + 10, y, 85, -BULLET_SPEED);
  }
}

function enemyFire() {
  // pick a random settled enemy; slight aim toward the player at higher levels
  let n = 0;
  let chosen = null;
  for (const e of enemies) {
    if (e.delay > 0 || e.state !== 'form') continue;
    n++;
    if (Math.random() < 1 / n) chosen = e;
  }
  if (!chosen) return;
  const vy = Math.min(300, 165 + level * 12);
  const vx = level >= 3 ? clamp((player.x - chosen.x) * 0.35, -70, 70) : 0;
  spawnBullet(enemyBullets, chosen.x, chosen.y + 14, vx, vy);
}

function maybeDrop(x, y) {
  if (Math.random() >= 0.13) return;
  const r = Math.random();
  let type = r < 0.34 ? 'double' : r < 0.56 ? 'triple' : r < 0.86 ? 'shield' : 'life';
  if (type === 'double' && weapon >= 2) type = 'triple';
  if (type === 'life' && lives >= MAX_LIVES) type = 'shield';
  if (type === 'shield' && shield) type = weapon >= 3 ? 'life' : 'triple';
  if (type === 'life' && lives >= MAX_LIVES) type = 'double';
  powerups.push({ type, x, baseX: x, y, phase: Math.random() * TAU });
}

function killEnemy(i, scored) {
  const e = enemies[i];
  const col = VARIANT_COLORS[e.variant];
  addBurst(e.x, e.y, col.glow, 14, 230);
  addBurst(e.x, e.y, '#f8fafc', 5, 130);
  if (scored) {
    score += e.points;
    maybeDrop(e.x, e.y);
  }
  swapRemove(enemies, i);
}

function damagePlayer() {
  if (state !== 'playing' || t < invUntil) return;
  if (shield) {
    shield = false;
    invUntil = t + 1.0;
    addBurst(player.x, player.y, '#34d399', 22, 240);
    shake = Math.max(shake, 0.5);
    navigator.vibrate?.(10);
    return;
  }
  lives--;
  updateHud(true);
  addBurst(player.x, player.y, '#7dd3fc', 22, 240);
  shake = 1;
  invUntil = t + INVINCIBLE_S;
  navigator.vibrate?.(20);
  if (lives <= 0) die();
}

function applyPowerup(type) {
  if (type === 'double') weapon = Math.max(weapon, 2);
  else if (type === 'triple') weapon = 3;
  else if (type === 'shield') shield = true;
  else if (type === 'life') {
    if (lives < MAX_LIVES) { lives++; updateHud(true); }
    else score += 50;
  }
  addBurst(player.x, player.y - 10, POWER_COLORS[type], 16, 190);
  navigator.vibrate?.(10);
}

// ---------------------------------------------------------------------------
// Update (pure logic — driven by the rAF loop and by tests via tick())
// ---------------------------------------------------------------------------
function update(dt) {
  t += dt;
  if (shake > 0) shake = Math.max(0, shake - dt * 2.6);

  if (state === 'dying') {
    updateParticles(dt);
    for (let i = playerBullets.length - 1; i >= 0; i--) {
      const b = playerBullets[i];
      b.y += b.vy * dt;
      if (b.y < -24) releaseBullet(playerBullets, i);
    }
    if (t - deadAt > DYING_MS / 1000) showGameOver();
    return;
  }
  if (state !== 'playing') { updateParticles(dt); return; }

  // ---- movement (x and y, both clamped live) ----
  const prevX = player.x;
  const dir = currentDir();
  if (dir !== 0) {
    player.x = clamp(player.x + dir * PLAYER_SPEED * dt, PLAYER_HALF, VW - PLAYER_HALF);
  } else if (dragX != null) {
    const target = clamp(dragX, PLAYER_HALF, VW - PLAYER_HALF);
    player.x += (target - player.x) * Math.min(1, dt * DRAG_EASE);
  }
  const dirY = currentDirY();
  if (dirY !== 0) {
    player.y = clamp(player.y + dirY * PLAYER_SPEED * dt, PLAYER_MIN_Y, PLAYER_MAX_Y);
  } else if (dragY != null) {
    const targetY = clamp(dragY, PLAYER_MIN_Y, PLAYER_MAX_Y);
    player.y += (targetY - player.y) * Math.min(1, dt * DRAG_EASE);
  }
  const vx = dt > 0 ? (player.x - prevX) / dt : 0;
  player.tilt = lerp(player.tilt, clamp(vx / PLAYER_SPEED, -1, 1), Math.min(1, dt * 10));

  // ---- autofire ----
  fireCd -= dt;
  while (fireCd <= 0) {
    fireCd += FIRE_INTERVAL;
    firePlayer();
  }

  // ---- player bullets ----
  for (let i = playerBullets.length - 1; i >= 0; i--) {
    const b = playerBullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y < -24 || b.x < -20 || b.x > VW + 20) releaseBullet(playerBullets, i);
  }

  // ---- wave flow ----
  formT += dt;
  if (waveMode === 'active' && enemies.length === 0) {
    waveMode = 'clear';
    clearT = 0;
    score += 25 * level; // wave bonus
  } else if (waveMode === 'clear') {
    clearT += dt;
    if (clearT >= CLEAR_DELAY) {
      level++;
      waveMode = 'active';
      spawnWave(level);
      showBanner(level);
    }
  }

  // ---- enemies ----
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (e.delay > 0) { e.delay -= dt; continue; }
    slotPos(e);
    if (e.state === 'enter') {
      e.prog += dt / ENTER_DUR;
      if (e.prog >= 1) {
        e.state = 'form';
        e.x = _ex; e.y = _ey;
      } else {
        const k = smoothstep(e.prog);
        e.x = lerp(e.sx, _ex, k) + Math.sin(e.prog * Math.PI) * e.swoop;
        e.y = lerp(e.sy, _ey, k);
      }
    } else {
      e.x = _ex; e.y = _ey;
    }
    // invasion: an enemy that reaches the ship's line costs a life
    if (e.y > INVADE_Y) {
      damagePlayer();
      killEnemy(i, false);
      continue;
    }
    // contact with the ship
    const pdx = e.x - player.x, pdy = e.y - player.y;
    const contactR = ENEMY_R + PLAYER_R - 4;
    if (pdx * pdx + pdy * pdy < contactR * contactR) {
      damagePlayer();
      killEnemy(i, false);
      continue;
    }
  }

  // ---- enemy fire ----
  enemyFireCd -= dt;
  if (enemyFireCd <= 0) {
    enemyFire();
    enemyFireCd = enemyFireInterval() * (0.55 + Math.random() * 0.9);
  }

  // ---- enemy bullets ----
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y > VH + 20) { releaseBullet(enemyBullets, i); continue; }
    const dx = b.x - player.x, dy = b.y - player.y;
    const r = PLAYER_R + 5;
    if (dx * dx + dy * dy < r * r) {
      releaseBullet(enemyBullets, i);
      damagePlayer();
    }
  }

  // ---- player bullets vs enemies ----
  outer:
  for (let i = playerBullets.length - 1; i >= 0; i--) {
    const b = playerBullets[i];
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (e.delay > 0 || e.y < -14) continue;
      const dx = b.x - e.x, dy = b.y - e.y;
      const r = ENEMY_R + 6;
      if (dx * dx + dy * dy < r * r) {
        killEnemy(j, true);
        releaseBullet(playerBullets, i);
        continue outer;
      }
    }
  }

  // ---- power-ups ----
  for (let i = powerups.length - 1; i >= 0; i--) {
    const pu = powerups[i];
    pu.y += POWERUP_FALL * dt;
    pu.x = pu.baseX + Math.sin(t * 2 + pu.phase) * 10;
    if (pu.y > VH + 26) { swapRemove(powerups, i); continue; }
    const dx = pu.x - player.x, dy = pu.y - player.y;
    const r = POWERUP_R + PLAYER_R;
    if (dx * dx + dy * dy < r * r) {
      applyPowerup(pu.type);
      swapRemove(powerups, i);
    }
  }

  updateParticles(dt);
  updateHud(false);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const BG_GRAD = ctx.createLinearGradient(0, 0, 0, VH);
BG_GRAD.addColorStop(0, '#060a1d');
BG_GRAD.addColorStop(0.55, '#0a1030');
BG_GRAD.addColorStop(1, '#0b0d22');

function drawBackground() {
  ctx.fillStyle = BG_GRAD;
  ctx.fillRect(0, 0, VW, VH);

  ctx.globalCompositeOperation = 'lighter';
  for (const n of nebulae) {
    const size = n.sprite.w;
    const y = ((n.y + t * n.speed) % (VH + size)) - size / 2;
    ctx.drawImage(n.sprite.c, n.x - size / 2, y - size / 2, size, size);
  }
  ctx.globalCompositeOperation = 'source-over';

  for (const layer of starLayers) {
    for (const st of layer.stars) {
      const y = (st.y + t * layer.speed) % VH;
      const tw = 0.55 + 0.45 * Math.sin(t * 2.2 + st.tw);
      ctx.globalAlpha = layer.alpha * tw;
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.arc(st.x, y, st.r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawFlame(x, y) {
  const flick = 0.75 + 0.25 * Math.sin(t * 34);
  const len = 15 * flick + Math.abs(player.tilt) * 4;
  ctx.globalCompositeOperation = 'lighter';
  for (const side of [-6, 6]) {
    ctx.fillStyle = 'rgba(56,189,248,.5)';
    ctx.beginPath();
    ctx.moveTo(x + side - 3, y);
    ctx.lineTo(x + side, y + len);
    ctx.lineTo(x + side + 3, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(224,242,254,.85)';
    ctx.beginPath();
    ctx.moveTo(x + side - 1.4, y);
    ctx.lineTo(x + side, y + len * 0.55);
    ctx.lineTo(x + side + 1.4, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawShip() {
  const blink = t < invUntil && Math.floor(t * 12) % 2 === 0 && state === 'playing';
  if (blink) return;
  const y = state === 'ready' ? player.y + Math.sin(t * 2) * 3 : player.y;
  drawFlame(player.x, y + 14);
  ctx.save();
  ctx.translate(player.x, y);
  ctx.rotate(player.tilt * 0.26);
  ctx.scale(1 - Math.abs(player.tilt) * 0.12, 1);
  ctx.drawImage(shipSprite.c, -shipSprite.w / 2, -shipSprite.h / 2, shipSprite.w, shipSprite.h);
  ctx.restore();
  if (shield) {
    const pulse = 0.55 + 0.25 * Math.sin(t * 5);
    ctx.strokeStyle = `rgba(52,211,153,${pulse})`;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(player.x, y, 27, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110,231,183,.2)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(player.x, y, 30, 0, TAU);
    ctx.stroke();
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.rect(0, 0, VW, VH);
  ctx.clip();

  if (shake > 0) {
    const m = shake * shake * 7;
    ctx.translate(Math.sin(t * 71) * m, Math.cos(t * 63) * m);
  }

  drawBackground();

  for (const pu of powerups) {
    const bob = 1 + 0.07 * Math.sin(t * 4 + pu.phase);
    const sp = powerupSprites[pu.type];
    ctx.drawImage(sp.c, pu.x - (sp.w * bob) / 2, pu.y - (sp.h * bob) / 2, sp.w * bob, sp.h * bob);
  }

  ctx.globalCompositeOperation = 'lighter';
  for (const b of enemyBullets) drawSprite(enemyBulletSprite, b.x, b.y);
  for (const b of playerBullets) drawSprite(laserSprite, b.x, b.y);
  ctx.globalCompositeOperation = 'source-over';

  for (const e of enemies) {
    if (e.delay > 0) continue;
    const sp = enemySprites[e.variant];
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(Math.sin(formT * 2 + e.phase) * 0.08);
    ctx.drawImage(sp.c, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
    ctx.restore();
  }

  drawParticles();
  if (state !== 'over' && state !== 'dying') drawShip();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastTs = null;
function frame(ts) {
  requestAnimationFrame(frame);
  if (document.hidden) { lastTs = null; return; }
  if (pause.active) { lastTs = null; return; }
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
const pause = installPause({
  canPause: () => state === 'playing',
  top: 62,                                    // below the lives row
});
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------
// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'playing' });

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
  VW, VH, TOUCH, PLAYER_MIN_Y, PLAYER_MAX_Y, DRAG_LIFT,
  get state() { return state; },
  get player() { return player; },
  get enemies() { return enemies; },
  get bullets() { return playerBullets; },
  get enemyBullets() { return enemyBullets; },
  get powerups() { return powerups; },
  get score() { return score; },
  get best() { return best; },
  get lives() { return lives; },
  get level() { return level; },
  get weapon() { return weapon; },
  get shield() { return shield; },
  get waveMode() { return waveMode; },
  start: () => { if (state === 'ready') startPlaying(); },
  restart: () => restart(),
  tick(dtMs, times = 1) { for (let i = 0; i < times; i++) update(dtMs / 1000); },
  setDir(d) { testDir = d; },
  setDirY(d) { testDirY = d; },
  setDrag(x) { dragX = x; },
  // raw finger position in world units (applies the DRAG_LIFT offset + clamp,
  // exactly like a real pointer event)
  setTarget(x, y) {
    dragX = x;
    dragY = y == null ? null : clamp(y - DRAG_LIFT, PLAYER_MIN_Y, PLAYER_MAX_Y);
  },
  // force one full hit (bypasses shield + mercy invincibility) — for tests
  hurt() { shield = false; invUntil = 0; damagePlayer(); },
  killAll() { for (let i = enemies.length - 1; i >= 0; i--) killEnemy(i, true); },
  spawnPowerup(type) {
    powerups.push({ type, x: player.x, baseX: player.x, y: player.y - 60, phase: 0 });
  },
};
