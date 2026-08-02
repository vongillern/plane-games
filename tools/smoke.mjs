// smoke.mjs — drive every app in a real browser and check the things a static
// reader cannot see.
//
//   npm i --no-save --prefix tools playwright-core   # once, ad hoc
//   node tools/smoke.mjs
//
// Run this locally, not in CI. `playwright install` is a ~300MB download and
// service-worker activation timing is genuinely flaky on a shared runner —
// a red build nobody trusts is worse than no build.
//
// tools/check.mjs reads the source and proves the *shape* of things: that every
// referenced asset is precached, that no CACHE went un-bumped, that respondWith
// always gets a Response. It cannot prove that any of it actually works,
// because none of it is exercised until a browser installs a worker, fills a
// cache, and is then cut off from the network. That is what this file does.
//
// Nothing here needs a package.json, and there must never be one: "no build
// step, no dependencies, no CDN" is the whole identity of the project.
// playwright-core is resolved ad hoc below and lives in a gitignored
// tools/node_modules, exactly the way a scratch tool should.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Failure bookkeeping.
//
// A smoke run touches twelve apps; stopping at the first problem means twelve
// runs to find three bugs. Everything below records and carries on, and every
// record carries the app, the assertion, and the value that was actually seen.
// ---------------------------------------------------------------------------
const failures = [];
let assertions = 0;

function check(where, what, cond, got) {
  assertions++;
  if (!cond) failures.push({ where, what, got });
}

const show = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

// ---------------------------------------------------------------------------
// Ad-hoc playwright-core.
//
// A bare import resolves up from tools/, so tools/node_modules and a
// repo-root node_modules both work, and neither is committed.
// ---------------------------------------------------------------------------
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error(
    'smoke: playwright-core is not installed. This repo has no package.json by ' +
    'design — install it ad hoc:\n\n    npm i --no-save --prefix tools playwright-core\n'
  );
  process.exit(1);
}

// The browser binary is whatever `playwright install` already dropped in the
// shared cache; the version moves, so look for it rather than naming it.
function findChromium() {
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(cache)) return null;
  return fs.readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))            // not chromium_headless_shell-*
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((d) => path.join(cache, d, 'chrome-linux64', 'chrome'))
    .find((p) => fs.existsSync(p)) || null;
}

const executablePath = findChromium();
if (!executablePath) {
  console.error(
    'smoke: no Chromium found under ~/.cache/ms-playwright (looking for ' +
    'chromium-*/chrome-linux64/chrome).\n\n    npx playwright install chromium\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The site, served the way it is deployed: over HTTP from the repo root.
// A file:// origin has no service workers at all, so this is not optional.
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const stopServer = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stopServer);

// wait for it to actually answer before pointing a browser at it
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${BASE}/index.html`)).ok; } catch { await sleep(50); }
}
if (!up) {
  console.error(`smoke: python3 -m http.server never came up on ${BASE}`);
  stopServer();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The apps, discovered rather than listed: a new game must be covered the day
// it lands, without anyone remembering to edit this file.
// ---------------------------------------------------------------------------
const APPS = [
  { name: 'hub', dir: '', url: `${BASE}/` },
  ...fs.readdirSync(path.join(ROOT, 'games'))
    .filter((g) => fs.existsSync(path.join(ROOT, 'games', g, 'index.html')))
    .sort()
    .map((g) => ({ name: g, dir: `games/${g}`, url: `${BASE}/games/${g}/` })),
];
// How each app answers "did it render?".
//
// The default is the canvas probe below. These three draw differently, and the
// reason is worth writing down each time — otherwise the next person to see a
// blank span canvas "fixes" a game that is behaving correctly.
const RENDER = {
  // The hub is a page of links. There is no canvas anywhere in it.
  hub: { dom: 'nav.games a.card', min: 2 },
  // 2048 animates real DOM elements, one per tile, so a canvas would be a
  // second renderer for no reason.
  '2048': { dom: '#tiles .tile', min: 2 },
  // Span's frame loop skips draw() outright on the menu screen — see
  // `if (screen !== 'menu') draw(now)` in games/span/game.js — because a DOM
  // overlay covers the canvas there. A blank canvas at boot is the correct
  // behaviour; the level chips are what has to be on screen.
  span: { dom: '#menu .levels .lvl-chip', min: 2, canvasMayBeBlank: true },
};

// --use-angle=swiftshader gives headless Chromium a software GL backend.
// Without it the four Three.js games (drop, runway, carve, sink) get a null
// WebGL context and every one of them fails to boot — which is a property of
// the test environment, not of the games.
const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});

// ---------------------------------------------------------------------------
// Page helpers.
// ---------------------------------------------------------------------------

// Everything the page said or fetched, from the moment it was created.
function watch(page) {
  const log = { consoleErrors: [], pageErrors: [], failedRequests: [], offOrigin: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e)));
  page.on('requestfailed', (r) => log.failedRequests.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return;
    log.offOrigin.push(u);
  });
  return log;
}

// Did this app actually draw?
//
// A canvas with a size proves layout, not painting, so each kind is probed the
// way it can be: a 2D canvas is read back on a 16x16 grid of samples and must
// not be one flat colour, and a WebGL canvas — whose drawing buffer is already
// cleared by the time we can ask — is checked for a live, correctly-sized
// context, which is what actually breaks when GL is unavailable.
async function probeRender(page, rule) {
  return page.evaluate((sel) => {
    const out = { images: 0, brokenImages: [] };

    // Every image the page shows must have decoded. Offline, a precache list
    // that missed an icon looks exactly like this and nothing else notices.
    for (const img of document.images) {
      out.images++;
      if (!img.naturalWidth) out.brokenImages.push(img.getAttribute('src') || img.currentSrc);
    }

    if (sel) {
      const nodes = [...document.querySelectorAll(sel)];
      out.domCount = nodes.length;
      const r = nodes[0] ? nodes[0].getBoundingClientRect() : null;
      out.domSize = r ? [Math.round(r.width), Math.round(r.height)] : null;
    }

    const canvases = [...document.querySelectorAll('canvas')];
    if (!canvases.length) { out.kind = 'none'; return out; }
    // some games overlay a HUD canvas: judge the biggest one
    const c = canvases.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
    const r = c.getBoundingClientRect();
    Object.assign(out, { kind: 'canvas', w: Math.round(r.width), h: Math.round(r.height),
                         bw: c.width, bh: c.height });

    const ctx2d = c.getContext('2d');
    if (ctx2d) {
      out.kind = 'canvas2d';
      try {
        const px = ctx2d.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let gy = 0; gy < 16 && seen.size < 4; gy++) {
          for (let gx = 0; gx < 16 && seen.size < 4; gx++) {
            const x = Math.floor(c.width * (gx + 0.5) / 16);
            const y = Math.floor(c.height * (gy + 0.5) / 16);
            const i = (y * c.width + x) * 4;
            seen.add(`${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`);
          }
        }
        out.distinctColors = seen.size;
      } catch (e) {
        out.readError = String(e.message || e);
      }
      return out;
    }

    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (gl) {
      out.kind = 'webgl';
      out.contextLost = gl.isContextLost();
      const vp = gl.getParameter(gl.VIEWPORT);
      out.viewport = [vp[2], vp[3]];
    }
    return out;
  }, rule.dom || null);
}

function checkRendered(where, rule, r) {
  check(where, 'every image on the page decoded', r.brokenImages.length === 0, show(r.brokenImages));

  if (rule.dom) {
    check(where, `at least ${rule.min} '${rule.dom}' on screen`, r.domCount >= rule.min,
      show({ found: r.domCount }));
    check(where, 'and they have a laid-out size',
      !!r.domSize && r.domSize[0] > 0 && r.domSize[1] > 0, show(r.domSize));
  }
  if (rule.dom && r.kind === 'none') return;   // hub: no canvas is expected

  check(where, 'the app has a canvas', r.kind !== 'none', show(r));
  if (r.kind === 'none') return;
  check(where, 'the canvas has a laid-out size', r.w > 0 && r.h > 0, show(r));
  check(where, 'the canvas has a backing store', r.bw > 0 && r.bh > 0, show(r));

  if (r.kind === 'canvas2d' && !rule.canvasMayBeBlank) {
    check(where, 'the 2D canvas is not one flat colour', r.distinctColors > 1,
      show({ distinctColors: r.distinctColors, readError: r.readError }));
  } else if (r.kind === 'webgl') {
    check(where, 'the WebGL context is alive', r.contextLost === false, show(r));
    check(where, 'the WebGL viewport is non-degenerate',
      r.viewport[0] > 0 && r.viewport[1] > 0, show(r.viewport));
  }
}

// everything an app needs to be judged: its render rule, defaulted
const ruleFor = (app) => RENDER[app.name] || { min: 1 };

// The worker is precached and in charge once it controls the page: install
// runs addAll before skipWaiting, and activate claims. So a non-null
// controller is exactly the "safe to pull the plug" signal.
async function waitForWorker(page, timeout = 30000) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout });
}

// let the boot rAF actually paint before probing
const settle = (page, ms = 700) => page.waitForTimeout(ms);

const registrations = (page) => page.evaluate(async () =>
  (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
const cacheKeys = (page) => page.evaluate(() => caches.keys());
const docks = (page) => page.evaluate(() => document.querySelectorAll('.up-dock').length);

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------
const timings = [];
async function phase(title, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
  } catch (e) {
    failures.push({ where: title, what: 'the phase itself threw', got: String(e.message || e) });
  }
  timings.push({ title, ms: Date.now() - t0, failed: failures.length - before });
  const n = failures.length - before;
  console.log(`  ${n ? 'FAIL' : 'ok  '}  ${title} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

console.log(`smoke: ${APPS.length} apps on ${BASE}\n`);
const started = Date.now();

// --- 1. Boot sweep ---------------------------------------------------------
// Every app, fresh, online. Anything the console says, anything that fails to
// load, and above all anything that leaves this origin: "offline is sacred"
// means a single CDN font would ruin the entire premise, and it would ruin it
// silently, on a plane, months later.
await phase('boot sweep', async () => {
  for (const app of APPS) {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const log = watch(page);
      await page.goto(app.url, { waitUntil: 'load' });
      await settle(page);

      const where = `boot/${app.name}`;
      check(where, 'no console errors', log.consoleErrors.length === 0, show(log.consoleErrors));
      check(where, 'no uncaught page errors', log.pageErrors.length === 0, show(log.pageErrors));
      check(where, 'no failed requests', log.failedRequests.length === 0, show(log.failedRequests));
      check(where, 'no off-origin requests', log.offOrigin.length === 0, show(log.offOrigin));
      checkRendered(where, ruleFor(app), await probeRender(page, ruleFor(app)));
    } finally {
      await ctx.close();
    }
  }
});

// --- 2. Offline reload after install ---------------------------------------
// The promise the whole project is named after. Online once to let the worker
// precache, then the network is taken away and the page is reloaded from
// nothing but the cache.
await phase('offline reload after install', async () => {
  for (const app of APPS) {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage();
      const where = `offline-reload/${app.name}`;
      await page.goto(app.url, { waitUntil: 'load' });
      await waitForWorker(page);

      await ctx.setOffline(true);
      const log = watch(page);
      await page.reload({ waitUntil: 'load' });
      await settle(page);

      // Failed requests are expected here — update.js's launch check and the
      // browser's own worker byte-check both go to the network and both are
      // handled. What must not happen is the page failing to come up.
      check(where, 'no uncaught page errors offline', log.pageErrors.length === 0, show(log.pageErrors));
      checkRendered(where, ruleFor(app), await probeRender(page, ruleFor(app)));
    } finally {
      await ctx.close();
    }
  }
});

// --- 3. Offline cold-nav from the hub --------------------------------------
// The realistic disaster: the player opened the hub at the gate, the plane
// took off, and now they tap a game they have never opened. Nothing about that
// game has been fetched in this session — it can only come out of the *hub's*
// precache list, and only via the hub worker's offlineFallback.
await phase('offline cold-nav from the hub', async () => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await waitForWorker(page);
    await ctx.setOffline(true);

    for (const app of APPS.filter((a) => a.dir)) {
      const where = `offline-cold-nav/${app.name}`;
      const log = watch(page);
      await page.goto(app.url, { waitUntil: 'load' });
      await settle(page);
      check(where, 'no uncaught page errors on a cold offline open',
        log.pageErrors.length === 0, show(log.pageErrors));
      checkRendered(where, ruleFor(app), await probeRender(page, ruleFor(app)));
    }
  } finally {
    await ctx.close();
  }
});

// --- 4. Cache coexistence --------------------------------------------------
// Every app prunes stale generations on activate, and a bare `k !== CACHE`
// there deletes the hub's cache and all ten siblings' — the bug that shipped
// for the entire life of the project until 22f8f02. It is invisible online.
//
// Note on how this is staged: a Playwright BrowserContext has its own isolated
// storage, so two contexts can never see each other's CacheStorage and the
// question could not even be asked. Separate *tabs* in one context are the
// right analogue anyway — they share an origin's caches, and each gets a fresh
// sessionStorage, which is precisely what makes each one a direct launch that
// claims the shell for itself (see update.js).
await phase('cache coexistence', async () => {
  const picked = ['hub', '2048', 'drop', 'snake']
    .map((n) => APPS.find((a) => a.name === n))
    .filter(Boolean);

  const ctx = await browser.newContext();
  try {
    let last = null;
    for (const app of picked) {
      const page = await ctx.newPage();       // a new tab = a fresh session = a direct launch
      await page.goto(app.url, { waitUntil: 'load' });
      await waitForWorker(page);
      last = page;
    }
    const keys = (await cacheKeys(last)).sort();
    for (const app of picked) {
      check('cache-coexistence', `${app.name} still has its own cache after ${picked.length} launches`,
        keys.some((k) => k.startsWith(`am-${app.name}-`)), show(keys));
    }
    check('cache-coexistence', 'no app left a cache behind beyond its own',
      keys.length === picked.length, show(keys));
  } finally {
    await ctx.close();
  }

  // The other half of the rule, and the one that looks like a bug if you do
  // not know update.js: inside ONE tab, hub -> game is *not* two apps. The
  // game is nested under the shell that claimed the session, so it stands
  // down, registers nothing, and deletes any cache of its own it finds. One
  // cache — the hub's — is the correct answer here, not two.
  const nested = await browser.newContext();
  try {
    const page = await nested.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await waitForWorker(page);
    await page.goto(`${BASE}/games/drop/`, { waitUntil: 'load' });
    await settle(page);
    const keys = (await cacheKeys(page)).sort();
    check('cache-coexistence', 'a nested game adds no cache of its own',
      keys.length === 1 && keys[0].startsWith('am-hub-'), show(keys));
  } finally {
    await nested.close();
  }
});

// --- 5. Shell claim --------------------------------------------------------
// One collection turning into twelve apps that each announce their own updates
// is the regression update.js exists to prevent. It has two visible symptoms —
// a second worker registration, and a second update pill — and both are
// checkable from the page.
await phase('shell claim', async () => {
  const nested = await browser.newContext();
  try {
    const page = await nested.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await waitForWorker(page);
    await page.goto(`${BASE}/games/drop/`, { waitUntil: 'load' });
    await settle(page, 1200);           // releaseOwnWorker is async and fire-and-forget

    const scopes = await registrations(page);
    check('shell-claim/nested', 'exactly one service worker registration', scopes.length === 1, show(scopes));
    check('shell-claim/nested', 'and it is the hub\'s', scopes[0] === `${BASE}/`, show(scopes));
    check('shell-claim/nested', 'the nested game shows no update dock',
      (await docks(page)) === 0, show(await docks(page)));
  } finally {
    await nested.close();
  }

  const direct = await browser.newContext();
  try {
    const page = await direct.newPage();
    await page.goto(`${BASE}/games/drop/`, { waitUntil: 'load' });
    await waitForWorker(page);
    await settle(page, 400);

    const scopes = await registrations(page);
    check('shell-claim/direct', 'exactly one service worker registration', scopes.length === 1, show(scopes));
    check('shell-claim/direct', 'and it is the game\'s own',
      scopes[0] === `${BASE}/games/drop/`, show(scopes));
    check('shell-claim/direct', 'a directly-launched game owns its update dock',
      (await docks(page)) === 1, show(await docks(page)));
  } finally {
    await direct.close();
  }
});

// --- 6. 2048 save/restore --------------------------------------------------
// The one game with state worth losing. A reload here is not hypothetical:
// it is exactly what tapping "Update ready · Reload" does.
await phase('2048 save/restore', async () => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/games/2048/`, { waitUntil: 'load' });
    await settle(page, 300);

    // A known board, so the move that follows is a real merge with a real
    // score rather than whatever two random tiles happened to spawn.
    await page.evaluate(() => window.__test.setBoard([
      [2, 2, 0, 0],
      [4, 0, 0, 0],
      [0, 0, 0, 0],
      [8, 0, 0, 0],
    ]));
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowLeft']) {
      await page.keyboard.press(key);
      await settle(page, 350);
    }
    await settle(page, 400);

    const saved = await page.evaluate(() => localStorage.getItem('am.2048.save'));
    check('2048-save', 'a move writes a save', !!saved, show(saved));
    if (!saved) return;
    const save = JSON.parse(saved);
    const wantTiles = save.cells.flat().filter(Boolean).sort((a, b) => a - b);
    check('2048-save', 'the save records a score earned by merging', save.score > 0, show(save.score));
    check('2048-save', 'the save records a board that is not a fresh game',
      wantTiles.length >= 3, show(wantTiles));

    await page.reload({ waitUntil: 'load' });
    await settle(page, 600);

    const after = await page.evaluate(() => ({
      score: Number(document.getElementById('score').textContent),
      tiles: [...document.querySelectorAll('#tiles .tile .tile-num')]
        .map((n) => Number(n.textContent)).sort((a, b) => a - b),
      raw: localStorage.getItem('am.2048.save'),
    }));
    check('2048-save', 'the score comes back after a reload', after.score === save.score,
      `${after.score} !== ${save.score}`);
    check('2048-save', 'the board comes back after a reload',
      after.tiles.join() === wantTiles.join(), `${show(after.tiles)} !== ${show(wantTiles)}`);
    check('2048-save', 'restoring does not clobber the save', after.raw === saved, show(after.raw));

    // A finished game is not worth resuming: if the save survived, the next
    // launch would open on a board with nowhere left to move.
    await page.evaluate(() => window.__test.forceNearFull());
    await settle(page, 300);
    await page.keyboard.press('ArrowLeft');
    await settle(page, 1600);           // the game-over overlay lands after ~720ms

    const end = await page.evaluate(() => ({
      save: localStorage.getItem('am.2048.save'),
      overlay: document.getElementById('overlay').hidden
        ? null : document.getElementById('overlay-title').textContent,
    }));
    check('2048-save', 'the game actually ended', end.overlay === 'Game over', show(end.overlay));
    check('2048-save', 'a finished game clears its save', end.save === null, show(end.save));
  } finally {
    await ctx.close();
  }
});

// --- 7. Carve: tricks, rails, obstacles ------------------------------------
// tools/carve-rules.mjs proves the *rules* in Node. This proves they are wired
// to the game: that a tree you fly over really is survivable in the loop that
// runs, that a rail catches a rider and pays out, that a held ↑ becomes a
// backflip, that a streak lights the board up, and that the light goes down.
//
// The rAF loop is frozen and the simulation is stepped by hand, so none of it
// depends on wall-clock timing or on what the mountain randomly generated.
await phase('carve tricks, rails and sundown', async () => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const log = watch(page);
    await page.goto(`${BASE}/games/carve/`, { waitUntil: 'load' });
    await settle(page, 400);

    const fresh = () => page.evaluate(() => {
      window.__test.freeze(true);
      window.__test.start();
      window.__test.clearAhead(600);
      return true;
    });

    // --- flying over a tree ------------------------------------------------
    // The reported bug: a kicker carried the rider clean over a crown and the
    // run ended anyway, because a tree's contact height was literally 99m.
    await fresh();
    const overTree = await page.evaluate(() => {
      const t = window.__test, p = t.player;
      const tree = t.putTree(0, 1.2, 1);            // dead ahead, full size
      p.grounded = false;
      p.vy = 0;
      p.y += 3.6;                                   // about a kicker's apex
      t.step(1 / 60, 4);
      return { state: t.state, treeH: tree.h, passed: p.s };
    });
    check('carve/tree', 'a tree no longer has an infinite crown',
      overTree.treeH < 4, show(overTree.treeH));
    check('carve/tree', 'flying over a tree does not end the run',
      overTree.state === 'playing', show(overTree));

    // ...and the rule that must not have loosened with it.
    await fresh();
    const intoTree = await page.evaluate(() => {
      const t = window.__test, p = t.player;
      t.putTree(0, 1.2, 1);
      t.step(1 / 60, 6);
      return t.state;
    });
    check('carve/tree', 'riding into a tree still ends the run',
      intoTree !== 'playing', show(intoTree));

    // --- grinding a rail --------------------------------------------------
    await fresh();
    const rail = await page.evaluate(async () => {
      const t = window.__test;
      const r = t.putRail(0, 9);
      let caught = false, held = 0;
      for (let i = 0; i < 240 && t.state === 'playing'; i++) {
        t.step(1 / 60, 1);
        if (t.grinding) { caught = true; held++; }
        else if (caught) break;                      // rode off the end
      }
      return {
        placed: !!r, caught, held, bonus: t.bonus, streak: t.streak,
        toast: document.getElementById('toasts').textContent,
      };
    });
    check('carve/rail', 'a rail can be placed in the rider\'s lane', rail.placed, show(rail));
    check('carve/rail', 'riding into it starts a grind', rail.caught, show(rail));
    check('carve/rail', 'and the grind lasts long enough to feel like one',
      rail.held > 20, show(rail.held));
    check('carve/rail', 'riding off the end pays for the metres held',
      rail.bonus > 0 && /grind/.test(rail.toast), show(rail));
    check('carve/rail', 'a grind counts toward the streak', rail.streak >= 1, show(rail.streak));

    // --- flips ------------------------------------------------------------
    // A full backflip is 2π at FLIP_KEY rad/s; hold ↑ for that long in the air
    // and the landing has to be named for it.
    await fresh();
    await page.evaluate(() => {
      const t = window.__test, p = t.player;
      p.v = 34;
      p.grounded = false;
      p.vy = 13;                                     // a generous kicker
      p.airStart = 0;
      t.step(1 / 60, 1);
    });
    await page.keyboard.down('ArrowUp');
    await page.evaluate(() => window.__test.step(1 / 60, 74));
    await page.keyboard.up('ArrowUp');
    const flip = await page.evaluate(() => {
      const t = window.__test;
      for (let i = 0; i < 160 && !t.player.grounded && t.state === 'playing'; i++) t.step(1 / 60, 1);
      return { bonus: t.bonus, state: t.state, toast: document.getElementById('toasts').textContent };
    });
    check('carve/flip', 'a held ↑ in the air lands a backflip',
      /backflip/.test(flip.toast), show(flip));
    check('carve/flip', 'and it scores', flip.bonus > 0, show(flip.bonus));

    // ...and the same trick through the input that actually ships: a drag.
    // 2π at FLIP_PER_PX (0.017 rad/px) is 370px of vertical travel, dragged
    // while the loop is frozen so no simulated time passes mid-flick.
    await fresh();
    await page.evaluate(() => {
      const t = window.__test, p = t.player;
      p.v = 34; p.grounded = false; p.vy = 13; p.airStart = 0;
      t.step(1 / 60, 1);
    });
    await page.mouse.move(640, 650);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(640, 650 - i * 37);
    await page.mouse.up();
    const dragFlip = await page.evaluate(() => {
      const t = window.__test;
      const spun = { flip: t.player.flip, spin: t.player.spin };
      for (let i = 0; i < 200 && !t.player.grounded && t.state === 'playing'; i++) t.step(1 / 60, 1);
      return { ...spun, bonus: t.bonus, toast: document.getElementById('toasts').textContent };
    });
    check('carve/flip', 'dragging up in the air rotates the board backwards',
      dragFlip.flip < -6 && dragFlip.flip > -6.6, show(dragFlip.flip));
    check('carve/flip', 'and no sideways drag means no spin came with it',
      Math.abs(dragFlip.spin) < 0.01, show(dragFlip.spin));
    check('carve/flip', 'a dragged backflip lands and scores',
      /backflip/.test(dragFlip.toast) && dragFlip.bonus > 0, show(dragFlip));

    // --- streak -----------------------------------------------------------
    // Three scored tricks in a row is the threshold the HUD and the board glow
    // both read, so it is one assertion for both.
    await fresh();
    const streak = await page.evaluate(() => {
      const t = window.__test, p = t.player, need = t.rules.STREAK_ON;
      for (let n = 0; n < need; n++) {
        p.grounded = false;
        p.vy = 9;
        p.airStart = -2;                             // long enough to be "clean air"
        p.spin = 0; p.spinTotal = 0; p.flip = 0; p.flipTotal = 0;
        for (let i = 0; i < 200 && !p.grounded; i++) t.step(1 / 60, 1);
      }
      t.step(1 / 60, 30);                            // let the glow ease in
      const chip = document.getElementById('streak');
      return {
        streak: t.streak, heat: t.heat, hidden: chip.hidden,
        chip: chip.textContent, need,
      };
    });
    check('carve/streak', 'clean airs in a row build a streak',
      streak.streak >= streak.need, show(streak));
    check('carve/streak', 'the streak pill appears with it', streak.hidden === false, show(streak));
    check('carve/streak', 'and names the count', streak.chip.includes(String(streak.streak)), show(streak.chip));
    check('carve/streak', 'the board lights up (heat > 0)', streak.heat > 0.05, show(streak.heat));

    const cooled = await page.evaluate(() => {
      const t = window.__test, p = t.player;
      p.grounded = false; p.vy = 6; p.spin = Math.PI / 2; p.spinTotal = Math.PI / 2;
      for (let i = 0; i < 200 && !p.grounded; i++) t.step(1 / 60, 1);
      t.step(1 / 60, 60);
      return { streak: t.streak, heat: t.heat, hidden: document.getElementById('streak').hidden };
    });
    check('carve/streak', 'a sketchy landing ends the streak', cooled.streak === 0, show(cooled));
    check('carve/streak', 'and the board cools off', cooled.heat < 0.2, show(cooled.heat));
    check('carve/streak', 'and the pill goes away', cooled.hidden === true, show(cooled));

    // --- how crowded the piste is -----------------------------------------
    // "Sometimes slightly too many obstacles" is a real complaint and a real
    // regression risk in both directions, so it gets a number. The rider is
    // lifted 60m and teleported down the fall line, which generates the world
    // exactly as riding it would while being unable to touch anything.
    await fresh();
    const piste = await page.evaluate(() => {
      const t = window.__test, p = t.player;
      const seen = new Map();
      const from = p.s;
      for (let i = 0; i < 60; i++) {                 // 60 x 50m = 3km
        p.s += 50;
        // Airborne and 60m up, re-asserted every step: the grounded branch
        // plants y back on the snow, and a rider on the snow teleporting
        // through 3km of trees crashes, which would stop the world generating
        // and report a suspiciously empty mountain.
        p.grounded = false;
        p.rail = null;
        p.vy = 0;
        p.y = t.groundY(p.x, p.s) + 60;
        t.step(1 / 600, 1);
        for (const o of t.obstacles) seen.set(`${o.x.toFixed(2)}|${o.s.toFixed(2)}`, o);
      }
      const span = p.s - from;
      const all = [...seen.values()].filter((o) => o.s > from + 40 && o.s < p.s - 40);

      // Is there always a line through? At every metre, the widest gap left
      // between the obstacles straddling that point must fit a rider.
      let tightest = 99, tightestAt = 0;
      const H = t.pisteHalf;
      for (let s = from + 50; s < p.s - 50; s += 1) {
        const blocked = all
          .filter((o) => Math.abs(o.s - s) < o.r + 0.5)
          .map((o) => [o.x - o.r - 0.5, o.x + o.r + 0.5])
          .sort((a, b) => a[0] - b[0]);
        let edge = -H, gap = 0;
        for (const [lo, hi] of blocked) {
          gap = Math.max(gap, lo - edge);
          edge = Math.max(edge, hi);
        }
        gap = Math.max(gap, H - edge);
        if (gap < tightest) { tightest = gap; tightestAt = Math.round(s); }
      }
      return { per100: (all.length / span) * 100, n: all.length, tightest, tightestAt, state: t.state };
    });
    check('carve/piste', 'the survey flew the whole 3km without crashing',
      piste.state === 'playing', show(piste.state));
    check('carve/piste', 'the piste is not a slalom course',
      piste.per100 < 12, show(piste));
    check('carve/piste', '...and not an empty groomer either',
      piste.per100 > 3, show(piste));
    check('carve/piste', 'there is always a line through, everywhere',
      piste.tightest > 1.6, show(piste));

    // --- sundown ----------------------------------------------------------
    await fresh();
    const dusk = await page.evaluate(() => {
      const t = window.__test;
      t.step(1 / 60, 300);            // the light eases, so let the new run's morning arrive
      const early = t.dayT;
      // ~2.2 km of run, clearing the piste ahead as it goes so the light — not
      // a tree — is what the test is measuring
      for (let i = 0; i < 60 && t.state === 'playing'; i++) {
        t.clearAhead(600);
        t.step(1 / 60, 60);
      }
      return { early, late: t.dayT, dist: Math.round(t.player.s), state: t.state };
    });
    check('carve/sundown', 'a run starts in daylight', dusk.early < 0.02, show(dusk.early));
    check('carve/sundown', 'a long run runs out of it', dusk.late > 0.5, show(dusk));

    await page.evaluate(() => { window.__test.start(); window.__test.step(1 / 60, 240); });
    const morning = await page.evaluate(() => window.__test.dayT);
    check('carve/sundown', 'and a restart brings the sun back up', morning < 0.6, show(morning));

    check('carve/errors', 'no uncaught page errors through all of it',
      log.pageErrors.length === 0, show(log.pageErrors));
    check('carve/errors', 'and no console errors', log.consoleErrors.length === 0, show(log.consoleErrors));
  } finally {
    await ctx.close();
  }
});

// --- 8. Wake: a whole race -------------------------------------------------
// tools/wake-rules.mjs proves the arithmetic in Node. This proves it is wired
// to the game, and it does it the only way a race can honestly be tested:
// by racing one. The rAF loop is frozen, the player is put on the same
// autopilot the rivals use, and three full laps are stepped by hand — about
// two and a half minutes of racing in a couple of seconds of wall clock.
//
// The things that can only break here are the wiring: a lap that counts twice
// because the game reads `s` instead of the progress model, a finish that
// never fires, a HUD that disagrees with the simulation behind it.
await phase('wake: a full three-lap race', async () => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const log = watch(page);
    await page.goto(`${BASE}/games/wake/`, { waitUntil: 'load' });
    await settle(page, 400);

    const fresh = () => page.evaluate(() => {
      const t = window.__test;
      t.freeze(true);
      t.start();
      t.go();                       // skip the lights
      return t.state;
    });

    check('wake/start', 'the lights go out and the race is on', await fresh() === 'racing');

    // --- the whole race ----------------------------------------------------
    const race = await page.evaluate(() => {
      const t = window.__test;
      t.autopilot(true);
      let steps = 0;
      // a cap well past any plausible race, so a game that never finishes
      // fails here rather than hanging the suite
      while (t.state === 'racing' && steps < 30000) { t.step(1 / 60, 20); steps += 20; }
      const laps = t.racers.map((r) => r.lap);
      return {
        state: t.state,
        steps,
        raceT: t.raceT,
        playerLap: t.player.lap,
        bestLap: t.player.bestLap,
        finishedAt: t.player.finishedAt,
        place: t.place,
        laps,
        standings: t.standings,
        LAPS: t.rules.LAPS,
        GRID: t.rules.GRID,
      };
    });

    check('wake/race', 'the race ends on its own', race.state === 'finished', show(race.state));
    check('wake/race', 'the player completed exactly the advertised laps',
      race.playerLap === race.LAPS, `${race.playerLap} of ${race.LAPS}`);
    check('wake/race', 'and crossed the line for real', race.finishedAt > 0, show(race.finishedAt));
    check('wake/race', 'a lap takes a plausible time',
      race.bestLap > 25 && race.bestLap < 75, `${show(race.bestLap)} s`);
    check('wake/race', 'three laps take two to four minutes',
      race.raceT > 90 && race.raceT < 260, `${race.raceT.toFixed(1)} s`);
    check('wake/race', 'the player finishes somewhere in the field',
      race.place >= 1 && race.place <= race.GRID, show(race.place));
    check('wake/race', 'the whole field is still accounted for',
      new Set(race.standings).size === race.GRID, show(race.standings));

    // Every rival must get round too. A rival stuck on a buoy or driving into
    // the shallows for two minutes is the classic AI failure, and it is
    // invisible from the player's seat if it happens behind them.
    const stuck = race.laps.filter((l) => l < race.LAPS - 1).length;
    check('wake/ai', 'no rival gets stuck: all of them are on the last lap or done',
      stuck === 0, `${stuck} rival(s) behind, laps ${show(race.laps)}`);

    // --- the HUD agrees with the simulation --------------------------------
    const hud = await page.evaluate(() => {
      const t = window.__test;
      t.start(); t.go(); t.autopilot(true);
      t.step(1 / 60, 600);
      t.paint();
      return {
        pos: document.getElementById('posNum').textContent,
        lap: document.getElementById('lapNum').textContent,
        clock: document.getElementById('clock').textContent,
        rows: document.querySelectorAll('#standings li').length,
        speed: Number(document.getElementById('speedVal').textContent),
        realPos: t.place,
        realSpeed: Math.round(t.player.v * 3.6),
        raceT: t.raceT,
      };
    });
    check('wake/hud', 'the position on screen is the position in the race',
      hud.pos === String(hud.realPos), `${hud.pos} vs ${hud.realPos}`);
    check('wake/hud', 'the speedo reads the ski\'s actual speed',
      hud.speed === hud.realSpeed, `${hud.speed} vs ${hud.realSpeed}`);
    check('wake/hud', 'the clock is running', /^00:0[7-9]|^00:1[0-2]/.test(hud.clock),
      `${hud.clock} at ${hud.raceT.toFixed(2)}s`);
    check('wake/hud', 'every racer has a row in the standings', hud.rows === race.GRID, show(hud.rows));
    check('wake/hud', 'the lap counter never exceeds the race length',
      Number(hud.lap) >= 1 && Number(hud.lap) <= race.LAPS, show(hud.lap));

    // --- the shallows are a real punishment, not a wall --------------------
    const off = await page.evaluate(async () => {
      const t = window.__test;
      t.start(); t.go(); t.autopilot(false);
      t.teleport(200, 0, 30);
      t.step(1 / 60, 30);
      const onCourse = t.player.v;
      t.teleport(200, t.rules.TRACK_HALF + 9, 30);
      t.step(1 / 60, 90);
      return { onCourse, inShallows: t.player.v, off: t.player.off, state: t.state };
    });
    check('wake/shallows', 'the shallows cost most of your speed',
      off.inShallows < off.onCourse * 0.7, `${off.inShallows.toFixed(1)} vs ${off.onCourse.toFixed(1)} m/s`);
    check('wake/shallows', 'the game knows you are off course', off.off === true, show(off));
    check('wake/shallows', '...but it is not a crash — the race carries on',
      off.state === 'racing', show(off.state));

    // --- the wake is fuel --------------------------------------------------
    // The one mechanic the whole design rests on: sitting behind someone fills
    // the bar. If this stops working the game still runs, and stops being the
    // game it was designed as.
    const draft = await page.evaluate(() => {
      const t = window.__test;
      t.start(); t.go(); t.autopilot(false); t.setBoost(0);
      // park a rival 12 m dead ahead, matching speed, and hold station
      const rival = t.racers.find((r) => !r.isPlayer);
      for (let i = 0; i < 60; i++) {
        t.teleport(300, 0, 26);
        const p = t.player;
        rival.x = p.x + Math.cos(p.heading) * 12;
        rival.z = p.z + Math.sin(p.heading) * 12;
        rival.heading = p.heading;
        rival.v = 26;
        t.step(1 / 60, 1);
      }
      const drafted = t.player.boost;
      const towed = t.player.draft;
      // now the same second of racing with nobody in front
      t.setBoost(0);
      for (const r of t.racers) if (!r.isPlayer) { r.x = 9999; r.z = 9999; }
      for (let i = 0; i < 60; i++) { t.teleport(300, 0, 26); t.step(1 / 60, 1); }
      return { drafted, towed, alone: t.player.boost, aloneTow: t.player.draft, max: t.rules.BOOST_MAX };
    });
    check('wake/draft', 'a second in a rival\'s wake fills a chunk of the bar',
      draft.drafted > draft.max * 0.15, show(draft.drafted));
    check('wake/draft', 'the game knows it is being towed', draft.towed > 0.5, show(draft.towed));
    // Open water is not zero — air off a swell fills the bar too, and should.
    // What must hold is that the tow is worth clearly more, because the whole
    // design (and starting the player last) rests on the wake being the prize.
    check('wake/draft', 'open water is not a tow at all', draft.aloneTow === 0, show(draft.aloneTow));
    check('wake/draft', 'and open water fills the bar far more slowly',
      draft.alone < draft.drafted * 0.6, `${draft.alone.toFixed(1)} vs ${draft.drafted.toFixed(1)}`);

    // --- boost spends, and refuses when there is nothing to spend ----------
    const boost = await page.evaluate(() => {
      const t = window.__test;
      t.start(); t.go(); t.autopilot(false);
      t.teleport(300, 0, 30); t.setBoost(t.rules.BOOST_MAX);
      t.holdBoost(true);
      t.step(1 / 60, 45);
      const firing = { boost: t.player.boost, v: t.player.v, on: t.player.boosting };
      t.holdBoost(false);
      // an empty bar must refuse rather than silently do nothing
      t.setBoost(0);
      document.getElementById('boostBtn').classList.remove('deny');
      t.holdBoost(true);
      const denied = document.getElementById('boostBtn').classList.contains('deny');
      t.step(1 / 60, 10);
      const after = t.player.boosting;
      t.holdBoost(false);
      return { ...firing, denied, after, max: t.rules.BOOST_MAX };
    });
    check('wake/boost', 'holding it drains the bar', boost.boost < boost.max, show(boost.boost));
    check('wake/boost', 'and the ski actually goes faster than its clean top speed',
      boost.v > 33, `${boost.v.toFixed(1)} m/s`);
    check('wake/boost', 'the game agrees it is firing', boost.on === true, show(boost.on));
    check('wake/boost', 'an empty bar refuses visibly instead of doing nothing',
      boost.denied === true, show(boost.denied));
    check('wake/boost', 'and nothing fires', boost.after === false, show(boost.after));

    // --- the water the ski rides is the water that is drawn ----------------
    const surf = await page.evaluate(() => {
      const t = window.__test;
      t.start(); t.go(); t.autopilot(true);
      t.step(1 / 60, 240);
      const p = t.player;
      return { y: p.y, surface: t.waterAt(p.x, p.z), air: p.air };
    });
    check('wake/water', 'the ski sits on the surface, not above or below it',
      surf.air > 0 || Math.abs(surf.y - surf.surface) < 0.6,
      `ski ${surf.y.toFixed(2)} vs water ${surf.surface.toFixed(2)}`);

    check('wake/errors', 'no uncaught page errors through all of it',
      log.pageErrors.length === 0, show(log.pageErrors));
    check('wake/errors', 'and no console errors', log.consoleErrors.length === 0, show(log.consoleErrors));
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------

await browser.close();
stopServer();

const secs = ((Date.now() - started) / 1000).toFixed(1);

if (failures.length) {
  console.log('');
  for (const f of failures) {
    console.log(`FAIL  ${f.where}: ${f.what}`);
    if (f.got !== undefined) console.log(`        got: ${f.got}`);
  }
  console.log(`\n${failures.length} of ${assertions} assertions failed across ${APPS.length} apps in ${secs}s.`);
  process.exit(1);
}

console.log(`\nok — ${assertions} assertions, ${APPS.length} apps, ${timings.length} phases in ${secs}s.`);
