# Snake — Interaction Guide

## Mental model
"I steer the head; the body is my history." The player flicks the direction
the head should turn next, thinking one or two moves ahead. Food is the goal;
their own tail is the hazard they created.

## Inputs (touch first)
- **Swipe on the board** → turn the head (threshold 20px, dominant axis). The
  turn lands **as the threshold is crossed**, not on release: the snake is
  moving throughout the gesture, so waiting for the finger to lift cost a cell
  or two on every turn. The gesture then re-arms from that point, so one
  continuous drag can trace several turns in sequence.
- **Turns queue two deep**, so a fast "up then left" flick sequence is honored
  exactly; a third rapid input replaces nothing (cap keeps intent readable).
- **Tap on Ready** → start. **Swipe on Ready** → start AND apply that first
  turn (one gesture does both — no wasted input).
- **Tap on Dead** → restart. **Tap anywhere off the board** on Ready or Dead
  → start / restart; the board is a square on a tall screen, and the primary
  verb gets the whole of it.
- Keyboard: arrows / WASD, Space/Enter/R for start/restart.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Discoverability
- Start overlay: "swipe to steer" + pulsing "tap to start".
- Persistent bottom hint: "Swipe on the board to steer."
- Death is always legible: the collision happens where the player is looking
  (the head), so no explanation is needed.

## Intentional behaviors
- A 180° reversal swipe is ignored (you can't run into your own neck) — this
  is genre law; feedback would punish the player's rhythm more than silence.
- Taps during play do nothing (no pause-by-accident).
