// ccv-launcher Service Worker. Served at /launcher/sw.js, scope /launcher/.
//
// Purpose: receive Web Push delivery from the OS push service (APNs / FCM)
// and surface a system notification. On iOS PWA this is the ONLY path that
// works in background — `new Notification(...)` from the page is a silent
// no-op once the PWA is suspended.
//
// We DO NOT cache HTML / JS / API responses here. Launcher iterates fast
// and stale caches would mask real bugs. Only the bare minimum is wired:
// claim clients on activate, handle `push` + `notificationclick`.

const SW_VERSION = 'ccv-launcher-1';

self.addEventListener('install', (event) => {
  // Activate ASAP so a freshly-installed PWA can receive pushes without
  // requiring the user to reload twice.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network passthrough. Returning undefined means the browser handles the
// request as if no SW intercepted — which is what we want for /api/launcher
// /* and /ws. Keep this listener empty (don't even register if not needed)
// — registering and then no-op'ing is safe but pointless. Comment kept for
// future contributors so nobody adds caching here without thinking.
//
// self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  // Apple Push will deliver an empty body sometimes (heartbeat / refresh).
  // Spec says we still MUST showNotification when permission was granted
  // via userVisibleOnly:true, otherwise the browser will revoke the sub.
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); } catch { payload = { title: 'ccv', body: event.data.text() }; }
  }
  const title = payload.title || 'ccv launcher';
  const body  = payload.body  || '';
  const data  = payload.data  || {};
  const tag   = data.tag      || `ccv:${data.pid || 'unknown'}:${data.status || 'event'}`;
  const options = {
    body,
    icon: '/launcher/icon.svg',
    badge: '/launcher/icon.svg',
    tag,
    renotify: true,
    data,
  };
  // CRITICAL: event.waitUntil keeps the SW alive until showNotification
  // resolves. Without it, iOS may kill the SW before the OS draws the
  // banner, producing the dreaded "push arrived but no notification".
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetPid = data.pid != null ? Number(data.pid) : null;
  const urlPath = '/launcher';
  event.waitUntil((async () => {
    // Prefer an already-open client (the PWA or a normal tab) so tapping a
    // push focuses what's there instead of spawning a duplicate window.
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      try {
        const u = new URL(c.url);
        if (u.pathname.startsWith('/launcher')) {
          await c.focus();
          c.postMessage({ type: 'notification:navigate', pid: targetPid, tag: event.notification.tag });
          return;
        }
      } catch {}
    }
    await self.clients.openWindow(urlPath);
  })());
});

// Lets the page issue a `postMessage({type:'sw:ping'})` to confirm the SW
// is alive and reachable from the controlled scope. Handy for diagnostic.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'sw:ping') {
    try { event.source && event.source.postMessage({ type: 'sw:pong', version: SW_VERSION }); } catch {}
  }
});
