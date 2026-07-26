# Nova — Interaction Guide

## Mental model
"Fly the ship; the guns handle themselves." The player owns the ship's
*position* — x freely, y within the bottom third of the playfield — while
lasers autofire on a steady cadence, so every ounce of attention goes into
dodging enemy fire and lining up under the formation. Touch maps this to
*the ship rides just above your finger*; buttons exist for players who
prefer discrete steering.

## Inputs (touch first)
- **Drag anywhere on the playfield** → the ship chases a point ~90 world
  units ABOVE the finger, on both axes, with a fast ease (never teleports —
  always feels piloted). The lift offset means the finger never occludes the
  ship. Lift the finger to hold position.
- **Vertical clamp, live**: the ship flies only in the bottom-third band
  (y ≈ 467–616 of 700). Dragging higher pins the ship smoothly at the top of
  the band — the gesture is clamped mid-flight, never rejected.
- **Hold ◀ / ▶ buttons** (58px, bottom corners, semi-transparent, only on
  touch devices, only visible during play) → constant-speed horizontal
  steering. Buttons are deliberately horizontal-only — drag is the 2D
  instrument. They capture their pointer, so a thumb sliding off mid-hold
  still releases cleanly.
- **Tap on Ready** → start. **Tap on Ship-lost** → restart ("Fly again"
  button also present; the whole screen is the target).
- Keyboard: ←/→ or A/D fly horizontally, ↑/↓ or W/S fly vertically (same
  clamp band), Space/Enter start, Space/R restart after game over. Space
  during play is simply satisfied — lasers already fire.
- Firing is **automatic** by design: no fire button on touch means no
  claw-grip, and the two input schemes stay perfectly symmetric.
- **Pause** → the round button near the top-right, or `Esc` / `P`. Tap the
  card anywhere to resume; backgrounding the app pauses too. Shared
  behaviour — see `pause.js` and "Pause" in `DESIGN.md`.
- **Check for updates** → the pill at the bottom. It says *Update ready ·
  Reload* on launch when a new build is waiting; tapping reloads into it.
  It appears only when this game is the app you launched: opened from the
  hub, the hub does the updating for everything and this pill stays away.
  Shared behaviour — see `update.js` and "Updates" in `DESIGN.md`.

## Discoverability
- Start overlay: "drag or use ◀ ▶ to fly · lasers fire themselves" — the
  full control surface in one line — plus the animated ship preview with its
  flickering engine flame establishing the hero.
- Power-ups teach by shape + glyph: Ⅱ bars = double shot, Ⅲ bars = triple,
  shield outline, heart = life. Collecting one answers instantly with a
  colored particle ring and a haptic tick.
- "LEVEL n" banner marks every wave; the HUD level chip (top-center) keeps
  the count while the banner is gone.
- Hits answer back hard: screen shake + haptic + heart dimming, then a
  blinking ship telegraphs the mercy-invincibility window.

## Touch specifics
- The ship's hit radius (14u ≈ finger-safe) is smaller than its art —
  near-misses feel skillful, not cheap.
- The lift offset (~90u) keeps the ship visible above the thumb at all
  times; ◀ ▶ buttons remain the zero-occlusion alternative.
- Buttons and drag never fight: while a button is held it owns x; y still
  follows the finger. Release returns full control to the finger.
- Clamping, not rejection: the ship stops live at the playfield edges and at
  the top of its flight band.

## Intentional behaviors
- Power-ups fall and can be missed — chasing them into enemy fire is the
  game's core risk/reward.
- Enemies crossing the invasion line (near the bottom of the playfield) cost
  a life even without touching the ship: the formation's slow descent is a
  real clock. Flying high to meet the formation is faster kills at real risk
  — ramming an enemy costs a life too.
- Weapon upgrades survive being hit (losing a life is punishment enough);
  only the shield is consumed.
