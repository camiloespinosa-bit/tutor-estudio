// Guarda la app en el dispositivo para que abra rápido y sin conexión.
// Las llamadas a la IA (openrouter.ai) nunca se guardan en caché.
const VERSION = 'tutor-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'js/db.js', 'js/docs.js', 'js/llm.js', 'js/prompts.js', 'js/srs.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/marked.min.js', 'vendor/purify.min.js', 'vendor/mermaid.min.js',
  'js/diagrams.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Primero la red (para recibir siempre la versión nueva) y, si no hay conexión, la copia guardada.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
