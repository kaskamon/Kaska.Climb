// Service worker mínimo: solo existe para que el navegador considere la app
// "instalable" (icono en el móvil, pantalla completa sin barra de navegador).
// Estrategia network-first — nunca sirve una versión vieja en caché mientras
// haya conexión, así los cambios que subimos se ven al momento. Solo cae a
// caché si de verdad no hay red.
const CACHE_NAME = 'kaska-climb-v2';
const urlsToCache = [
  './',
  './index.html',
  './login.html',
  './manifest.json',
  './manifest-cliente.json',
  './logo-192.png',
  './logo-512.png',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)).catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // No tocar nada que no sea GET (los envíos de sesión, publicaciones, etc.
  // van siempre directos a la red, nunca a través de la caché).
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
