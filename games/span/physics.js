// Span — deterministic Verlet bridge physics. Pure module: no DOM, no Math.random.
// World units: 1 unit = 1 m (grid). y grows downward (matches canvas).

export const GRID_STEP = 0.5;
export const GRAVITY = 10;
export const DT = 1 / 60;
export const ITERATIONS = 8;
const DRAG = 0.996;
const SETTLE_TIME = 0.8; // bridge settles under own weight before the first vehicle

// Materials. strength = max sustained strain (|len-rest|/rest) before breaking.
// Steel ~2.5x wood cost, ~3x strength, heavier. Cable: tension only, goes slack.
export const MATS = {
  road:  { key: 'road',  label: 'Road',  cost: 16, weight: 1.0,  strength: 0.0028, maxLen: 2.25, drivable: true },
  wood:  { key: 'wood',  label: 'Wood',  cost: 12, weight: 0.45, strength: 0.006,  maxLen: 3.25 },
  steel: { key: 'steel', label: 'Steel', cost: 30, weight: 1.3,  strength: 0.018,  maxLen: 4.25 },
  cable: { key: 'cable', label: 'Cable', cost: 8,  weight: 0.06, strength: 0.006,  maxLen: 6, tensionOnly: true },
};

export const MAT_KEYS = ['road', 'wood', 'steel', 'cable'];

// Breaking uses a smoothed stress signal so one-frame impact spikes (a wheel
// dropping onto the deck edge) don't snap otherwise-sound members.
const STRESS_SMOOTH = 0.15;

export const VEHICLES = {
  car:   { wheels: [-0.75, 0.75],       r: 0.32, wheelM: 4,  chassisM: 5,  chassisH: 0.78, speed: 2.4, accel: 5 },
  truck: { wheels: [-1.05, 0.05, 1.05], r: 0.36, wheelM: 9,  chassisM: 15, chassisH: 0.92, speed: 1.9, accel: 3.5 },
};

export function memberCost(len, mat) {
  return Math.round(len * MATS[mat].cost);
}

export function bridgeCost(bridge) {
  let c = 0;
  for (const m of bridge.members) {
    const a = bridge.nodes[m.a], b = bridge.nodes[m.b];
    c += memberCost(Math.hypot(b.x - a.x, b.y - a.y), m.mat);
  }
  return c;
}

// level: { gap, leftTop, rightTop, floorY, killY?, vehicle, vehicles?, vehicleGap?, timeLimit? }
// bridge: { nodes: [{x, y, fixed}], members: [{a, b, mat}] }
export function createSim(level, bridge) {
  const pts = [];
  for (const n of bridge.nodes) {
    pts.push({
      x: n.x, y: n.y, px: n.x, py: n.y,
      mass: 0.4, im: 0, fixed: !!n.fixed,
      vehicle: -1, r: 0, grounded: false,
    });
  }

  const mems = [];
  for (const m of bridge.members) {
    const a = pts[m.a], b = pts[m.b];
    const rest = Math.hypot(b.x - a.x, b.y - a.y);
    mems.push({ a: m.a, b: m.b, mat: m.mat, rest, stress: 0, peak: 0, broken: false });
    const half = MATS[m.mat].weight * rest * 0.5;
    pts[m.a].mass += half;
    pts[m.b].mass += half;
  }
  for (const p of pts) p.im = p.fixed ? 0 : 1 / p.mass;

  // Vehicles
  const spec = VEHICLES[level.vehicle || 'car'];
  const count = level.vehicles || 1;
  const vehs = [];
  for (let i = 0; i < count; i++) {
    const cx = -2.5, top = level.leftTop;
    const wheelIdx = [];
    for (const off of spec.wheels) {
      pts.push({
        x: cx + off, y: top - spec.r, px: cx + off, py: top - spec.r,
        mass: spec.wheelM, im: 1 / spec.wheelM, fixed: false,
        vehicle: i, r: spec.r, grounded: false,
      });
      wheelIdx.push(pts.length - 1);
    }
    pts.push({
      x: cx, y: top - spec.r - spec.chassisH, px: cx, py: top - spec.r - spec.chassisH,
      mass: spec.chassisM, im: 1 / spec.chassisM, fixed: false,
      vehicle: i, r: 0, grounded: false,
    });
    const chassis = pts.length - 1;
    const all = [...wheelIdx, chassis];
    const links = [];
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const A = pts[all[a]], B = pts[all[b]];
        links.push({ a: all[a], b: all[b], rest: Math.hypot(B.x - A.x, B.y - A.y) });
      }
    }
    vehs.push({
      wheelIdx, chassis, links, spec,
      delay: SETTLE_TIME + i * (level.vehicleGap ?? 3.2),
      active: false, done: false,
    });
  }

  const terrain = [
    { ax: -100, ay: level.leftTop, bx: 0, by: level.leftTop },
    { ax: level.gap, ay: level.rightTop, bx: level.gap + 100, by: level.rightTop },
  ];
  const killY = level.killY ?? (level.floorY + 0.6);
  const timeLimit = level.timeLimit ?? 40;
  const winX = level.gap + 1.0;

  const sim = {
    pts, mems, vehs, level,
    t: 0,
    status: 'running', // 'running' | 'passed' | 'failed'
    failReason: '',
    breakEvents: [],   // members broken this step (for effects)
    brokenCount: 0,
    step,
  };

  function solveMember(m) {
    if (m.broken) return;
    const a = pts[m.a], b = pts[m.b];
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-9;
    const diff = (d - m.rest) / d;
    if (MATS[m.mat].tensionOnly && diff < 0) return; // slack cable
    const w = a.im + b.im;
    if (w === 0) return;
    const f = diff / w;
    a.x += dx * f * a.im; a.y += dy * f * a.im;
    b.x -= dx * f * b.im; b.y -= dy * f * b.im;
  }

  function solveRigid(l) {
    const a = pts[l.a], b = pts[l.b];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1e-9;
    const diff = (d - l.rest) / d;
    const w = a.im + b.im;
    const f = diff / w;
    a.x += dx * f * a.im; a.y += dy * f * a.im;
    b.x -= dx * f * b.im; b.y -= dy * f * b.im;
  }

  // Capsule collision: wheel point (with radius) vs a segment between two points.
  function collideWheelSeg(p, ax, ay, bx, by, imA, imB, nA, nB) {
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby || 1e-9;
    let t = ((p.x - ax) * abx + (p.y - ay) * aby) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + abx * t, cy = ay + aby * t;
    let dx = p.x - cx, dy = p.y - cy;
    let d = Math.hypot(dx, dy);
    if (d >= p.r) return;
    if (d < 1e-9) { dx = 0; dy = -1; d = 1e-9; }
    const nx = dx / d, ny = dy / d;
    const pen = p.r - d;
    const segIm = (imA * (1 - t) * (1 - t) + imB * t * t);
    const total = p.im + segIm;
    if (total === 0) return;
    const wPart = p.im / total;
    p.x += nx * pen * wPart;
    p.y += ny * pen * wPart;
    if (segIm > 0) {
      const push = pen * (1 - wPart);
      const denom = imA * (1 - t) * (1 - t) + imB * t * t || 1e-9;
      const lambda = push / denom;
      nA.x -= nx * lambda * imA * (1 - t); nA.y -= ny * lambda * imA * (1 - t);
      nB.x -= nx * lambda * imB * t;       nB.y -= ny * lambda * imB * t;
    }
    if (ny < -0.35) p.grounded = true;
  }

  const FIXED = { x: 0, y: 0 }; // dummy sink for fixed terrain endpoints

  function collideWheels() {
    for (const v of vehs) {
      if (!v.active) continue;
      for (const wi of v.wheelIdx) {
        const p = pts[wi];
        for (const s of terrain) {
          collideWheelSeg(p, s.ax, s.ay, s.bx, s.by, 0, 0, FIXED, FIXED);
        }
        for (const m of mems) {
          if (m.broken || !MATS[m.mat].drivable) continue;
          const a = pts[m.a], b = pts[m.b];
          collideWheelSeg(p, a.x, a.y, b.x, b.y, a.im, b.im, a, b);
        }
      }
    }
  }

  function step() {
    if (sim.status !== 'running') return;
    sim.t += DT;
    sim.breakEvents.length = 0;

    for (const v of vehs) if (!v.active && sim.t >= v.delay) v.active = true;

    // Integrate
    const g = GRAVITY * DT * DT;
    for (const p of pts) {
      if (p.fixed) continue;
      if (p.vehicle >= 0 && !vehs[p.vehicle].active) continue;
      const vx = (p.x - p.px) * DRAG;
      const vy = (p.y - p.py) * DRAG;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + g;
      p.grounded = false;
    }

    // Relax constraints
    for (let it = 0; it < ITERATIONS; it++) {
      for (const m of mems) solveMember(m);
      for (const v of vehs) {
        if (!v.active) continue;
        for (const l of v.links) solveRigid(l);
      }
      collideWheels();
    }

    // Drive grounded wheels
    for (const v of vehs) {
      if (!v.active) continue;
      const want = v.spec.speed * DT;
      const dv = v.spec.accel * DT * DT;
      for (const wi of v.wheelIdx) {
        const p = pts[wi];
        if (!p.grounded) continue;
        const vx = p.x - p.px;
        if (vx < want) p.px = p.x - Math.min(want, vx + dv);
      }
    }

    // Measure residual strain; break members whose sustained stress exceeds 1
    for (const m of mems) {
      if (m.broken) continue;
      const a = pts[m.a], b = pts[m.b];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      let strain = (d - m.rest) / m.rest;
      if (MATS[m.mat].tensionOnly && strain < 0) strain = 0;
      const ratio = Math.abs(strain) / MATS[m.mat].strength;
      m.stress += (ratio - m.stress) * STRESS_SMOOTH;
      if (m.stress > m.peak) m.peak = m.stress;
      if (m.stress >= 1) {
        m.broken = true;
        sim.brokenCount++;
        sim.breakEvents.push(m);
      }
    }

    // Win / fail
    let allDone = true;
    for (const v of vehs) {
      if (!v.done) {
        let minX = Infinity;
        for (const wi of v.wheelIdx) minX = Math.min(minX, pts[wi].x);
        if (v.active && minX > winX) v.done = true;
      }
      if (!v.done) allDone = false;
      for (const wi of [...v.wheelIdx, v.chassis]) {
        if (pts[wi].y > killY) {
          sim.status = 'failed';
          sim.failReason = 'fell';
          return;
        }
      }
    }
    if (allDone) {
      sim.status = 'passed';
      return;
    }
    if (sim.t > timeLimit) {
      sim.status = 'failed';
      sim.failReason = 'time';
    }
  }

  return sim;
}

// Fast-forward a sim to completion (used by tests). Returns a summary.
export function runSim(sim, maxT = 45) {
  const maxSteps = Math.ceil(maxT / DT);
  for (let i = 0; i < maxSteps && sim.status === 'running'; i++) sim.step();
  let peak = 0;
  for (const m of sim.mems) peak = Math.max(peak, m.peak);
  return {
    passed: sim.status === 'passed',
    status: sim.status,
    failReason: sim.failReason,
    brokenMembers: sim.brokenCount,
    t: Math.round(sim.t * 100) / 100,
    peakStress: Math.round(peak * 1000) / 1000,
  };
}
