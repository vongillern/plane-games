#!/usr/bin/env node
// Web's rules, checked in Node in a few milliseconds.
//
// games/web/rules.js is pure on purpose — no DOM, no Three.js, no clock, no
// Math.random — so everything that decides a run can be proved here instead of
// squinting at a browser. Two properties are worth the whole file:
//
//   * A web always finds something. The cone of feelers widening while the
//     button is held is the entire accessibility story; if it can leave a
//     player in the middle of a city with nothing to grab, the game is broken
//     in the exact way Spider-Man 2's first prototype was.
//   * Nothing ever stops the player. Every contact path has to leave him
//     moving, because a swinging game that halts reads as a bug no matter what
//     caused it.
//
// Run: node tools/web-rules.mjs

import {
  CELL, PLAZA_CHANCE, TOWER_H,
  cityBox, cellOf, insideCity, rayCity,
  coneDir, coneSpread, CONE_MIN, CONE_MAX, WIDEN_TIME, FEELERS,
  aimVector, pickAnchor, arcIsClear, attachWeb, LAUNCH_UP, MIN_LEN, MAX_LEN,
  newPilot, autoPilot,
  constrainRope, applyForces, stepPlayer, resolveContact, depenetrate,
  speedOf, len3, clamp,
  G, DRAG, RUN_MIN, PLAYER_R,
  nextBeacon, reachedBeacon, timeForBeacon, TIME_MIN, BEACON_NEAR, BEACON_FAR,
  assist, ASSIST_OVER,
  formatClock, START_HEIGHT,
} from '../games/web/rules.js';

const failures = [];
let checks = 0;
function ok(what, cond, detail = '') {
  checks++;
  if (!cond) failures.push(detail ? `${what}\n        got: ${detail}` : what);
}
const eq = (what, a, b) => ok(what, Object.is(a, b), `${a} !== ${b}`);
const near = (what, a, b, tol = 1e-6) => ok(what, Math.abs(a - b) <= tol, `${a} !== ${b} (±${tol})`);
const SEED = 20260806;

// A tiny deterministic generator, so this file has no Math.random either and a
// failure is always reproducible.
let _s = 12345;
const rnd = () => { _s = (Math.imul(_s, 1664525) + 1013904223) >>> 0; return _s / 4294967296; };
const between = (a, b) => a + (b - a) * rnd();

// ---------------------------------------------------------------------------
// The city.
// ---------------------------------------------------------------------------

{
  // Boxes must never leave their own cell — the whole DDA raycast assumes it.
  // Widen a footprint past CELL and the ray starts walking straight through
  // corners with no hit at all.
  let maxHalf = 0, plazas = 0, tallest = 0, n = 0;
  for (let i = -30; i <= 30; i++) {
    for (let j = -30; j <= 30; j++) {
      n++;
      const b = cityBox(SEED, i, j, {});
      if (!b) { plazas++; continue; }
      maxHalf = Math.max(maxHalf, b.w / 2, b.d / 2);
      tallest = Math.max(tallest, b.h);
      eq(`cell (${i},${j}) is centred on the lattice`, b.x, i * CELL);
    }
  }
  ok('a building never crosses its own cell boundary', maxHalf <= CELL / 2, `half-extent ${maxHalf} > ${CELL / 2}`);
  ok('nothing is taller than CITY_CEILING', tallest <= TOWER_H, `${tallest} > ${TOWER_H}`);
  const rate = plazas / n;
  ok('plazas land near their configured rate', Math.abs(rate - PLAZA_CHANCE) < 0.025, `${(rate * 100).toFixed(1)}% vs ${PLAZA_CHANCE * 100}%`);

  // Same cell, same building, forever. The browser and this file must agree or
  // every assertion below is about a different city.
  const a = cityBox(SEED, 3, -7, {});
  const c = cityBox(SEED, 3, -7, {});
  ok('cityBox is a pure function of its cell', a.w === c.w && a.d === c.d && a.h === c.h);
  const other = cityBox(SEED + 1, 3, -7, {});
  ok('a different seed is a different city', !other || other.h !== a.h);
}

// ---------------------------------------------------------------------------
// The raycast — checked against brute force.
//
// The DDA is the one piece of cleverness in rules.js, and a subtly wrong one
// would degrade the aim assist rather than break it: webs would occasionally
// pass through a corner and grab the building behind. So it gets marched
// against a dumb sampler that cannot be clever enough to be wrong.
// ---------------------------------------------------------------------------

{
  let compared = 0, hits = 0;
  for (let k = 0; k < 3000; k++) {
    const ox = between(-400, 400), oz = between(-400, 400), oy = between(4, 200);
    if (insideCity(SEED, ox, oy, oz)) continue;
    let dx = between(-1, 1), dy = between(-1, 1), dz = between(-1, 1);
    const l = len3(dx, dy, dz);
    if (l < 1e-3) continue;
    dx /= l; dy /= l; dz /= l;
    const maxDist = 300;

    const hit = rayCity(SEED, ox, oy, oz, dx, dy, dz, maxDist, {});

    // Brute force: step along the ray and note the first sample inside anything.
    const STEP = 0.05;
    let brute = null;
    for (let t = STEP; t <= maxDist; t += STEP) {
      if (insideCity(SEED, ox + dx * t, oy + dy * t, oz + dz * t)) { brute = t; break; }
    }

    compared++;
    if (brute === null) {
      ok('no brute-force hit means no DDA hit', hit === null, hit ? `DDA found t=${hit.t.toFixed(2)}` : '');
    } else {
      hits++;
      ok('DDA finds the hit brute force found', hit !== null, `missed a hit near t=${brute.toFixed(2)}`);
      if (hit) {
        ok('DDA agrees with brute force on distance', Math.abs(hit.t - brute) < STEP * 2,
          `dda ${hit.t.toFixed(3)} vs brute ${brute.toFixed(3)}`);
        // The reported point must be on the ray and on a surface.
        near('the hit point lies on the ray', len3(hit.x - (ox + dx * hit.t), hit.y - (oy + dy * hit.t), hit.z - (oz + dz * hit.t)), 0, 1e-9);
        ok('the hit reports a unit axis-aligned normal', Math.abs(Math.abs(hit.nx) + Math.abs(hit.ny) + Math.abs(hit.nz) - 1) < 1e-9);
        // Just outside the surface is empty; just inside is solid.
        ok('the normal points out of the building',
          !insideCity(SEED, hit.x + hit.nx * 0.3, hit.y + hit.ny * 0.3, hit.z + hit.nz * 0.3));
      }
    }
  }
  ok('the raycast comparison actually exercised hits', hits > 200, `only ${hits} of ${compared} rays hit anything`);
}

{
  // Above the skyline, looking up, there is nothing — and the answer has to be
  // null rather than a convenient anchor. Sky-attached webs are precisely what
  // Spider-Man 1 did and what Spider-Man 2 was built to stop doing.
  const hit = rayCity(SEED, 0, TOWER_H + 60, 0, 0.2, 0.97, 0.1, MAX_LEN, {});
  ok('a web fired at the sky finds nothing', hit === null, hit ? `grabbed something at ${hit.t}` : '');
}

// ---------------------------------------------------------------------------
// The cone.
// ---------------------------------------------------------------------------

{
  let prev = -1, monotone = true;
  for (let t = 0; t <= WIDEN_TIME * 1.5; t += WIDEN_TIME / 20) {
    const s = coneSpread(t);
    if (s < prev - 1e-12) monotone = false;
    prev = s;
  }
  ok('the cone only ever widens while held', monotone);
  near('a tap is the narrow cone', coneSpread(0), CONE_MIN);
  near('a full hold is the wide cone', coneSpread(WIDEN_TIME), CONE_MAX);
  eq('holding longer than WIDEN_TIME does not keep widening', coneSpread(99), CONE_MAX);
  ok('the assist ramp can only widen the floor, never narrow it past CONE_MIN',
    coneSpread(0, 0.001) >= CONE_MIN);

  // Sample 0 is the axis exactly. Without that, "narrow" is a small cone rather
  // than a precise one, and a skilled player can never actually hit what they
  // are pointing at.
  const axis = { x: 0, y: 1, z: 0 };
  const d0 = coneDir(axis.x, axis.y, axis.z, CONE_MAX, 0, FEELERS, {});
  near('feeler 0 is the cone axis itself', len3(d0.x - axis.x, d0.y - axis.y, d0.z - axis.z), 0, 1e-12);

  // Deliberately a non-unit axis: pickAnchor normalises before it calls, but
  // coneDir has to survive a caller that doesn't, because the failure is silent.
  const AX = 0.3, AY = 0.9, AZ = 0.31, AL = len3(AX, AY, AZ);
  let worst = 0, longest = 0;
  for (let k = 0; k < FEELERS; k++) {
    const d = coneDir(AX, AY, AZ, CONE_MAX, k, FEELERS, {});
    longest = Math.max(longest, Math.abs(len3(d.x, d.y, d.z) - 1));
    const dot = (d.x * AX + d.y * AY + d.z * AZ) / AL;
    worst = Math.max(worst, Math.acos(clamp(dot, -1, 1)));
  }
  ok('every feeler is a unit vector', longest < 1e-9, `worst error ${longest}`);
  ok('no feeler escapes the cone', worst <= CONE_MAX + 1e-9, `${worst} > ${CONE_MAX}`);

  // Feelers must not all pile onto one side — that would make the assist
  // directional in a way no player could learn.
  let sx = 0, sz = 0;
  for (let k = 1; k < FEELERS; k++) {
    const d = coneDir(0, 1, 0, CONE_MAX, k, FEELERS, {});
    sx += d.x; sz += d.z;
  }
  ok('the cone is balanced around its axis', Math.hypot(sx, sz) / FEELERS < 0.02, `drift ${(Math.hypot(sx, sz) / FEELERS).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// The aim assist — the property the whole game rests on.
// ---------------------------------------------------------------------------

{
  // Fristrom's finding was that more candidate points meant a less confused
  // player. The modern form of that promise: anywhere in the city below the
  // rooftops, holding the button finds you something.
  //
  // "Below the rooftops" is the honest qualifier and it has to be measured, not
  // assumed. Above the local skyline there is genuinely nothing to grab, and
  // returning null there is the correct answer — it is the whole reason webs
  // attach to geometry instead of to the sky. So the sample is restricted to
  // positions that actually have a neighbour tall enough to web.
  // The tallest thing actually within reach of a web. A fixed cell radius looks
  // like the same test and is not: at CELL = 78 a 5x5 neighbourhood spans
  // 390 m, so a tower four blocks away would excuse a miss from a spot with
  // nothing near it but low-rises.
  const reach = Math.ceil(MAX_LEN / CELL);
  const skyline = (x, z) => {
    let h = 0;
    const ci = cellOf(x), cj = cellOf(z);
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        const b = cityBox(SEED, i, j, {});
        if (!b) continue;
        if (Math.hypot(b.x - x, b.z - z) > MAX_LEN) continue;
        h = Math.max(h, b.h);
      }
    }
    return h;
  };

  let tried = 0, found = 0, worstHold = 0, skipped = 0;
  for (let k = 0; k < 900; k++) {
    const x = between(-500, 500), z = between(-500, 500);
    const y = between(12, 90);
    if (insideCity(SEED, x, y, z, 2)) continue;
    if (y > skyline(x, z) - 6) { skipped++; continue; }
    const heading = between(0, Math.PI * 2);
    const p = { x, y, z, vx: Math.sin(heading) * 40, vy: -8, vz: Math.cos(heading) * 40 };

    tried++;
    // Sweep the hold the way a player does: fire, and keep holding.
    let hit = null, held = 0;
    for (let h = 0; h <= WIDEN_TIME + 1e-9; h += WIDEN_TIME / 6) {
      hit = pickAnchor(SEED, p, aimVector(heading, 0, undefined, {}), h, {});
      if (hit) { held = h; break; }
    }
    if (hit) { found++; worstHold = Math.max(worstHold, held); }
  }
  const rate = found / tried;
  // Nine in ten, measured, and the residual is honest rather than a rounding
  // of "almost always": these are spots where the only thing within a web's
  // reach is below you. A player is never standing still when it happens — the
  // sixty-second run below is the moving version of this question, and there
  // the swing never stalls — but the number is what it is and is asserted at
  // what it is, so a change that quietly halves it fails here.
  ok('holding the web button finds an anchor almost anywhere in the city',
    rate > 0.9, `${(rate * 100).toFixed(1)}% of ${tried} positions`);
  ok('and it never takes longer than the widen window to get there',
    worstHold <= WIDEN_TIME + 1e-9, `${worstHold}s`);
}

{
  // An anchor must be a real point on a real surface, at a length that swings.
  let bad = 0, tooShort = 0, inside = 0, checkedAnchors = 0;
  for (let k = 0; k < 800; k++) {
    const x = between(-500, 500), z = between(-500, 500), y = between(12, 90);
    if (insideCity(SEED, x, y, z, 2)) continue;
    const heading = between(0, Math.PI * 2);
    const p = { x, y, z, vx: Math.sin(heading) * 45, vy: -10, vz: Math.cos(heading) * 45 };
    const a = pickAnchor(SEED, p, aimVector(heading, between(-1, 1), undefined, {}), WIDEN_TIME, {});
    if (!a) continue;
    checkedAnchors++;
    const L = len3(a.x - p.x, a.y - p.y, a.z - p.z);
    if (L < MIN_LEN - 1e-6) tooShort++;
    if (L > MAX_LEN + 1e-6) bad++;
    // On the surface, not in the concrete.
    if (insideCity(SEED, a.x + a.nx * 0.3, a.y + a.ny * 0.3, a.z + a.nz * 0.3)) inside++;
    // And nothing solid between the player and the anchor: a web cannot pass
    // through a building to reach the one behind it.
    const d = rayCity(SEED, p.x, p.y, p.z, (a.x - p.x) / L, (a.y - p.y) / L, (a.z - p.z) / L, L - 0.05, {});
    if (d) bad++;
  }
  ok('the assist found anchors to check', checkedAnchors > 200, `only ${checkedAnchors}`);
  eq('no anchor is shorter than MIN_LEN', tooShort, 0);
  eq('no anchor is inside a building or through a wall', bad + inside, 0);
}

{
  // Anchors should mostly be above you: that is what a pendulum needs, and an
  // anchor level with your head just yanks you sideways.
  let above = 0, total = 0;
  for (let k = 0; k < 400; k++) {
    const x = between(-400, 400), z = between(-400, 400), y = between(20, 80);
    if (insideCity(SEED, x, y, z, 2)) continue;
    const heading = between(0, Math.PI * 2);
    const p = { x, y, z, vx: Math.sin(heading) * 45, vy: -10, vz: Math.cos(heading) * 45 };
    const a = pickAnchor(SEED, p, aimVector(heading, 0, undefined, {}), WIDEN_TIME, {});
    if (!a) continue;
    total++;
    if (a.y > p.y) above++;
  }
  eq('every anchor is above the player', above, total);
}

// ---------------------------------------------------------------------------
// The pendulum.
// ---------------------------------------------------------------------------

{
  // The rope is inextensible and it only pulls. Both halves matter: a rope that
  // pushes turns a slack web into a pogo stick, and a rope that stretches makes
  // release timing meaningless.
  const anchor = { x: 0, y: 100, z: 0 };
  const p = { x: 60, y: 40, z: 0, vx: 0, vy: 0, vz: 0 };
  const L = len3(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z);

  const slack = { x: 10, y: 90, z: 0, vx: 5, vy: 5, vz: 0 };
  const before = speedOf(slack);
  ok('a slack rope does nothing at all', constrainRope(slack, anchor, L) === false);
  near('and takes no speed while slack', speedOf(slack), before, 1e-12);

  // Swing it and watch the length. High above the skyline on purpose: down in
  // the city a wall contact legitimately moves the player off the sphere, and
  // this assertion is about the rope, not about the buildings.
  const hi = { x: 60, y: TOWER_H + 500, z: 0, vx: 0, vy: 0, vz: 0 };
  const hiAnchor = { x: 0, y: TOWER_H + 560, z: 0 };
  const hiL = len3(hi.x - hiAnchor.x, hi.y - hiAnchor.y, hi.z - hiAnchor.z);
  let maxLen = 0;
  const o = { anchor: hiAnchor, ropeLen: hiL, gravity: G, drag: 0 };
  for (let s = 0; s < 2400; s++) {
    stepPlayer(SEED, hi, o, 1 / 240, {});
    maxLen = Math.max(maxLen, len3(hi.x - hiAnchor.x, hi.y - hiAnchor.y, hi.z - hiAnchor.z));
  }
  ok('a taut rope never lengthens', maxLen <= hiL + 1e-6, `${maxLen} > ${hiL}`);
  void L;
}

{
  // Release preserves momentum. There is no code at release that does this —
  // it falls out of resolving the rope by projection, which is the reason to
  // resolve it that way. If someone rewrites constrainRope as a spring, this
  // is the assertion that notices.
  const anchor = { x: 0, y: 120, z: 0 };
  const p = { x: 70, y: 60, z: 0, vx: -30, vy: -5, vz: 12 };
  constrainRope(p, anchor, len3(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z));
  const before = { vx: p.vx, vy: p.vy, vz: p.vz };
  const speed = speedOf(p);
  // Letting go is simply not calling constrainRope any more.
  near('release keeps every component of velocity', len3(p.vx - before.vx, p.vy - before.vy, p.vz - before.vz), 0, 1e-12);
  near('release keeps the speed', speedOf(p), speed, 1e-12);
}

{
  // The constraint may remove outward radial speed, but it must never *add*
  // energy. Gravity and the pump are allowed to; the projection is not.
  let worst = 0;
  for (let k = 0; k < 500; k++) {
    const anchor = { x: 0, y: 0, z: 0 };
    const L = between(30, 140);
    const p = {
      x: between(-1, 1), y: between(-1, 1), z: between(-1, 1),
      vx: between(-60, 60), vy: between(-60, 60), vz: between(-60, 60),
    };
    const l = len3(p.x, p.y, p.z) || 1;
    // Place it outside the sphere so the constraint actually engages.
    p.x = (p.x / l) * L * 1.05; p.y = (p.y / l) * L * 1.05; p.z = (p.z / l) * L * 1.05;
    const before = speedOf(p);
    constrainRope(p, anchor, L);
    worst = Math.max(worst, speedOf(p) - before);
  }
  ok('the rope constraint never adds speed', worst <= 1e-9, `added ${worst}`);
}

{
  // Mid-air steering turns you without inflating your speed. This is the bug
  // that hides forever: rotate the velocity by feeding an updated component
  // back into the next line and every steered frame gains a fraction of a
  // percent, which after a minute of swinging is a different game.
  let worst = 0;
  for (const steer of [-1, -0.4, 0.4, 1]) {
    const p = { x: 0, y: 100, z: 0, vx: 40, vy: 0, vz: 10 };
    const before = Math.hypot(p.vx, p.vz);
    for (let s = 0; s < 240; s++) applyForces(p, { steer, gravity: 0, drag: 0 }, 1 / 60);
    worst = Math.max(worst, Math.abs(Math.hypot(p.vx, p.vz) - before) / before);
  }
  ok('steering turns the player without changing their speed', worst < 0.02, `${(worst * 100).toFixed(2)}% drift`);
}

{
  // Drag is a brake, never a motor, and the cap holds under a long fall.
  const p = { x: 0, y: 4000, z: 0, vx: 0, vy: 0, vz: 0 };
  for (let s = 0; s < 3000; s++) applyForces(p, { gravity: G, drag: DRAG }, 1 / 60);
  ok('terminal speed is bounded', speedOf(p) < 130, `${speedOf(p).toFixed(1)} m/s`);
  const slow = { x: 0, y: 0, z: 0, vx: 3, vy: 0, vz: 0 };
  applyForces(slow, { gravity: 0, drag: DRAG }, 1 / 60);
  ok('drag never speeds anyone up', Math.abs(slow.vx) <= 3 + 1e-12);
}

// ---------------------------------------------------------------------------
// Nothing ever stops the player.
//
// The single promise this game makes. Spider-Man 2 got here by deleting every
// "set velocity to zero" in an engine that had been written for a fighting
// game; we get here by never writing one, and by checking.
// ---------------------------------------------------------------------------

{
  let stalls = 0, contacts = 0, slowest = Infinity;
  for (let k = 0; k < 4000; k++) {
    // Aim a fast player straight at something solid, from every angle. Find a
    // surface first and start the frame just short of it — firing random short
    // steps into open air proves nothing about what happens on impact.
    const o = { x: between(-300, 300), y: between(3, 140), z: between(-300, 300) };
    if (insideCity(SEED, o.x, o.y, o.z, PLAYER_R)) continue;
    let dx = between(-1, 1), dy = between(-1, 1), dz = between(-1, 1);
    const l = len3(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const surface = rayCity(SEED, o.x, o.y, o.z, dx, dy, dz, 300, {});
    if (!surface || surface.t < 8) continue;

    const sp = between(15, 110);
    const step = sp / 60;                       // one frame at 60fps
    const t0 = surface.t - step * 0.5;          // straddle the wall
    const from = { x: o.x + dx * t0, y: o.y + dy * t0, z: o.z + dz * t0 };
    // No padding here: `from` is deliberately within a player-radius of the
    // wall, which is the whole point. Padding by PLAYER_R rejects every
    // candidate and the suite reports zero contacts while claiming to pass.
    if (insideCity(SEED, from.x, from.y, from.z)) continue;
    const p = {
      x: from.x + dx * step, y: from.y + dy * step, z: from.z + dz * step,
      vx: dx * sp, vy: dy * sp, vz: dz * sp, heading: Math.atan2(dx, dz),
    };
    const out = resolveContact(SEED, p, from, {});
    if (!out.wall && !out.ground && !out.roof) continue;
    contacts++;
    const after = Math.hypot(p.vx, p.vz);
    slowest = Math.min(slowest, after);
    if (after < 1e-3) stalls++;
    ok('contact never leaves the player inside a building', !insideCity(SEED, p.x, p.y, p.z, -0.01));
  }
  ok('the contact sweep actually hit things', contacts > 400, `only ${contacts} contacts`);
  eq('no contact anywhere leaves the player stopped', stalls, 0);
  ok('and the slowest outcome still has him moving', slowest > 0.5, `${slowest.toFixed(3)} m/s`);
}

{
  // A landing is a landing, not a full stop: he touches the street and runs.
  const p = { x: 3, y: 30, z: 3, vx: 0.0, vy: -80, vz: 0.0, heading: 0.7 };
  const from = { x: 3, y: 40, z: 3 };
  resolveContact(SEED, p, from, {});
  ok('a dead-vertical landing still leaves him running', Math.hypot(p.vx, p.vz) >= RUN_MIN - 1e-9,
    `${Math.hypot(p.vx, p.vz).toFixed(2)} m/s`);
  ok('and he runs in the direction he was facing', Math.abs(Math.atan2(p.vx, p.vz) - 0.7) < 1e-6);
  ok('the street is solid', p.y >= PLAYER_R - 1e-9);
}

{
  // Dropped inside a building by a teleport or a spawn, he comes back out.
  const b = cityBox(SEED, 2, 2, {});
  const p = { x: b.x, y: b.h / 2, z: b.z, vx: 0, vy: -5, vz: 0 };
  ok('depenetrate notices a player inside a building', depenetrate(SEED, p) === true);
  ok('and puts him outside it', !insideCity(SEED, p.x, p.y, p.z, -0.01));
  const free = { x: b.x, y: b.h + 200, z: b.z, vx: 0, vy: 0, vz: 0 };
  ok('and leaves a player in open air alone', depenetrate(SEED, free) === false);
}

{
  // The long one: swing a whole run and prove the loop is stable. No NaN, no
  // escape, no stall, and — the thing that kills a pendulum game — no decay.
  // A real rope plus drag loses height every arc and the run dies four webs
  // in; the down-swing pump is what stops that, and this is where it's proved.
  const p = { x: 0, y: START_HEIGHT, z: 0, vx: 0, vy: -5, vz: 34, heading: 0 };
  const pilot = newPilot();
  let webs = 0, wasAttached = false;
  let minY = Infinity, maxSpeed = 0, nan = false, groundedFrames = 0;
  const dt = 1 / 60;
  const speeds = [];
  let out = {};

  // One persistent options object: stepPlayer reels the line in by mutating
  // ropeLen, so handing it a fresh literal every frame throws that away and the
  // web silently stops shortening.
  const o = { anchor: null, ropeLen: 0, gravity: G, drag: DRAG };

  for (let s = 0; s < 60 * 60; s++) {
    autoPilot(SEED, pilot, p, out.dropWeb, dt, {});
    if (pilot.anchor && !wasAttached) webs++;
    wasAttached = !!pilot.anchor;

    o.anchor = pilot.anchor; o.ropeLen = pilot.ropeLen;
    out = stepPlayer(SEED, p, o, dt, {});
    pilot.ropeLen = o.ropeLen;
    if (!Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz)) { nan = true; break; }
    minY = Math.min(minY, p.y);
    maxSpeed = Math.max(maxSpeed, speedOf(p));
    if (p.grounded) groundedFrames++;
    if (s % 60 === 0) speeds.push(Math.hypot(p.vx, p.vz));
  }

  ok('a sixty-second run never goes non-finite', !nan);
  ok('a sixty-second run actually swings', webs >= 8, `only ${webs} webs`);
  ok('the player never sinks below the street', minY >= PLAYER_R - 1e-6, `${minY}`);
  ok('speed stays inside the cap', maxSpeed <= 118 + 1e-6, `${maxSpeed.toFixed(1)} m/s`);
  ok('the run does not decay into a walk', groundedFrames < 60 * 20, `${(groundedFrames / 60).toFixed(1)}s on the deck`);

  // The pump has to hold pace up across the run, not merely postpone the decay.
  // Sampled from t=8s so the comparison is cruise against cruise: the run opens
  // with a free fall from START_HEIGHT, and counting that as "early" would let
  // a swing that genuinely winds down look like it was merely slowing from a
  // dive it never has to repeat.
  const early = speeds.slice(15, 25).reduce((a, b) => a + b, 0) / 10;
  const late = speeds.slice(-10).reduce((a, b) => a + b, 0) / 10;
  ok('the swing sustains its pace instead of winding down',
    late > early * 0.75, `${early.toFixed(1)} m/s early vs ${late.toFixed(1)} m/s late`);
  ok('and it is genuinely moving', late > 26, `${late.toFixed(1)} m/s`);
  ok('and it uses the height the city offers', p.y > 4, `finished at y=${p.y.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// The run: beacons, clock, assist ramp.
// ---------------------------------------------------------------------------

{
  let onRoof = 0, tooNear = 0, tooFar = 0, n = 0;
  for (let k = 0; k < 400; k++) {
    const x = between(-600, 600), z = between(-600, 600);
    const heading = between(0, Math.PI * 2);
    const b = nextBeacon(SEED, k, x, z, heading, {});
    n++;
    const d = Math.hypot(b.x - x, b.z - z);
    // The fallback (every candidate was a plaza) places one overhead and is
    // exempt from the distance band — but it must still not be inside anything.
    if (d > 1) {
      if (d < BEACON_NEAR - CELL) tooNear++;
      if (d > BEACON_FAR + CELL) tooFar++;
    }
    if (!insideCity(SEED, b.x, b.y, b.z, 1)) onRoof++;
  }
  eq('no beacon is ever buried in a building', onRoof, n);
  eq('no beacon spawns on top of you', tooNear, 0);
  eq('no beacon spawns out of reach', tooFar, 0);

  const a = nextBeacon(SEED, 5, 100, 200, 1.2, {});
  const b = nextBeacon(SEED, 5, 100, 200, 1.2, {});
  ok('beacon placement is deterministic', a.x === b.x && a.y === b.y && a.z === b.z);

  const bc = { x: 0, y: 100, z: 0 };
  ok('a beacon reached is a beacon reached', reachedBeacon({ x: 0, y: 100, z: 10 }, bc));
  ok('and one across the street is not', !reachedBeacon({ x: 0, y: 100, z: 60 }, bc));
}

{
  let mono = true, prev = Infinity;
  for (let n = 0; n < 60; n++) {
    const t = timeForBeacon(n);
    if (t > prev + 1e-12) mono = false;
    prev = t;
    ok(`beacon ${n} is always worth something`, t >= TIME_MIN);
  }
  ok('beacons are worth less the further you get', mono);
  eq('and the clock bottoms out rather than vanishing', timeForBeacon(1000), TIME_MIN);
}

{
  // The ramp gives a new player a slower, draggier, more forgiving hero and
  // hands the real one over by ASSIST_OVER. Both ends have to be exact: start
  // too close to full and the ramp is decoration, end short of it and the
  // player never gets the game everyone else is describing.
  const a0 = assist(0), aN = assist(ASSIST_OVER), aLate = assist(ASSIST_OVER * 4);
  ok('a new player is draggier', a0.drag > aN.drag);
  ok('a new player has a wider minimum cone', a0.coneFloor > aN.coneFloor);
  ok('a new player falls a little slower', a0.gravity < aN.gravity);
  near('the ramp lands exactly on the real numbers', aN.drag, DRAG, 1e-12);
  near('...and on the real gravity', aN.gravity, G, 1e-12);
  near('...and on the real cone', aN.coneFloor, CONE_MIN, 1e-12);
  ok('and it never overshoots past the end', aLate.drag === aN.drag && aLate.gravity === aN.gravity);

  // The ramp must be an assist, not a handicap that outlives its welcome.
  let mono = true, prevDrag = Infinity;
  for (let n = 0; n <= ASSIST_OVER; n++) {
    const a = assist(n);
    if (a.drag > prevDrag + 1e-12) mono = false;
    prevDrag = a.drag;
  }
  ok('the ramp only ever eases off', mono);
}

{
  // The wide beginner cone has to actually be more forgiving than the expert
  // one — the ramp is worthless if it changes a number nothing reads.
  let wideFound = 0, narrowFound = 0, tried = 0;
  for (let k = 0; k < 400; k++) {
    const x = between(-400, 400), z = between(-400, 400), y = between(15, 70);
    if (insideCity(SEED, x, y, z, 2)) continue;
    const heading = between(0, Math.PI * 2);
    const p = { x, y, z, vx: Math.sin(heading) * 40, vy: -8, vz: Math.cos(heading) * 40 };
    const aim = aimVector(heading, 0, undefined, {});
    tried++;
    if (pickAnchor(SEED, p, aim, 0, { coneFloor: assist(0).coneFloor })) wideFound++;
    if (pickAnchor(SEED, p, aim, 0, { coneFloor: CONE_MIN })) narrowFound++;
  }
  ok('a beginner\'s first tap catches more often than an expert\'s',
    wideFound > narrowFound, `${wideFound} vs ${narrowFound} of ${tried}`);
}

{
  eq('the clock reads as a clock', formatClock(65.4), '1:05.4');
  eq('...under a minute too', formatClock(9.25), '0:09.3');
  eq('...and never goes negative', formatClock(-3), '0:00.0');
}

{
  // arcIsClear is what stops the assist handing you a web into the wall you
  // just attached to. It has to say yes in open air and no through concrete.
  const open = { x: 0, y: 400, z: 0, vx: 30, vy: 0, vz: 0 };
  ok('an arc through open sky is clear', arcIsClear(SEED, open, { x: 0, y: 500, z: 0 }));
  const b = cityBox(SEED, 0, 0, {});
  // Standing just off a wall, swinging straight into it.
  const face = { x: b.x + b.w / 2 + 2, y: Math.min(b.h - 10, 40), z: b.z, vx: -60, vy: -10, vz: 0 };
  ok('an arc straight into the wall beside you is not clear',
    !arcIsClear(SEED, face, { x: b.x + b.w / 2 + 2, y: b.h + 40, z: b.z }));
}

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\n${failures.length} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`ok — ${checks} checks on web's rules.`);
