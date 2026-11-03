// Режим технических работ. Пока он включён, всё, кроме старосты, закрыто на сервере
// (RLS и Edge Functions, см. supabase/migrations/20261103130000_maintenance_mode.sql);
// здесь только экран «Ведутся технические работы» для остальных, плашка и кнопка для старосты.
// Подключается после shared.js и ДО основного скрипта страницы: обёртка над fetch должна встать
// раньше, чем создастся клиент Supabase. sb и showConfirm берутся лениво, при вызове.
(function () {
  'use strict';
  const MIN_GAP_MS = 5000;        // чаще проверять не нужно, даже если ошибок много
  const POLL_MS = 60000;          // и просто раз в минуту, пока вкладка открыта
  let state = { on: false, admin: false };
  let busy = false;
  let lastAt = 0;
  let guestBypass = false;        // гость открыл вход для старосты: экран не мешает ему войти

  const $ = (id) => document.getElementById(id);
  const client = () => (typeof sb !== 'undefined' ? sb : null);

  function ensureStyles() {
    if ($('maintStyle')) return;
    const st = document.createElement('style');
    st.id = 'maintStyle';
    st.textContent =
      '#maintScreen{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:24px;' +
      'background:rgba(6,6,6,.78);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px)}' +
      '#maintScreen .m-card{max-width:360px;text-align:center;padding:28px 24px;border-radius:24px;color:#e5e5ea;' +
      'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);box-shadow:0 20px 60px rgba(0,0,0,.45)}' +
      '#maintScreen h1{font-size:1.25rem;margin:0 0 8px;color:#fff}' +
      '#maintScreen p{margin:0 0 18px;color:#aeaeb2}' +
      '#maintScreen button{font:inherit;border:0;border-radius:12px;padding:10px 20px;color:#fff;background:#0a84ff;cursor:pointer}' +
      '#maintScreen button.m-link{background:none;color:#8e8e93;font-size:.8125rem;margin-top:12px;padding:6px}' +
      '#maintBanner{position:fixed;top:0;left:0;right:0;z-index:1040;pointer-events:none;text-align:center;' +
      'padding:calc(env(safe-area-inset-top,0px) + 2px) 8px 2px;font-size:.75rem;font-weight:600;color:#1c1400;background:#ffd60a}';
    document.head.appendChild(st);
  }

  function showScreen() {
    ensureStyles();
    if ($('maintScreen')) return;
    const el = document.createElement('div');
    el.id = 'maintScreen';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'maintTitle');
    el.innerHTML =
      '<div class="m-card"><h1 id="maintTitle">Ведутся технические работы</h1>' +
      '<p>Журнал скоро вернётся. Загляните чуть позже.</p>' +
      '<button type="button" id="maintReload">Обновить</button>' +
      '<div><button type="button" class="m-link" id="maintAdminLogin">Вход для старосты</button></div></div>';
    document.body.appendChild(el);
    // Остальное содержимое недоступно ни мышью, ни клавиатурой, ни экранным диктором
    Array.prototype.forEach.call(document.body.children, (c) => { if (c !== el) c.inert = true; });
    $('maintReload').onclick = () => location.reload();
    $('maintAdminLogin').onclick = () => { guestBypass = true; apply(); location.hash = '#profile'; };
    $('maintAdminLogin').hidden = typeof AppState !== 'undefined' && AppState.auth === 'signed';
  }

  function hideScreen() {
    const el = $('maintScreen');
    if (!el) return;
    el.remove();
    Array.prototype.forEach.call(document.body.children, (c) => { c.inert = false; });
  }

  function apply() {
    const signed = typeof AppState !== 'undefined' && AppState.auth === 'signed';
    if (signed) guestBypass = false;   // вошёл, но не староста: экран возвращается
    const blocked = state.on && !state.admin;
    if (blocked && !guestBypass) showScreen(); else hideScreen();

    ensureStyles();
    let banner = $('maintBanner');
    const showBanner = state.on && state.admin;
    if (showBanner && !banner) {
      banner = document.createElement('div');
      banner.id = 'maintBanner';
      banner.textContent = 'Режим техработ включён';
      document.body.appendChild(banner);
    } else if (!showBanner && banner) banner.remove();

    const val = $('maintStateVal');
    if (val) val.textContent = state.on ? 'Включён' : 'Выключен';
  }

  // Спросить сервер: включён ли режим и староста ли я (работает и без входа)
  async function check(force) {
    const c = client();
    if (!c || busy || (!force && Date.now() - lastAt < MIN_GAP_MS)) return;
    busy = true; lastAt = Date.now();
    try {
      const { data, error } = await c.rpc('maintenance_status');
      if (!error && data) { state = { on: data.on === true, admin: data.admin === true }; apply(); }
    } catch (e) { /* нет сети: остаётся прежнее состояние */ }
    finally { busy = false; }
  }

  // Любой отказ от Supabase (в том числе 503 maintenance от Edge Function) — повод перепроверить режим
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!res.ok && typeof SUPABASE_URL !== 'undefined' && url.indexOf(SUPABASE_URL) === 0) check(false);
    } catch (e) {}
    return res;
  };

  // Кнопка старосты в админ-панели
  window.toggleMaintenance = async function () {
    const c = client();
    if (!c || typeof showConfirm !== 'function') return;
    const next = !state.on;
    const q = next
      ? 'Включить режим технических работ? Все, кроме старосты, потеряют доступ к журналу, пока вы его не выключите.'
      : 'Выключить режим технических работ? Журнал снова откроется для всех.';
    if (!(await showConfirm(q))) return;
    const { error } = await c.rpc('set_maintenance', { p_on: next });
    if (error) { if (typeof showAlert === 'function') showAlert('Не удалось переключить режим: ' + (error.message || error.code)); return; }
    await check(true);
  };

  window.addEventListener('DOMContentLoaded', () => {
    check(true);
    if (typeof AppState !== 'undefined') AppState.onChange(() => { apply(); check(false); });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(true); });
  setInterval(() => { if (!document.hidden) check(true); }, POLL_MS);
})();
