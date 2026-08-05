// web-rules.mjs — assertions against games/web/rules.js.
//
//   node tools/web-rules.mjs
//
// Zero dependencies, same idiom as wake-rules.mjs, carve-rules.mjs and
// span-physics.mjs beside it: not a build step, nothing on the site depends on
// it, and it emits nothing.
//
// Web generates its city, which means "can this be played?" is a question no
// amount of playtesting answers — the run that traps you is the seed you have
// not drawn yet. So the last section flies an autopilot through a dozen seeds
// and several kilometres of city each. It is a crude pilot on purpose: if
// something that dumb can keep a run alive, a person can.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'games', 'web');
const R = await import(path.join(WEB, 'rules.js'));

const {
  clamp,
  G, DRAG, V_MAX, PLAYER_R, MAX_ROPE, MIN_ROPE, PAYOUT, HAUL, MIN_UP, IDEAL_ANG,
  speed, capSpeed, integrate, applyRope, settleRope, swingAssist, ROOF_MARGIN,
  releaseBoost, PERFECT_BOOST, pickAnchor,
  difficulty, START_SAFE, RAMP, ANCHOR_LOOK, SAFE_CLEAR, ANCHOR_Y_MAX,
  makeRng, createCity, hits, START,
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
const near = (what, a, b, tol = 1e-6) => ok(what, Math.abs(a - b) <= tol, `${a} !== ${b} (±${tol})`);

const SEEDS = [
  1, 7, 42, 99, 1234, 20250805, 0xbeef, 31337, 555, 8, 61803, 27182,
  3, 77, 404, 8675309, 90210, 12, 999983, 2718281,
];
const dist = (p, a) => Math.hypot(p.x - a.x, p.y - a.y);

// ---------------------------------------------------------------------------
// The rope is a rope
// ---------------------------------------------------------------------------
{
  const a = { x: 0, y: 0 };
  const slack = { x: 3, y: -4, vx: 5, vy: 5 };
  ok('a slack rope does nothing at all', applyRope(slack, a, 10) === false);
  near('and leaves the velocity untouched', slack.vx, 5);

  const taut = { x: 0, y: -20, vx: 6, vy: -9 };
  applyRope(taut, a, 10);
  near('a taut rope pulls the player back onto the circle', dist(taut, a), 10, 1e-9);
  near('and cancels the outward velocity exactly', taut.vy, 0, 1e-9);
  near('while the tangential part survives', taut.vx, 6, 1e-9);

  // swinging up past the anchor must not be yanked back down
  const over = { x: 2, y: 3, vx: 4, vy: 2 };
  ok('above the anchor and inside the rope, nothing is applied',
    applyRope(over, a, 10) === false);

  // energy: a swing released from horizontal must not gain energy on its own
  const sub = { x: 12, y: 0, vx: 0, vy: 0 };
  const anchor = { x: 0, y: 0 };
  const step = 1 / 4000;
  let vBottom = 0;
  for (let i = 0; i < 12000 && sub.x > 0; i++) {
    integrate(sub, step);
    applyRope(sub, anchor, 12);
    vBottom = speed(sub);
  }
  ok('and it reaches the bottom of the arc at all', sub.x <= 0, `stopped at x=${sub.x.toFixed(2)}`);
  const ideal = Math.sqrt(2 * G * 12);
  ok('an unassisted swing arrives at the bottom at no more than the drop predicts',
    vBottom <= ideal + 1e-6, `${vBottom.toFixed(3)} vs ${ideal.toFixed(3)} m/s`);
  ok('and drag costs it less than 12%', vBottom > ideal * 0.88,
    `${vBottom.toFixed(3)} vs ${ideal.toFixed(3)} m/s`);
}

// ---------------------------------------------------------------------------
// Reeling in, pumping, and the speed ceiling
// ---------------------------------------------------------------------------
{
  near('a short line pays out toward the safe length', settleRope(10, 0.5, 26), 10 + PAYOUT * 0.5);
  near('a long one is hauled in, and far harder', settleRope(20, 0.1, 8), 20 - HAUL * 0.1);
  near('the haul stops at the safe length rather than overshooting it', settleRope(8.1, 1, 8), 8);
  near('and so does the payout', settleRope(7.9, 1, 8), 8);
  near('MIN_ROPE is the floor even if an anchor asks for less', settleRope(3, 1, 1), MIN_ROPE);
  ok('a settled line stays settled', settleRope(settleRope(12, 1 / 60, 12), 1 / 60, 12) === 12);

  const a = { x: 0, y: 0 };
  const p = { x: -8, y: -9, vx: 6, vy: 0 };
  const before = speed(p);
  swingAssist(p, a, 0.1);
  ok('the pump accelerates you along the arc you are already on', speed(p) > before,
    `${before.toFixed(2)} -> ${speed(p).toFixed(2)}`);
  const back = { x: -8, y: -9, vx: -6, vy: 0 };
  swingAssist(back, a, 0.1);
  ok('and backwards too, if that is the way you are swinging', back.vx < -6, `${back.vx}`);

  const top = { x: 3, y: 1, vx: 5, vy: 0 };
  swingAssist(top, a, 0.1);
  near('but never above the anchor', top.vx, 5);

  const fast = { x: 0, y: -10, vx: V_MAX, vy: 0 };
  swingAssist(fast, a, 0.2);
  ok('and never past the speed ceiling', speed(fast) <= V_MAX + 1e-9, `${speed(fast)}`);

  const over = capSpeed({ x: 0, y: 0, vx: V_MAX * 2, vy: 0 });
  near('capSpeed clamps the magnitude', speed(over), V_MAX, 1e-9);
  const drifting = { x: 0, y: 0, vx: V_MAX, vy: 0 };
  integrate(drifting, 0.1);
  ok('and free flight cannot exceed it either', speed(drifting) <= V_MAX + 1e-9,
    `${speed(drifting)}`);
}

// ---------------------------------------------------------------------------
// The release window
// ---------------------------------------------------------------------------
{
  const a = { x: 0, y: 0 };
  const bottom = { x: 0.5, y: -12, vx: 20, vy: 1 };
  const s0 = speed(bottom);
  ok('letting go through the bottom of the arc is rewarded', releaseBoost(bottom, a) === true);
  near('by exactly PERFECT_BOOST', speed(bottom), s0 * PERFECT_BOOST, 1e-9);

  const side = { x: 11, y: -5, vx: 20, vy: 8 };
  ok('letting go out at the side is not', releaseBoost(side, a) === false);

  const backwards = { x: 0, y: -12, vx: -20, vy: 0 };
  ok('nor is letting go while swinging backwards', releaseBoost(backwards, a) === false);

  const quick = { x: 0, y: -12, vx: V_MAX - 0.5, vy: 0 };
  releaseBoost(quick, a);
  ok('and the boost never breaks the ceiling', speed(quick) <= V_MAX + 1e-9, `${speed(quick)}`);
}

// ---------------------------------------------------------------------------
// Aim: the anchor a tap grabs
// ---------------------------------------------------------------------------
{
  const at = (x, y) => ({ x, y });
  const anchors = [at(-10, 20), at(5, 18), at(14, 22), at(40, 30)];

  const got = pickAnchor(anchors, 0, 10);
  ok('a tap grabs something ahead and above', got && got.x > 0, JSON.stringify(got));
  ok('never something out of reach', pickAnchor([at(0, 10 + MAX_ROPE + 1)], 0, 10) === null);
  ok('never something level with you', pickAnchor([at(8, 10 + MIN_UP - 0.5)], 0, 10) === null);
  ok('never something behind you', pickAnchor([at(-20, 24)], 0, 10) === null);
  ok('never something already inside the reel', pickAnchor([at(0, 10 + MIN_ROPE - 0.5)], 0, 10) === null);
  ok('and an empty sky returns nothing rather than throwing', pickAnchor([], 0, 10) === null);

  // between two legal anchors, the one nearer the ideal swing angle wins
  const steep = at(2, 10 + 18);                       // almost straight up
  const flat = at(18, 10 + 5);                        // almost level
  const good = at(12, 10 + 13);                       // ~47°
  const chosen = pickAnchor([steep, flat, good], 0, 10);
  ok('and of three in reach it takes the one at a swingable angle', chosen === good,
    JSON.stringify(chosen));
  ok('IDEAL_ANG is a forward swing, not a ladder',
    IDEAL_ANG > 0.6 && IDEAL_ANG < 1.2, `${IDEAL_ANG} rad`);
}

// ---------------------------------------------------------------------------
// The city the generator builds
// ---------------------------------------------------------------------------
{
  near('difficulty is flat through the opening', difficulty(START_SAFE - 1), 0);
  near('and tops out exactly once', difficulty(START_SAFE + RAMP * 2), 1);

  for (const seed of SEEDS) {
    const city = createCity(makeRng(seed));
    city.ensure(4000);

    // 1. anchors stay inside a web's reach of each other
    let worstGap = 0;
    for (let i = 1; i < city.anchors.length; i++) {
      worstGap = Math.max(worstGap, city.anchors[i].x - city.anchors[i - 1].x);
    }
    ok(`seed ${seed}: consecutive anchors stay within reach`,
      worstGap <= MAX_ROPE * 0.85, `${worstGap.toFixed(2)} m > ${(MAX_ROPE * 0.85).toFixed(2)} m`);
    // each anchor must account for the roofs all the way to its neighbours, or
    // a tower can sit in the blind spot between two of them
    ok(`seed ${seed}: the clearance windows of neighbouring anchors overlap`,
      ANCHOR_LOOK >= worstGap, `look ${ANCHOR_LOOK} m < widest gap ${worstGap.toFixed(2)} m`);

    // 2. every anchor clears the roofs it has to swing over
    let worstClear = Infinity, worstAt = 0;
    for (const a of city.anchors) {
      const c = a.y - city.maxRoof(a.x - ANCHOR_LOOK, a.x + ANCHOR_LOOK);
      if (c < worstClear) { worstClear = c; worstAt = a.x; }
    }
    ok(`seed ${seed}: every anchor sits clear of its own rooftops`,
      worstClear >= SAFE_CLEAR, `${worstClear.toFixed(2)} m at x=${worstAt.toFixed(0)}`);

    // 3. nothing is drawn above the sky, or below the street
    ok(`seed ${seed}: anchors stay under the ceiling`,
      city.anchors.every((a) => a.y <= ANCHOR_Y_MAX), 'an anchor is off the top of the world');
    ok(`seed ${seed}: buildings stand on the street`,
      city.buildings.every((b) => b.h > 0 && b.w > 0), 'a building has no size');

    // 4. buildings are laid out left to right and never overlap
    let overlaps = 0;
    for (let i = 1; i < city.buildings.length; i++) {
      const prev = city.buildings[i - 1], b = city.buildings[i];
      if (b.x < prev.x + prev.w) overlaps++;
    }
    ok(`seed ${seed}: buildings do not intersect each other`, overlaps === 0, `${overlaps} overlaps`);

    // 5. the same seed builds the same city
    const twin = createCity(makeRng(seed));
    twin.ensure(4000);
    ok(`seed ${seed}: the city is a pure function of the seed`,
      JSON.stringify(twin.anchors) === JSON.stringify(city.anchors));
  }

  // the opening is survivable on frame one, from a standing start
  for (const seed of SEEDS) {
    const city = createCity(makeRng(seed));
    city.ensure(200);
    ok(`seed ${seed}: the run does not begin inside a building`,
      !hits(city, START.x, START.y), 'START overlaps the city');
    ok(`seed ${seed}: there is a web in reach on the first frame`,
      pickAnchor(city.anchors, START.x, START.y) !== null, 'nothing to grab at START');
  }
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
{
  const city = { buildings: [{ x: 0, w: 10, h: 20 }] };
  ok('the street kills', hits(city, 50, 0.5));
  ok('a rooftop kills', hits(city, 5, 20 - PLAYER_R * 0.5));
  ok('a wall kills', hits(city, -PLAYER_R * 0.5, 10));
  ok('open sky above the roof does not', !hits(city, 5, 20 + PLAYER_R + 0.01));
  ok('open sky beside the wall does not', !hits(city, -PLAYER_R - 0.01, 10));
  ok('and the corner is a circle, not a box',
    !hits(city, -PLAYER_R * 0.8, 20 + PLAYER_R * 0.8), 'clipped a corner it should have missed');
}

// ---------------------------------------------------------------------------
// The autopilots
//
// Two pilots, because the interesting property is not "can it be flown" but
// "does flying it safely cost you anything". Both are deliberately crude: no
// lookahead, no anchor comparison, no plan. Neither is meant to be good.
//
//   CAUTIOUS holds each web through the up-swing and lets go only once it can
//   already see its next anchor. It must never die. If something that dumb can
//   keep a run alive across every seed, the generator is not laying traps.
//
//   GREEDY lets go at the bottom of every arc, which is the fastest possible
//   line and sheds altitude every swing. It must go noticeably faster than
//   CAUTIOUS and must eventually die. If it survived too, height would not
//   matter and the game would have no decision in it at all.
// ---------------------------------------------------------------------------
{
  const DT = 1 / 120;

  // the third pilot: never lets go at all
  function hold(seed, maxSeconds) {
    const city = createCity(makeRng(seed));
    const p = { ...START };
    let anchor = null, rope = 0;
    for (let t = 0; t < maxSeconds; t += DT) {
      city.ensure(p.x + 140);
      city.prune(p.x - 60);
      if (anchor) {
        rope = settleRope(rope, DT, anchor.clear);
        swingAssist(p, anchor, DT);
      } else {
        const a = pickAnchor(city.anchors, p.x, p.y);
        if (a) { anchor = a; rope = dist(p, a); }
      }
      integrate(p, DT);
      if (anchor) applyRope(p, anchor, rope);
      if (hits(city, p.x, p.y)) return { crashed: true, x: p.x };
    }
    return { crashed: false, x: p.x };
  }

  function fly(seed, maxSeconds, greedy) {
    const city = createCity(makeRng(seed));
    const p = { ...START };
    let anchor = null, rope = 0, perfects = 0;
    for (let t = 0; t < maxSeconds; t += DT) {
      city.ensure(p.x + 140);
      city.prune(p.x - 60);

      if (anchor) {
        const past = p.x > anchor.x + 1 && p.vy > 0;
        // greedy lets go the moment it is past and rising; cautious keeps
        // climbing until the next web is in range
        const ready = greedy ? past : past && pickAnchor(city.anchors, p.x, p.y) !== null;
        if (ready || p.x - anchor.x > MAX_ROPE * 0.9) {
          if (releaseBoost(p, anchor)) perfects++;
          anchor = null;
        } else {
          rope = settleRope(rope, DT, anchor.clear);
          swingAssist(p, anchor, DT);
        }
      }
      // the web is *held*, not tapped: while nothing is attached it keeps
      // reaching, and grabs the first anchor that comes into range
      if (!anchor) {
        const a = pickAnchor(city.anchors, p.x, p.y);
        if (a) { anchor = a; rope = dist(p, a); }
      }

      integrate(p, DT);
      if (anchor) applyRope(p, anchor, rope);
      if (hits(city, p.x, p.y)) return { crashed: true, x: p.x, t, perfects };
    }
    return { crashed: false, x: p.x, t: maxSeconds, perfects };
  }

  const RUN = 120;
  let deepest = 0, greedyDeaths = 0, safeTotal = 0, fastTotal = 0;
  for (const seed of SEEDS) {
    const safe = fly(seed, RUN, false);
    ok(`seed ${seed}: the cautious pilot survives ${RUN} seconds`, !safe.crashed,
      `crashed at ${safe.x.toFixed(0)} m after ${safe.t.toFixed(1)} s`);
    if (!safe.crashed) {
      const pace = safe.x / safe.t;
      ok(`seed ${seed}: and covers ground at a swinging pace`, pace > 8 && pace < V_MAX,
        `${pace.toFixed(1)} m/s over ${safe.x.toFixed(0)} m`);
      ok(`seed ${seed}: earning the timing bonus without aiming for it`, safe.perfects > 0,
        `${safe.perfects} clean releases`);
      deepest = Math.max(deepest, safe.x);
    }

    const fast = fly(seed, RUN, true);
    if (fast.crashed) greedyDeaths++;
    ok(`seed ${seed}: the greedy line is the faster one`, fast.x / fast.t > safe.x / safe.t,
      `greedy ${(fast.x / fast.t).toFixed(1)} vs cautious ${(safe.x / safe.t).toFixed(1)} m/s`);
    safeTotal += safe.x;
    fastTotal += fast.x;
  }

  // The shape of the whole game, in two numbers: the greedy line goes
  // meaningfully further, and pays for it often enough to be a real gamble.
  // If either of these drifts, the game has quietly become one-dimensional —
  // a safe line that is also the fast line, or a fast line with no downside.
  ok('the greedy line covers appreciably more ground', fastTotal > safeTotal * 1.25,
    `greedy ${(fastTotal / SEEDS.length).toFixed(0)} m vs cautious ${(safeTotal / SEEDS.length).toFixed(0)} m per run`);
  const rate = greedyDeaths / SEEDS.length;
  ok('and it is punished often enough to be a gamble', rate >= 0.15 && rate <= 0.7,
    `${greedyDeaths} of ${SEEDS.length} greedy runs ended in a crash`);
  ok('a run can reach the hardest city the generator builds',
    deepest > START_SAFE + RAMP, `deepest cautious run ${deepest.toFixed(0)} m`);

  // Never letting go is the other degenerate line, and it has to be answered
  // differently from never pressing: a held web keeps its own clearance, so it
  // cannot kill you. It has to be *pointless* instead. If this ever started
  // covering ground, holding the button down would be the whole game.
  {
    let stuck = 0, worst = 0;
    for (const seed of SEEDS) {
      const r = hold(seed, 120);
      if (!r.crashed) stuck++;
      worst = Math.max(worst, r.x);
    }
    ok('a web that is never released is safe', stuck === SEEDS.length,
      `${SEEDS.length - stuck} of ${SEEDS.length} hold-forever runs crashed`);
    ok('and goes nowhere — you have to let go to play', worst < 120,
      `the best hold-forever run still covered ${worst.toFixed(0)} m in 120 s`);
  }

  // and doing nothing at all is fatal — a run has to be a run
  {
    const city = createCity(makeRng(1));
    const p = { ...START };
    let dead = false;
    for (let t = 0; t < 12 && !dead; t += DT) {
      city.ensure(p.x + 140);
      integrate(p, DT);
      if (hits(city, p.x, p.y)) dead = true;
    }
    ok('never touching the screen ends the run', dead, 'the player survived doing nothing');
  }
}

// ---------------------------------------------------------------------------

if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  console.log(`\n${failures.length} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`ok — ${checks} checks, ${SEEDS.length} seeds.`);
