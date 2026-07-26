# Hub — Interaction Guide

Per-app guides live in `games/<name>/INTERACTIONS.md`. Shared rules in `DESIGN.md`
("Touch affordances"). This file covers the hub itself.

## Mental model
"A shelf of games." The user is choosing, not playing: one scrolling column of
cards, each card is one game, tapping it opens the game full-screen.

## Inputs
- **Tap a card** → open that game. The entire card is the link (not just the
  title), with a chevron affordance signalling "this goes somewhere".
- **Scroll** → the only other gesture; the page is a plain vertical scroll.
- **Add to Home Screen** → explicit button when installable; on iOS it opens a
  share-sheet walkthrough tip instead (no beforeinstallprompt there).
- **Check for updates** → the pill in the footer. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  Launched from the hub, this one control covers every game inside it — the
  games themselves stay quiet.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.
  **The hub is the one app that `mount`s this control inline** (in the footer)
  rather than floating it: the hub scrolls, so a fixed pill would sit on top of
  a card forever. That also exempts it from the 600px-height rule the games
  follow — an inline control competes with nothing.

## Discoverability
- Nothing to learn: cards look like buttons (surface, border, hover/active
  states) and name the game plus a one-line description of its verb.
- "Works fully offline" line sets the expectation that flights/airplane mode
  are fine — the core promise of the collection.
- Each game repeats its own controls on its start screen, so the hub never
  needs to teach gameplay.

## Touch specifics
- Cards are full-width, ~70px tall — far beyond minimum target size.
- No gestures with thresholds, nothing to clamp; the hub must never intercept
  scroll (no `touch-action: none` here).
