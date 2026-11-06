// «Журнал 2.0», этап 7: установка на экран телефона. Подключается на страницах кабинетов (app, headman, teacher).
// Регистрирует sw.js (раньше его регистрировал только index.html) и хранит запрос установки Chrome/Android;
// на iPhone системной кнопки нет, поэтому там показываем подсказку «Поделиться → На экран Домой».
(function () {
  'use strict';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW registration failed:', e)); });
  }
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', () => { deferred = null; });
  // 'installed' — уже на экране; 'prompt' — можно вызвать install(); 'ios' — только подсказка; 'none' — браузер не умеет
  window.J2PWA = {
    state: () => (standalone() ? 'installed' : deferred ? 'prompt' : ios ? 'ios' : 'none'),
    install: async () => { if (!deferred) return false; const p = deferred; deferred = null; p.prompt(); const r = await p.userChoice; return r && r.outcome === 'accepted'; },
  };
})();
