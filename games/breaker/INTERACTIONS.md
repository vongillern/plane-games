# Breaker — Interaction Guide

## Mental model
"The paddle is my finger." The whole screen is one big touchpad for the
paddle's X position: drag anywhere and the paddle is wherever your finger is,
horizontally — the finger never needs to sit on (or occlude) the paddle
itself. Everything else — ball, bricks, power-ups — plays out above it.

## Inputs (touch first)
- **Drag anywhere** → paddle follows the pointer's X absolutely, clamped at
  the walls (clamp, don't reject). Works in every in-round state, including
  while serving, so you can aim before launching.
- **Tap** (a press that moves < ~14px) while the ball is docked → launch.
  Dragging to position and lifting is *not* a launch; only a clean tap is.
- **Tap on the start screen** → start. **Tap after game over** → restart
  ("Break again" button, 52px, also present).
- Keyboard: ←/→ or A/D hold to move, Space to start/launch/restart, R to
  restart at any time.

## Discoverability
- Start overlay teaches the single verb: "drag anywhere to move the paddle."
- The docked-ball state shows a pulsing hint ("drag to aim · tap to launch")
  above the paddle, and the ball visibly pulses on the paddle — an invitation.
- Brick language teaches by appearance: armored bricks carry a white inner
  outline, then show cracks after the first hit; metal bricks are riveted
  steel and visibly refuse to break (spark, no crack) — and never gate level
  completion.
- Power-up capsules glow in their own color with a literal icon (↔ wide,
  clock slow, three dots multi-ball, hammer smash, heart life); catching one
  flashes the paddle in that color. While hammer is active, armored (two-hit)
  bricks break in a single hit; metal bricks still refuse.

## Feedback
- Every brick answers back: white hit-flash, colored particle burst + pop
  scale-out on break, haptic-free (too frequent).
- Haptics only on meaningful beats: ball lost, power-up caught, level clear
  (`navigator.vibrate?.(10)`).
- Losing a ball shakes the world (not the HUD); losing the last life shows
  the game-over card in <300ms with tap-anywhere restart.

## Intentional behaviors
- Bounce angle is authored, not simulated: where the ball meets the paddle
  sets the exit angle (center = steep, edge = sharp), so aiming is a skill.
  Bounces are clamped so a perfectly horizontal rally can never happen.
- Losing an extra (multi-ball) ball costs nothing; only the last ball costs
  a life — generosity where it doesn't matter, tension where it does.
- The paddle band floats ~100 world units above the bottom edge: dedicated
  dead space where the dragging thumb rests without covering the paddle.
  The ball is only lost past the very bottom of the field, below that band —
  the gap is finger room, not extra danger.
- Portrait-only by intent (400×700 world, letterboxed elsewhere).
