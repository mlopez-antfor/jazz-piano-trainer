// Service worker: guarda la app en el iPad para abrirla sin conexión.
// Solo se registra en la versión publicada (https), no en el Mac.
// Estrategia: primero la red (así siempre llega la última versión) y, si no
// hay conexión, la copia guardada. Las muestras de piano no cambian: primero
// la copia.
const CACHE = 'jpt-20261114232229';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const isSample = /\/sonidos\//.test(new URL(req.url).pathname);
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isSample) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.status === 200) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
