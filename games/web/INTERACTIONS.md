# Web — Interaction Guide

## Mental model
"I hold on, I ride the arc, I let go at the right moment." There is one verb and
it is a hold. Pressing casts a web at whatever is up and ahead of you; keeping
it pressed keeps the line attached; letting go throws you along the arc with
every bit of speed you built. The finger is not a throttle and not a stick —
it is a grip.

The second idea, and the one everything else serves: **the web attaches to the
city, not to the sky.** Every anchor is a real point on a real building found by
casting rays at it. That single constraint is what makes the skyline something
you read rather than scenery you pass, and it is the thing Spider-Man 2 changed
about Spider-Man 1.

## Inputs (touch first)
- **Hold anywhere** → cast a web, and keep casting until one catches. The cone
  of feeler rays starts narrow at your aim and **widens the longer you hold**,
  so a quick tap is a precise shot at one particular ledge and a long hold is a
  scoop that will find something. This is Energy Hook's refinement of the
  Spider-Man 2 mechanic, and it is what lets one control serve both a player
  who knows what they want and a player who just wants to keep moving.
- **Horizontal drag, held** → aim. Steering is the *offset from the touch-down
  point* (position control, full lock at ±110px), the same idiom Wake steers
  with, so a held finger holds a line and a correction is 1:1. It swings the
  feeler cone to the side and also steers you in mid-air.
- **Release** → let go of the line. This is the whole skill of the game: let go
  at the bottom and you go far and low, let go on the way up and you go high and
  short. Nothing tells you when; you learn it in about four swings.
- Keyboard: hold Space to web (and to start/restart), ←/→ or A/D to aim, R for
  an instant restart.
- **Tap anywhere** starts/restarts from the overlays.
- **Pause** → the round button top-right, or `Esc` / `P`. Shared behaviour —
  see `pause.js` and "Pause" in `DESIGN.md`. It only exists during a run.
- **Check for updates** → the pill at the bottom, on the start and results
  screens only. Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Clamp, don't reject
- **There is no crash, no death and no reset.** Hitting a wall costs you 14% of
  your speed and sends you sliding along it. Hitting the street costs a little
  more and you run. The clock is the only thing that can end a run.
- Steering saturates at full lock; dragging past ±110px does nothing rather
  than breaking the model.
- A web fired with nothing in range does not fail — it keeps looking, widening,
  until something catches or you let go. The only place it genuinely finds
  nothing is above the rooftops, which is correct: there is nothing up there.
- Landing drops the line rather than leaving you tethered to a wall you can no
  longer swing from.
- The rope pulls and never pushes, so a web fired at something below you simply
  goes slack until you fall past it and it comes tight.

## Feedback (every input answers back)
- A web that catches: the line snaps taut, the figure's arms come up along it,
  and a short haptic fires. From the ground it also launches you, hard.
- Speed: the camera pulls back and the lens widens with pace, a contrail
  follows the arc, and the km/h readout climbs. Fristrom's point about cosmetics
  is doing all the work here — the physics of 40 m/s and 20 m/s differ by a
  number, and the camera is what makes them differ by a feeling.
- A wall: the camera takes a knock (suppressed entirely under reduced motion).
- A beacon reached: a `+13s` toast, a haptic, and the clock jumps.
- Under ten seconds the clock turns coral and breathes, and it becomes an
  `aria-live` region so it is announced rather than merely coloured.
- Off-screen beacons get an arrow around the edge of the screen with the
  distance on it. A countdown toward a target the player cannot find is not a
  challenge.

## Intentional behaviors
- **The anchor is chosen for you, and imperfectly on purpose.** Players told
  Fristrom they rarely ended up where they intended and did not care — the
  uncertainty is the texture of the game. The assist prefers anchors that are
  ahead, roughly 37° up, and mid-length, and it checks the best candidate for
  the one failure that reads as a bug rather than as bad luck: swinging you
  straight into the wall you just attached to. It does not try to be right.
- **Straight overhead is refused.** A rope directly above you is a dead
  pendulum — you hang and bob with no arc to convert height into speed. Scoring
  "higher is better" walks into it and the whole game becomes a pogo stick in
  one street, which is what the first tuning pass actually produced.
- **The web reels itself in, and that is load-bearing.** A pendulum bottoms out
  at (anchor height − line length); attach from down in a street and that is
  below the pavement, so the line never comes tight. Reeling lifts the bottom of
  the arc, does work on the player, and is why a run cruises across the rooftops
  at ~140 km/h instead of trudging along the second storey at 70.
- **A swing pumps itself on the way down.** A real rope plus air resistance
  loses height every arc and the run dies four webs in.
- **Gravity is about 7.5× Earth.** So are the jumps. Fristrom's Spider-Man 2 ran
  at roughly ten, for the same reason: at Earth gravity a 90 m line is a
  six-second wallow and the speed the fantasy runs on never arrives. Nobody has
  ever objected to this in a swinging game; they object to webs on clouds.
- **The first few beacons are easier than the rest and nobody is told.**
  Spider-Man 2 shipped new players a slower, draggier hero and sold the
  difference back through a shop — which Fristrom notes is itself a violation of
  the fantasy, since Spider-Man does not buy his powers in a store. A short run
  can have the curve for free: drag, gravity and the minimum cone width all ramp
  to their real values over the first six beacons.
- **The Running Man.** Frustrated testers stopped swinging and jogged to the
  objective through the streets; Spider-Man 2 detected it and had Bruce Campbell
  mock them until they went back up. Four and a half seconds on the deck here
  gets a toast. It is the difference between a player who has decided not to
  play the game and a player nobody told.
- Attract mode: the start screen arcs the camera slowly around the skyline, so
  the city is on show before the first input.
- **No audio.** `DESIGN.md` keeps audio to Carve and Sink; a third would mean
  promoting it to a shared `audio.js` rather than pasting the module again.
  A velocity-scaled wind would suit this game more than most — that is the
  trade being made, not an oversight.

## Scoring
There is no score — there is a result. Beacons reached, the distance swung, and
your best (`am.web.best`). Fristrom's warning about keeping extrinsic motivators
out of the core applies directly: the reason to swing has to be the swinging.

## Where the rules live
`rules.js` is pure — no DOM, no Three.js, no clock, no `Math.random` — and it
owns the city, the raycast, the feeler cone and the anchor choice, the pendulum
and its reel, contact, the beacon and clock economy, and the assist ramp.
`game.js` owns the renderer, the camera, the input and the HUD.

The city is worth calling out: buildings are axis-aligned boxes on a hashed
grid, which is a design decision rather than a shortcut. It makes the anchor
raycast an analytic slab test over a grid walk, so the most important code in
this game — how a web decides what to grab — runs in Node and gets checked. A
mesh-picking city would have put it somewhere no test could reach. It also means
the world is infinite and stateless: there is no edge and nothing to store.

`node tools/web-rules.mjs` checks the rules in milliseconds — including a
sixty-second autopilot run that asserts the swing sustains its pace, never puts
the player through a wall, and never once brings him to a stop. `node
tools/smoke.mjs` boots the real thing in a browser and swings it headlessly.
