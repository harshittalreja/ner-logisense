// NER-LogiSense service worker: makes the driver app open and work with no signal.
//   app shell  -> network-first with the pre-cached copy as offline fallback
//   /network   -> network-first, falls back to the cached corridor graph
//   map tiles  -> cache-first (OpenFreeMap / Esri); tiles seen once stay available offline
//   everything else (API POSTs, live data) -> straight to the network
const SHELL = "ner-shell-v5";
const TILES = "ner-tiles-v1";
const DATA = "ner-data-v1";
const SHELL_FILES = [
  "/driver", "/static/css/app.css", "/static/js/common.js", "/static/js/driver.js",
  "/static/vendor/maplibre-gl.js", "/static/vendor/maplibre-gl.css", "/static/manifest.json", "/static/icons/icon.svg",
  // built-in map: works with no signal
  ...["countries", "states", "lakes", "rivers", "railways", "highways", "places", "regionlabels"].map((f) => `/static/basemap/${f}.geojson`),
  ...["Regular", "Semibold", "Italic", "Bold"].flatMap((w) => ["0-255", "8192-8447"].map((r) => `/static/fonts/OpenSans-${w}/${r}.pbf`)),
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES, DATA].includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const mapHost = url.hostname === "tiles.openfreemap.org" || url.hostname === "server.arcgisonline.com";
  if (mapHost && url.pathname.startsWith("/styles/")) {       // style JSON: fresh when online, cached copy offline
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(TILES).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req)));
    return;
  }
  if (mapHost) {                                               // tiles, fonts, sprites: cache-first
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; }
      catch { return new Response("", { status: 504 }); }
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname === "/network") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req)));
    return;
  }
  if (url.pathname === "/driver" || url.pathname.startsWith("/static/")) {
    // network-first so code updates show up immediately; the cached copy is the offline fallback
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(url.pathname === "/driver" ? "/driver" : req, copy)); }
      return res;
    }).catch(() => caches.match(url.pathname === "/driver" ? "/driver" : req)));
  }
});
