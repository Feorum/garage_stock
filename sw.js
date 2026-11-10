// Service worker: caches the app shell so the app opens fast and works offline.
// Supabase API calls (other origin) are never cached, so data is always live.
const CACHE = 'garage-log-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Password setup and auth callback URLs must always bypass the app cache.
  const authParameters = ['access_token', 'refresh_token', 'token', 'token_hash',
    'code', 'error', 'error_description', 'type'];
  if (url.hash || authParameters.some(name => url.searchParams.has(name)) ||
      e.request.headers.has('Authorization')) return;
  const cacheable = e.request.method === 'GET' &&
    (SHELL_URLS.has(url.href) || url.hostname === 'cdn.jsdelivr.net');
  if (!cacheable) return;
  // stale-while-revalidate: answer from cache, refresh in the background
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request);
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
