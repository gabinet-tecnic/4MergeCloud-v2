// Service Worker — Merge Cloud PWA
// redeploy: re-trigger GitHub Pages (deploy encallat)
const CACHE = 'mergecloud-v56';

const ASSETS = [
  './index.html',
  './index-ca.html',
  './main.js',
  './editor2d.js',
  './manifest.json',
  './three/three.module.js',
  './jsm/controls/OrbitControls.js',
  './jsm/controls/TransformControls.js',
  './loaders/pointcloud_loaders.js',
  './loaders/PLYLoader.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Instal·lació: precacheja tots els recursos de l'app
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      // addAll falla si un fitxer no existeix — usem add individual per ser tolerants
      return Promise.allSettled(ASSETS.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

// Activació: esborra caches antigues
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first (evita caches obsoletes al mòbil)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      // Offline: servim des de la caché
      return caches.match(event.request).then(cached => cached || caches.match('./index.html'));
    })
  );
});
