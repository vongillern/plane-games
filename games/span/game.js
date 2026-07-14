// Span — a bridge builder. Offline PWA, vanilla ES module.
// Build with drags, test with deterministic Verlet physics (see physics.js).

import {
  MATS, MAT_KEYS, GRID_STEP, DT,
  memberCost, bridgeCost, createSim,
} from './physics.js';

// roundRect shim for older Safari
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
    return this;
  };
}
import { LEVELS, levelAnchors } from './levels.js';

const UNLOCK_KEY = 'am.span.unlocked';
const BEST_KEY = 'am.span.best';
const BRIDGE_KEY = 'am.span.bridge.';

// ---- Palette ----------------------------------------------------------------
const COLORS = {
  road:  { base: '#42598a', deck: '#cfe0f5' },
  wood:  { base: '#d9a066' },
  steel: { base: '#9fb2c8' },
  cable: { base: '#7dd3fc' },
};
const AMBER = [245, 158, 11];
const RED = [239, 68, 68];

function hexRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
const RGB = {};
for (const k of MAT_KEYS) RGB[k] = hexRgb(COLORS[k].base);
RGB.deck = hexRgb(COLORS.road.deck);

// stress 0..1 -> material color -> amber -> red
function stressColor(rgb, s) {
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  let a = rgb, b = AMBER, t;
  if (s < 0.55) { t = s / 0.55; } else { a = AMBER; b = RED; t = (s - 0.55) / 0.45; }
  const r = (a[0] + (b[0] - a[0]) * t) | 0;
  const g = (a[1] + (b[1] - a[1]) * t) | 0;
  const bl = (a[2] + (b[2] - a[2]) * t) | 0;
  return `rgb(${r},${g},${bl})`;
}

// ---- DOM --------------------------------------------------------------------
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const levelNumEl = document.getElementById('level-num');
const levelNameEl = document.getElementById('level-name');
const budgetEl = document.getElementById('budget');
const budgetChipEl = document.getElementById('budget-chip');
const introEl = document.getElementById('intro');
const menuEl = document.getElementById('menu');
const levelsEl = document.getElementById('levels');
const resultEl = document.getElementById('result');
const resultTitleEl = document.getElementById('result-title');
const resultSubEl = document.getElementById('result-sub');
const resultPrimaryEl = document.getElementById('result-primary');
const resultSecondaryEl = document.getElementById('result-secondary');
const resultHintTouchEl = document.getElementById('result-hint-touch');
const resultHintKeyEl = document.getElementById('result-hint-key');
const paletteEl = document.getElementById('palette');
const matBtns = [...paletteEl.querySelectorAll('.mat-btn')];
const eraseBtn = document.getElementById('btn-erase');
const resetBtn = document.getElementById('btn-reset');
const testBtn = document.getElementById('btn-test');
const stopBtn = document.getElementById('btn-stop');
const backBtn = document.getElementById('btn-back');

// ---- Persistence ------------------------------------------------------------
function loadUnlocked() {
  const n = parseInt(localStorage.getItem(UNLOCK_KEY) || '1', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), LEVELS.length) : 1;
}
function loadBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; }
  catch { return {}; }
}
let unlocked = loadUnlocked();
let best = loadBest();

function saveProgress() {
  localStorage.setItem(UNLOCK_KEY, String(unlocked));
  localStorage.setItem(BEST_KEY, JSON.stringify(best));
}

function saveBridge() {
  const free = bridge.nodes.slice(anchorCount).map((n) => [n.x, n.y]);
  const members = bridge.members.map((m) => [m.a, m.b, m.mat]);
  try {
    localStorage.setItem(BRIDGE_KEY + levelIndex, JSON.stringify({ free, members }));
  } catch { /* storage full: play on */ }
}

function loadBridge() {
  try {
    const raw = localStorage.getItem(BRIDGE_KEY + levelIndex);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const [x, y] of data.free) bridge.nodes.push({ x, y, fixed: false });
    for (const [a, b, mat] of data.members) {
      if (bridge.nodes[a] && bridge.nodes[b] && MATS[mat]) bridge.members.push({ a, b, mat });
    }
  } catch { /* corrupt: start clean */ }
}

// ---- State ------------------------------------------------------------------
let screen = 'menu';         // 'menu' | 'build' | 'test'
let levelIndex = 0;
let level = LEVELS[0];
let anchorCount = 2;
let bridge = { nodes: [], members: [] };
let spent = 0;
let material = 'road';
let erasing = false;
let sim = null;
let resultShown = false;     // overlay visible
let resultTimer = 0;
let introTimer = 0;

// effects
let particles = [];
let shake = 0;

// camera
let view = { scale: 40, ox: 0, oy: 0 };
let dpr = 1, cw = 0, ch = 0;

// input
let drag = null; // { fromNode | fromPt, x, y, moved, startSx, startSy }

// ---- Canvas / camera --------------------------------------------------------
function sizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  cw = canvas.clientWidth;
  ch = canvas.clientHeight;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  computeView();
}
window.addEventListener('resize', sizeCanvas);

function worldBounds() {
  let yMin = Math.min(level.leftTop, level.rightTop) - 2.4;
  for (const a of levelAnchors(level)) yMin = Math.min(yMin, a.y - 1.4);
  return { xMin: -3.7, xMax: level.gap + 3.7, yMin, yMax: level.floorY + 1.1 };
}

function computeView() {
  const b = worldBounds();
  const w = b.xMax - b.xMin, h = b.yMax - b.yMin;
  const pad = 8;
  const scale = Math.min((cw - pad * 2) / w, (ch - pad * 2) / h);
  view.scale = scale;
  view.ox = (cw - w * scale) / 2 - b.xMin * scale;
  // bias content upward: less empty sky, more ground when letterboxed
  view.oy = (ch - h * scale) * 0.4 - b.yMin * scale;
}

const wx = (x) => x * view.scale + view.ox;
const wy = (y) => y * view.scale + view.oy;
const sx2w = (px) => (px - view.ox) / view.scale;
const sy2w = (py) => (py - view.oy) / view.scale;

// ---- Bridge editing ---------------------------------------------------------
function resetBridge() {
  const anchors = levelAnchors(level);
  anchorCount = anchors.length;
  bridge = {
    nodes: anchors.map((a) => ({ x: a.x, y: a.y, fixed: true })),
    members: [],
  };
  spent = 0;
}

function inTerrain(x, y) {
  if (y > level.floorY - GRID_STEP + 1e-6) return true;
  if (x < -1e-6 && y > level.leftTop + 1e-6) return true;
  if (x > level.gap + 1e-6 && y > level.rightTop + 1e-6) return true;
  return false;
}

function validNodePos(x, y) {
  const b = worldBounds();
  if (x < b.xMin + 0.4 || x > b.xMax - 0.4 || y < b.yMin + 0.2) return false;
  return !inTerrain(x, y);
}

function nearestNode(x, y, radius) {
  let bestI = -1, bestD = radius;
  for (let i = 0; i < bridge.nodes.length; i++) {
    const n = bridge.nodes[i];
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}

// Snap a pointer position: an existing node, else a valid grid point, else null.
function snapPoint(x, y) {
  const ni = nearestNode(x, y, 0.42);
  if (ni >= 0) return { node: ni, x: bridge.nodes[ni].x, y: bridge.nodes[ni].y };
  const gx = Math.round(x / GRID_STEP) * GRID_STEP;
  const gy = Math.round(y / GRID_STEP) * GRID_STEP;
  if (!validNodePos(gx, gy)) return null;
  return { node: -1, x: gx, y: gy };
}

function findMember(a, b) {
  return bridge.members.findIndex((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a));
}

// Distance from point to segment (world units).
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const len2 = abx * abx + aby * aby || 1e-9;
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

function memberAt(x, y, radius = 0.28) {
  let bestI = -1, bestD = radius;
  for (let i = 0; i < bridge.members.length; i++) {
    const m = bridge.members[i];
    const a = bridge.nodes[m.a], b = bridge.nodes[m.b];
    const d = segDist(x, y, a.x, a.y, b.x, b.y);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}

// Validate a prospective member. Returns { ok, reason, cost, len }.
function checkMember(from, to, mat) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const cost = memberCost(len, mat);
  if (len < 0.4) return { ok: false, reason: '', cost, len };
  if (len > MATS[mat].maxLen + 1e-6) return { ok: false, reason: 'too long', cost, len };
  if (from.node >= 0 && to.node >= 0 && findMember(from.node, to.node) >= 0) {
    return { ok: false, reason: 'built', cost, len };
  }
  return { ok: true, reason: '', cost, len };
}

function nodeIndexFor(pt) {
  if (pt.node >= 0) return pt.node;
  bridge.nodes.push({ x: pt.x, y: pt.y, fixed: false });
  return bridge.nodes.length - 1;
}

function placeMember(from, to, mat) {
  const c = checkMember(from, to, mat);
  if (!c.ok) return false;
  const a = nodeIndexFor(from);
  const b = to.node >= 0 ? to.node : nodeIndexFor(to);
  if (a === b) return false;
  bridge.members.push({ a, b, mat });
  spent = bridgeCost(bridge);
  updateBudget();
  saveBridge();
  navigator.vibrate?.(8);
  return true;
}

function deleteMember(i) {
  bridge.members.splice(i, 1);
  // drop orphaned free nodes (remap indices)
  const used = new Set();
  for (const m of bridge.members) { used.add(m.a); used.add(m.b); }
  const map = new Map();
  const nodes = [];
  bridge.nodes.forEach((n, idx) => {
    if (idx < anchorCount || used.has(idx)) {
      map.set(idx, nodes.length);
      nodes.push(n);
    }
  });
  bridge.nodes = nodes;
  for (const m of bridge.members) { m.a = map.get(m.a); m.b = map.get(m.b); }
  spent = bridgeCost(bridge);
  updateBudget();
  saveBridge();
  navigator.vibrate?.(8);
}

// ---- UI updates -------------------------------------------------------------
function updateBudget() {
  const left = level.budget - spent;
  budgetEl.textContent = left < 0 ? `-$${-left}` : `$${left}`;
  budgetChipEl.classList.toggle('over', left < 0);
  testBtn.disabled = left < 0 || bridge.members.length === 0;
}

function setMaterial(mat) {
  material = mat;
  erasing = false;
  eraseBtn.classList.remove('sel');
  for (const b of matBtns) b.classList.toggle('sel', b.dataset.mat === mat);
}

function setErasing(on) {
  erasing = on;
  eraseBtn.classList.toggle('sel', on);
  if (on) for (const b of matBtns) b.classList.remove('sel');
  else setMaterial(material);
}

function showIntro() {
  introEl.innerHTML = '';
  const em = document.createElement('em');
  em.textContent = `${level.name}. `;
  introEl.appendChild(em);
  introEl.appendChild(document.createTextNode(level.intro));
  introEl.classList.remove('hide');
  introTimer = performance.now() + 5200;
}

function renderLevelChips() {
  levelsEl.innerHTML = '';
  LEVELS.forEach((L, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lvl-chip';
    const isLocked = i >= unlocked;
    const isDone = best[i] !== undefined;
    if (isLocked) btn.classList.add('locked');
    if (isDone) btn.classList.add('done');
    if (!isLocked && !isDone) btn.classList.add('next');
    btn.setAttribute('aria-label', `Level ${i + 1}: ${L.name}${isLocked ? ' (locked)' : ''}`);
    const num = document.createElement('span');
    num.textContent = String(i + 1);
    btn.appendChild(num);
    if (isDone) {
      const b = document.createElement('span');
      b.className = 'best';
      b.textContent = `$${best[i]}`;
      btn.appendChild(b);
    }
    if (!isLocked) btn.addEventListener('click', () => openLevel(i));
    levelsEl.appendChild(btn);
  });
}

// ---- Screen flow ------------------------------------------------------------
function openLevel(i) {
  levelIndex = i;
  level = LEVELS[i];
  levelNumEl.textContent = `Level ${i + 1}`;
  levelNameEl.textContent = level.name;
  resetBridge();
  loadBridge();
  spent = bridgeCost(bridge);
  computeView();
  goBuild();
  showIntro();
}

function goBuild() {
  screen = 'build';
  sim = null;
  drag = null;
  particles = [];
  shake = 0;
  menuEl.hidden = true;
  resultEl.hidden = true;
  resultShown = false;
  paletteEl.style.visibility = '';
  testBtn.hidden = false;
  stopBtn.hidden = true;
  updateBudget();
}

function goMenu() {
  screen = 'menu';
  sim = null;
  drag = null;
  resultEl.hidden = true;
  resultShown = false;
  renderLevelChips();
  menuEl.hidden = false;
}

function startTest() {
  if (screen !== 'build' || testBtn.disabled) return;
  screen = 'test';
  drag = null;
  introEl.classList.add('hide');
  sim = createSim(level, bridge);
  simAcc = 0;
  resultShown = false;
  resultTimer = 0;
  paletteEl.style.visibility = 'hidden';
  testBtn.hidden = true;
  stopBtn.hidden = false;
  navigator.vibrate?.(10);
}

function stopTest() {
  if (screen !== 'test') return;
  goBuild();
}

function onTestEnd() {
  if (sim.status === 'passed') {
    const left = level.budget - spent;
    const prevBest = best[levelIndex];
    if (prevBest === undefined || left > prevBest) best[levelIndex] = left;
    if (levelIndex + 1 < LEVELS.length) unlocked = Math.max(unlocked, levelIndex + 2);
    saveProgress();
    showResult(true, left, prevBest);
    navigator.vibrate?.([20, 60, 40]);
  } else {
    showResult(false);
  }
}

function showResult(won, left, prevBest) {
  resultShown = true;
  stopBtn.hidden = true;
  resultEl.dataset.kind = won ? 'win' : 'fail';
  if (won) {
    const last = levelIndex === LEVELS.length - 1;
    resultTitleEl.textContent = last ? 'All spans built.' : 'It holds!';
    let sub = `Budget left: <strong>$${left}</strong>`;
    if (prevBest !== undefined) sub += ` &middot; Best: <strong>$${Math.max(left, prevBest)}</strong>`;
    resultSubEl.innerHTML = sub;
    resultPrimaryEl.textContent = last ? 'Level select' : 'Next level';
    resultSecondaryEl.textContent = 'Improve';
    resultHintTouchEl.textContent = '';
    resultHintKeyEl.textContent = last ? '' : 'Space for next level';
  } else {
    resultTitleEl.textContent = 'It broke.';
    resultSubEl.textContent = sim.failReason === 'time'
      ? 'The crossing timed out. Is the road connected?'
      : sim.brokenCount > 0
        ? `${sim.brokenCount} member${sim.brokenCount === 1 ? '' : 's'} failed. Your bridge is intact — reinforce and retry.`
        : 'The vehicle fell. Your bridge is intact — adjust and retry.';
    resultPrimaryEl.textContent = 'Retry';
    resultSecondaryEl.textContent = 'Levels';
    resultHintTouchEl.textContent = 'Tap Retry to rebuild';
    resultHintKeyEl.textContent = 'Space to retry';
  }
  resultEl.hidden = false;
}

resultPrimaryEl.addEventListener('click', () => {
  if (resultEl.dataset.kind === 'win') {
    if (levelIndex === LEVELS.length - 1) goMenu();
    else openLevel(levelIndex + 1);
  } else {
    goBuild();
  }
});
resultSecondaryEl.addEventListener('click', () => {
  if (resultEl.dataset.kind === 'win') goBuild();
  else goMenu();
});

// ---- Controls wiring ----------------------------------------------------------
for (const b of matBtns) b.addEventListener('click', () => setMaterial(b.dataset.mat));
eraseBtn.addEventListener('click', () => setErasing(!erasing));
resetBtn.addEventListener('click', () => {
  if (screen !== 'build') return;
  resetBridge();
  updateBudget();
  saveBridge();
});
testBtn.addEventListener('click', startTest);
stopBtn.addEventListener('click', stopTest);
backBtn.addEventListener('click', () => {
  if (screen === 'test') stopTest();
  goMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key;
  if (screen === 'menu') return;
  if (k === ' ') {
    e.preventDefault();
    if (resultShown) resultPrimaryEl.click();
    else if (screen === 'build') startTest();
    else if (screen === 'test') stopTest();
    return;
  }
  if (screen !== 'build' || resultShown) return;
  if (k >= '1' && k <= '4') setMaterial(MAT_KEYS[+k - 1]);
  else if (k === 'e' || k === 'E') setErasing(!erasing);
  else if (k === 'r' || k === 'R') { resetBridge(); updateBudget(); saveBridge(); }
  else if (k === 'Escape') goMenu();
});

// ---- Pointer input ----------------------------------------------------------
function pointerWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: sx2w(e.clientX - r.left), y: sy2w(e.clientY - r.top) };
}

canvas.addEventListener('pointerdown', (e) => {
  if (screen !== 'build' || resultShown) return;
  canvas.setPointerCapture(e.pointerId);
  const p = pointerWorld(e);
  if (erasing) {
    const mi = memberAt(p.x, p.y);
    if (mi >= 0) deleteMember(mi);
    drag = { erase: true };
    return;
  }
  const from = snapPoint(p.x, p.y);
  drag = {
    from, x: p.x, y: p.y,
    moved: false, sx: e.clientX, sy: e.clientY,
  };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || screen !== 'build') return;
  const p = pointerWorld(e);
  if (drag.erase) {
    const mi = memberAt(p.x, p.y);
    if (mi >= 0) deleteMember(mi);
    return;
  }
  drag.x = p.x;
  drag.y = p.y;
  if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.moved = true;
});

canvas.addEventListener('pointerup', (e) => {
  if (!drag || screen !== 'build') { drag = null; return; }
  const d = drag;
  drag = null;
  if (d.erase) return;
  const p = pointerWorld(e);
  if (!d.moved) {
    // tap: delete a beam if the tap wasn't on a node
    const ni = nearestNode(p.x, p.y, 0.42);
    if (ni < 0) {
      const mi = memberAt(p.x, p.y);
      if (mi >= 0) deleteMember(mi);
    }
    return;
  }
  if (!d.from) return;
  const to = snapPoint(p.x, p.y);
  if (!to) return;
  placeMember(d.from, to, material);
});

canvas.addEventListener('pointercancel', () => { drag = null; });

// ---- Effects ----------------------------------------------------------------
function burst(m) {
  const a = sim.pts[m.a], b = sim.pts[m.b];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const col = COLORS[m.mat].base;
  // sparks
  for (let i = 0; i < 9; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 1.2 + Math.random() * 2.4;
    particles.push({
      kind: 'spark', x: mx, y: my,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 1,
      life: 0.45 + Math.random() * 0.3, age: 0, col,
    });
  }
  // two shards: the split halves
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  for (const s of [-1, 1]) {
    particles.push({
      kind: 'shard', x: mx + Math.cos(ang) * s * m.rest * 0.22, y: my + Math.sin(ang) * s * m.rest * 0.22,
      vx: Math.cos(ang + s * 0.6) * 0.8 * s, vy: -0.6 - Math.random() * 0.6,
      angle: ang, spin: s * (2 + Math.random() * 3),
      len: m.rest * 0.4, life: 0.9, age: 0, col, mat: m.mat,
    });
  }
  shake = Math.min(shake + 3, 5);
  navigator.vibrate?.(15);
}

function stepParticles(dt) {
  for (const p of particles) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 7 * dt;
    if (p.spin) p.angle += p.spin * dt;
  }
  particles = particles.filter((p) => p.age < p.life);
  shake = Math.max(0, shake - dt * 12);
}

// ---- Rendering ---------------------------------------------------------------
function draw(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
  }

  drawGrid();
  drawTerrain();
  drawStructures(now);
  drawMembers();
  drawNodes(now);
  if (drag && drag.from && drag.moved) drawPreview();
  if (sim) drawVehicles();
  drawParticles();
}

function drawGrid() {
  const b = { xMin: sx2w(-8), xMax: sx2w(cw + 8), yMin: sy2w(-8), yMax: sy2w(ch + 8) };
  const x0 = Math.ceil(b.xMin / GRID_STEP) * GRID_STEP;
  const y0 = Math.ceil(b.yMin / GRID_STEP) * GRID_STEP;
  ctx.lineWidth = 1;
  for (let gx = x0; gx <= b.xMax; gx += GRID_STEP) {
    const major = Math.abs(gx - Math.round(gx)) < 1e-6;
    ctx.strokeStyle = major ? 'rgba(96,165,250,.085)' : 'rgba(96,165,250,.035)';
    ctx.beginPath();
    ctx.moveTo(wx(gx), 0);
    ctx.lineTo(wx(gx), ch);
    ctx.stroke();
  }
  for (let gy = y0; gy <= b.yMax; gy += GRID_STEP) {
    const major = Math.abs(gy - Math.round(gy)) < 1e-6;
    ctx.strokeStyle = major ? 'rgba(96,165,250,.085)' : 'rgba(96,165,250,.035)';
    ctx.beginPath();
    ctx.moveTo(0, wy(gy));
    ctx.lineTo(cw, wy(gy));
    ctx.stroke();
  }
}

function terrainPath(kind) {
  // kind 'left' | 'right' | 'floor'
  ctx.beginPath();
  if (kind === 'left') {
    ctx.rect(-20, wy(level.leftTop), wx(0) + 20, wy(level.floorY) - wy(level.leftTop));
  } else if (kind === 'right') {
    ctx.rect(wx(level.gap), wy(level.rightTop), cw - wx(level.gap) + 20, wy(level.floorY) - wy(level.rightTop));
  } else {
    ctx.rect(-20, wy(level.floorY), cw + 40, ch - wy(level.floorY) + 20);
  }
}

function drawTerrain() {
  const grad = ctx.createLinearGradient(0, wy(Math.min(level.leftTop, level.rightTop) - 0.5), 0, ch);
  grad.addColorStop(0, '#1d3050');
  grad.addColorStop(1, '#111b2e');
  ctx.fillStyle = grad;
  for (const k of ['left', 'right', 'floor']) { terrainPath(k); ctx.fill(); }

  // hatching
  ctx.save();
  ctx.beginPath();
  ctx.rect(-20, wy(level.floorY), cw + 40, ch - wy(level.floorY) + 20);
  ctx.rect(-20, wy(level.leftTop), wx(0) + 20, wy(level.floorY) - wy(level.leftTop));
  ctx.rect(wx(level.gap), wy(level.rightTop), cw - wx(level.gap) + 20, wy(level.floorY) - wy(level.rightTop));
  ctx.clip();
  ctx.strokeStyle = 'rgba(96,165,250,.075)';
  ctx.lineWidth = 1;
  const step = 13;
  for (let x = -ch; x < cw + ch; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + ch, ch);
    ctx.stroke();
  }
  ctx.restore();

  // glowing edges
  ctx.strokeStyle = 'rgba(96,165,250,.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-20, wy(level.leftTop));
  ctx.lineTo(wx(0), wy(level.leftTop));
  ctx.lineTo(wx(0), wy(level.floorY));
  ctx.lineTo(wx(level.gap), wy(level.floorY));
  ctx.lineTo(wx(level.gap), wy(level.rightTop));
  ctx.lineTo(cw + 20, wy(level.rightTop));
  ctx.stroke();
}

function drawStructures(now) {
  // pillars
  for (const p of level.pillars) {
    const w = 0.24 * view.scale;
    const x = wx(p.x);
    const grad = ctx.createLinearGradient(x - w, 0, x + w, 0);
    grad.addColorStop(0, '#1a2a44');
    grad.addColorStop(0.5, '#273d61');
    grad.addColorStop(1, '#16233a');
    ctx.fillStyle = grad;
    ctx.fillRect(x - w, wy(0), w * 2, wy(level.floorY) - wy(0));
    ctx.strokeStyle = 'rgba(96,165,250,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w, wy(0), w * 2, wy(level.floorY) - wy(0));
  }
  // masts (tower anchors above the cliffs)
  for (const a of level.extraAnchors) {
    if (!a.mast) continue;
    const baseY = a.x <= 0 ? level.leftTop : a.x >= level.gap ? level.rightTop : level.floorY;
    const x = wx(a.x);
    const w = 0.14 * view.scale;
    const grad = ctx.createLinearGradient(x - w, 0, x + w, 0);
    grad.addColorStop(0, '#1a2a44');
    grad.addColorStop(0.5, '#2c4269');
    grad.addColorStop(1, '#16233a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x - w, wy(baseY));
    ctx.lineTo(x - w * 0.55, wy(a.y));
    ctx.lineTo(x + w * 0.55, wy(a.y));
    ctx.lineTo(x + w, wy(baseY));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(96,165,250,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function memberEnds(m) {
  if (sim) {
    return [sim.pts[m.a], sim.pts[m.b]];
  }
  return [bridge.nodes[m.a], bridge.nodes[m.b]];
}

function drawMembers() {
  const mems = sim ? sim.mems : bridge.members;
  // cables under everything, then wood/steel, road on top
  const order = { cable: 0, wood: 1, steel: 1, road: 2 };
  const sorted = [...mems].sort((a, b) => order[a.mat] - order[b.mat]);
  for (const m of sorted) {
    if (m.broken) continue;
    const [a, b] = memberEnds(m);
    const s = sim ? Math.min(m.stress, 1) : 0;
    const u = view.scale;
    if (m.mat === 'cable') {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const slack = sim && m.rest - d > 0.005;
      ctx.strokeStyle = sim ? stressColor(RGB.cable, s) : COLORS.cable.base;
      ctx.globalAlpha = slack ? 0.45 : 0.9;
      ctx.lineWidth = Math.max(1, 0.035 * u);
      ctx.beginPath();
      ctx.moveTo(wx(a.x), wy(a.y));
      if (slack) {
        const sag = (m.rest - d) * 0.9 + 0.06;
        ctx.quadraticCurveTo(wx((a.x + b.x) / 2), wy((a.y + b.y) / 2 + sag), wx(b.x), wy(b.y));
      } else {
        ctx.lineTo(wx(b.x), wy(b.y));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (m.mat === 'road') {
      // body
      ctx.strokeStyle = sim ? stressColor(RGB.road, s) : COLORS.road.base;
      ctx.lineWidth = Math.max(2.5, 0.15 * u);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wx(a.x), wy(a.y));
      ctx.lineTo(wx(b.x), wy(b.y));
      ctx.stroke();
      // bright running surface
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / d, ny = (b.x - a.x) / d;
      const off = 0.05 * u;
      ctx.strokeStyle = sim ? stressColor(RGB.deck, s) : COLORS.road.deck;
      ctx.lineWidth = Math.max(1.2, 0.045 * u);
      ctx.beginPath();
      ctx.moveTo(wx(a.x) - nx * off, wy(a.y) - ny * off);
      ctx.lineTo(wx(b.x) - nx * off, wy(b.y) - ny * off);
      ctx.stroke();
    } else {
      ctx.strokeStyle = sim ? stressColor(RGB[m.mat], s) : COLORS[m.mat].base;
      ctx.lineWidth = Math.max(1.8, (m.mat === 'steel' ? 0.1 : 0.085) * u);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(wx(a.x), wy(a.y));
      ctx.lineTo(wx(b.x), wy(b.y));
      ctx.stroke();
    }
  }
  ctx.lineCap = 'butt';
}

function drawNodes(now) {
  const u = view.scale;
  // free nodes
  for (let i = anchorCount; i < bridge.nodes.length; i++) {
    const n = sim ? sim.pts[i] : bridge.nodes[i];
    ctx.fillStyle = '#e3ecfa';
    ctx.beginPath();
    ctx.arc(wx(n.x), wy(n.y), Math.max(2.4, 0.065 * u), 0, Math.PI * 2);
    ctx.fill();
  }
  // anchors: glowing rings
  const pulse = screen === 'build' ? 0.55 + 0.25 * Math.sin(now / 480) : 0.6;
  for (let i = 0; i < anchorCount; i++) {
    const n = bridge.nodes[i];
    const x = wx(n.x), y = wy(n.y);
    ctx.fillStyle = 'rgba(96,165,250,.16)';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(7, 0.2 * u), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(147,197,253,${pulse})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(4.5, 0.12 * u), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#bfdbfe';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, 0.045 * u), 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPreview() {
  const from = drag.from;
  const to = snapPoint(drag.x, drag.y);
  const u = view.scale;
  const end = to || { x: drag.x, y: drag.y };
  const c = to ? checkMember(from, end, material) : { ok: false, reason: '', cost: 0, len: 0 };
  const affordable = spent + c.cost <= level.budget;
  const good = c.ok && to && affordable;
  const col = good ? COLORS[material].base : '#ef4444';

  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = Math.max(1.5, 0.05 * u);
  ctx.beginPath();
  ctx.moveTo(wx(from.x), wy(from.y));
  ctx.lineTo(wx(end.x), wy(end.y));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // endpoint marker
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(wx(end.x), wy(end.y), Math.max(4, 0.11 * u), 0, Math.PI * 2);
  ctx.stroke();

  // cost bubble
  if (c.len >= 0.4) {
    const label = c.reason === 'too long' ? 'too long'
      : c.reason === 'built' ? 'built'
      : `$${c.cost}`;
    const mx = (wx(from.x) + wx(end.x)) / 2;
    const my = (wy(from.y) + wy(end.y)) / 2 - 14;
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(10,14,24,.85)';
    ctx.beginPath();
    ctx.roundRect(mx - tw / 2 - 7, my - 10, tw + 14, 19, 9);
    ctx.fill();
    ctx.fillStyle = good ? '#cfe0f5' : '#fca5a5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my);
  }
}

function drawVehicles() {
  const u = view.scale;
  for (let vi = 0; vi < sim.vehs.length; vi++) {
    const v = sim.vehs[vi];
    if (!v.active && vi > 0) continue; // later vehicles appear when launched
    const spec = v.spec;
    const w0 = sim.pts[v.wheelIdx[0]];
    const wN = sim.pts[v.wheelIdx[v.wheelIdx.length - 1]];
    const mx = (w0.x + wN.x) / 2, my = (w0.y + wN.y) / 2;
    const ang = Math.atan2(wN.y - w0.y, wN.x - w0.x);
    const truck = spec.wheels.length > 2;

    ctx.save();
    ctx.translate(wx(mx), wy(my));
    ctx.rotate(ang);

    // body
    const bw = (truck ? 2.75 : 1.85) * u;
    const bh = (truck ? 0.62 : 0.42) * u;
    const by = -(spec.r + (truck ? 0.42 : 0.32)) * u;
    ctx.fillStyle = truck ? '#8aa8cc' : '#60a5fa';
    ctx.beginPath();
    ctx.roundRect(-bw / 2, by - bh / 2, bw, bh, 0.12 * u);
    ctx.fill();
    if (truck) {
      // cab
      ctx.fillStyle = '#60a5fa';
      ctx.beginPath();
      ctx.roundRect(bw * 0.22, by - bh * 0.95, bw * 0.26, bh * 0.75, 0.08 * u);
      ctx.fill();
      ctx.fillStyle = '#0e1626';
      ctx.beginPath();
      ctx.roundRect(bw * 0.32, by - bh * 0.85, bw * 0.13, bh * 0.42, 2);
      ctx.fill();
      // cargo
      ctx.fillStyle = '#33517c';
      ctx.beginPath();
      ctx.roundRect(-bw * 0.48, by - bh * 1.05, bw * 0.62, bh * 0.85, 0.08 * u);
      ctx.fill();
    } else {
      // cabin
      ctx.fillStyle = '#93c5fd';
      ctx.beginPath();
      ctx.roundRect(-bw * 0.22, by - bh * 0.85, bw * 0.44, bh * 0.8, 0.1 * u);
      ctx.fill();
      ctx.fillStyle = '#0e1626';
      ctx.beginPath();
      ctx.roundRect(-bw * 0.16, by - bh * 0.75, bw * 0.32, bh * 0.5, 2);
      ctx.fill();
    }
    ctx.restore();

    // wheels (world space: they are real point masses)
    for (const wi of v.wheelIdx) {
      const p = sim.pts[wi];
      const r = spec.r * u;
      ctx.fillStyle = '#131c2e';
      ctx.beginPath();
      ctx.arc(wx(p.x), wy(p.y), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#9fc1f7';
      ctx.lineWidth = Math.max(1.4, r * 0.22);
      ctx.beginPath();
      ctx.arc(wx(p.x), wy(p.y), r * 0.82, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#9fc1f7';
      ctx.beginPath();
      ctx.arc(wx(p.x), wy(p.y), r * 0.24, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawParticles() {
  const u = view.scale;
  for (const p of particles) {
    const t = 1 - p.age / p.life;
    ctx.globalAlpha = t;
    if (p.kind === 'spark') {
      ctx.strokeStyle = p.col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(wx(p.x), wy(p.y));
      ctx.lineTo(wx(p.x - p.vx * 0.03), wy(p.y - p.vy * 0.03));
      ctx.stroke();
    } else {
      ctx.save();
      ctx.translate(wx(p.x), wy(p.y));
      ctx.rotate(p.angle);
      ctx.strokeStyle = p.col;
      ctx.lineWidth = Math.max(2, (p.mat === 'cable' ? 0.035 : 0.09) * u);
      ctx.beginPath();
      ctx.moveTo(-p.len * u / 2, 0);
      ctx.lineTo(p.len * u / 2, 0);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

// ---- Main loop ----------------------------------------------------------------
let simAcc = 0;
let lastTs = 0;

function frame(now) {
  const dt = Math.min((now - lastTs) / 1000, 0.1);
  lastTs = now;

  if (screen === 'test' && sim) {
    if (sim.status === 'running') {
      simAcc += dt;
      let steps = 0;
      while (simAcc >= DT && steps < 4) {
        sim.step();
        for (const m of sim.breakEvents) burst(m);
        simAcc -= DT;
        steps++;
      }
      if (simAcc >= DT) simAcc = 0; // can't keep up: drop time, stay deterministic
      if (sim.status !== 'running') {
        resultTimer = now + (sim.status === 'passed' ? 700 : 650);
      }
    } else if (!resultShown && now >= resultTimer) {
      onTestEnd();
    }
  }

  if (introTimer && now > introTimer && screen === 'build') {
    introEl.classList.add('hide');
    introTimer = 0;
  }

  stepParticles(dt);
  if (screen !== 'menu') draw(now);
  requestAnimationFrame(frame);
}

// ---- Test hook (headless verification) ----------------------------------------
window.__test = {
  levels: LEVELS.length,
  load(n) {
    localStorage.removeItem(BRIDGE_KEY + n);
    openLevel(n);
    resetBridge();
    updateBudget();
  },
  clear() {
    resetBridge();
    updateBudget();
  },
  // segs: [[x1,y1,x2,y2,mat], ...] — placed through the real validation path
  place(segs) {
    const errors = [];
    for (const [x1, y1, x2, y2, mat] of segs) {
      const find = (x, y) => {
        const ni = nearestNode(x, y, 0.05);
        return ni >= 0 ? { node: ni, x: bridge.nodes[ni].x, y: bridge.nodes[ni].y } : { node: -1, x, y };
      };
      const from = find(x1, y1), to = find(x2, y2);
      if (from.node < 0 && !validNodePos(x1, y1)) { errors.push(`invalid node ${x1},${y1}`); continue; }
      if (to.node < 0 && !validNodePos(x2, y2)) { errors.push(`invalid node ${x2},${y2}`); continue; }
      if (!placeMember(from, to, mat)) errors.push(`rejected ${mat} ${x1},${y1}->${x2},${y2}`);
    }
    return { spent, budgetLeft: level.budget - spent, errors };
  },
  // fast-forward a full test; returns the summary and restores build mode
  run(maxT = 45) {
    const s = createSim(level, bridge);
    const maxSteps = Math.ceil(maxT / DT);
    for (let i = 0; i < maxSteps && s.status === 'running'; i++) s.step();
    return {
      passed: s.status === 'passed',
      status: s.status,
      failReason: s.failReason,
      brokenMembers: s.brokenCount,
      budgetLeft: level.budget - spent,
      t: Math.round(s.t * 100) / 100,
    };
  },
  state() {
    return {
      screen, level: levelIndex, spent, budget: level.budget, unlocked,
      best: { ...best }, members: bridge.members.length,
    };
  },
  // world -> client coords (for driving pointer input in tests)
  screenPos(x, y) {
    const r = canvas.getBoundingClientRect();
    return { x: r.left + wx(x), y: r.top + wy(y) };
  },
};

// ---- Install button (per spec) -------------------------------------------------
(() => {
  const btn = document.getElementById('install');
  const tip = document.getElementById('install-tip');
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferred = null;
  addEventListener('beforeinstallprompt', (e) => {
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
  addEventListener('appinstalled', () => { btn.hidden = true; });
})();

// ---- Boot ----------------------------------------------------------------------
level = LEVELS[0];
resetBridge();
sizeCanvas();
goMenu();
requestAnimationFrame((t) => { lastTs = t; requestAnimationFrame(frame); });

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}
