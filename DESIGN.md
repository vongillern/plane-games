# Airplane Mode — Design Language

A collection of beautiful, fully-offline games. Every pixel should feel intentional.
Imagine Steve Jobs reviewing it: if a detail doesn't earn its place, remove it.

## Principles

1. **The game IS the interface.** No chrome, no menus unless essential. One tap to play.
2. **Offline is sacred.** Zero external requests, ever. Every asset is local and precached.
3. **Motion sells quality.** Animate only `transform` and `opacity`. 60fps or don't animate.
4. **Respect the device.** Safe-area insets, no zoom, no scroll-bounce, no text selection
   on game surfaces, works portrait-first but never breaks in landscape.

## Visual tokens

```css
:root {
  --bg: #0a0a0f;            /* near-black, slightly blue */
  --surface: #16161f;
  --surface-2: #1e1e2a;
  --text: #f5f5f7;          /* Apple-white */
  --text-dim: rgba(245,245,247,.55);
  --border: rgba(255,255,255,.08);
  --radius: 20px;
  --radius-sm: 12px;
  --ease-spring: cubic-bezier(.22,1.2,.36,1);
  --ease-out: cubic-bezier(.16,1,.3,1);
}
```

- **Font**: system stack only — `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. Numerals: `font-variant-numeric: tabular-nums`.
- **Per-game accent** (used for theme_color, glows, key surfaces):
  - Hub: `#7c5cff` (violet)
  - 2048: `#f5a623` (warm amber/gold)
  - Drop: `#22d3ee` (electric cyan) on violet-tinted depth fog
  - Snake: `#34d399` (emerald)
  - Glide: `#fb7185` (coral/rose)
  - Span: `#3b82f6` (bridge blue)
  - Runway: `#d946ef` (fuchsia)
  - Hop: `#84cc16` (lime)
  - Nova: `#38bdf8` (electric sky blue)
  - Breaker: `#f97316` (vivid orange)
  - Carve: `#2dd4bf` (glacier teal) on sunlit alpine blues
  - Sink: `#ef4444` (ember red) — the rim light on an otherwise black opening
- Big type, heavy weights (700–800), tight letter-spacing (-0.02em) for titles.
- Cards/surfaces: `--radius` corners, 1px `--border`, subtle top-light gradient.
- Glow sparingly: `box-shadow: 0 0 40px -8px <accent at ~35%>` on the hero element only.

## Interaction

- Touch first: swipe/tap/drag with `touch-action: none` on the game surface,
  pointer events (not touch events) so mouse works too.
- Keyboard as a first-class citizen (arrows/WASD, space, R to restart).
- Haptics where supported: `navigator.vibrate?.(10)` on meaningful events only.
- Instant restart. Death/game-over screens appear in <300ms and one tap restarts.

## Touch affordances (every app)

1. **Clamp, don't reject.** If an action has a limit (max length, board edge,
   budget), stop the gesture at the limit live — never let the user complete an
   invalid gesture and then tell them no.
2. **Every registered input answers back.** When a legal gesture can't act
   (blocked 2048 move, reversal swipe in Snake), respond with motion or haptic —
   silence reads as "broken" on touch.
3. **Finger-sized targets.** Buttons ≥ 44px. Canvas hit-testing converts a
   px radius (~26px) to world units — never a fixed world radius that shrinks
   with zoom.
4. **Primary verbs get the whole screen.** Tap-to-start/restart accepts a tap
   anywhere, not just on the button. Overlay backdrop taps do the primary action.
5. **Hints match the device.** `.if-touch` / `.if-key` spans, switched purely in
   CSS via hover/pointer media queries.
6. **Orientation serves the content.** Portrait by default; a wide game (Span)
   declares landscape in its manifest AND CSS-rotates in portrait browsers with
   pointer coords mapped back (see `games/span/`).
7. **Every app documents its interaction model** in `INTERACTIONS.md` beside its
   code: the player's mental model, each input, and how it's discovered. Read it
   before touching input code; update it when interactions change.

## Pause (every real-time game)

A phone interrupts you constantly, and "die or close the tab" is not an exit.
Every game with a running clock ships the same pause: `pause.js`, copied
unchanged into each game directory (each app stays independently installable,
so a shared parent file would break `scope: "."`).

- One call at boot: `installPause({ canPause, onPause, top, right })`. The
  module owns the button, the card, the keys (`Esc` / `P`) and auto-pause on
  background; `canPause()` decides when there is anything to freeze, so the
  button never appears on a start or game-over screen.
- **The module never owns the clock.** Each game asks `pause.active` at the top
  of its own loop and returns before its update, resetting its own `last`/
  `lastTs` so no time debt is banked. Skipping the draw leaves the last frame
  on screen under the card, which is exactly what a paused game should look
  like.
- The card borrows the game's `--accent`, so it belongs to the game it covers.
- Placement is per-game (`top` / `right`): the button gets out of the way of
  whatever HUD a game already has, but stays in the same corner everywhere.
- 2048 is the one game without it — nothing is running to freeze.

## Updates (every app)

Offline-first cuts both ways: the worker serves the cached copy first, so a
shipped fix can sit on the server for days without a player ever seeing it.
`update.js` — copied unchanged into every app directory, same reason as
`pause.js` — makes that loop visible and puts it in the player's hands.

- **One app owns updates per session — the one you launched.** Every directory
  is installable on its own, but the hub is installable too, and then the games
  are pages inside it. Both were true at once, so opening a game from the hub
  also registered the game's worker: one collection behaved like twelve apps,
  each announcing its own update on top of the hub's. The first page of a
  session claims it (`sessionStorage`, key `am.shell` — per tab, per installed
  window, and it survives navigation) and anything *underneath* that claim goes
  quiet: no worker of its own, no control. Launch the hub and the hub alone
  speaks for the collection; launch a game from its own icon and it owns itself
  exactly as before.
- A quiet page also **stands down a worker it registered under an older build**,
  and drops that worker's caches — nothing else would ever prune them. It only
  does so once the shell's own worker is registered, so it can never strand the
  page offline.
- It **registers the service worker** (apps no longer do it inline) and checks
  for a new one on launch.
- One control, bottom-centre, in the app's own accent: "Check for updates"
  normally; it promotes itself to "Update ready · Reload" when a new worker
  has installed. Tapping it reloads. Forcing a check reports the answer —
  including the running cache version — rather than doing nothing visible.
- It **never reloads on its own**, and it hides while a game is in play
  (`canShow`). A game in progress is not worth a silent refresh.
- A reload must never cost a game. The action games are safe because the
  control hides during play; a turn-based one has no such moment, so **2048
  saves its position** (`am.2048.save`: board, score, whether 2048 has been
  passed) after every move that settles and restores it at boot. A finished
  game clears the save — the next launch is a new game, not a dead board.
- `mount` puts the control in the page flow instead of floating — the hub
  scrolls, so a fixed pill would sit on a card forever.
- "Is this an update?" means *our* worker was already in charge, compared by
  script URL. The hub's worker has the widest scope, so opening a game from
  the hub's cache means the hub is controlling the page while the game's own
  worker installs underneath it — a first install, not an update.
- Each `sw.js` answers a `'version'` message with its `CACHE` name, which is
  what the control reports. Bumping that string per release (below) is what
  makes an update detectable at all.

## PWA checklist (every app: hub and each game)

Each directory is a fully independent, installable PWA:

- `manifest.webmanifest`: `name`, `short_name`, `start_url: "."`, `scope: "."`,
  `display: "standalone"`, `orientation: "portrait"` (games), `theme_color` = accent-tinted
  dark, `background_color: "#0a0a0f"`, icons: `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` (`purpose: "maskable"`).
- `sw.js`: versioned cache name (`am-<app>-v1`), precache **every** file the app uses on
  install, cache-first fetch handler, delete old caches on activate. Bump version string
  on any asset change. Prune **only your own generations** (`k.startsWith('am-<app>-')`) —
  a bare `k !== CACHE` sweeps away the hub's cache and every sibling's along with it.
- Register with a **relative** path: `navigator.serviceWorker.register('./sw.js')`.
- `<head>` must include: `viewport` with `viewport-fit=cover`, `theme-color` meta,
  `apple-touch-icon` link (192px), `apple-mobile-web-app-capable`, manifest link.
- **All URLs relative** (`./…`) — the site deploys under a GitHub Pages subpath.
- CSS must handle safe areas: `env(safe-area-inset-*)`.

## File conventions

- Vanilla JS (ES modules), vanilla CSS. No build step, no frameworks, no CDN.
- Per game: `index.html`, `style.css`, `game.js`, `sw.js`, `manifest.webmanifest`,
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`.
- Icons are generated by `tools/gen-icons.mjs` — don't hand-make them.
- State (best scores, settings) in `localStorage`, key prefix `am.<game>.`.

## Quality bar

- Lighthouse PWA installable, no console errors, first load < 1s on 3G-class hardware
  (except Drop's three.js, which is still local).
- Feels native: no 300ms tap delay, no rubber-banding, no flash of unstyled content
  (inline critical background color on `<html>`).
