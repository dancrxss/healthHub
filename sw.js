// Service worker: precache the app shell, cache-first. Bump CACHE_VERSION in
// the same commit as any change to cached asset patterns or request/response
// shapes (CLAUDE.md §3).
const CACHE_VERSION = 'v20';
const CACHE_NAME = `healthhub-${CACHE_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/motion.css',
  './css/app.css',
  './css/screens.css',
  './css/stats.css',
  './css/coach.css',
  './css/home.css',
  './js/util.js',
  './js/motion.js',
  './js/swipe.js',
  './js/exercise-types.js',
  './js/inputs.js',
  './js/csv-import.js',
  './js/settings.js',
  './js/charts.js',
  './js/stats-data.js',
  './js/db.js',
  './js/health.js',
  './js/calc.js',
  './js/queries.js',
  './js/coach-engine.js',
  './js/coach-api.js',
  './js/coach.js',
  './js/sync.js',
  './js/seed.js',
  './js/timer.js',
  './js/ui.js',
  './js/screens/workout.js',
  './js/screens/picker.js',
  './js/screens/log.js',
  './js/screens/routines.js',
  './js/screens/stats.js',
  './js/screens/settings.js',
  './js/screens/coach.js',
  './js/screens/coach-shared.js',
  './js/screens/home.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // The Coach talks to the Claude API directly (POST today); never let a
  // cross-origin API response — of any method — be served from or written to
  // the shell cache.
  if (new URL(event.request.url).hostname === 'api.anthropic.com') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (cached) =>
        cached ||
        fetch(event.request).then((res) => {
          // Cache same-origin GETs opportunistically so new assets self-heal.
          if (res.ok && new URL(event.request.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
    )
  );
});
