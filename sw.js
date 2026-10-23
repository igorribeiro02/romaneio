/* Service worker: abre o app sem internet e guarda os pedaços de mapa já vistos. */
const VERSION = 'romaneio-v5';
const SHELL = [
  './', './index.html', './core.js', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
const TILE_CACHE = 'romaneio-tiles';
const TILE_LIMIT = 2000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > TILE_LIMIT) await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Mapa de fundo: usa o que já tem e atualiza em segundo plano
  if (url.hostname === 'tile.openstreetmap.org' || url.hostname === 'server.arcgisonline.com') {
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); trimTiles(); } return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // Busca de ruas: sempre rede (o app guarda as respostas por conta própria)
  if (url.hostname.endsWith('nominatim.openstreetmap.org')) return;
  // App e bibliotecas: rede primeiro (pega atualização na hora), cache se estiver sem internet
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && (url.origin === location.origin || url.hostname.endsWith('cdnjs.cloudflare.com') || url.hostname.endsWith('fonts.gstatic.com') || url.hostname.endsWith('fonts.googleapis.com'))) {
      const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request).then(m => m || caches.match('./index.html'))));
});
