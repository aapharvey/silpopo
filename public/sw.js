// Silpopo — service worker: зберігає оболонку застосунку, щоб список відкривався в магазині без інтернету.
// Дані списку кешує сам застосунок (localStorage); запити /api/* сюди не потрапляють.
const CACHE = "silpopo-shell-v2";
const SHELL = ["/", "/app.css", "/app.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/favicon-32.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== location.origin && !fonts) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/telegram/") || url.pathname.startsWith("/atb/")) return;

  if (fonts) {
    // Шрифти не змінюються — спершу з кешу.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Свій код — спершу з мережі (щоб оновлення приходили одразу), без мережі — з кешу.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "/" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req.mode === "navigate" ? "/" : req).then((hit) => hit || caches.match("/"))),
  );
});
