/*
 * Service worker. Only active when the app is served over http(s), not from file://.
 *  - Receives images shared from other apps (Web Share Target) and hands them to the page.
 *  - Keeps the app files cached so it opens offline.
 */
const CACHE = 'trip-splitter-v3';
const ASSETS = [
  './', './index.html', './styles.css', './money.js', './sample.js', './billparse.js', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'shared-files').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('image');
        if (file && typeof file !== 'string') {
          const cache = await caches.open('shared-files');
          await cache.put('shared-image', new Response(file, { headers: { 'content-type': file.type || 'image/png' } }));
        }
      } catch (err) { /* fall through and just open the app */ }
      return Response.redirect(new URL('./index.html?shared=1', self.registration.scope).href, 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network first so updates show up; cached copy when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
