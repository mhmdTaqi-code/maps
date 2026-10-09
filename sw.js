// Caching strategy
//  - the page (index.html): network first with a 3.5 s timeout, cached copy when offline -> new versions
//    show on the next open; the page reloads itself once when a new worker takes over
//  - versioned app files, data and pinned CDN libraries: precached, cache first (URLs change per version)
//  - map tiles: cache-first, capped so the phone's storage doesn't fill up
// Bump VERSION whenever app.js / app.css / index.html / data/* change (keep DATA_VERSION in app.js in sync).
const VERSION = '31';
const SHELL = `shell-v${VERSION}`, TILES = 'tiles-v2', TILE_LIMIT = 4000;
const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org', 'basemaps.cartocdn.com'];
const DATA = ['heritage', 'buildings', 'streets', 'site', 'landmarks', 'context_buildings', 'cad_contours', 'places', 'heritage_points'].map(n => `data/${n}.json?v=${VERSION}`);
const PRECACHE = [
  './', 'index.html', `app.css?v=${VERSION}`, `app.js?v=${VERSION}`, 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  `data/plan_corners.json?v=${VERSION}`, ...DATA,
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/@geoman-io/leaflet-geoman-free@2.17.0/dist/leaflet-geoman.css',
  'https://unpkg.com/@geoman-io/leaflet-geoman-free@2.17.0/dist/leaflet-geoman.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@7.1.0/turf.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith('shell-') && k !== SHELL) || (k.startsWith('tiles-') && k !== TILES)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES), keys = await c.keys();
  if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => c.delete(k)));
}
let trimTimer;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok) { c.put(req.url, r.clone()); clearTimeout(trimTimer); trimTimer = setTimeout(trimTiles, 5000); }
        return r;
      } catch { return Response.error(); }
    }));
    return;
  }
  if (url.hostname === 'nominatim.openstreetmap.org') return;   // live search, never cached

  const sameOrigin = url.origin === location.origin;
  const cacheable = sameOrigin || /unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!cacheable) return;

  // the page itself: network first (so a new version shows on the very next open), cache if offline/slow
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(SHELL).then(async c => {
      // no-cache: always ask the server (a cheap 304 when nothing changed) instead of the browser's 10-minute copy
      const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => { if (r.ok) c.put('index.html', r.clone()); return r; });
      const slow = new Promise(res => setTimeout(res, 3500, null));
      try {
        const r = await Promise.race([net, slow]);
        if (r) return r;
      } catch {}
      return (await c.match('index.html')) || net;
    }));
    return;
  }
  // versioned assets, data and pinned libraries never change under the same URL: cache first
  e.respondWith(caches.open(SHELL).then(async c => {
    const hit = await c.match(req);
    if (hit) return hit;
    try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }
    catch { return Response.error(); }
  }));
});
