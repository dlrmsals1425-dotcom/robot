const CACHE_NAME = "safebot-shell-blue-v1";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest?theme=blue-v1",
  "/icons/icon-192-blue-v1.png",
];
const APP_SHELL_PATHS = ["/", "/manifest.webmanifest"];
const STATIC_PREFIXES = [
  "/assets/",
  "/icons/",
  "/models/",
  "/mediapipe/",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (
    requestUrl.pathname.startsWith("/api/") ||
    requestUrl.pathname === "/control" ||
    requestUrl.pathname.startsWith("/control/")
  ) {
    return;
  }

  const isStaticAsset =
    APP_SHELL_PATHS.includes(requestUrl.pathname) ||
    STATIC_PREFIXES.some((prefix) => requestUrl.pathname.startsWith(prefix));
  if (!isStaticAsset) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (
            event.request.mode === "navigate" &&
            requestUrl.pathname === "/"
          ) {
            return caches.match("/");
          }
          return Response.error();
        }),
      ),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() };
  }

  event.waitUntil(
    self.registration.showNotification(
      payload.title || "SAFEBOT · 안전 관제 알림",
      {
        body:
          payload.body ||
          "현장에서 안전 확인이 필요한 이벤트가 감지되었습니다.",
        icon: "/icons/icon-192-blue-v1.png",
        badge: "/icons/icon-192-blue-v1.png",
        tag: payload.tag || "safebot-control-center",
        data: { url: payload.url || "/?event=latest" },
      },
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || "/",
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(
      (clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      },
    ),
  );
});
