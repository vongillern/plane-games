# Hop — Interaction Guide

## Mental model
"The jelly chases my finger." The jelly bounces on its own; the player owns
only its horizontal position. Touch is direct: hold anywhere and the jelly
steers toward the finger's x and settles under it (an arrival curve — desired
velocity proportional to the offset — so it never oscillates around the
finger). Keyboard is the classic lean: hold a direction to drift.

(Earlier build used "hold a side of the screen to drift that way"; players
read that as *inverted* whenever the jelly was already past their finger and
kept flying away from it. Finger-follow removed that failure mode.)

## Inputs (touch first)
- **Hold / drag anywhere** → the jelly steers toward the finger's x; release →
  steering stops (momentum decays via air friction). Position maps 1:1 across
  the canvas width, so precision is direct, not rate-based.
- **Tap on Ready** → start (the tap's x immediately becomes the first steering
  target — input is never wasted; releasing clears it).
- **Tap on Dead** → restart. "Bounce again" button (52px) also present.
- Keyboard: ←/→ or A/D hold (constant-acceleration lean), Space/Enter/R.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Discoverability
- Start overlay: "drag — the jelly follows your finger" — the exact verb for
  the model — plus the animated jelly preview establishing the character.
- Platform types teach by appearance-then-consequence: cracked = crumbles
  after one bounce, cloud = fades in/out; both telegraph *before* betraying.
- No zones or midline to learn: wherever the finger is, that's where the jelly
  goes. A resting thumb near the bottom corner steers just as well as a finger
  tracking mid-screen.

## Intentional behaviors
- Landing on a crumble/cloud platform then falling through is the genre's
  risk/reward, always telegraphed visually first.
- Portrait-only by intent (physics normalized to width); landscape isn't
  blocked but is not the designed experience.
