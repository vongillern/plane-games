const CACHE = 'am-hub-v17';

const GAMES = ['2048', 'drop', 'snake', 'glide', 'span', 'runway', 'hop', 'nova', 'breaker', 'carve', 'sink'];
const GAME_FILES = [
  '',
  'index.html',
  'style.css',
  'game.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

const ASSETS = [
  './',
  './index.html',
  './update.js',
  './install.js',
  './style.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './games/drop/vendor/three.module.js',
  './games/runway/vendor/three.module.js',
  './games/carve/vendor/three.module.js',
  './games/sink/vendor/three.module.js',
  './games/carve/rules.js',
  './games/span/physics.js',
  './games/span/levels.js',
];
// 2048 is turn-based: it has no pause.js to cache
const NO_PAUSE = ['2048'];
for (const g of GAMES) {
  for (const f of GAME_FILES) ASSETS.push('./games/' + g + '/' + f);
  ASSETS.push('./games/' + g + '/update.js');
  ASSETS.push('./games/' + g + '/install.js');
  if (NO_PAUSE.indexOf(g) === -1) ASSETS.push('./games/' + g + '/pause.js');
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('am-hub-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Offline and the exact URL isn't cached: navigations fall back to the
// nearest cached page (the game's index.html, else the hub's) so Safari
// never sees a rejected respondWith.
function offlineFallback(req) {
  const isPage = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  if (!isPage) return Response.error();
  const m = new URL(req.url).pathname.match(/\/games\/([^/]+)(\/|$)/);
  const page = m ? './games/' + m[1] + '/index.html' : './index.html';
  return caches.match(page)
    .then((hit) => hit || caches.match('./index.html'))
    .then((hit) => hit || Response.error());
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && new URL(req.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => offlineFallback(req));
    })
  );
});

// the page asks what build it is running (see update.js)
self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) {
    e.source.postMessage({ type: 'version', version: CACHE });
  }
});
