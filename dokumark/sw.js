const CACHE_NAME = 'dokumark-cache-v10-turmdecker-1';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './jspdf.umd.min.js',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        // Use addAll to fetch and cache all the assets.
        // We use a request with {cache: 'reload'} to bypass the browser's
        // HTTP cache, ensuring we get the latest version from the network.
        return Promise.all(urlsToCache.map(url => {
            return cache.add(new Request(url, {cache: 'reload'}));
        }));
      })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      }
    )
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (/^(dokumap|dokumark)-cache-/.test(cacheName) && cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
