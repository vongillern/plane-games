# Snake — Interaction Guide

## Mental model
"I steer the head; the body is my history." The player flicks the direction
the head should turn next, thinking one or two moves ahead. Food is the goal;
their own tail is the hazard they created.

## Inputs (touch first)
- **Swipe on the board** → turn the head (threshold 20px, dominant axis).
- **Turns queue two deep**, so a fast "up then left" flick sequence is honored
  exactly; a third rapid input replaces nothing (cap keeps intent readable).
- **Tap on Ready** → start. **Swipe on Ready** → start AND apply that first
  turn (one gesture does both — no wasted input).
- **Tap on Dead** → restart.
- Keyboard: arrows / WASD, Space/Enter/R for start/restart.

## Discoverability
- Start overlay: "swipe to steer" + pulsing "tap to start".
- Persistent bottom hint: "Swipe on the board to steer."
- Death is always legible: the collision happens where the player is looking
  (the head), so no explanation is needed.

## Intentional behaviors
- A 180° reversal swipe is ignored (you can't run into your own neck) — this
  is genre law; feedback would punish the player's rhythm more than silence.
- Taps during play do nothing (no pause-by-accident).
