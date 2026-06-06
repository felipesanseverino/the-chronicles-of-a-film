const CACHE = 'tcof-v1';
const STATIC = [
  '/',
  '/index.html',
  '/archive.html',
  '/series.html',
  '/style.css',
  '/main.js',
  '/config.js',
  '/manifest.json',
  '/favicon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network-first for Cloudinary images, cache-first for everything else
  if (e.request.url.includes('cloudinary.com') || e.request.url.includes('fonts.googleapis')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      });
      return cached || network;
    })
  );
});
