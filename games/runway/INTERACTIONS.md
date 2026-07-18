# Runway — Interaction Guide

## Mental model
"I'm the runner." The player identifies with their chosen runner (rolling
suitcase, UFO, prop plane, or rocket — picked on the start screen, remembered
across visits) and thinks in lanes: *left / middle / right*, plus two evasive
verbs, *jump* and *slide*. They never think about the camera or speed — those
are the game's job. Obstacles are read two ways at a distance: by silhouette
(low box = jump it, barrier with a gap under the bar = slide it, huge tanker =
change lanes) and by a fog-proof glow on the ground under each one, color-coded
by the verb that beats it: gold = jump, magenta = slide, red = change lanes.

## Inputs (touch first)
- **Swipe left / right** → change lane (one lane per swipe, clamped at edges).
- **Swipe up** → jump. **Swipe down** → slide. Swipe down mid-jump slams to the
  ground and into a slide.
- **Tap during a run** → deliberately nothing (prevents accidental deaths); the
  swipe threshold is 24px.
- **Tap anywhere** on start/game-over overlays → start / restart.
- Keyboard: ←→↑↓ / WASD; Space, Enter or R to start/restart.

## Discoverability
- Start overlay: "swipe to dodge · jump · slide" (touch) / arrow-key variant.
- The rest is taught by the obstacle course itself: the opening ~12s always
  leaves one lane free, first obstacles arrive slowly, and near-misses give a
  haptic tick + score bonus, teaching "close is rewarded, contact kills."
- Buffered actions (a queued jump/slide within 0.25s) make inputs feel honored
  rather than dropped when mid-animation.

## Sizing rules (the point of this game's tuning)
- The camera sits low and close (CAM_UP 3.2, CAM_BACK 5.5, FOV 68) so the
  player fills the lower third of a portrait phone — Subway-Surfers framing.
- Coins are 0.42-radius, obstacles scaled 1.22–1.35 (visual only; collision is
  lane + action based, so scaling geometry is always safe).
- Pickup radii are forgiving (0.75 world units) — grazing a coin collects it.
  Err generous on rewards, exact on hazards.

## Intentional silences
- Sub-threshold swipes and mid-run taps do nothing by design; every *legal*
  gesture has an immediate, visible response (bank animation on lane change).
