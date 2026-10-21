// Service worker of the team app: shows Web Push notifications and opens the right page when one is clicked (docs/NOTIFICATIONS.md).
// It does nothing else: no caching, no offline mode, no network interception.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (_) {
    d = {};
  }
  const tag = typeof d.tag === "string" ? d.tag : undefined;
  event.waitUntil(
    self.registration.showNotification(typeof d.title === "string" ? d.title : "Conversations", {
      body: typeof d.body === "string" ? d.body : "",
      tag,
      // a new missed call replaces the old one and alerts again
      renotify: !!(tag && tag.startsWith("call")),
      data: { url: typeof d.url === "string" ? d.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  // only pages of this app: a payload cannot send the click anywhere else
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if (new URL(c.url).origin === target.origin) {
          if ("navigate" in c) await c.navigate(target.href).catch(() => undefined);
          return c.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
