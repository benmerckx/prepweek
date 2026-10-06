// Offline support. The data is already local-first (IndexedDB), so all this
// has to do is make the app itself load without a network:
//  - pages: network first, falling back to the cached app shell (any
//    /s/<sheet> URL is the same single-page app);
//  - hashed bundles, fonts and icons: cache first (their names change when
//    their content does);
//  - sync, presence, files, sharing and the account API go straight to the network.

const CACHE = 'prepweek-v2';
const SHELL = '/';
const LIVE = /^\/(sync|presence|files|share|api|auth)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([SHELL, '/manifest.webmanifest', '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || LIVE.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(SHELL, copy));
          }
          return res;
        })
        .catch(() => caches.match(SHELL).then((r) => r ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
