import { installPause } from './pause.js';
// Glide — a night-flight paper plane game.
// Airplane Mode collection. Fully offline, canvas 2D.

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---------- DOM ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');
const scoreEl = document.getElementById('score');
const startOverlay = document.getElementById('start-overlay');
const overOverlay = document.getElementById('over-overlay');
const finalScoreEl = document.getElementById('final-score');
const bestScoreEl = document.getElementById('best-score');
const newBestEl = document.getElementById('new-best');

const BEST_KEY = 'am.glide.best';

// ---------- Utilities ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = Math.PI / 180;

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

// ---------- View / geometry ----------
let W = 0, H = 0, dpr = 1;
let planeSize = 30, planeX = 120, towerW = 80, mistH = 60, mistTop = 0;
let speed = 180, spacing = 300, introOffset = 240;

// physics constants (recomputed on resize, tuned to viewport height)
let GRAVITY = 0, FLAP = 0, MAXFALL = 0;

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  planeSize = clamp(H * 0.055, 26, 46);
  planeX = Math.min(W * 0.30, 170);
  towerW = clamp(W * 0.17, 60, 104);
  mistH = H * 0.09;
  mistTop = H - mistH;

  speed = clamp(W * 0.42, 155, 300);
  spacing = clamp(W * 0.72, 250, 470);
  introOffset = W * 0.55;

  GRAVITY = H * 2.2;
  FLAP = -H * 0.62;
  MAXFALL = H * 0.92;

  buildParallax();
}

// ---------- Parallax fields ----------
let stars = [];
let hills = [];
let mistBlobs = [];

function buildParallax() {
  stars = [];
  const starCount = clamp(Math.round((W * H) / 8500), 30, 110);
  for (let i = 0; i < starCount; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H * 0.82,
      r: rand(0.5, 1.7),
      a: rand(0.25, 0.9),
      tw: rand(0, Math.PI * 2),
      ts: rand(0.6, 1.8),
    });
  }

  hills = [];
  const hillField = W * 1.6;
  let hx = 0;
  while (hx < hillField) {
    const w = rand(W * 0.35, W * 0.7);
    hills.push({
      x: hx + w * 0.5,
      w,
      h: rand(H * 0.14, H * 0.30),
      base: rand(H * 0.58, H * 0.80),
      shade: rand(0.5, 1),
    });
    hx += w * rand(0.62, 0.9);
  }
  hillFieldW = hx;

  mistBlobs = [];
  const mField = W * 1.4;
  for (let i = 0; i < 8; i++) {
    mistBlobs.push({
      x: Math.random() * mField,
      y: mistTop + rand(-mistH * 0.3, mistH * 0.5),
      rx: rand(W * 0.2, W * 0.42),
      ry: rand(mistH * 0.5, mistH * 1.1),
      a: rand(0.05, 0.14),
    });
  }
  mistFieldW = mField;
}
let hillFieldW = 0, mistFieldW = 0;

// ---------- Game state ----------
const START = 'start', PLAYING = 'playing', DYING = 'dying', OVER = 'over';
let state = START;

let plane = { y: 0, vy: 0, angle: 0, spin: 0 };
let towers = [];
let trail = [];
let score = 0;
let best = loadBest();
let worldScroll = 0;
let flashAlpha = 0;
let dyingTimer = 0;
let trailTimer = 0;
let idleT = 0;

function curGap() {
  const startGap = H * 0.32;
  const minGap = H * 0.18;
  return Math.max(minGap, startGap - score * (H * 0.007));
}

function spawnTower(x) {
  const gapH = curGap();
  let minC = gapH / 2 + H * 0.08;
  let maxC = mistTop - gapH / 2 - H * 0.06;
  let center;
  if (minC >= maxC) center = (minC + maxC) / 2;
  else center = rand(minC, maxC);
  towers.push({
    x,
    gapTop: center - gapH / 2,
    gapBottom: center + gapH / 2,
    passed: false,
  });
}

function resetPlay() {
  towers = [];
  trail = [];
  score = 0;
  plane.y = H * 0.42;
  plane.vy = 0;
  plane.angle = 0;
  plane.spin = 0;
  dyingTimer = 0;
  trailTimer = 0;
  spawnTower(W + introOffset);
  scoreEl.textContent = '0';
}

function flap() {
  plane.vy = FLAP;
}

function startGame() {
  resetPlay();
  state = PLAYING;
  startOverlay.hidden = true;
  overOverlay.hidden = true;
  scoreEl.classList.add('show');
  flap();
  vibrate(10);
}

function restart() {
  resetPlay();
  state = PLAYING;
  overOverlay.hidden = true;
  scoreEl.classList.add('show');
  flashAlpha = 0;
  flap();
  vibrate(10);
}

function die() {
  if (state !== PLAYING) return;
  state = DYING;
  dyingTimer = 0;
  flashAlpha = 0.9;
  plane.spin = (plane.vy < 0 ? -1 : 1) * rand(5, 8);
  if (plane.vy < FLAP * 0.4) plane.vy = FLAP * 0.4;
  vibrate(30);
}

function gameOver() {
  state = OVER;
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

function popScore() {
  scoreEl.textContent = String(score);
  scoreEl.classList.remove('pop');
  void scoreEl.offsetWidth;
  scoreEl.classList.add('pop');
}

// ---------- Input ----------
function handleTap() {
  switch (state) {
    case START: startGame(); break;
    case PLAYING: flap(); vibrate(10); break;
    case OVER: restart(); break;
    // DYING ignores input
  }
}

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handleTap();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'Enter') {
    e.preventDefault();
    handleTap();
  } else if (e.code === 'KeyR') {
    if (state === OVER) restart();
  }
});

// ---------- Collision ----------
function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = clamp(cx, rx, rx + rw);
  const ny = clamp(cy, ry, ry + rh);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

function checkCollision() {
  const r = planeSize * 0.35; // forgiving ~70% hitbox
  const cx = planeX, cy = plane.y;

  if (cy - r <= 0) return true;            // ceiling
  if (cy + r >= mistTop) return true;      // floor mist

  for (const t of towers) {
    if (t.x + towerW < cx - r || t.x > cx + r) continue;
    if (circleRect(cx, cy, r, t.x, 0, towerW, t.gapTop)) return true;
    if (circleRect(cx, cy, r, t.x, t.gapBottom, towerW, H - t.gapBottom)) return true;
  }
  return false;
}

// ---------- Update ----------
function update(dt) {
  // background scroll speed by state
  let bgSpeed;
  if (state === PLAYING) bgSpeed = speed;
  else if (state === DYING) bgSpeed = speed * 0.35;
  else bgSpeed = speed * 0.3; // ambient drift on menus
  worldScroll += bgSpeed * dt;

  // twinkle
  for (const s of stars) s.tw += s.ts * dt;

  if (state === START || state === OVER) {
    idleT += dt;
    if (state === START) {
      plane.y = H * 0.46 + Math.sin(idleT * 2.0) * H * 0.02;
      plane.angle = Math.sin(idleT * 2.0 + Math.PI / 2) * 6 * DEG;
    }
  }

  if (state === PLAYING) {
    plane.vy = clamp(plane.vy + GRAVITY * dt, -Infinity, MAXFALL);
    plane.y += plane.vy * dt;

    // rotation follows vertical velocity
    let target;
    if (plane.vy < 0) target = -25 * DEG * clamp(-plane.vy / (-FLAP), 0, 1);
    else target = 65 * DEG * clamp(plane.vy / MAXFALL, 0, 1);
    plane.angle += (target - plane.angle) * clamp(dt * 12, 0, 1);

    // move towers
    for (const t of towers) t.x -= speed * dt;
    // recycle passed towers off-screen
    while (towers.length && towers[0].x + towerW < -20) towers.shift();
    // spawn
    const newest = towers[towers.length - 1];
    if (!newest) spawnTower(W + introOffset);
    else if (newest.x <= W - spacing) spawnTower(newest.x + spacing);

    // scoring
    for (const t of towers) {
      if (!t.passed && t.x + towerW < planeX) {
        t.passed = true;
        score++;
        popScore();
        vibrate(10);
      }
    }

    if (checkCollision()) die();
  } else if (state === DYING) {
    plane.vy = clamp(plane.vy + GRAVITY * dt, -Infinity, MAXFALL);
    plane.y += plane.vy * dt;
    plane.angle += plane.spin * dt;
    for (const t of towers) t.x -= speed * 0.35 * dt;
    dyingTimer += dt;
    if (dyingTimer >= 0.42) gameOver();
  }

  // trail
  if (state === PLAYING || state === DYING) {
    for (const p of trail) { p.x -= speed * dt; p.life -= dt; }
    while (trail.length && trail[0].life <= 0) trail.shift();
    trailTimer += dt;
    if (trailTimer >= 0.022) {
      trailTimer = 0;
      trail.push({ x: planeX - planeSize * 0.4, y: plane.y, life: 0.5 });
      if (trail.length > 26) trail.shift();
    }
  }

  if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt * 5.5);
}

// ---------- Rendering ----------
function drawBackground() {
  // dusk gradient
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#241638');
  g.addColorStop(0.42, '#150f22');
  g.addColorStop(1, '#08080d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // faint rose horizon glow low-center
  const rg = ctx.createRadialGradient(W * 0.5, H * 0.9, 0, W * 0.5, H * 0.9, H * 0.6);
  rg.addColorStop(0, 'rgba(251,113,133,0.10)');
  rg.addColorStop(1, 'rgba(251,113,133,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);

  // far stars
  const so = worldScroll * 0.08;
  for (const s of stars) {
    let sx = ((s.x - so) % W + W) % W;
    const tw = 0.6 + 0.4 * Math.sin(s.tw);
    ctx.globalAlpha = s.a * tw;
    ctx.fillStyle = '#e9e6ff';
    ctx.beginPath();
    ctx.arc(sx, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // mid silhouettes (rounded skyline / cloud banks)
  const ho = worldScroll * 0.28;
  for (const hl of hills) {
    let base = ((hl.x - ho) % hillFieldW + hillFieldW) % hillFieldW;
    for (let k = -1; k <= 1; k++) {
      const cx = base + k * hillFieldW;
      if (cx + hl.w < 0 || cx - hl.w > W) continue;
      drawHill(cx, hl);
    }
  }
}

function drawHill(cx, hl) {
  const top = hl.base - hl.h;
  const left = cx - hl.w / 2;
  const right = cx + hl.w / 2;
  const r = Math.min(hl.h, hl.w / 2);
  ctx.beginPath();
  ctx.moveTo(left, H);
  ctx.lineTo(left, top + r);
  ctx.quadraticCurveTo(left, top, left + r, top);
  ctx.lineTo(right - r, top);
  ctx.quadraticCurveTo(right, top, right, top + r);
  ctx.lineTo(right, H);
  ctx.closePath();
  const shade = hl.shade;
  const g = ctx.createLinearGradient(0, top, 0, H);
  g.addColorStop(0, `rgba(${Math.round(60 * shade + 26)},${Math.round(48 * shade + 22)},${Math.round(86 * shade + 30)},0.55)`);
  g.addColorStop(1, 'rgba(14,12,22,0.15)');
  ctx.fillStyle = g;
  ctx.fill();
}

function drawMist() {
  // drifting soft blobs
  const mo = worldScroll * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, mistTop - mistH * 0.6, W, mistH * 1.8 + 4);
  ctx.clip();
  for (const b of mistBlobs) {
    let sx = ((b.x - mo) % mistFieldW + mistFieldW) % mistFieldW;
    for (let k = -1; k <= 1; k++) {
      const cx = sx + k * mistFieldW;
      if (cx + b.rx < 0 || cx - b.rx > W) continue;
      const g = ctx.createRadialGradient(cx, b.y, 0, cx, b.y, b.rx);
      g.addColorStop(0, `rgba(200,170,210,${b.a})`);
      g.addColorStop(1, 'rgba(200,170,210,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, b.y, b.rx, b.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // solid mist band gradient at very bottom
  const g = ctx.createLinearGradient(0, mistTop, 0, H);
  g.addColorStop(0, 'rgba(90,70,110,0)');
  g.addColorStop(0.5, 'rgba(80,64,104,0.16)');
  g.addColorStop(1, 'rgba(40,30,54,0.34)');
  ctx.fillStyle = g;
  ctx.fillRect(0, mistTop, W, mistH);
}

function towerTopPath(x, w, top, bot, r) {
  r = Math.min(r, w / 2, Math.max(0, bot - top));
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x + w, top);
  ctx.lineTo(x + w, bot - r);
  ctx.quadraticCurveTo(x + w, bot, x + w - r, bot);
  ctx.lineTo(x + r, bot);
  ctx.quadraticCurveTo(x, bot, x, bot - r);
  ctx.closePath();
}

function towerBottomPath(x, w, top, bot, r) {
  r = Math.min(r, w / 2, Math.max(0, bot - top));
  ctx.beginPath();
  ctx.moveTo(x, bot);
  ctx.lineTo(x, top + r);
  ctx.quadraticCurveTo(x, top, x + r, top);
  ctx.lineTo(x + w - r, top);
  ctx.quadraticCurveTo(x + w, top, x + w, top + r);
  ctx.lineTo(x + w, bot);
  ctx.closePath();
}

function fillTowerBody(x, top, bot) {
  const g = ctx.createLinearGradient(x, 0, x + towerW, 0);
  g.addColorStop(0, '#16121f');
  g.addColorStop(0.5, '#0e0b16');
  g.addColorStop(1, '#0a0810');
  ctx.fillStyle = g;
  ctx.fill();
}

function drawTower(t) {
  const x = t.x;
  const r = towerW * 0.5;

  // ----- top monolith (hangs from ceiling) -----
  towerTopPath(x, towerW, 0, t.gapTop, r);
  fillTowerBody(x, 0, t.gapTop);
  // left edge sheen
  ctx.save();
  towerTopPath(x, towerW, 0, t.gapTop, r);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(x, 0, 2, t.gapTop);
  // rim glow gradient rising into the tower from the gap edge
  const glowH = Math.min(H * 0.05, t.gapTop);
  const tg = ctx.createLinearGradient(0, t.gapTop - glowH, 0, t.gapTop);
  tg.addColorStop(0, 'rgba(251,113,133,0)');
  tg.addColorStop(1, 'rgba(251,113,133,0.28)');
  ctx.fillStyle = tg;
  ctx.fillRect(x, t.gapTop - glowH, towerW, glowH);
  ctx.restore();
  // crisp rim line
  ctx.save();
  ctx.strokeStyle = 'rgba(251,113,133,0.9)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(251,113,133,0.8)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x + r, t.gapTop);
  ctx.lineTo(x + towerW - r, t.gapTop);
  ctx.stroke();
  ctx.restore();

  // ----- bottom monolith (rises from floor) -----
  towerBottomPath(x, towerW, t.gapBottom, H, r);
  fillTowerBody(x, t.gapBottom, H);
  ctx.save();
  towerBottomPath(x, towerW, t.gapBottom, H, r);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(x, t.gapBottom, 2, H - t.gapBottom);
  const glowH2 = Math.min(H * 0.05, H - t.gapBottom);
  const bg = ctx.createLinearGradient(0, t.gapBottom, 0, t.gapBottom + glowH2);
  bg.addColorStop(0, 'rgba(251,113,133,0.28)');
  bg.addColorStop(1, 'rgba(251,113,133,0)');
  ctx.fillStyle = bg;
  ctx.fillRect(x, t.gapBottom, towerW, glowH2);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(251,113,133,0.9)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(251,113,133,0.8)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x + r, t.gapBottom);
  ctx.lineTo(x + towerW - r, t.gapBottom);
  ctx.stroke();
  ctx.restore();
}

function drawTrail() {
  for (const p of trail) {
    const a = (p.life / 0.5) * 0.5;
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd6de';
    ctx.beginPath();
    ctx.arc(p.x, p.y, planeSize * 0.09 * (0.4 + p.life), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPlane() {
  const s = planeSize;
  ctx.save();
  ctx.translate(planeX, plane.y);
  ctx.rotate(plane.angle);

  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;

  const nose = [s * 0.62, 0];
  const tailTop = [-s * 0.5, -s * 0.34];
  const tailBot = [-s * 0.5, s * 0.34];
  const notch = [-s * 0.24, 0];

  // upper wing (lit)
  ctx.beginPath();
  ctx.moveTo(nose[0], nose[1]);
  ctx.lineTo(tailTop[0], tailTop[1]);
  ctx.lineTo(notch[0], notch[1]);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // lower wing (shaded)
  ctx.beginPath();
  ctx.moveTo(nose[0], nose[1]);
  ctx.lineTo(tailBot[0], tailBot[1]);
  ctx.lineTo(notch[0], notch[1]);
  ctx.closePath();
  ctx.fillStyle = '#c9cfdb';
  ctx.fill();

  // center crease
  ctx.strokeStyle = 'rgba(120,130,150,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(nose[0], nose[1]);
  ctx.lineTo(notch[0], notch[1]);
  ctx.stroke();

  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawBackground();
  for (const t of towers) drawTower(t);
  drawMist();
  drawTrail();
  drawPlane();

  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flashAlpha})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------- Loop ----------
let lastT = performance.now();
function frame(now) {
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (pause.active) { requestAnimationFrame(frame); return; }
  if (document.hidden) {
    requestAnimationFrame(frame);
    return;
  }
  dt = clamp(dt, 0, 0.033);
  update(dt);
  render();
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) lastT = performance.now();
});

window.addEventListener('resize', resize);

// ---------- Boot ----------
resize();
bestScoreEl.textContent = String(best);
plane.y = H * 0.46;
const pause = installPause({ canPause: () => state === PLAYING });
requestAnimationFrame(frame);
