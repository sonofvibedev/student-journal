// «Журнал 2.0»: лёгкий мониторинг клиента (этап 5). Подключается сразу после env.js (до supabase.js), чтобы
// обёртка fetch попала в клиент Supabase. Шлёт на Edge Function client-report: ошибки браузера и замеры.
// Ничего личного: идентификаторы, токены, строки запроса и адреса вне своего файла вырезаются.
// Не должен ронять и тормозить страницу: всё в try/catch, отключается флагом window.J2_NO_MONITOR = true.
(function () {
  'use strict';
  try {
    if (window.J2_NO_MONITOR || window.__j2Monitor || typeof SUPABASE_URL === 'undefined') return;
    window.__j2Monitor = true;
    var URL_REPORT = SUPABASE_URL + '/functions/v1/client-report';
    var MAX_TOTAL = 20, MAX_SAME = 5, MAX_API = 4, BATCH = 10;   // на сеанс; за запрос сервер принимает до 10
    var queue = [], seen = {}, total = 0, apiSent = 0, apiSentN = 0, apiMs = [], timer = null, timerDue = 0;

    // Вырезает из текста всё, что похоже на токен, почту или параметры адреса; длинные адреса сводит к «файл:строка»
    function clean(s, max) {
      s = String(s == null ? '' : s);
      s = s.replace(/https?:\/\/[^\s)'"]+/g, function (u) {
        u = u.replace(/[?#][^:]*/, '');                                  // параметры адреса прочь, номер строки остаётся
        var m = u.match(/\/([^\/:]+):(\d+)(?::\d+)?$/) || u.match(/\/([^\/]*)\/?$/);
        return m ? (m[2] ? m[1] + ':' + m[2] : m[1] || 'url') : 'url';
      });
      s = s.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer ***')
        .replace(/(access_token|refresh_token|apikey|token|password|code)=[^\s&]+/gi, '$1=***')
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g, '***')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***')
        .replace(/\b[0-9a-f]{24,}\b/gi, '***')
        .replace(/[A-Za-z0-9+\/_=-]{32,}/g, '***');
      return s.slice(0, max);
    }
    var page = (location.pathname.split('/').pop() || 'index.html').slice(0, 40);

    function send(events, hiding) {
      try {
        var body = JSON.stringify({ events: events });
        if (hiding && navigator.sendBeacon && navigator.sendBeacon(URL_REPORT, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
        fetch(URL_REPORT, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY }, body: body }).catch(function () {});
      } catch (e) { /* мониторинг не должен мешать */ }
    }
    function apiEvent() {                          // медиана времени ответов Supabase за сеанс
      if (apiMs.length < 3 || apiMs.length === apiSentN || apiSent >= MAX_API || total >= MAX_TOTAL) return;
      var a = apiMs.slice().sort(function (x, y) { return x - y; });
      queue.push({ kind: 'perf', name: 'api', message: 'n=' + a.length, ms: Math.round(a[a.length >> 1]) });
      apiSent++; apiSentN = apiMs.length; total++;
    }
    function flush(hiding) {
      try {
        clearTimeout(timer); timer = null;
        apiEvent();
        while (queue.length) send(queue.splice(0, BATCH), hiding);
      } catch (e) { /* ничего */ }
    }
    function later(ms) {                           // ближний срок вытесняет дальний: ошибка не ждёт таймера замеров
      var due = Date.now() + ms;
      if (timer && timerDue <= due) return;
      clearTimeout(timer); timerDue = due;
      timer = setTimeout(function () { timer = null; flush(false); }, ms);
    }
    function add(ev) {
      if (total >= MAX_TOTAL) return;
      var key = ev.kind + '|' + ev.name + '|' + ev.message;
      if (ev.kind === 'error') { seen[key] = (seen[key] || 0) + 1; if (seen[key] > MAX_SAME) return; }
      total++; queue.push(ev);
      if (ev.kind === 'error' && window.J2Act && window.J2Act.log) { try { window.J2Act.log('error', ev.name + ': ' + ev.message.slice(0, 50)); } catch (x) { /* лог действий не мешает */ } }   // тот же сбой в ленте активности (2.1)
      later(ev.kind === 'error' ? 3000 : 30000);   // ошибки уходят быстро, замеры копятся
    }

    function fromError(err, fallbackMsg, prefix) {
      var name = (err && err.name) || 'Error', msg = (err && err.message) || fallbackMsg || String(err || '');
      if (/^Script error\.?$/i.test(msg)) return;                       // чужой скрипт без подробностей: не информативно
      var stack = err && err.stack ? String(err.stack) : '';
      if (/(chrome|moz|safari)-extension:/.test(stack)) return;          // расширения браузера
      add({ kind: 'error', name: clean(prefix + name, 120), message: clean(msg, 300), detail: clean('page: ' + page + (stack ? '\n' + stack : ''), 1000) });
    }
    window.addEventListener('error', function (e) {
      try { fromError(e.error, e.message, ''); } catch (x) { /* ничего */ }
    });
    window.addEventListener('unhandledrejection', function (e) {
      try {
        var r = e.reason;
        fromError(r instanceof Error ? r : { name: 'Rejection', message: r && r.message ? r.message : typeof r === 'string' ? r : 'unhandled rejection' }, '', r instanceof Error ? 'Rejection: ' : '');
      } catch (x) { /* ничего */ }
    });

    // Время ответов Supabase: только свои запросы, сам client-report не считается
    var origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        var t0 = performance.now(), u = '';
        try { u = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { /* ничего */ }
        var p = origFetch.apply(this, arguments);
        try {
          if (u.indexOf(SUPABASE_URL) === 0 && u.indexOf('/client-report') < 0 && apiMs.length < 200) {
            p.then(function () { apiMs.push(performance.now() - t0); }, function () { /* сбой сети: не замер */ });
          }
        } catch (e) { /* ничего */ }
        return p;
      };
    }

    // Загрузка страницы: после события load, когда navigation timing дописан
    window.addEventListener('load', function () {
      setTimeout(function () {
        try {
          var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
          var ms = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : (performance.timing ? performance.timing.loadEventEnd - performance.timing.navigationStart : 0);
          if (ms > 0 && ms < 600000) add({ kind: 'perf', name: 'page', message: page, ms: Math.round(ms) });
        } catch (e) { /* ничего */ }
      }, 0);
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
    window.addEventListener('pagehide', function () { flush(true); });
    setInterval(function () { if (queue.length || apiMs.length > apiSentN) flush(false); }, 30000);
  } catch (e) { /* мониторинг сломан: страница живёт без него */ }
})();
