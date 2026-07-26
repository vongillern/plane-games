# Glide — Interaction Guide

## Mental model
"Every tap is a wing-beat." One verb only: tap = lift, gravity does the rest.
The player thinks in rhythm — tap-tap-pause — threading the paper plane
through gaps. Zero UI to think about mid-flight.

## Inputs (touch first)
- **Tap anywhere on screen** → flap. Also starts the game from the title and
  restarts from game over. The entire viewport is the button.
- Keyboard: Space / ↑ / Enter flap; R restarts when over.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Discoverability
- Start overlay: "tap to stay aloft" — the flappy convention finishes the
  lesson; the first tap IS the tutorial.
- The forgiving hitbox (~70% of the sprite) quietly makes near-misses feel
  like skill, which keeps trust in the controls.
- Game over: "Fly again" button (52px) plus "or tap anywhere".

## Intentional behaviors
- During the ~0.4s death tumble, taps are swallowed on purpose: a player
  mid-tap-rhythm would otherwise skip the score screen (and restart) by
  accident. The pause converts mash into intent.
