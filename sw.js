// Сервис-воркер журнала 24ДММ-2.
// Стратегия: "сначала сеть" для своих страниц (index.html, cabinet.html) — если сеть есть,
// пользователь всегда видит самую свежую версию сайта, кэш используется только как запасной
// вариант при отсутствии связи. data.json НИКОГДА не кэшируется — иначе застревали бы
// старые пропуски. Внешние CDN-скрипты (Bootstrap, Chart.js и т.д.) не трогаем — их кэширует
// сам браузер через обычный HTTP-кэш.
//
// ВАЖНО: при каждом заметном обновлении index.html/cabinet.html стоит поднять CACHE_VERSION —
// это гарантированно подчистит старый кэш при следующем заходе.
const CACHE_VERSION = 'journal-24dmm2-v2';

const PRECACHE_URLS = [
  './index.html',
  './cabinet.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
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

  // Чужие домены (CDN) не трогаем — пусть работает обычный HTTP-кэш браузера
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
