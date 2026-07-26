// check.mjs — assert the invariants DESIGN.md promises.
//
//   node tools/check.mjs
//
// This is NOT a build step. It emits nothing, the site does not depend on it,
// and it has zero dependencies — same idiom as gen-icons.mjs beside it.
//
// It exists because this project's failure mode is *delivery*, not gameplay.
// Four of the five regressions in the repo's history were service-worker or
// caching bugs, and the worst of them are invisible: a shipped fix that no
// installed player can ever receive, or a game that works online and shows a
// black screen offline. Every rule below is one that has already broken, or
// is one line away from breaking, and all of them are mechanically checkable.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = fs.readdirSync(path.join(ROOT, 'games')).sort();
// every app directory, hub first ('' is the root)
const APPS = ['', ...GAMES.map((g) => path.join('games', g))];

const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
const appName = (app) => (app === '' ? 'hub' : path.basename(app));
const label = (app) => (app === '' ? '(hub)' : app);

// Each sw.js defines CACHE and ASSETS before its first listener, so the
// prelude can just be run — no regex-parsing of array literals, and the hub's
// computed GAMES x GAME_FILES cross-product comes out exactly as it ships.
function swPrelude(app) {
  const src = read(path.join(app, 'sw.js'));
  const cut = src.indexOf('self.addEventListener');
  const prelude = cut === -1 ? src : src.slice(0, cut);
  try {
    return { src, ...new Function(`${prelude}\nreturn { CACHE, ASSETS };`)() };
  } catch (e) {
    fail(path.join(app, 'sw.js'), `could not evaluate the CACHE/ASSETS prelude: ${e.message}`);
    return { src, CACHE: null, ASSETS: [] };
  }
}

const sw = new Map(APPS.map((a) => [a, swPrelude(a)]));

// ---------------------------------------------------------------------------
// 1. The cache-version ratchet.
//
// Cache-first means the worker serves the old copy until CACHE changes. A fix
// shipped without a bump reaches nobody, forever, with no symptom. This has
// happened three times; 7e72831 is a commit whose entire diff is -v2/+v3.
// ---------------------------------------------------------------------------
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

let base = null;
try {
  for (const ref of ['origin/main', 'main']) {
    try { base = git(['merge-base', ref, 'HEAD']); break; } catch { /* try the next */ }
  }
  if (base && base === git(['rev-parse', 'HEAD'])) base = 'HEAD-IS-BASE';
} catch {
  base = null;   // not a git checkout, or no history
}

if (base === null) {
  warn('cache ratchet', 'no git merge-base available, skipping the version-bump check');
} else if (base !== 'HEAD-IS-BASE') {
  const changed = (git(['diff', '--name-only', base, 'HEAD']) || '').split('\n').filter(Boolean);
  for (const app of APPS) {
    const dir = app === '' ? '' : app + '/';
    // shipped files belonging to THIS app — for the hub, root level only, and
    // never the docs or tools, which no player ever downloads
    const shipped = changed.filter((f) => {
      if (!f.startsWith(dir)) return false;
      const rest = f.slice(dir.length);
      if (app === '' && rest.includes('/')) return false;
      if (f.endsWith('.md')) return false;
      return true;
    });
    if (!shipped.length) continue;

    // It is not enough for sw.js to have changed — the CACHE *value* must
    // differ, or the worker still serves the old copy from the old cache.
    const swPath = `${dir}sw.js`;
    const nameOf = (text) => (text.match(/^const CACHE = '([^']+)';$/m) || [])[1];
    let was;
    try { was = nameOf(git(['show', `${base}:${swPath}`])); } catch { was = null; }
    const now = sw.get(app).CACHE;
    if (was && was === now) {
      fail(
        swPath,
        `${shipped.length} shipped file(s) changed but CACHE is still '${now}' ` +
        `(${shipped.slice(0, 3).join(', ')}${shipped.length > 3 ? ', …' : ''}) — ` +
        'cache-first means installed players will never receive this change'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Cache naming, and pruning only your own generations.
//
// A bare `k !== CACHE` in activate sweeps away the hub's cache and every
// sibling's. That shipped for the entire life of the project until 22f8f02.
// update.js also derives 'am-<dir>-' from the directory name when it stands
// down a stale worker, so the name and the directory must agree.
// ---------------------------------------------------------------------------
for (const app of APPS) {
  const { src, CACHE } = sw.get(app);
  if (!CACHE) continue;
  const want = new RegExp(`^am-${appName(app)}-v\\d+$`);
  if (!want.test(CACHE)) {
    fail(path.join(app, 'sw.js'), `CACHE is '${CACHE}', expected to match am-${appName(app)}-v<N>`);
  }
  const prunesOwn =
    /k\.startsWith\(PREFIX\)/.test(src) ||
    src.includes(`k.startsWith('am-${appName(app)}-')`);
  if (!prunesOwn) {
    fail(
      path.join(app, 'sw.js'),
      'activate does not restrict the prune to this app\'s own generations — ' +
      'a bare `k !== CACHE` deletes the hub\'s cache and every sibling\'s'
    );
  }
}

// ---------------------------------------------------------------------------
// 3. respondWith must always get a Response.
//
// `.catch(() => hit)` reads fine and is always undefined: we only reached the
// fetch because `hit` was falsy. Offline, that rejects respondWith and Safari
// shows a hard error page. Fixed once in deb56cd, reintroduced in three apps.
// ---------------------------------------------------------------------------
for (const app of APPS) {
  const { src } = sw.get(app);
  const fetchIdx = src.indexOf("addEventListener('fetch'");
  if (fetchIdx === -1) continue;
  const body = src.slice(fetchIdx);
  for (const m of body.matchAll(/\.catch\(\s*\([^)]*\)\s*=>\s*([^)\n]+)\)/g)) {
    const handler = m[1].trim();
    // a fire-and-forget catch on the runtime-cache write is not in the
    // respondWith chain and is allowed to swallow
    if (/caches\.open\(/.test(body.slice(Math.max(0, m.index - 80), m.index))) continue;
    const ok = /caches\.match|Response|offlineFallback/.test(handler);
    if (!ok) {
      fail(
        path.join(app, 'sw.js'),
        `the fetch handler's .catch resolves to \`${handler}\`, which is not a Response — ` +
        'respondWith will reject offline'
      );
    }
  }
  if (!/ignoreSearch:\s*true/.test(body)) {
    fail(
      path.join(app, 'sw.js'),
      'caches.match without { ignoreSearch: true } — any URL carrying a query string ' +
      'misses the cache and is dead offline'
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Everything an app references must be precached.
//
// Miss one and the app works online and dies offline, which is the one thing
// this project promises. cache.addAll is atomic, so a path that does not
// exist means the worker never installs at all — total offline loss, and the
// only symptom is that the app quietly stops updating.
// ---------------------------------------------------------------------------
for (const app of APPS) {
  const { ASSETS } = sw.get(app);
  const assets = new Set(ASSETS);

  // every precached path must exist on disk
  for (const a of ASSETS) {
    if (!a.startsWith('./')) {
      fail(path.join(app, 'sw.js'), `ASSETS entry '${a}' is not a relative './' path`);
      continue;
    }
    const rel = a.slice(2);
    if (rel === '' || rel.endsWith('/')) continue;         // directory entries
    const onDisk = app === '' ? rel : path.join(app, rel);
    if (!exists(onDisk)) {
      fail(
        path.join(app, 'sw.js'),
        `ASSETS lists '${a}' which does not exist — cache.addAll is atomic, so the ` +
        'worker will never install'
      );
    }
  }

  // everything index.html and the JS modules reference must be in ASSETS
  const html = read(path.join(app, 'index.html'));
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) refs.add(m[1]);

  const jsFiles = fs.readdirSync(path.join(ROOT, app || '.'))
    .filter((f) => f.endsWith('.js') && f !== 'sw.js');
  for (const f of jsFiles) {
    const src = read(path.join(app, f));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) refs.add(m[1]);
  }

  for (const r of refs) {
    if (!assets.has(r)) {
      fail(path.join(app, 'sw.js'), `'${r}' is referenced but missing from ASSETS — broken offline`);
    }
  }
}

// the hub serves every game from its own cache, so its list must cover theirs
{
  const hubAssets = new Set(sw.get('').ASSETS);
  for (const g of GAMES) {
    for (const a of sw.get(path.join('games', g)).ASSETS) {
      if (a === './') continue;
      const viaHub = './games/' + g + '/' + a.slice(2);
      if (!hubAssets.has(viaHub)) {
        fail(
          'sw.js',
          `the hub does not precache '${viaHub}', which games/${g} needs — ` +
          'opening that game offline from the hub will fail'
        );
      }
    }
  }
  const listed = read('sw.js').match(/const GAMES = \[([^\]]*)\]/);
  const declared = listed ? listed[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)).sort() : [];
  if (declared.join() !== GAMES.join()) {
    fail('sw.js', `GAMES is [${declared}] but games/ contains [${GAMES}]`);
  }
}

// ---------------------------------------------------------------------------
// 5. The shared modules are copied, not imported — so they must stay identical.
//
// A parent-directory module would sit outside every app's scope: "." and
// break independent installability, so copying is correct. Nothing but this
// check stands between that and twelve silently diverging versions.
// ---------------------------------------------------------------------------
// pause.js belongs to real-time games only: the hub has no clock, and 2048 is
// turn-based. Everything else must carry all three.
const NO_PAUSE = ['', path.join('games', '2048')];
for (const mod of ['update.js', 'install.js', 'pause.js']) {
  const owners = mod === 'pause.js' ? APPS.filter((a) => !NO_PAUSE.includes(a)) : APPS;
  const copies = owners.map((a) => path.join(a, mod)).filter(exists);
  if (copies.length !== owners.length) {
    const missing = owners.map((a) => path.join(a, mod)).filter((p) => !exists(p));
    fail(mod, `expected ${owners.length} copies, found ${copies.length} (missing: ${missing.join(', ')})`);
  }
  // and an app that should NOT have it must not have it either
  if (mod === 'pause.js') {
    for (const a of NO_PAUSE) {
      if (exists(path.join(a, mod))) fail(label(a), 'ships pause.js but has no running clock to freeze');
    }
  }
  const hashes = new Map();
  for (const c of copies) {
    const h = md5(c);
    if (!hashes.has(h)) hashes.set(h, []);
    hashes.get(h).push(c);
  }
  if (hashes.size > 1) {
    const groups = [...hashes.values()].map((g) => `[${g.join(', ')}]`).join(' vs ');
    fail(mod, `copies have drifted apart: ${groups}`);
  }
}

// the vendored three.js must be one library, not four
{
  const copies = GAMES.map((g) => path.join('games', g, 'vendor/three.module.js')).filter(exists);
  const hashes = new Set(copies.map(md5));
  if (hashes.size > 1) fail('vendor/three.module.js', `${copies.length} copies, ${hashes.size} distinct versions`);
}

// ---------------------------------------------------------------------------
// 6. Installability: the head tags and manifest fields that make a PWA a PWA.
// ---------------------------------------------------------------------------
const HEAD_RULES = [
  [/<meta[^>]+name="viewport"[^>]*viewport-fit=cover/, 'viewport meta with viewport-fit=cover'],
  [/<meta[^>]+name="theme-color"/, 'theme-color meta'],
  [/<link[^>]+rel="apple-touch-icon"/, 'apple-touch-icon link'],
  [/<meta[^>]+name="apple-mobile-web-app-capable"/, 'apple-mobile-web-app-capable meta'],
  [/<link[^>]+rel="manifest"/, 'manifest link'],
];

for (const app of APPS) {
  const html = read(path.join(app, 'index.html'));
  for (const [re, what] of HEAD_RULES) {
    if (!re.test(html)) fail(path.join(app, 'index.html'), `missing ${what}`);
  }

  const manifest = JSON.parse(read(path.join(app, 'manifest.webmanifest')));
  for (const [field, want] of [['start_url', '.'], ['scope', '.'], ['display', 'standalone']]) {
    if (manifest[field] !== want) {
      fail(path.join(app, 'manifest.webmanifest'), `${field} is ${JSON.stringify(manifest[field])}, expected "${want}"`);
    }
  }
  const icons = manifest.icons || [];
  if (icons.length < 3) fail(path.join(app, 'manifest.webmanifest'), `${icons.length} icons, expected 3`);
  if (!icons.some((i) => (i.purpose || '').includes('maskable'))) {
    fail(path.join(app, 'manifest.webmanifest'), 'no maskable icon');
  }
  for (const i of icons) {
    const src = i.src.replace(/^\.\//, '');
    if (!exists(app === '' ? src : path.join(app, src))) {
      fail(path.join(app, 'manifest.webmanifest'), `icon '${i.src}' does not exist`);
    }
  }

  // the theme-color meta and the manifest must agree, or the status bar flickers
  const meta = html.match(/<meta[^>]+name="theme-color"[^>]+content="([^"]+)"/);
  if (meta && manifest.theme_color && meta[1].toLowerCase() !== manifest.theme_color.toLowerCase()) {
    fail(path.join(app, 'index.html'), `theme-color meta ${meta[1]} != manifest theme_color ${manifest.theme_color}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Offline is sacred, and the site lives under a GitHub Pages subpath.
// ---------------------------------------------------------------------------
for (const app of APPS) {
  const dir = path.join(ROOT, app || '.');
  const files = fs.readdirSync(dir).filter((f) => /\.(html|js|css|webmanifest)$/.test(f));
  for (const f of files) {
    const src = read(path.join(app, f));
    for (const m of src.matchAll(/["'(](https?:\/\/[^"')\s]+)/g)) {
      // schema/spec URLs inside comments are documentation, not requests
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (/^\s*(\/\/|\*|<!--)/.test(line)) continue;
      fail(path.join(app, f), `external URL ${m[1]} — offline is sacred, everything must be local`);
    }
  }
}

// storage keys are one flat namespace shared by all twelve apps
for (const app of APPS) {
  const dir = path.join(ROOT, app || '.');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = read(path.join(app, f));
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*'([^']+)'/g)) {
      const key = m[1];
      const ok = key === 'am.shell' || key.startsWith(`am.${appName(app)}.`);
      if (!ok) fail(path.join(app, f), `storage key '${key}' is not prefixed am.${appName(app)}.`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Accent drift — a WARNING, deliberately.
//
// Three games drifted from the DESIGN.md table for months and nothing broke.
// A script that fails the build over a nudged hex value is a script people
// start ignoring wholesale, and then it stops catching the things above.
// ---------------------------------------------------------------------------
{
  const design = read('DESIGN.md');
  for (const g of GAMES) {
    const row = design.match(new RegExp(`^\\s*-\\s*${g}:\\s*\`(#[0-9a-fA-F]{6})\``, 'im'));
    if (!row) continue;
    const css = read(path.join('games', g, 'style.css')).match(/--accent:\s*(#[0-9a-fA-F]{6})/);
    if (css && css[1].toLowerCase() !== row[1].toLowerCase()) {
      warn(`games/${g}/style.css`, `--accent ${css[1]} != DESIGN.md ${row[1]}`);
    }
  }
}

// ---------------------------------------------------------------------------

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);

const apps = `${APPS.length} apps`;
if (errors.length) {
  console.log(`\n${errors.length} problem(s) across ${apps}.`);
  process.exit(1);
}
console.log(`\nok — ${apps} clean${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`);
