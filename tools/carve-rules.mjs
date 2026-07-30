// carve-rules.mjs — assertions against games/carve/rules.js.
//
//   node tools/carve-rules.mjs
//
// Zero dependencies, same idiom as span-physics.mjs beside it: not a build
// step, nothing on the site depends on it, and it emits nothing.
//
// Carve's rules used to live inside a 1800-line render loop, where the only way
// to ask "can a kicker carry me over a tree?" was to play until one showed up.
// The answer had been *no* for the life of the game — trees were infinitely
// tall — and no amount of playtesting says why. rules.js is pure, so every
// question below is a function call.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CARVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'games', 'carve');
const R = await import(path.join(CARVE, 'rules.js'));

const {
  TAU, TOP_V, MIN_V, START_V,
  cruiseSpeed, speedStep, turnLoss,
  treeBody, rockBody, obstacleRadius, hitsObstacle,
  landingVerdict, trickScore, spinPoints, flipPoints,
  grindPoints, streakHeat, STREAK_ON,
} = R;

// ---------------------------------------------------------------------------
// Harness: every check names what it wanted and prints what it got.
// ---------------------------------------------------------------------------
const failures = [];
let checks = 0;
function ok(what, cond, detail = '') {
  checks++;
  if (!cond) failures.push(detail ? `${what}\n        got: ${detail}` : what);
}
const eq = (what, a, b) => ok(what, Object.is(a, b), `${a} !== ${b}`);
const near = (what, a, b, tol = 1e-6) => ok(what, Math.abs(a - b) <= tol, `${a} !== ${b} (±${tol})`);

// ---------------------------------------------------------------------------
// Speed: straight is the fast line
// ---------------------------------------------------------------------------
{
  const straight = cruiseSpeed(0);
  const lazy = cruiseSpeed(0.35);
  const hard = cruiseSpeed(1);

  near('a straight line settles at the top of the range', straight, TOP_V, 0.2);
  ok('a held full carve is slower than a straight line', hard < straight - 3,
    `hard ${hard.toFixed(1)} vs straight ${straight.toFixed(1)}`);
  ok('...but only a little: a full carve keeps three quarters of its speed',
    hard > straight * 0.72, `${hard.toFixed(1)} of ${straight.toFixed(1)}`);
  ok('a lazy carve costs a fraction of what a hard one does',
    straight - lazy < (straight - hard) / 3,
    `lost ${(straight - lazy).toFixed(1)} vs ${(straight - hard).toFixed(1)}`);
  ok('sharper always means slower', hard < lazy && lazy < straight,
    `${hard.toFixed(1)} < ${lazy.toFixed(1)} < ${straight.toFixed(1)}`);

  eq('no speed lost at all when riding flat', turnLoss(0), 0);
  ok('the loss is superlinear: half the edge is much less than half the cost',
    turnLoss(0.5) < turnLoss(1) / 2.5, String(turnLoss(0.5)));

  // A carve must never be able to bring the run to a halt.
  let v = START_V;
  for (let i = 0; i < 3000; i++) v = speedStep(v, 1, 1 / 60);
  ok('a carve held forever still never stalls the run', v >= MIN_V, String(v));

  // A rail is frictionless: it accelerates even while the finger is over.
  const onRail = speedStep(25, 1, 1 / 60, true);
  ok('a grind gains speed where a carve would lose it', onRail > 25, String(onRail));
}

// ---------------------------------------------------------------------------
// Obstacles: the bug this file was written for
// ---------------------------------------------------------------------------
{
  const tree = treeBody(1);
  const rock = rockBody(1);

  ok('a tree has a finite crown', Number.isFinite(tree.h) && tree.h < 4, String(tree.h));
  eq('at snow level a tree is full width', obstacleRadius(tree, 0), tree.r);
  eq('over the crown a tree cannot be hit at all', obstacleRadius(tree, tree.h + 0.01), 0);
  ok('the crown tapers rather than stopping dead',
    obstacleRadius(tree, tree.h * 0.75) < tree.r * 0.6, String(obstacleRadius(tree, tree.h * 0.75)));

  // The report: a kicker carried the rider over a tree and it still counted as
  // a hit. A kicker's apex is ~3.5 m over the snow (vy 11 m/s, g 26 m/s²,
  // launched off a 1.15 m lip).
  const KICKER_APEX = 1.15 + (11 * 11) / (2 * 26);
  ok('a kicker clears the snow by more than a tree is tall', KICKER_APEX > tree.h,
    `apex ${KICKER_APEX.toFixed(2)}m vs crown ${tree.h.toFixed(2)}m`);
  ok('flying over a tree dead centre is not a hit',
    !hitsObstacle(tree, 0, 0, KICKER_APEX), `apex ${KICKER_APEX.toFixed(2)}m`);
  ok('a big tree at the same apex is also cleared',
    !hitsObstacle(treeBody(1.15), 0, 0, KICKER_APEX), 'sc 1.15');

  // ...and the thing that must not have changed: on the snow, a tree kills.
  ok('riding into a tree still ends the run', hitsObstacle(tree, 0.3, 0, 0.4), 'grounded');
  ok('an ollie does not clear a tree', hitsObstacle(tree, 0, 0, 0.74), 'ollie apex 0.74m');
  ok('a rock is short enough to ollie', !hitsObstacle(rock, 0, 0, 1.0), 'ollie apex 1.0m');
  ok('but a rock ridden into still hits', hitsObstacle(rock, 0.2, 0, 0.05), 'grounded');
  ok('threading a gap 2m off the trunk is clean', !hitsObstacle(tree, 2, 0, 0), 'dx 2m');
}

// ---------------------------------------------------------------------------
// Landings
// ---------------------------------------------------------------------------
{
  const straight = landingVerdict({ spin: 0, flip: 0 });
  ok('a straight landing is clean', straight.aligned);
  ok('landing switch (180°) is style, not a fall',
    landingVerdict({ spin: Math.PI, spinTotal: Math.PI }).aligned);
  ok('landing sideways is sketchy', !landingVerdict({ spin: Math.PI / 2 }).aligned);
  ok('a completed flip lands clean',
    landingVerdict({ flip: TAU, flipTotal: TAU }).aligned);
  ok('a flip only half way round is sketchy',
    !landingVerdict({ flip: Math.PI, flipTotal: Math.PI }).aligned);
  ok('a clean spin with the nose still down is sketchy',
    !landingVerdict({ spin: 0, flip: 2.2 }).aligned);

  const v = landingVerdict({ spin: 0, flip: 0, spinTotal: -TAU, flipTotal: -TAU });
  eq('a full rotation counts as two 180s', v.spins, 2);
  eq('a full flip counts as one flip', v.flips, 1);
  eq('rotating nose-up is a backflip', v.flipDir, -1);
  eq('rotating nose-down is a frontflip', landingVerdict({ flipTotal: TAU }).flipDir, 1);
}

// ---------------------------------------------------------------------------
// Tricks
// ---------------------------------------------------------------------------
{
  const name = (o) => trickScore(o).label;
  const pts = (o) => trickScore(o).pts;

  eq('a plain hop is worth nothing', pts({ airTime: 0.3 }), 0);
  eq('a long straight air pays for itself', name({ airTime: 1.2 }), 'clean air');
  eq('a 360 is named in degrees', name({ spins: 2 }), '360°');
  eq('a backflip has a name of its own', name({ flips: 1, flipDir: -1 }), 'backflip');
  eq('and so does a frontflip', name({ flips: 1, flipDir: 1 }), 'frontflip');
  eq('two of them is a double', name({ flips: 2, flipDir: -1 }), 'double backflip');
  eq('a flip with a spin in it is a rodeo', name({ flips: 1, spins: 3, flipDir: -1 }), 'rodeo 540°');
  eq('...or a misty the other way', name({ flips: 1, spins: 2, flipDir: 1 }), 'misty 360°');
  eq('a still hand in the air is a method grab', name({ airTime: 1, grabbed: true }), 'method grab');
  eq('a grab on top of a rotation is called out', name({ spins: 2, grabbed: true }), '360° + grab');

  ok('a flip pays better than a 360 (it is harder)',
    flipPoints(1) > spinPoints(2), `${flipPoints(1)} vs ${spinPoints(2)}`);
  ok('a rodeo beats either of its halves',
    pts({ flips: 1, spins: 2 }) > Math.max(flipPoints(1), spinPoints(2)),
    String(pts({ flips: 1, spins: 2 })));
  ok('a grab adds to a trick rather than replacing it',
    pts({ spins: 2, grabbed: true }) > pts({ spins: 2 }));
  ok('every named rotation pays something', [1, 2, 3, 4, 5].every((n) => spinPoints(n) > 0 && flipPoints(n) > 0));
  ok('bigger rotations always pay more', [2, 3, 4, 5].every((n) => spinPoints(n) > spinPoints(n - 1)
    && flipPoints(n) > flipPoints(n - 1)));
}

// ---------------------------------------------------------------------------
// Grinds and streaks
// ---------------------------------------------------------------------------
{
  eq('a rail you barely touched pays nothing', grindPoints(0), 0);
  ok('a full 14m rail is worth about a 360', Math.abs(grindPoints(14) - 126) < 1, String(grindPoints(14)));
  ok('longer grinds pay more', grindPoints(12) > grindPoints(6));

  eq('one trick is not a streak', streakHeat(1), 0);
  eq(`the board stays cold below ${STREAK_ON}`, streakHeat(STREAK_ON - 1), 0);
  ok('it lights up the moment the streak starts', streakHeat(STREAK_ON) > 0);
  eq('and saturates rather than running away', streakHeat(99), 1);
  ok('heat only ever climbs', streakHeat(4) < streakHeat(6));
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\n${failures.length} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`ok — ${checks} checks on carve's rules.`);
