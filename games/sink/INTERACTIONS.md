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

## Clamp, don't reject
- Dragging past 90px does nothing extra rather than accelerating away or
  snapping the stick — the gesture saturates instead of breaking.
- The arena is fenced (guardrail / shoreline / parapet, per map). Running
  into it *clamps* the hole at the edge with a soft bounce, a low thud
  and a light haptic. You can never steer out of the world and the edge
  never kills.

## Every input answers back
- Anything you swallow gives a dust puff at the rim, a thud pitched down
  by the object's size, and — for anything large — a haptic tick and a
  small camera shake.
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
- Speed rises gently with size (`r ^ 0.28`) while the camera pulls back
  faster, so a big hole reads as weighty without ever feeling sluggish.
- **Holes eat holes.** Any hole 15% bigger than another swallows it
  whole, taking 55% of its area. That applies to you in both directions.
- Being swallowed is a setback, not an elimination: you respawn 2.5s
  later at ~35% of your area, elsewhere on the map. The match always runs
  its full 120 seconds.
- Rivals hunt. They pick the best value-per-distance target they can
  actually fit, and switch to a smaller hole — including yours — when one
  is in range. They are not on rails.
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
