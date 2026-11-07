/* Word Atlas offline cache: app shell network-first, everything else cache-first. */
const VERSION = "atlas-v1";
const SHELL = `${VERSION}-shell-2`;
const MEDIA = `${VERSION}-media`;
const localPreview = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const atlasPath = new URL("atlas/", self.registration.scope).pathname;
const legacySoundPath = new URL("sfx/", self.registration.scope).pathname;

async function removeLegacySounds() {
  const cache = await caches.open(SHELL);
  const keys = await cache.keys();
  await Promise.all(keys.filter((req) => new URL(req.url).pathname.startsWith(legacySoundPath)).map((req) => cache.delete(req)));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("atlas-") && k !== SHELL && k !== MEDIA).map((k) => caches.delete(k))))
      .then(removeLegacySounds)
      .then(() => self.clients.claim()),
  );
});

async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith(legacySoundPath)) {
    event.respondWith(new Response(null, { status: 404 }));
    return;
  }
  if (req.headers.has("range")) return;
  if (localPreview && !url.pathname.startsWith(atlasPath)) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }
  if (!localPreview && url.pathname === `${atlasPath}index.json`) {
    const refresh = fetch(req).then(async (res) => {
      if (res.ok) {
        const cache = await caches.open(SHELL);
        await cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    });
    event.respondWith(caches.match(req).then((hit) => hit || refresh));
    event.waitUntil(refresh.catch(() => {}));
    return;
  }
  const isShell = req.mode === "navigate" || url.pathname.endsWith("/index.json");
  if (isShell) {
    event.respondWith(
      fetch(req, localPreview ? { cache: "no-store" } : undefined)
        .then(async (res) => {
          if (res.ok) {
            const cache = await caches.open(SHELL);
            await cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (hit) return hit;
          if (req.mode === "navigate") {
            const home = await caches.match(new URL("./", self.registration.scope).href);
            if (home) return home;
          }
          return new Response(null, { status: 503 });
        }),
    );
    return;
  }
  const isMedia = /\/atlas\/(img|thumb|audio)\//.test(url.pathname);
  // A retry bypasses a failed browser request without storing duplicate images.
  if (isMedia) url.searchParams.delete("retry");
  const cacheKey = isMedia ? url.href : req;
  event.respondWith(
    caches.match(cacheKey).then(
      (hit) =>
        hit ||
        fetch(req).then(async (res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            const name = isMedia ? MEDIA : SHELL;
            try {
              const cache = await caches.open(name);
              await cache.put(cacheKey, copy);
              if (name === MEDIA) await trim(MEDIA, 1500);
            } catch {
              // A full cache should not prevent a successful network response.
            }
          }
          return res;
        }),
    ),
  );
});
