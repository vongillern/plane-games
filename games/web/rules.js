// Web — the rules a test can check without a browser.
//
// Everything in this file is pure: no DOM, no canvas, no clock, and no
// Math.random (the city takes an rng, so the same seed always builds the same
// skyline). The look, the input and the camera live in game.js; what *decides
// a run* lives here — how a swing accelerates, which anchor a tap grabs, where
// the city puts its rooftops and its anchor points, and what counts as a crash.
// tools/web-rules.mjs checks all of it in Node in a few milliseconds.
//
// Two things are here rather than in game.js on purpose:
//
//   * `createCity` is the only definition of the world. The renderer draws the
//     same rectangles the collision test reads, so nothing can ever be drawn
//     where it cannot be hit, or hit where it was not drawn.
//   * the city is generated, so "is this run survivable?" is not something a
//     playtest can answer — the run that traps you is the one you have not
//     played yet. The generator is written so that it *cannot* place an
//     unreachable anchor or one that sits below the roofs around it, and the
//     test flies an autopilot through a dozen seeds to prove it.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Physics
//
// Units are metres and seconds, y is up, and the street is y = 0. Gravity is
// heavier than Earth's because the arcs have to feel snappy on a phone screen:
// at 9.8 a full swing takes about three seconds, which reads as floating.
// ---------------------------------------------------------------------------
export const G = 24;               // m/s²
export const DRAG = 0.05;          // per second, exponential
export const V_MAX = 40;           // m/s — the arcs stop being readable above this
export const PLAYER_R = 0.85;      // m, the collision circle (the figure is drawn larger)

export const MAX_ROPE = 26;        // m — how far a web can reach
export const MIN_ROPE = 4.5;       // m — how far it can be reeled in
export const PAYOUT = 6;           // m/s of line let out toward a full arc
export const HAUL = 34;            // m/s of line hauled back in when there is too much out
export const GRAB_SLACK = 6;       // m of extra line a web may be fired with, over the anchor's own
export const SWING_ASSIST = 8;     // m/s² along the arc, the "pump"
export const MIN_UP = 3;           // m — an anchor level with you is not a swing

// Aim: about 50° above the horizon, forward. Straight up stalls you over the
// anchor; flat ahead swings you into the next roof.
export const IDEAL_ANG = 0.88;

export const speed = (p) => Math.hypot(p.vx, p.vy);

export function capSpeed(p) {
  const s = speed(p);
  if (s > V_MAX) { p.vx *= V_MAX / s; p.vy *= V_MAX / s; }
  return p;
}

// Free flight: gravity, a little air drag, and that is all.
export function integrate(p, dt) {
  p.vy -= G * dt;
  const d = Math.exp(-DRAG * dt);
  p.vx *= d; p.vy *= d;
  capSpeed(p);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  return p;
}

// The rope is a rope, not a rod: it pulls when taut and does nothing when
// slack, so a player who swings up past the anchor arcs over freely instead of
// being yanked back down. Solved by projection — clamp the position onto the
// circle and drop the outward part of the velocity.
export function applyRope(p, anchor, rope) {
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= rope || dist === 0) return false;
  const nx = dx / dist, ny = dy / dist;
  p.x = anchor.x + nx * rope;
  p.y = anchor.y + ny * rope;
  const radial = p.vx * nx + p.vy * ny;
  if (radial > 0) { p.vx -= nx * radial; p.vy -= ny * radial; }
  return true;
}

// A held web settles to exactly the length the rooftops below its anchor allow
// (`safe`, computed once in createCity): hauled in hard when there is too much
// line out, paid out gently when there is room for a bigger arc.
//
// Converging on one length rather than winding all the way in is what makes the
// game readable. The player's only decision is *when to let go*, and every arc
// they hold has the same shape and the same clearance, so that decision is
// about the skyline ahead rather than about how much line they happen to have
// out. It also removes both failure modes the autopilot found: a long grab from
// high up whose arc bottoms out ten metres inside a roof the player cannot see
// yet, and a web held so long it winds into a tight orbit and stalls.
export function settleRope(rope, dt, safe = MIN_ROPE) {
  const target = Math.max(MIN_ROPE, safe);
  if (rope > target) return Math.max(target, rope - HAUL * dt);
  return Math.min(target, rope + PAYOUT * dt);
}

// A nudge along the arc in whichever direction you are already travelling.
// Without it a swing is a decaying pendulum and every run ends the same way:
// gently, in the street. It only helps below the anchor — pumping at the top
// of the arc is not a thing a rope can do.
export function swingAssist(p, anchor, dt) {
  const dx = p.x - anchor.x, dy = p.y - anchor.y;
  if (dy > -1) return p;
  const dist = Math.hypot(dx, dy) || 1;
  let tx = -dy / dist, ty = dx / dist;
  if (p.vx * tx + p.vy * ty < 0) { tx = -tx; ty = -ty; }
  if (speed(p) < V_MAX) {
    p.vx += tx * SWING_ASSIST * dt;
    p.vy += ty * SWING_ASSIST * dt;
  }
  return p;
}

// Letting go through the bottom of the arc, already moving forward, is the one
// timing the game rewards. Score is distance, so the prize is simply speed —
// no combo counter, no second number on the HUD to read while falling.
export const PERFECT_BOTTOM = 0.86;   // cos of the angle off straight-down
export const PERFECT_BOOST = 1.1;

export function releaseBoost(p, anchor) {
  const dy = p.y - anchor.y;
  const dist = Math.hypot(p.x - anchor.x, dy) || 1;
  const perfect = -dy / dist > PERFECT_BOTTOM && p.vx > 4;
  if (perfect) {
    const s = speed(p) || 1;
    const k = Math.min(PERFECT_BOOST, V_MAX / s);
    p.vx *= k; p.vy *= k;
  }
  return perfect;
}

// ---------------------------------------------------------------------------
// Aim
//
// The player never picks an anchor, only a moment — one verb, held. So this
// has to choose the anchor the player *meant*, and it is wrong in a way they
// feel instantly: grab something behind you and the swing becomes a brake.
// ---------------------------------------------------------------------------
export function pickAnchor(anchors, x, y) {
  let best = null, bestScore = Infinity;
  for (const a of anchors) {
    const dx = a.x - x, dy = a.y - y;
    if (dy < MIN_UP) continue;
    if (dx < -MAX_ROPE * 0.2) continue;          // behind you: a brake, not a swing
    const dist = Math.hypot(dx, dy);
    if (dist < MIN_ROPE) continue;
    // Range is the anchor's own clearance plus a little slack, not simply
    // MAX_ROPE. Fired from further out than that, the line still has metres to
    // haul in when the arc reaches its lowest point, and the player is already
    // inside the building before it finishes. That crash is unreadable — the
    // web looked attached and the swing looked fine — so the shot is not
    // offered at all rather than offered and then betrayed.
    const reach = Math.min(MAX_ROPE, (a.clear === undefined ? MAX_ROPE : a.clear) + GRAB_SLACK);
    if (dist > reach) continue;
    // near the ideal angle first, then reach — a long rope is a fast arc
    const score = Math.abs(Math.atan2(dy, dx) - IDEAL_ANG) * 1.5
      + (1 - dist / MAX_ROPE) * 0.9;
    if (score < bestScore) { bestScore = score; best = a; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The city
//
// Generated in a stream ahead of the player and pruned behind. Difficulty is a
// function of distance, not time, so a slow careful run and a fast one meet the
// same skyline at the same metre mark.
// ---------------------------------------------------------------------------
export const START_SAFE = 70;      // m of easy city before the ramp starts
export const RAMP = 1800;          // m over which it reaches full difficulty

export function difficulty(x) {
  return clamp((x - START_SAFE) / RAMP, 0, 1);
}

// Wide enough to reach past the neighbouring anchors on both sides, so the
// windows of consecutive anchors overlap and no rooftop falls between two of
// them unaccounted for. At 11 they did not: a 24 m tower sat 14 m past an
// anchor that had cleared only its own block, and the arc from that anchor
// flew into the side of it at 30 m/s. The player never had a shot — by the
// time the tower's own anchor was in range they were already level with the
// wall. tools/web-rules.mjs asserts this stays larger than the widest gap the
// generator can open between two anchors.
export const ANCHOR_LOOK = 22;     // m either side of an anchor that must clear it
export const SAFE_CLEAR = 9;       // m the anchor must sit above those roofs
export const ANCHOR_Y_MAX = 80;    // m — the ceiling of the skyline
export const ROOF_MARGIN = 2.5;    // m of daylight between the bottom of a safe arc and the roof

// mulberry32: 32 bits of state, uniform enough for a skyline, and identical in
// Node and the browser so a seed reproduces a run exactly.
export function makeRng(seed) {
  let t = seed >>> 0;
  return function rng() {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function createCity(rng) {
  const buildings = [];
  const anchors = [];
  let right = -40;                 // right edge of the last building placed
  let lastH = 9;                   // the skyline walks rather than jumps; see below
  let nextAnchorX = 7;             // the opening anchor is hand-placed; see below
  let opened = false;

  function growBuildings(toX) {
    while (right < toX) {
      const d = difficulty(right);
      const gap = lerp(2.2, 8, d) * (0.45 + rng() * 1.15);
      const w = lerp(9.5, 6.5, d) * (0.72 + rng() * 0.85);
      const x = right + gap;
      // Heights walk toward a fresh random target with a capped step, rather
      // than being drawn independently. Independent draws put a 40 m tower next
      // to a 10 m one, which is both noise to look at and a wall to fly into —
      // the anchors above a block can only rise as fast as the roofs under them
      // do, so a skyline that jumps produces a run that cannot be climbed.
      const low = lerp(9, 15, d);
      const target = low + rng() * lerp(9, 28, d);
      let h = lastH + clamp(target - lastH, -lerp(4, 8, d), lerp(4, 8, d));
      // The first few blocks are held low. The player starts in mid-air with
      // one web in hand and no idea what the verb is yet; a 40 m tower in the
      // first second is a death that teaches nothing.
      if (x < 42) h = Math.min(h, 8 + x * 0.12);
      lastH = h;
      buildings.push({ x, w, h, seed: rng() });
      right = x + w;
    }
  }

  function maxRoof(x0, x1) {
    let m = 0;
    for (const b of buildings) {
      if (b.x + b.w < x0 || b.x > x1) continue;
      if (b.h > m) m = b.h;
    }
    return m;
  }

  function growAnchors(toX) {
    while (nextAnchorX < toX) {
      const x = nextAnchorX;
      // the roofs an anchor has to clear are placed before its height is chosen
      growBuildings(x + ANCHOR_LOOK + 30);
      const d = difficulty(x);
      const roof = maxRoof(x - ANCHOR_LOOK, x + ANCHOR_LOOK);
      // clearance tightens with distance, but never below SAFE_CLEAR: an anchor
      // you cannot swing under is a wall, and the player has no way to see that
      // until they are already committed to it.
      const want = roof + lerp(15, 10.5, d) + rng() * 7;
      let y = Math.max(roof + SAFE_CLEAR + 1, Math.min(ANCHOR_Y_MAX, want));
      // the opening anchor is the tutorial: it has to be in reach from START on
      // the very first frame, before the player has fallen anywhere
      if (!opened) y = Math.max(y, 34);
      // `clear` travels with the anchor because reelIn needs it every frame and
      // it can never change: the roofs under an anchor are placed before it is.
      anchors.push({ x, y, seed: rng(), clear: Math.max(MIN_ROPE, y - roof - ROOF_MARGIN) });
      // spacing stays inside a web's reach with margin, so there is always a
      // next anchor from directly beneath this one
      nextAnchorX = opened
        ? x + lerp(13.5, 19, d) * (0.86 + rng() * 0.28)
        : x + 13;
      opened = true;
    }
  }

  return {
    buildings,
    anchors,
    ensure(toX) { growBuildings(toX + 40); growAnchors(toX); },
    prune(behindX) {
      while (buildings.length && buildings[0].x + buildings[0].w < behindX) buildings.shift();
      while (anchors.length && anchors[0].x < behindX) anchors.shift();
    },
    maxRoof,
  };
}

// Everything solid is lethal, which makes the rule one sentence long: stay off
// the city. A forgiving circle (PLAYER_R is well under half the drawn figure)
// keeps a graze reading as skill rather than as a bug in the hit test.
export function hits(city, x, y, r = PLAYER_R) {
  if (y - r <= 0) return true;                       // the street
  for (const b of city.buildings) {
    if (x + r < b.x || x - r > b.x + b.w) continue;
    if (y - r >= b.h) continue;
    const nx = clamp(x, b.x, b.x + b.w);
    const ny = clamp(y, 0, b.h);
    const dx = x - nx, dy = y - ny;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

// Where a run starts: mid-air, moving, above the opening anchor's reach.
export const START = { x: 0, y: 26, vx: 17, vy: 0 };
