# Hop — Interaction Guide

## Mental model
"Lean left or right." The jelly bounces on its own; the player only supplies
horizontal drift, like tilting an invisible board. Touch maps this to *holding
a side of the screen* — the closest a flat screen gets to leaning.

## Inputs (touch first)
- **Hold the left / right half of the screen** → drift that way; release →
  stop steering. Sliding the finger across the midline switches direction
  live, so a held thumb can steer continuously.
- **Tap on Ready** → start (the tap's side also applies as an initial lean —
  input is never wasted; releasing clears it immediately).
- **Tap on Dead** → restart. "Bounce again" button (52px) also present.
- Keyboard: ←/→ or A/D hold, Space/Enter/R.

## Discoverability
- Start overlay: "hold a side to steer" — the exact verb for the model — plus
  the animated jelly preview establishing the character.
- Platform types teach by appearance-then-consequence: cracked = crumbles
  after one bounce, cloud = fades in/out; both telegraph *before* betraying.
- The screen midline is invisible by design: halves are ~half the screen wide,
  so precision is never needed — anywhere-left vs anywhere-right.

## Intentional behaviors
- Landing on a crumble/cloud platform then falling through is the genre's
  risk/reward, always telegraphed visually first.
- Portrait-only by intent (physics normalized to width); landscape isn't
  blocked but is not the designed experience.
