const JOURNAL_URL = new URL("./", self.registration.scope).href;
const APP_ICON_URL = new URL("img/farley-trades%20image.png", self.registration.scope).href;

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "Your scheduled alert is due." };
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Farley Trades", {
    body: payload.body || "Your scheduled alert is due.",
    icon: APP_ICON_URL,
    badge: APP_ICON_URL,
    tag: payload.tag || "farley-alert",
    data: { url: payload.url || JOURNAL_URL },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || JOURNAL_URL, self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.focus();
      if ("navigate" in existing && existing.url !== targetUrl) await existing.navigate(targetUrl);
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});