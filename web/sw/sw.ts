// Caches the app shell so AmaniCare opens quickly on slow connections. API calls always go to the network.
// Compiled as a classic script (no import/export), because sw.js is registered without type: 'module'.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'amanicare-v6';
const SHELL = ['/', '/index.html', '/app.js', '/monitoring.js', '/styles.css', '/icon.svg', '/manifest.webmanifest',
  '/i18n/fr.json', '/i18n/en.json', '/i18n/ln.json', '/i18n/sw.json'];

sw.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting())));
sw.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => sw.clients.claim()),
));
sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Always the network first: a reload gets the latest deploy. The saved copy (one per file, whatever its ?v=)
  // is only used when there is no connection at all, never when the server answers, even with an error.
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  // (A page request can't be given options; the page itself is sent with no-store.)
  e.respondWith((e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' })).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((r) => r || caches.match('/index.html')).then((r) => r || Response.error())));
});
