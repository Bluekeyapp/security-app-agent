const CACHE_NAME = "security-patrol-agent-v12";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles/app.css?v=68",
  "./src/app.js?v=68",
  "./src/agentRemoteStore.js?v=66",
  "./src/config.js",
  "./src/patrol.js",
  "./src/supabaseClient.js",
  "./src/storage.js?v=63",
  "./manifest.webmanifest",
  "./assets/sab-agent-logo.png",
  "./assets/sab-agent-apple-touch-icon.png"
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
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || response.status !== 200 || response.type === "opaque") {
          return response;
        }

        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return event.request.mode === "navigate" ? caches.match("./index.html") : Response.error();
      }))
  );
});
