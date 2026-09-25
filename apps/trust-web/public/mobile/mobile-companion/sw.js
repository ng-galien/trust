self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("TRUST", {
      body: "A new mobile update is available.",
      icon: "/mobile/mobile-companion/icon-192.png",
      badge: "/mobile/mobile-companion/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const destination = new URL("/mobile/mobile-companion/", self.location.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const current = windows.find((client) => new URL(client.url).pathname.startsWith("/mobile/mobile-companion"));
      if (current) {
        await current.navigate(destination.href);
        await current.focus();
      } else await self.clients.openWindow(destination.href);
    })(),
  );
});
