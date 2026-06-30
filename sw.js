const CACHE_NAME = 'escalada-pwa-v1';
const urlsToCache = [
  './',
  './index.html',
  './Macrociclos.html', 
  './Semanas.html',
  './Sesiones.html',
  './manifest.json',
  './icono-192x192.png',
  './icono-512x512.png'
  // Añade aquí cualquier archivo .css o .js extra que utilices
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});