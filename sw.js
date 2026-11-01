// App files: network first, so updates show up immediately; the cache makes them work
// offline. Recordings: cache first, since they are large and never change under a name.
const CACHE = 'meditation-sounds-v3';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'audio.js',
  'synth.js',
  'icons.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

const fromNetwork = (req) =>
  fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/sounds/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fromNetwork(req)));
  } else {
    e.respondWith(fromNetwork(req).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
