const CACHE = 'am-drop-v7';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './update.js',
  './pause.js',
  './manifest.webmanifest',
  './vendor/three.module.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('am-drop-') && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => hit);
    })
  );
});

// the page asks what build it is running (see update.js)
self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) {
    e.source.postMessage({ type: 'version', version: CACHE });
  }
});
