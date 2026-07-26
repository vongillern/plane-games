const CACHE = 'am-snake-v8';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './update.js',
  './install.js',
  './pause.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

// Prune this app's own generations only — a bare `k !== CACHE` sweeps away
// the hub's cache and every sibling's along with it.
const PREFIX = CACHE.replace(/v\d+$/, '');

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Offline and the exact URL isn't cached: a navigation falls back to this
// app's own page, so Safari never sees a rejected respondWith. A failed
// *subresource* must not get index.html back — the wrong MIME type turns a
// missing module into a silent black screen, so it fails honestly instead.
function offlineFallback(req) {
  const isPage = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  if (!isPage) return Response.error();
  return caches.match('./index.html').then((hit) => hit || Response.error());
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
