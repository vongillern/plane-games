# Sink — Interaction Guide

## Mental model
"I am the hole." The finger is not a cursor and not a vehicle — it is a
direction. Whatever the opening passes under falls in, if it is smaller
than the opening. Everything else in the game follows from one question
the player asks constantly: *am I big enough for that yet?*

## Inputs (touch first)
- **Drag anywhere, held** → steer. Touch-down places a floating stick;
  the offset from that point is the direction, and its length is the
  speed (dead zone 6px, full speed at 90px). A held finger holds a line;
  lifting coasts to a stop. The stick is drawn where the finger landed,
  so it never fights the thumb's natural resting place.
- **Tap** (<12px, <300ms) → start / play again from the overlays. Any
  point on the screen works, not just the button.
- Keyboard: WASD or arrows steer at full speed, Space/Enter start &
  restart, R restarts immediately, M mutes.
- The stick renders for mouse drags too — on desktop the hint reads
  "WASD or arrows", but dragging works and shows the same ring.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Clamp, don't reject
- Dragging past 90px does nothing extra rather than accelerating away or
  snapping the stick — the gesture saturates instead of breaking.
- The arena is fenced (guardrail / shoreline / parapet, per map). Running
  into it *clamps* the hole at the edge with a soft bounce, a low thud
  and a light haptic. You can never steer out of the world and the edge
  never kills.

## Every input answers back
- Anything you swallow gives a dust puff at the rim as the ground under it
  goes, then — once it is actually *in* — a thud pitched down by the
  object's size, and for anything large a haptic tick and a small camera
  shake. The score and the growth land on that same beat, not on the puff.
- **Things too big to eat shiver** when the hole passes beneath them.
  This is the game's most important piece of feedback: without it a
  player reads "nothing happened" as a bug rather than as "not yet".
- Crossing a size threshold toasts what just became edible ("cars are on
  the menu") with a chime, so growth is legible without a tutorial.
- The hole visibly swells toward its new radius rather than popping, and
  the camera pulls back as you grow — being big *feels* different.

## Intentional behaviors
- Growth is area-true: swallowing adds area, and the radius is
  `sqrt(area / PI)`. Early swallows change your size a lot, late ones
  barely — the same curve as the objects you can reach.
- **Bigger is slower.** Speed falls with size (`r ^ -0.34`, floored at 52%
  of base) and a big hole takes longer to change course. Growth buys reach
  and menu, never pace — so a late lead has to be steered, and a small hole
  can always outrun a big one. It is the trade the whole match is built on.
- **Holes eat holes.** Any hole 15% bigger than another swallows it
  whole, taking 55% of its area. The player is given a wider margin: a
  rival needs to be 45% bigger to take *you*. The house tilts the table
  your way, quietly.
- Being swallowed is a setback, not an elimination: you respawn 2.5s
  later at ~35% of your area, elsewhere on the map. The match always runs
  its full 120 seconds.
- Rivals hunt, but they are opponents with a plan, not solvers. They run
  at 60–78% of full speed, re-appraise every ~1–2s (not twice a second),
  judge targets with a wide jitter, bank 18% less area per bite than you,
  mooch for a beat about a third of the time, and never chase a hole fast
  enough to outrun them. They are still not on rails — they are just
  beatable.
- **Blockers dissolve.** Anything standing between the camera and your
  hole — a tower, a bus — fades to a dither until it is out of the way, so
  the pit is never hidden by the city. It is a screen-door fade, not
  blending: the props stay in the opaque pass and never need sorting.
  What counts as "standing between" is **any part of the building**: the
  test is against its whole column, base to roof, so the tower leaning
  over your hole with its footprint off the bottom of the screen fades
  like any other. Where its feet are has nothing to do with it.
- **Things fall in, they do not come untethered.** The ground under a prop
  is already gone when it goes, so it leaves with weight: full gravity and
  a real downward push from the first frame, and only a nudge inward. It
  overbalances on the rim, tips over it, then spirals down the shaft,
  reflecting off the wall on the way. Small props whip over; a tower
  groans. Each one dissolves as the last of it drops past the rim, so a
  bench and a tower both vanish at the same moment in their own fall —
  the moment you can no longer see them.
- **Half of it has to be under before it counts.** A prop that has only
  just tipped in can still be standing proud of the rim; the hole banks
  the points and takes the growth once half of it is below the ground,
  and not before. Swallowing a tower is a thing that takes a moment.
- The shaft is flat black, unlit and unfogged — a hole is an absence, and
  any wall shading at all made it read as a grey bowl painted on the
  ground. A hole across the arena is exactly as black as the one at your
  feet, and the props tumbling down it are the only thing in there
  catching light.
- Attract mode: on the start screen the rivals eat the city behind the
  panel while the camera orbits. Starting a match regenerates the world,
  so the demo never eats into your run.

## Maps
Three maps rotate, one per match (`am.sink.map`), named on the start and
results panels: **Downtown** (street grid, towers, traffic), **Bayside**
(park paths, palms and a beach), **Skydeck** (a rooftop plaza of
concentric rings). They share one generator — each supplies a palette, a
road network, a ground painter and a density table.

## Scoring
- Points per object, scaled by its size; +200 and a share of the victim's
  score for swallowing a rival hole. Final placement (1st–4th) is what
  the results panel leads with; best score persists (`am.sink.best`).

## Sound
- Fully synthesized (WebAudio): a low bed that deepens as the hole grows,
  a per-swallow thud pitched by object size, tier chimes, a countdown
  beep in the last five seconds, and a match-end sting. Mute toggle
  (persisted, `am.sink.muted`) top-right; also the M key. Audio starts on
  the first gesture, respecting iOS autoplay rules.
