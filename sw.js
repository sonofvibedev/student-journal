// Сервис-воркер журнала 24ДММ-2.
// Стратегия: "сначала сеть" (но не дольше NET_WAIT, потом кэш) для своих страниц и файлов — если сеть есть,
// пользователь всегда видит самую свежую версию сайта, кэш используется только как запасной
// вариант при отсутствии связи. data.json НИКОГДА не кэшируется — иначе застревали бы
// старые пропуски. Библиотеки лежат в vendor/ (свои, не CDN) и кэшируются как остальное.
//
// ВАЖНО: при каждом заметном обновлении index.html/cabinet.html стоит поднять CACHE_VERSION —
// это гарантированно подчистит старый кэш при следующем заходе. Ту же цифру — в ?v= у app.css и
// shared.js в index.html и cabinet.html, чтобы новая страница никогда не взяла старые стили/скрипт.
// Свои файлы запрашиваем мимо HTTP-кэша браузера (сервер ответит «не изменилось», если файл тот же):
// иначе после деплоя телефон мог получить новую страницу со старым app.css.
const CACHE_VERSION = 'journal-24dmm2-v62';
const NET_WAIT = 3000;          // сколько ждать сеть для своих файлов и страниц, прежде чем отдать кэш

// Тяжёлые библиотеки старого журнала (exceljs, chart, bootstrap, qrcode) заранее не качаем: при выкате нового воркера это
// ~1,3 МБ в момент первого запуска. Новому кабинету они не нужны (exceljs грузит только выгрузка отчёта старосты, ей и так нужна сеть);
// при первом использовании их кладёт в кэш общий обработчик fetch ниже.
const PRECACHE_URLS = [
  './env.js',
  './tg-gate.js',
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
  './games.css',
  './games-core.js',
  './games.js',
  './snake.js',
  './words.js',
  './shared.js',
  './maintenance.js',
  './j2-core.js',
  './j2-gate.js',
  './cab-core.js',
  './tg-app.js',
  './pwa.js',
  './offline-queue.js',
  './join.html',
  './join.js',
  './cab.css',
  './app.html',
  './app-student.js',
  './app-rating.js',
  './headman.html',
  './headman.js',
  './teacher.html',
  './teacher.js',
  './chat-crypto.js',
  './chat-ui.js',
  './sysadmin.html',
  './sysadmin.js',
  './monitor.js',
  './j2.css',
  './dean-report.js',
  './profile.js',
  './studak.js',
  './pass.html',
  './vendor/supabase.js',
  './manifest.json',
  './icons/favicon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
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
  // pass.html?t=<токен> — кладём в кэш без токена: одна копия страницы, токены в кэше не копятся
  const key = url.pathname.endsWith('/pass.html') ? new URL('./pass.html', self.location.href).href : event.request;
  let saved = null;
  const net = fresh.then((response) => {
    if (response.ok) { const copy = response.clone(); saved = caches.open(CACHE_VERSION).then((cache) => cache.put(key, copy)); }   // ошибки сервера в кэш не кладём
    return response;
  });
  event.waitUntil(net.then(() => saved).catch(() => {}));      // ответили из кэша — запрос всё равно дозагрузится и обновит кэш
  // «Сначала сеть», но не дольше NET_WAIT: медленная или «висящая» сеть не держит запуск, отдаём кэш (если он есть)
  const fromCache = () => caches.match(event.request, { ignoreSearch: true });
  event.respondWith(new Promise((resolve) => {
    let done = false;
    const give = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache().then(give), NET_WAIT);
    net.then((r) => { clearTimeout(timer); give(r); },
      () => { clearTimeout(timer); fromCache().then((c) => give(c || Response.error())); });
  }));
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
