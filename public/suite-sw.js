// Service worker de la suite RR.HH PYMES: SOLO recibe los avisos del centro de
// notificaciones (Web Push) y abre la suite al tocarlos.
// - No guarda nada en caché: la suite siempre carga la versión más reciente.
// - Alcance "/app" (la pantalla principal app.html). El Kiosco usa su propio
//   service worker con alcance "/kiosk", así que no se mezclan.
const SUITE_SW_VERSION = '2026.10-avisos2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'RR.HH PYMES', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'RR.HH PYMES';
  const options = {
    body: data.body || 'Nueva alerta de asistencia.',
    icon: '/suite-icons/icon-192.png',
    badge: '/suite-icons/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/app.html#alertas' },
    lang: 'es-CO',
  };
  // Boton "Ver alerta" (Android). En iPhone no se muestran botones: tocar el aviso hace lo mismo.
  if (Array.isArray(data.actions) && data.actions.length) options.actions = data.actions.slice(0, 1);
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Avisa a la suite abierta para que actualice la campana al instante.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(c => c.postMessage({ type: 'suite-push' }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/app.html#alertas', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find(c => new URL(c.url).pathname.startsWith('/app'));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'suite-open', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version' && event.source) event.source.postMessage({ swVersion: SUITE_SW_VERSION });
});
