// Service worker del Kiosco RR.HH (app instalable para Android y iOS).
// - Guarda en el equipo la pantalla del kiosco, sus íconos y las librerías
//   (Tailwind, íconos, motor y modelo de reconocimiento facial), para que la
//   app abra y reconozca rostros aunque no haya internet.
// - NUNCA guarda respuestas de /api/: las marcaciones siempre van al servidor
//   (o a la cola sin conexión que ya maneja kiosk.html).
// IMPORTANTE: cada vez que se modifique kiosk.html, subir KIOSK_SW_VERSION
// para que las tablets instaladas se actualicen solas.
const KIOSK_SW_VERSION = '2026.10-app1';
const CORE_CACHE = 'kiosco-core-' + KIOSK_SW_VERSION;
const CDN_CACHE = 'kiosco-cdn-v1'; // librerías y modelo facial: se conservan entre versiones

const CORE_FILES = [
  '/kiosk.html',
  '/kiosk.webmanifest',
  '/kiosk-icons/icon.svg',
  '/kiosk-icons/icon-192.png',
  '/kiosk-icons/apple-touch-icon.png',
  '/kiosk-icons/favicon-32.png',
];
// Se piden igual que las pide la página (<script>/<link> sin CORS).
const CDN_FILES = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js',
];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    await core.addAll(CORE_FILES.map(u => new Request(u, { cache: 'reload' })));
    // Librerías externas: si alguna falla no se bloquea la instalación;
    // se guardarán la primera vez que la página las use.
    const cdn = await caches.open(CDN_CACHE);
    await Promise.all(CDN_FILES.map(async (u) => {
      try {
        if (await cdn.match(u)) return;
        const r = await fetch(new Request(u, { mode: 'no-cors' }));
        if (r && (r.ok || r.type === 'opaque')) await cdn.put(u, r);
      } catch (e) { /* sin internet en este momento */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('kiosco-') && k !== CORE_CACHE && k !== CDN_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version' && event.source) event.source.postMessage({ swVersion: KIOSK_SW_VERSION });
});

async function networkFirstPage(request) {
  const core = await caches.open(CORE_CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const fresh = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (fresh && fresh.ok) core.put('/kiosk.html', fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await core.match('/kiosk.html');
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone()).catch(() => {});
  return fresh;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request).then((fresh) => {
    if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  }).catch(() => null);
  if (cached) return cached;
  const fresh = await refresh;
  if (fresh) return fresh;
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return; // datos siempre en vivo
    if (url.pathname === '/kiosk.html' || (req.mode === 'navigate' && url.pathname.startsWith('/kiosk'))) {
      event.respondWith(networkFirstPage(req));
      return;
    }
    if (url.pathname.startsWith('/kiosk-icons/') || url.pathname === '/kiosk.webmanifest') {
      event.respondWith(cacheFirst(req, CORE_CACHE));
    }
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // Modelo facial (archivos grandes que no cambian): primero lo guardado.
    if (url.pathname.includes('/face-api/model/')) {
      event.respondWith(cacheFirst(req, CDN_CACHE));
      return;
    }
    event.respondWith(staleWhileRevalidate(req, CDN_CACHE));
  }
});
