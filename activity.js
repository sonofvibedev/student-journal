// «Журнал 2.1»: журнал действий для сисадмина. Собирает осмысленные события: вход, выход, открытие экрана, нажатие кнопки.
// События копятся в очереди и уходят пачкой (раз в ~20 секунд, при сворачивании страницы и при выходе) в RPC usage_log_batch.
// Что НЕ попадает никогда: пароли и любой ввод (читаем только названия экранов и подписи кнопок), содержимое чата (экраны чата и их кнопки не пишем),
// адресные параметры и идентификаторы (чистим). Подключается после j2-core.js (нужен J2.sb). Не должен ронять и тормозить страницу.
// Работает в браузере (window.J2Act) и в Node (тест: только чистые функции).
(function (root) {
  'use strict';
  const FLUSH_MS = 20000, MAX_Q = 100, BATCH = 50, KEY_Q = 'j2_act_q', KEY_DEV = 'j2_act_dev', KEY_LOGIN = 'j2_act_login';
  const LOGIN_GAP = 6 * 3600 * 1000;                       // новый вход = первое событие после перерыва в 6 часов

  // ---------- чистые функции ----------
  // Название экрана: «страница + маршрут» без параметров и идентификаторов. Экраны чата не пишем вовсе (null).
  function screenName(page, hash) {
    let h = String(hash || '').replace(/^#/, '').split('?')[0];
    if (/(^|\/)chat(\/|$)/i.test(h)) return null;
    h = h.replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27}|st-\d+|[0-9a-f]{16,}|\d{3,})(?=\/|$)/gi, '/…').slice(0, 60);
    return (String(page || '').replace(/\.html$/, '') || 'index') + (h && h !== '/' ? '#' + h : '');
  }
  // Подпись нажатой кнопки: aria-label, иначе data-act, иначе видимый текст (обрезан). Пусто = не писать.
  function clickLabel(label, dataAct, text) {
    const s = String(label || dataAct || text || '').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, 40) : '';
  }
  // Устройство словами: «Android · Chrome (телефон)»; без точных версий
  function deviceLabel(ua, w, tg) {
    ua = String(ua || '');
    const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'ОС ?';
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс' : /Firefox\//.test(ua) ? 'Firefox' : /(Chrome|CriOS)\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'браузер';
    return os + ' · ' + (tg ? 'Telegram' : br) + ' (' + (w && w < 700 ? 'телефон' : 'ПК') + ')';
  }

  const api = { screenName, clickLabel, deviceLabel };
  root.J2Act = Object.assign(root.J2Act || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document || !root.J2 || !root.J2.sb || root.J2_NO_ACTIVITY) return;

  // ---------- сбор ----------
  const sb = root.J2.sb, doc = root.document;
  let q = [], timer = null, busy = false, devId = '', lastClick = '', lastClickAt = 0;
  const ls = {
    get(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* нет памяти */ } },
  };
  try { q = JSON.parse(ls.get(KEY_Q) || '[]').filter((e) => e && e.k).slice(-MAX_Q); } catch (e) { q = []; }
  devId = ls.get(KEY_DEV) || '';
  if (!devId) { devId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join(''); ls.set(KEY_DEV, devId); }
  const page = (root.location.pathname.split('/').pop() || 'index.html').slice(0, 30);
  const dev = deviceLabel(root.navigator.userAgent, root.innerWidth, !!(root.Telegram && root.Telegram.WebApp && root.Telegram.WebApp.initData));
  let authed = false;

  function save() { ls.set(KEY_Q, JSON.stringify(q.slice(-MAX_Q))); }
  function log(kind, name) {
    if (!authed) return;                                    // без входа писать некому: RPC требует пользователя
    q.push({ k: kind, n: name || '', d: dev, di: devId, t: Date.now() });
    if (q.length > MAX_Q) q = q.slice(-MAX_Q);
    save(); later();
  }
  function later() { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS); }
  async function flush() {
    if (busy || !q.length || !authed) return;
    busy = true; clearTimeout(timer); timer = null;
    const part = q.slice(0, BATCH);
    try {
      const { error } = await sb.rpc('usage_log_batch', { p_events: part });
      if (!error) { q = q.slice(part.length); save(); }
      else if (error.code === '42501' || error.code === '22023') { q = q.slice(part.length); save(); }   // отказ навсегда (нет права, плохие данные): не повторяем
    } catch (e) { /* нет сети: остаётся в очереди */ }
    busy = false;
    if (q.length) later();
  }

  function screen() { const n = screenName(page, root.location.hash); if (n) log('screen', n); }
  function login() {
    const last = Number(ls.get(KEY_LOGIN) || 0);
    if (Date.now() - last < LOGIN_GAP) { ls.set(KEY_LOGIN, String(Date.now())); return; }
    ls.set(KEY_LOGIN, String(Date.now())); log('login', '');
  }

  // Состояние входа: событие входа пишем при появлении сессии, выхода — до signOut (после него писать уже некому)
  sb.auth.onAuthStateChange((ev, session) => {
    const was = authed; authed = !!(session && session.user);
    if (authed && !was) { login(); screen(); flush(); }
    if (!authed) { q = []; ls.set(KEY_Q, '[]'); }
  });
  const signOut = sb.auth.signOut.bind(sb.auth);
  sb.auth.signOut = async function () {
    try { if (authed) { q.push({ k: 'logout', n: '', d: dev, di: devId, t: Date.now() }); busy = false; await Promise.race([flush(), new Promise((r) => setTimeout(r, 1500))]); } } catch (e) { /* выход важнее лога */ }
    ls.set(KEY_LOGIN, '0');
    return signOut.apply(null, arguments);
  };

  root.addEventListener('hashchange', screen);
  // Нажатия: только кнопки и их роли (не поля ввода). Одно и то же подряд в течение секунды — одно событие.
  doc.addEventListener('click', (e) => {
    try {
      const el = e.target && e.target.closest && e.target.closest('button, [role="button"], [role="switch"], [role="tab"], a.j2-btn, [data-act]');
      if (!el || el.closest('input, textarea, select, [data-nolog], .ch-compose, .ch-list') || el.matches('[disabled], [aria-disabled="true"]')) return;
      if (/(^|\/)chat(\/|$)/i.test(root.location.hash)) return;
      const label = clickLabel(el.getAttribute('aria-label'), el.getAttribute('data-act'), el.textContent);
      if (!label || /парол|password/i.test(label)) return;
      const now = Date.now(); if (label === lastClick && now - lastClickAt < 1000) return;
      lastClick = label; lastClickAt = now;
      log('action', label);
    } catch (err) { /* лог не должен мешать */ }
  }, true);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') flush(); });
  root.addEventListener('pagehide', () => { flush(); });
  root.J2Act.log = log; root.J2Act.flush = flush;
})(typeof window !== 'undefined' ? window : globalThis);
