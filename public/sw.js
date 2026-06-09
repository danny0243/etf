/* ============================================================
   ETF 股票分析 — Service Worker
   功能：離線快取 + 推播通知接收
   ============================================================ */

const CACHE = 'etf-shell-v20260609m';
const SHELL = [
  '/',
  '/css/style.css?v=20260609m',
  '/css/auth.css?v=20260609m',
  '/js/app.js?v=20260609m',
  '/js/etf-auth.js?v=20260609m',
  '/js/pwa.js?v=20260609m',
  '/js/config.js?v=20260609m',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── 安裝：快取 App Shell ──────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// ── 啟動：清除舊快取 ─────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// ── Fetch：App Shell 快取優先，API 走網路 ─────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API 請求永遠走網路
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Push：收到推播 → 顯示通知 ────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch {}

  const title   = data.title   || '📈 ETF 除息提醒';
  const options = {
    body:    data.body    || '請開啟 App 查看詳情',
    icon:    data.icon    || '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    tag:     data.tag     || 'etf-alert',
    renotify: true,
    data:    { url: data.url || '/' },
    actions: [
      { action: 'open',    title: '查看詳情' },
      { action: 'dismiss', title: '稍後再說' },
    ],
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── NotificationClick：點擊通知開啟 App ──────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
