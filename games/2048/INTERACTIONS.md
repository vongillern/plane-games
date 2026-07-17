# 2048 — Interaction Guide

## Mental model
"Tilting a tray of tiles." A swipe tips the whole board; every tile slides as
far as it can and equal tiles crush together. The player thinks about *the
whole board at once*, not individual tiles — which is why input applies
globally and instantly.

## Inputs (touch first)
- **Swipe any direction on the board** → move all tiles (threshold 24px,
  dominant axis wins).
- **Swipe that can't move anything** → the board *bumps* in that direction
  (bump-\* animation). The input registered; the move is impossible. Never
  silent.
- **Swipe mid-animation** → queued (latest wins) and fast-forwarded the moment
  tiles land. Rapid play never drops input.
- **Overlay backdrop tap** → primary action (game over: new game; win: keep
  going). Buttons also present, 44px.
- Keyboard: arrows / WASD.

## Discoverability
- Persistent hint under the board: "Swipe to move. Merge tiles to reach 2048."
- 2048 is a cultural convention; the hint is a reminder, not a tutorial.
- Score chip "+N" float-up and merge pop teach the reward loop; haptic tick on
  merges.
- New Game is deliberately absent during play (no accidental resets); it only
  appears at game over.

## Intentional behaviors
- No undo — a design decision from an earlier session; keeps stakes honest.
- Sub-threshold swipes do nothing (24px is small enough that any intentional
  flick clears it).
