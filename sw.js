// Сервис-воркер журнала 24ДММ-2.
// Стратегия: "сначала сеть" для своих страниц (index.html, cabinet.html) — если сеть есть,
// пользователь всегда видит самую свежую версию сайта, кэш используется только как запасной
// вариант при отсутствии связи. data.json НИКОГДА не кэшируется — иначе застревали бы
// старые пропуски. Внешние CDN-скрипты (Bootstrap, Chart.js и т.д.) не трогаем — их кэширует
// сам браузер через обычный HTTP-кэш.
//
// ВАЖНО: при каждом заметном обновлении index.html/cabinet.html стоит поднять CACHE_VERSION —
// это гарантированно подчистит старый кэш при следующем заходе. Ту же цифру — в ?v= у app.css и
// shared.js в index.html и cabinet.html, чтобы новая страница никогда не взяла старые стили/скрипт.
// Свои файлы запрашиваем мимо HTTP-кэша браузера (сервер ответит «не изменилось», если файл тот же):
// иначе после деплоя телефон мог получить новую страницу со старым app.css.
const CACHE_VERSION = 'journal-24dmm2-v23';

const PRECACHE_URLS = [
  './env.js',
  './study-days.json',
  './changelog.js',
  './theme.js',
  './schedule.js',
  './notify.js',
  './index.html',
  './cabinet.html',
  './app.css',
  './fonts/Inter-cyrillic.woff2',
  './fonts/Inter-cyrillic-ext.woff2',
  './fonts/Inter-latin.woff2',
  './profile.css',
  './achievements.css',
  './badges.js',
  './achievements.js',
  './shared.js',
  './profile.js',
  './studak.js',
  './pass.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // data.json — только из сети, никогда не перехватываем и не кэшируем
  if (url.pathname.endsWith('data.json')) return;

  // Supabase (вход, профиль, аватарки) — только сеть, никогда не кэшируем
  if (url.hostname.endsWith('.supabase.co')) return;

  // Чужие домены (CDN) не трогаем — пусть работает обычный HTTP-кэш браузера
  if (url.origin !== self.location.origin) return;

  // Страницы — как есть (навигацию нельзя пересобрать), остальное своё — с проверкой у сервера
  const fresh = event.request.mode === 'navigate'
    ? fetch(event.request)
    : fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  event.respondWith(
    fresh
      .then((response) => {
        const copy = response.clone();
        // pass.html?t=<токен> — кладём в кэш без токена: одна копия страницы, токены в кэше не копятся
        const key = url.pathname.endsWith('/pass.html') ? new URL('./pass.html', self.location.href).href : event.request;
        caches.open(CACHE_VERSION).then((cache) => cache.put(key, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

// --- Напоминания о дедлайнах и домашке ---
// Сообщение присылает Edge Function send-reminders; содержимое — в теле push.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { body: event.data ? event.data.text() : '' }; }
  const title = payload.title || 'Журнал 24ДММ-2';
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: payload.tag || 'journal-reminder',
    data: { url: payload.url || './index.html#homework' }
  }));
});

// Нажали на уведомление — открываем уже запущенное окно журнала, а не новое
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
