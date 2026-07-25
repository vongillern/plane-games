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
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

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

## Progression (levels, challenges, rewards)
- **Levels**: every 12 rings. A slim `3 ▸▸▸░░ 4` bar under the score shows
  progress; difficulty (gap width, red density, second gaps) scales with
  level, and each level opens with two danger-free breather rings. First
  time reaching a level pays +1★.
- **Challenges**: 3 active at a time, visible on the start and game-over
  screens with progress bars. Completing one mid-run fires a toast and pays
  stars; the next challenge in the queue takes its place.
- **Stars → balls**: stars unlock ball skins (Soccer 3★, Basketball 6★,
  Prism 10★, Dragon Orb 15★). Picker on both overlays; locked balls show
  their cost, tapping one says how many more stars are needed. All balls
  bounce identically — cosmetics only, no pay-to-win-by-grinding.
- **Power-ups**: glowing tokens float in one specific slot of a gap every
  ~8–14 rings; you collect by *falling through that side of the gap* —
  aim is the skill. Color + shape + a named toast teach the mapping:
  - **Shield** (green torus): blocks one red slot, smashing it.
    Bubble + HUD chip while held.
  - **Slow-mo** (blue octahedron): 6s slower physics; blue vignette +
    draining chip.
  - **Blaze** (orange tetra): instant fever — smash the next platform.
- Mid-run HUD stays minimal: score, level bar, best/★ chips, and chips
  only for *currently held* power-ups. Everything persists in
  localStorage (`am.drop.save`), fully offline.
