# Wake — Interaction Guide

## Mental model
"I'm racing a jet ski, and I start last." The finger is the handlebars: hold it
offset from where it touched down and the ski holds that lock — farther means
sharper. Lifting straightens out. The throttle is never yours; the *line* is.
One drag verb, one button, and everything else the race gives you for free.

The second idea, and the one the whole game is built on: **the wake ahead of
you is fuel.** Sitting in a rival's spray fills the boost bar. The player
starts on the back row precisely so this is discovered in the first corner
rather than the third lap.

## Inputs (touch first)
- **Horizontal drag, held** → steer. Steering is the *offset from the
  touch-down point* (position control, full lock at ±96px), so a held finger
  holds a line through a corner and micro-corrections are 1:1. Release eases
  the bars straight. The drag works anywhere on the screen — the HUD is inert
  to the pointer, so a thumb crossing the speedo never stops the ski turning.
- **BOOST button** (bottom right, 84px) → hold to burn the bar. It is the one
  real button because it is the one input that must never fire by accident
  mid-corner. It is a separate pointer from the steering drag, so you can hold
  both at once.
- Keyboard: ←/→ or A/D steer, Space boost (and start/restart), R instant
  restart.
- **Tap anywhere** starts/restarts from the overlays.
- **Pause** → the round button top-right, or `Esc` / `P`. Shared behaviour —
  see `pause.js` and "Pause" in `DESIGN.md`. It only exists while a race is
  running: there is nothing to freeze on the start or results screen.
- **Check for updates** → the pill at the bottom, on the start and results
  screens only. Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Clamp, don't reject
- Steering saturates at full lock; dragging past ±96px does nothing rather
  than breaking the model.
- There is no crash and no reset. Running wide into the shallows *caps* your
  speed at 17 m/s against a racing 33 — you keep driving, you keep your lap,
  and a rival goes past. Clipping a buoy costs 28% of your speed, not your race.
- Bumping another ski pushes both apart and costs each of you 1.5%. Contact is
  racing; a penalty big enough to notice would make an eight-ski pack
  unplayable on a phone.
- Boost cannot be fired below 15% of a bar, so a stab at an almost-empty meter
  cannot waste it — but a burst already running drains all the way to zero
  rather than cutting out mid-corner.

## Feedback (every input answers back)
- Steering: the ski rolls into the turn, the hull slides (the tail steps out
  and catches up), spray sheets off the inside edge, and a foam wake is laid
  down behind you.
- Boost: the button fills accent magenta and scales down, the gauge's inner
  ring drains, the camera FOV punches out, and the rooster tail doubles.
- **Pressing boost on an empty bar shakes the button** and gives a short
  haptic. A button the player deliberately pressed must never answer with
  silence.
- Swell: hitting the face of a roller at speed throws the ski into the air —
  the camera lifts, steering authority drops to a quarter, and the bar fills
  while you are up there. Landing bursts spray and dips the camera.
- Laps: a `lap 00:42.19` toast, marked **best** when it beats the stored one,
  plus a haptic. Overtakes tick the position number, and taking the lead turns
  it magenta.
- Off course: an `off course` toast on the way out, and the spray turns sand.
- The minimap and the eight-row standings list are the peripheral vision a
  portrait frame cannot give you. The livery swatch beside each name is the
  same colour as that rider's ski, which is the only way to tie a name in the
  list to a hull on the water.

## Intentional behaviors
- **The tidy line is the fast line.** A held full-lock turn settles around
  21 m/s where a clean line reaches 33, and the loss is superlinear — a lazy
  correction costs almost nothing. Grip also falls away with speed, so a
  hairpin genuinely has to be taken slower. That is what makes a racing line
  exist rather than being decoration.
- **The throttle is always open.** A phone racer that asks you to hold a
  button to move has spent its only input.
- **Rubber-banding is deliberately feeble** — ±6% of pace at 120 m adrift, and
  a rival can never out-pace you by more than 15% however far ahead you get.
  Strong catch-up makes every race a photo finish, which sounds exciting and is
  actually the opposite: it means nothing you do in the first two laps matters.
- **A wake out-earns a jump better than two to one.** Air is something the
  lagoon hands you for driving fast; a tow is something you have to go and take
  off a rival, so it has to be worth more. When the two were level the bar
  filled nine times in a ninety-second stint, four fifths of it from jumps, and
  the tow — the reason the player starts at the back — was decoration. Only a
  real swell face launches the ski now, so it is airborne about a tenth of the
  time rather than nearly half of it, and about three quarters of the bar comes
  off the wake.
- **The grid is a real standing start.** Eight skis, four rows of two, all
  *ahead* of the line, so the first crossing completes lap 1 exactly as a real
  race does. The player is on the back row.
- **Your result is your position as you cross the line.** Rivals keep racing
  behind the results card — a lake that empties the moment someone finishes
  looks broken — but the order shown is the order at your finish.
- **The circuit cannot cross itself.** It is a closed radial curve, which
  guarantees it, and `tools/wake-rules.mjs` also proves that no two stretches
  come within two channel widths. If they did, "how far around are you?" would
  have two answers, and the lap counter, the standings and every rival's
  target would quietly pick the wrong one.
- Crossing the start line *backwards* after a spin takes the lap away again
  and gives it back when you re-cross. The obvious `s < lastS` test gets this
  wrong and silently awards a free lap.
- Attract mode: the start screen slowly arcs the camera around the grid, so
  the lagoon is on show before the first input.
- **No audio.** `DESIGN.md` keeps audio to Carve and Sink; a third would mean
  promoting it to a shared `audio.js` rather than pasting the module again.

## Scoring
There is no score — there is a result. Finishing position, total time, and best
lap, with the field listed and gapped behind you. Best lap persists
(`am.wake.bestlap`) and the HUD shows it live; best finishing position persists
too (`am.wake.bestpos`).

## Where the rules live
`rules.js` is pure — no DOM, no Three.js, no clock, no `Math.random` — and it
owns the course geometry, the racing line, lap and progress arithmetic, the
standings order, the speed and steering model, the boost economy, the wake's
shape, and the water surface itself. `game.js` owns the lagoon, the renderer,
the AI and the input.

The water is worth calling out: `waveHeight` in `rules.js` is the *only*
definition of the surface. The mesh the player looks at and the height every
ski rides both read it (the mesh through `waveRow`, which is the same maths
evaluated a row at a time by complex rotation instead of four sines per
vertex), and `tools/wake-rules.mjs` asserts the two agree to 1e-9. Before that
they were two functions, and keeping them in step was a thing to remember.

`node tools/wake-rules.mjs` checks the rules in milliseconds; `node
tools/smoke.mjs` races a full three laps on autopilot in a real browser and
proves they are wired to the game.
