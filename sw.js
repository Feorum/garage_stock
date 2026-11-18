// The release builder substitutes the application entry's complete public module graph.
// Waiting for previous tabs to close keeps a single release in each running app.
const CACHE_PREFIX = 'garage-log-';
const RELEASE = '__GARAGE_RELEASE__';
const CACHE = CACHE_PREFIX + RELEASE;
const SHELL = __GARAGE_SHELL__;
const urls = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(
    SHELL.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' }))
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  // The exact URL allowlist excludes callbacks, password pages, queries and RPC data.
  if (request.method !== 'GET' || request.headers.has('Authorization') || !urls.has(request.url)) return;
  event.respondWith(caches.open(CACHE).then(async cache =>
    await cache.match(request) || await fetch(request)
  ));
});
