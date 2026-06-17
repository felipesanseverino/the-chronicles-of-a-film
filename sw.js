const CACHE = 'tcof-identity-v4';
const STATIC = [
  '/',
  '/index.html',
  '/archive.html',
  '/series.html',
  '/publisher.html',
  '/style.css',
  '/main.js',
  '/publisher.css',
  '/publisher.js',
  '/publisher-config.js',
  '/config.js',
  '/manifest.json',
  '/publisher-manifest.json',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/assets/tcof-studio-app-icon.png',
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
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first for remote images and fonts, cache-first for static local files.
  if (e.request.url.includes('cloudinary.com') || e.request.url.includes('fonts.googleapis')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
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
