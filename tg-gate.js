// Замок Mini App: страница, открытая из Telegram без нужного ключа в адресе, отвечает «404».
// Нужен, когда бота меняют: у нового бота в BotFather адрес приложения с ?b=<TG_APP_KEY>,
// старый бот открывает адрес без ключа и получает 404. Работает только внутри Telegram;
// обычный браузер и установленное PWA не затрагиваются. Выключен, пока TG_APP_KEY в env.js пуст.
//
// Вход не сбрасывается: замок ничего не пишет и не стирает в localStorage (там сессия Supabase),
// а лишь решает, показывать ли страницу. Ключ помним в sessionStorage — он живёт, пока открыто
// окно Mini App, поэтому переходы внутри приложения (адрес без ?b=) не ломаются.
// Это не защита данных (ключ виден в коде), а способ отключить старого бота.
//
// Подключается сразу после env.js: <script src="tg-gate.js"></script>
(function (root) {
  'use strict';

  // Открыто ли окно из Telegram: Telegram кладёт tgWebAppData в hash и (через telegram-web-app.js)
  // в sessionStorage. Сам объект Telegram.WebApp на этом шаге может быть ещё не создан.
  function inTelegram(hash, stored, tgInitData) {
    return !!tgInitData || /tgWebAppData=/.test(hash || '') || /tgWebAppData/.test(stored || '');
  }

  // Пускать ли страницу. key — TG_APP_KEY, search — location.search, savedKey — ключ из sessionStorage
  function tgGateAllowed(key, tg, search, savedKey) {
    if (!key) return true;                 // замок выключен
    if (!tg) return true;                  // не Telegram — не наше дело
    const q = new URLSearchParams(search || '').get('b');
    return q === key || savedKey === key;
  }

  if (typeof module !== 'undefined') { module.exports = { tgGateAllowed, inTelegram }; return; }

  const key = typeof TG_APP_KEY === 'string' ? TG_APP_KEY : '';
  if (!key) return;

  let stored = '', saved = '';
  try { stored = root.sessionStorage.getItem('__telegram__initParams') || ''; } catch (e) { /* без хранилища */ }
  try { saved = root.sessionStorage.getItem('tg_app_key') || ''; } catch (e) { /* без хранилища */ }
  const initData = root.Telegram && root.Telegram.WebApp && root.Telegram.WebApp.initData;
  const tg = inTelegram(root.location.hash, stored, initData);

  if (tgGateAllowed(key, tg, root.location.search, saved)) {
    if (tg) { try { root.sessionStorage.setItem('tg_app_key', key); } catch (e) { /* не страшно */ } }
    return;
  }

  // Заменяем всю страницу на 404. Разбор исходного HTML продолжается, но пишет в уже отброшенные
  // узлы, а скрипты не находят свою разметку и тихо падают. Всё, что они успеют дописать в новый
  // body (тосты, окна), убираем наблюдателем: на экране остаётся только 404.
  // (document.open() и window.stop() не годятся: первый не обрывает разбор, второй подвешивает загрузку.)
  const doc = root.document;
  doc.documentElement.innerHTML =
    '<head><meta charset="utf-8"><title>404 Not Found</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{margin:0;height:100%;background:#fff;color:#222;font:16px/1.4 system-ui,sans-serif}' +
    'body{display:grid;place-items:center}h1{font-size:20px;font-weight:600;margin:0}</style></head>' +
    '<body><h1 id="tg404">404 Not Found</h1></body>';
  root.__TG_GATE_BLOCKED = true;
  new MutationObserver(function () {
    const b = doc.body;
    if (!b) return;
    Array.prototype.slice.call(b.children).forEach(function (n) { if (n.id !== 'tg404') n.remove(); });
  }).observe(doc.documentElement, { childList: true, subtree: true });
})(typeof window !== 'undefined' ? window : this);
