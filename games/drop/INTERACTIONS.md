# Drop — Interaction Guide

## Mental model
"I spin the tower, not the ball." The ball bounces on its own; the player's
one job is rotating the helix so the ball falls through gaps and misses the
red slots. Their finger is *physically coupled* to the tower's rotation —
drag = rotate, flick = spin with momentum.

## Inputs (touch first)
- **Horizontal drag anywhere** → rotate the tower (0.009 rad/px; a full-screen
  swipe ≈ half a turn). Rotation is continuous and unbounded — nothing to
  clamp, nothing to reject.
- **Flick** → momentum carry with decay, reinforcing the "heavy physical
  tower" model.
- **Tap** (movement < 9px) → start / restart on overlays; nothing mid-run.
- Keyboard: ←/→ or A/D hold-to-rotate, Space/Enter/R start/restart.

## Discoverability
- Start overlay: "drag to rotate the tower" + "tap to start".
- The coupling is self-teaching: any touch immediately moves the tower 1:1,
  which is the strongest affordance possible.
- Red = danger is learned in one death; depth fog and slot colors are read at
  a glance thereafter.

## Intentional behaviors
- Landing on a red slot kills instantly — the genre's stakes; the red is
  visible well before the ball arrives, so it's fair.
- Taps during play do nothing (the only verbs are rotate and wait).
