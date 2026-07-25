const CACHE = 'am-hub-v9';

const GAMES = ['2048', 'drop', 'snake', 'glide', 'span', 'runway', 'hop', 'nova', 'breaker', 'carve'];
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
  './style.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './games/drop/vendor/three.module.js',
  './games/runway/vendor/three.module.js',
  './games/carve/vendor/three.module.js',
  './games/span/physics.js',
  './games/span/levels.js',
];
for (const g of GAMES) {
  for (const f of GAME_FILES) ASSETS.push('./games/' + g + '/' + f);
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
  return caches.match(page).then((hit) => hit || caches.match('./index.html'));
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
