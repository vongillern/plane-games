// Carve — the rules a test can check without a browser.
//
// Everything in this file is pure: no DOM, no Three.js, no clock, no
// Math.random. The mountain, the renderer and the input live in game.js; what
// *counts* lives here — when an obstacle can be flown over, whether a landing
// is clean, what a rotation is called and what it pays, how much speed a carve
// costs, what a grind is worth. tools/carve-rules.mjs checks all of it in Node
// in a few milliseconds, which is the only cheap way to keep a tuning tweak
// from quietly making trees unclearable or turning faster than going straight.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function normAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------
export const START_V = 17;       // downhill speed at the gate (m/s)
export const MAX_V = 40;         // terminal speed on a straight line
export const MIN_V = 14;         // a carve can never bring you below this
// How hard the mountain pulls. The old ramp had a ~17s time constant, so the
// first half of every run was spent waiting to get going; this reaches cruising
// speed in about six seconds and keeps a floor under it at the top end.
export const TOP_V = MAX_V + 2;  // what a straight line actually settles at
export const PULL = 0.16;        // rate = |cap - v| * PULL
export const PULL_MIN = 0.9;     // ...never less than this (m/s²), either way
// Edges cost speed. Holding a full-lock carve gives up this much off the top
// end; a lazy one gives up very little, because the loss is superlinear in edge
// pressure. Straight is the fast line — which is the point.
export const TURN_LOSS = 9;

export const turnLoss = (carve01) => TURN_LOSS * Math.pow(clamp(carve01, 0, 1), 1.6);

// One integration step of the speed model. `carve01` is edge pressure, 0..1.
// The mountain pulls toward whatever the current line can hold and never quite
// stops pulling — the floor is what makes the first six seconds feel steep. A
// rail has no snow under it, so a grind gives up nothing at all: that is why
// hitting one feels fast.
export function speedStep(v, carve01, dt, grinding = false) {
  const cap = grinding ? TOP_V : TOP_V - turnLoss(carve01);
  const gap = cap - v;
  const rate = Math.sign(gap) * Math.max(PULL_MIN, Math.abs(gap) * PULL);
  return clamp(v + rate * dt, MIN_V, TOP_V);
}

// Speed the model settles at while a carve of this pressure is held.
export function cruiseSpeed(carve01, dt = 1 / 60, steps = 2000) {
  let v = START_V;
  for (let i = 0; i < steps; i++) v = speedStep(v, carve01, dt);
  return v;
}

// ---------------------------------------------------------------------------
// Obstacles
//
// Every obstacle is a cone of contact: `solid` metres of full-width base, then
// a taper to nothing at `h`. A rock is short and stubby, so an ollie clears it.
// A tree used to be `h: 99` — infinitely tall — which meant a kicker could
// carry you clean over the crown and still register a hit. Now the crown really
// does end, and the taper means a near-clear only clips if you fly right down
// the trunk line.
// ---------------------------------------------------------------------------
export const RIDER_R = 0.42;

export function obstacleRadius(o, hAbove) {
  if (hAbove >= o.h) return 0;                    // over the top: no contact
  if (hAbove <= o.solid) return o.r;
  return o.r * (1 - (hAbove - o.solid) / (o.h - o.solid));
}

export function hitsObstacle(o, dx, ds, hAbove, riderR = RIDER_R) {
  const r = obstacleRadius(o, hAbove);
  return r > 0 && Math.hypot(dx, ds) < r + riderR;
}

// Contact profiles, in metres, before the per-instance scale is applied.
export const TREE_SOLID = 1.0, TREE_CLEAR = 3.0;
export const ROCK_SOLID = 0.45;

export const treeBody = (sc) => ({ r: 0.62 * sc + 0.28, solid: TREE_SOLID * sc, h: TREE_CLEAR * sc });
export const rockBody = (sc) => ({ r: 0.72 * sc + 0.2, solid: ROCK_SOLID * sc, h: 0.95 * sc });

// ---------------------------------------------------------------------------
// Landings
// ---------------------------------------------------------------------------
export const ALIGN_TOL = 0.96;   // rad (~55°) of yaw slop allowed on touchdown
export const FLIP_TOL = 0.95;    // rad (~54°) of flip slop allowed on touchdown

// `spin`/`flip` are the live angles; the totals are how far the board went
// round, which is what the trick is named after. Riding switch is style, not a
// fall, so the nearest 180° counts as straight for yaw — but a flip has to come
// all the way back over.
export function landingVerdict({ spin = 0, flip = 0, spinTotal = 0, flipTotal = 0 }) {
  let mis = normAngle(spin);
  if (mis > Math.PI / 2) mis -= Math.PI;
  if (mis < -Math.PI / 2) mis += Math.PI;
  const flipMis = normAngle(flip);
  return {
    aligned: Math.abs(mis) < ALIGN_TOL && Math.abs(flipMis) < FLIP_TOL,
    yawOff: Math.abs(mis),
    flipOff: Math.abs(flipMis),
    spins: Math.round(Math.abs(spinTotal) / Math.PI),
    flips: Math.round(Math.abs(flipTotal) / TAU),
    flipDir: Math.sign(flipTotal),
  };
}

// ---------------------------------------------------------------------------
// Tricks
// ---------------------------------------------------------------------------
export function spinPoints(spins) {
  if (spins <= 0) return 0;
  return spins === 1 ? 40 : spins === 2 ? 100 : spins === 3 ? 180 : 100 * spins - 120;
}
export function flipPoints(flips) {
  if (flips <= 0) return 0;
  return flips === 1 ? 120 : flips === 2 ? 320 : 300 * flips - 300;
}

// What the rider just did, named and priced. `flipDir` is -1 for a backflip
// (nose comes up and over) and +1 for a frontflip.
export function trickScore({ spins = 0, flips = 0, flipDir = -1, airTime = 0, grabbed = false }) {
  let pts = spinPoints(spins) + flipPoints(flips);
  const flipWord = flipDir > 0 ? 'frontflip' : 'backflip';
  let label = '';
  if (flips > 0 && spins > 0) {
    // a flip and a spin at once is the trick with a name of its own
    label = `${flipDir > 0 ? 'misty' : 'rodeo'} ${spins * 180}°`;
    pts += 60;
  } else if (flips > 0) {
    label = flips === 1 ? flipWord : flips === 2 ? `double ${flipWord}` : `${flips}× ${flipWord}`;
  } else if (spins > 0) {
    label = `${spins * 180}°`;
  }
  if (grabbed) {
    if (label) { label += ' + grab'; pts += 35; }
    else { label = 'method grab'; pts = 45; }
  } else if (!label && airTime > 0.85) {
    label = 'clean air';
    pts = 25;
  }
  return { label, pts };
}

// ---------------------------------------------------------------------------
// Grinds
// ---------------------------------------------------------------------------
export const GRIND_PER_M = 9;
export const grindPoints = (metres) => Math.max(0, Math.round(metres * GRIND_PER_M));

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------
export const STREAK_ON = 3;      // tricks in a row before the board lights up
// 0 while cold, ramping to 1 as the streak builds — everything visual reads
// this one number so the board, the trail and the sparks can never disagree.
export const streakHeat = (streak) => clamp((streak - (STREAK_ON - 1)) / 4, 0, 1);
