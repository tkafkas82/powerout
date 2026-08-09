/*
 * Shell is cache-first (so the app opens offline with the last render), API is
 * network-only — a stale outage schedule is worse than no schedule.
 *
 * The push handler is what makes notifications work with the app closed: the
 * server sends to the browser vendor's push service, which wakes this worker.
 */
const CACHE = 'power-outages-v3';
// The 17 launch images are deliberately absent: iOS requests only the one that
// matches the device, and the runtime cache below picks it up on first launch.
// Precaching all of them would cost ~460 KB on install to no benefit.
const SHELL = [
  '.', 'index.html', 'styles.css', 'app.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // always live

  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
    )
  );
});

// ---- push --------------------------------------------------------------------
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }

  const title = data.title || '⚡ Διακοπή ρεύματος';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // A stable tag per event replaces an earlier notification about the same
      // outage instead of stacking duplicates.
      tag: data.tag || 'outage',
      renotify: true,
      timestamp: Date.now(),
      data: { url: data.url || './' }
    })
  );
});

// Focus an existing window if the app is already open, rather than piling up tabs.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.navigate?.(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// Chrome can retire a subscription and hand us a new one; re-register it so the
// device doesn't silently stop receiving pushes.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!applicationServerKey) return;
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    const settings = await readSettings();
    await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub, areas: settings.areas, leadHours: settings.leadHours })
    });
  })());
});

// The worker can't read localStorage, so app.js mirrors what the server needs
// into a cached JSON response under this synthetic URL.
async function readSettings() {
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match('push-settings.json');
    if (res) return await res.json();
  } catch { /* fall through */ }
  return { areas: [], leadHours: 24 };
}
