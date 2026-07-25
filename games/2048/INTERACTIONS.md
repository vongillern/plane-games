# 2048 — Interaction Guide

## Mental model
"Tilting a tray of tiles." A swipe tips the whole board; every tile slides as
far as it can and equal tiles crush together. The player thinks about *the
whole board at once*, not individual tiles — which is why input applies
globally and instantly.

## Inputs (touch first)
- **Swipe any direction on the board** → move all tiles (threshold 24px,
  dominant axis wins).
- **Swipe that can't move anything** → the tray *tips harder* the way you
  pushed and springs flat (`bumpBoard`). The input registered; the move is
  impossible. Never silent.
- **Swipe mid-animation** → queued (latest wins) and fast-forwarded the moment
  tiles land. Rapid play never drops input, and the queued move plays at
  `RUSH` speed (≈half), so staying ahead of the board feels snappy, not laggy.
- **Overlay backdrop tap** → primary action (game over: new game; win: keep
  going). Buttons also present, 44px.
- Keyboard: arrows / WASD.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Motion model
All tile motion is choreographed in JS (Web Animations API) from the single
`MOTION` table at the top of `game.js` — no CSS transitions. Every duration
passes through a per-move scaler, so a rushed move or a reduced-motion device
compresses the whole timeline coherently.

- **The tray tips** 2.4° toward the swipe on every legal move: the mental model
  made literal, and the reason a move reads as *one* event rather than sixteen.
- **Distance costs time.** A one-cell slide takes ~195ms, a three-cell slide
  ~305ms. Tiles nearest the wall they are heading for leave first (18ms per
  lane step), so a full row unspools as a wave. Delaying the *rear* tiles is
  also what guarantees a follower never overtakes the tile it is chasing.
- **Squash and stretch.** A tile leans into its travel and compresses against
  whatever stopped it, proportional to how far it came. Position lives on
  `.tile`, every scale on `.tile-face`, so the two never fight over one
  transform.
- **Merges resolve on impact**, each on its own clock rather than a shared
  "everything is done now" timer: the surviving tile pops and flashes white the
  instant the incoming tile arrives, and the incoming tile sinks *under* it.
- **Celebration scales with the number.** Every merge gets a pop, a flash and a
  shockwave ring; 128+ adds sparks; 1024+ lights the whole board. Haptics
  follow the same three tiers.
- **The score climbs** instead of snapping, and a "+N" rises off the tile that
  earned it — the reward is attached to the thing that caused it.
- **The new tile waits a beat** (130ms), then materialises with an
  inward-collapsing ring. It joins the model the moment the board lands, so a
  queued move never races a tile that isn't on the board yet.
- Bursts are clipped to the tray; only the "+N" labels may leave it.
- `prefers-reduced-motion` collapses every duration to ~0 and skips all bursts;
  the game stays fully playable.

## Discoverability
- Persistent hint under the board: "Swipe to move. Merge tiles to reach 2048."
- 2048 is a cultural convention; the hint is a reminder, not a tutorial.
- The "+N" float, the merge pop and the climbing score chip teach the reward
  loop; haptic tick on merges.
- New Game is deliberately absent during play (no accidental resets); it only
  appears at game over.

## Intentional behaviors
- No undo — a design decision from an earlier session; keeps stakes honest.
- Sub-threshold swipes do nothing (24px is small enough that any intentional
  flick clears it).
- Win and game-over cards wait ~720ms so the merge that caused them is seen
  before anything covers the board.
