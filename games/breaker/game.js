import { installPause } from './pause.js';
// Breaker — a polished brick-breaker. Airplane Mode collection.
// Fully offline, canvas 2D. Sub-stepped swept physics so the ball never
// tunnels through bricks or the paddle; every glow is pre-rendered to a
// sprite once (no per-frame shadowBlur), so it holds 60fps on phones.

// ---------------------------------------------------------------------------
// Constants (world units: fixed 400×700 playfield, scaled to fit the screen)
// ---------------------------------------------------------------------------
const VW = 400, VH = 700;
const BEST_KEY = 'am.breaker.best';
const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;

const COLS = 8;
const CELL_W = 48, CELL_H = 24;
const BRICK_W = 44, BRICK_H = 20;
const GRID_X = (VW - COLS * CELL_W) / 2 + (CELL_W - BRICK_W) / 2;
const GRID_Y = 92;

const PADDLE_Y = 600;            // paddle center y — 100u of finger room below,
                                 // so a dragging thumb rests under the paddle,
                                 // not on it; the loss line stays at the bottom
const PADDLE_H = 13;
const PADDLE_W = 68;
const PADDLE_WIDE_W = 116;
const BALL_R = 6;
const STEP = 3.5;                // max physics substep (u) — < BALL_R, no tunneling
const MAX_BOUNCE = 1.08;         // rad from vertical off the paddle (~62°)
const MIN_VY = 0.22;             // min |dy| of the unit direction — never horizontal
const KEY_PADDLE_SPEED = 560;    // u/s while holding an arrow key
const SPEED_RAMP = 7;            // u/s gained per second within a level
const POWERUP_FALL = 150;        // u/s
const POWERUP_CHANCE = 0.13;
const WIDE_S = 10, SLOW_S = 8, SLOW_MUL = 0.62, HAMMER_S = 9;
const START_LIVES = 3, MAX_LIVES = 5;
const TRAIL_N = 10;
const BANNER_S = 1.35;

const ROW_COLORS = ['#f43f5e', '#f97316', '#fbbf24', '#a3e635', '#34d399', '#22d3ee', '#818cf8', '#c084fc'];
const ACCENT = '#f97316';

// Power-up definitions: color + icon painter (drawn once into a sprite).
const PU_W = 30, PU_H = 18;
const PU_TYPES = {
  wide: { color: '#38bdf8', weight: 0.32 },
  slow: { color: '#a78bfa', weight: 0.26 },
  multi: { color: '#f97316', weight: 0.28 },
  hammer: { color: '#fbbf24', weight: 0.2 },
  life: { color: '#f43f5e', weight: 0.14 },
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const stage = document.getElementById('stage');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const hudEl = document.getElementById('hud');
const scoreEl = document.getElementById('score');
const levelValueEl = document.getElementById('level-value');
const heartsEl = document.getElementById('hearts');
const bannerEl = document.getElementById('banner');
const serveHintEl = document.getElementById('serve-hint');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const startBestEl = document.getElementById('start-best');
const finalScoreEl = document.getElementById('final-score');
const bestScoreEl = document.getElementById('best-score');
const newBestEl = document.getElementById('new-best');
const restartBtn = document.getElementById('restart');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
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

// ---------------------------------------------------------------------------
// Canvas sizing (DPR-aware; playfield letterboxed + centered in the stage)
// ---------------------------------------------------------------------------
let dpr = 1, scale = 1, ox = 0, oy = 0, cw = 0, ch = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  cw = stage.clientWidth;
  ch = stage.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  scale = Math.min(cw / VW, ch / VH);
  ox = (cw - VW * scale) / 2;
  oy = (ch - VH * scale) / 2;
  // clamp the HUD to the playfield's horizontal extent
  hudEl.style.left = `${ox}px`;
  hudEl.style.right = `${ox}px`;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Pre-rendered sprites (glows baked in — no per-frame shadowBlur)
// ---------------------------------------------------------------------------
const SPR = 3; // sprite pixels per world unit
const spriteCache = new Map();

function makeSprite(key, wUnits, hUnits, paint) {
  let s = spriteCache.get(key);
  if (s) return s;
  const c = document.createElement('canvas');
  c.width = Math.ceil(wUnits * SPR);
  c.height = Math.ceil(hUnits * SPR);
  const g = c.getContext('2d');
  g.scale(SPR, SPR);
  paint(g);
  s = { c, w: wUnits, h: hUnits };
  spriteCache.set(key, s);
  return s;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Brick sprite: soft baked glow halo + gradient body + top sheen.
const BRICK_PAD = 9;
function brickSprite(color, kind, cracked) {
  const key = `brick|${color}|${kind}|${cracked ? 1 : 0}`;
  const W = BRICK_W + BRICK_PAD * 2, H = BRICK_H + BRICK_PAD * 2;
  return makeSprite(key, W, H, (g) => {
    const x = BRICK_PAD, y = BRICK_PAD;
    const metal = kind === 'm';
    // halo
    const halo = g.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W / 2);
    halo.addColorStop(0, metal ? 'rgba(148,163,184,.16)' : hexA(color, 0.30));
    halo.addColorStop(1, metal ? 'rgba(148,163,184,0)' : hexA(color, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);
    // body
    const grad = g.createLinearGradient(0, y, 0, y + BRICK_H);
    if (metal) {
      grad.addColorStop(0, '#94a3b8');
      grad.addColorStop(0.45, '#64748b');
      grad.addColorStop(1, '#334155');
    } else {
      grad.addColorStop(0, mix(color, '#ffffff', 0.28));
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, mix(color, '#000000', 0.32));
    }
    g.fillStyle = grad;
    roundRectPath(g, x, y, BRICK_W, BRICK_H, 5);
    g.fill();
    // top sheen
    g.fillStyle = 'rgba(255,255,255,.28)';
    roundRectPath(g, x + 2, y + 2, BRICK_W - 4, BRICK_H * 0.34, 3.5);
    g.fill();
    if (kind === 's' && !cracked) {
      // armored: inner outline signals "takes two hits"
      g.strokeStyle = 'rgba(255,255,255,.75)';
      g.lineWidth = 1.4;
      roundRectPath(g, x + 3, y + 3, BRICK_W - 6, BRICK_H - 6, 3);
      g.stroke();
    }
    if (metal) {
      // rivets
      g.fillStyle = 'rgba(15,23,42,.75)';
      for (const [rx, ry] of [[7, 6], [BRICK_W - 7, 6], [7, BRICK_H - 6], [BRICK_W - 7, BRICK_H - 6]]) {
        g.beginPath(); g.arc(x + rx, y + ry, 1.6, 0, TAU); g.fill();
      }
    }
    if (cracked) {
      g.strokeStyle = 'rgba(10,10,15,.6)';
      g.lineWidth = 1.3;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x + BRICK_W * 0.30, y + 1);
      g.lineTo(x + BRICK_W * 0.42, y + BRICK_H * 0.52);
      g.lineTo(x + BRICK_W * 0.30, y + BRICK_H - 1);
      g.moveTo(x + BRICK_W * 0.42, y + BRICK_H * 0.52);
      g.lineTo(x + BRICK_W * 0.62, y + BRICK_H * 0.38);
      g.moveTo(x + BRICK_W * 0.72, y + 2);
      g.lineTo(x + BRICK_W * 0.64, y + BRICK_H - 2);
      g.stroke();
    }
  });
}

function ballSprite() {
  const R = BALL_R, PAD = 12;
  const S = (R + PAD) * 2;
  return makeSprite('ball', S, S, (g) => {
    const c = S / 2;
    const glow = g.createRadialGradient(c, c, R * 0.4, c, c, c);
    glow.addColorStop(0, 'rgba(253,186,116,.85)');
    glow.addColorStop(0.35, 'rgba(249,115,22,.35)');
    glow.addColorStop(1, 'rgba(249,115,22,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, S, S);
    const body = g.createRadialGradient(c - R * 0.35, c - R * 0.4, R * 0.2, c, c, R);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.6, '#ffedd5');
    body.addColorStop(1, '#fdba74');
    g.fillStyle = body;
    g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
  });
}

function paddleGlowSprite() {
  const W = 160, H = 70;
  return makeSprite('paddle-glow', W, H, (g) => {
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(1, H / W);
    const glow = g.createRadialGradient(0, 0, 4, 0, 0, W / 2);
    glow.addColorStop(0, 'rgba(249,115,22,.5)');
    glow.addColorStop(0.5, 'rgba(249,115,22,.16)');
    glow.addColorStop(1, 'rgba(249,115,22,0)');
    g.fillStyle = glow;
    g.fillRect(-W / 2, -W / 2, W, W);
    g.restore();
  });
}

// The hammer capsule animates: a rainbow gradient slides across it. Frames are
// pre-rendered into the sprite cache (one small canvas per phase), so drawing
// stays a plain drawImage like every other sprite.
const HAMMER_FRAMES = 24;

function powerupSprite(type, frame = 0) {
  const def = PU_TYPES[type];
  const rainbow = type === 'hammer';
  const PAD = 9, W = PU_W + PAD * 2, H = PU_H + PAD * 2;
  return makeSprite(rainbow ? `pu|hammer|${frame}` : `pu|${type}`, W, H, (g) => {
    const x = PAD, y = PAD;
    const hue0 = (frame / HAMMER_FRAMES) * 360;
    const halo = g.createRadialGradient(W / 2, H / 2, 2, W / 2, H / 2, W / 2);
    halo.addColorStop(0, rainbow ? `hsla(${hue0}, 95%, 65%, .45)` : hexA(def.color, 0.45));
    halo.addColorStop(1, rainbow ? `hsla(${hue0}, 95%, 65%, 0)` : hexA(def.color, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);
    let grad;
    if (rainbow) {
      // full hue wheel across the capsule; advancing the frame slides it left
      grad = g.createLinearGradient(x, 0, x + PU_W, 0);
      for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${(hue0 + i * 60) % 360}, 95%, 62%)`);
    } else {
      grad = g.createLinearGradient(0, y, 0, y + PU_H);
      grad.addColorStop(0, mix(def.color, '#ffffff', 0.4));
      grad.addColorStop(0.5, def.color);
      grad.addColorStop(1, mix(def.color, '#000000', 0.3));
    }
    g.fillStyle = grad;
    roundRectPath(g, x, y, PU_W, PU_H, PU_H / 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,.35)';
    roundRectPath(g, x + 3, y + 2, PU_W - 6, PU_H * 0.34, 3);
    g.fill();
    // icon
    const cx = W / 2, cy = H / 2 + 0.5;
    g.strokeStyle = 'rgba(12,10,18,.9)';
    g.fillStyle = 'rgba(12,10,18,.9)';
    g.lineWidth = 1.8;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (type === 'wide') {
      g.beginPath();
      g.moveTo(cx - 8, cy); g.lineTo(cx + 8, cy);
      g.moveTo(cx - 5, cy - 3.5); g.lineTo(cx - 8.5, cy); g.lineTo(cx - 5, cy + 3.5);
      g.moveTo(cx + 5, cy - 3.5); g.lineTo(cx + 8.5, cy); g.lineTo(cx + 5, cy + 3.5);
      g.stroke();
    } else if (type === 'slow') {
      g.beginPath(); g.arc(cx, cy, 5.4, 0, TAU); g.stroke();
      g.beginPath(); g.moveTo(cx, cy - 3); g.lineTo(cx, cy); g.lineTo(cx + 2.6, cy + 1.6); g.stroke();
    } else if (type === 'multi') {
      for (const [dx, dy] of [[-5.5, 1.5], [0, -2.5], [5.5, 1.5]]) {
        g.beginPath(); g.arc(cx + dx, cy + dy, 2.6, 0, TAU); g.fill();
      }
    } else if (type === 'hammer') {
      g.save();
      g.translate(cx, cy);
      g.rotate(-0.55);
      roundRectPath(g, -5, -5.5, 10, 4.6, 1.4); // head
      g.fill();
      g.beginPath(); g.moveTo(0, -1.2); g.lineTo(0, 6); g.stroke(); // handle
      g.restore();
    } else if (type === 'life') {
      g.beginPath();
      g.moveTo(cx, cy + 4.6);
      g.bezierCurveTo(cx - 7.5, cy - 1.5, cx - 4.5, cy - 6.5, cx, cy - 2.8);
      g.bezierCurveTo(cx + 4.5, cy - 6.5, cx + 7.5, cy - 1.5, cx, cy + 4.6);
      g.fill();
    }
  });
}

function trailSprite() {
  const S = 16;
  return makeSprite('trail', S, S, (g) => {
    const glow = g.createRadialGradient(S / 2, S / 2, 0.5, S / 2, S / 2, S / 2);
    glow.addColorStop(0, 'rgba(253,186,116,.9)');
    glow.addColorStop(1, 'rgba(249,115,22,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, S, S);
  });
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function mix(hexColor, hex2, t) {
  const A = parseInt(hexColor.slice(1), 16), B = parseInt(hex2.slice(1), 16);
  const r = Math.round(lerp((A >> 16) & 255, (B >> 16) & 255, t));
  const g = Math.round(lerp((A >> 8) & 255, (B >> 8) & 255, t));
  const b = Math.round(lerp(A & 255, B & 255, t));
  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------------------
// Particle + pop pools (fixed size, no per-frame allocation)
// ---------------------------------------------------------------------------
const MAX_PARTICLES = 140;
const particles = Array.from({ length: MAX_PARTICLES }, () => ({ active: false }));

function burst(x, y, color, count, spread = 130) {
  let spawned = 0;
  for (let i = 0; i < particles.length && spawned < count; i++) {
    const p = particles[i];
    if (p.active) continue;
    const a = Math.random() * TAU;
    const spd = spread * (0.35 + Math.random());
    p.active = true;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * spd;
    p.vy = Math.sin(a) * spd - 30;
    p.life = 0;
    p.maxLife = 0.32 + Math.random() * 0.22;
    p.color = color;
    p.size = 1.8 + Math.random() * 2.4;
    spawned++;
  }
}

// Tiny rainbow glints shed by the falling hammer capsule — same pool as
// bursts, just gentler velocities and shorter lives.
function spawnSparkle(x, y) {
  for (const p of particles) {
    if (p.active) continue;
    const a = Math.random() * TAU;
    const spd = 12 + Math.random() * 32;
    p.active = true;
    p.x = x + (Math.random() * 2 - 1) * PU_W * 0.45;
    p.y = y + (Math.random() * 2 - 1) * PU_H * 0.5;
    p.vx = Math.cos(a) * spd;
    p.vy = Math.sin(a) * spd - 22;
    p.life = 0;
    p.maxLife = 0.28 + Math.random() * 0.24;
    p.color = `hsl(${Math.floor(Math.random() * 360)}, 95%, 70%)`;
    p.size = 0.9 + Math.random() * 1.4;
    return;
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.maxLife) { p.active = false; continue; }
    p.vy += 620 * dt;
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

// Brick "pop": the brick sprite scales up and fades over ~140ms.
const MAX_POPS = 16;
const pops = Array.from({ length: MAX_POPS }, () => ({ active: false }));

function addPop(x, y, spr) {
  for (const p of pops) {
    if (p.active) continue;
    p.active = true;
    p.x = x; p.y = y; p.spr = spr;
    p.life = 0; p.maxLife = 0.14;
    return;
  }
}

function updatePops(dt) {
  for (const p of pops) {
    if (!p.active) continue;
    p.life += dt;
    if (p.life >= p.maxLife) p.active = false;
  }
}

function drawPops() {
  for (const p of pops) {
    if (!p.active) continue;
    const t = p.life / p.maxLife;
    const s = 1 + t * 0.45;
    ctx.globalAlpha = 1 - t;
    ctx.drawImage(p.spr.c, p.x - (p.spr.w * s) / 2, p.y - (p.spr.h * s) / 2, p.spr.w * s, p.spr.h * s);
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Level layouts — cell kinds: '' none, 'n' normal, 's' strong, 'm' metal
// ---------------------------------------------------------------------------
function gridOf(rows, fn) {
  const g = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) row.push(fn(r, c) ? 'n' : '');
    g.push(row);
  }
  return g;
}

const LAYOUTS = [
  { name: 'solid', build: (lvl) => gridOf(Math.min(7, 5 + Math.floor((lvl - 1) / 6)), () => true) },
  { name: 'checker', build: () => gridOf(7, (r, c) => (r + c) % 2 === 0) },
  { name: 'pyramid', build: () => gridOf(7, (r, c) => Math.abs(c - 3.5) <= 3.5 - r * 0.5) },
  { name: 'lattice', build: () => gridOf(7, (r, c) => r % 2 === 0 || c % 2 === 0) },
  { name: 'diamond', build: () => gridOf(7, (r, c) => Math.abs(c - 3.5) + Math.abs(r - 3) <= 4) },
  { name: 'fortress', build: () => gridOf(7, () => true) },
];

function buildLevel(lvl) {
  const layout = LAYOUTS[(lvl - 1) % LAYOUTS.length];
  const grid = layout.build(lvl);
  const strongChance = Math.min(0.45, (lvl - 1) * 0.09);
  const metalOk = lvl >= 4;
  let metalBudget = metalOk ? Math.min(8, 2 + lvl) : 0;

  bricks = [];
  breakableLeft = 0;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!grid[r][c]) continue;
      let kind = 'n';
      // fortress walls its upper rows' edges with metal (later levels);
      // metal is always sparse + never a full row, so no brick is sealed off.
      if (layout.name === 'fortress' && metalOk && (c === 0 || c === COLS - 1) && r < 4 && metalBudget > 0) {
        kind = 'm'; metalBudget--;
      } else if (layout.name === 'lattice' && metalOk && r % 2 === 0 && c % 2 === 1 && r > 0 && metalBudget > 0 && Math.random() < 0.4) {
        kind = 'm'; metalBudget--;
      } else if (Math.random() < strongChance * (1 - (r / grid.length) * 0.5)) {
        kind = 's';
      }
      const brick = {
        c, r, kind,
        x: GRID_X + c * CELL_W,
        y: GRID_Y + r * CELL_H,
        hp: kind === 's' ? 2 : 1,
        color: ROW_COLORS[r % ROW_COLORS.length],
        flash: 0,
        alive: true,
      };
      bricks.push(brick);
      if (kind !== 'm') breakableLeft++;
    }
  }

  levelBaseSpeed = Math.min(480, 350 + (lvl - 1) * 18);
  levelSpeedCap = levelBaseSpeed + 130;
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
let state = 'ready'; // 'ready' | 'serve' | 'playing' | 'banner' | 'over'
let paddle, balls, bricks, powerups, breakableLeft;
let score, lives, level, best;
let levelBaseSpeed = 350, levelSpeedCap = 480;
let wideUntil = 0, slowUntil = 0, hammerUntil = 0;
let shake = 0;
let bannerUntil = 0;
let t = 0;
let scoreShown = -1, levelShown = -1, livesShown = -1;
let inputLeft = false, inputRight = false;

function makePaddle() {
  return { x: VW / 2, y: PADDLE_Y, w: PADDLE_W, targetW: PADDLE_W, h: PADDLE_H, flash: 0 };
}

function makeBall(x, y, speed) {
  const trail = [];
  for (let i = 0; i < TRAIL_N; i++) trail.push({ x, y });
  return { x, y, dx: 0, dy: -1, speed, lost: false, trail, ti: 0 };
}

function makePowerup(x, y, type) {
  return { x, y, type, phase: Math.random() * TAU, alive: true };
}

function pickPowerupType() {
  let total = 0;
  for (const k in PU_TYPES) total += PU_TYPES[k].weight;
  let r = Math.random() * total;
  for (const k in PU_TYPES) {
    r -= PU_TYPES[k].weight;
    if (r <= 0) return k;
  }
  return 'wide';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function newGame() {
  score = 0;
  lives = START_LIVES;
  level = 1;
  paddle = makePaddle();
  powerups = [];
  wideUntil = slowUntil = hammerUntil = 0;
  shake = 0;
  buildLevel(level);
  spawnServeBall();
  state = 'serve';
  showBanner('LEVEL 1');
  updateHUD();
}

function spawnServeBall() {
  balls = [makeBall(paddle.x, paddle.y - PADDLE_H / 2 - BALL_R - 1, levelBaseSpeed)];
}

function startGame() {
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  newGame();
}

function restart() {
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  hideBanner();
  newGame();
}

function launch() {
  if (state !== 'serve') return;
  const b = balls[0];
  const a = (Math.random() * 0.6 - 0.3); // slight random tilt off vertical
  b.dx = Math.sin(a);
  b.dy = -Math.cos(a);
  state = 'playing';
}

function gameOver() {
  state = 'over';
  finalScoreEl.textContent = fmt(score);
  const isNew = score > best;
  if (isNew) { best = score; saveBest(best); }
  bestScoreEl.textContent = fmt(best);
  newBestEl.hidden = !isNew;
  overOverlay.hidden = false;
}

function loseBall() {
  lives--;
  shake = 1;
  navigator.vibrate?.(10);
  powerups.length = 0;
  wideUntil = slowUntil = hammerUntil = 0;
  paddle.targetW = PADDLE_W;
  if (lives <= 0) {
    updateHUD();
    gameOver();
    return;
  }
  spawnServeBall();
  state = 'serve';
}

function beginBanner() {
  score += 50 * level;
  state = 'banner';
  bannerUntil = t + BANNER_S;
  balls.length = 0;
  powerups.length = 0;
  wideUntil = slowUntil = hammerUntil = 0;
  paddle.targetW = PADDLE_W;
  navigator.vibrate?.(10);
  showBanner(`LEVEL ${level + 1}`);
}

function advanceLevel() {
  level++;
  buildLevel(level);
  spawnServeBall();
  state = 'serve';
}

let bannerTimer = null;
function showBanner(text) {
  bannerEl.textContent = text;
  bannerEl.classList.add('show');
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 1600);
}
function hideBanner() {
  bannerEl.classList.remove('show');
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const HEART_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 21c-4.8-3.7-9-7-9-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 4-4.2 7.3-9 11Z" fill="currentColor"/></svg>';
const heartSpans = [];
for (let i = 0; i < MAX_LIVES; i++) {
  const s = document.createElement('span');
  s.className = 'heart';
  s.innerHTML = HEART_SVG;
  heartsEl.appendChild(s);
  heartSpans.push(s);
}

function updateHUD() {
  if (score !== scoreShown) { scoreEl.textContent = fmt(score); scoreShown = score; }
  if (level !== levelShown) { levelValueEl.textContent = String(level); levelShown = level; }
  if (lives !== livesShown) {
    const slots = Math.max(START_LIVES, lives);
    for (let i = 0; i < MAX_LIVES; i++) {
      heartSpans[i].hidden = i >= slots;
      heartSpans[i].classList.toggle('off', i >= lives);
    }
    livesShown = lives;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function movePaddleTo(x) {
  paddle.x = clamp(x, paddle.w / 2, VW - paddle.w / 2);
}

function worldX(clientX) {
  const rect = canvas.getBoundingClientRect();
  return (clientX - rect.left - ox) / scale;
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) { inputLeft = true; e.preventDefault(); }
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) { inputRight = true; e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') startGame();
    else if (state === 'serve') launch();
    else if (state === 'over') restart();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    if (state !== 'ready') restart();
  }
});
window.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'a', 'A'].includes(e.key)) inputLeft = false;
  else if (['ArrowRight', 'd', 'D'].includes(e.key)) inputRight = false;
});

let ptrId = null, ptrMoved = 0, ptrLastX = 0;
stage.addEventListener('pointerdown', (e) => {
  if (state === 'ready') { startGame(); return; }
  if (state === 'over') { restart(); return; }
  ptrId = e.pointerId;
  ptrMoved = 0;
  ptrLastX = e.clientX;
  movePaddleTo(worldX(e.clientX));
});
stage.addEventListener('pointermove', (e) => {
  if (ptrId !== e.pointerId) return;
  ptrMoved += Math.abs(e.clientX - ptrLastX);
  ptrLastX = e.clientX;
  movePaddleTo(worldX(e.clientX));
});
function endPointer(e) {
  if (ptrId !== e.pointerId) return;
  ptrId = null;
  // a tap (not a drag) while serving launches the ball
  if (state === 'serve' && ptrMoved < 14) launch();
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', (e) => { if (ptrId === e.pointerId) ptrId = null; });
stage.addEventListener('dblclick', (e) => e.preventDefault());
stage.addEventListener('contextmenu', (e) => e.preventDefault());

restartBtn.addEventListener('click', restart);

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
function clampDir(b) {
  const len = Math.hypot(b.dx, b.dy) || 1;
  b.dx /= len; b.dy /= len;
  if (Math.abs(b.dy) < MIN_VY) {
    const sy = b.dy === 0 ? -1 : Math.sign(b.dy);
    const sx = b.dx === 0 ? 1 : Math.sign(b.dx);
    b.dy = sy * MIN_VY;
    b.dx = sx * Math.sqrt(1 - MIN_VY * MIN_VY);
  }
}

function collideWalls(b) {
  if (b.x < BALL_R && b.dx < 0) { b.x = BALL_R; b.dx = -b.dx; }
  else if (b.x > VW - BALL_R && b.dx > 0) { b.x = VW - BALL_R; b.dx = -b.dx; }
  if (b.y < BALL_R && b.dy < 0) { b.y = BALL_R; b.dy = -b.dy; clampDir(b); }
}

function collidePaddle(b) {
  if (b.dy <= 0) return; // only when falling
  const hw = paddle.w / 2, hh = paddle.h / 2;
  const nx = clamp(b.x, paddle.x - hw, paddle.x + hw);
  const ny = clamp(b.y, paddle.y - hh, paddle.y + hh);
  const dx = b.x - nx, dy = b.y - ny;
  if (dx * dx + dy * dy > BALL_R * BALL_R) return;
  // where the ball leaves the paddle sets the bounce angle:
  // center → steep, edges → sharp
  const rel = clamp((b.x - paddle.x) / (hw + BALL_R * 0.5), -1, 1);
  const a = rel * MAX_BOUNCE;
  b.dx = Math.sin(a);
  b.dy = -Math.cos(a);
  b.y = paddle.y - hh - BALL_R - 0.5;
  paddle.flash = 1;
  clampDir(b);
}

function collideBricks(b) {
  // one brick per substep keeps corner hits stable
  for (const br of bricks) {
    if (!br.alive) continue;
    if (Math.abs(b.x - (br.x + BRICK_W / 2)) > BRICK_W / 2 + BALL_R + 1) continue;
    if (Math.abs(b.y - (br.y + BRICK_H / 2)) > BRICK_H / 2 + BALL_R + 1) continue;
    const nx = clamp(b.x, br.x, br.x + BRICK_W);
    const ny = clamp(b.y, br.y, br.y + BRICK_H);
    let dx = b.x - nx, dy = b.y - ny;
    let len = Math.hypot(dx, dy);
    if (len > BALL_R) continue;
    if (len === 0) { dx = 0; dy = b.dy > 0 ? -1 : 1; len = 1; } // center inside: reflect vertically
    const nxu = dx / len, nyu = dy / len;
    const vDotN = b.dx * nxu + b.dy * nyu;
    if (vDotN < 0) {
      b.dx -= 2 * vDotN * nxu;
      b.dy -= 2 * vDotN * nyu;
      clampDir(b);
    }
    // push out of penetration
    b.x = nx + nxu * (BALL_R + 0.5);
    b.y = ny + nyu * (BALL_R + 0.5);
    hitBrick(br);
    return;
  }
}

function hitBrick(br) {
  const cx = br.x + BRICK_W / 2, cy = br.y + BRICK_H / 2;
  if (br.kind === 'm') {
    br.flash = 1;
    burst(cx, cy, '#cbd5e1', 4, 80);
    return;
  }
  br.hp--;
  if (br.kind === 's' && t < hammerUntil) br.hp = 0; // hammer smashes armored bricks in one hit
  br.flash = 1;
  score += 10;
  if (br.hp <= 0) destroyBrick(br, cx, cy);
}

function destroyBrick(br, cx, cy) {
  if (!br.alive || br.kind === 'm') return;
  br.alive = false;
  breakableLeft--;
  if (br.kind === 's') score += 15;
  burst(cx, cy, br.color, 12);
  addPop(cx, cy, brickSprite(br.color, br.kind, false));
  if (Math.random() < POWERUP_CHANCE && powerups.length < 3 && state === 'playing') {
    powerups.push(makePowerup(cx, cy, pickPowerupType()));
  }
  if (breakableLeft <= 0 && (state === 'playing' || state === 'serve')) beginBanner();
}

function moveBall(b, dt) {
  const slowMul = t < slowUntil ? SLOW_MUL : 1;
  let remaining = b.speed * slowMul * dt;
  while (remaining > 0) {
    const step = Math.min(STEP, remaining);
    remaining -= step;
    b.x += b.dx * step;
    b.y += b.dy * step;
    collideWalls(b);
    collidePaddle(b);
    collideBricks(b);
    if (state !== 'playing') return; // level cleared mid-flight
    if (b.y - BALL_R > VH + 20) { b.lost = true; return; }
  }
}

// ---------------------------------------------------------------------------
// Powerups
// ---------------------------------------------------------------------------
function applyPowerup(type) {
  score += 25;
  paddle.flash = 1;
  navigator.vibrate?.(10);
  if (type === 'hammer') {
    for (let i = 0; i < 4; i++) burst(paddle.x, paddle.y - 10, `hsl(${i * 90}, 95%, 65%)`, 4, 110);
  } else {
    burst(paddle.x, paddle.y - 10, PU_TYPES[type].color, 12, 110);
  }
  if (type === 'wide') {
    wideUntil = t + WIDE_S;
    paddle.targetW = PADDLE_WIDE_W;
  } else if (type === 'slow') {
    slowUntil = t + SLOW_S;
  } else if (type === 'hammer') {
    hammerUntil = t + HAMMER_S;
  } else if (type === 'multi') {
    const src = balls[0];
    if (src) {
      for (const da of [-0.5, 0.5]) {
        const nb = makeBall(src.x, src.y, src.speed);
        const a = Math.atan2(src.dx, -src.dy) + da;
        nb.dx = Math.sin(a);
        nb.dy = -Math.cos(a);
        clampDir(nb);
        balls.push(nb);
      }
    }
  } else if (type === 'life') {
    lives = Math.min(MAX_LIVES, lives + 1);
  }
}

function updatePowerups(dt) {
  for (const pu of powerups) {
    if (!pu.alive) continue;
    pu.y += POWERUP_FALL * dt;
    if (pu.type === 'hammer') {
      pu.sparkleT = (pu.sparkleT || 0) - dt;
      if (pu.sparkleT <= 0) { spawnSparkle(pu.x, pu.y); pu.sparkleT = 0.05; }
    }
    const hw = paddle.w / 2 + 4, hh = paddle.h / 2 + 4;
    if (pu.y + PU_H / 2 > paddle.y - hh && pu.y - PU_H / 2 < paddle.y + hh &&
        pu.x + PU_W / 2 > paddle.x - hw && pu.x - PU_W / 2 < paddle.x + hw) {
      pu.alive = false;
      applyPowerup(pu.type);
    } else if (pu.y - PU_H > VH) {
      pu.alive = false;
    }
  }
  for (let i = powerups.length - 1; i >= 0; i--) if (!powerups[i].alive) powerups.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Update (pure logic — used by both the rAF loop and tests via tick())
// ---------------------------------------------------------------------------
function update(dt) {
  t += dt;
  if (shake > 0) shake = Math.max(0, shake - dt * 3.2);

  updateParticles(dt);
  updatePops(dt);

  if (state === 'ready' || state === 'over') return;

  // paddle: keyboard steering + width animation + effect expiry
  const dir = (inputLeft && !inputRight) ? -1 : (inputRight && !inputLeft) ? 1 : 0;
  if (dir !== 0) movePaddleTo(paddle.x + dir * KEY_PADDLE_SPEED * dt);
  if (t >= wideUntil && paddle.targetW !== PADDLE_W) paddle.targetW = PADDLE_W;
  paddle.w = lerp(paddle.w, paddle.targetW, Math.min(1, dt * 8));
  movePaddleTo(paddle.x); // re-clamp after width change
  if (paddle.flash > 0) paddle.flash = Math.max(0, paddle.flash - dt * 4);
  for (const br of bricks) if (br.flash > 0) br.flash = Math.max(0, br.flash - dt * 6);

  if (state === 'banner') {
    if (t >= bannerUntil) advanceLevel();
    updateHUD();
    return;
  }

  if (state === 'serve') {
    // ball docked on the paddle, gently pulsing
    const b = balls[0];
    if (b) {
      b.x = paddle.x;
      b.y = paddle.y - PADDLE_H / 2 - BALL_R - 1;
    }
    serveHintEl.classList.add('show');
    updateHUD();
    return;
  }
  serveHintEl.classList.remove('show');

  // playing: speed ramp + ball physics + trails
  for (const b of balls) {
    b.speed = Math.min(b.speed + SPEED_RAMP * dt, levelSpeedCap);
    moveBall(b, dt);
    const tr = b.trail[b.ti];
    tr.x = b.x; tr.y = b.y;
    b.ti = (b.ti + 1) % TRAIL_N;
    if (state !== 'playing') { serveHintEl.classList.remove('show'); updateHUD(); return; }
  }
  for (let i = balls.length - 1; i >= 0; i--) if (balls[i].lost) balls.splice(i, 1);
  if (balls.length === 0) loseBall();

  if (state === 'playing') updatePowerups(dt);
  updateHUD();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let fieldGrad = null, glowGrad = null, wallGrad = null, vignetteGrad = null;

function initGradients() {
  fieldGrad = ctx.createLinearGradient(0, 0, 0, VH);
  fieldGrad.addColorStop(0, '#100c16');
  fieldGrad.addColorStop(0.45, '#0c0a12');
  fieldGrad.addColorStop(1, '#0a0a0f');

  glowGrad = ctx.createRadialGradient(VW / 2, GRID_Y + 70, 20, VW / 2, GRID_Y + 70, 320);
  glowGrad.addColorStop(0, 'rgba(249,115,22,.07)');
  glowGrad.addColorStop(1, 'rgba(249,115,22,0)');

  wallGrad = ctx.createLinearGradient(0, 0, 0, VH);
  wallGrad.addColorStop(0, 'rgba(249,115,22,.4)');
  wallGrad.addColorStop(0.4, 'rgba(249,115,22,.14)');
  wallGrad.addColorStop(1, 'rgba(249,115,22,.05)');

  vignetteGrad = ctx.createRadialGradient(VW / 2, VH * 0.5, VH * 0.35, VW / 2, VH * 0.5, VH * 0.8);
  vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vignetteGrad.addColorStop(1, 'rgba(0,0,0,.34)');
}

function drawBricks() {
  for (const br of bricks) {
    if (!br.alive) continue;
    const cracked = br.kind === 's' && br.hp === 1;
    const spr = brickSprite(br.color, br.kind, cracked);
    const cx = br.x + BRICK_W / 2, cy = br.y + BRICK_H / 2;
    ctx.drawImage(spr.c, cx - spr.w / 2, cy - spr.h / 2, spr.w, spr.h);
    if (br.flash > 0) {
      ctx.globalAlpha = br.flash * 0.55;
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, br.x, br.y, BRICK_W, BRICK_H, 5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function drawPaddle() {
  const glow = paddleGlowSprite();
  const gw = paddle.w * 1.9, gh = 58;
  ctx.globalAlpha = 0.75 + paddle.flash * 0.25;
  ctx.drawImage(glow.c, paddle.x - gw / 2, paddle.y - gh / 2, gw, gh);
  ctx.globalAlpha = 1;

  const hw = paddle.w / 2, hh = paddle.h / 2;
  const grad = ctx.createLinearGradient(0, paddle.y - hh, 0, paddle.y + hh);
  const lift = paddle.flash * 0.5;
  grad.addColorStop(0, mix('#fdba74', '#ffffff', 0.25 + lift));
  grad.addColorStop(0.45, '#f97316');
  grad.addColorStop(1, '#c2410c');
  ctx.fillStyle = grad;
  roundRectPath(ctx, paddle.x - hw, paddle.y - hh, paddle.w, paddle.h, hh);
  ctx.fill();
  // sheen
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  roundRectPath(ctx, paddle.x - hw + 3, paddle.y - hh + 2, paddle.w - 6, paddle.h * 0.32, 3);
  ctx.fill();
}

function drawBalls() {
  const spr = ballSprite();
  const trSpr = trailSprite();
  const slowActive = t < slowUntil;
  const showTrail = state === 'playing';
  for (const b of balls) {
    // trail: oldest → newest
    for (let i = 0; showTrail && i < TRAIL_N; i++) {
      const idx = (b.ti + i) % TRAIL_N;
      const p = b.trail[idx];
      const a = (i / TRAIL_N) * 0.34;
      const s = 4 + (i / TRAIL_N) * 9;
      ctx.globalAlpha = a;
      if (slowActive) {
        ctx.fillStyle = '#a78bfa';
        ctx.beginPath(); ctx.arc(p.x, p.y, s * 0.35, 0, TAU); ctx.fill();
      } else {
        ctx.drawImage(trSpr.c, p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    let pulse = 1;
    if (state === 'serve') pulse = 1 + Math.sin(t * 5) * 0.08;
    const s = spr.w * pulse;
    ctx.drawImage(spr.c, b.x - s / 2, b.y - s / 2, s, s);
  }
}

function drawPowerups() {
  const hammerFrame = Math.floor(t * 18) % HAMMER_FRAMES;
  for (const pu of powerups) {
    const spr = powerupSprite(pu.type, hammerFrame);
    ctx.save();
    ctx.translate(pu.x, pu.y);
    ctx.rotate(Math.sin(t * 3 + pu.phase) * 0.14);
    ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h);
    ctx.restore();
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // letterbox: darker than the field so the playfield reads as a surface
  ctx.fillStyle = '#060609';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.rect(0, 0, VW, VH);
  ctx.clip();

  if (!fieldGrad) initGradients();
  ctx.fillStyle = fieldGrad;
  ctx.fillRect(0, 0, VW, VH);
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, VW, VH);

  // screen shake (world only — HUD stays put)
  if (shake > 0) {
    const m = shake * shake * 7;
    ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
  }

  // walls
  ctx.fillStyle = wallGrad;
  ctx.fillRect(0, 0, 2, VH);
  ctx.fillRect(VW - 2, 0, 2, VH);
  ctx.fillRect(0, 0, VW, 2);

  drawBricks();
  drawPops();
  drawPowerups();
  if (state !== 'over') drawBalls();
  drawPaddle();
  drawParticles();

  ctx.fillStyle = vignetteGrad;
  ctx.fillRect(0, 0, VW, VH);
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
startBestEl.textContent = fmt(best);
paddle = makePaddle();
balls = [];
bricks = [];
powerups = [];
score = 0; lives = START_LIVES; level = 1; breakableLeft = 0;
buildLevel(1); // pretty backdrop behind the start overlay
resize();
updateHUD();
const pause = installPause({
  canPause: () => state === 'playing' || state === 'serve',
  top: 48,                                    // below the score / hearts row
});
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
  VW, VH, BALL_R, BRICK_W, BRICK_H, TOUCH,
  get state() { return state; },
  get paddle() { return paddle; },
  get balls() { return balls; },
  get bricks() { return bricks; },
  get powerups() { return powerups; },
  get score() { return score; },
  get lives() { return lives; },
  get level() { return level; },
  get best() { return best; },
  get breakableLeft() { return breakableLeft; },
  start() { if (state === 'ready') startGame(); },
  restart() { restart(); },
  launch() { launch(); },
  tick(dtMs, times = 1) { for (let i = 0; i < times; i++) update(dtMs / 1000); },
  setPaddleX(x) { movePaddleTo(x); },
  setBall(partial) { if (balls[0]) Object.assign(balls[0], partial); },
  setLives(n) { lives = n; updateHUD(); },
  loseAllBalls() { for (const b of balls) { b.y = VH + 100; b.lost = true; } },
  smashAllBricks() {
    for (const br of bricks) {
      if (br.alive && br.kind !== 'm') destroyBrick(br, br.x + BRICK_W / 2, br.y + BRICK_H / 2);
    }
  },
  spawnPowerup(type) {
    const pu = makePowerup(paddle.x, paddle.y - 100, type);
    powerups.push(pu);
    return pu;
  },
};
