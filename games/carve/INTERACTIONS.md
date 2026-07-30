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
- **In the air: vertical drag** → flip. Down pulls the nose down (a
  frontflip), up throws it back (a backflip), ~1°/px. A flip has to come
  all the way back over — within ~54° of upright — or it lands sketchy. A
  diagonal drag does both at once, which is how the corked tricks come out.
- **In the air: hold still** → grab. A hand on the board is a still hand, so
  holding the drag (or `Shift`) without steering for ~0.4s tucks the rider
  into a method. Any rotation input cancels it; adding one back mid-air is
  what makes "540° + grab".
- **Kickers** (snow ramps with orange flags) launch automatically off the
  lip — speed decides air time. No timing test on takeoff; the skill is
  the rotation and the landing.
- **Rails** (a steel bar on posts, an orange marker at the entry) pay by the
  metre. The uphill end tapers into a snow lead-in, so *riding into one puts
  you on it* — nothing new to learn, and no way to miss the mechanic. On the
  bar: tap to pop off early, or lean hard (>80% lock) to step off the side.
  Riding off the end pops you into a small air. Every exit pays.
- Keyboard: ←/→ or A/D carve (and spin mid-air), ↑/↓ or W/S flip mid-air,
  `Shift` grab, Space/Enter jump & start/restart, R instant restart, M mute.
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
- A rail has no fail state. Balance is a visible sway, not a timer; leaning
  out of it is a dismount, not a crash, and it still pays.

## Feedback (every input answers back)
- Carving: board yaw + body lean + snow spray + carve noise scale with
  carve sharpness; a groove trail is left behind.
- **Quick cuts throw snow.** Changing edges under load — or a flick faster
  than any held input can produce — kicks a fan of powder off the new
  outside edge with a short swish. A smooth lean gets nothing, so the
  effect only ever means "that was sharp".
- Jumps: whoosh; landings: spray burst + thump + camera dip scaled by air
  time. Tricks: toast (`rodeo 540° +360`) + chime + haptic. Sketchy
  landings: wobble animation + "sketchy landing" toast + haptic.
- Grinds: a bright metallic bed that replaces the carve noise entirely,
  orange sparks off the board, and a `grind 14m` payout on the way out.
- Near-missing an obstacle while grounded pays `close! +15` — the risk of
  threading tight lines is rewarded, teaching that proximity is safe-ish.
- **Streaks light the board up.** Three scored things in a row — tricks,
  grinds, near misses — and the deck starts to glow accent teal, the grooves
  it cuts take the same colour, embers trail off the tail and a `STREAK ×3`
  pill appears next to the score. Keep it going and the whole thing runs
  gold, with the reward chime climbing a step each time. A crash or a
  sketchy landing puts it out; a plain landing does not.

## Intentional behaviors
- **Straight is the fast line.** A held full-lock carve settles around
  33 m/s where a straight line reaches 42; a lazy carve costs almost
  nothing, because the loss is superlinear in edge pressure. Turning to dodge
  is a real trade, not a free action. A grind gives up nothing at all —
  there is no snow under the board — which is why a rail feels quick.
- **Trees have tops.** They kill on contact, but the crown ends about 3m up
  and tapers, so a kicker really can carry you over one, and a near-clear
  only clips if you fly right down the trunk line. (This was a bug: a tree's
  contact height was literally 99m, and flying clean over one still ended
  the run.) Rocks are short enough to ollie.
- A guaranteed corridor always exists through obstacle rows; kicker
  approaches, landings and the whole length of a rail are kept clear.
  `tools/smoke.mjs` measures both — obstacles per 100m, and that a line
  through exists at every metre of 3km.
- **The rider rides square.** The stance keeps a whisper of yaw (4°) and the
  head cancels it, so the face stays on the fall line. The visible yaw is
  the direction of travel, which means it reads as *steering*. (It used to
  carry a permanent 15°, which read as a broken character rather than style.)
- **The mountain pulls hard.** You leave the gate at 17 m/s and reach
  cruising speed in about six seconds; the old ramp took nearly twenty,
  which meant the first half of every run was spent waiting to get going.
- Obstacle rows are spaced in metres and thin out at roughly 4 per 100m
  early, 8 by 3km — a mountain, not a slalom course.
- Crash → tumble + spray, game-over panel within 300 ms, tap restarts
  instantly *from where you crashed* (the mountain continues; score
  resets). The panel ignores taps for its first 400 ms so the tail of a
  drag that was in flight during the crash can't restart the run by
  accident.
- Attract mode: on the start screen the rider slowly cruises the slope
  behind the panel, showing the scene before the first input.

## Sundown
Distance is a clock. Past 850m of a run the light starts to go: the sun drops
into alpenglow — pink snow, deep blue sky, the first stars — and by another
1150m the run is under moonlight, with the chalet windows, the kicker flags
and the streak glow doing all the work. A restart brings the sun back up, so
every run is a whole afternoon and nobody has to find a settings screen.

One colour drives it. Everything unlit — the painterly range, the valley, the
forests, the netting, the sky's own base stop — is multiplied by a tint, and
the fog is that same tint times the daylight fog colour, which is why the
aerial haze baked into the backdrop still lands exactly on the horizon at
midnight. Everything lit needs nothing: the sun and hemisphere lights go dim
and cold, and the snow follows.

## Scoring
- Score = metres travelled + trick bonuses. Rotations: 180 +40, 360 +100,
  540 +180, 720 +280…; flips: backflip/frontflip +120, double +320; a flip
  with a spin in it (rodeo / misty) adds +60 on top of both halves; grabs
  +45 alone or +35 on top of a rotation; clean big air +25; grinds +9/m;
  near miss +15. Clean tricks also pay a small speed boost. Best score
  persists (`am.carve.best`), and the game-over panel names your best trick
  and longest streak.

## Sound
- Fully synthesized (WebAudio): wind bed scales with speed, carve noise with
  edge pressure, a bright steel bed while grinding, plus whoosh / thump /
  chime / swish / clank / scrape one-shots and a streak chime that climbs a
  step per trick. Mute toggle (persisted, `am.carve.muted`) top-right; also
  the M key. iOS autoplay rules respected — audio starts on first gesture.

## Where the rules live
`rules.js` is pure — no DOM, no Three.js, no clock, no `Math.random` — and it
owns what *counts*: obstacle contact profiles, landing tolerances, trick names
and prices, the speed model, grind and streak maths. `game.js` owns the
mountain, the renderer and the input. `node tools/carve-rules.mjs` checks the
rules in milliseconds; `node tools/smoke.mjs` proves they are wired to the game
in a real browser.
