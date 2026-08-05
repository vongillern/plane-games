// wake-rules.mjs — assertions against games/wake/rules.js.
//
//   node tools/wake-rules.mjs
//
// Zero dependencies, same idiom as carve-rules.mjs and span-physics.mjs beside
// it: not a build step, nothing on the site depends on it, and it emits nothing.
//
// A race is the one genre in this collection where "it looked fine when I
// played it" proves almost nothing. Whether the course can actually be driven
// flat out, whether the lap counter survives a spin across the start line,
// whether eight standings can ever disagree with eight lap counts — none of
// those show up in a playtest until the one race where they do. All of them are
// arithmetic, and all of them are checked here.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'games', 'wake');
const R = await import(path.join(WAKE, 'rules.js'));

const {
  TAU, clamp,
  buildCourse, racingLine, courseRadius, TRACK_HALF, LAPS, GRID, R0,
  stepProgress, raceOrder, isFinished,
  V_MAX, V_BOOST, V_OFF, YAW_BASE, speedStep, speedCap, turnLoss, yawRate,
  BOOST_MAX, BOOST_ARM, boostStep, boostActive, draftFactor, DRAFT_LEN, DRAFT_HALF,
  waveHeight, waveSlope, waveRow, launchSpeed, LAUNCH_V, SWELL_MAX,
  RIVALS, PLAYER_HUE, aiPace, CATCHUP,
  formatTime, formatGap, ordinal,
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

const course = buildCourse();

// ---------------------------------------------------------------------------
// The course exists, closes, and is a sane length
// ---------------------------------------------------------------------------
{
  ok('the lap is between 1.1 and 1.6 km — about 45 seconds at racing speed',
    course.length > 1100 && course.length < 1600, `${course.length.toFixed(0)} m`);

  const lapTime = course.length / (V_MAX * 0.86);
  ok('a three-lap race runs 1.5–3 minutes', lapTime * LAPS > 90 && lapTime * LAPS < 180,
    `${(lapTime * LAPS).toFixed(0)} s`);

  // equal-arc resampling: every segment the same length as every other
  let min = Infinity, max = 0;
  for (let i = 0; i < course.samples; i++) {
    const b = (i + 1) % course.samples;
    const d = Math.hypot(course.xs[b] - course.xs[i], course.zs[b] - course.zs[i]);
    min = Math.min(min, d); max = Math.max(max, d);
  }
  ok('samples are evenly spaced along the arc, not along the angle',
    max / min < 1.02, `${min.toFixed(3)}–${max.toFixed(3)} m`);

  const p0 = course.sample(0), pEnd = course.sample(course.length - 1e-9);
  ok('the loop closes', Math.hypot(p0.x - pEnd.x, p0.z - pEnd.z) < 0.5,
    `${Math.hypot(p0.x - pEnd.x, p0.z - pEnd.z).toFixed(3)} m apart`);
}

// ---------------------------------------------------------------------------
// The course never crosses itself, and never crosses its own banks
//
// This is the assumption every other number in the game rests on. If two parts
// of the channel overlap, "how far around are you?" has two answers, and the
// lap counter, the standings and the AI all quietly pick the wrong one.
// ---------------------------------------------------------------------------
{
  let minR = Infinity;
  for (let i = 0; i < 2000; i++) minR = Math.min(minR, courseRadius((i / 2000) * TAU));
  ok('the radius never reaches zero, so the curve is star-shaped and simple',
    minR > R0 * 0.4, `min radius ${minR.toFixed(1)} m`);

  // Non-adjacent stretches of the centreline must stay more than a full channel
  // width apart, or the outside of one corner is the inside of another.
  const N = course.samples;
  let closest = Infinity, where = '';
  for (let i = 0; i < N; i += 2) {
    for (let j = i + 40; j < N - 20; j += 2) {
      const d = Math.hypot(course.xs[j] - course.xs[i], course.zs[j] - course.zs[i]);
      const apart = Math.min(j - i, N - (j - i)) * course.step;
      if (apart < 90) continue;              // adjacent along the track, fine
      if (d < closest) { closest = d; where = `${i}↔${j}`; }
    }
  }
  ok('separate stretches of course never come within two channel widths',
    closest > TRACK_HALF * 2.2, `closest ${closest.toFixed(1)} m at ${where}`);
}

// ---------------------------------------------------------------------------
// It can be driven
//
// A corner tighter than the ski can turn is not a challenge, it is a wall.
// ---------------------------------------------------------------------------
{
  let tightest = 0, at = 0;
  for (let i = 0; i < course.samples; i++) {
    if (Math.abs(course.curv[i]) > tightest) { tightest = Math.abs(course.curv[i]); at = i; }
  }
  const radius = 1 / tightest;

  // the tightest turn the ski can hold, at the speed a full-lock turn settles at
  const vHairpin = V_MAX - turnLoss(1);
  const turnR = vHairpin / Math.abs(yawRate(vHairpin, 1));
  ok('the tightest corner is wider than the ski\'s own turning circle at full lock',
    radius > turnR * 1.15, `corner ${radius.toFixed(0)} m vs ski ${turnR.toFixed(0)} m`);

  ok('...but at least one corner is genuinely tight — it is a circuit, not a ring',
    radius < 130, `tightest corner ${radius.toFixed(0)} m at sample ${at}`);

  // and the channel is wide enough at that corner for the whole grid
  ok('eight skis abreast fit in the channel', TRACK_HALF * 2 > GRID * 2.6,
    `${(TRACK_HALF * 2).toFixed(0)} m for ${GRID} skis`);
}

// ---------------------------------------------------------------------------
// nearest(): the projection every other system reads
// ---------------------------------------------------------------------------
{
  // a point exactly on the centreline projects to itself, with no offset
  for (const frac of [0, 0.17, 0.5, 0.83]) {
    const s = course.length * frac;
    const p = course.sample(s);
    const n = course.nearest(p.x, p.z, -1);
    ok(`a point on the centreline reads zero lateral offset (at ${frac})`,
      Math.abs(n.lateral) < 0.3, `${n.lateral.toFixed(3)} m`);
    const ds = Math.abs(((n.s - s + course.length * 1.5) % course.length) - course.length / 2);
    ok(`...and reads back its own arc distance (at ${frac})`, ds < 1.5, `off by ${ds.toFixed(2)} m`);
  }

  // the sign of the offset says which side, consistently: + is to the right of
  // travel, which is what the off-course test and the AI's steering both assume
  {
    const p = course.sample(200);
    const right = { x: p.x + Math.sin(p.ang) * 10, z: p.z - Math.cos(p.ang) * 10 };
    const left = { x: p.x - Math.sin(p.ang) * 10, z: p.z + Math.cos(p.ang) * 10 };
    ok('offset to the right of travel is positive', course.nearest(right.x, right.z, -1).lateral > 5);
    ok('offset to the left of travel is negative', course.nearest(left.x, left.z, -1).lateral < -5);
  }

  // the hinted window finds the same answer as a full search — this is the
  // optimisation eight skis a frame depend on, and a too-small window silently
  // returns a point from the wrong part of the lake
  {
    let worst = 0;
    for (let i = 0; i < course.samples; i += 7) {
      const p = course.sample(i * course.step);
      const off = ((i * 13) % 41) - 20;
      const x = p.x + Math.sin(p.ang) * off, z = p.z - Math.cos(p.ang) * off;
      const full = course.nearest(x, z, -1);
      const hinted = course.nearest(x, z, i);
      worst = Math.max(worst, Math.abs(full.lateral - hinted.lateral));
    }
    ok('a hinted lookup agrees with a full search', worst < 0.05, `worst disagreement ${worst.toFixed(4)} m`);
  }
}

// ---------------------------------------------------------------------------
// The racing line
// ---------------------------------------------------------------------------
{
  const line = racingLine(course);
  let out = 0, maxAbs = 0, jump = 0;
  for (let i = 0; i < course.samples; i++) {
    if (Math.abs(line[i]) > TRACK_HALF) out++;
    maxAbs = Math.max(maxAbs, Math.abs(line[i]));
    jump = Math.max(jump, Math.abs(line[i] - line[(i + 1) % course.samples]));
  }
  eq('the racing line never leaves the channel', out, 0);
  ok('it does use the width available', maxAbs > TRACK_HALF * 0.25, `max ${maxAbs.toFixed(1)} m`);
  ok('and it is smooth — no rival saws at the bars', jump < 0.5, `biggest step ${jump.toFixed(3)} m`);

  // it should sit on the inside of a corner: opposite sign to the curvature
  let agree = 0, total = 0;
  for (let i = 0; i < course.samples; i++) {
    if (Math.abs(course.curv[i]) < 0.004) continue;
    total++;
    if (Math.sign(line[i]) === -Math.sign(course.curv[i])) agree++;
  }
  ok('it hugs the inside of the corners', agree / total > 0.85,
    `${agree}/${total} samples on the inside`);
}

// ---------------------------------------------------------------------------
// Laps
// ---------------------------------------------------------------------------
{
  const L = course.length;
  const r = { lap: 0 };
  stepProgress(r, 10, L);
  eq('a fresh racer is on lap 0', r.lap, 0);

  for (const s of [L * 0.3, L * 0.7, L - 20]) stepProgress(r, s, L);
  eq('moving up the course does not tick the lap over', r.lap, 0);

  stepProgress(r, 5, L);
  eq('crossing the line completes a lap', r.lap, 1);
  near('and progress is continuous across the line', r.progress, L + 5, 1e-9);

  // the case a bare `s < lastS` gets wrong: spinning and crossing back over
  stepProgress(r, L - 5, L);
  eq('crossing back over the line takes the lap away again', r.lap, 0);
  near('progress goes down, not up', r.progress, L - 5, 1e-9);

  stepProgress(r, 5, L);
  eq('and re-crossing gives it back', r.lap, 1);

  // moving nearly half a lap in one step is movement, not a wrap
  const q = { lap: 2, s: 100 };
  stepProgress(q, 100 + L * 0.45, L);
  eq('a big legitimate jump forward is not a lap', q.lap, 2);

  ok(`${LAPS} laps ends the race`, isFinished({ lap: LAPS }) && !isFinished({ lap: LAPS - 1 }));
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------
{
  const mk = (name, progress, finishedAt) => ({ name, progress, finishedAt });
  const order = raceOrder([mk('c', 100), mk('a', 900), mk('b', 400)]);
  eq('the leader is the one furthest round', order[0].name, 'a');
  eq('...and the tail is the one least far', order[2].name, 'c');

  // Someone across the line stays ahead of a racer who is still going, even
  // though the finisher stops accumulating distance the moment they stop.
  const done = mk('done', 3000, 12000);
  const running = mk('running', 3400, null);
  eq('a finisher holds their place against a racer still on the course',
    raceOrder([running, done])[0].name, 'done');

  const first = mk('first', 3000, 9000), second = mk('second', 3000, 9500);
  eq('two finishers are ordered by the clock', raceOrder([second, first])[0].name, 'first');

  // sorting must not disturb the caller's array — the HUD renders one and the
  // simulation iterates the other
  const src = [mk('x', 1), mk('y', 2)];
  raceOrder(src);
  eq('raceOrder leaves its input alone', src[0].name, 'x');
}

// ---------------------------------------------------------------------------
// Speed: the tidy line is the fast line
// ---------------------------------------------------------------------------
{
  const settle = (opts) => {
    let v = 0;
    for (let i = 0; i < 3000; i++) v = speedStep(v, opts, 1 / 60);
    return v;
  };
  const straight = settle({});
  const hard = settle({ steer: 1 });
  const lazy = settle({ steer: 0.3 });
  const off = settle({ offTrack: true });
  const boosted = settle({ boosting: true });

  near('a clean line settles at the top speed', straight, V_MAX, 0.01);
  ok('a held full-lock turn is much slower', hard < straight - 8,
    `${hard.toFixed(1)} vs ${straight.toFixed(1)}`);
  ok('a lazy turn costs far less than a third of a hard one',
    straight - lazy < (straight - hard) / 3, `${(straight - lazy).toFixed(2)} vs ${(straight - hard).toFixed(2)}`);
  ok('sharper is always slower', hard < lazy && lazy < straight);
  near('the shallows cap you hard', off, V_OFF, 0.01);
  ok('being off the course is worse than any turn you can make', off < hard,
    `off ${off.toFixed(1)} vs hairpin ${hard.toFixed(1)}`);
  near('boost raises the ceiling', boosted, V_BOOST, 0.01);
  ok('boost is worth about a third more speed', boosted / straight > 1.25 && boosted / straight < 1.5,
    `${(boosted / straight).toFixed(2)}×`);

  ok('a wake tows you a little even without spending boost',
    speedCap({ drafting: 1 }) > speedCap({ drafting: 0 }));

  // pace scales a rival everywhere, not just on the straights
  const slow = 0.95;
  ok('a slower rival is slower flat out', speedCap({ pace: slow }) < speedCap({}));
  ok('...and slower through a corner too',
    speedCap({ steer: 1, pace: slow }) < speedCap({ steer: 1 }));
  ok('...and slower in the shallows',
    speedCap({ offTrack: true, pace: slow }) < speedCap({ offTrack: true }));
  eq('pace defaults to no change at all', speedCap({ pace: 1 }), speedCap({}));
  near('the pace factor is exactly that', speedCap({ pace: 0.5 }), speedCap({}) / 2, 1e-12);
  eq('no speed lost going straight', turnLoss(0), 0);

  // decelerating into the shallows must be immediate enough to be a punishment
  let v = V_MAX;
  for (let i = 0; i < 60; i++) v = speedStep(v, { offTrack: true }, 1 / 60);
  ok('one second in the shallows takes most of the speed away', v < V_MAX * 0.6,
    `${v.toFixed(1)} m/s after 1 s`);
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------
{
  eq('no input, no turn', yawRate(20, 0), 0);
  ok('the ski turns both ways symmetrically', Math.abs(yawRate(20, 1) + yawRate(20, -1)) < 1e-12);
  ok('grip falls away with speed — flat out means wide arcs',
    Math.abs(yawRate(V_MAX, 1)) < Math.abs(yawRate(V_MAX * 0.3, 1)));
  ok('...but never to nothing, even past the top speed', Math.abs(yawRate(V_BOOST, 1)) > 0.2,
    `${yawRate(V_BOOST, 1).toFixed(3)} rad/s`);
  ok('steering input is clamped', Math.abs(yawRate(10, 40)) === Math.abs(yawRate(10, 1)));
}

// ---------------------------------------------------------------------------
// Boost
// ---------------------------------------------------------------------------
{
  eq('you start with nothing to spend', boostStep(0, {}, 1), 0);

  // earning it
  const drafted = boostStep(0, { drafting: 1 }, 1);
  ok('a second in a wake is worth about a third of a bar', drafted > 20 && drafted < 40, String(drafted));
  ok('a partial wake pays less', boostStep(0, { drafting: 0.4 }, 1) < drafted);
  ok('air off a swell pays too', boostStep(0, { airborne: true }, 1) > 0);
  // The design invariant, not just a number: a tow has to out-earn a jump, or
  // the wake stops being worth chasing and the game is a different one.
  ok('...but a wake out-earns it by more than two to one',
    drafted > boostStep(0, { airborne: true }, 1) * 2,
    `wake ${drafted} vs air ${boostStep(0, { airborne: true }, 1)}`);
  eq('the bar never overfills', boostStep(BOOST_MAX, { drafting: 1 }, 5), BOOST_MAX);

  // spending it
  const spent = boostStep(BOOST_MAX, { holding: true }, 1);
  ok('holding boost drains it', spent < BOOST_MAX);
  const secs = BOOST_MAX / (BOOST_MAX - spent);
  ok('a full bar is 2–4 seconds — it decides a corner, not a lap', secs > 2 && secs < 4,
    `${secs.toFixed(1)} s`);
  eq('an empty bar cannot go negative', boostStep(0, { holding: true }, 5), 0);
  ok('you cannot earn while spending', boostStep(50, { holding: true, drafting: 1 }, 1) < 50);

  // arming
  ok('a stab at an almost-empty bar does nothing', !boostActive(BOOST_ARM - 1, true, false));
  ok('an armed bar fires', boostActive(BOOST_ARM + 1, true, false));
  ok('...and a burst already running keeps running down to empty',
    boostActive(2, true, true), 'a burst that cuts out mid-corner reads as a bug');
  ok('an empty bar stops the burst', !boostActive(0, true, true));
  ok('not holding is not boosting', !boostActive(BOOST_MAX, false, true));
}

// ---------------------------------------------------------------------------
// The wake
// ---------------------------------------------------------------------------
{
  eq('you cannot draft off someone behind you', draftFactor(-5, 0), 0);
  eq('nor off someone you are about to hit', draftFactor(0.5, 0), 0);
  eq('nor from beyond the end of the wake', draftFactor(DRAFT_LEN + 1, 0), 0);
  ok('right behind and in line is the sweet spot', draftFactor(12, 0) > 0.8, String(draftFactor(12, 0)));
  ok('drifting sideways out of it fades rather than snapping off',
    draftFactor(12, 3) > 0 && draftFactor(12, 3) < draftFactor(12, 0));
  eq('and outside it entirely is nothing', draftFactor(12, DRAFT_HALF * 2), 0);
  ok('the wake spreads with distance: a gap that misses up close, catches further back',
    draftFactor(28, 5) > draftFactor(4, 5), `${draftFactor(28, 5).toFixed(2)} vs ${draftFactor(4, 5).toFixed(2)}`);
  ok('the factor never exceeds 1', draftFactor(12, 0) <= 1);
}

// ---------------------------------------------------------------------------
// The water
// ---------------------------------------------------------------------------
{
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < 4000; i++) {
    const h = waveHeight((i * 37) % 700 - 350, (i * 91) % 700 - 350, i * 0.017);
    hi = Math.max(hi, h); lo = Math.min(lo, h);
  }
  ok('the surface stays inside the sum of its amplitudes',
    hi <= SWELL_MAX && lo >= -SWELL_MAX, `${lo.toFixed(2)}…${hi.toFixed(2)} vs ±${SWELL_MAX}`);
  ok('the swell is big enough to be worth jumping', hi > 0.8, `crest ${hi.toFixed(2)} m`);
  ok('...and small enough not to hide a rival', SWELL_MAX < 2.2, `${SWELL_MAX} m`);
  ok('it actually moves', waveHeight(0, 0, 0) !== waveHeight(0, 0, 1.7));

  // the analytic slope has to match the surface, or the ski rides a different
  // lake from the one that is drawn
  const t = 3.3, e = 1e-4;
  for (const [x, z] of [[0, 0], [61, -18], [-140, 92]]) {
    const s = waveSlope(x, z, t);
    const nx = (waveHeight(x + e, z, t) - waveHeight(x - e, z, t)) / (2 * e);
    const nz = (waveHeight(x, z + e, t) - waveHeight(x, z - e, t)) / (2 * e);
    ok(`the analytic slope matches the surface at ${x},${z}`,
      Math.abs(s.dx - nx) < 1e-4 && Math.abs(s.dz - nz) < 1e-4,
      `${s.dx.toFixed(6)}/${nx.toFixed(6)}, ${s.dz.toFixed(6)}/${nz.toFixed(6)}`);
  }

  // The mesh and the ski read the water through different functions for speed.
  // If they ever disagree, skis float above their own wave or sink through it —
  // and the only symptom is that the game looks subtly wrong.
  {
    const n = 64, x0 = -137.5, dx = 6.25, z = 42.5, t = 5.75;
    const y = new Float64Array(n), sx = new Float64Array(n), sz = new Float64Array(n);
    waveRow(x0, dx, n, z, t, y, sx, sz);
    let dy = 0, ds = 0;
    for (let i = 0; i < n; i++) {
      const x = x0 + dx * i;
      const s = waveSlope(x, z, t);
      dy = Math.max(dy, Math.abs(y[i] - waveHeight(x, z, t)));
      ds = Math.max(ds, Math.abs(sx[i] - s.dx), Math.abs(sz[i] - s.dz));
    }
    ok('the mesh rides exactly the water the ski does', dy < 1e-9, `off by ${dy.toExponential(2)} m`);
    ok('...slopes included, so the lighting matches the surface', ds < 1e-9, `off by ${ds.toExponential(2)}`);

    // the rotation trick must not drift across a long row, either
    const long = 512;
    const ly = new Float64Array(long), lsx = new Float64Array(long), lsz = new Float64Array(long);
    waveRow(-1600, 6.25, long, z, t, ly, lsx, lsz);
    const end = waveHeight(-1600 + 6.25 * (long - 1), z, t);
    ok('and it does not drift over a long row', Math.abs(ly[long - 1] - end) < 1e-9,
      `off by ${Math.abs(ly[long - 1] - end).toExponential(2)} m`);

    // an offset write must land where it was asked to, and leave the rest alone
    const buf = new Float64Array(10).fill(-1);
    const b2 = new Float64Array(10), b3 = new Float64Array(10);
    waveRow(0, 5, 4, 0, 0, buf, b2, b3, 3);
    ok('writing at an offset leaves the rest of the buffer alone',
      buf[2] === -1 && buf[7] === -1 && buf[3] !== -1, `${Array.from(buf).join(',')}`);
  }

  eq('crawling over a swell does not launch you', launchSpeed(LAUNCH_V - 1, 0.3), 0);
  eq('nor does a flat patch at full speed', launchSpeed(V_MAX, 0), 0);
  eq('nor the back of a swell', launchSpeed(V_MAX, -0.3), 0);
  ok('a fast hit on a rising swell throws the ski', launchSpeed(V_MAX, 0.25) > 1);
  ok('faster means higher', launchSpeed(V_MAX, 0.25) > launchSpeed(24, 0.25));
  ok('steeper means higher', launchSpeed(V_MAX, 0.3) > launchSpeed(V_MAX, 0.15));
}

// ---------------------------------------------------------------------------
// Rivals
// ---------------------------------------------------------------------------
{
  eq('seven rivals make a grid of eight', RIVALS.length + 1, GRID);
  ok('every rival has a distinct name', new Set(RIVALS.map((r) => r.name)).size === RIVALS.length);

  // The livery is the only thing tying a name in the standings to a hull on
  // the water, so two rivals in the same colour is a real bug — and one of
  // them wearing the player's magenta is worse.
  // hue is a wheel: 0.01 and 0.99 are neighbours, not opposites
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
  const hues = [...RIVALS.map((r) => r.hue), PLAYER_HUE];
  let tightest = 1, pair = '';
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      const g = hueGap(hues[i], hues[j]);
      if (g < tightest) { tightest = g; pair = `${hues[i]}/${hues[j]}`; }
    }
  }
  ok('no two liveries are within 5% of the colour wheel',
    tightest > 0.05, `closest ${tightest.toFixed(3)} at ${pair}`);
  ok('and no rival is anywhere near the player\'s magenta',
    RIVALS.every((r) => hueGap(r.hue, PLAYER_HUE) > 0.1),
    RIVALS.map((r) => `${r.name} ${hueGap(r.hue, PLAYER_HUE).toFixed(2)}`).join(', '));
  ok('they are ordered fastest first', RIVALS.every((r, i) => i === 0 || r.pace <= RIVALS[i - 1].pace));
  ok('the field is close: the slowest is within 10% of the fastest',
    RIVALS[RIVALS.length - 1].pace / RIVALS[0].pace > 0.9);

  eq('a rival level with you races at its own pace', aiPace(1, 0), 1);
  ok('one that is behind pushes a little harder', aiPace(1, 120) > 1 && aiPace(1, -120) < 1,
    `behind ${aiPace(1, 120).toFixed(3)}, ahead ${aiPace(1, -120).toFixed(3)}`);
  ok('catch-up is feeble by design — under 7%',
    Math.abs(aiPace(1, 9999) - 1) <= CATCHUP + 1e-9, `${((aiPace(1, 9999) - 1) * 100).toFixed(1)}%`);
  ok('and it is symmetric: a leader eases off as much as a straggler pushes',
    Math.abs((aiPace(1, 300) - 1) + (aiPace(1, -300) - 1)) < 1e-9);

  // the whole point of the cap: two laps of a lead cannot be erased
  const leadPace = aiPace(1, -400), chasePace = aiPace(1, 400);
  ok('a rival cannot out-pace you by more than 15% however far ahead you get',
    chasePace / leadPace < 1.15, `${(chasePace / leadPace).toFixed(3)}×`);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------
{
  eq('an unset best lap reads as dashes', formatTime(null), '--:--.--');
  eq('a fresh clock', formatTime(0), '00:00.00');
  eq('seconds and hundredths', formatTime(45320), '00:45.32');
  eq('past a minute', formatTime(83450), '01:23.45');
  eq('hundredths truncate rather than round up past the second',
    formatTime(1999), '00:01.99');
  eq('a gap behind', formatGap(820), '+0.82');
  eq('a gap ahead', formatGap(-1500), '-1.50');
  eq('places are ordinal', ordinal(0) + ordinal(1) + ordinal(2) + ordinal(7), '1st2nd3rd8th');
}

// ---------------------------------------------------------------------------
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\n${failures.length} of ${checks} checks failed.`);
  process.exit(1);
}
console.log(`ok — ${checks} checks on wake's rules.`);
