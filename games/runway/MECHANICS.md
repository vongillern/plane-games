# Runway — Subway Surfers mechanics checklist

The full list of Subway Surfers mechanics, and how each one maps to Runway.
✅ replicated · 🟡 partial / adapted · ❌ not yet

## Core movement
- ✅ **3 lanes, swipe left/right** — identical (clamped at edges).
- ✅ **Swipe up to jump** — parabolic arc, 0.55s.
- ✅ **Swipe down to slide** — 0.6s squash; passes under gates.
- ✅ **Swipe down mid-air (slam)** — fast drop straight into a slide.
- ✅ **Input buffering** — jump/slide queued within 0.25s is honored.
- ✅ **Constantly accelerating run** — asymptotic ramp 14 → 30 u/s.

## Trains (the heart of SS)
- ✅ **Parked trains** — block a lane for ~22 units; dodge them, or land on the
  roof from above.
- ✅ **Train chains with roof gaps** — a ramp train sometimes has a second
  train behind it with a jumpable gap between the roofs.
- ✅ **Oncoming trains** — approach ~10 u/s faster than the world with blazing
  fog-proof headlights; the classic "get out of this lane NOW" moment.
- ✅ **Ramp trains** — sloped glowing nose; run straight into it and ride up
  onto the roof.
- ✅ **Running on train roofs** — a real second elevation (y = 1.5); ground
  obstacles pass harmlessly beneath you.
- ✅ **Jumping between train roofs** — jump from roof to roof; the landing
  logic snaps you onto the next support.
- ✅ **Falling off the end of a train** — gravity pulls you back to ground
  level when the roof runs out.
- ✅ **Hitting the side/face of a train = crash** — including jumping into the
  face of one too low.

## Obstacles
- ✅ **Jump barrier** (luggage cart) — gold ground glow.
- ✅ **Slide barrier** (gate: full-width glowing bar) — magenta ground glow.
- ✅ **Full blocker** (fuel tanker, one lane wide) — red ground glow.
- 🟡 **Stumble on grazing an obstacle** — Runway rewards a near-miss (score
  bonus + haptic) instead of a stumble; contact itself is fatal.
- ❌ **Guard + dog chase** — no chaser; a stumble mechanic would need one to
  matter.

## Pickups / powerups
- ✅ **Coins** — now spinning gold disks; lines on the ground, arcs over
  ramps, trails along train roofs.
- ✅ **Coin magnet** — 6s vacuum with an on-player ring + HUD pip.
- ❌ **Jetpack** — flies above everything collecting coin arcs.
- ❌ **Super sneakers** — jump-height boost.
- ❌ **2x multiplier / score boosters.**
- ❌ **Hoverboard** — one-crash shield.
- ❌ **Mystery boxes / keys / daily missions.**

## World & variation
- ✅ **Solvability guarantee** — every wave/train section leaves at least one
  survivable path; no tanker walls while a train blocks other lanes.
- ✅ **Difficulty ramp** — density, train frequency and double-train odds all
  scale over the first minute.
- 🟡 **Elevated route variation** — train roofs give a high road / low road
  choice; SS also has pillars and tunnels.
- ❌ **Turns** — Subway Surfers itself is a straight track (turns are Temple
  Run); not planned.

## Meta
- ✅ **Characters** — 4 selectable runners, persisted.
- ✅ **Best score persistence** — localStorage.
- ❌ **Character/board shop, currencies, missions, seasonal events.**
