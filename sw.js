// One complete module graph per version. A waiting update activates after the
// previous app tabs close, rather than replacing modules under a running page.
const CACHE_PREFIX = 'garage-log-';
const CACHE = `${CACHE_PREFIX}v4`;
const SHELL = [
  './', './index.html', './styles.css', './app.js',
  './src/supabase.js', './src/auth.js', './src/ui.js',
  './src/navigation.js', './src/views.js', './src/catalogue.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
];
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key))
  )));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const authParameters = [
    'access_token', 'refresh_token', 'token', 'token_hash',
    'code', 'error', 'error_description', 'type',
  ];
  // Password pages, callbacks, user/API data and authorization-bearing requests
  // never enter this cache. Only explicitly listed public assets are local.
  if (request.method !== 'GET' || url.hash ||
      request.headers.has('Authorization') ||
      authParameters.some(name => url.searchParams.has(name))) return;
  const isShell = SHELL_URLS.has(url.href);
  const isDependency = url.origin === 'https://cdn.jsdelivr.net' && url.pathname.startsWith('/npm/');
  if (!isShell && !isDependency) return;

  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone()).catch(() => {});
    return response;
  }));
});
