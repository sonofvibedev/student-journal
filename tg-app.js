// «Журнал 2.0»: общая настройка Telegram Mini App для новых страниц (app, headman, teacher, sysadmin, join, register).
// Подключается после telegram-web-app.js. Вне Telegram (нет Telegram.WebApp.initData) ничего не меняет и ничего не рисует.
// Что здесь: expand и ready, цвет шапки и фона, запрет сворачивания свайпом вниз, запасной верхний отступ для старого клиента
// и жест «потяни, чтобы обновить». Само обновление делают страницы: они слушают событие j2:refresh.
// «Назад» живёт в cab-core.js (Cab.backButton), здесь его нет.
'use strict';
(function () {
  const W = (function () { try { const w = window.Telegram && window.Telegram.WebApp; return w && w.initData ? w : null; } catch (e) { return null; } })();
  const TGApp = (window.TGApp = window.TGApp || {});
  TGApp.inTelegram = !!W;
  const BG = '#0A0C11';                                                                   // фон журнала (j2.css, --j-bg)
  const since = (v) => { try { return typeof W.isVersionAtLeast === 'function' && W.isVersionAtLeast(v); } catch (e) { return false; } };
  const call = (fn) => { try { fn(); } catch (e) { /* клиент без этой возможности: журнал работает и так */ } };

  // ---------- шапка Telegram и запасной отступ ----------
  // Нормальный клиент (Bot API 8.0+) сам выставляет --tg-*-inset-*, а j2.css складывает их в --app-inset-*.
  // Старый клиент в полноэкранном режиме отступов не знает (оба нули): тогда ставим класс, и в j2.css верхний отступ ≈100px.
  function insets() {
    let top = 0;
    call(() => { top = (W.safeAreaInset && W.safeAreaInset.top || 0) + (W.contentSafeAreaInset && W.contentSafeAreaInset.top || 0); });
    if (!top) call(() => { const cs = getComputedStyle(document.documentElement); top = parseFloat(cs.getPropertyValue('--tg-safe-area-inset-top')) + parseFloat(cs.getPropertyValue('--tg-content-safe-area-inset-top')) || 0; });
    document.documentElement.classList.toggle('tg-fs-fallback', !!(W && W.isFullscreen && !top));
  }
  TGApp.syncInsets = insets;

  if (W) {
    call(() => W.expand());
    if (since('7.7') && typeof W.disableVerticalSwipes === 'function') call(() => W.disableVerticalSwipes());
    call(() => { if (since('6.1')) { W.setHeaderColor(BG); W.setBackgroundColor(BG); } if (since('7.10') && W.setBottomBarColor) W.setBottomBarColor(BG); });
    call(() => W.ready());
    insets();
    ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged'].forEach((ev) => call(() => W.onEvent(ev, insets)));
  }

  // ---------- «потяни, чтобы обновить» (пороги как в старом журнале: 72 и 108 px) ----------
  // Работает только в Telegram: в обычном браузере тянут родным жестом, а Chrome мы не мешаем (overscroll-behavior в j2.css).
  const TRIGGER = 72, MAX = 108;
  let start = null, dist = 0, ready = false, busy = false, el = null, txt = null;

  const buzz = () => { call(() => { if (W && W.HapticFeedback && since('6.1')) W.HapticFeedback.impactOccurred('light'); else if (navigator.vibrate) navigator.vibrate(10); }); };
  function node() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'j2-ptr'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></svg><span></span>';
    txt = el.querySelector('span');
    document.body.appendChild(el);
    return el;
  }
  const label = (t) => { node(); txt.textContent = t; };
  function move(d) {
    const k = Math.min(d, MAX), p = Math.min(1, k / TRIGGER);
    node().style.transform = `translate(-50%, ${(-52 + k * 0.5).toFixed(1)}px)`;
    el.style.opacity = String(p);
    label(d >= TRIGGER ? 'Отпустите, чтобы обновить' : 'Потяните, чтобы обновить');
  }
  function reset() {
    if (el) { el.style.transform = ''; el.style.opacity = ''; el.classList.remove('is-ready'); }
    start = null; dist = 0; ready = false;
  }

  // Где тянуть нельзя: шторка, поле ввода в фокусе, чат, всё внутри .no-swipe, несохранённые данные
  function dirty() {
    const typed = [...document.querySelectorAll('main input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]), main textarea')].some((x) => x.value !== x.defaultValue);
    let own = false; call(() => { own = typeof window.J2_NO_REFRESH === 'function' && !!window.J2_NO_REFRESH(); });   // страница знает свои несохранённые данные
    return typed || own;
  }
  function blocked(target) {
    if (document.querySelector('.cab-modal')) return true;
    const a = document.activeElement;
    if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return true;
    if (/^#\/chat(\/|$)/.test(location.hash)) return true;
    if (target && target.closest && target.closest('.no-swipe')) return true;
    return dirty();
  }
  TGApp.blocked = blocked;

  // Страницы вешают обработчик на j2:refresh и кладут промис в e.detail.tasks; пока он идёт, показываем «Обновляем…»
  async function refresh() {
    busy = true; reset();
    node().classList.add('is-busy'); el.style.opacity = '1'; el.style.transform = 'translate(-50%, 0)'; label('Обновляем…');
    let ok = true;
    try { const detail = { tasks: [] }; window.dispatchEvent(new CustomEvent('j2:refresh', { detail })); const r = await Promise.all(detail.tasks); ok = r.every((x) => x !== false); }
    catch (e) { ok = false; console.error('[refresh]', e); }
    el.classList.remove('is-busy'); label(ok ? 'Готово' : 'Не удалось обновить');
    call(() => { if (W.HapticFeedback && since('6.1')) W.HapticFeedback.notificationOccurred(ok ? 'success' : 'error'); });
    setTimeout(() => { el.style.opacity = ''; el.style.transform = ''; busy = false; }, ok ? 700 : 1600);
  }

  function ptrInit() {
    document.addEventListener('touchstart', (e) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY }; dist = 0;
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!start || busy || e.touches.length !== 1) return;
      const t = e.touches[0], dy = t.clientY - start.y, dx = Math.abs(t.clientX - start.x);
      if (dy <= 0 || dx > dy * 0.6 || window.scrollY > 0 || document.querySelector('.cab-modal')) { if (dist) reset(); else start = null; return; }
      dist = dy; move(dy);
      const r = dy >= TRIGGER;
      if (r !== ready) { ready = r; el.classList.toggle('is-ready', r); if (r) buzz(); }
      if (e.cancelable) e.preventDefault();                                              // страница не «отпружинивает», Telegram не сворачивается
    }, { passive: false });
    const end = () => { if (!start || busy) { start = null; return; } const fire = ready; if (fire) refresh(); else reset(); };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
  }
  if (W) { if (document.body) ptrInit(); else document.addEventListener('DOMContentLoaded', ptrInit, { once: true }); }
})();
