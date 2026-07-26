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

## Adding a game

Read `DESIGN.md`, add art + an entry to `tools/gen-icons.mjs`, create
`games/<name>/` following the PWA checklist, and add a card to the hub's
`index.html` (plus its icon in the hub `sw.js` precache list, and bump the
hub cache version).
