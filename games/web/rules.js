// Web — the rules.
//
// Everything in this file is pure: no DOM, no Three.js, no clock, no
// Math.random. What decides a run lives here — the city, the raycast that
// finds a web anchor, the pendulum, and the fact that nothing in this game
// ever brings the player to a stop. `tools/web-rules.mjs` checks all of it in
// Node in a few milliseconds.
//
// The design comes from Jamie Fristrom's GDC postmortem on Spider-Man 2's
// swinging. Three of his points are load-bearing here and are called out again
// where they bite:
//
//   1. Webs attach to real geometry, never to the sky. Sky-anchored webs don't
//      fail because they're unrealistic — they fail because they break the
//      fantasy. So: raycast.
//   2. Picking a 3D anchor that yields the arc you wanted is harder than any
//      mechanic a mass-market game normally asks for. The answer that worked
//      was a cone of feeler rays, biased by the stick. The refinement (from his
//      later game, Energy Hook) is that the cone starts *narrow* and widens
//      while the button is held, so precision is available and a miss is still
//      rare.
//   3. Physics may be broken freely as long as the fantasy holds. Gravity here
//      is ~7.5x Earth, you steer in mid-air, and a swing pumps itself. None of
//      that is defensible as simulation and all of it is why the game moves.

export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

// ---------------------------------------------------------------------------
// The city.
//
// Buildings are axis-aligned boxes on a fixed street grid, and that is a design
// decision rather than a shortcut: it makes the anchor raycast an analytic slab
// test over a grid walk, so the entire swing model runs in Node with no
// renderer. A mesh-picking city would have put the most important code in this
// game somewhere it could never be tested.
//
// The grid is infinite and stateless — `cityBox` hashes its cell coordinates
// instead of reading an array. Nothing has to decide how big the world is, and
// there is no edge to fall off.
// ---------------------------------------------------------------------------

export const CELL = 78;            // street grid pitch (m)
export const H_MIN = 30;           // shortest building
export const H_MAX = 132;          // ...and the tallest, before towers
export const TOWER_CHANCE = 0.06;  // a few go much higher, so the skyline reads
export const TOWER_H = 235;
export const PLAZA_CHANCE = 0.07;  // empty cells: parks, lots, junctions

// One hashed float per (cell, channel). Integer mixing so it is identical in
// every engine — a city that differs between the test and the browser would
// make the test worthless.
export function hashCell(seed, i, j, k) {
  let h = (seed | 0) ^ Math.imul(k | 0, 0x9e3779b1);
  h = Math.imul(h ^ (i | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (j | 0), 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h ^ (h >>> 7), 0x85ebca6b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Which grid cell a world coordinate falls in. Building centres sit on the
// lattice, so cell i spans [i*CELL - CELL/2, i*CELL + CELL/2).
export const cellOf = (v) => Math.round(v / CELL);

// The building in a cell, or null for a plaza. Deterministic and allocation-
// free-ish; callers that raycast pass `out` to reuse one object.
export function cityBox(seed, i, j, out = {}) {
  if (hashCell(seed, i, j, 7) < PLAZA_CHANCE) return null;
  const w = lerp(24, 40, hashCell(seed, i, j, 1));
  const d = lerp(24, 40, hashCell(seed, i, j, 2));
  const t = hashCell(seed, i, j, 3);
  const tall = hashCell(seed, i, j, 4) < TOWER_CHANCE;
  // Squared so short buildings are common and the tall ones feel earned.
  const h = tall ? lerp(H_MAX, TOWER_H, hashCell(seed, i, j, 5)) : lerp(H_MIN, H_MAX, t * t);
  out.i = i; out.j = j;
  out.x = i * CELL; out.z = j * CELL;
  out.w = w; out.d = d; out.h = h;
  return out;
}

// Is a world point inside a building? Used to keep beacons out of concrete.
export function insideCity(seed, x, y, z, pad = 0) {
  if (y < 0) return false;
  const b = cityBox(seed, cellOf(x), cellOf(z), _box);
  if (!b || y > b.h + pad) return false;
  return Math.abs(x - b.x) <= b.w / 2 + pad && Math.abs(z - b.z) <= b.d / 2 + pad;
}

const _box = {};

// The tallest thing that could be in any cell — the DDA can stop climbing once
// the ray is above this, which is what makes "no anchor above the rooftops"
// cheap rather than a full-length walk into empty sky.
export const CITY_CEILING = TOWER_H;

// ---------------------------------------------------------------------------
// The raycast.
//
// A 2D DDA across the street grid, slab-testing the one box each cell can hold.
// Returns the nearest hit in front of the origin, with the face normal, or null.
// ---------------------------------------------------------------------------

export const RAY_MAX_CELLS = 64;   // walk limit; 64 cells is ~3.5 km

export function rayCity(seed, ox, oy, oz, dx, dy, dz, maxDist, hit = {}) {
  if (maxDist <= 0) return null;

  let i = cellOf(ox);
  let j = cellOf(oz);

  const stepI = dx > 0 ? 1 : -1;
  const stepJ = dz > 0 ? 1 : -1;

  // Distance along the ray to the next cell boundary, and the distance between
  // boundaries. An axis with no motion never advances.
  const invX = dx !== 0 ? 1 / dx : 0;
  const invZ = dz !== 0 ? 1 / dz : 0;
  let tMaxX = dx !== 0 ? ((i + stepI * 0.5) * CELL - ox) * invX : Infinity;
  let tMaxZ = dz !== 0 ? ((j + stepJ * 0.5) * CELL - oz) * invZ : Infinity;
  const tDeltaX = dx !== 0 ? CELL * Math.abs(invX) : Infinity;
  const tDeltaZ = dz !== 0 ? CELL * Math.abs(invZ) : Infinity;

  let t = 0;
  for (let n = 0; n < RAY_MAX_CELLS; n++) {
    const b = cityBox(seed, i, j, _box);
    if (b) {
      const h = slabHit(b, ox, oy, oz, dx, dy, dz, hit);
      // A hit found while stepping through cell (i,j) is the nearest one there
      // is: the DDA visits cells in ray order, and a box never leaves its cell.
      if (h !== null && h <= maxDist) return hit;
    }

    // Already above everything and still climbing: no cell further along can
    // hold anything. This is the "unless you were above the buildings" case,
    // and it must stay a null rather than a fallback anchor.
    if (dy > 0 && oy + dy * t > CITY_CEILING) return null;

    if (tMaxX < tMaxZ) { t = tMaxX; i += stepI; tMaxX += tDeltaX; }
    else { t = tMaxZ; j += stepJ; tMaxZ += tDeltaZ; }
    if (t > maxDist) return null;
  }
  return null;
}

// Ray vs one box, y from 0 to b.h. Fills `hit` and returns the entry distance,
// or null. Faces are reported so a caller can tell a rooftop from a wall.
function slabHit(b, ox, oy, oz, dx, dy, dz, hit) {
  const minX = b.x - b.w / 2, maxX = b.x + b.w / 2;
  const minZ = b.z - b.d / 2, maxZ = b.z + b.d / 2;

  let tMin = 0, tMax = Infinity;
  let axis = 0, sign = 0;

  // X slab
  if (dx === 0) { if (ox < minX || ox > maxX) return null; }
  else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv, s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tMin) { tMin = t1; axis = 0; sign = s; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  // Y slab
  if (dy === 0) { if (oy < 0 || oy > b.h) return null; }
  else {
    const inv = 1 / dy;
    let t1 = (0 - oy) * inv, t2 = (b.h - oy) * inv, s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tMin) { tMin = t1; axis = 1; sign = s; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  // Z slab
  if (dz === 0) { if (oz < minZ || oz > maxZ) return null; }
  else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv, s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tMin) { tMin = t1; axis = 2; sign = s; }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMin <= 0) return null;      // started inside, or the box is behind us

  hit.t = tMin;
  hit.x = ox + dx * tMin;
  hit.y = oy + dy * tMin;
  hit.z = oz + dz * tMin;
  hit.nx = axis === 0 ? sign : 0;
  hit.ny = axis === 1 ? sign : 0;
  hit.nz = axis === 2 ? sign : 0;
  hit.i = b.i; hit.j = b.j; hit.bh = b.h;
  return tMin;
}

// ---------------------------------------------------------------------------
// The feelers.
//
// Fristrom's team went from hand-marked swing points, to more points, to "what
// if there are infinite points and we just intersect surfaces" — a cone of rays
// biased by the stick. Sample 0 is the cone axis exactly, so a narrow cone is
// genuinely precise rather than merely small; the rest spiral outward by the
// golden angle, which spreads evenly without any randomness for the test to
// chase.
// ---------------------------------------------------------------------------

export const FEELERS = 32;
export const CONE_MIN = 0.05;      // ~2.9° — a tap is a rifle shot
export const CONE_MAX = 0.85;      // ~49°  — a held button is a shotgun
export const WIDEN_TIME = 0.45;    // seconds from one to the other

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// How wide the cone is after holding for `heldFor` seconds. `floor` is the
// assist ramp's minimum width — a new player's "narrow" is wider than an
// experienced one's.
export function coneSpread(heldFor, floor = CONE_MIN) {
  const t = clamp(heldFor / WIDEN_TIME, 0, 1);
  return lerp(Math.max(CONE_MIN, floor), CONE_MAX, t);
}

// Direction of feeler `k` of `n`, around a unit axis. Writes into `out`.
export function coneDir(ax, ay, az, spread, k, n, out = {}) {
  // Normalise defensively: a caller who hands over a not-quite-unit axis would
  // otherwise get feelers that are neither unit vectors nor inside the cone,
  // and the aim assist would go subtly soft rather than visibly wrong.
  const al = len3(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  if (k === 0) { out.x = ax; out.y = ay; out.z = az; return out; }
  // Any vector not parallel to the axis gives us a basis.
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; }
  // e1 = normalize(u x a), e2 = a x e1
  let e1x = uy * az - uz * ay;
  let e1y = uz * ax - ux * az;
  let e1z = ux * ay - uy * ax;
  const e1l = len3(e1x, e1y, e1z) || 1;
  e1x /= e1l; e1y /= e1l; e1z /= e1l;
  const e2x = ay * e1z - az * e1y;
  const e2y = az * e1x - ax * e1z;
  const e2z = ax * e1y - ay * e1x;

  // sqrt spreads samples by area rather than by angle, so the cone doesn't
  // bunch up against its own axis.
  const phi = spread * Math.sqrt(k / (n - 1));
  const theta = k * GOLDEN_ANGLE;
  const s = Math.sin(phi), c = Math.cos(phi);
  const cx = Math.cos(theta) * s, cy = Math.sin(theta) * s;
  out.x = ax * c + e1x * cx + e2x * cy;
  out.y = ay * c + e1y * cx + e2y * cy;
  out.z = az * c + e1z * cx + e2z * cy;
  return out;
}

// The aim axis: your heading, swung `lateral` (-1..1) to the side and tilted up.
// Webs go up and ahead, because that is the only place a useful anchor is.
export const AIM_PITCH = 0.52;     // rad above horizontal, ~30°
export const AIM_YAW = 1.05;       // rad of full-lock steer, ~60°

export function aimVector(heading, lateral = 0, pitch = AIM_PITCH, out = {}) {
  const a = heading + clamp(lateral, -1, 1) * AIM_YAW;
  const c = Math.cos(pitch);
  out.x = Math.sin(a) * c;
  out.y = Math.sin(pitch);
  out.z = Math.cos(a) * c;
  return out;
}

// ---------------------------------------------------------------------------
// Choosing the anchor.
//
// Every feeler that hits something is a candidate; the score decides which one
// a player probably meant. Then the best few are checked for the one failure
// that reads as a bug rather than as bad luck — a web that swings you straight
// into the wall you just attached to.
//
// What it deliberately does NOT do is guarantee the best anchor. Players told
// Fristrom they rarely ended up where they intended and didn't care; that
// uncertainty is the texture of the game, and an assist tight enough to remove
// it would remove the reason to keep swinging too.
// ---------------------------------------------------------------------------

export const MIN_LEN = 14;         // shorter than this and the arc is a jerk
export const MAX_LEN = 200;        // web length limit
export const ARC_LOOKAHEAD = 0.38; // seconds of swing to test for a face-plant

const _dir = {};
const _hit = {};

export function pickAnchor(seed, p, aim, heldFor, opts = {}) {
  const floor = opts.coneFloor ?? CONE_MIN;
  const spread = opts.spread ?? coneSpread(heldFor, floor);
  const n = opts.feelers ?? FEELERS;
  const maxLen = opts.maxLen ?? MAX_LEN;

  const al = len3(aim.x, aim.y, aim.z) || 1;
  const ax = aim.x / al, ay = aim.y / al, az = aim.z / al;

  const vl = len3(p.vx, p.vy, p.vz);
  const fx = vl > 1 ? p.vx / vl : ax;
  const fz = vl > 1 ? p.vz / vl : az;

  let best = null, bestScore = -Infinity;
  let second = null, secondScore = -Infinity;

  for (let k = 0; k < n; k++) {
    coneDir(ax, ay, az, spread, k, n, _dir);
    if (!rayCity(seed, p.x, p.y, p.z, _dir.x, _dir.y, _dir.z, maxLen, _hit)) continue;
    if (_hit.t < MIN_LEN) continue;

    // An anchor has to be above you — but *only* above you is the trap. A rope
    // straight overhead is a dead pendulum: you hang under it and bob, with no
    // arc to convert height into speed. Scoring "higher is better" walks
    // straight into it, and the sixty-second run in the Node suite found the
    // result — a player pogoing up and down one street at walking pace.
    // So elevation is scored against a target, not maximised.
    const up = (_hit.y - p.y) / _hit.t;
    if (up < 0.06 || up > 0.93) continue;
    const upFit = 1 - Math.abs(up - 0.6) / 0.6;

    const ahead = ((_hit.x - p.x) * fx + (_hit.z - p.z) * fz) / _hit.t;
    const onAxis = (_dir.x * ax + _dir.y * ay + _dir.z * az);
    // Mid-length anchors swing best: short ones snap, long ones barely turn you.
    const spanFit = 1 - Math.abs(_hit.t - 88) / 120;
    // Down in the canyon, height is the thing worth having, and a short low
    // anchor is a trap that keeps you there: every arc tops out where the last
    // one did and the run settles into a 20 m/s trudge between second storeys.
    // Up at roof level this term is worth nothing, which is correct — there is
    // nothing to recover from.
    const climb = clamp((_hit.y - p.y) / 90, 0, 1) * clamp(1 - p.y / 80, 0, 1);

    const score = upFit * 1.8 + ahead * 2.2 + onAxis * 1.0 + spanFit * 0.8 + climb * 2.6;
    if (score > bestScore) {
      second = best; secondScore = bestScore;
      best = { x: _hit.x, y: _hit.y, z: _hit.z, t: _hit.t, nx: _hit.nx, ny: _hit.ny, nz: _hit.nz };
      bestScore = score;
    } else if (score > secondScore) {
      second = { x: _hit.x, y: _hit.y, z: _hit.z, t: _hit.t, nx: _hit.nx, ny: _hit.ny, nz: _hit.nz };
      secondScore = score;
    }
  }

  if (!best) return null;
  // Prefer an anchor that doesn't drive you into a wall, but never refuse to
  // fire because both candidates are imperfect. A web that grabs something
  // awkward is a story; a web that silently does nothing is a broken button.
  if (!arcIsClear(seed, p, best, opts) && second && arcIsClear(seed, p, second, opts)) return second;
  return best;
}

// Swing forward a few tenths of a second and see whether the straight line to
// where you'd be passes through a building.
export function arcIsClear(seed, p, anchor, opts = {}) {
  const g = opts.gravity ?? G;
  const L = Math.min(len3(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z), opts.maxLen ?? MAX_LEN);
  const q = { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz };
  const dt = ARC_LOOKAHEAD / 3;
  for (let s = 0; s < 3; s++) {
    q.vy -= g * dt;
    q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
    constrainRope(q, anchor, L);
  }
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
  const d = len3(dx, dy, dz);
  if (d < 1e-6) return true;
  return !rayCity(seed, p.x, p.y, p.z, dx / d, dy / d, dz / d, d, _hit);
}

// ---------------------------------------------------------------------------
// The pendulum.
//
// Gravity is 7.5x Earth. Fristrom put Spider-Man 2's at roughly ten, for the
// same reason: at Earth gravity a 90 m web is a six-second wallow, and the
// speed the whole fantasy runs on never arrives.
// ---------------------------------------------------------------------------

export const G = 75;               // m/s^2
export const DRAG = 0.0042;        // quadratic; terminal speed lands near the cap
export const AIR_STEER = 26;       // m/s^2 sideways with no contact with anything
export const SWING_PUMP = 24;      // m/s^2 along the arc while descending
export const V_CAP = 118;          // hard ceiling, so a long fall can't run away

// A real pendulum plus drag loses height every swing and the run dies four webs
// in. The down-swing pump is what a child does on a playground swing, minus the
// legs — unphysical as written, and the difference between a game and a demo.
export function applyForces(p, o, dt) {
  const g = o.gravity ?? G;
  const drag = o.drag ?? DRAG;

  p.vy -= g * dt;

  if (o.steer) {
    // Sideways, perpendicular to travel, in the horizontal plane. Physics has
    // nothing to say about steering in mid-air; it feels right anyway. Both
    // components read the *old* velocity — updating vx first and then feeding
    // it into vz rotates by the wrong angle and slowly inflates the speed.
    const hl = Math.hypot(p.vx, p.vz);
    if (hl > 0.5) {
      const acc = (o.airSteer ?? AIR_STEER) * clamp(o.steer, -1, 1) * dt;
      const ox = p.vx, oz = p.vz;
      p.vx += (oz / hl) * acc;
      p.vz += (-ox / hl) * acc;
    }
  }

  // Descending on a taut rope means gravity is doing work along the arc; that
  // is when a pump adds, exactly as it does on a playground swing.
  if (o.anchor && o.taut && p.vy < 0) {
    const vl = len3(p.vx, p.vy, p.vz);
    if (vl > 1) {
      const k = (o.pump ?? SWING_PUMP) * dt * clamp(-p.vy / 30, 0, 1);
      p.vx += (p.vx / vl) * k;
      p.vy += (p.vy / vl) * k;
      p.vz += (p.vz / vl) * k;
    }
  }

  const v = len3(p.vx, p.vy, p.vz);
  if (v > 0) {
    const f = Math.max(0, 1 - drag * v * dt);
    p.vx *= f; p.vy *= f; p.vz *= f;
    if (v * f > V_CAP) {
      const s = V_CAP / (v * f);
      p.vx *= s; p.vy *= s; p.vz *= s;
    }
  }
}

// The web pulls itself in, and this is not a flourish — it is what makes the
// game playable at all.
//
// A pendulum's arc bottoms out at (anchor height - rope length). Attach from
// down in a street and that number is below the pavement, so the rope never
// comes tight: you fall, you land, you relaunch, and the run settles into a
// 20 m/s trudge along the second storey. The Node suite showed exactly that
// shape for an hour of tuning before the cause was obvious.
//
// Reeling in lifts the bottom of the arc every frame the line is tight, which
// is both the fix and the thing Spider-Man visibly does. It also does work on
// the player, so a swing climbs instead of merely conserving.
// How far it reels is the whole subtlety. Reeling to a fixed minimum is worse
// than not reeling at all — the player ends up hugging the anchor on a stub of
// line, dangling with nowhere to swing. So the target is derived from the job:
// take in exactly enough line to lift the bottom of the arc clear of the
// street, and then stop.
export const REEL_RATE = 60;       // metres per second of line taken in
export const ARC_CLEAR = 55;       // where the bottom of the arc should sit

export function reelRope(ropeLen, taut, dt, rate = REEL_RATE, anchorY = Infinity, clear = ARC_CLEAR) {
  if (!taut) return ropeLen;
  // anchorY - ropeLen is the lowest point the swing can reach, so ARC_CLEAR is
  // not a safety margin — it is the cruising altitude of the entire game, and
  // the sweep that set it is the difference between skimming the pavement at
  // 20 m/s and crossing the rooftops at 39. The rate matters as much: reel too
  // slowly and a two-second swing ends before the line has come in far enough
  // to matter.
  const want = anchorY - clear;
  // A low anchor cannot be reeled up to a high arc, and trying just winches the
  // player into a stub of line and leaves him dangling against the wall. Take
  // the swing as it comes instead.
  if (want < MIN_LEN) return ropeLen;
  return Math.max(Math.min(ropeLen, want), ropeLen - rate * dt);
}

// Inextensible rope, resolved by projection: pull the player back onto the
// sphere and delete the outward radial velocity. Tangential speed is untouched,
// which is why letting go preserves every bit of momentum you built — no
// special case at release, and nothing to get wrong there.
//
// The rope pulls and never pushes, so it goes slack near the top of an arc.
// That is correct, and it is also what lets you web something below you and
// simply fall until the line comes tight.
export function constrainRope(p, anchor, len) {
  const rx = p.x - anchor.x, ry = p.y - anchor.y, rz = p.z - anchor.z;
  const r = len3(rx, ry, rz);
  if (r <= len || r === 0) return false;
  const nx = rx / r, ny = ry / r, nz = rz / r;
  p.x = anchor.x + nx * len;
  p.y = anchor.y + ny * len;
  p.z = anchor.z + nz * len;
  const radial = p.vx * nx + p.vy * ny + p.vz * nz;
  if (radial > 0) { p.vx -= radial * nx; p.vy -= radial * ny; p.vz -= radial * nz; }
  return true;
}

// Firing a web from the deck also launches you off it.
//
// Without this the game has a trap door: land once, and a rope anchored 20 m up
// a wall across the street can never lift you again, so the run quietly becomes
// a jog. (The Node suite caught exactly that — 52 of 60 seconds on the ground.)
// Fristrom's note that Spider-Man jumps an absurd number of stories and it
// still doesn't read as a jump is the licence: the recovery has to be violent
// enough to matter under 7.5x gravity, and 58 m/s buys about 22 m of apex,
// which is a fifth of what it sounds like.
export const LAUNCH_UP = 58;
export const LAUNCH_FWD = 24;      // ...and this much of it aimed at the anchor

// Attaching is one decision, so it lives in one function that both the game and
// the test call — a launch rule that existed only in game.js would be a rule
// nothing checks.
export function attachWeb(p, anchor, maxLen = MAX_LEN) {
  const L = Math.min(len3(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z), maxLen);
  if (p.grounded) {
    p.vy = Math.max(p.vy, LAUNCH_UP);
    // Purely vertical is a pogo stick, not a web-zip: he leaves the ground and
    // lands on the same paving slab. Carry him at what he just grabbed.
    const hx = anchor.x - p.x, hz = anchor.z - p.z;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-3) {
      const cur = (p.vx * hx + p.vz * hz) / hl;
      if (cur < LAUNCH_FWD) {
        const add = LAUNCH_FWD - cur;
        p.vx += (hx / hl) * add;
        p.vz += (hz / hl) * add;
      }
    }
    p.grounded = false;
  }
  return L;
}

// ---------------------------------------------------------------------------
// Contact.
//
// There is no crash in this game and no reset, and this function is where that
// promise is kept. Fristrom's team went through their engine deleting every
// place it set a character's velocity to zero, and turning off Spider-Man 1's
// automatic wall-stick is what turned a rejected prototype into a shipped one:
// swinging along and stopping dead reads as a bug no matter why it happened.
//
// So a wall costs you speed and sends you along it. The street costs you a
// little and you run. Nothing here can return a stationary player — the test
// asserts it across every contact path.
// ---------------------------------------------------------------------------

export const PLAYER_R = 1.7;
export const WALL_KEEP = 0.86;     // tangential speed kept scuffing a wall
export const WALL_BOUNCE = 0.18;   // and how much of the impact comes back
export const LAND_KEEP = 0.90;
export const RUN_MIN = 9;          // he lands and takes a few steps; never stops
export const RUN_MAX = 27;
export const GROUND_FRICTION = 0.55;

// Sweep from `from` to the player's new position. Buildings are tens of metres
// across and a frame moves at most ~4 m, so a swept segment cannot tunnel.
export function resolveContact(seed, p, from, out = {}) {
  out.wall = false; out.ground = false; out.roof = false;

  const dx = p.x - from.x, dy = p.y - from.y, dz = p.z - from.z;
  const d = len3(dx, dy, dz);
  if (d > 1e-6 && rayCity(seed, from.x, from.y, from.z, dx / d, dy / d, dz / d, d + PLAYER_R, _hit)) {
    const nx = _hit.nx, ny = _hit.ny, nz = _hit.nz;
    p.x = _hit.x + nx * PLAYER_R;
    p.y = _hit.y + ny * PLAYER_R;
    p.z = _hit.z + nz * PLAYER_R;

    const into = p.vx * nx + p.vy * ny + p.vz * nz;
    if (into < 0) {
      // Split into "through the wall" and "along the wall", then keep most of
      // the second one. This is the surfer move: you touch the glass, you spin,
      // your feet run along it for a moment, and you leave with your speed.
      p.vx -= into * nx * (1 + WALL_BOUNCE);
      p.vy -= into * ny * (1 + WALL_BOUNCE);
      p.vz -= into * nz * (1 + WALL_BOUNCE);
      p.vx *= WALL_KEEP; p.vy *= WALL_KEEP; p.vz *= WALL_KEEP;
    }
    if (ny > 0.5) { out.roof = true; out.surfaceY = p.y; } else out.wall = true;
  }

  if (p.y < PLAYER_R) {
    p.y = PLAYER_R;
    if (p.vy < 0) { p.vy *= -0.05; }        // a scrape of a bounce, not a stop
    out.ground = true;
  }

  if (out.ground || out.roof) {
    p.vx *= LAND_KEEP; p.vz *= LAND_KEEP;
    const h = Math.hypot(p.vx, p.vz);
    if (h > RUN_MAX) { const s = RUN_MAX / h; p.vx *= s; p.vz *= s; }
    else if (h < RUN_MIN) {
      // The floor exists so the player is never standing still wondering what
      // broke. If he has no direction left at all, give him the one he was
      // facing rather than an arbitrary one.
      const fx = h > 0.01 ? p.vx / h : Math.sin(p.heading ?? 0);
      const fz = h > 0.01 ? p.vz / h : Math.cos(p.heading ?? 0);
      p.vx = fx * RUN_MIN; p.vz = fz * RUN_MIN;
    }
  }

  return out;
}

// Push a player who has somehow ended up inside a building out through its
// nearest face. Nothing in the normal loop should reach this — a fresh run
// starting on a rooftop and a teleporting test hook both can.
export function depenetrate(seed, p) {
  const b = cityBox(seed, cellOf(p.x), cellOf(p.z), _box);
  if (!b || p.y > b.h + PLAYER_R) return false;
  const dxp = b.x + b.w / 2 + PLAYER_R - p.x, dxm = p.x - (b.x - b.w / 2 - PLAYER_R);
  const dzp = b.z + b.d / 2 + PLAYER_R - p.z, dzm = p.z - (b.z - b.d / 2 - PLAYER_R);
  const dyp = b.h + PLAYER_R - p.y;
  if (dxp < 0 || dxm < 0 || dzp < 0 || dzm < 0) return false;
  const m = Math.min(dxp, dxm, dzp, dzm, dyp);
  if (m === dyp) { p.y = b.h + PLAYER_R; if (p.vy < 0) p.vy = 0; }
  else if (m === dxp) p.x = b.x + b.w / 2 + PLAYER_R;
  else if (m === dxm) p.x = b.x - b.w / 2 - PLAYER_R;
  else if (m === dzp) p.z = b.z + b.d / 2 + PLAYER_R;
  else p.z = b.z - b.d / 2 - PLAYER_R;
  return true;
}

// ---------------------------------------------------------------------------
// One step.
// ---------------------------------------------------------------------------

const _from = { x: 0, y: 0, z: 0 };

export function stepPlayer(seed, p, o, dt, out = {}) {
  _from.x = p.x; _from.y = p.y; _from.z = p.z;

  o.taut = o.anchor
    ? len3(p.x - o.anchor.x, p.y - o.anchor.y, p.z - o.anchor.z) >= o.ropeLen - 0.01
    : false;

  // `o` is the caller's own state object and this mutates its ropeLen — the web
  // shortening is a property of the web, not a decision the renderer should be
  // making on its own.
  if (o.anchor) o.ropeLen = reelRope(o.ropeLen, o.taut, dt, o.reel ?? REEL_RATE, o.anchor.y, o.arcClear ?? ARC_CLEAR);

  applyForces(p, o, dt);
  p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

  out.taut = o.anchor ? constrainRope(p, o.anchor, o.ropeLen) : false;
  out.ropeLen = o.ropeLen;
  resolveContact(seed, p, _from, out);

  // Touching down drops the web. Without this the player can end a swing on the
  // street still tethered to a wall twenty metres up, and then nothing can ever
  // lift him again: the rope forbids the arc and the launch only fires on a
  // fresh attach. The Node suite found it as 55 seconds of jogging.
  // The caller owns the anchor, so this is a signal rather than a mutation.
  out.dropWeb = !!o.anchor && (out.ground || out.roof);

  if (out.ground || out.roof) {
    const h = Math.hypot(p.vx, p.vz);
    p.grounded = true;
    // Steering on foot is direct: he is running, not flying.
    if (o.steer && h > 0.01) {
      const a = Math.atan2(p.vx, p.vz) + clamp(o.steer, -1, 1) * 2.2 * dt;
      p.vx = Math.sin(a) * h; p.vz = Math.cos(a) * h;
    }
    p.vx -= p.vx * GROUND_FRICTION * dt;
    p.vz -= p.vz * GROUND_FRICTION * dt;
  } else {
    p.grounded = false;
  }

  if (Math.hypot(p.vx, p.vz) > 0.01) p.heading = Math.atan2(p.vx, p.vz);
  return out;
}

export const speedOf = (p) => len3(p.vx, p.vy, p.vz);

// ---------------------------------------------------------------------------
// The run: beacons and the clock.
//
// The only failure state is the clock. Everything else in this file exists to
// make sure a mistake costs you time and never costs you the run.
// ---------------------------------------------------------------------------

export const TIME_START = 30;      // seconds on the clock at the off
export const TIME_MIN = 8;         // ...and the least a beacon can ever be worth
export const BEACON_R = 17;        // reach radius — generous, and deliberately so
export const BEACON_NEAR = 230;    // how far the next one is placed
export const BEACON_FAR = 430;
export const BEACON_SPREAD = 1.45; // rad either side of your heading, ~83°

// A beacon is worth less the further you get, which is the whole difficulty
// curve: the city never changes, the clock just stops being generous.
export function timeForBeacon(n) {
  return Math.max(TIME_MIN, 15 - n * 0.42);
}

// Place beacon `n` on a rooftop ahead of the player. Deterministic in
// (seed, n) so a run replays and the test can assert on every one of them.
export function nextBeacon(seed, n, x, z, heading, out = {}) {
  // Walk candidates until one lands on a real roof. Plazas are 7% of cells, so
  // this is one or two tries in practice and the loop bound is paranoia.
  for (let k = 0; k < 24; k++) {
    const r = lerp(BEACON_NEAR, BEACON_FAR, hashCell(seed, n, k, 11));
    const a = heading + (hashCell(seed, n, k, 12) * 2 - 1) * BEACON_SPREAD;
    const tx = x + Math.sin(a) * r;
    const tz = z + Math.cos(a) * r;
    const b = cityBox(seed, cellOf(tx), cellOf(tz), {});
    if (!b) continue;
    out.x = b.x; out.z = b.z; out.y = b.h + 9;
    out.i = b.i; out.j = b.j;
    return out;
  }
  // Every candidate was a plaza: put it over the player's own cell rather than
  // return nothing. A run cannot be allowed to end because the dice were odd.
  out.x = x; out.z = z; out.y = 90; out.i = cellOf(x); out.j = cellOf(z);
  return out;
}

export function reachedBeacon(p, b, r = BEACON_R) {
  return len3(p.x - b.x, p.y - b.y, p.z - b.z) <= r;
}

// ---------------------------------------------------------------------------
// The assist ramp.
//
// Spider-Man 2 shipped new players a slower, draggier, shorter-jumping hero and
// sold the difference back through a shop — which Fristrom points out is itself
// a violation of the fantasy, since Spider-Man does not buy his powers in a
// store. The curve was worth having; the store was the price he paid for it.
// A short run can have the curve for free: it just happens, over the first
// half-dozen beacons, and nobody has to go shopping.
// ---------------------------------------------------------------------------

export const ASSIST_OVER = 6;      // beacons until the training wheels are off

export function assist(n) {
  const t = clamp(n / ASSIST_OVER, 0, 1);
  return {
    drag: lerp(DRAG * 1.9, DRAG, t),        // slower and more damped at the start
    gravity: lerp(G * 0.82, G, t),
    coneFloor: lerp(0.20, CONE_MIN, t),     // a beginner's narrow is still wide
    pump: lerp(SWING_PUMP * 0.8, SWING_PUMP, t),
  };
}

// ---------------------------------------------------------------------------
// The Running Man.
//
// Frustrated testers stopped swinging and jogged to the objective through the
// streets, and Spider-Man 2 detected it and had Bruce Campbell mock them until
// they went back up. We have no audio, so it is a toast — but the detection is
// the same idea, and it is the difference between a player who has decided not
// to play the game and a player nobody told.
// ---------------------------------------------------------------------------

export const RUN_NAG_AFTER = 4.5;  // seconds on the deck before we say something

// ---------------------------------------------------------------------------
// The autopilot.
//
// A competent player, expressed as four lines of policy: hold until something
// catches, ride the arc down, let go on the way up. It lives here rather than
// in game.js because both the Node suite and the headless smoke test need it,
// and two copies of "how do you play this game" would drift.
//
// The `descended` flag is the whole thing. Without it, releasing on `vy > 6`
// fires on the frame straight after a ground launch, and the player thrashes
// through fifty webs in a second without ever completing a swing.
// ---------------------------------------------------------------------------

const _aim = {};

export function newPilot() {
  return { anchor: null, ropeLen: 0, held: 0, descended: false };
}

// Let go once you are climbing at roughly 25° — releasing the instant vy turns
// positive throws away most of the arc, which is the difference between a swing
// that carries a city block and one that dumps you back in the same street.
export const RELEASE_RISE = 0.42;  // fraction of speed that must be upward

export const STALL_SPEED = 13;     // hanging, not swinging — let go and re-aim

export function autoPilot(seed, a, p, dropWeb, dt, opts = {}) {
  const v = speedOf(p);
  const rising = a.anchor && p.vy > RELEASE_RISE * (v || 1);
  const stalled = a.anchor && a.descended && v < STALL_SPEED;
  if (dropWeb || (a.anchor && a.descended && rising) || stalled) {
    a.anchor = null; a.ropeLen = 0; a.held = 0; a.descended = false;
  }
  if (!a.anchor) {
    a.held += dt;
    const anchor = pickAnchor(seed, p, aimVector(p.heading, a.lateral ?? 0, undefined, _aim), a.held, opts);
    if (anchor) {
      a.anchor = anchor;
      a.ropeLen = attachWeb(p, anchor, opts.maxLen ?? MAX_LEN);
      a.held = 0; a.descended = false;
    }
  } else if (p.vy < -4) {
    a.descended = true;
  }
  return a;
}

export function formatClock(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

export const START_HEIGHT = 120;   // dropped in above the rooftops, already moving
export const START_SPEED = 34;
