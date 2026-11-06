// «Журнал 2.0», этап 2: общая оболочка кабинетов студента (app.html) и старосты (headman.html).
// Подключается после env.js, vendor/supabase.js и j2-core.js. Права проверяет сервер (RLS и RPC), эта страница только показывает.
// Что здесь: вход и выбор членства, роутер по hash, нижняя панель, экранирование (шаблон Cab.h), даты по Минску, мелкие помощники.
'use strict';
(function () {
  const Cab = (window.Cab = window.Cab || {});
  const sb = (Cab.sb = J2.sb);

  // ---------- экранирование: интерполяции в Cab.h`…` экранируются, Cab.raw(html) — нет ----------
  class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
  Cab.raw = (s) => new Raw(s);
  const one = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(one).join('') : v == null || v === false ? '' : J2.esc(v));
  Cab.h = (strings, ...vals) => new Raw(strings.reduce((a, s, i) => a + s + (i < vals.length ? one(vals[i]) : ''), ''));
  Cab.str = (v) => (v instanceof Raw ? v.s : one(v));

  // ---------- время: журнал живёт по Минску (UTC+3 без перехода на летнее время) ----------
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const DOW = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const DOW_S = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  Cab.MONTHS = MONTHS; Cab.DOW = DOW; Cab.DOW_S = DOW_S;
  Cab.testNow = null;                                     // тесты подставляют «сейчас» (мс UTC)
  Cab.minsk = function (ms) {
    const t = new Date((ms == null ? (Cab.testNow ?? Date.now()) : ms) + 3 * 3600e3);
    const p = (n) => String(n).padStart(2, '0');
    return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), dow: (t.getUTCDay() + 6) % 7,
      iso: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`, minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
  };
  // 'YYYY-MM-DD' + n дней → 'YYYY-MM-DD'
  Cab.addDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  Cab.dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);   // b − a в днях
  Cab.dowOf = (iso) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;                                // 0 = понедельник
  Cab.mondayOf = (iso) => Cab.addDays(iso, -Cab.dowOf(iso));
  Cab.dateText = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
  Cab.dateShort = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1].slice(0, 3)}`; };
  Cab.hm = (t) => String(t || '').slice(0, 5);             // '09:35:00' → '09:35'
  Cab.toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  Cab.plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };
  Cab.num = (n) => { const x = Math.round(Number(n) * 10) / 10; return String(x).replace('.', ','); };

  // «завтра», «2 дня»: подпись срока и цвет срочности (текст всегда рядом с цветом)
  Cab.due = function (iso) {
    if (!iso) return { text: 'без срока', cls: 'mute', days: 9999 };
    const n = Cab.dayDiff(Cab.minsk().iso, iso);
    if (n < 0) return { text: 'просрочено', cls: 'coral', days: n };
    if (n === 0) return { text: 'сегодня', cls: 'coral', days: n };
    if (n === 1) return { text: 'завтра', cls: 'coral', days: n };
    return { text: `${n} ${Cab.plural(n, ['день', 'дня', 'дней'])}`, cls: n <= 3 ? 'amber' : 'mute', days: n };
  };

  Cab.initials = (s) => (s && s.last_name ? s.last_name + (s.first_name ? ' ' + s.first_name.charAt(0) + '.' : '') : 'Без имени');
  Cab.fullName = (s) => [s.last_name, s.first_name].filter(Boolean).join(' ') || 'Без имени';
  Cab.KIND = { lecture: 'Лекция', practice: 'Практическое', lab: 'Лабораторная', other: 'Занятие' };
  Cab.kindLow = (k) => ({ lecture: 'лекция', practice: 'практическое', lab: 'лабораторная', other: 'занятие' }[k] || 'занятие');

  // Запрос Supabase: ошибка превращается в исключение, данные возвращаются сразу
  Cab.q = async (p) => { const { data, error } = await p; if (error) { const e = new Error(error.message || 'query'); e.code = error.code; throw e; } return data; };
  // RPC с понятной ошибкой: код из raise exception (например forbidden) остаётся в e.rpc
  Cab.rpc = async (name, args) => {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) { const e = new Error(error.message || name); e.rpc = (error.message || '').trim(); e.code = error.code; throw e; }
    return data;
  };
  const RPC_ERR = { forbidden: 'Это действие вам недоступно.', not_found: 'Запись не найдена: обновите страницу.', group_closed: 'Журнал закрыт: данные можно только смотреть.',
    maintenance: 'Ведутся технические работы. Повторите позже.' };
  Cab.rpcText = (e) => RPC_ERR[e && e.rpc] || (e && e.code === '42501' ? RPC_ERR.forbidden : 'Не получилось. Проверьте связь и повторите.');

  // ---------- иконки ----------
  const ic = (p) => Cab.raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`);
  Cab.icon = {
    home: ic('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>'),
    calendar: ic('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>'),
    study: ic('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/>'),
    user: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),
    journal: ic('<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    tasks: ic('<path d="M4 7l2 2 3-3M4 17l2 2 3-3M13 8h7M13 18h7"/>'),
    chat: ic('<path d="M4 5h16v11H9l-5 4z"/>'),
    bell: ic('<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21h4"/>'),
    chev: ic('<path d="M9 6l6 6-6 6"/>'),
    back: ic('<path d="M15 6l-6 6 6 6"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
    check: ic('<path d="M5 12l5 5 9-10"/>'),
    lock: ic('<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  };

  // ---------- вход и контекст ----------
  // Возвращает контекст или null (тогда страница уже уводит пользователя на нужный экран)
  const loadOnline = async function (kind) {
    if (!sb) { document.body.textContent = 'Нет связи с сервером.'; return null; }
    const { data: ses } = await sb.auth.getSession();
    if (!ses || !ses.session) { location.replace('join.html'); return null; }
    const uid = ses.session.user.id;
    const [mems, sa] = await Promise.all([
      Cab.q(sb.from('memberships').select('group_id, student_id, base_role, extra_role, status, consent_at').eq('user_id', uid)),
      Cab.q(sb.from('sysadmins').select('user_id').eq('user_id', uid)),
    ]);
    const isSysadmin = sa.length > 0;
    const active = mems.filter((m) => m.status === 'active');
    const mine = active.find((m) => m.base_role === 'student');
    const teach = active.filter((m) => m.base_role === 'teacher_lecture' || m.base_role === 'teacher_practice');
    // Преподаватель (тестовый кабинет): своя страница, студенческие страницы ему не нужны
    if (kind === 'teacher') {
      if (!teach.length) { location.replace(mine ? 'app.html' : 'join.html'); return null; }
      const gids = [...new Set(teach.map((m) => m.group_id))];
      const [groups, asg] = await Promise.all([
        Cab.q(sb.from('groups').select('id, name, status, warn_hours, dean_hours').in('id', gids)),
        Cab.q(sb.from('teacher_assignments').select('group_id, subject, lesson_kind').eq('user_id', uid)),
      ]);
      const ctx = { uid, email: ses.session.user.email, isTeacher: true, teacherRole: teach[0].base_role === 'teacher_lecture' ? 'lecture' : 'practice', member: teach[0], groups, assignments: asg, isSysadmin,
        subjects: [...new Set(asg.map((x) => x.subject))] };
      Cab.ctx = ctx;
      return ctx;
    }
    if (!mine && teach.length) { location.replace('teacher.html'); return null; }
    if (!mine) {
      if (mems.some((m) => m.status === 'pending')) { location.replace('join.html'); return null; }
      if (isSysadmin) { location.replace('sysadmin.html'); return null; }
      location.replace('join.html'); return null;
    }
    const isStaff = mine.extra_role === 'headman' || mine.extra_role === 'deputy';
    if (kind === 'headman' && !isStaff) { location.replace('app.html'); return null; }
    const [group, student] = await Promise.all([
      Cab.q(sb.from('groups').select('id, name, status, warn_hours, dean_hours').eq('id', mine.group_id).single()),
      Cab.q(sb.from('students').select('id, last_name, first_name, study_form, subgroup').eq('id', mine.student_id).single()),
    ]);
    const ctx = { uid, email: ses.session.user.email, group, student, member: mine, isStaff, role: mine.extra_role, isSysadmin, closed: group.status !== 'active' };
    Cab.ctx = ctx;
    return ctx;
  };

  // Без сети (этап 7): кабинет открывается из контекста, сохранённого при прошлом входе, чтобы староста могла отметить пропуски.
  // Контекст — только для показа; права по-прежнему проверяет сервер при отправке очереди.
  const CTX_KEY = 'j2.ctx.';
  const netErr = (e) => (window.OQ ? OQ.isNetError(e) : navigator.onLine === false);
  const cachedCtx = (kind) => { try { return JSON.parse(localStorage.getItem(CTX_KEY + kind)); } catch (_) { return null; } };
  Cab.load = async function (kind) {
    const off = (c) => { Cab.ctx = Object.assign({}, c, { offline: true }); return Cab.ctx; };
    if (kind !== 'teacher' && navigator.onLine === false) { const c = cachedCtx(kind); if (c && c.uid) return off(c); }
    try {
      const ctx = await loadOnline(kind);
      if (ctx && kind !== 'teacher') { try { localStorage.setItem(CTX_KEY + kind, JSON.stringify(ctx)); } catch (_) { /* память переполнена: офлайн-вход просто не получится */ } }
      return ctx;
    } catch (e) {
      const c = kind !== 'teacher' && netErr(e) ? cachedCtx(kind) : null;
      if (c && c.uid) return off(c);
      throw e;
    }
  };

  // ---------- очередь пропусков без сети: полоса состояния и отправка ----------
  Cab.netBar = function () {
    const el = document.getElementById('cabNet'); if (!el) return;
    const n = window.OQ && Cab.ctx && Cab.ctx.uid ? OQ.count(Cab.ctx.uid) : 0, off = navigator.onLine === false;
    el.hidden = !off && !n;
    el.textContent = off ? `Нет связи. Отметки сохраняются на телефоне${n ? `, в очереди: ${n}` : ''}.` : n ? `Отправляем отметки: ${n}…` : '';
  };
  Cab.flushQueue = async function () {
    if (!window.OQ || !Cab.ctx || !Cab.ctx.uid || navigator.onLine === false || !OQ.count(Cab.ctx.uid)) return;
    const { data } = await sb.auth.getSession();
    if (!data || !data.session || data.session.user.id !== Cab.ctx.uid) return;   // очередь чужая или вход слетел
    const r = await OQ.flush(sb, Cab.ctx.uid);
    Cab.netBar();
    if (r.error === '42501') Cab.toast('Часть отметок не принята: журнал закрыт или нет прав.', 'err');
    else if (r.sent) Cab.toast(`Отметки отправлены: ${r.sent}.`, 'ok');
    if (r.sent && Cab.onFlushed) Cab.onFlushed();
  };

  // ---------- установка на экран телефона ----------
  Cab.installCard = () => {
    const st = window.J2PWA ? J2PWA.state() : 'none';
    if (st !== 'prompt' && st !== 'ios') return '';
    return Cab.h`<div class="j2-card" id="cabInstallCard"><h2>Установить журнал</h2>${st === 'prompt'
      ? Cab.h`<p>Значок на экране телефона, запуск без адресной строки, пропуски можно отметить без сети.</p><button type="button" class="j2-btn" id="cabInstall">Установить</button>`
      : Cab.h`<p>Нажмите «Поделиться» в Safari и выберите «На экран Домой».</p>`}</div>`;
  };
  Cab.bindInstall = (el) => {
    const b = el.querySelector('#cabInstall'); if (!b) return;
    b.onclick = async () => { await J2PWA.install(); const c = document.getElementById('cabInstallCard'); if (c && J2PWA.state() !== 'prompt') c.remove(); };
  };

  Cab.fatal = (text) => { document.body.innerHTML = Cab.str(Cab.h`<main class="j2-wrap"><h1 class="j2-h1">Журнал</h1><p class="j2-sub">${text}</p><button class="j2-btn" id="cabOut" type="button">Выйти</button></main>`); document.getElementById('cabOut').onclick = () => Cab.signOut(); };
  Cab.signOut = async () => {
    try { await sb.auth.signOut(); } catch (e) { /* уже вышли */ }
    try { ['student', 'headman'].forEach((k) => localStorage.removeItem(CTX_KEY + k)); } catch (e) { /* нет доступа к памяти */ }   // очередь пропусков остаётся: уйдёт при следующем входе
    location.replace('join.html');
  };

  // ---------- «Назад» в Telegram Mini App ----------
  // Стек экранов (страница + hash) лежит в sessionStorage и переживает переходы между app.html, headman.html и teacher.html.
  // Пишем при загрузке и при hashchange, подряд одинаковые не дублируем. Адрес, равный предпоследнему, — это возврат (pop).
  // Кнопка Telegram видна, пока в стеке больше одной записи или открыто окно (.cab-modal); на корне скрыта, и Telegram закрывает приложение штатно.
  const NAV_KEY = 'j2.nav', NAV_MAX = 30;
  Cab.nav = {
    max: NAV_MAX,
    // Чистая логика: стек и новый адрес → новый стек
    visit(stack, here, max) {
      const s = (Array.isArray(stack) ? stack : []).filter((x) => typeof x === 'string'), lim = max || NAV_MAX;
      if (!s.length) return [here];
      if (s[s.length - 1] === here) return s;                       // тот же адрес (перезагрузка): не дублируем
      if (s.length >= 2 && s[s.length - 2] === here) return s.slice(0, -1);   // возврат на предыдущий экран
      s.push(here);
      return s.length > lim ? s.slice(s.length - lim) : s;
    },
    read() { try { const a = JSON.parse(sessionStorage.getItem(NAV_KEY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch (e) { return []; } },
    write(a) { try { sessionStorage.setItem(NAV_KEY, JSON.stringify(a)); } catch (e) { /* нет sessionStorage: кнопки «Назад» просто не будет */ } },
    page() { return location.pathname.split('/').pop() || 'index.html'; },
    // адрес экрана: корень страницы (пустой hash) приводим к стартовому маршруту
    key(start) { return Cab.nav.page() + (location.hash && location.hash !== '#/' ? location.hash : '#/' + start); },
    // куда вести по «Назад»: { same, hash, href } или null на корне
    target(stack, start) {
      if (!stack || stack.length < 2) return null;
      const t = stack[stack.length - 2], i = t.indexOf('#'), file = i < 0 ? t : t.slice(0, i), hash = i < 0 ? '' : t.slice(i);
      return { same: file === Cab.nav.page(), hash: hash || '#/' + start, href: t };
    },
  };
  // Подключает BackButton, если приложение открыто из Telegram и версия 6.1+. Возвращает функцию «обновить видимость» (или пустую). Всё в try/catch.
  Cab.backButton = function (start) {
    let TG = null;
    try { const w = window.Telegram && window.Telegram.WebApp; TG = w && w.initData && typeof w.isVersionAtLeast === 'function' && w.isVersionAtLeast('6.1') && w.BackButton ? w : null; } catch (e) { TG = null; }
    if (!TG) return () => {};
    const sync = () => { try { if (document.querySelector('.cab-modal') || Cab.nav.read().length > 1) TG.BackButton.show(); else TG.BackButton.hide(); } catch (e) { /* не мешаем журналу */ } };
    try {
      TG.BackButton.onClick(() => {
        try {
          if (document.querySelector('.cab-modal')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); sync(); return; }   // сначала закрываем окно
          const t = Cab.nav.target(Cab.nav.read(), start);
          if (!t) { sync(); return; }
          if (t.same) location.hash = t.hash; else location.href = t.href;
        } catch (e) { /* ignore */ }
      });
      new MutationObserver(sync).observe(document.body, { childList: true });          // окно открыли или закрыли
      if (typeof TG.ready === 'function') TG.ready();
    } catch (e) { /* ignore */ }
    return sync;
  };

  // ---------- свайп влево-вправо: соседний раздел нижней панели ----------
  // Пороги и условия — как в старом журнале (index.html: enableHorizontalSwipe). Открываем раздел так же, как тап по вкладке: меняем hash,
  // поэтому стек «Назад» (Cab.nav) и подсветка вкладки работают без отдельного кода.
  Cab.swipe = {
    MIN: 50, RATIO: 1.5, MAX_MS: 700, EDGE: 24, SLIDE_PX: 24,
    // нижняя панель, окна, поля ввода, ленты с горизонтальной прокруткой и всё, что помечено .no-swipe
    IGNORE: 'input, select, textarea, [contenteditable], [role="slider"], .cab-modal, .cab-tabbar, .cab-days, .ch-chips, .ch-tabs, .no-swipe',
    // сдвиг пальца → 1 (влево: следующий раздел), -1 (вправо: предыдущий) или 0 (не свайп)
    dir(dx, dy, dt) {
      const S = Cab.swipe;
      if (Math.abs(dx) < S.MIN || Math.abs(dx) < Math.abs(dy) * S.RATIO || dt > S.MAX_MS) return 0;
      return dx < 0 ? 1 : -1;
    },
    // индекс соседнего раздела; на краях списка -1 (без зацикливания)
    next(i, dir, n) { const j = i + dir; return i < 0 || !dir || j < 0 || j >= n ? -1 : j; },
    // есть ли у элемента или его родителей горизонтальная прокрутка, которая реально работает
    scrollsX(el) {
      for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
        const ox = getComputedStyle(e).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth) return true;
      }
      return false;
    },
    // cur() — индекс раздела на корневом экране или -1 (вложенный экран, загрузка, чат); go(j, dir) — открыть раздел j
    bind(cur, go) {
      const S = Cab.swipe;
      let st = null;
      document.addEventListener('touchstart', (e) => {
        st = null;
        if (e.touches.length !== 1 || cur() < 0 || document.querySelector('.cab-modal, .cab-bare')) return;
        const t = e.touches[0], el = e.target;
        if (t.clientX < S.EDGE || t.clientX > window.innerWidth - S.EDGE) return;   // край экрана: системный жест «назад»
        if (el.closest && (el.closest(S.IGNORE) || S.scrollsX(el))) return;
        st = { x: t.clientX, y: t.clientY, time: Date.now() };
      }, { passive: true });
      // Ось определена по первым ~10 px: вертикальный жест (прокрутка, «потяни, чтобы обновить») дальше не смотрим
      document.addEventListener('touchmove', (e) => {
        if (!st || st.axis || e.touches.length !== 1) return;
        const t = e.touches[0], ax = Math.abs(t.clientX - st.x), ay = Math.abs(t.clientY - st.y);
        if (Math.max(ax, ay) < 10) return;
        if (ax < ay * S.RATIO) st = null; else st.axis = 'x';
      }, { passive: true });
      document.addEventListener('touchend', (e) => {
        if (!st) return;
        const t = e.changedTouches[0], d = S.dir(t.clientX - st.x, t.clientY - st.y, Date.now() - st.time);
        st = null;
        if (!d || (window.getSelection && String(window.getSelection())) || document.querySelector('.cab-modal')) return;
        const j = S.next(cur(), d, document.querySelectorAll('.cab-tab').length);
        if (j >= 0) go(j, d);
      }, { passive: true });
      document.addEventListener('touchcancel', () => { st = null; }, { passive: true });
    },
  };

  // ---------- оболочка и роутер ----------
  // opts: { kind, tabs: [{id, label, icon, path}], routes: { 'home': {tab:'home', render(el, ctx, params)} }, start }
  // Адрес: #/home, #/study/homework, #/journal/certs. Вкладка = первый сегмент, если не указано иное.
  Cab.start = async function (opts) {
    const ctx = await Cab.load(opts.kind);
    if (!ctx) return;
    const root = document.getElementById('cab');
    root.innerHTML = Cab.str(Cab.h`<main class="cab-wrap" id="cabMain" tabindex="-1"></main>
      <nav class="cab-tabbar none" aria-label="Разделы" style="${'--n:' + opts.tabs.length}"><span class="cab-tab-ind" aria-hidden="true"></span>${opts.tabs.map((t) => Cab.h`<a class="cab-tab" href="${'#/' + t.path}" data-tab="${t.id}"><span class="cab-ico">${t.icon}</span><span>${t.label}</span></a>`)}</nav>
      <div class="cab-toast" id="cabToast" role="status" aria-live="polite"></div>
      <div class="cab-net" id="cabNet" role="status" aria-live="polite" hidden></div>`);
    const main = document.getElementById('cabMain');
    Cab.netBar();
    const syncNet = () => { Cab.netBar(); Cab.flushQueue().catch((e) => console.error('[queue]', e)); };
    window.addEventListener('online', syncNet); window.addEventListener('offline', Cab.netBar);
    syncNet();
    let gen = 0, lastTab = null, rootIdx = -1, swipeDir = null;   // rootIdx: номер раздела на корневом экране (иначе -1: свайп выключен)
    async function go() {
      const my = ++gen, swDir = swipeDir;
      swipeDir = null; rootIdx = -1;
      const hash = location.hash.replace(/^#\/?/, '') || (ctx.offline && opts.routes.journal ? 'journal' : opts.start);
      const [name, ...rest] = hash.split('/');
      let ok = true;                                                                    // false — экран не загрузился (жест «обновить» покажет ошибку)
      const key = opts.routes[hash] ? hash : opts.routes[name] ? name : opts.start;
      const r = opts.routes[key];
      const params = key === hash ? [] : rest;
      const bar = root.querySelector('.cab-tabbar'), tabs = [...root.querySelectorAll('.cab-tab')], tabId = r.tab || name;
      tabs.forEach((a) => { const on = a.dataset.tab === tabId; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      const idx = tabs.findIndex((a) => a.dataset.tab === tabId);
      bar.classList.toggle('none', idx < 0);
      if (idx >= 0) bar.style.setProperty('--i', idx);
      // плавный сдвиг включаем после первой расстановки, чтобы при открытии «таблетка» не ехала с нуля
      if (!bar.classList.contains('anim')) requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('anim')));
      if (lastTab !== null && lastTab !== tabId) { main.classList.remove('fade', 'sw-l', 'sw-r'); void main.offsetWidth; main.classList.add(swDir ? 'sw-' + swDir : 'fade'); }
      lastTab = tabId;
      main.innerHTML = '<p class="cab-load">Загружаем…</p>';
      try { await r.render(main, ctx, params, { isCurrent: () => my === gen }); }
      catch (e) {
        if (my !== gen) return;
        ok = false;
        console.error('[cab]', key, e);
        main.innerHTML = Cab.str(Cab.h`<div class="j2-card bad"><h2>Не получилось загрузить</h2><p>Проверьте связь и повторите.</p></div><button class="j2-btn" id="cabRetry" type="button">Повторить</button>`);
        document.getElementById('cabRetry').onclick = go;
      }
      if (my === gen) { window.scrollTo(0, 0); if (ok && key === hash && key !== 'chat' && opts.tabs.some((t) => t.path === key)) rootIdx = idx; }   // корень раздела: адрес = путь вкладки (не вложенный экран) и не чат
      return ok;
    }
    Cab.rerender = go;
    window.addEventListener('j2:refresh', (e) => { if (e.detail && e.detail.tasks) e.detail.tasks.push(go()); });   // жест «потяни, чтобы обновить» (tg-app.js)
    window.addEventListener('hashchange', go);
    Cab.swipe.bind(() => rootIdx, (j, d) => {
      try { const w = window.Telegram && window.Telegram.WebApp; if (w && w.initData && w.HapticFeedback && w.isVersionAtLeast('6.1')) w.HapticFeedback.selectionChanged(); } catch (e) { /* без вибрации */ }
      swipeDir = d > 0 ? 'l' : 'r';
      window.scrollTo(0, 0);
      location.hash = '#/' + opts.tabs[j].path;          // как тап по вкладке: hashchange → go и запись в стек «Назад»
    });
    const syncBack = Cab.backButton(opts.start);
    const record = () => { Cab.nav.write(Cab.nav.visit(Cab.nav.read(), Cab.nav.key(opts.start))); syncBack(); };
    record(); window.addEventListener('hashchange', record);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNet(); if (Cab.autoRefresh && Cab.autoRefresh()) go(); } });
    await go();
    return ctx;
  };

  Cab.toast = function (text, kind) {
    const el = document.getElementById('cabToast'); if (!el) return;
    el.textContent = text; el.className = 'cab-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(Cab._tt); Cab._tt = setTimeout(() => { el.className = 'cab-toast'; }, 3500);
  };

  // Шапка экрана: «назад» слева, подпись справа, заголовок. back: {href, text}
  Cab.top = (back, right) => Cab.h`<div class="cab-top">${back ? Cab.h`<a class="j2-back" href="${back.href}"><span class="cab-ico sm">${Cab.icon.back}</span>${back.text}</a>` : Cab.raw('<span></span>')}<span class="cab-top-r">${right || ''}</span></div>`;

  // Кольцо прогресса: value из max, цвет по порогам (лайм → янтарь → коралл)
  Cab.ring = function (value, max, size) {
    const s = size || 96, r = s / 2 - 8, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, max ? value / max : 0));
    const col = p >= 1 ? 'var(--j-coral)' : p >= 0.66 ? 'var(--j-amber)' : 'var(--j-lime)';
    return Cab.h`<svg class="cab-ring" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" role="img" aria-label="${Cab.num(value)} из ${Cab.num(max)} часов"><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="8"/><circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="none" stroke="${Cab.raw(col)}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}" transform="rotate(-90 ${s / 2} ${s / 2})"/></svg>`;
  };

  // Сегменты «Все / Мои / …»: onChange(value)
  Cab.segmented = function (el, items, value, onChange) {
    el.className = 'j2-tabs'; el.setAttribute('role', 'tablist');
    el.innerHTML = Cab.str(Cab.h`${items.map((it) => Cab.h`<button type="button" role="tab" data-v="${it.value}" aria-selected="${it.value === value ? 'true' : 'false'}">${it.label}</button>`)}`);
    el.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b))); onChange(b.dataset.v); };
  };

  // Подтверждение: нижний лист с двумя кнопками, Esc и тап по фону = «Отмена»; true, если нажали подтверждающую кнопку
  Cab.ask = function (title, text, okText) {
    return new Promise((res) => {
      const back = document.activeElement, root = document.getElementById('cab'), m = document.createElement('div');
      m.className = 'cab-modal';
      m.innerHTML = Cab.str(Cab.h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="stAskT"><h2 class="st-sh-t" id="stAskT">${title}</h2><p class="cab-note">${text}</p><button class="j2-btn danger" data-a="ok" type="button">${okText}</button><button class="j2-btn" data-a="no" type="button">Отмена</button></div>`);
      const key = (e) => { if (e.key === 'Escape') fin(false); };
      const no = () => fin(false);
      function fin(v) { m.remove(); root.inert = false; document.removeEventListener('keydown', key); window.removeEventListener('hashchange', no); if (back && back.focus) back.focus(); res(v); }
      m.onclick = (e) => { if (e.target === m) fin(false); const b = e.target.closest('button[data-a]'); if (b) fin(b.dataset.a === 'ok'); };
      document.body.appendChild(m); root.inert = true;
      document.addEventListener('keydown', key); window.addEventListener('hashchange', no);
      m.querySelector('button').focus();
    });
  };

  // Задание из tasks: { id, kind, rec } → удобный вид
  Cab.task = (row) => {
    const r = row.rec || {};
    return { id: row.id, kind: row.kind, type: r.type || '', subject: r.subject || '', text: r.text || '', due: r.dueDate || null, subgroup: Number(r.subgroup) || 0,
      createdBy: row.created_by || null, raw: row, isExam: r.type === 'zachet' || r.type === 'exam' };
  };
  // Видно ли задание студенту с подгруппой sg (0/null — подгруппа не выбрана, видны все)
  Cab.taskVisible = (t, sg) => !t.subgroup || !sg || t.subgroup === Number(sg);
})();
