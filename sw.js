const SHELL_CACHE = "commute-drive-shell-v3";
const SHELL_FILES = ["./", "./index.html", "./drive.css", "./drive.js", "./drive-config.js", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // Driver code and configuration must update first. Cache is only an offline fallback.
  const isAppShell = event.request.mode === "navigate" || /\.(?:html|js|css|webmanifest)$/.test(requestUrl.pathname);
  if (isAppShell) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("離線且沒有可用的道路資料。", { status: 503, statusText: "Offline" });
  }
}
