// Minimal app-shell cache. Streams are NEVER cached.
const CACHE = 'mytv-v10';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './catalog.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (/\.(m3u8|ts|mp3|aac|mp4)(\?|$)/i.test(url.pathname)) return;

  // Network-first per file dell'app (index, css, js): aggiornamenti veloci.
  // cache 'no-cache': GitHub Pages manda max-age=600, senza questo per 10 minuti tornava la versione vecchia.
  if (/\/(index\.html|styles\.css|app\.js|catalog\.js)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return resp;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Cache-first per il resto (icone, manifest)
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
