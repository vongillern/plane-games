# Runway — Interaction Guide

## Mental model
"I'm the runner." The player identifies with their chosen runner (rolling
suitcase, Clawd the crab, an Optimus-style robot, or a Tron-style program —
picked on the start screen, remembered across visits; every runner fits within
2/3 of a lane) and thinks in lanes: *left / middle / right*, plus two evasive
verbs, *jump* and *slide*. They never think about the camera or speed — those
are the game's job. Obstacles are read two ways at a distance: by silhouette
(low box = jump it, glowing bar = slide it, tanker = change lanes, long tram =
dodge or ride it) and by a fog-proof glow on the ground under each one,
color-coded by the verb that beats it: gold = jump, magenta = slide, red =
change lanes / oncoming, cyan = ride the ramp up. Trams add a second story:
run up a ramp tram and you're on the roofs — jump between them, collect the
coin trail, and drop back down when they run out. See MECHANICS.md for the
full Subway-Surfers mechanics map.

## Inputs (touch first)
- **Swipe left / right** → change lane (one lane per swipe, clamped at edges).
- **Swipe up** → jump. **Swipe down** → slide. Swipe down mid-jump slams to the
  ground and into a slide.
- **Tap during a run** → deliberately nothing (prevents accidental deaths); the
  swipe threshold is 24px.
- **Tap anywhere** on start/game-over overlays → start / restart.
- Keyboard: ←→↑↓ / WASD; Space, Enter or R to start/restart.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

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
