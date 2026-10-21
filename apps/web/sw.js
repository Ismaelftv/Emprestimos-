// Cache só dos arquivos do app (abre mesmo sem internet). NUNCA guarda respostas da API: dados financeiros e documentos não ficam em cache.
const C = 'caixa-v5', FILES = ['./', './index.html', './api.js', './app.js', './portal.js', './extras.js', './main.js', './app.css', './styles.css', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request)));
});
// avisos push (vencimentos etc.) — funcionam com o app fechado
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { /* sem corpo */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Caixa', { body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: d.tag || 'caixa', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => { for (const c of list) if ('focus' in c) return c.focus(); return self.clients.openWindow(url); }));
});
