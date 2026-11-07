// Renshuu Offline service worker: keeps the app usable without internet.
const CACHE = 'rso-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/rso.js')) return; // only used online, on renshuu.org
  // stale-while-revalidate: answer from cache instantly, refresh in background when online
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = e.request.mode === 'navigate' ? './index.html' : e.request;
    const cached = await c.match(key, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => cached);
    return cached || net;
  }));
});
