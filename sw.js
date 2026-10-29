// Fa funzionare il sito anche con poca rete: file del sito e dati dalla rete se possibile, altrimenti dalla copia salvata.
const CACHE = 'milano-ztl-v7';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'manifest.webmanifest',
  'data/rules.json', 'data/zones.geojson', 'data/varchi.geojson', 'data/meta.json', 'data/avoid.geojson',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (sameOrigin) {
    // prima la rete, così i dati aggiornati arrivano subito
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  } else {
    // librerie, font e mappa: prima la copia salvata, poi la rete
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    })));
  }
});
