# Span — Interaction Guide

## Mental model
"Blueprint on a drafting table." The player thinks they are *drawing* a bridge:
drag a line between two points and it becomes a beam. Anchors (glowing rings)
say "start here"; the grid says "structure snaps, this is engineering, not
freehand". Test mode flips the mental model from drawing to *watching a
stress test* — color = strain, red = about to snap.

## Orientation
Landscape, always. Bridges are wide; the gap must get the long axis.
- Installed: manifest `orientation: landscape`.
- Portrait browser on touch: the whole app is CSS-rotated 90° (style.css) and
  pointer coords are mapped back in `pointerWorld()` / `screenPos()`. Any new
  clientX/clientY use on the canvas MUST go through that mapping.

## Inputs (touch first)
- **Drag node → point** = lay a beam of the selected material. The preview is
  live: dashed line, endpoint ring, cost bubble ($) at the midpoint.
- **The drag is clamped, never rejected**: the preview stops growing at the
  material's max length (`snapDragPoint`). The user physically feels the limit;
  they are never told "too long" after the fact.
- **Tap a beam** = delete it. **Erase tool** = delete by touch/drag sweep.
- **Material palette** (Road/Wood/Steel/Cable buttons, cost per meter shown).
- **Test / Stop** = run / abort the simulation. Space on keyboard.
- Keyboard: 1–4 materials, E erase, R reset, Esc menu.
- Hit radii are px-based (`snapRadius()` ≈ 26px, `eraseRadius()` ≈ 20px)
  converted to world units, so fingers work at any zoom.

## Discoverability
- Level 1 is the tutorial: gap of 2, one obvious drag, intro line literally
  says "Drag from one anchor to the other to lay road."
- Each level's intro line teaches exactly one idea (triangles, steel strength,
  cables pull only...). Never more than one sentence.
- Pulsing anchor rings mark where building starts; the grid invites snapping.
- Budget chip turns red when overspent and Test disables — over-building is
  allowed (explore freely), testing an unaffordable bridge is not.
- Failure teaches: break sparks show *where* it failed; the fail copy
  distinguishes "members broke" / "vehicle fell" / "road not connected".

## Intentional behaviors
- Building while over budget is allowed on purpose (sandbox freedom); the
  gate is the Test button, not the drawing.
- A drag shorter than 0.4 world units is treated as a tap (delete), so there is
  no accidental confetti of tiny beams.
