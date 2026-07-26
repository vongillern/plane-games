import { installPause } from './pause.js';
import { installUpdates } from './update.js';
import { installPrompt } from './install.js';
// Snake — offline PWA. Vanilla ES module.
// The differentiator: the snake steps on a fixed grid timer but every frame
// interpolates between grid cells, so the body glides as one continuous ribbon.

const GRID = 17;
const BEST_KEY = 'am.snake.best';

// Same media condition as the .if-touch/.if-key CSS hint rules.
const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;

// Speed ramp (cells per second) — gentle acceleration as the snake grows.
const SPEED_MIN = 7.5;
const SPEED_MAX = 13;
const SPEED_PER_CELL = 0.22;
const START_LEN = 3;

// Bonus food.
const BONUS_EVERY = 5;     // every 5th food is a bonus
const BONUS_MS = 6000;     // lifetime before it expires
const BONUS_SCORE = 3;

const DYING_MS = 240;      // death animation before the game-over overlay

// Palette.
const CELL_A = '#0c1913';
const CELL_B = '#0e1f18';
const SNAKE = '#34d399';
const SNAKE_GLOSS = 'rgba(167, 243, 208, .55)';
const SNAKE_GLOW = 'rgba(52, 211, 153, .45)';
const DEAD_COL = '#ef4444';
const DEAD_GLOSS = 'rgba(255, 180, 180, .5)';
const FOOD_COL = '#34d399';
const BONUS_COL = '#fbbf24';

// ---- DOM ------------------------------------------------------------------
const boardEl = document.getElementById('board');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const overlayEl = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub = document.getElementById('overlay-sub');
const overlayHint = document.getElementById('overlay-hint');

// ---- Canvas sizing (devicePixelRatio-aware) -------------------------------
let boardPx = 0;
let cell = 0;
let dpr = 1;

function sizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  boardPx = canvas.clientWidth;
  canvas.width = Math.round(boardPx * dpr);
  canvas.height = Math.round(boardPx * dpr);
  cell = boardPx / GRID;
}

window.addEventListener('resize', sizeCanvas);

// ---- State ----------------------------------------------------------------
const DIRS = {
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

let state;          // 'ready' | 'playing' | 'dying' | 'dead'
let body;           // array of {x,y}, head first
let dir;            // current direction vector
let dirQueue;       // up to 2 queued turns
let growing;        // freeze the tail this interval (predicted eat)
let food;           // {x, y, bonus, born}
let foodSpawnCount; // how many foods have appeared (drives bonus cadence)
let score;
let best;
let acc;            // ms accumulated toward the next step
let lastTs;         // previous frame timestamp
let deadAt;         // performance.now() when death occurred
let bursts;         // eat effects

// ---- Helpers --------------------------------------------------------------
function loadBest() {
  const raw = localStorage.getItem(BEST_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function saveBest() {
  try { localStorage.setItem(BEST_KEY, String(best)); } catch (_) {}
}

function speed() {
  return Math.min(SPEED_MAX, SPEED_MIN + (body.length - START_LEN) * SPEED_PER_CELL);
}

function stepInterval() {
  return 1000 / speed();
}

const lerp = (a, b, t) => a + (b - a) * t;

// ---- Food -----------------------------------------------------------------
function placeFood(bonus) {
  const occupied = new Set(body.map((s) => s.x + ',' + s.y));
  const free = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++)
      if (!occupied.has(x + ',' + y)) free.push({ x, y });
  if (!free.length) { food = null; return; } // board full — nothing left to place
  const spot = free[(Math.random() * free.length) | 0];
  food = { x: spot.x, y: spot.y, bonus, born: performance.now() };
}

function spawnNextFood() {
  foodSpawnCount++;
  placeFood(foodSpawnCount % BONUS_EVERY === 0);
}

// ---- Eat bursts -----------------------------------------------------------
function addBurst(x, y, color) {
  bursts.push({ x, y, color, born: performance.now() });
}

// ---- Score ----------------------------------------------------------------
function bumpScore(n) {
  score += n;
  scoreEl.textContent = score;
  if (score > best) {
    best = score;
    bestEl.textContent = best;
    saveBest();
  }
}

// ---- Direction input ------------------------------------------------------
function enqueue(nd) {
  // reference = the last turn already queued, else the current direction
  const ref = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
  if (nd.x === -ref.x && nd.y === -ref.y) return; // ignore 180° reversal
  if (nd.x === ref.x && nd.y === ref.y) return;   // ignore no-op
  if (dirQueue.length < 2) dirQueue.push(nd);      // 2-deep queue
}

// ---- Simulation step ------------------------------------------------------
function step() {
  if (dirQueue.length) dir = dirQueue.shift();

  const nx = body[0].x + dir.x;
  const ny = body[0].y + dir.y;

  // wall collision
  if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) return die();
  // self collision (the tail cell vacates this step, so it's excluded)
  for (let i = 0; i < body.length - 1; i++)
    if (body[i].x === nx && body[i].y === ny) return die();

  const ate = food && food.x === nx && food.y === ny;

  body.unshift({ x: nx, y: ny });

  if (ate) {
    const bonus = food.bonus;
    bumpScore(bonus ? BONUS_SCORE : 1);
    addBurst(nx, ny, bonus ? BONUS_COL : FOOD_COL);
    navigator.vibrate?.(10);
    spawnNextFood();
    // grow: keep the tail this step
  } else {
    body.pop();
  }

  // Predict whether the NEXT step eats, so we can freeze the tail across the
  // upcoming interval and keep the ribbon continuous while it grows.
  const peek = dirQueue.length ? dirQueue[0] : dir;
  growing = !!food && food.x === body[0].x + peek.x && food.y === body[0].y + peek.y;
}

function die() {
  state = 'dying';
  deadAt = performance.now();
  navigator.vibrate?.(30);
}

// ---- Rendering ------------------------------------------------------------
const cx = (gx) => (gx + 0.5) * cell;

function drawBoard() {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      ctx.fillStyle = (x + y) & 1 ? CELL_B : CELL_A;
      ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
    }
  }
}

function drawFood(ts) {
  if (!food) return;
  const fx = cx(food.x);
  const fy = cx(food.y);
  const color = food.bonus ? BONUS_COL : FOOD_COL;

  // gentle idle pulse
  const pulse = 0.5 + 0.5 * Math.sin(ts / 320);
  const core = cell * (food.bonus ? 0.30 : 0.26) * (1 + pulse * 0.10);
  const glowR = cell * (food.bonus ? 1.15 : 0.95);

  // soft radial glow
  const g = ctx.createRadialGradient(fx, fy, core * 0.3, fx, fy, glowR);
  g.addColorStop(0, food.bonus ? 'rgba(251,191,36,.55)' : 'rgba(52,211,153,.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(fx, fy, glowR, 0, Math.PI * 2);
  ctx.fill();

  // core dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(fx, fy, core, 0, Math.PI * 2);
  ctx.fill();

  // highlight
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.beginPath();
  ctx.arc(fx - core * 0.3, fy - core * 0.3, core * 0.32, 0, Math.PI * 2);
  ctx.fill();

  // bonus: shrinking ring timer
  if (food.bonus) {
    const remain = 1 - Math.min(1, (ts - food.born) / BONUS_MS);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, cell * 0.07);
    ctx.beginPath();
    ctx.arc(fx, fy, cell * 0.44, -Math.PI / 2, -Math.PI / 2 + remain * Math.PI * 2);
    ctx.stroke();
  }
}

function drawBursts(ts) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    const p = (ts - b.born) / 380;
    if (p >= 1) { bursts.splice(i, 1); continue; }
    const r = cell * (0.25 + p * 0.75);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = (1 - p) * 0.8;
    ctx.lineWidth = cell * 0.12 * (1 - p) + 1;
    ctx.beginPath();
    ctx.arc(cx(b.x), cx(b.y), r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function snakePoints() {
  // Build the continuous fractional path: head tip -> body centers -> tail tip.
  const t = state === 'playing' ? Math.min(1, acc / stepInterval()) : 0;
  const last = body.length - 1;
  const pts = [];

  // head extends toward the next cell
  pts.push({ x: body[0].x + dir.x * t, y: body[0].y + dir.y * t });
  for (let i = 0; i < last; i++) pts.push({ x: body[i].x, y: body[i].y });

  // tail retracts (unless growing this interval, when it stays put)
  if (growing || last < 1) {
    pts.push({ x: body[last].x, y: body[last].y });
  } else {
    pts.push({
      x: lerp(body[last].x, body[last - 1].x, t),
      y: lerp(body[last].y, body[last - 1].y, t),
    });
  }
  return pts;
}

function drawSnake() {
  const dead = state === 'dying' || state === 'dead';
  const pts = snakePoints();
  const w = cell * 0.66;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ribbon body path
  ctx.beginPath();
  ctx.moveTo(cx(pts[0].x), cx(pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(cx(pts[i].x), cx(pts[i].y));

  // glow underlay
  ctx.shadowBlur = dead ? 0 : cell * 0.5;
  ctx.shadowColor = SNAKE_GLOW;
  ctx.strokeStyle = dead ? DEAD_COL : SNAKE;
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // head — slightly wider than the body
  const hp = { x: cx(pts[0].x), y: cx(pts[0].y) };
  ctx.fillStyle = dead ? DEAD_COL : SNAKE;
  ctx.beginPath();
  ctx.arc(hp.x, hp.y, w * 0.6, 0, Math.PI * 2);
  ctx.fill();

  // gloss highlight down the ribbon
  ctx.strokeStyle = dead ? DEAD_GLOSS : SNAKE_GLOSS;
  ctx.lineWidth = w * 0.34;
  ctx.stroke();

  // eyes, looking in the travel direction
  const perp = { x: -dir.y, y: dir.x };
  const eo = w * 0.22;   // sideways offset
  const ef = w * 0.05;   // forward offset
  const eyeR = w * 0.17;
  const pupilR = w * 0.09;
  for (const s of [1, -1]) {
    const ex = hp.x + perp.x * eo * s + dir.x * ef;
    const ey = hp.y + perp.y * eo * s + dir.y * ef;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dead ? '#7f1d1d' : '#04150e';
    ctx.beginPath();
    ctx.arc(ex + dir.x * eyeR * 0.45, ey + dir.y * eyeR * 0.45, pupilR, 0, Math.PI * 2);
    ctx.fill();
  }
}

function render(ts) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boardPx, boardPx);
  ctx.save();

  // death screen shake
  if (state === 'dying') {
    const p = (ts - deadAt) / DYING_MS;
    const mag = (1 - p) * cell * 0.28;
    ctx.translate((Math.random() - 0.5) * mag, (Math.random() - 0.5) * mag);
  }

  drawBoard();
  drawFood(ts);
  drawBursts(ts);
  drawSnake();
  ctx.restore();

  // red flash on death
  if (state === 'dying') {
    const p = (ts - deadAt) / DYING_MS;
    ctx.fillStyle = `rgba(239,68,68,${(1 - p) * 0.22})`;
    ctx.fillRect(0, 0, boardPx, boardPx);
  }
}

// ---- Main loop ------------------------------------------------------------
function frame(ts) {
  requestAnimationFrame(frame);
  if (pause.active) { lastTs = null; return; }

  if (lastTs == null) lastTs = ts;
  let dt = ts - lastTs;
  lastTs = ts;
  if (dt > 100) dt = 100; // clamp after tab switches / stalls

  if (state === 'playing') {
    acc += dt;
    let guard = 0;
    while (acc >= stepInterval() && state === 'playing' && guard++ < 8) {
      acc -= stepInterval();
      step();
    }
    if (food && food.bonus && ts - food.born > BONUS_MS) placeFood(false);
  } else if (state === 'dying') {
    if (ts - deadAt > DYING_MS) { state = 'dead'; showGameOver(); }
  }

  render(ts);
}

// ---- Overlay --------------------------------------------------------------
function showOverlay(title, sub, hint) {
  overlayTitle.textContent = title;
  overlaySub.textContent = sub;
  overlayHint.textContent = hint;
  overlayEl.hidden = false;
}

function hideOverlay() {
  overlayEl.hidden = true;
}

function showStart() {
  showOverlay('Snake',
    TOUCH ? 'swipe to steer' : 'arrow keys to steer',
    TOUCH ? 'tap to start' : 'press Space to start');
}

function showGameOver() {
  showOverlay('Game over', `Score ${score}  ·  Best ${best}`,
    TOUCH ? 'tap to play again' : 'press Space to play again');
}

// ---- Lifecycle ------------------------------------------------------------
function reset() {
  const mid = (GRID / 2) | 0;
  body = [];
  for (let i = 0; i < START_LEN; i++) body.push({ x: mid - i, y: mid });
  dir = DIRS.right;
  dirQueue = [];
  growing = false;
  bursts = [];
  score = 0;
  scoreEl.textContent = 0;
  acc = 0;
  lastTs = null;
  foodSpawnCount = 0;
  placeFood(false);
  state = 'ready';
  showStart();
}

function startPlaying() {
  hideOverlay();
  acc = 0;
  lastTs = null;
  state = 'playing';
}

function restart() {
  reset();
  startPlaying();
}

// ---- Input: keyboard ------------------------------------------------------
const KEY_DIRS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const name = KEY_DIRS[e.key];
  if (name) {
    e.preventDefault();
    if (state === 'ready') startPlaying();
    if (state === 'playing') enqueue(DIRS[name]);
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'ready') startPlaying();
    else if (state === 'dead') restart();
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    restart();
  }
});

// ---- Input: pointer swipe -------------------------------------------------
let ptr = null;
const SWIPE_MIN = 20;

boardEl.addEventListener('pointerdown', (e) => {
  ptr = { id: e.pointerId, x: e.clientX, y: e.clientY };
});

boardEl.addEventListener('pointermove', (e) => {
  if (ptr && e.pointerId === ptr.id) e.preventDefault();
});

function endSwipe(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x;
  const dy = e.clientY - ptr.y;
  ptr = null;

  const adx = Math.abs(dx), ady = Math.abs(dy);
  const swiped = Math.max(adx, ady) >= SWIPE_MIN;

  if (state === 'ready') {
    startPlaying();
    if (swiped) enqueue(adx > ady ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up));
    return;
  }
  if (state === 'dead') { restart(); return; }
  if (state === 'playing' && swiped) {
    enqueue(adx > ady ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up));
  }
}

boardEl.addEventListener('pointerup', endSwipe);
boardEl.addEventListener('pointercancel', () => { ptr = null; });
boardEl.addEventListener('dblclick', (e) => e.preventDefault());
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// The board is a square in the middle of a tall screen, so more than half the
// display was dead on the start and game-over screens. The primary verb gets
// the whole screen; the board keeps the swipe. The shared controls (install,
// pause, update) all stop propagation, so they never reach this.
addEventListener('pointerdown', (e) => {
  if (boardEl.contains(e.target)) return;
  if (state === 'ready') startPlaying();
  else if (state === 'dead') restart();
});

// ---- Boot -----------------------------------------------------------------
best = loadBest();
bestEl.textContent = best;
sizeCanvas();
reset();
// the shared card owns pause now, including the tab-hide case
const pause = installPause({ canPause: () => state === 'playing' });
requestAnimationFrame(frame);

// ---- Service worker -------------------------------------------------------
// update.js registers the service worker and owns the update prompt
installUpdates({ canShow: () => state !== 'playing' });
installPrompt();
