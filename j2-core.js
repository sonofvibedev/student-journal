// «Журнал 2.0»: общее ядро клиентских страниц (register.html, join.html, sysadmin.html, j2-gate.js).
// Подключается после env.js (SUPABASE_URL, SUPABASE_KEY, SB_STORAGE_KEY) и vendor/supabase.js.
// Здесь только вызовы сервера и мелкие помощники. Права проверяет сервер (RLS и функции), не эта страница.
'use strict';
(function () {
  const J2 = (window.J2 = window.J2 || {});

  // Клиент Supabase с тем же ключом сессии, что у основного сайта: вошедший здесь остаётся вошедшим и в журнале.
  J2.sb = window.supabase && typeof SUPABASE_URL !== 'undefined'
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: SB_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
    : null;

  J2.EMAIL_DOMAIN = 'students.journal-24dmm2.app';
  // Логин студента превращается в «почту» так же, как в Edge Functions (_shared/common.ts).
  // Если ввели почту (есть @: преподаватели, сисадмины), берём её как есть.
  J2.loginToEmail = (login) => { const v = String(login).trim().toLowerCase(); return v.includes('@') ? v : `${v}@${J2.EMAIL_DOMAIN}`; };
  J2.LOGIN_RE = /^[a-z0-9_.]{3,32}$/;
  J2.PASSWORD_MIN = 8;
  J2.PASSWORD_MAX = 72;

  // Вызов Edge Function. Возвращает { ok, status, data }. Токен сессии добавляется, если он есть.
  J2.fn = async function (name, body, opts) {
    const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
    let token = SUPABASE_KEY;
    if (!(opts && opts.anon) && J2.sb) {
      const { data } = await J2.sb.auth.getSession();
      if (data && data.session) token = data.session.access_token;
    }
    headers.Authorization = 'Bearer ' + token;
    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
      let data = null;
      try { data = await r.json(); } catch (e) { /* пустой ответ */ }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  };

  // Переключатель «Студент / Староста / Сисадмин»: только доступные роли, при одной роли пусто. roles: { student, staff, sysadmin, staffLabel }.
  // Это обычные ссылки на app.html, headman.html, sysadmin.html: права по-прежнему проверяет сервер, страница роли лишь показывает.
  J2.roleSwitch = function (current, roles) {
    const r = roles || {};
    const all = [['student', 'Студент', 'app.html'], ['staff', r.staffLabel || 'Староста', 'headman.html'], ['sysadmin', 'Сисадмин', 'sysadmin.html']].filter((x) => r[x[0]]);
    if (all.length < 2) return '';
    return '<nav class="j2-roles" aria-label="Роль в журнале">' + all.map((x) => '<a href="' + x[2] + '"' + (x[0] === current ? ' aria-current="page"' : '') + '>' + J2.esc(x[1]) + '</a>').join('') + '</nav>';
  };

  // Текст ошибки сервера по коду
  const ERR = {
    network: 'Нет связи с сервером. Проверьте интернет и повторите.',
    maintenance: 'Ведутся технические работы. Вернитесь позже.',
    invalid_code: 'Такого кода нет. Проверьте код у старосты.',
    too_many_attempts: 'Слишком много попыток. Подождите 15 минут.',
    too_many_requests: 'Слишком много запросов. Подождите немного.',
    student_taken: 'Эту фамилию уже выбрал другой человек. Выберите другую или обратитесь к старосте.',
    login_taken: 'Такой логин занят. Придумайте другой.',
    email_taken: 'Эта почта уже зарегистрирована. Войдите или используйте другую.',
    bad_login: 'Логин: 3–32 символа, строчные латинские буквы, цифры, точка и подчёркивание.',
    bad_password: 'Пароль: от 8 до 72 символов.',
    bad_email: 'Проверьте адрес почты.',
    bad_name: 'Укажите фамилию и имя.',
    consent_required: 'Нужно согласие на обработку данных.',
    no_student: 'Эта запись больше недоступна. Выберите другую.',
    not_pending: 'Действие уже недоступно.',
    unauthorized: 'Сначала войдите.',
    bseu_unavailable: 'Сайт bseu.by сейчас не отвечает. Попробуйте позже или отправьте заявку без расписания.',
    server_error: 'Что-то пошло не так на сервере. Повторите позже.',
  };
  J2.errText = (code) => ERR[code] || 'Не получилось. Повторите.';

  J2.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  J2.$ = (id) => document.getElementById(id);

  // Сегодня и завтра для подписей
  J2.fmtDate = (d) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  J2.fmtTime = (d) => new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // Согласие на обработку данных: версия и хэш текста сохраняются на сервере. Текст один на все страницы.
  J2.CONSENT_VERSION = '2026-11-05';
  J2.CONSENT_TEXT = [
    ['Что хранится', 'ФИО, группа и форма обучения, пропуски и справки, оценки.'],
    ['Кто видит', 'Вы видите всё своё. Староста группы видит пропуски и справки. Преподаватели видят только свои предметы.'],
    ['Ваши права', 'Можно запросить удаление своих данных. Данные выпускников удаляются через год после выпуска.'],
  ];
  J2.consentHash = async function () {
    const text = J2.CONSENT_VERSION + '|' + J2.CONSENT_TEXT.map((x) => x.join(': ')).join('|');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Состояние кнопки «идёт запрос»: защита от двойного нажатия
  J2.busy = async function (btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  };
})();
