/* Production static shell only. No payroll data, authentication tokens or credentials. */
const REVISION = "pga-crew-clock-v30-vacation-b-20261029";
const CACHE = REVISION;
const PREFIX = 'pga-crew-clock-v30-';
const BASE = new URL('./', self.registration.scope);
const url = path => new URL(path, BASE).href;
const SHELL = ['./','index.html','app.js?v='+REVISION,'offline-outbox.js',
  'styles.css?v='+REVISION,'manifest.webmanifest','assets/PINNACLE.png',
  'assets/app-icon-32-v2.png','assets/app-icon-180-v2.png',
  'assets/app-icon-192-v2.png','assets/app-icon-512-v2.png',
  'assets/app-icon-maskable-512-v2.png'].map(url);
const PATHS = new Set(SHELL.map(value => new URL(value).pathname));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const replies = await Promise.all(SHELL.map(value => fetch(new Request(value, {cache:'reload'}))));
    if (replies.some(reply => !reply.ok)) throw Error('Incomplete release shell; current version retained.');
    const cache = await caches.open(CACHE);
    await Promise.all(replies.map((reply,i) => cache.put(SHELL[i],reply)));
    await cache.put(url('.shell-complete'),new Response(REVISION));
    // No skipWaiting here: existing pages/active shifts are not forced to update.
  })());
});
self.addEventListener('activate', event => {
  // Preserve old shell caches, all IndexedDB stores and all localStorage records.
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', event => {
  if (!event.source || !event.source.url?.startsWith(BASE.href)) return;
  if (event.data?.type === 'V30_SHELL_VERSION') event.ports?.[0]?.postMessage({revision:REVISION});
  if (event.data?.type === 'V30_ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
async function fallback(request) {
  const cache = await caches.open(CACHE);
  if (!(await cache.match(url('.shell-complete')))) return Response.error();
  const exact = await cache.match(request, {ignoreSearch:false});
  if (exact) return exact;
  if (request.mode === 'navigate') return await cache.match(url('index.html')) || Response.error();
  return Response.error();
}
self.addEventListener('fetch', event => {
  const target = new URL(event.request.url);
  if (event.request.method !== 'GET' || target.origin !== BASE.origin || !PATHS.has(target.pathname)) return;
  event.respondWith((async () => {
    try { return await fetch(event.request); }
    catch { return fallback(event.request); }
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const notification = payload.notification || {};
  const data = payload.data || {};
  const webpush = payload.webpush || {};
  const fcmOptions = payload.fcmOptions || webpush.fcm_options || webpush.fcmOptions || {};
  const title = notification.title || payload.title || data.title || "PGA Crew Clock";
  const body = notification.body || payload.body || data.body || "Tap to open Crew Clock.";
  const url = fcmOptions.link || notification.click_action || payload.url || data.url || "./index.html";
  const tag = notification.tag || payload.tag || data.tag || "pga-crew-clock-reminder";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: false,
      icon: "./assets/app-icon-192-v2.png",
      badge: "./assets/app-icon-192-v2.png",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./index.html", self.location.href).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => client.url.startsWith(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});
