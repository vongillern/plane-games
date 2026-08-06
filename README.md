# ✈️ Airplane Mode

A collection of beautiful games that work **entirely offline** — built for flights,
subways, and dead zones. Pure static files: no build step, no frameworks, no network.

## Games

| Game | What it is | Play |
|---|---|---|
| **2048** | Slide, merge, chase the golden tile | `games/2048/` |
| **Drop** | Helix-jump-style 3D descent (Three.js) | `games/drop/` |
| **Snake** | Silky-smooth modern snake | `games/snake/` |
| **Glide** | One-tap paper-plane night flight | `games/glide/` |
| **Carve** | Endless 3D snowboard carving (Three.js) | `games/carve/` |
| **Span** | Build a bridge, then hold the load | `games/span/` |
| **Runway** | Three lanes, full throttle (Three.js) | `games/runway/` |
| **Hop** | Bounce to the edge of space | `games/hop/` |
| **Nova** | Blast the swarm, rule the stars | `games/nova/` |
| **Breaker** | One ball, every brick | `games/breaker/` |
| **Sink** | Swallow the city before your rivals do (Three.js) | `games/sink/` |
| **Wake** | Three-lap jet-ski race against seven rivals (Three.js) | `games/wake/` |
| **Web** | Swing the city, beacon to beacon (Three.js) | `games/web/` |

The hub and **each game is its own installable PWA** — visit any of them and
"Add to Home Screen" to install just that game, or install the hub for all of them.
Once visited, everything works with the network fully off.

Whichever one you launched is the one that handles updates. Install the hub and
a single control in its footer covers the whole collection; the games opened
inside it stay quiet. Install a game on its own and it updates itself, exactly
as if the hub weren't there.

## Run locally

```sh
npx serve .        # or: python3 -m http.server
```

Service workers require a secure context: `localhost` works, `file://` does not.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.
3. Done. All paths are relative, so the `/plane-games/` subpath just works.

`.nojekyll` is included so Pages serves files verbatim.

## Structure

```
index.html            hub launcher (PWA)
games/2048/           2048 (self-contained PWA)
games/drop/           Drop (self-contained PWA, vendored Three.js)
tools/gen-icons.mjs   dependency-free icon generator (SDF → PNG)
DESIGN.md             the design language everything follows
```

## Checks

None of these are build steps: nothing on the site depends on them, they emit
nothing, and they have no dependencies except where noted.

```sh
node tools/check.mjs         # the invariants DESIGN.md promises, read from source
node tools/span-physics.mjs  # games/span/physics.js — are the levels still solvable?
node tools/carve-rules.mjs   # games/carve/rules.js — tricks, collisions, speed
node tools/wake-rules.mjs    # games/wake/rules.js — the course, laps, boost, water
node tools/web-rules.mjs     # games/web/rules.js — the raycast, the aim assist, the swing
node tools/smoke.mjs         # every app in a real browser, then with the network cut
```

`smoke.mjs` is the only one that needs anything installed, and deliberately not
in a `package.json`: `npm i --no-save --prefix tools playwright-core`, plus a
Chromium from `playwright install`. Run it locally, not in CI.

## Adding a game

Read `DESIGN.md` first. Then, in `games/<new>/`:

1. `index.html` — the full head boilerplate (viewport with `viewport-fit=cover`,
   `theme-color`, `color-scheme`, the Apple meta tags, `apple-touch-icon`,
   manifest link, inline `html{background:#0a0a0f}`), plus the `#install` /
   `#install-tip` / `#install-tip-close` markup.
2. `style.css` — the `:root` token block, `--accent`, the `.if-touch`/`.if-key`
   media queries, `env(safe-area-inset-*)` on all four sides.
3. `game.js` — import and call `installPause`, `installUpdates`, `installPrompt`.
4. `sw.js` — `CACHE = 'am-<new>-v1'`, an `ASSETS` array listing **every** file,
   and the canonical body (copy any existing game's — they are identical below
   `ASSETS`).
5. `manifest.webmanifest` — `scope: "."`, `start_url: "."`, three icons.
6. `update.js`, `install.js` and `pause.js` — copied **byte-identically** from
   the root. Turn-based games skip `pause.js`; there is nothing to freeze.
7. `INTERACTIONS.md` — required.

Then, outside the game directory — this is the part that bites:

8. **`sw.js` (hub)** — add to `GAMES`; add any file beyond the standard set to
   the `ASSETS` tail (a vendored library, an extra module); add to `NO_PAUSE`
   if turn-based; bump `am-hub-vN`.
9. **`index.html` (hub)** — a card, plus its `.card-<new>` accent rule in the
   hub's `style.css`.
10. **`tools/gen-icons.mjs`** — an art function and an `APPS` entry, then
    `node tools/gen-icons.mjs`.
11. **`DESIGN.md`** — the accent table row, matching `--accent` exactly.

Finally run `node tools/check.mjs`. It enforces every rule above that can be
checked mechanically, and exists because missing one of them fails silently:
forget `NO_PAUSE` for a turn-based game and the hub precaches a `pause.js`
that doesn't exist, `cache.addAll` rejects, and **the hub's service worker
never installs** — the whole collection loses offline support, and the only
symptom is that the hub quietly stops updating.
