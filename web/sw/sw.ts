// Caches the app shell so AmaniCare opens quickly on slow connections. API calls always go to the network.
// Compiled as a classic script (no import/export), because sw.js is registered without type: 'module'.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'amanicare-v7';
const SHELL = ['/', '/index.html', '/app.js', '/monitoring.js', '/styles.css', '/icon.svg', '/manifest.webmanifest',
  '/i18n/fr.json', '/i18n/en.json', '/i18n/ln.json', '/i18n/sw.json'];

sw.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting())));
sw.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()),
));
sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Files of a given deploy (?v=…) never change: served from the saved copy when there is one, so a reload
  // downloads nothing unless a new version was deployed. Older versions of the same file are dropped.
  if (url.searchParams.has('v')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        await c.put(e.request, res.clone());
        for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) await c.delete(k); }
      }
      return res;
    }).catch(() => caches.match(url.pathname).then((r) => r || Response.error())));
    return;
  }
  // Everything else (the page itself, monitoring.js…): the network checks for a newer copy (a quick 304 when
  // nothing changed); the saved copy is used only when there is no connection at all.
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  // (A page request can't be given options; the server sends the page with no-cache.)
  e.respondWith((e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' })).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((r) => r || caches.match('/index.html')).then((r) => r || Response.error())));
});
