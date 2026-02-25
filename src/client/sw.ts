const CACHE_NAME = 'copilot-uplink-v1';
const SHELL_URLS = ['/', '/index.html', '/style.css'];

self.addEventListener('install', (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
});

self.addEventListener('fetch', (event: any) => {
  // Network-first for API/WS, cache-first for shell
  if (event.request.url.includes('/ws')) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});