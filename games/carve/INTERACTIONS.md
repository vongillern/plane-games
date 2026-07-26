# Carve — Interaction Guide

## Mental model
"I'm carving down an endless groomed mountain." The finger is an edge:
holding it offset from where it touched down holds a carve in that
direction — farther means sharper. Lifting straightens out. In the air the
same drag becomes rotation. One verb (drag), two contexts (snow / air).

## Inputs (touch first)
- **Horizontal drag, held** → carve. Steering is the *offset from the
  touch-down point* (position control, full lock at ±140px), so a held
  finger holds a line and micro-corrections are 1:1. Release eases the
  board straight.
- **Tap** (<12px, <260ms) → ollie. Anywhere on screen. A tap ~0.1s before
  landing is buffered and fires on touch-down.
- **In the air: horizontal drag** → spin the board (~0.9°/px). Land within
  ~55° of straight (either way — switch counts) or the landing is
  "sketchy": big speed loss, wobble, no points, but not a crash.
- **Kickers** (snow ramps with orange flags) launch automatically off the
  lip — speed decides air time. No timing test on takeoff; the skill is
  the spin and the landing.
- Keyboard: ←/→ or A/D carve (and spin mid-air), Space/Enter jump &
  start/restart, R instant restart, M mute.
- **Tap anywhere** starts/restarts from the overlays.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Clamp, don't reject
- The piste is fenced with orange netting. Drifting into it *clamps*
  position with a soft bounce, spray, a scrape sound and a light haptic —
  you can never carve out of the world, and the fence never kills.
- Steering saturates at the carve limit; extra drag past ±140px does
  nothing rather than breaking the model.

## Feedback (every input answers back)
- Carving: board yaw + body lean + snow spray + carve noise scale with
  carve sharpness; a groove trail is left behind.
- Jumps: whoosh; landings: spray burst + thump + camera dip scaled by air
  time. Tricks: toast (`360! +100`) + chime + haptic. Sketchy landings:
  wobble animation + "sketchy landing" toast + haptic.
- Near-missing an obstacle while grounded pays `close! +15` — the risk of
  threading tight lines is rewarded, teaching that proximity is safe-ish.

## Intentional behaviors
- Trees always kill on contact; **rocks can be ollied over** (they're
  short) — discovered naturally the first time a buffered jump clears one.
- A guaranteed corridor always exists through obstacle rows; kicker
  approaches and landings are kept clear of obstacles.
- Crash → tumble + spray, game-over panel within 300 ms, tap restarts
  instantly *from where you crashed* (the mountain continues; score
  resets). The panel ignores taps for its first 400 ms so the tail of a
  drag that was in flight during the crash can't restart the run by
  accident.
- **The mountain pulls hard.** You leave the gate at 17 m/s and reach a
  40 m/s terminal in about six seconds; the old ramp took nearly twenty,
  which meant the first half of every run was spent waiting to get going.
  Obstacle rows are spaced in metres, so they moved ~25% further apart to
  keep the *felt* rhythm — the run is quicker, not harder. Scores are
  distance, so a run of the same length now scores higher than it used to.
- Attract mode: on the start screen the rider slowly cruises the slope
  behind the panel, showing the scene before the first input.

## Scoring
- Score = metres travelled + trick bonuses (180 +40, 360 +100, 540 +180,
  720 +280…; clean big air +25; near miss +15). Clean tricks also pay a
  small speed boost. Best score persists (`am.carve.best`).

## Sound
- Fully synthesized (WebAudio): wind bed scales with speed, carve noise
  with edge pressure, plus whoosh/thump/chime/scrape one-shots. Mute
  toggle (persisted, `am.carve.muted`) top-right; also the M key. iOS
  autoplay rules respected — audio starts on first gesture.
