import { installUpdates } from './update.js';
// 2048 — offline PWA. Vanilla ES module.

const SIZE = 4;
const BEST_KEY = 'am.2048.best';
const WIN_VALUE = 2048;

// ---- Motion ---------------------------------------------------------------
// The entire feel of the game lives in this table (milliseconds at speed 1).
// Nothing here is animated by CSS transitions: every tile is choreographed in
// JS so a tile that travels three cells takes longer than one that travels
// one, and so each merge pops at the exact instant its tile lands — not on a
// shared "everything is done now" timer.
const MOTION = {
  slideBase:    195,  // a one-cell slide
  slidePerCell:  55,  // + per extra cell travelled
  stagger:       18,  // per-tile head start; tiles nearest the wall leave first
  settle:       170,  // squash recovery after a tile hits the wall/stack
  pop:          380,  // merge pop on the surviving tile
  flash:        300,
  ring:         620,
  spark:        720,
  spawnDelay:   130,  // beat between the board landing and the new tile
  spawn:        340,
  tilt:         520,  // the tray tipping the way you swiped
  bump:         460,  // blocked move
  scoreTween:   560,
  overlayIn:    720,  // let a win/loss land visually before the card covers it
};

// When the player is already swiping ahead of the board, the whole move
// compresses — showmanship for the first swipe, snap for the tenth.
const RUSH = 0.52;

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Every duration passes through a per-move scaler so a rushed move (or a
// reduced-motion device) shrinks its whole timeline coherently.
function scaler(speed) {
  return REDUCED ? () => 1 : (v) => v * speed;
}
const D1 = scaler(1);

const EASE_SLIDE  = 'cubic-bezier(.29, .05, .16, 1)';   // push, then friction
const EASE_SPRING = 'cubic-bezier(.22, 1.2, .36, 1)';
const EASE_OUT    = 'cubic-bezier(.16, 1, .3, 1)';

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

// Celebration tier: every merge pops, big merges earn sparks, and the
// milestones (1024, 2048, beyond) light the whole board.
function tierFor(value) {
  if (value >= 1024) return 3;
  if (value >= 128) return 2;
  return 1;
}

// ---- DOM ------------------------------------------------------------------
const boardEl = document.getElementById('board');
const gridEl = document.getElementById('grid');
const tilesEl = document.getElementById('tiles');
const fxEl = document.getElementById('fx');            // bursts, clipped to the tray
const labelEl = document.getElementById('fx-labels');  // "+N", free to leave it
const glowEl = document.getElementById('board-glow');
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
let animating;    // a slide is in flight — new moves get queued
let uid;
let queuedDir;    // one pending direction queued while animating, or null
let rushNext;     // the next move starts already behind the player: compress it
let gen = 0;      // bumped on reset so in-flight callbacks from the old game die

const VECTORS = {
  left:  { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up:    { x: 0, y: -1 },
  down:  { x: 0, y: 1 },
};

// ---- Geometry -------------------------------------------------------------
// Tile positions are real pixels (not calc() strings) so the Web Animations
// API can interpolate them; the grid is measured from the DOM and re-measured
// whenever the viewport changes.
const M = { cell: 0, step: 0 };
let tiltAnim = null;

function measure() {
  if (tiltAnim) { tiltAnim.cancel(); tiltAnim = null; } // never measure a tilted board
  const a = gridEl.children[0].getBoundingClientRect();
  const b = gridEl.children[1].getBoundingClientRect();
  if (!a.width) return;
  M.cell = a.width;
  M.step = (b.left - a.left) || a.width;
}

function cellX(c) { return c * M.step; }
function cellY(r) { return r * M.step; }

window.addEventListener('resize', () => {
  measure();
  for (const t of tiles.values()) {
    if (t.slideAnim) { t.slideAnim.cancel(); t.slideAnim = null; }
    placeTile(t);
  }
});

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
function makeTile(value, x, y, spawnAnim, D) {
  const id = ++uid;
  const el = document.createElement('div');
  el.className = 'tile';
  const face = document.createElement('div');
  face.className = 'tile-face';
  const flash = document.createElement('div');
  flash.className = 'tile-flash';
  const num = document.createElement('span');
  num.className = 'tile-num';
  face.append(flash, num);
  el.appendChild(face);

  const tile = { id, value, c: x, r: y, el, face, flash, num, pendingValue: null, slideAnim: null, faceAnim: null };
  applyVisual(tile);
  placeTile(tile);
  tilesEl.appendChild(el);
  tiles.set(id, tile);
  cells[y][x] = tile;
  if (spawnAnim) playSpawn(tile, D || D1);
  return tile;
}

function applyVisual(tile) {
  const s = styleFor(tile.value);
  tile.el.style.setProperty('--tile-bg', s.bg);
  tile.el.style.setProperty('--tile-fg', s.fg);
  tile.el.style.setProperty('--tile-fs', digitsFontVar(tile.value));
  tile.el.style.setProperty('--tile-glow', s.glow ? `0 0 26px -2px ${s.bg}` : 'none');
  tile.num.textContent = tile.value;
}

function placeTile(tile) {
  tile.el.style.setProperty('--x', `${cellX(tile.c)}px`);
  tile.el.style.setProperty('--y', `${cellY(tile.r)}px`);
}

function removeTile(tile) {
  tile.el.remove();
  tiles.delete(tile.id);
}

// One animation slot per face: a merge pop must be able to interrupt the
// squash it is landing out of, and a rushed move must interrupt anything.
function faceAnimate(tile, frames, opts) {
  if (tile.faceAnim) tile.faceAnim.cancel();
  tile.faceAnim = tile.face.animate(frames, opts);
  return tile.faceAnim;
}

// ---- Effects layer --------------------------------------------------------
// Rings, sparks and floating score live in their own layer so they can outlive
// the tile that spawned them (a merged tile is gone 100ms later).
function fxNode(className, c, r, layer) {
  const el = document.createElement('div');
  el.className = className;
  el.style.left = `${cellX(c) + M.cell / 2}px`;
  el.style.top = `${cellY(r) + M.cell / 2}px`;
  (layer || fxEl).appendChild(el);
  return el;
}

function fxPlay(el, frames, opts) {
  const a = el.animate(frames, opts);
  a.finished.then(() => el.remove(), () => el.remove());
}

function ringBurst(c, r, color, D, tier) {
  if (REDUCED) return;
  const el = fxNode('fx-ring', c, r);
  el.style.setProperty('--ring-color', color);
  el.style.width = el.style.height = `${M.cell}px`;
  const spread = tier === 3 ? 2.1 : tier === 2 ? 1.75 : 1.5;
  fxPlay(el, [
    { transform: 'translate(-50%, -50%) scale(.78)', opacity: tier === 3 ? .8 : .55 },
    { transform: `translate(-50%, -50%) scale(${spread})`, opacity: 0 },
  ], { duration: D(MOTION.ring), easing: EASE_OUT });
}

// A ring that contracts inward instead of outward — reads as "materialising".
function ringCollapse(c, r, color, D) {
  if (REDUCED) return;
  const el = fxNode('fx-ring', c, r);
  el.style.setProperty('--ring-color', color);
  el.style.width = el.style.height = `${M.cell}px`;
  fxPlay(el, [
    { transform: 'translate(-50%, -50%) scale(1.7)', opacity: 0 },
    { transform: 'translate(-50%, -50%) scale(1.15)', opacity: .5, offset: .45 },
    { transform: 'translate(-50%, -50%) scale(.95)', opacity: 0 },
  ], { duration: D(MOTION.ring * .72), easing: EASE_OUT, delay: D(MOTION.spawnDelay) });
}

function sparkBurst(c, r, color, D, count) {
  if (REDUCED) return;
  const base = Math.random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const el = fxNode('fx-spark', c, r);
    el.style.setProperty('--spark-color', color);
    const angle = base + (i / count) * Math.PI * 2 + (Math.random() - .5) * .5;
    const dist = M.cell * (0.55 + Math.random() * 0.5);
    const size = M.cell * (0.06 + Math.random() * 0.05);
    el.style.width = el.style.height = `${size}px`;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    fxPlay(el, [
      { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)', opacity: 1 },
      { transform: `translate(-50%, -50%) translate(${dx * .55}px, ${dy * .55}px) scale(.9)`, opacity: .9, offset: .35 },
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy + M.cell * .12}px) scale(.2)`, opacity: 0 },
    ], { duration: D(MOTION.spark) * (0.75 + Math.random() * 0.5), easing: EASE_OUT });
  }
}

function floatGain(gain, c, r, D) {
  const el = fxNode('fx-float', c, r, labelEl);
  el.textContent = '+' + gain;
  const y = (k) => `translate(-50%, -50%) translateY(${-M.cell * k}px)`;
  fxPlay(el, [
    { transform: `${y(-.02)} scale(.7)`, opacity: 0, offset: 0 },
    { transform: `${y(.30)} scale(1)`, opacity: 1, offset: .18 },
    { transform: `${y(.58)} scale(1)`, opacity: 1, offset: .58 },
    { transform: `${y(1.05)} scale(.94)`, opacity: 0, offset: 1 },
  ], { duration: REDUCED ? 1 : D(950), easing: 'ease-out' });
}

// The board itself answers a milestone merge.
function boardPulse(D) {
  if (REDUCED) return;
  glowEl.animate([
    { opacity: 0, transform: 'scale(.97)' },
    { opacity: 1, transform: 'scale(1.01)', offset: .18 },
    { opacity: 0, transform: 'scale(1.04)' },
  ], { duration: D(760), easing: EASE_OUT });
}

// ---- Tile animations ------------------------------------------------------
function playSpawn(tile, D) {
  faceAnimate(tile, [
    { transform: 'scale(.2)', opacity: 0, offset: 0 },
    { transform: 'scale(1.14)', opacity: 1, offset: .58 },
    { transform: 'scale(1)', opacity: 1, offset: 1 },
  ], {
    duration: D(MOTION.spawn),
    delay: D(MOTION.spawnDelay),
    easing: EASE_SPRING,
    fill: 'backwards',
  });
  ringCollapse(tile.c, tile.r, styleFor(tile.value).bg, D);
}

// Squash and stretch: a tile leans into its travel, then compresses against
// whatever stopped it. This is the single detail that makes a slide readable.
function playSquash(tile, dir, dist, delay, dur, D) {
  if (REDUCED) return;
  const k = Math.min(dist / 3, 1);
  const horiz = dir === 'left' || dir === 'right';
  const sc = (along, across) => horiz ? `scale(${along}, ${across})` : `scale(${across}, ${along})`;
  const settle = D(MOTION.settle);
  const total = dur + settle;
  faceAnimate(tile, [
    { transform: sc(1, 1), offset: 0, easing: 'ease-out' },
    { transform: sc(1 + .11 * k, 1 - .08 * k), offset: (dur * .4) / total, easing: 'ease-in' },
    { transform: sc(1 - .15 * k, 1 + .12 * k), offset: dur / total, easing: EASE_SPRING },
    { transform: sc(1, 1), offset: 1 },
  ], { duration: total, delay, fill: 'backwards' });
}

function playSlide(tile, fromC, fromR, delay, dur) {
  if (tile.slideAnim) tile.slideAnim.cancel();
  tile.slideAnim = tile.el.animate([
    { transform: `translate3d(${cellX(fromC)}px, ${cellY(fromR)}px, 0)` },
    { transform: `translate3d(${cellX(tile.c)}px, ${cellY(tile.r)}px, 0)` },
  ], { duration: dur, delay, easing: EASE_SLIDE, fill: 'backwards' });
}

// The absorbed tile does not simply disappear: it sinks into the survivor a
// beat after impact, under it.
function playAbsorb(tile, D) {
  const dur = D(MOTION.pop * .38);
  tile.el.style.zIndex = '0';
  const a = faceAnimate(tile, [
    { transform: 'scale(1)', opacity: 1 },
    { transform: 'scale(.72)', opacity: 0 },
  ], { duration: dur, easing: 'ease-in', fill: 'forwards' });
  const drop = () => removeTile(tile);
  a.finished.then(drop, drop);
}

function playMerge(tile, D) {
  const s = styleFor(tile.value);
  const tier = tierFor(tile.value);
  const amp = tier === 3 ? .40 : tier === 2 ? .32 : .26;

  tile.el.style.zIndex = '3';
  const pop = faceAnimate(tile, [
    { transform: 'scale(1)', offset: 0 },
    { transform: `scale(${1 + amp})`, offset: .32 },
    { transform: `scale(${1 - amp * .14})`, offset: .62 },
    { transform: 'scale(1)', offset: 1 },
  ], { duration: D(MOTION.pop), easing: EASE_SPRING });
  pop.finished.then(() => { tile.el.style.zIndex = ''; }, () => {});

  if (!REDUCED) {
    tile.flash.animate([
      { opacity: 0 },
      { opacity: tier === 3 ? 1 : .8, offset: .12 },
      { opacity: 0 },
    ], { duration: D(MOTION.flash), easing: EASE_OUT });
  }

  ringBurst(tile.c, tile.r, s.bg, D, tier);
  if (tier >= 2) sparkBurst(tile.c, tile.r, s.bg, D, tier === 3 ? 14 : 7);
  if (tier === 3) boardPulse(D);
}

// The tray tips the way you pushed — the mental model, made literal. Subtle
// enough (2.4°) to read as weight rather than as a 3D gimmick.
function tiltBoard(dir, D) {
  if (REDUCED) return;
  const deg = 2.4;
  // positive rotateY pushes the right edge away, positive rotateX the top edge
  const to = dir === 'left'  ? `rotateY(${-deg}deg)`
           : dir === 'right' ? `rotateY(${deg}deg)`
           : dir === 'up'    ? `rotateX(${deg}deg)`
           :                   `rotateX(${-deg}deg)`;
  if (tiltAnim) tiltAnim.cancel();
  tiltAnim = boardEl.animate([
    { transform: 'perspective(1200px)' },
    { transform: `perspective(1200px) ${to}`, offset: .3 },
    { transform: 'perspective(1200px)' },
  ], { duration: D(MOTION.tilt), easing: EASE_SPRING });
}

// A swipe that can't move anything still answers back: the tray tips harder
// and shoves, then springs flat — the input registered, the move is impossible.
function bumpBoard(dir) {
  const deg = REDUCED ? 0 : 4.2;
  const push = REDUCED ? 0 : 8;
  const v = VECTORS[dir];
  const shove = `translate3d(${v.x * push}px, ${v.y * push}px, 0)`;
  const tip = dir === 'left'  ? `rotateY(${-deg}deg)`
            : dir === 'right' ? `rotateY(${deg}deg)`
            : dir === 'up'    ? `rotateX(${deg}deg)`
            :                   `rotateX(${-deg}deg)`;
  if (tiltAnim) tiltAnim.cancel();
  tiltAnim = boardEl.animate([
    { transform: 'perspective(1200px)' },
    { transform: `perspective(1200px) ${shove} ${tip}`, offset: .26 },
    { transform: 'perspective(1200px)' },
  ], { duration: REDUCED ? 1 : MOTION.bump, easing: EASE_SPRING });
}

function boardShudder() {
  if (REDUCED) return;
  if (tiltAnim) tiltAnim.cancel();
  tiltAnim = boardEl.animate([
    { transform: 'translate3d(0,0,0)' },
    { transform: 'translate3d(-7px,0,0)', offset: .12 },
    { transform: 'translate3d(6px,0,0)', offset: .3 },
    { transform: 'translate3d(-4px,0,0)', offset: .5 },
    { transform: 'translate3d(2px,0,0)', offset: .72 },
    { transform: 'translate3d(0,0,0)' },
  ], { duration: 520, easing: 'ease-out' });
}

// ---- Setup / new game -----------------------------------------------------
function reset() {
  gen++;
  tilesEl.replaceChildren();
  fxEl.replaceChildren();
  labelEl.replaceChildren();
  cells = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  tiles = new Map();
  won = false;
  animating = false;
  uid = 0;
  queuedDir = null;
  rushNext = false;
  setScore(0);
  hideOverlay();
  measure();
  spawnTile(D1);
  spawnTile(D1);
}

function spawnTile(D) {
  const empties = emptyCells();
  if (!empties.length) return null;
  const spot = empties[Math.floor(Math.random() * empties.length)];
  const value = Math.random() < 0.9 ? 2 : 4;
  return makeTile(value, spot.x, spot.y, true, D);
}

// ---- Score ----------------------------------------------------------------
// The number rolls up instead of snapping, and each merge in a move pushes it
// again — a four-merge sweep reads as one long climb.
let shownScore = 0;
let scoreFrom = 0;
let scoreAt = 0;
let scoreDur = 0;
let scoreRaf = 0;
let bestFloor = 0;

function renderScore() {
  scoreEl.textContent = shownScore;
  bestEl.textContent = Math.max(bestFloor, shownScore);
}

function setScore(v) {
  if (scoreRaf) { cancelAnimationFrame(scoreRaf); scoreRaf = 0; }
  score = v;
  shownScore = v;
  bestFloor = best || 0;
  renderScore();
}

function tickScore(now) {
  const t = Math.min(1, (now - scoreAt) / scoreDur);
  const e = 1 - Math.pow(1 - t, 3);
  shownScore = Math.round(scoreFrom + (score - scoreFrom) * e);
  renderScore();
  if (t < 1) scoreRaf = requestAnimationFrame(tickScore);
  else { scoreRaf = 0; shownScore = score; renderScore(); }
}

function addScore(gain, D) {
  if (!scoreRaf) bestFloor = best;  // capture before this climb raises `best`
  score += gain;
  if (score > best) { best = score; saveBest(); }
  if (REDUCED) { setScore(score); return; }
  scoreFrom = shownScore;
  scoreAt = performance.now();
  scoreDur = D(MOTION.scoreTween);
  if (!scoreRaf) scoreRaf = requestAnimationFrame(tickScore);
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

// Tiles nearest the wall they are heading for leave first, so a full row
// unspools as a wave instead of a slab. Delaying the *rear* tiles is also what
// guarantees a follower never overtakes the tile it is chasing.
function laneIndex(tile, dir) {
  switch (dir) {
    case 'left':  return tile.c;
    case 'right': return SIZE - 1 - tile.c;
    case 'up':    return tile.r;
    default:      return SIZE - 1 - tile.r;
  }
}

function move(dir) {
  if (animating) {
    // never drop input mid-animation: keep only the latest queued move and
    // fast-forward into it the instant the current slide lands
    queuedDir = dir;
    return;
  }
  const v = VECTORS[dir];
  const { xs, ys } = buildTraversals(v);

  let moved = false;
  const slides = [];   // { tile, fromC, fromR, absorbed }
  const merges = [];   // { survivor, absorbed }

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
        slides.push({ tile, fromC: x, fromR: y, absorbed: true });
        tile.c = next.x;
        tile.r = next.y;           // slide onto the survivor, then sink into it
        tiles.delete(tile.id);     // out of the model now; the element lingers

        nextTile.mergedThisTurn = true;
        nextTile.pendingValue = nextTile.value * 2;
        merges.push({ survivor: nextTile, absorbed: tile });
        moved = true;
      } else if (farthest.x !== x || farthest.y !== y) {
        cells[y][x] = null;
        cells[farthest.y][farthest.x] = tile;
        slides.push({ tile, fromC: x, fromR: y, absorbed: false });
        tile.c = farthest.x;
        tile.r = farthest.y;
        moved = true;
      }
    });
  });

  if (!moved) { bumpBoard(dir); return; }

  animating = true;
  const speed = rushNext ? RUSH : 1;
  rushNext = false;
  const D = scaler(speed);
  const g = gen;

  tiltBoard(dir, D);

  // Lay out every slide first so each merge knows the exact moment its
  // incoming tile arrives.
  const endAt = new Map();
  let landing = 0;
  for (const s of slides) {
    const dist = Math.abs(s.tile.c - s.fromC) + Math.abs(s.tile.r - s.fromR);
    const dur = D(MOTION.slideBase + MOTION.slidePerCell * (dist - 1));
    const delay = D(MOTION.stagger * laneIndex(s.tile, dir));
    placeTile(s.tile);
    playSlide(s.tile, s.fromC, s.fromR, delay, dur);
    if (!s.absorbed) playSquash(s.tile, dir, dist, delay, dur, D);
    endAt.set(s.tile, delay + dur);
    landing = Math.max(landing, delay + dur);
  }

  // Each merge resolves on its own impact, not on a shared timer.
  for (const m of merges) {
    const at = endAt.get(m.absorbed) || landing;
    const tier = tierFor(m.survivor.pendingValue);
    window.setTimeout(() => {
      if (g !== gen) return;
      const s = m.survivor;
      s.value = s.pendingValue;
      s.pendingValue = null;
      applyVisual(s);
      playMerge(s, D);
      playAbsorb(m.absorbed, D);
      addScore(s.value, D);
      bumpChip();
      floatGain(s.value, s.c, s.r, D);
      navigator.vibrate?.(tier === 3 ? 26 : tier === 2 ? 14 : 8);
    }, at);
  }

  window.setTimeout(() => {
    if (g !== gen) return;

    // The board has landed. The new tile joins the model right now — its
    // entrance animation is what's delayed — so a queued move can fire
    // immediately without racing a tile that isn't on the board yet.
    spawnTile(D);
    const justWon = !won && merges.some(m => (m.survivor.pendingValue || m.survivor.value) >= WIN_VALUE);
    const dead = !justWon && !movesAvailable();

    animating = false;

    if (justWon || dead) {
      queuedDir = null;
      if (justWon) won = true;
      else { navigator.vibrate?.(30); boardShudder(); }
      const show = justWon ? showWin : showGameOver;
      window.setTimeout(() => { if (g === gen) show(); }, D(MOTION.overlayIn));
    } else if (queuedDir) {
      // the moment the board has landed, let a queued move fast-forward in —
      // this is what keeps rapid play feeling snappy instead of laggy
      const d = queuedDir;
      queuedDir = null;
      rushNext = true;
      move(d);
    }
  }, landing);
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
measure();
reset();

// tiny test hook: lets headless tests force a near-full grid to reach
// game-over quickly without playing out a full game. Harmless in production.
window.__test = {
  motion: MOTION,
  // rows: 4x4 of values (0 / null = empty)
  setBoard(rows) {
    gen++;
    tilesEl.replaceChildren();
    fxEl.replaceChildren();
    labelEl.replaceChildren();
    cells = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    tiles = new Map();
    uid = 0;
    measure();
    rows.forEach((row, y) => row.forEach((v, x) => { if (v) makeTile(v, x, y, false); }));
    queuedDir = null;
    animating = false;
  },
  forceNearFull() {
    // 15 pairwise-distinct sentinel values (never equal each other, or a
    // freshly-spawned 2/4) with a single gap at (0,0). A single "left" move
    // shifts every row flush and lands the last empty cell where nothing
    // can ever merge again, so the very next spawn ends the game.
    let v = 101;
    const rows = Array.from({ length: SIZE }, (_, y) =>
      Array.from({ length: SIZE }, (_, x) => (x === 0 && y === 0) ? 0 : v++));
    window.__test.setBoard(rows);
  },
};

// ---- Service worker -------------------------------------------------------
// update.js registers the service worker and owns the update prompt
installUpdates();

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
