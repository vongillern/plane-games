// 2048 — offline PWA. Vanilla ES module.

const SIZE = 4;
const SLIDE_MS = 150;        // tile slide duration — matches --anim-slide in style.css
const SPAWN_DELAY_MS = 100;  // pause after a slide lands before the new tile appears
const BEST_KEY = 'am.2048.best';
const WIN_VALUE = 2048;

// ---- Tile visual ramp ----------------------------------------------------
const TILE_STYLES = {
  2:    { bg: '#2b2822', fg: '#f5f5f7' },
  4:    { bg: '#3a3327', fg: '#f5f5f7' },
  8:    { bg: '#b9803a', fg: '#1a1408' },
  16:   { bg: '#dd8f38', fg: '#1a1408' },
  32:   { bg: '#ec7f2e', fg: '#1a1408' },
  64:   { bg: '#f2661f', fg: '#ffffff' },
  128:  { bg: '#f5a623', fg: '#1a1408' },
  256:  { bg: '#f7b52c', fg: '#1a1408' },
  512:  { bg: '#f9c62a', fg: '#1a1408' },
  1024: { bg: '#fcd535', fg: '#1a1408', glow: true },
  2048: { bg: '#ffdd44', fg: '#1a1408', glow: true },
};
const HIGH_STYLE = { bg: '#ffe66e', fg: '#1a1408', glow: true };

function styleFor(value) {
  return TILE_STYLES[value] || HIGH_STYLE;
}

// ---- DOM ------------------------------------------------------------------
const boardEl = document.getElementById('board');
const gridEl = document.getElementById('grid');
const tilesEl = document.getElementById('tiles');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const scoreChipEl = scoreEl.closest('.chip');
const overlayEl = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlaySub = document.getElementById('overlay-sub');
const overlayActions = document.getElementById('overlay-actions');

// build the 16 static background cells
for (let i = 0; i < SIZE * SIZE; i++) {
  const c = document.createElement('div');
  c.className = 'grid-cell';
  gridEl.appendChild(c);
}

// ---- State ----------------------------------------------------------------
let cells;        // SIZE x SIZE of tile objects or null
let tiles;        // Map id -> tile
let score;
let best;
let won;          // player crossed 2048 and chose to keep going (or dismissed)
let animating;    // a slide/merge is currently in flight — new moves get queued
let uid;
let queuedDir;    // one pending direction queued while animating, or null

const VECTORS = {
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
};

// ---- Helpers --------------------------------------------------------------
function loadBest() {
  const raw = localStorage.getItem(BEST_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function saveBest() {
  try { localStorage.setItem(BEST_KEY, String(best)); } catch (_) {}
}

function withinBounds(p) {
  return p.x >= 0 && p.x < SIZE && p.y >= 0 && p.y < SIZE;
}

function emptyCells() {
  const out = [];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (!cells[y][x]) out.push({ x, y });
  return out;
}

function digitsFontVar(value) {
  const len = String(value).length;
  if (len <= 2) return 'calc(var(--cell) * 0.44)';
  if (len === 3) return 'calc(var(--cell) * 0.34)';
  return 'calc(var(--cell) * 0.27)';
}

// ---- Tile rendering -------------------------------------------------------
function makeTile(value, x, y, isNew) {
  const id = ++uid;
  const el = document.createElement('div');
  el.className = 'tile' + (isNew ? ' tile-new' : '');
  const inner = document.createElement('div');
  inner.className = 'tile-inner';
  el.appendChild(inner);
  const tile = { id, value, c: x, r: y, el, inner, pendingValue: null };
  applyVisual(tile);
  placeTile(tile);
  tilesEl.appendChild(el);
  tiles.set(id, tile);
  cells[y][x] = tile;
  if (isNew) {
    // self-cleaning: strip the one-shot class once its spawn animation
    // finishes so it never fights a later merge-pop on the same element
    inner.addEventListener('animationend', () => el.classList.remove('tile-new'), { once: true });
  }
  return tile;
}

function applyVisual(tile) {
  const s = styleFor(tile.value);
  tile.el.style.setProperty('--tile-bg', s.bg);
  tile.el.style.setProperty('--tile-fg', s.fg);
  tile.el.style.setProperty('--tile-fs', digitsFontVar(tile.value));
  tile.el.style.setProperty('--tile-glow', s.glow ? `0 0 24px -2px ${s.bg}` : 'none');
  tile.inner.textContent = tile.value;
}

function placeTile(tile) {
  tile.el.style.setProperty('--x', `calc((var(--cell) + var(--gap)) * ${tile.c})`);
  tile.el.style.setProperty('--y', `calc((var(--cell) + var(--gap)) * ${tile.r})`);
}

function removeTile(tile) {
  tile.el.remove();
  tiles.delete(tile.id);
}

// ---- Setup / new game -----------------------------------------------------
function reset() {
  tilesEl.replaceChildren();
  cells = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  tiles = new Map();
  score = 0;
  won = false;
  animating = false;
  uid = 0;
  queuedDir = null;
  updateScore(0, false);
  hideOverlay();
  spawnTile();
  spawnTile();
}

function spawnTile() {
  const empties = emptyCells();
  if (!empties.length) return null;
  const spot = empties[Math.floor(Math.random() * empties.length)];
  const value = Math.random() < 0.9 ? 2 : 4;
  return makeTile(value, spot.x, spot.y, true);
}

// ---- Score ----------------------------------------------------------------
function updateScore(newScore, animate) {
  const gain = newScore - score;
  score = newScore;
  scoreEl.textContent = score;
  if (score > best) {
    best = score;
    bestEl.textContent = best;
    saveBest();
  }
  if (animate && gain > 0) {
    floatScore(gain);
    bumpChip();
  }
}

function floatScore(gain) {
  const f = document.createElement('div');
  f.className = 'score-float';
  f.textContent = '+' + gain;
  scoreChipEl.appendChild(f);
  f.addEventListener('animationend', () => f.remove(), { once: true });
}

function bumpChip() {
  scoreChipEl.classList.remove('chip-bump');
  void scoreChipEl.offsetWidth; // reflow so the animation restarts on rapid merges
  scoreChipEl.classList.add('chip-bump');
}

// ---- Movement -------------------------------------------------------------
function buildTraversals(v) {
  const xs = [0, 1, 2, 3];
  const ys = [0, 1, 2, 3];
  if (v.x > 0) xs.reverse();
  if (v.y > 0) ys.reverse();
  return { xs, ys };
}

function findFarthest(x, y, v) {
  let prev = { x, y };
  let p = { x: x + v.x, y: y + v.y };
  while (withinBounds(p) && !cells[p.y][p.x]) {
    prev = p;
    p = { x: p.x + v.x, y: p.y + v.y };
  }
  return { farthest: prev, next: withinBounds(p) ? p : null };
}

// A swipe that can't move anything still answers back: the board nudges the
// way you pushed, so touch users know the input registered.
function bumpBoard(dir) {
  boardEl.classList.remove('bump-left', 'bump-right', 'bump-up', 'bump-down');
  void boardEl.offsetWidth; // restart the animation on repeated bumps
  boardEl.classList.add('bump-' + dir);
}

function move(dir) {
  if (animating) {
    // never drop input mid-animation: keep only the latest queued move
    // and fast-forward into it the instant the current slide lands
    queuedDir = dir;
    return;
  }
  const v = VECTORS[dir];
  const { xs, ys } = buildTraversals(v);

  let moved = false;
  let gain = 0;
  const toRemove = [];        // incoming tiles absorbed by a merge
  const mergedSurvivors = [];

  for (const tile of tiles.values()) tile.mergedThisTurn = false;

  ys.forEach(y => {
    xs.forEach(x => {
      const tile = cells[y][x];
      if (!tile) return;
      const { farthest, next } = findFarthest(x, y, v);
      const nextTile = next ? cells[next.y][next.x] : null;

      if (nextTile && nextTile.value === tile.value && !nextTile.mergedThisTurn) {
        // merge `tile` into `nextTile`
        cells[y][x] = null;
        tile.c = next.x;
        tile.r = next.y;           // slide onto the survivor, then vanish
        toRemove.push(tile);

        nextTile.mergedThisTurn = true;
        nextTile.pendingValue = nextTile.value * 2;
        mergedSurvivors.push(nextTile);
        gain += nextTile.pendingValue;
        moved = true;
      } else if (farthest.x !== x || farthest.y !== y) {
        cells[y][x] = null;
        cells[farthest.y][farthest.x] = tile;
        tile.c = farthest.x;
        tile.r = farthest.y;
        moved = true;
      }
    });
  });

  if (!moved) { bumpBoard(dir); return; }

  animating = true;

  // trigger the slide: tile positions already mutated above, so re-placing
  // every tile now animates them (via the transform transition) from their
  // old screen position to their new one
  for (const tile of tiles.values()) placeTile(tile);

  if (gain > 0) {
    updateScore(score + gain, true);
    navigator.vibrate?.(10);
  }

  window.setTimeout(() => {
    // slide has landed: finalize merges (pop survivors, drop absorbed tiles)
    for (const s of mergedSurvivors) {
      s.value = s.pendingValue;
      s.pendingValue = null;
      applyVisual(s);
      s.el.classList.remove('tile-merged');
      // reflow so the animation restarts if merged again quickly
      void s.el.offsetWidth;
      s.el.classList.add('tile-merged');
    }
    for (const t of toRemove) removeTile(t);

    animating = false;

    const justWon = !won && mergedSurvivors.some(s => s.value >= WIN_VALUE);
    if (justWon) {
      won = true;
      showWin();
    }

    // the moment the board has landed, let a queued move fast-forward in —
    // this is what keeps rapid play feeling snappy instead of laggy
    if (queuedDir) {
      const d = queuedDir;
      queuedDir = null;
      move(d);
    }

    // the new tile appears a beat after the slide lands, not instantly
    window.setTimeout(() => {
      spawnTile();
      if (!justWon && !movesAvailable()) {
        navigator.vibrate?.(30);
        showGameOver();
      }
    }, SPAWN_DELAY_MS);
  }, SLIDE_MS);
}

// ---- Win / lose -----------------------------------------------------------
function movesAvailable() {
  if (emptyCells().length) return true;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const t = cells[y][x];
      if (!t) continue;
      for (const dir in VECTORS) {
        const v = VECTORS[dir];
        const nx = x + v.x, ny = y + v.y;
        if (withinBounds({ x: nx, y: ny })) {
          const n = cells[ny][nx];
          if (n && n.value === t.value) return true;
        }
      }
    }
  }
  return false;
}

// ---- Overlay --------------------------------------------------------------
function hideOverlay() {
  overlayEl.hidden = true;
  overlayActions.replaceChildren();
}

function overlayButton(label, primary, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn' + (primary ? ' btn-primary' : '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function showWin() {
  overlayTitle.textContent = 'You win';
  overlaySub.textContent = 'You reached 2048.';
  overlayActions.replaceChildren(
    overlayButton('Keep going', true, hideOverlay),
  );
  overlayEl.hidden = false;
}

function showGameOver() {
  overlayTitle.textContent = 'Game over';
  overlaySub.textContent = `Score ${score}`;
  overlayActions.replaceChildren(
    overlayButton('New Game', true, reset),
  );
  overlayEl.hidden = false;
}

// tap anywhere on the overlay backdrop = the primary action
// (game over: restart; win: keep going)
overlayEl.addEventListener('pointerdown', (e) => {
  if (e.target !== overlayEl) return;
  if (overlayTitle.textContent === 'Game over') reset();
  else hideOverlay();
});

// ---- Input: keyboard ------------------------------------------------------
const KEY_DIRS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
  A: 'left', D: 'right', W: 'up', S: 'down',
};

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const dir = KEY_DIRS[e.key];
  if (dir) {
    e.preventDefault();
    move(dir);
  }
});

// ---- Input: pointer swipe -------------------------------------------------
let ptr = null;
const SWIPE_MIN = 24;

boardEl.addEventListener('pointerdown', (e) => {
  if (!overlayEl.hidden) return;
  ptr = { id: e.pointerId, x: e.clientX, y: e.clientY };
});

boardEl.addEventListener('pointermove', (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  e.preventDefault();
});

function endSwipe(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x;
  const dy = e.clientY - ptr.y;
  ptr = null;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (Math.max(adx, ady) < SWIPE_MIN) return;
  if (adx > ady) move(dx > 0 ? 'right' : 'left');
  else move(dy > 0 ? 'down' : 'up');
}

boardEl.addEventListener('pointerup', endSwipe);
boardEl.addEventListener('pointercancel', () => { ptr = null; });

// prevent iOS double-tap zoom / long-press selection on the board
boardEl.addEventListener('dblclick', (e) => e.preventDefault());
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- Boot -----------------------------------------------------------------
best = loadBest();
bestEl.textContent = best;
reset();

// tiny test hook: lets headless tests force a near-full grid to reach
// game-over quickly without playing out a full game. Harmless in production.
window.__test = {
  forceNearFull() {
    tilesEl.replaceChildren();
    cells = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    tiles = new Map();
    uid = 0;
    // 15 pairwise-distinct sentinel values (never equal each other, or a
    // freshly-spawned 2/4) with a single gap at (0,0). A single "left" move
    // shifts every row flush and lands the last empty cell where nothing
    // can ever merge again, so the very next spawn ends the game.
    let v = 101;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (x === 0 && y === 0) continue;
        makeTile(v++, x, y, false);
      }
    }
    queuedDir = null;
    animating = false;
  },
};

// ---- Service worker -------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---- Install prompt ---------------------------------------------------
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
