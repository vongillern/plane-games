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
- ✅ **Stumble on grazing an obstacle** — clipping a corner mid-lane-change
  isn't fatal, but it summons the guard; a clean pass at slightly wider
  clearance is still a rewarded near-miss.
- ✅ **Guard + dog chase** — after a stumble the guard (dog in tow) runs
  behind you for 8 seconds; stumble or slip again while he's there and he
  catches you.

## Pickups / powerups
- ✅ **Coins** — now spinning gold disks; lines on the ground, arcs over
  ramps, trails along train roofs, sky trails during jetpack flight.
- ✅ **Coin magnet** — 6s vacuum with an on-player ring + HUD pip.
- ✅ **Jetpack** — 5.5s of flight above everything, with high coin trails to
  hoover up; visible thruster flames, soft landing with a grace window.
- ✅ **Super sneakers** — 8s of 2.7-unit jumps: sail over tankers and leap
  straight onto train roofs from the ground.
- ✅ **2x multiplier** — 15s score booster; stacks with the daily-mission
  multiplier and shows as a badge next to the score.
- ✅ **Hoverboard** — 20s shield under your feet; a crash smashes the board
  instead of you, sweeps the hazard, and grants a moment of invulnerability.
- ✅ **Mystery boxes** — random reward: coins, any powerup, or (rarely) a key.
- ✅ **Keys + revive** — keys persist between runs; spend one on the game-over
  screen to resume the run where you died.
- ✅ **Daily missions** — 3 date-seeded missions per day; each one completed
  adds +1 to the base score multiplier for the rest of the day.

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
- ✅ **Daily missions** — see Pickups section; shown on the start screen with
  live progress.
- ❌ **Character/board shop, currencies, seasonal events** — deliberately
  out of scope: everything in Runway is unlocked from the start, and an
  offline mini-game has no economy to sell into.
