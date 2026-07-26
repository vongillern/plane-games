// span-physics.mjs — assertions against games/span/physics.js.
//
//   node tools/span-physics.mjs
//
// Zero dependencies, same idiom as check.mjs and gen-icons.mjs beside it: this
// is not a build step, nothing on the site depends on it, and it emits nothing.
//
// Span is the one game whose rules live in a module rather than in a render
// loop. physics.js is pure — no DOM, no Math.random, no clock — so a bridge
// plus a level is a *function* whose answer can be checked in Node in a few
// hundred milliseconds. Nothing else in this repo can be tested this cheaply,
// and the failure it guards against is the expensive kind: a tuning change to
// a material constant that quietly makes a shipped level unsolvable.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SPAN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'games', 'span');
const physics = await import(path.join(SPAN, 'physics.js'));
const { LEVELS } = await import(path.join(SPAN, 'levels.js'));

const {
  DT, GRAVITY, GRID_STEP, ITERATIONS,
  MATS, MAT_KEYS, VEHICLES,
  bridgeCost, createSim, memberCost, runSim,
} = physics;

// ---------------------------------------------------------------------------
// A tiny harness. Each check names what it wanted and prints what it got —
// "L2 bare deck should fail" is only useful if it also says what happened.
// ---------------------------------------------------------------------------
const failures = [];
let checks = 0;

function ok(what, cond, detail = '') {
  checks++;
  if (!cond) failures.push(detail ? `${what}\n        got: ${detail}` : what);
}

function eq(what, actual, expected) {
  ok(what, Object.is(actual, expected), `${fmt(actual)} !== ${fmt(expected)}`);
}

const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------------------
// Bridge builders. These are the two shapes the early levels are *about*, so
// they double as a check that the levels remain solvable the way they teach.
// ---------------------------------------------------------------------------

// A deck of `mat` laid straight from the left anchor to the right one, cut
// into `n` equal members with free nodes between them.
function deck(level, n, mat = 'road') {
  const nodes = [];
  const members = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    nodes.push({
      x: level.gap * t,
      y: level.leftTop + (level.rightTop - level.leftTop) * t,
      fixed: i === 0 || i === n,
    });
  }
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, mat });
  return { nodes, members };
}

// The same deck with an underslung truss: a lower chord `depth` below each
// interior deck node, triangulated back up. This is the shape "The Sag" and
// "Truss Me" exist to teach.
function trussed(level, n, depth, brace = 'wood') {
  const b = deck(level, n);
  const lower = [];
  for (let i = 1; i < n; i++) {
    const top = b.nodes[i];
    b.nodes.push({ x: top.x, y: top.y + depth, fixed: false });
    lower.push(b.nodes.length - 1);
  }
  for (let i = 0; i < lower.length - 1; i++) {
    b.members.push({ a: lower[i], b: lower[i + 1], mat: brace });
  }
  for (let i = 0; i < lower.length; i++) {
    // each lower node ties to the deck node above it and to its two neighbours
    b.members.push({ a: i, b: lower[i], mat: brace });
    b.members.push({ a: i + 1, b: lower[i], mat: brace });
    b.members.push({ a: i + 2, b: lower[i], mat: brace });
  }
  return b;
}

const play = (level, bridge) => runSim(createSim(level, bridge));

// ---------------------------------------------------------------------------
// 1. The constants are sane.
//
// Cheap, but DT and ITERATIONS are exactly the knobs someone reaches for when
// the sim feels wrong, and a sign flip or a zero here is silent: the bridge
// simply never moves and every level "passes".
// ---------------------------------------------------------------------------
ok('DT is a positive sub-frame step', DT > 0 && DT <= 1 / 30, String(DT));
ok('GRAVITY pulls downward (y grows down, so positive)', GRAVITY > 0, String(GRAVITY));
ok('ITERATIONS is a positive integer', Number.isInteger(ITERATIONS) && ITERATIONS > 0, String(ITERATIONS));
ok('GRID_STEP is a positive fraction of a world unit', GRID_STEP > 0 && GRID_STEP <= 1, String(GRID_STEP));

// ---------------------------------------------------------------------------
// 2. The material table and MAT_KEYS agree.
//
// The palette in game.js iterates MAT_KEYS and indexes MATS; a key in one and
// not the other is a build tool with a dead button, or a crash on click.
// ---------------------------------------------------------------------------
eq('MAT_KEYS covers every entry in MATS', MAT_KEYS.slice().sort().join(), Object.keys(MATS).sort().join());
for (const k of MAT_KEYS) {
  const m = MATS[k];
  ok(`MATS.${k}.key matches its own table key`, m.key === k, `${m.key} !== ${k}`);
  ok(`MATS.${k}.cost is positive`, m.cost > 0, String(m.cost));
  ok(`MATS.${k}.strength is positive`, m.strength > 0, String(m.strength));
  ok(`MATS.${k}.maxLen is positive`, m.maxLen > 0, String(m.maxLen));
}
ok('exactly one material is drivable (the deck)',
  MAT_KEYS.filter((k) => MATS[k].drivable).length === 1,
  MAT_KEYS.filter((k) => MATS[k].drivable).join(','));
ok('cable is the tension-only material', MATS.cable.tensionOnly === true, String(MATS.cable.tensionOnly));

// ---------------------------------------------------------------------------
// 3. memberCost respects material and length.
// ---------------------------------------------------------------------------
for (const k of MAT_KEYS) {
  ok(`memberCost is positive for ${k}`, memberCost(1, k) > 0, String(memberCost(1, k)));
  ok(`memberCost grows with length for ${k}`,
    memberCost(3, k) > memberCost(2, k) && memberCost(2, k) > memberCost(1, k),
    `1m=${memberCost(1, k)} 2m=${memberCost(2, k)} 3m=${memberCost(3, k)}`);
}
// the price ladder the levels are budgeted around: cable is the cheap way to
// hold, steel the expensive way, and road sits between wood and steel
ok('per-metre price ladder is cable < wood < road < steel',
  memberCost(10, 'cable') < memberCost(10, 'wood') &&
  memberCost(10, 'wood') < memberCost(10, 'road') &&
  memberCost(10, 'road') < memberCost(10, 'steel'),
  MAT_KEYS.map((k) => `${k}=${memberCost(10, k)}`).join(' '));

// ---------------------------------------------------------------------------
// 4. bridgeCost is the sum of its members, and monotonic in both directions.
//
// The budget chip is the whole economy of the game: if cost is not monotonic
// you can make a bridge stronger *and* cheaper, and every level's budget stops
// meaning anything.
// ---------------------------------------------------------------------------
{
  const L = LEVELS[1];
  eq('an empty bridge costs nothing', bridgeCost({ nodes: [], members: [] }), 0);

  const three = deck(L, 3);
  const six = deck(L, 6);
  const byHand = three.members.reduce((sum, m) => {
    const a = three.nodes[m.a], b = three.nodes[m.b];
    return sum + memberCost(Math.hypot(b.x - a.x, b.y - a.y), m.mat);
  }, 0);
  eq('bridgeCost is the sum of its members\' memberCost', bridgeCost(three), byHand);

  // more members over the same span: same road length, but rounding is per
  // member, so the only guarantee is that it does not get cheaper
  ok('splitting a deck into more members never makes it cheaper',
    bridgeCost(six) >= bridgeCost(three),
    `3 members=${bridgeCost(three)} vs 6 members=${bridgeCost(six)}`);

  // adding structure on top of a deck must cost more than the bare deck
  const braced = trussed(L, 3, 1);
  ok('adding members to a bridge increases its cost',
    bridgeCost(braced) > bridgeCost(three),
    `bare=${bridgeCost(three)} braced=${bridgeCost(braced)}`);

  // a wider gap means longer members means more money
  const wide = deck(LEVELS[5], 3);   // gap 12
  ok('spanning a wider gap costs more than a narrow one',
    bridgeCost(wide) > bridgeCost(three),
    `gap ${L.gap}=${bridgeCost(three)} vs gap ${LEVELS[5].gap}=${bridgeCost(wide)}`);

  // swapping every member for a dearer material costs strictly more
  const steel = deck(L, 3, 'steel');
  ok('the same shape in steel costs more than in road',
    bridgeCost(steel) > bridgeCost(three),
    `road=${bridgeCost(three)} steel=${bridgeCost(steel)}`);
}

// ---------------------------------------------------------------------------
// 5. A known-good bridge holds; an under-built one does not.
//
// These two are the point of the file. Both are the *level's own* lesson:
// level 1 says "drag from one anchor to the other to lay road", and level 2
// says "a flat deck sags — brace it with wood from below". If a materials
// tweak ever makes the first fail or the second pass, the level is teaching a
// lie, and nothing else in the repo would notice.
// ---------------------------------------------------------------------------
{
  const L = LEVELS[0];   // First Span — gap 2, budget 40
  const bridge = {
    nodes: [{ x: 0, y: L.leftTop, fixed: true }, { x: L.gap, y: L.rightTop, fixed: true }],
    members: [{ a: 0, b: 1, mat: 'road' }],
  };
  const cost = bridgeCost(bridge);
  const r = play(L, bridge);
  ok(`"${L.name}": one road member from anchor to anchor carries the car`,
    r.passed, JSON.stringify(r));
  eq(`"${L.name}": nothing breaks doing it`, r.brokenMembers, 0);
  ok(`"${L.name}": the taught solution fits the budget`,
    cost <= L.budget, `${cost} > ${L.budget}`);
}

{
  const L = LEVELS[1];   // The Sag — gap 6, budget 300
  const bare = deck(L, 6);
  const r = play(L, bare);
  ok(`"${L.name}": an unbraced flat deck does NOT hold`,
    !r.passed, JSON.stringify(r));
  eq(`"${L.name}": and it fails by dropping the car, not by running out of time`,
    r.failReason, 'fell');
  ok(`"${L.name}": members actually snap under the load`,
    r.brokenMembers > 0, String(r.brokenMembers));

  // the same deck, braced from below exactly as the level's intro says
  const braced = trussed(L, 3, 1, 'wood');
  const cost = bridgeCost(braced);
  const rb = play(L, braced);
  ok(`"${L.name}": bracing that same deck with wood from below holds`,
    rb.passed, JSON.stringify(rb));
  eq(`"${L.name}": and nothing breaks`, rb.brokenMembers, 0);
  ok(`"${L.name}": with room to spare in the budget`,
    cost <= L.budget, `${cost} > ${L.budget}`);
  ok(`"${L.name}": bracing leaves headroom before the breaking point`,
    rb.peakStress < 1, `peak stress ${rb.peakStress}`);
}

// ---------------------------------------------------------------------------
// 6. The sim is a deterministic function of its inputs.
//
// Everything above is worthless if it is only true on average. Verlet
// integration plus the smoothed stress signal means a stray Math.random or a
// Date.now would show up as flake here long before it showed up in play.
// ---------------------------------------------------------------------------
{
  const L = LEVELS[2];
  const shape = () => trussed(L, 3, 1, 'wood');
  const a = play(L, shape());
  const b = play(L, shape());
  eq('runSim is deterministic (identical summaries from identical inputs)',
    JSON.stringify(a), JSON.stringify(b));

  // a *failing* run too: the break order feeds sim.breakEvents, and that is
  // the part most likely to go order-dependent
  const f1 = play(L, deck(L, 7));
  const f2 = play(L, deck(L, 7));
  eq('a failing run is deterministic too', JSON.stringify(f1), JSON.stringify(f2));
  ok('...and it is genuinely a failing run', !f1.passed, JSON.stringify(f1));

  // determinism to the last point, not just the summary
  const s1 = createSim(L, shape());
  const s2 = createSim(L, shape());
  for (let i = 0; i < 200; i++) { s1.step(); s2.step(); }
  const snap = (s) => s.pts.map((p) => `${p.x.toFixed(12)},${p.y.toFixed(12)}`).join(';');
  eq('every point sits at the identical coordinate after 200 steps', snap(s1), snap(s2));
}

// ---------------------------------------------------------------------------
// 7. createSim does not mutate the bridge it is handed.
//
// game.js hands it the live bridge the player built and keeps drawing that
// same object afterwards. If the sim wrote back into it, a failed test run
// would leave the workshop showing a collapsed bridge.
// ---------------------------------------------------------------------------
{
  const L = LEVELS[1];
  const bridge = trussed(L, 3, 1, 'wood');
  const before = JSON.stringify(bridge);
  const costBefore = bridgeCost(bridge);
  play(L, bridge);
  eq('createSim/runSim leave the input bridge untouched', JSON.stringify(bridge), before);
  eq('...so its cost is unchanged after a run', bridgeCost(bridge), costBefore);
}

// ---------------------------------------------------------------------------
// 8. Every shipped level is simulable and always terminates.
//
// runSim is capped, but `status` staying 'running' at the cap means the level
// has no time limit that bites — the player would sit watching a bridge that
// never resolves either way.
// ---------------------------------------------------------------------------
for (const [i, L] of LEVELS.entries()) {
  const r = play(L, deck(L, Math.max(1, Math.round(L.gap / 2))));
  ok(`level ${i + 1} ("${L.name}") resolves rather than running forever`,
    r.status === 'passed' || r.status === 'failed', r.status);
  ok(`level ${i + 1} ("${L.name}") names a vehicle physics knows`,
    !!VEHICLES[L.vehicle], String(L.vehicle));
  ok(`level ${i + 1} ("${L.name}") has a positive budget`, L.budget > 0, String(L.budget));
}

// ---------------------------------------------------------------------------

for (const f of failures) console.log(`FAIL  ${f}`);

if (failures.length) {
  console.log(`\n${failures.length} of ${checks} assertion(s) failed across ${LEVELS.length} levels.`);
  process.exit(1);
}
console.log(`ok — ${checks} assertions, ${LEVELS.length} levels, span physics holds.`);
