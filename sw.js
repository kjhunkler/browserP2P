const APP_VERSION = "2.4.8";
const CACHE_NAME = `browserp2p-${APP_VERSION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/games/digger.js",
  "./js/games/air-hockey.js",
  "./js/games/paint-panic.js",
  "./js/games/tower.js",
  "./js/games/gentle-rain.js",
  "./js/peer-net.js",
  "./manifest.webmanifest",
  "./icons/robot.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith("browserp2p-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((response) => {
          if (response && (response.ok || response.type === "opaque")) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || fetched;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "GET_VERSION") {
    event.source?.postMessage({ type: "VERSION", version: APP_VERSION });
  }

  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

  if (event.data?.type === "REFRESH_APP_SHELL") {
    event.waitUntil(
      refreshAppShell()
        .then(() => event.ports[0]?.postMessage({ ok: true, version: APP_VERSION }))
        .catch((error) => event.ports[0]?.postMessage({ ok: false, error: error.message }))
    );
  }
});

async function refreshAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const stamp = Date.now();
  const results = await Promise.allSettled(APP_SHELL.map(async (url) => {
    const bust = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${bust}cache-bust=${stamp}`, { cache: "reload" });
    if (!(response.ok || response.type === "opaque")) throw new Error(`Failed to refresh ${url}`);
    await cache.put(url, response);
  }));
  if (results.every((result) => result.status === "rejected")) throw new Error("No files refreshed.");
}
