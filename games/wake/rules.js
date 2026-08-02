// Wake — the rules a test can check without a browser.
//
// Everything in this file is pure: no DOM, no Three.js, no clock, no
// Math.random. The lagoon, the renderer and the input live in game.js; what
// *decides the race* lives here — where the course goes, how far around it a
// ski is, when a lap has been completed, who is in front, what a turn costs in
// speed, how boost is earned and spent, and where the water surface is.
// tools/wake-rules.mjs checks all of it in Node in a few milliseconds.
//
// Two of these deserve a note on why they are here rather than in game.js:
//
//   * `waveHeight` is the *only* definition of the water surface. The mesh the
//     player sees and the height the ski rides both read it, so a ski can never
//     float above its own wave or sink through it. Fixing one used to mean
//     remembering to fix the other.
//   * the course is a closed radial curve, so it cannot cross itself no matter
//     how the lobes are tuned. A hand-placed spline can, and a course that
//     crosses itself makes "how far around are you?" unanswerable — the lap
//     counter and every rival's position are built on that one number.

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export function normAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

// ---------------------------------------------------------------------------
// The course
//
// r(θ): a radius that wobbles with θ. Because r is always positive the curve is
// star-shaped about the origin, which is a cheap guarantee that it never
// crosses itself — see the note at the top. The three harmonics give the
// circuit its character: one long sweeper, a pair of hairpins, and a kink.
// ---------------------------------------------------------------------------
export const R0 = 205;                 // mean radius (m)
export const LOBES = [
  { n: 3, amp: 0.215, phase: 0.55 },
  { n: 2, amp: 0.105, phase: 2.30 },
  { n: 5, amp: 0.062, phase: 1.05 },
];

export function courseRadius(theta) {
  let r = 1;
  for (const l of LOBES) r += l.amp * Math.sin(l.n * theta + l.phase);
  return R0 * r;
}

export function coursePoint(theta) {
  const r = courseRadius(theta);
  return { x: r * Math.cos(theta), z: r * Math.sin(theta) };
}

// Half-width of the rideable channel. Eight skis start four rows deep inside
// it, and it has to stay wide enough at the hairpins that being shoved wide is
// a setback rather than an instant trip into the shallows.
export const TRACK_HALF = 27;
export const LAPS = 3;
export const GRID = 8;

// Resample the curve at a fixed arc-length so "how far around" is a distance in
// metres rather than an angle — an angle advances at wildly different speeds
// through a hairpin and a straight, and every rival's position compares against
// it. `nearest` then only has to search a window of a uniform polyline.
export function buildCourse(samples = 1024) {
  const th = new Float64Array(samples + 1);
  const xs = new Float64Array(samples + 1);
  const zs = new Float64Array(samples + 1);
  const cum = new Float64Array(samples + 1);

  // pass 1: dense θ sampling, to measure arc length against θ
  const FINE = samples * 8;
  const fx = new Float64Array(FINE + 1);
  const fz = new Float64Array(FINE + 1);
  const fl = new Float64Array(FINE + 1);
  for (let i = 0; i <= FINE; i++) {
    const p = coursePoint((i / FINE) * TAU);
    fx[i] = p.x; fz[i] = p.z;
    if (i > 0) fl[i] = fl[i - 1] + Math.hypot(fx[i] - fx[i - 1], fz[i] - fz[i - 1]);
  }
  const length = fl[FINE];

  // pass 2: walk that table to place `samples` points at equal arc length
  let j = 0;
  for (let i = 0; i <= samples; i++) {
    const want = (i / samples) * length;
    while (j < FINE && fl[j + 1] < want) j++;
    const span = fl[j + 1] - fl[j] || 1;
    const t = clamp((want - fl[j]) / span, 0, 1);
    xs[i] = lerp(fx[j], fx[j + 1], t);
    zs[i] = lerp(fz[j], fz[j + 1], t);
    th[i] = ((j + t) / FINE) * TAU;
    cum[i] = want;
  }
  // close the loop exactly: the last sample *is* the first one
  xs[samples] = xs[0]; zs[samples] = zs[0];

  const step = length / samples;

  // tangent angle (atan2 of dz,dx) and signed curvature at each sample
  const ang = new Float64Array(samples);
  const curv = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const a = (i + samples - 1) % samples, b = (i + 1) % samples;
    ang[i] = Math.atan2(zs[b] - zs[a], xs[b] - xs[a]);
  }
  for (let i = 0; i < samples; i++) {
    const b = (i + 1) % samples;
    curv[i] = normAngle(ang[b] - ang[i]) / step;      // rad per metre
  }

  const course = {
    samples, length, step, xs, zs, ang, curv, theta: th,

    // index of the sample at arc distance s (wrapping)
    index(s) {
      const i = Math.floor((((s % length) + length) % length) / step);
      return i % samples;
    },

    // point + heading at arc distance s, interpolated between samples
    sample(s) {
      const u = (((s % length) + length) % length) / step;
      const i = Math.floor(u) % samples;
      const t = u - Math.floor(u);
      const b = (i + 1) % samples;
      return {
        x: lerp(xs[i], xs[b], t),
        z: lerp(zs[i], zs[b], t),
        ang: ang[i] + normAngle(ang[b] - ang[i]) * t,
        curv: curv[i],
        i,
      };
    },

    // Where a point sits relative to the course: arc distance along it, and
    // signed distance from the centreline (+ is to the rider's right).
    // `hint` is the last known sample index — a race asks this for eight skis
    // every frame, and every one of them is within a few metres of where it was.
    nearest(x, z, hint = -1, window = 0) {
      let lo = 0, hi = samples;
      if (hint >= 0) {
        const w = window || Math.max(8, Math.ceil(60 / step));
        lo = hint - w; hi = hint + w;
      }
      let best = Infinity, bi = 0, bt = 0;
      for (let k = lo; k < hi; k++) {
        const i = ((k % samples) + samples) % samples;
        const b = (i + 1) % samples;
        const ex = xs[b] - xs[i], ez = zs[b] - zs[i];
        const wx = x - xs[i], wz = z - zs[i];
        const e2 = ex * ex + ez * ez || 1;
        const t = clamp((wx * ex + wz * ez) / e2, 0, 1);
        const px = wx - ex * t, pz = wz - ez * t;
        const d2 = px * px + pz * pz;
        if (d2 < best) { best = d2; bi = i; bt = t; }
      }
      const b = (bi + 1) % samples;
      const ex = xs[b] - xs[bi], ez = zs[b] - zs[bi];
      const el = Math.hypot(ex, ez) || 1;
      // right-hand normal of the tangent, in the y-up XZ plane
      const nx = ez / el, nz = -ex / el;
      const lateral = (x - (xs[bi] + ex * bt)) * nx + (z - (zs[bi] + ez * bt)) * nz;
      return {
        i: bi,
        s: cum[bi] + el * bt,
        lateral,
        ang: ang[bi] + normAngle(ang[b] - ang[bi]) * bt,
        curv: curv[bi],
      };
    },
  };
  return course;
}

// The line a good rival takes: drift toward the inside of a corner, in
// proportion to how hard it is, then smooth so nobody saws at the bars on a
// kink. Clamped inside the channel — an AI that drives into the shallows on
// purpose reads as broken, not as a mistake.
export function racingLine(course, reach = 0.62, smooth = 26) {
  const n = course.samples;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // curvature of ~1/70 rad/m is about as tight as this course gets
    const k = clamp(course.curv[i] * 70, -1, 1);
    raw[i] = -k * TRACK_HALF * reach;
  }
  // circular box blur, twice — cheap, and enough to make the line continuous
  let a = raw, b = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -smooth; d <= smooth; d++) sum += a[((i + d) % n + n) % n];
      b[i] = sum / (2 * smooth + 1);
    }
    const t = a; a = b; b = t;
  }
  for (let i = 0; i < n; i++) a[i] = clamp(a[i], -TRACK_HALF * 0.8, TRACK_HALF * 0.8);
  return a;
}

// ---------------------------------------------------------------------------
// Progress and laps
//
// A racer's standing is one number: metres travelled since the start line,
// across every lap. Everything — the position list, the AI's sense of who it is
// chasing, the finish — reads it, so it has to survive crossing the line
// backwards after a spin, which is exactly what a bare `s < lastS` test does
// not. A jump of more than half the lap is a wrap; anything smaller is just
// moving.
// ---------------------------------------------------------------------------
export function stepProgress(racer, s, length) {
  const prev = racer.s;
  if (prev !== undefined) {
    if (s - prev < -length / 2) racer.lap++;
    else if (s - prev > length / 2) racer.lap--;
  }
  racer.s = s;
  racer.progress = racer.lap * length + s;
  return racer.progress;
}

// Standings, leader first. Finished racers hold the order they finished in —
// once you are across the line your race is over, and the clock decides it, not
// how far the ski coasted afterwards.
export function raceOrder(racers) {
  return racers.slice().sort((a, b) => {
    if (a.finishedAt != null || b.finishedAt != null) {
      if (a.finishedAt == null) return 1;
      if (b.finishedAt == null) return -1;
      return a.finishedAt - b.finishedAt;
    }
    return b.progress - a.progress;
  });
}

export const isFinished = (racer, laps = LAPS) => racer.lap >= laps;

// ---------------------------------------------------------------------------
// Speed
//
// Throttle is always on — a phone racer that asks you to hold a button to move
// has spent its only input. What you control is the line, and the line is what
// costs: a hard turn scrubs speed superlinearly, so the fast way round is the
// tidy way round. Off the course the shallows cap you hard, which is the whole
// punishment for missing a buoy — no crash, no reset, just a rival going past.
// ---------------------------------------------------------------------------
export const V_MAX = 33;          // m/s on a clean line (~119 km/h)
export const V_BOOST = 45;        // ...with boost held (~162 km/h)
export const V_OFF = 17;          // cap in the shallows
export const ACCEL = 8.5;         // m/s² toward a higher cap
export const DECEL = 20;          // m/s² down to a lower one
export const TURN_LOSS = 12;      // top speed given up at full lock
export const HIT_LOSS = 0.72;     // speed kept after clipping a buoy or a rival

export const turnLoss = (steer01) => TURN_LOSS * Math.pow(clamp(steer01, 0, 1), 1.7);

// `pace` is a rival's own measure of how fast they are, applied to whatever
// their line has earned them. It multiplies the cap rather than the throttle so
// a slower rival is slower everywhere — a rival that only lost time on the
// straights would take the corners like the leader and look like a cheat.
export function speedCap({
  steer = 0, boosting = false, offTrack = false, drafting = 0, pace = 1,
} = {}) {
  if (offTrack) return V_OFF * pace;
  const base = boosting ? V_BOOST : V_MAX;
  // sitting in a wake is worth a couple of km/h even without spending boost —
  // the tow is what teaches the player that the wake is a place to be
  return (base - turnLoss(steer) + 2.2 * clamp(drafting, 0, 1)) * pace;
}

export function speedStep(v, opts, dt) {
  const cap = speedCap(opts);
  const rate = v < cap ? ACCEL : -DECEL;
  const next = v + rate * dt;
  return v < cap ? Math.min(next, cap) : Math.max(next, cap);
}

// How hard the ski turns. Grip falls away with speed, so top speed makes wide
// arcs and a hairpin has to be taken slower — the reason a racing line exists.
export const YAW_BASE = 1.85;     // rad/s at a standstill
export const YAW_FADE = 0.62;     // fraction of that lost by V_MAX
export function yawRate(v, steer) {
  const grip = 1 - YAW_FADE * clamp(v / V_MAX, 0, 1.4);
  return clamp(steer, -1, 1) * YAW_BASE * grip;
}

// ---------------------------------------------------------------------------
// Boost
//
// Boost is never given, only taken: you earn it by riding in someone's wake or
// by getting air off a swell, which puts both of the things that make this game
// look like the picture on the fastest path through it. A full bar is about
// three seconds of V_BOOST, so it decides a corner, not a lap.
// ---------------------------------------------------------------------------
export const BOOST_MAX = 100;
export const BOOST_DRAIN = 34;    // per second, held
export const DRAFT_GAIN = 30;     // per second, sitting in a wake
// Air pays less than half what a wake does, on purpose. Air is something the
// lagoon hands you for driving fast; a tow is something you have to go and
// take off a rival. When these two were level the bar filled nine times in a
// ninety-second stint, four fifths of it from jumps, and the tow — the reason
// the player starts at the back of the grid — was decoration.
export const AIR_GAIN = 13;       // per second of air off a swell
export const BOOST_ARM = 15;      // can't fire below this — no useless stabs

// The wake is a cone that opens out behind a ski: `back` metres behind it,
// `side` metres off its centreline. 1 in the sweet spot, falling to 0 at the
// edges, so drifting out of it fades rather than snapping off.
export const DRAFT_LEN = 30;
export const DRAFT_HALF = 6.5;
export function draftFactor(back, side) {
  if (back <= 1.5 || back > DRAFT_LEN) return 0;
  const spread = DRAFT_HALF * (0.35 + 0.65 * (back / DRAFT_LEN));
  const lat = 1 - Math.abs(side) / spread;
  if (lat <= 0) return 0;
  // A plateau, not a peak. The tow has to be findable at speed with a thumb on
  // a phone: a single best distance means the bar fills in stutters and the
  // player never works out what they did right.
  const along = back < 6 ? (back - 1.5) / 4.5
    : back < 15 ? 1
      : 1 - (back - 15) / (DRAFT_LEN - 15);
  return clamp(lat, 0, 1) * clamp(along, 0, 1);
}

export function boostStep(boost, { holding = false, drafting = 0, airborne = false } = {}, dt) {
  let b = boost;
  if (holding) b -= BOOST_DRAIN * dt;
  else b += (DRAFT_GAIN * clamp(drafting, 0, 1) + (airborne ? AIR_GAIN : 0)) * dt;
  return clamp(b, 0, BOOST_MAX);
}

// Holding the button is not the same as boosting: an empty bar, or one below
// the arming threshold you have not already broken into, does nothing.
export function boostActive(boost, holding, wasBoosting) {
  if (!holding || boost <= 0) return false;
  return wasBoosting || boost >= BOOST_ARM;
}

// ---------------------------------------------------------------------------
// The water surface
//
// Three travelling swells. This is the single definition of where the water is:
// the mesh is built from it and every ski rides it, so they cannot disagree.
// ---------------------------------------------------------------------------
// A long ocean roller carrying three shorter swells. The roller is what gets a
// ski airborne — the short chop on its own is a texture, not a ramp.
export const SWELL = [
  { amp: 0.95, len: 88, dir: 0.35, spd: 7.6 },
  { amp: 0.42, len: 41, dir: 0.62, spd: 5.4 },
  { amp: 0.20, len: 19, dir: 2.10, spd: 3.9 },
  { amp: 0.09, len: 9, dir: -0.85, spd: 2.8 },
];
export const SWELL_MAX = SWELL.reduce((a, w) => a + w.amp, 0);

export function waveHeight(x, z, t) {
  let y = 0;
  for (const w of SWELL) {
    const k = TAU / w.len;
    y += w.amp * Math.sin(k * (Math.cos(w.dir) * x + Math.sin(w.dir) * z - w.spd * t));
  }
  return y;
}

// Analytic slope — cheaper and exact where recomputing mesh normals is neither.
export function waveSlope(x, z, t, out = { dx: 0, dz: 0 }) {
  let dx = 0, dz = 0;
  for (const w of SWELL) {
    const k = TAU / w.len;
    const c = Math.cos(k * (Math.cos(w.dir) * x + Math.sin(w.dir) * z - w.spd * t)) * w.amp * k;
    dx += c * Math.cos(w.dir);
    dz += c * Math.sin(w.dir);
  }
  out.dx = dx; out.dz = dz;
  return out;
}

// A whole row of the water mesh at once.
//
// This lives here, next to waveHeight, because it is the same water — the mesh
// the player looks at has to be the surface the ski rides, and the only way to
// be sure of that is for a test to compare the two. It is separate because
// evaluating four sines per vertex, sixty times a second, is the single most
// expensive thing this game does. Along a row of the grid each wave's phase
// advances by a constant, so successive sines and cosines come from one complex
// rotation apiece: two multiplies instead of a trig call. One `Math.sin` per
// wave per row seeds it, and 3,000 vertices cost about 400 trig calls a frame
// rather than 24,000.
export function waveRow(x0, dx, n, z, t, outY, outSx, outSz, off = 0) {
  for (let i = 0; i < n; i++) { outY[off + i] = 0; outSx[off + i] = 0; outSz[off + i] = 0; }
  for (const w of SWELL) {
    const k = TAU / w.len;
    const cx = Math.cos(w.dir), cz = Math.sin(w.dir);
    const ak = w.amp * k;
    const d = k * cx * dx;
    const sd = Math.sin(d), cd = Math.cos(d);
    let s = Math.sin(k * (cx * x0 + cz * z - w.spd * t));
    let c = Math.cos(k * (cx * x0 + cz * z - w.spd * t));
    for (let i = 0; i < n; i++) {
      const j = off + i;
      outY[j] += w.amp * s;
      outSx[j] += ak * cx * c;
      outSz[j] += ak * cz * c;
      const ns = s * cd + c * sd;
      c = c * cd - s * sd;
      s = ns;
    }
  }
}

// Hitting the up-slope of a swell at speed throws the ski into the air. Below
// LAUNCH_V it just bobs, which is why the rolling start is calm and the end of
// a straight is not. Capped, because the steepest face of four aligned swells
// is rare enough that tuning for it would make every ordinary jump limp.
export const LAUNCH_V = 20;
export const LAUNCH_K = 1.35;
export const LAUNCH_MAX = 7;
// Only a real swell face throws you. At 0.05 the ordinary chop cleared the bar
// and the ski spent 41% of a race in the air, skipping rather than planing —
// which is neither what a jet ski does nor what makes a jump feel earned.
export const LAUNCH_SLOPE = 0.125;
export function launchSpeed(v, slopeAlong) {
  if (v < LAUNCH_V || slopeAlong <= LAUNCH_SLOPE) return 0;
  const vy = slopeAlong * v * LAUNCH_K * clamp((v - LAUNCH_V) / (V_MAX - LAUNCH_V), 0, 1.5);
  return Math.min(vy, LAUNCH_MAX);
}

// ---------------------------------------------------------------------------
// Rivals
//
// Seven of them, with real differences in pace, and a catch-up that is
// deliberately feeble. Strong rubber-banding makes every race end in a photo
// finish, which sounds exciting and is actually the opposite: nothing you do in
// the first two laps can matter. This one is worth about a length a lap.
// ---------------------------------------------------------------------------
// `hue` is the livery, and it is the only way to tie a name in the standings
// to a hull on the water — so no rival may sit near the player's magenta, and
// no two may sit near each other.
// The field is pitched against a driver who makes no use of the wake at all.
// Measured over six races, an autopilot that never deliberately drafts and
// only spends boost on the straights averages 5th of 8, about six seconds
// behind, and occasionally wins. That gap is the game: deliberate drafting is
// worth roughly twice the boost income, and boost is worth about 1.3 s a bar,
// so the wake is exactly the difference between a midfield result and a win.
// Pitched at parity with the leader the same driver came 7th, ten seconds
// down — and a mechanic you must master in order to finish seventh teaches
// nobody anything. These numbers come from an AI proxy, not a human; if the
// first real playtest says otherwise, this table is the one dial to turn.
export const RIVALS = [
  { name: 'HIKARI', pace: 0.980, line: 1.00, hue: 0.16 },
  { name: 'KAZU',   pace: 0.966, line: 0.94, hue: 0.55 },
  { name: 'RIN',    pace: 0.958, line: 0.90, hue: 0.03 },
  { name: 'SORA',   pace: 0.951, line: 0.86, hue: 0.42 },
  { name: 'AYUMI',  pace: 0.943, line: 0.82, hue: 0.72 },
  { name: 'REN',    pace: 0.935, line: 0.78, hue: 0.09 },
  { name: 'YUKI',   pace: 0.927, line: 0.74, hue: 0.30 },
];
export const PLAYER_NAME = 'YOU';
export const PLAYER_HUE = 0.92;

export const CATCHUP = 0.06;      // ±6% of pace, at 120 m adrift
export function aiPace(base, behindBy) {
  return base * (1 + clamp(behindBy / 120, -1, 1) * CATCHUP);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------
export function formatTime(ms) {
  if (ms == null || !isFinite(ms)) return '--:--.--';
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const c = Math.floor((t % 1000) / 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

export function formatGap(ms) {
  const t = Math.abs(ms) / 1000;
  return `${ms < 0 ? '-' : '+'}${t.toFixed(2)}`;
}

export const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
export const ordinal = (i) => ORDINALS[i] || `${i + 1}th`;
