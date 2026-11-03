const CACHE_NAME = 'noterecall-pwa-v3.0';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'fsrs.js',
  'db.js',
  'manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each asset individually with reload cache policy to ensure freshest version
      for (const url of ASSETS_TO_CACHE) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch (err) {
          console.warn('[NoteRecall SW] Pre-cache item notice for', url, err);
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Bypass API calls (sync, logs, cards) entirely so live status is never stalled
  if (url.pathname.includes('/api/')) {
    return;
  }

  // HTML Navigation Requests (Opening or refreshing the PWA)
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { ignoreSearch: true }).then((cachedIndex) => {
        // Fast race against network with 800ms threshold
        const networkFetch = fetch(req)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return networkResponse;
          })
          .catch(() => cachedIndex);

        if (cachedIndex) {
          // If we have an offline cached index, race it so out-of-range Wi-Fi doesn't freeze the page!
          return Promise.race([
            networkFetch,
            new Promise((resolve) => setTimeout(() => resolve(cachedIndex), 800))
          ]);
        }
        return networkFetch;
      })
    );
    return;
  }

  // App Shell Static Assets (JS, CSS, Manifest, Images): Stale-While-Revalidate
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cachedResponse) => {
      const fetchPromise = fetch(req)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      // Return cached asset immediately for instantaneous 0ms offline rendering!
      return cachedResponse || fetchPromise;
    })
  );
});
