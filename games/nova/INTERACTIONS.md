# Nova — Interaction Guide

## Mental model
"Fly the ship; the guns handle themselves." The only verb the player owns is
*horizontal position* — lasers autofire on a steady cadence, so every ounce of
attention goes into dodging enemy fire and lining up under the formation.
Touch maps this to *the ship follows your finger*; buttons exist for players
who prefer discrete steering.

## Inputs (touch first)
- **Drag anywhere on the playfield** → the ship chases the finger's x with a
  fast ease (never teleports — always feels piloted). Lift to hold position.
- **Hold ◀ / ▶ buttons** (58px, bottom corners, semi-transparent, only on
  touch devices, only visible during play) → constant-speed steering. Buttons
  capture their pointer, so a thumb sliding off mid-hold still releases
  cleanly.
- **Tap on Ready** → start. **Tap on Ship-lost** → restart ("Fly again"
  button also present; the whole screen is the target).
- Keyboard: ←/→ or A/D hold to fly, Space/Enter start, Space/R restart after
  game over. Space during play is simply satisfied — lasers already fire.
- Firing is **automatic** by design: no fire button on touch means no
  claw-grip, and the two input schemes stay perfectly symmetric.

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
- Drag is offset-free by intent: the ship goes *under* the finger. The ship
  sits low and the finger typically rests below the playfield edge, so
  occlusion is minimal; ◀ ▶ buttons are the zero-occlusion alternative.
- Buttons and drag never fight: while a button is held it wins; release
  returns control to the finger on the canvas.
- Clamping, not rejection: the ship stops live at the playfield edges.

## Intentional behaviors
- Power-ups fall and can be missed — chasing them into enemy fire is the
  game's core risk/reward.
- Enemies crossing the invasion line (just above the ship) cost a life even
  without touching the ship: the formation's slow descent is a real clock.
- Weapon upgrades survive being hit (losing a life is punishment enough);
  only the shield is consumed.
