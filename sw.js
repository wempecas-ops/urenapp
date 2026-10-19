// Service worker: zorgt dat de app ook zonder bereik opstart.
// Pagina en afbeeldingen komen eerst van het netwerk (zodat updates direct zichtbaar zijn)
// en vallen terug op de bewaarde kopie. Database-verkeer wordt nooit bewaard.
const NAAM = 'wop-v1';
const BASIS = ['/', '/index.html', '/logo.png', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(NAAM).then(c => c.addAll(BASIS)).then(() => self.skipWaiting())) });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== NAAM).map(n => caches.delete(n)))).then(() => self.clients.claim())) });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  const eigen = u.origin === self.location.origin && !u.pathname.startsWith('/api/');
  const cdn = u.hostname === 'cdn.tailwindcss.com';
  if (!eigen && !cdn) return;
  e.respondWith(
    fetch(r).then(res => { if (res && (res.ok || res.type === 'opaque')) { const kopie = res.clone(); caches.open(NAAM).then(c => c.put(r, kopie)) } return res })
      .catch(() => caches.match(r).then(m => m || (r.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
