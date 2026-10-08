// app shell: network-first (always fresh when online); map tiles: cache-first
const SHELL = 'shell-v1', TILES = 'tiles-v1';
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org', 'basemaps.cartocdn.com'];
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(req.url, r.clone()); return r; } catch { return hit || Response.error(); }
    }));
    return;
  }
  if (url.hostname === 'nominatim.openstreetmap.org') return;
  e.respondWith(fetch(req).then(r => {
    if (r.ok && (url.origin === location.origin || /unpkg|jsdelivr|cdnjs|fonts\.g/.test(url.hostname))) {
      const copy = r.clone(); caches.open(SHELL).then(c => c.put(req, copy));
    }
    return r;
  }).catch(() => caches.match(req)));
});
