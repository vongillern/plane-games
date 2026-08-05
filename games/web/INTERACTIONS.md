# Web — Interaction Guide

## Mental model
"The thread is the accelerator." One verb, and it is *held*, not tapped: press
and a web goes out and grabs the best anchor ahead of you; keep holding and you
swing under it, gaining speed; let go and you fly. The player is never choosing
*which* anchor — only *when* to hold and when to let go. Everything else in the
game is a consequence of those two moments.

The whole risk/reward sits in one place: a web held longer carries you higher
and slower; letting go at the bottom of the arc is the fastest line and sheds
altitude every swing. Score is distance, so the reward for good timing is just
more distance — there is no second number to read.

## Inputs (touch first)
- **Press and hold anywhere on screen** → fire a web and swing. Releasing lets
  go. The press also starts the game from the title and restarts from game
  over, so the first press of a run is already a web. The entire viewport is
  the control; there is nothing to aim.
- Keyboard: hold **Space** / **↑** / **Enter** to swing; **R** restarts when
  over. Key repeat is ignored, so a held key is one continuous web.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the card
  anywhere to resume; backgrounding the app pauses too. Shared behaviour — see
  `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it. It
  appears only when this game is the app you launched: opened from the hub, the
  hub does the updating for everything and this pill stays away. Shared
  behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Discoverability
- Start overlay: "hold to swing, let go to fly" — both halves of the verb, in
  the order you need them.
- **The anchor the game would grab wears a pulsing ring.** The aim rule
  (`pickAnchor` in `rules.js`) is genuinely non-obvious — it prefers a forward,
  roughly 50° shot and refuses anything behind you or too far out for its own
  rooftops — and none of that is written down anywhere in the app. Showing the
  answer instead of explaining the rule is the whole tutorial.
- Every anchor tip glows even when it is not the candidate, so the line you
  could take is legible several swings ahead. That is what makes "when do I let
  go" a decision rather than a guess.
- Rooftops carry the only cool rim light in the scene, because the roof edge is
  the thing you are actually flying against.
- The counter marks every 250 m with a pop and a tick of haptic; the metres in
  between are written silently. A number that animates twenty-five times a
  second is unreadable, and worse, distracting exactly when a run is going
  well.
- Game over: "Swing again" button (52px) plus "or hold anywhere".

## Intentional behaviors
- **A held web with nothing in range is not silent.** The line casts out and
  snaps back on a loop for as long as you hold, and the first unanswered shot
  buzzes once. Holding through a gap is a legitimate move — the web attaches
  the instant something comes into range — so the reaching animation has to
  read as *working on it*, not as a dead control. It buzzes once rather than
  per frame; a haptic every 16 ms is a broken phone, not feedback.
- **During the ~0.45 s death tumble, input is swallowed**, exactly as in Glide.
  A player mid-swing is holding the button when they hit, and without this they
  would fly straight past their own score screen.
- **Pausing lets go of the web.** A thread held across a pause would still be
  held on the other side of it, and the resume tap would land you mid-swing
  with no memory of having aimed. So does backgrounding the app, and so does a
  pointer that leaves the window — a pointer that never reports `up` would
  otherwise leave the web stuck on and the run flying itself.
- **Multi-touch is one web.** A second finger down does not fire a second
  thread, and lifting one of two fingers does not let go; the web releases when
  the last pointer lifts. Otherwise a stray palm ends a good run.
- The collision circle is well under half the drawn figure, so a graze past a
  roof reads as skill rather than as a bug in the hit test.
