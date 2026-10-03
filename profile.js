// ============================================================================
// Личный кабинет: вход, профиль, аватар, MarketPass, справки, зачётка,
// калькулятор рейтинга, пропуски и календарь, настройки, вход в админку.
//
// Это перенесённый код cabinet.html, а не переписанный заново. Логика, имена
// функций и ключи localStorage остались прежними, поэтому у студентов
// сохраняются оценки, состояние калькулятора и вход.
//
// Что при переносе убрано как дубль (то же самое есть в index.html):
//   tgSupports, haptic, applyTelegramTheme, onTelegramBack,
//   syncTelegramBackButton, setupTelegram, showAlert, showConfirm,
//   formatDateShort, getSemesterRange, getPeriodRangeFor,
//   buildSubjectBreakdown, certStatusBadge, renderDataLastUpdated,
//   а также DEFAULT_SUBJECTS, TG, appData, sb, PROFILE_CACHE_KEY.
//
// Что переименовано, потому что имя занято и логика своя:
//   init          -> initProfile
//   updateAdminUI -> updateProfileAdminUI
//
// Что убрано совсем:
//   объявления (renderCabinetAnnouncements и соседи) — раздел упразднён;
//   прежние виджеты сводки кабинета (setDashWidget, лента с фильтрами,
//   «Место в группе») — вместо них четыре блока нового профиля.
//
// Разделы кабинета больше не переключаются сами: «Зачётка» и «Дедлайны»
// стали экранами раздела «Учёба», и всем заведует общий роутер приложения.
// ============================================================================
'use strict';

  // FX — лёгкие анимации на CSS (классы .fx-reveal и .fx-pop в app.css): JS только расставляет классы
  // и задержки, анимируются лишь transform и opacity. При «Уменьшении движения» FX выключен
  // (и CSS всё равно гасит анимации) — сайт работает так же, просто без движения.
  const FX = (() => {
    const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const on = !reduce;

    function toList(target) {
      if (!target) return [];
      if (typeof target === 'string') return Array.from(document.querySelectorAll(target));
      if (target instanceof Element) return [target];
      return Array.from(target);
    }

    function isShown(el) { return el.getClientRects().length > 0; }

    // После анимации снимаем класс и переменные, чтобы повторный вызов проиграл её снова
    function cleanup(el) {
      el.classList.remove('fx-reveal', 'fx-pop');
      ['--fx-delay', '--fx-y', '--fx-dur'].forEach(v => el.style.removeProperty(v));
    }

    // Запуск: снять класс со всех, один пересчёт стилей, настроить и снова добавить класс
    function run(els, cls, setup) {
      els.forEach(el => el.classList.remove(cls));
      if (els.length) void els[0].offsetWidth;
      els.forEach((el, i) => {
        setup(el, i);
        const done = (e) => {
          if (e.target !== el) return;
          el.removeEventListener('animationend', done);
          cleanup(el);
        };
        el.addEventListener('animationend', done);
        el.classList.add(cls);
      });
    }

    // Плавное появление снизу вверх, элементы по очереди (время — в секундах, как раньше).
    // y: 0 — только прозрачность (для строк таблиц <tr>)
    function reveal(target, opts = {}) {
      if (!on) return;
      const { y = 12, delay = 0, step = 0.04, max = 12, duration = 0.3, includeHidden = false } = opts;
      const els = toList(target).filter(el => includeHidden || isShown(el));
      const ms = (sec) => `${Math.round(sec * 1000)}ms`;
      run(els, 'fx-reveal', (el, i) => {
        el.style.setProperty('--fx-delay', ms(delay + Math.min(i, max) * step));
        el.style.setProperty('--fx-y', `${y}px`);
        el.style.setProperty('--fx-dur', ms(Math.min(Math.max(duration, 0.15), 0.35)));
      });
    }

    // Лёгкое «пружинящее» нажатие — для иконок таб-бара
    function pop(target) {
      if (!on) return;
      run(toList(target), 'fx-pop', () => {});
    }

    // Число «набегает» от текущего значения к новому (350 мс)
    function count(el, to) {
      if (!el) return;
      const target = Number(to);
      const from = parseFloat(el.innerText) || 0;
      if (!on || !Number.isFinite(target) || !Number.isInteger(target) || !Number.isInteger(from) || from === target) {
        el.innerText = to;
        return;
      }
      const token = el.__fxCount = {};
      const start = performance.now();
      const tick = (now) => {
        if (el.__fxCount !== token) return;
        const t = Math.min((now - start) / 350, 1);
        el.innerText = t < 1 ? Math.round(from + (target - from) * (1 - Math.pow(1 - t, 3))) : to;
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    if (on) {
      // Нажатие на вкладку нижней панели
      document.addEventListener('click', e => {
        const item = e.target.closest && e.target.closest('.tabbar-item');
        if (item) pop(item.querySelectorAll('.tab-ico'));
      });
      // Содержимое окна Bootstrap появляется по очереди
      document.addEventListener('show.bs.modal', e => {
        reveal(e.target.querySelectorAll('.modal-body > *'), { y: 8, step: 0.03, max: 8, duration: 0.3, includeHidden: true });
      });
    }

    return { enabled: on, reveal, pop, count };
  })();



  function formatDateFull(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput || '—');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()}`;
  }

  let myStudentId = null;

  // Цвет шапки и фона в Telegram берём из текущей темы: appBgColor() — в theme.js






  // Вибрация при переключении разделов кабинета
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.tabbar-item')) haptic('impact');
  });

  // Личная часть запускается из init() в index.html — после того, как
  // страница загрузила data.json и настроила Telegram. Свою загрузку данных
  // и свой setupTelegram кабинет больше не делает: это была вторая копия.
  async function initProfile() {
    document.getElementById('cabinetSkeleton').classList.add('d-none');
    await openPersonalCabinet();
    renderAppVersionLabel('cabinetVersion');
    renderNotifySettings();
    startNotifyFlow(checkWhatsNew());
    checkLocalReminders();
  }

  // «Что нового», номер версии и история изменений — в changelog.js (общий для обеих страниц).
  // Там же checkWhatsNew(): окно показывается один раз на каждую новую версию.

  function getStarostaContact() {
    const exact = appData.students.find(s => s.telegramUsername && (s.role || '').trim().toLowerCase() === 'староста');
    if (exact) return exact;
    return appData.students.find(s => s.telegramUsername && (s.role || '').toLowerCase().includes('старост'));
  }



  // --- Вход в личный кабинет: Supabase Auth ---
  // В коде только адрес проекта и публичный ключ (sb_publishable): что можно читать и менять,
  // решают правила RLS в базе. Логин превращается в технический email <логин>@students.journal-24dmm2.app.
  // Аккаунты создаёт Edge Function register-with-code по одноразовому коду от старосты.
  // SUPABASE_URL и SUPABASE_KEY — в env.js
  const LOGIN_EMAIL_DOMAIN = 'students.journal-24dmm2.app';
  const LOGIN_RE = /^[a-z0-9_.]{3,32}$/;
  const PASSWORD_MIN = 8;
  let myProfile = null;
  let inviteState = null;   // { code, student_id, has_account, login } — между шагами «Первого входа»

  const loginToEmail = (login) => `${login}@${LOGIN_EMAIL_DOMAIN}`;
  const normLogin = (v) => String(v || '').trim().toLowerCase();
  const NO_NETWORK_TEXT = 'Нет соединения с интернетом. Проверьте сеть и попробуйте ещё раз.';
  const AUTH_ERRORS = {
    invalid_credentials: 'Неверный логин или пароль.',
    invalid_code: 'Код не найден. Проверьте, что он введён без ошибок.',
    code_used: 'Этот код уже использован. Если вы забыли пароль, попросите у старосты новый код.',
    login_taken: 'Этот логин уже занят. Придумайте другой.',
    bad_login: 'Логин: от 3 до 32 символов — латинские буквы, цифры, «_» и «.».',
    bad_password: `Пароль должен быть не короче ${PASSWORD_MIN} символов.`,
    weak_password: `Пароль должен быть не короче ${PASSWORD_MIN} символов.`,
    same_password: 'Новый пароль совпадает с текущим.',
    too_many_attempts: 'Слишком много попыток. Подождите 15 минут и попробуйте снова.',
    over_request_rate_limit: 'Слишком много попыток. Подождите несколько минут и попробуйте снова.',
    unauthorized: 'Сессия закончилась. Войдите заново.',
    session_not_found: 'Сессия закончилась. Войдите заново.',
    no_profile: 'Аккаунт не привязан к студенту. Обратитесь к старосте.'
  };

  function isNetworkError(err) {
    if (!navigator.onLine) return true;
    const name = (err && err.name) || '';
    const msg = (err && err.message) || '';
    return name === 'AuthRetryableFetchError' || name === 'NetworkError' || /Failed to fetch|NetworkError|Load failed|network/i.test(msg);
  }
  function authErrorText(err) {
    if (isNetworkError(err)) return NO_NETWORK_TEXT;
    const code = (err && err.code) || '';
    if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
    if (err && err.status === 429) return AUTH_ERRORS.too_many_attempts;
    return 'Что-то пошло не так. Попробуйте ещё раз.';
  }
  function failWith(code) { const e = new Error(code); e.code = code; return e; }

  // Вызов Edge Function; ответ с ошибкой превращается в исключение с кодом ошибки
  async function callFunction(name, body, accessToken) {
    const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      const err = failWith('network'); err.name = 'NetworkError'; throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw failWith(data.error || (res.status === 429 ? 'too_many_attempts' : 'server_error'));
    return data;
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function readCachedProfile() {
    try { return JSON.parse(lsGet(PROFILE_CACHE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeCachedProfile(profile) {
    try {
      if (profile) lsSet(PROFILE_CACHE_KEY, JSON.stringify(profile));
      else lsRemove(PROFILE_CACHE_KEY);
    } catch (e) {}
  }

  // student_id вошедшего студента — только из его строки в profiles (RLS отдаёт лишь свою)
  async function loadMyProfile(session) {
    try {
      const { data, error } = await sb.from('profiles').select('student_id, login').eq('user_id', session.user.id).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const profile = { user_id: session.user.id, student_id: data.student_id, login: data.login };
      writeCachedProfile(profile);
      return profile;
    } catch (e) {
      const cached = readCachedProfile();
      if (isNetworkError(e) && cached && cached.user_id === session.user.id) return cached;
      throw e;
    }
  }

  async function openPersonalCabinet() {
    lsRemove('my_student_id');   // старый вход user## больше не используется
    const cached = readCachedProfile();
    if (!sb) {
      // supabase-js не загрузился (нет сети): показываем кабинет по сохранённому профилю
      if (cached) { enterCabinet(cached); return; }
      showLoginForm();
      showAlert(NO_NETWORK_TEXT);
      return;
    }
    let session = null;
    try { ({ data: { session } } = await sb.auth.getSession()); } catch (e) {}
    if (!session) {
      if (cached && !navigator.onLine) { enterCabinet(cached); return; }
      writeCachedProfile(null);
      showLoginForm();
      return;
    }
    try {
      const profile = await loadMyProfile(session);
      if (!profile) { await signOutQuietly(); showLoginForm(); showAlert(AUTH_ERRORS.no_profile); return; }
      enterCabinet(profile);
    } catch (e) {
      showLoginForm();
      showAlert(authErrorText(e));
    }
  }

  function enterCabinet(profile) {
    if (!appData.students.find(s => s.id === profile.student_id)) {
      showLoginForm();
      showAlert('Студент не найден в журнале. Обратитесь к старосте.');
      return;
    }
    myProfile = profile;
    myStudentId = profile.student_id;
    document.body.classList.remove('is-login');
    showCabinetContent();
    loadMyAvatar();
  }

  function showLoginForm() {
    document.getElementById('cabinetLoginInput').value = '';
    document.getElementById('cabinetPasswordInput').value = '';
    resetInviteForm();
    setAuthTab('login');
    document.body.classList.add('is-login');   // до входа разделы кабинета не нужны
    document.getElementById('cabinetLoginSection').classList.remove('d-none');
    document.getElementById('cabinetContentSection').classList.add('d-none');
    FX.reveal(document.getElementById('cabinetLoginSection').children, { step: 0.05 });
  }

  function setAuthTab(tab) {
    const invite = tab === 'invite';
    document.getElementById('authSeg').dataset.active = invite ? 'invite' : 'login';
    document.getElementById('authTabLogin').setAttribute('aria-selected', String(!invite));
    document.getElementById('authTabInvite').setAttribute('aria-selected', String(invite));
    document.getElementById('authPaneLogin').classList.toggle('d-none', invite);
    document.getElementById('authPaneInvite').classList.toggle('d-none', !invite);
  }

  async function attemptLogin() {
    const login = normLogin(document.getElementById('cabinetLoginInput').value);
    const password = document.getElementById('cabinetPasswordInput').value;
    if (!login || !password) { showAlert('Введите логин и пароль.'); return; }
    if (!LOGIN_RE.test(login)) { haptic('error'); showAlert(AUTH_ERRORS.invalid_credentials); return; }
    if (!sb) { showAlert(NO_NETWORK_TEXT); return; }
    const btn = document.getElementById('loginSubmitBtn');
    setBusy(btn, true);
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email: loginToEmail(login), password });
      if (error) throw error;
      const profile = await loadMyProfile(data.session);
      if (!profile) { await signOutQuietly(); throw failWith('no_profile'); }
      haptic('success');
      enterCabinet(profile);
    } catch (e) {
      haptic('error');
      showAlert(authErrorText(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // «Первый вход», шаг 1: код → чей он (ФИО берём из data.json по student_id)
  async function submitInviteCode() {
    const code = document.getElementById('inviteCodeInput').value.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{10}$/.test(code)) { showAlert('Код состоит из 10 букв и цифр, например ABCDE-23456.'); return; }
    const btn = document.getElementById('inviteCodeBtn');
    setBusy(btn, true);
    try {
      const info = await callFunction('register-with-code', { action: 'check', code });
      const student = appData.students.find(s => s.id === info.student_id);
      if (!student) { showAlert('Этот код выдан студенту, которого нет в журнале. Обратитесь к старосте.'); return; }
      inviteState = { code, ...info };
      document.getElementById('inviteStudentName').innerText = `${student.lastName} ${student.firstName}`;
      document.getElementById('inviteAccountNote').innerText = info.has_account
        ? `У вас уже есть аккаунт с логином «${info.login}». Задайте новый пароль, логин можно оставить.`
        : 'Придумайте логин и пароль — с ними вы будете входить в кабинет.';
      document.getElementById('newLoginInput').value = info.login || '';
      document.getElementById('inviteSubmitBtn').innerText = info.has_account ? 'Сохранить и войти' : 'Создать аккаунт';
      document.getElementById('inviteCodeForm').classList.add('d-none');
      document.getElementById('inviteAccountForm').classList.remove('d-none');
      FX.reveal(document.getElementById('inviteAccountForm').children, { step: 0.04 });
    } catch (e) {
      haptic('error');
      showAlert(authErrorText(e));
    } finally {
      setBusy(btn, false);
    }
  }

  // «Первый вход», шаг 2: логин и пароль → аккаунт создан (или задан новый пароль) → вход
  async function submitNewAccount() {
    if (!inviteState) { resetInviteForm(); return; }
    const login = normLogin(document.getElementById('newLoginInput').value);
    const password = document.getElementById('newPasswordInput').value;
    const repeat = document.getElementById('newPasswordRepeatInput').value;
    if (!LOGIN_RE.test(login)) { showAlert(AUTH_ERRORS.bad_login); return; }
    if (password.length < PASSWORD_MIN) { showAlert(AUTH_ERRORS.bad_password); return; }
    if (password !== repeat) { showAlert('Пароли не совпадают.'); return; }
    if (!sb) { showAlert(NO_NETWORK_TEXT); return; }
    const btn = document.getElementById('inviteSubmitBtn');
    setBusy(btn, true);
    try {
      await callFunction('register-with-code', { action: 'register', code: inviteState.code, login, password });
      const { data, error } = await sb.auth.signInWithPassword({ email: loginToEmail(login), password });
      if (error) throw error;
      const profile = await loadMyProfile(data.session);
      if (!profile) throw failWith('no_profile');
      haptic('success');
      enterCabinet(profile);
    } catch (e) {
      haptic('error');
      showAlert(authErrorText(e));
    } finally {
      setBusy(btn, false);
    }
  }

  function resetInviteForm() {
    inviteState = null;
    ['inviteCodeInput', 'newLoginInput', 'newPasswordInput', 'newPasswordRepeatInput'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('inviteCodeForm').classList.remove('d-none');
    document.getElementById('inviteAccountForm').classList.add('d-none');
  }

  // Формы «Сменить логин» / «Сменить пароль» раскрываются прямо в списке (одна за раз)
  function toggleAccountForm(which) {
    const forms = { login: 'changeLoginForm', password: 'changePasswordForm' };
    Object.keys(forms).forEach(key => {
      const el = document.getElementById(forms[key]);
      const open = key === which && el.classList.contains('d-none');
      el.classList.toggle('d-none', !open);
      if (open) FX.reveal(el.children, { step: 0.03 });
    });
    if (which === 'login' && myProfile) document.getElementById('changeLoginInput').value = myProfile.login;
    if (which === 'password') {
      ['currentPasswordInput', 'changePasswordInput', 'changePasswordRepeatInput'].forEach(id => { document.getElementById(id).value = ''; });
      document.getElementById('changePasswordUsername').value = myProfile ? myProfile.login : '';
    }
  }

  async function currentSession() {
    if (!sb) throw failWith('network');
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw failWith('unauthorized');
    return session;
  }

  async function saveNewLogin() {
    const login = normLogin(document.getElementById('changeLoginInput').value);
    if (!LOGIN_RE.test(login)) { showAlert(AUTH_ERRORS.bad_login); return; }
    if (myProfile && login === myProfile.login) { toggleAccountForm(null); return; }
    const btn = document.getElementById('changeLoginBtn');
    setBusy(btn, true);
    try {
      const session = await currentSession();
      await callFunction('change-login', { login }, session.access_token);
      try { await sb.auth.refreshSession(); } catch (e) {}
      myProfile = { ...myProfile, login };
      writeCachedProfile(myProfile);
      document.querySelectorAll('#cabinetLoginValue, .js-login').forEach(el => { el.innerText = login; });
      toggleAccountForm(null);
      haptic('success');
      showAlert(`Логин изменён. Теперь входите с логином «${login}».`);
    } catch (e) {
      haptic('error');
      if (e.code === 'unauthorized') { await logoutCabinet(); }
      showAlert(authErrorText(e));
    } finally {
      setBusy(btn, false);
    }
  }

  async function saveNewPassword() {
    const current = document.getElementById('currentPasswordInput').value;
    const next = document.getElementById('changePasswordInput').value;
    const repeat = document.getElementById('changePasswordRepeatInput').value;
    if (!current) { showAlert('Введите текущий пароль.'); return; }
    if (next.length < PASSWORD_MIN) { showAlert(AUTH_ERRORS.bad_password); return; }
    if (next !== repeat) { showAlert('Новые пароли не совпадают.'); return; }
    if (next === current) { showAlert(AUTH_ERRORS.same_password); return; }
    const btn = document.getElementById('changePasswordBtn');
    setBusy(btn, true);
    try {
      await currentSession();
      // Сначала подтверждаем текущий пароль — чтобы чужой человек с открытым кабинетом не сменил его
      const check = await sb.auth.signInWithPassword({ email: loginToEmail(myProfile.login), password: current });
      if (check.error) {
        if (check.error.code === 'invalid_credentials') { haptic('error'); showAlert('Текущий пароль введён неверно.'); return; }
        throw check.error;
      }
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) throw error;
      toggleAccountForm(null);
      haptic('success');
      showAlert('Пароль изменён.');
    } catch (e) {
      haptic('error');
      showAlert(authErrorText(e));
    } finally {
      setBusy(btn, false);
    }
  }

  async function signOutQuietly() {
    if (sb) {
      try {
        const { error } = await sb.auth.signOut();
        if (error) await sb.auth.signOut({ scope: 'local' });
      } catch (e) {
        try { await sb.auth.signOut({ scope: 'local' }); } catch (e2) {}
      }
    }
    // Без сети supabase-js мог не загрузиться — стираем сохранённую сессию сами
    try { localStorage.removeItem(SB_STORAGE_KEY); } catch (e) {}   // SB_STORAGE_KEY уже с приставкой — без обёртки
  }

  async function logoutCabinet() {
    await signOutQuietly();
    // Выход из кабинета — выход и из админ-режима: токен не остаётся на общем устройстве
    try { lsRemove('gh_pat'); } catch (e) {}
    if (typeof closeStudak === 'function') closeStudak(true);
    writeCachedProfile(null);
    writeCachedAvatar(null);
    myAvatarUrl = null;
    myProfile = null;
    myStudentId = null;
    showLoginForm();
  }

  // --- Вход администратора (перенесён с главной) ---
  // Строка «Админ-панель» видна только студентам с isAdmin: true (или если токен уже сохранён на устройстве,
  // чтобы можно было выйти). Токен не проверяется — просто сохраняется в localStorage gh_pat, как раньше.
  function readAdminToken() {
    try { return lsGet('gh_pat') || ''; } catch (e) { return ''; }
  }
  function updateProfileAdminUI() {
    const student = appData.students.find(s => s.id === myStudentId);
    const on = !!readAdminToken();
    document.getElementById('adminPanelRow').classList.toggle('d-none', !(student && student.isAdmin) && !on);
    const state = document.getElementById('adminPanelState');
    state.innerText = on ? 'Включена' : 'Войти';
    state.classList.toggle('on', on);
    document.getElementById('adminModeChip').classList.toggle('d-none', !on);
  }
  function renderAdminModal(title) {
    const on = !!readAdminToken();
    document.getElementById('adminLoginView').classList.toggle('d-none', on);
    document.getElementById('adminActiveView').classList.toggle('d-none', !on);
    document.getElementById('adminActiveTitle').innerText = title || 'Админ-режим включён';
  }
  function toggleAdminModal() {
    document.getElementById('adminLoggedOutNote').innerText = '';
    document.getElementById('githubTokenInput').value = '';
    renderAdminModal();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('adminModal')).show();
  }
  function saveAdminToken() {
    const input = document.getElementById('githubTokenInput');
    const token = input.value.trim();
    if (!token) { haptic('error'); return showAlert('Введите токен!'); }
    try { lsSet('gh_pat', token); } catch (e) { return showAlert('Не удалось сохранить токен на этом устройстве'); }
    input.value = '';
    haptic('success');
    updateProfileAdminUI();
    renderAdminModal('Вы вошли как администратор');
  }
  function logoutAdmin() {
    try { lsRemove('gh_pat'); } catch (e) {}
    haptic('success');
    updateProfileAdminUI();
    renderAdminModal();
    document.getElementById('adminLoggedOutNote').innerText = 'Вы вышли из админ-режима.';
  }
  document.getElementById('adminModal').addEventListener('shown.bs.modal', () => {
    if (!readAdminToken()) document.getElementById('githubTokenInput').focus();
  });

  // --- Своя аватарка: Supabase Storage, приватный бакет avatars, путь <user_id>.jpg ---
  // Фото обрезается по центру до квадрата и сжимается до 256×256 JPEG прямо в браузере.
  const AVATAR_CACHE_KEY = 'journal_avatar';   // { user_id, data } — data: URL, чтобы фото было видно и без сети
  const AVATAR_SIZE = 256;
  let myAvatarUrl = null;

  function readCachedAvatar() {
    try { return JSON.parse(lsGet(AVATAR_CACHE_KEY) || 'null'); } catch (e) { return null; }
  }
  function writeCachedAvatar(value) {
    try {
      if (value) lsSet(AVATAR_CACHE_KEY, JSON.stringify(value));
      else lsRemove(AVATAR_CACHE_KEY);
    } catch (e) {}
  }
  const avatarPath = () => `${myProfile.user_id}.jpg`;
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  async function loadMyAvatar() {
    if (!myProfile) return;
    const userId = myProfile.user_id;
    const cached = readCachedAvatar();
    myAvatarUrl = cached && cached.user_id === userId ? cached.data : null;
    renderCabinetAvatars();
    if (!sb) return;
    try {
      const { data, error } = await sb.storage.from('avatars').download(`${userId}.jpg`);
      if (!myProfile || myProfile.user_id !== userId) return;   // за это время вышли или вошёл другой
      if (error) {
        if (isNetworkError(error)) return;                        // без сети остаётся сохранённое фото
        myAvatarUrl = null;                                       // своего фото нет
        writeCachedAvatar(null);
      } else {
        myAvatarUrl = await blobToDataUrl(data);
        writeCachedAvatar({ user_id: userId, data: myAvatarUrl });
      }
    } catch (e) {
      return;
    }
    renderCabinetAvatars();
  }

  function toggleAvatarMenu(force) {
    const menu = document.getElementById('avatarMenu');
    const open = force === undefined ? menu.classList.contains('d-none') : force;
    menu.classList.toggle('d-none', !open);
    document.getElementById('avatarButton').setAttribute('aria-expanded', String(open));
    document.getElementById('avatarResetBtn').classList.toggle('d-none', !myAvatarUrl);
    if (open) FX.reveal(menu.children, { step: 0.03 });
  }

  // Снимок с учётом ориентации (EXIF): createImageBitmap, а если его нет — через <img>
  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  async function squareAvatarJpeg(file) {
    const src = await decodeImage(file);
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    if (!w || !h) throw new Error('decode');
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';                   // прозрачный PNG — на белом, а не на чёрном
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    if (src.close) src.close();
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.85));
  }

  async function handleAvatarFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    toggleAvatarMenu(false);
    if (!file || !myProfile) return;
    if (file.type && !file.type.startsWith('image/')) { showAlert('Выберите фотографию.'); return; }
    let blob;
    try {
      blob = await squareAvatarJpeg(file);
    } catch (e) {
      showAlert('Не удалось открыть это фото. Выберите другое — в формате JPEG или PNG.');
      return;
    }
    const btn = document.getElementById('avatarButton');
    btn.classList.add('is-uploading');
    try {
      await currentSession();
      const { error } = await sb.storage.from('avatars').upload(avatarPath(), blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '60' });
      if (error) throw error;
      myAvatarUrl = await blobToDataUrl(blob);
      writeCachedAvatar({ user_id: myProfile.user_id, data: myAvatarUrl });
      renderCabinetAvatars();
      haptic('success');
    } catch (e) {
      haptic('error');
      showAlert(isNetworkError(e) || e.code === 'network' ? NO_NETWORK_TEXT : e.code === 'unauthorized' ? AUTH_ERRORS.unauthorized : 'Не удалось сохранить фото. Попробуйте ещё раз.');
    } finally {
      btn.classList.remove('is-uploading');
    }
  }

  async function resetAvatar() {
    toggleAvatarMenu(false);
    if (!myAvatarUrl || !(await showConfirm('Сбросить фото профиля?'))) return;
    try {
      await currentSession();
      const { error } = await sb.storage.from('avatars').remove([avatarPath()]);
      if (error) throw error;
      myAvatarUrl = null;
      writeCachedAvatar(null);
      renderCabinetAvatars();
      haptic('success');
    } catch (e) {
      haptic('error');
      showAlert(isNetworkError(e) || e.code === 'network' ? NO_NETWORK_TEXT : 'Не удалось сбросить фото. Попробуйте ещё раз.');
    }
  }

  // Сессию завершили в другой вкладке или её не удалось продлить — возвращаемся к экрану входа
  if (sb) {
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && myStudentId) {
        setTimeout(() => { if (typeof closeStudak === 'function') closeStudak(true); writeCachedProfile(null); writeCachedAvatar(null); myAvatarUrl = null; myProfile = null; myStudentId = null; showLoginForm(); }, 0);
      }
    });
  }

  function showCabinetContent() {
    const student = appData.students.find(s => s.id === myStudentId);
    if (!student) { showLoginForm(); return; }

    document.getElementById('cabinetLoginSection').classList.add('d-none');
    document.getElementById('cabinetContentSection').classList.remove('d-none');
    document.getElementById('cabinetStudentName').innerText = `${student.lastName} ${student.firstName}`;

    const subjectSelect = document.getElementById('cabinetSubject');
    subjectSelect.innerHTML = '<option value="ALL">Все предметы</option>' +
      appData.subjects.map(s => `<option value="${s}">${s}</option>`).join('');

    document.getElementById('starostaPickerList').classList.add('d-none');
    document.querySelectorAll('#cabinetLoginValue, .js-login').forEach(el => { el.innerText = myProfile ? myProfile.login : '—'; });
    toggleAccountForm(null);
    toggleAvatarMenu(false);

    renderPersonalStats();
    updateProfileAdminUI();
    dlCalendarMonth = null;    // календарь дедлайнов открывается на текущем месяце
    renderDeadlines();
    renderMyAbsences();
    renderZachetka();
    setGradesTab(lsGet('grades_tab'));
    FX.reveal('#cabinetContentSection > .student-summary-card');
  }

  // ===== Четыре блока профиля =====
  // Ближайший срок, ближайшая домашка, действующие справки и пропуски
  // по предметам. Данные те же, что и везде: appData и myStudentId.

  // Ближайший дедлайн и ближайшая домашка — по одной строке
  function renderProfileNext() {
    const dl = activeDeadlines()
      .slice()
      .sort((a, b) => deadlineDaysLeft(a) - deadlineDaysLeft(b))[0];
    const elDl = document.getElementById('profileNextDeadline');
    if (elDl) {
      elDl.textContent = dl
        ? (dl.text || dl.subject) + ' · ' + deadlineRelative(deadlineDaysLeft(dl))
        : 'ничего не горит';
    }

    const today = dayKey(new Date());
    const hw = (appData.homework || [])
      .filter(h => !h.dueDate || dayKey(deadlineDate(h.dueDate)) >= today)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    const elHw = document.getElementById('profileNextHomework');
    if (elHw) {
      elHw.textContent = hw
        ? hw.subject + ' · до ' + dlFormatDate(deadlineDate(hw.dueDate))
        : 'заданий нет';
    }
  }

  // Действующие пропуски: уважительные записи, по которым справка ещё
  // не сдана. Сданные показываем ниже отдельной строкой, чтобы было видно,
  // что они приняты, и человек не искал их заново.
  function renderProfileCerts() {
    const box = document.getElementById('profileActiveCerts');
    if (!box) return;
    const mine = myAbsencesSorted().filter(a => a.isExcused && a.certType);
    const pending = mine.filter(a => !a.certSubmitted);
    const done = mine.filter(a => a.certSubmitted);

    if (!mine.length) {
      box.innerHTML = '<div class="row-i"><span class="lbl text-secondary">Справок нет</span></div>';
      return;
    }
    // Название предмета приходит из data.json и собирается в HTML — экранируем.
    // certStatusBadge отдаёт готовую разметку, её вставляем как есть.
    const line = (a) =>
      '<div class="row-i"><span class="lbl">' + escapeHtml(a.subject || 'Пропуск') +
      '<small class="d-block text-secondary">' + formatDateShort(a.date) + ' · ' +
      (Number(a.totalHours) || 0) + ' ч</small></span>' +
      '<span class="val">' + certStatusBadge(a) + '</span></div>';

    box.innerHTML = pending.map(line).join('') +
      (done.length
        ? '<div class="row-i"><span class="lbl text-secondary">Принято справок</span>' +
          '<span class="val">' + done.length + '</span></div>'
        : '');
  }

  // Пропуски по предметам: строка раскрывается в свои записи.
  // Считает тот же buildSubjectBreakdown, что и журнал, — цифры сходятся.
  function renderProfileSubjects() {
    const box = document.getElementById('profileSubjects');
    if (!box) return;
    const mine = myAbsencesSorted();
    const map = buildSubjectBreakdown(mine);
    const rows = Object.keys(map)
      .map(sub => ({ sub, ...map[sub], total: map[sub].unexcused + map[sub].excused }))
      .filter(r => r.total > 0)
      .sort((a, b) => b.unexcused - a.unexcused || b.total - a.total);

    if (!rows.length) {
      box.innerHTML = '<div class="row-i"><span class="lbl text-secondary">Пропусков нет</span></div>';
      return;
    }

    box.innerHTML = rows.map((r, i) => {
      const id = 'subjBody' + i;
      const recs = mine.filter(a => (a.subject || 'Прочее') === r.sub)
        // Комментарий к пропуску админ пишет руками — экранируем перед вставкой
        .map(a => '<div class="row-i"><span class="lbl">' + formatDateShort(a.date) +
          '<small class="d-block text-secondary">' + (a.isExcused ? 'уважительный' : 'неуважительный') +
          (a.comment ? ' · ' + escapeHtml(a.comment) : '') + '</small></span>' +
          '<span class="val">' + (Number(a.totalHours) || 0) + ' ч</span></div>').join('');
      return '<button type="button" class="subj-row" aria-expanded="false" aria-controls="' + id + '">' +
        '<span class="lbl">' + escapeHtml(r.sub) + '</span>' +
        '<span class="val">' + r.unexcused + ' / ' + r.excused + '</span>' +
        '<span class="chev" aria-hidden="true">⌄</span></button>' +
        '<div class="subj-body" id="' + id + '">' + recs + '</div>';
    }).join('') +
      '<div class="row-i"><span class="lbl text-secondary">неуважительные / уважительные, часы</span></div>';
  }

  // Раскрытие строки предмета
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('.subj-row');
    if (!row) return;
    const body = document.getElementById(row.getAttribute('aria-controls'));
    if (!body) return;
    const open = body.classList.toggle('open');
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    haptic('selection');
  });

  afterRender('renderMyAbsences', () => { renderProfileCerts(); renderProfileSubjects(); });
  afterRender('renderDeadlines', renderProfileNext);
  afterRender('showCabinetContent', () => { renderProfileNext(); renderProfileCerts(); renderProfileSubjects(); });

  // Разделы кабинета переехали в общий роутер приложения: «Зачётка» и «Дедлайны»
  // стали отдельными экранами раздела «Учёба», а то, что осталось личным, живёт
  // на экране «Профиль». Обёртка ниже сохранена, потому что на неё ссылается
  // календарь дедлайнов, — она просто просит роутер открыть нужный экран.
  function setCabinetSection(section) {
    if (section === 'grades') { goView('zachetka'); return; }
    if (section === 'deadlines') { goView('deadlines'); return; }
    goView('profile');
  }

  function renderPersonalStats() {
    if (!myStudentId) return;
    const period = document.getElementById('cabinetPeriod').value;
    const subject = document.getElementById('cabinetSubject').value;
    const range = getPeriodRangeFor(period);

    let unexcused = 0, excused = 0;
    appData.absences.forEach(a => {
      if (a.studentId !== myStudentId) return;
      if (subject !== 'ALL' && a.subject !== subject) return;
      if (range) {
        const d = new Date(a.date);
        if (isNaN(d.getTime()) || d < range.start || d >= range.end) return;
      }
      if (a.isExcused) excused += Number(a.totalHours);
      else unexcused += Number(a.totalHours);
    });

    FX.count(document.getElementById('cabinetUnexcused'), unexcused);
    FX.count(document.getElementById('cabinetExcused'), excused);
  }



  function renderMyAbsences() {
    renderDataLastUpdated();
    if (!myStudentId) return;
    const studentAbs = appData.absences.filter(a => a.studentId === myStudentId);

    const subjectMap = buildSubjectBreakdown(studentAbs);
    const subjectBody = document.getElementById('myAbsSubjectBody');
    subjectBody.innerHTML = '';
    Object.keys(subjectMap).forEach(sub => {
      const u = subjectMap[sub].unexcused;
      const e = subjectMap[sub].excused;
      if (u > 0 || e > 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="text-start fw-bold text-white">${sub}</td>
          <td class="text-warning">${u}</td>
          <td class="text-success">${e}</td>
          <td class="fw-bold">${u + e}</td>
        `;
        subjectBody.appendChild(tr);
      }
    });

    const listEl = document.getElementById('myAbsList');
    listEl.innerHTML = '';
    if (studentAbs.length === 0) {
      listEl.innerHTML = '<div class="p-3 text-secondary text-center">Пропусков нет</div>';
    } else {
      const sorted = [...studentAbs].sort((a, b) => new Date(b.date) - new Date(a.date));
      sorted.forEach(a => {
        const item = document.createElement('div');
        item.className = 'p-3 border-bottom border-secondary border-opacity-25';
        const subName = a.subject || (a.subjects ? a.subjects.join(', ') : 'Предмет не указан');
        const badge = certStatusBadge(a);
        item.innerHTML = `
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div>
              <div class="fw-bold text-white">${formatDateShort(a.date)} — ${subName} (${a.totalHours} ч)</div>
              <div class="small text-secondary">${a.comment || 'Без комментария'}</div>
            </div>
            <span class="badge ${a.isExcused ? 'bg-success' : 'bg-danger'} flex-shrink-0">${a.isExcused ? 'Уважительный' : 'Неуважительный'}</span>
          </div>
          ${badge ? `<div class="mt-2">${badge}</div>` : ''}
        `;
        listEl.appendChild(item);
      });
    }
  }



  function toggleStarostaPicker() {
    const container = document.getElementById('starostaPickerList');
    const wasHidden = container.classList.contains('d-none');
    container.classList.toggle('d-none');
    if (wasHidden) {
      renderStarostaPicker();
      FX.reveal(container.children, { y: 6, step: 0.03 });
    }
  }

  function renderStarostaPicker() {
    const container = document.getElementById('starostaPickerList');
    const starosta = getStarostaContact();
    if (!starosta) {
      container.innerHTML = '<div class="small text-secondary p-2">У старосты пока не указан Telegram username — попросите админа его добавить.</div>';
      return;
    }
    const abs = appData.absences.filter(a => a.studentId === myStudentId)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    if (abs.length === 0) {
      container.innerHTML = '<div class="small text-secondary p-2">Пропусков нет.</div>';
      return;
    }
    container.innerHTML = abs.map(a => {
      const subName = a.subject || 'Предмет не указан';
      const text = encodeURIComponent(`Привет! У меня вопрос по пропуску ${formatDateFull(a.date)} по предмету «${subName}». Можешь помочь?`);
      const url = `https://t.me/${starosta.telegramUsername}?text=${text}`;
      return `<button type="button" class="btn btn-outline-secondary btn-sm w-100 text-start mb-2"
                 onclick="openTelegramChat('${url}')">${formatDateShort(a.date)} — ${subName}</button>`;
    }).join('');
  }

  function openTelegramChat(url) {
    try {
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink) {
        window.Telegram.WebApp.openTelegramLink(url);
        return;
      }
    } catch (e) {}
    window.open(url, '_blank');
  }

  // --- Моя зачётка ---
  const ZACHETKA_EXCLUDED_SUBJECTS = ['Кураторский час', 'Физическая культура'];
  // Не входит в общий список предметов журнала (нет посещаемости/преподавателя) — только строка в зачётке
  const ZACHETKA_EXTRA_SUBJECTS = ['Летняя практика'];
  const ZACHETKA_GRADE_OPTIONS = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  function loadZachetkaState() {
    try {
      return JSON.parse(lsGet('zachetka_grades') || '{}');
    } catch (e) {
      return {};
    }
  }

  function renderZachetka() {
    const grades = loadZachetkaState();
    const container = document.getElementById('zachetkaList');
    const subjects = appData.subjects.filter(s => !ZACHETKA_EXCLUDED_SUBJECTS.includes(s)).concat(ZACHETKA_EXTRA_SUBJECTS);
    container.innerHTML = subjects.map(subj => {
      const current = grades[subj] !== undefined ? String(grades[subj]) : '';
      const optionsHtml = ['<option value="">—</option>']
        .concat(ZACHETKA_GRADE_OPTIONS.map(g => `<option value="${g}" ${current === String(g) ? 'selected' : ''}>${g}</option>`))
        .concat([`<option value="зач" ${current === 'зач' ? 'selected' : ''}>Зачтено (зач)</option>`])
        .join('');
      return `
        <div class="d-flex justify-content-between align-items-center mb-2">
          <div class="small text-white">${subj}</div>
          <select class="form-select form-select-sm" style="width: 110px;"
                  onchange="updateZachetkaGrade('${subj.replace(/'/g, "\\'")}', this.value)">
            ${optionsHtml}
          </select>
        </div>
      `;
    }).join('');
    updateZachetkaAverage(grades);
  }

  function updateZachetkaGrade(subject, value) {
    const grades = loadZachetkaState();
    if (!value) delete grades[subject];
    else if (value === 'зач') grades[subject] = 'зач';
    else grades[subject] = Number(value);
    lsSet('zachetka_grades', JSON.stringify(grades));
    updateZachetkaAverage(grades);
  }

  function updateZachetkaAverage(grades) {
    const vals = Object.values(grades).filter(v => typeof v === 'number');
    const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    document.getElementById('zachetkaAverage').innerText = avg !== null ? avg.toFixed(2) : '—';
  }




  // --- Дедлайны и календарь — общий код в shared.js. Здесь только своё для кабинета:
  // сроки справок вошедшего студента. Справка попадает в календарь, если пропуск уважительный,
  // указаны certType и certDueDate и справка ещё не сдана (certSubmitted).
  // Просроченная — красная ячейка и красная метка. shared.js вызывает deadlineExtraEvents и certDueCard.
  function deadlineExtraEvents(add) {
    const certs = {};
    (myStudentId ? myAbsencesSorted() : []).forEach(a => {
      if (!a.isExcused || !a.certType || !a.certDueDate || a.certSubmitted) return;
      const k = String(a.certDueDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
      const id = k + '|' + a.certType;
      if (!certs[id]) { certs[id] = { kind: 'cert', dueDate: k, certType: a.certType, list: [], over: deadlineDaysLeft(k) < 0 }; add(k, certs[id]); }
      certs[id].list.push(a);
    });
    // Свои пропуски по дням: день подкрашен (неуважительный — красным, уважительный — зелёным)
    (myStudentId ? myAbsencesSorted() : []).forEach(a => {
      const d = new Date(a.date); if (isNaN(d.getTime())) return;
      add(dayKey(d), { kind: 'abs', a });
    });
  }
  // Карточка пропуска в списке выбранного дня (календарь «Дедлайнов»)
  function absenceDayCard(a) {
    const row = document.createElement('div');
    row.className = 'ev' + (a.isExcused ? ' is-excused' : '');
    const subName = a.subject || (a.subjects ? a.subjects.join(', ') : 'Предмет не указан');
    row.innerHTML = `<span class="ev-ic" aria-hidden="true"></span><div class="ev-body"><div class="fw-bold text-white"></div><div class="small text-secondary"></div><div class="mt-1">${certStatusBadge(a)}</div></div>`;
    row.querySelector('.ev-ic').textContent = a.totalHours;
    row.querySelector('.fw-bold').textContent = `Пропуск · ${subName} · ${a.totalHours} ч`;
    row.querySelector('.small').textContent = (a.isExcused ? 'Уважительный' : 'Неуважительный') + (a.comment ? ` · ${a.comment}` : '');
    return row;
  }
  function certDueCard(c) {
    const n = deadlineDaysLeft(c.dueDate);
    const card = document.createElement('div');
    card.className = 'dl-card is-cert' + (c.over ? ' is-over' : n <= 3 ? ' is-soon' : '');
    card.innerHTML = '<div class="dl-subject"><span class="dl-kind">Справка</span></div><div class="dl-text"></div><div class="dl-meta"><span class="dl-date"></span><span class="dl-rel"></span></div>';
    card.querySelector('.dl-subject').append(c.certType);
    const lines = [...c.list].sort((a, b) => new Date(a.date) - new Date(b.date))
      .map(a => `${formatDateShort(a.date)} · ${a.subject || (a.subjects ? a.subjects.join(', ') : 'Предмет не указан')}`);
    card.querySelector('.dl-text').textContent = `Сдать за пропуски:\n${lines.join('\n')}`;
    card.querySelector('.dl-date').textContent = `до ${formatDateFull(deadlineDate(c.dueDate))}`;
    card.querySelector('.dl-rel').textContent = deadlineRelative(n);
    return card;
  }
  // --- «Сегодня» на первой вкладке: самое срочное + 3 ближайших дедлайна/зачёта ---
  // Срочнее всего — просроченная справка, дальше — ближайшее по дате (справка, дедлайн или зачёт)
  function renderToday() {
    const byDay = deadlineCalendarEvents();
    const items = [];
    Object.keys(byDay).forEach(k => byDay[k].forEach(e => { if (e.kind !== 'abs') items.push({ ...e, key: k, n: deadlineDaysLeft(k) }); }));
    const upcoming = items.filter(e => e.n >= 0).sort((a, b) => a.n - b.n || (a.kind === 'cert' ? -1 : 1));
    const overCert = items.filter(e => e.kind === 'cert' && e.over).sort((a, b) => a.n - b.n)[0];
    const next = overCert || upcoming[0];
    const card = document.getElementById('todayNext');
    card.className = 'w wide today-next' + (next ? '' : ' d-none');   // широкий виджет дашборда
    if (next) {
      const date = formatDateShort(deadlineDate(next.key));
      if (next.kind === 'cert') {
        card.classList.add(next.over ? 'is-over' : 'is-cert');
        const subs = Array.from(new Set(next.list.map(a => a.subject || (a.subjects ? a.subjects.join(', ') : '')).filter(Boolean)));
        document.getElementById('todayNextKind').textContent = `Справка · ${deadlineRelative(next.n)}`;
        document.getElementById('todayNextTitle').textContent = `Сдать: ${next.certType}`;
        document.getElementById('todayNextMeta').textContent = `до ${date}${subs.length ? ' · ' + subs.join(', ') : ''}`;
      } else {
        const z = next.kind === 'zachet';
        card.classList.add(z ? 'is-zachet' : 'is-dl');
        document.getElementById('todayNextKind').textContent = `${z ? 'Зачёт' : 'Дедлайн'} · ${deadlineRelative(next.n)}`;
        document.getElementById('todayNextTitle').textContent = z ? next.d.subject : (next.d.text || next.d.subject);
        document.getElementById('todayNextMeta').textContent = `${z ? '' : 'до '}${date}${z ? (next.d.text ? ' · ' + next.d.text : '') : ' · ' + next.d.subject}`;
      }
    }
    const list = document.getElementById('todayDeadlines');
    const dls = upcoming.filter(e => e.kind !== 'cert');
    list.innerHTML = '';
    if (!dls.length) list.innerHTML = '<div class="today-empty">Ближайших дедлайнов и зачётов нет</div>';
    dls.slice(0, 3).forEach(e => {
      const z = e.kind === 'zachet';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'today-dl' + (z ? ' is-zachet' : e.n <= 3 ? ' is-soon' : '');
      row.innerHTML = '<i aria-hidden="true"></i><span class="t"><span class="ttl"></span><small></small></span><span class="when num"></span>';
      row.querySelector('.ttl').textContent = z ? `Зачёт · ${e.d.subject}` : (e.d.text || e.d.subject);
      row.querySelector('small').textContent = z ? (e.d.text || formatDateShort(deadlineDate(e.key))) : e.d.subject;
      row.querySelector('.when').textContent = e.n <= 1 ? deadlineRelative(e.n) : formatDateShort(deadlineDate(e.key)).slice(0, 5);
      row.addEventListener('click', () => { dlCalendarMonth = new Date(deadlineDate(e.key).getFullYear(), deadlineDate(e.key).getMonth(), 1); dlCalendarDay = e.key; setCabinetSection('deadlines'); renderDeadlineCalendar(); });
      list.appendChild(row);
    });
    const more = document.getElementById('todayDeadlinesMore');
    more.textContent = dls.length > 3 ? `Все ${dls.length} ›` : 'Все ›';
  }
  // Зачётка на «Сегодня»: средний балл из зачётки и итог калькулятора (из тех же ключей localStorage)
  function updateTodayGrades() {
    document.getElementById('todayZachetkaAvg').innerText = document.getElementById('zachetkaAverage').innerText;
    let st = null;
    try { st = JSON.parse(lsGet('rating_calc_state') || 'null'); } catch (e) {}
    const c = st && Array.isArray(st.control) ? st.control : [], o = st && Array.isArray(st.oral) ? st.oral : [];
    const k = parseFloat(lsGet('rating_seminar_coef')) || 0.6;
    const w = parseFloat(lsGet('rating_final_coef')) || 0.4;
    const exam = parseFloat(lsGet('rating_exam_grade'));
    const sem = avgOf(c) * k + avgOf(o) * (1 - k);
    const el = document.getElementById('todayRating');
    if (!c.length && !o.length) el.innerText = '—';
    else el.innerText = isNaN(exam) ? `${sem.toFixed(2)} за семинары` : (sem * w + exam * (1 - w)).toFixed(2);
  }





  // --- Калькулятор рейтинга (перенесён из index.html в «Зачётку»; ключи localStorage прежние) ---
  // Рейтинг за семинарские = средний балл(контрольные) * K1 + средний балл(устные) * (1 - K1)
  // Итоговый рейтинг = рейтинг за семинарские * W1 + оценка на экзамене * (1 - W1)
  // Оценки хранятся только локально в браузере студента (localStorage), в data.json не пишутся
  let ratingCalc = { control: [], oral: [] };

  function loadRatingCalcState() {
    try {
      const saved = JSON.parse(lsGet('rating_calc_state') || 'null');
      if (saved && Array.isArray(saved.control) && Array.isArray(saved.oral)) {
        ratingCalc = saved;
      } else {
        ratingCalc = { control: [], oral: [] };
      }
    } catch (e) {
      ratingCalc = { control: [], oral: [] };
    }
  }

  function saveRatingCalcState() {
    lsSet('rating_calc_state', JSON.stringify(ratingCalc));
  }

  function openRatingCalculator() {
    loadRatingCalcState();
    renderGradesList('control');
    renderGradesList('oral');

    const savedSeminarCoef = lsGet('rating_seminar_coef');
    if (savedSeminarCoef) document.getElementById('seminarCoefSelect').value = savedSeminarCoef;

    const savedFinalCoef = lsGet('rating_final_coef');
    if (savedFinalCoef) document.getElementById('finalCoefSelect').value = savedFinalCoef;

    const savedExam = lsGet('rating_exam_grade');
    document.getElementById('examGradeInput').value = savedExam || '';
    document.getElementById('examNotYet').checked = !savedExam;
    if (savedExam) document.getElementById('examGradeRange').value = savedExam;

    recalcRating();
  }

  // Добавленные оценки — «таблетки»: нажатие убирает оценку
  function renderGradesList(type) {
    const container = document.getElementById(type === 'control' ? 'controlGradesList' : 'oralGradesList');
    container.innerHTML = ratingCalc[type].map((g, i) =>
      `<button type="button" class="rc-pill" onclick="removeRatingGrade('${type}', ${i})" aria-label="Убрать оценку ${g}">${g}</button>`
    ).join('') || '<span class="rc-empty">Пока нет оценок</span>';
  }

  // Добавляет оценку, выбранную ползунком
  function addRatingGrade(type) {
    const range = document.getElementById(type + 'PickRange');
    ratingCalc[type].push(range ? Number(range.value) : 0);
    saveRatingCalcState();
    renderGradesList(type);
    recalcRating();
    haptic('selection');
  }

  function updateRatingGrade(type, index, value) {
    const num = parseFloat(value);
    ratingCalc[type][index] = isNaN(num) ? 0 : num;
    saveRatingCalcState();
    recalcRating();
  }

  function removeRatingGrade(type, index) {
    ratingCalc[type].splice(index, 1);
    saveRatingCalcState();
    renderGradesList(type);
    recalcRating();
  }

  function avgOf(arr) {
    if (!arr.length) return 0;
    return arr.reduce((sum, v) => sum + Number(v), 0) / arr.length;
  }

  // Экзамен: ползунок с шагом 0.5 и «Экзамен ещё не сдан» (тогда оценки нет).
  // Само значение — в скрытом #examGradeInput, как раньше в поле ввода
  function setExamFromRange() {
    document.getElementById('examNotYet').checked = false;
    document.getElementById('examGradeInput').value = document.getElementById('examGradeRange').value;
    recalcRating();
  }
  function toggleExamNotYet() {
    const none = document.getElementById('examNotYet').checked;
    document.getElementById('examGradeInput').value = none ? '' : document.getElementById('examGradeRange').value;
    recalcRating();
  }

  const coefPair = (k) => `${k.toFixed(1)} / ${(1 - k).toFixed(1)}`;
  const ratingBand = (v) => v == null ? '' : v < 4 ? 'v-low' : v < 7 ? 'v-mid' : 'v-high';

  function recalcRating() {
    const controlAvg = avgOf(ratingCalc.control);
    const oralAvg = avgOf(ratingCalc.oral);

    document.getElementById('controlAvg').innerText = ratingCalc.control.length ? controlAvg.toFixed(2) : '—';
    document.getElementById('oralAvg').innerText = ratingCalc.oral.length ? oralAvg.toFixed(2) : '—';

    const k1 = Math.round(parseFloat(document.getElementById('seminarCoefSelect').value) * 10) / 10;
    const k2 = 1 - k1;
    lsSet('rating_seminar_coef', k1);
    document.getElementById('seminarCoefLabel').innerText = coefPair(k1);

    const seminarRating = controlAvg * k1 + oralAvg * k2;
    const hasSeminarGrades = ratingCalc.control.length > 0 || ratingCalc.oral.length > 0;
    document.getElementById('seminarRatingResult').innerText = hasSeminarGrades ? seminarRating.toFixed(2) : '—';

    const examGradeRaw = document.getElementById('examGradeInput').value;
    lsSet('rating_exam_grade', examGradeRaw || '');
    const examGrade = parseFloat(examGradeRaw);
    document.getElementById('examGradeLabel').innerText = isNaN(examGrade) ? '—' : examGrade.toFixed(1);
    document.getElementById('examGradeValue').innerText = isNaN(examGrade) ? '—' : String(examGrade);
    document.getElementById('examGradeRange').classList.toggle('opacity-50', isNaN(examGrade));

    const w1 = Math.round(parseFloat(document.getElementById('finalCoefSelect').value) * 10) / 10;
    const w2 = 1 - w1;
    lsSet('rating_final_coef', w1);
    document.getElementById('finalCoefLabel').innerText = coefPair(w1);

    const finalResultEl = document.getElementById('finalRatingResult');
    const formula = document.getElementById('ratingFormula');
    if (hasSeminarGrades && !isNaN(examGrade)) {
      const final = seminarRating * w1 + examGrade * w2;
      finalResultEl.innerText = final.toFixed(2);
      finalResultEl.className = 'rc-big num ' + ratingBand(final);
      formula.innerText = `${seminarRating.toFixed(2)} × ${w1.toFixed(1)} + ${examGrade} × ${w2.toFixed(1)} = ${final.toFixed(2)}`;
    } else {
      finalResultEl.innerText = '—';
      finalResultEl.className = 'rc-big num';
      formula.innerText = hasSeminarGrades ? 'Укажите оценку на экзамене' : 'Добавьте оценки за семинары';
    }
  }

  async function clearRatingCalc() {
    if (!(await showConfirm('Очистить все введённые оценки калькулятора?'))) return;
    ratingCalc = { control: [], oral: [] };
    lsRemove('rating_calc_state');
    lsRemove('rating_exam_grade');
    document.getElementById('examGradeInput').value = '';
    document.getElementById('examNotYet').checked = true;
    renderGradesList('control');
    renderGradesList('oral');
    recalcRating();
  }

  // Вкладки внутри «Зачётки»: Зачётка / Калькулятор; последняя выбранная запоминается
  function setGradesTab(tab) {
    if (tab !== 'calc') tab = 'zachetka';
    document.getElementById('gradesSeg').dataset.active = tab;
    document.getElementById('gradesSegZachetka').setAttribute('aria-selected', String(tab === 'zachetka'));
    document.getElementById('gradesSegCalc').setAttribute('aria-selected', String(tab === 'calc'));
    document.getElementById('gradesPaneZachetka').classList.toggle('d-none', tab !== 'zachetka');
    document.getElementById('gradesPaneCalc').classList.toggle('d-none', tab !== 'calc');
    if (tab === 'calc') openRatingCalculator();
    try { lsSet('grades_tab', tab); } catch (e) {}
  }

  // ===== Визуальные надстройки кабинета: приветствие, цвет часов, шкала места, хронология по месяцам, аватарка =====
  function periodHours() {
    const range = getPeriodRangeFor(document.getElementById('cabinetPeriod').value);
    const subject = document.getElementById('cabinetSubject').value;
    let unexcused = 0, excused = 0;
    appData.absences.forEach(a => {
      if (a.studentId !== myStudentId) return;
      if (subject !== 'ALL' && a.subject !== subject) return;
      if (range) { const d = new Date(a.date); if (isNaN(d.getTime()) || d < range.start || d >= range.end) return; }
      if (a.isExcused) excused += Number(a.totalHours); else unexcused += Number(a.totalHours);
    });
    return { unexcused, excused };
  }
  function hoursLevel(h) { return h >= 9 ? 'danger' : h >= 5 ? 'warning' : 'ok'; }
  function afterRender(name, fn) {
    const orig = window[name];
    window[name] = function () { const r = orig.apply(this, arguments); try { fn(); } catch (e) { console.error(e); } return r; };
  }
  function currentStudent() { return appData.students.find(s => s.id === myStudentId); }

  afterRender('renderPersonalStats', () => {
    const { unexcused } = periodHours();
    const el = document.getElementById('cabinetUnexcused');
    el.classList.remove('ok', 'warning', 'danger');
    el.classList.add(hoursLevel(unexcused));
  });
  // ===== Лента событий: пропуски, справки и сообщения старосты — по дням, с фильтром =====
    function dayTitle(d) {
    const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (dayKey(d) === dayKey(today)) return 'Сегодня';
    if (dayKey(d) === dayKey(yesterday)) return 'Вчера';
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${d.getFullYear() !== today.getFullYear() ? ' ' + d.getFullYear() : ''}`;
  }
  function myAbsencesSorted() {
    return appData.absences.filter(a => a.studentId === myStudentId).sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  let feedFilter = 'all';
  afterRender('renderMyAbsences', () => {
    const list = document.getElementById('myAbsList');
    const abs = myAbsencesSorted();
    const entries = [];
    const items = [...list.children];
    if (abs.length && items.length === abs.length) {
      items.forEach((item, i) => {
        const a = abs[i];
        item.className = 'ev' + (a.isExcused ? ' is-excused' : '');
        item.dataset.kind = a.isExcused && a.certType ? 'absence cert' : 'absence';
        const body = document.createElement('div');
        body.className = 'ev-body';
        while (item.firstChild) body.appendChild(item.firstChild);
        const ic = document.createElement('span');
        ic.className = 'ev-ic';
        ic.setAttribute('aria-hidden', 'true');
        ic.textContent = a.totalHours;
        item.append(ic, body);
        // Дата уже в заголовке дня: «24.09.26 — Логистика (2 ч)» → «Логистика · 2 ч»
        const title = body.querySelector('.fw-bold');
        if (title) title.textContent = title.textContent.replace(/^\s*\S+\s+—\s+/, '').replace(/\s*\((\d+(?:[.,]\d+)?) ч\)\s*$/, ' · $1 ч');
        entries.push({ ts: new Date(a.date).getTime(), node: item });
      });
    }
    entries.sort((x, y) => y.ts - x.ts);
    list.innerHTML = '';
    let last = '';
    entries.forEach(({ ts, node }) => {
      const d = new Date(ts);
      const key = isNaN(ts) ? 'nodate' : dayKey(d);
      if (key !== last) {
        const h = document.createElement('div');
        h.className = 'feed-day';
        h.textContent = isNaN(ts) ? 'Без даты' : dayTitle(d);
        list.appendChild(h);
        last = key;
      }
      list.appendChild(node);
    });
    renderCertsPending();
    if (!document.getElementById('statsViewCalendar').classList.contains('d-none')) renderCalendar();
  });


  // Справки в «студенческом»: сколько ещё ждём
  function renderCertsPending() {
    const el = document.getElementById('cabinetCertsPending');
    const n = myAbsencesSorted().filter(a => a.isExcused && a.certType && !a.certSubmitted).length;
    el.textContent = n ? `${n} ждём` : 'все сданы';
    el.classList.toggle('warn', n > 0);
    if (!myAbsencesSorted().some(a => a.isExcused && a.certType)) el.textContent = 'нет';
  }

  // ===== Календарь: месяц сеткой, дни с пропусками подсвечены; тап по дню — пропуски этого дня =====
  let calendarMonth = null;     // первое число показываемого месяца
  let calendarDay = null;       // выбранный день (ключ YYYY-MM-DD)
  function calendarAbsences() {
    const subject = document.getElementById('cabinetSubject').value;
    return myAbsencesSorted().filter(a => subject === 'ALL' || a.subject === subject);
  }
  function renderCalendar() {
    const abs = calendarAbsences();
    const byDay = {};
    abs.forEach(a => {
      const d = new Date(a.date); if (isNaN(d.getTime())) return;
      const k = dayKey(d);
      (byDay[k] = byDay[k] || { u: 0, e: 0, list: [] }).list.push(a);
      if (a.isExcused) byDay[k].e += Number(a.totalHours); else byDay[k].u += Number(a.totalHours);
    });
    if (!calendarMonth) {
      const latest = abs.length ? new Date(abs[0].date) : new Date();
      calendarMonth = new Date(latest.getFullYear(), latest.getMonth(), 1);
      if (abs.length) calendarDay = dayKey(latest);
    }
    const y = calendarMonth.getFullYear(), m = calendarMonth.getMonth();
    document.getElementById('calendarTitle').textContent = `${MONTHS_NOM[m]} ${y}`;
    const todayKey = dayKey(new Date());
    const offset = (new Date(y, m, 1).getDay() + 6) % 7;       // понедельник — первый день
    const days = new Date(y, m + 1, 0).getDate();
    let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(w => `<span class="wd">${w}</span>`).join('');
    html += '<span></span>'.repeat(offset);
    for (let d = 1; d <= days; d++) {
      const k = dayKey(new Date(y, m, d));
      const info = byDay[k];
      const cls = ['cal-day'];
      if ((offset + d - 1) % 7 >= 5) cls.push('weekend');
      if (info) cls.push(info.u > 0 ? 'u' : 'e');
      if (k === calendarDay) cls.push('sel');
      if (k === todayKey) cls.push('today');
      const label = info ? `${d} ${MONTHS_GEN[m]}: ${info.u ? info.u + ' ч неуважительных' : ''}${info.u && info.e ? ', ' : ''}${info.e ? info.e + ' ч уважительных' : ''}` : `${d} ${MONTHS_GEN[m]}`;
      html += `<button type="button" class="${cls.join(' ')}" data-day="${k}" aria-label="${label}"${k === calendarDay ? ' aria-pressed="true"' : ''}>${d}</button>`;
    }
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = html;
    grid.querySelectorAll('.cal-day').forEach(b => b.addEventListener('click', () => { calendarDay = b.dataset.day; renderCalendar(); }));
    renderCalendarDay(byDay);
  }
  function renderCalendarDay(byDay) {
    const title = document.getElementById('calendarDayTitle');
    const list = document.getElementById('calendarDayList');
    const [yy, mm, dd] = (calendarDay || '').split('-').map(Number);
    const inMonth = calendarDay && yy === calendarMonth.getFullYear() && mm - 1 === calendarMonth.getMonth();
    if (!inMonth) { title.textContent = ''; list.innerHTML = '<div class="feed-empty">Выберите день, чтобы увидеть пропуски</div>'; return; }
    title.textContent = `${dd} ${MONTHS_GEN[mm - 1]}`;
    const info = byDay[calendarDay];
    if (!info) { list.innerHTML = '<div class="feed-empty">В этот день пропусков нет</div>'; return; }
    const starosta = getStarostaContact();
    list.innerHTML = '';
    info.list.forEach(a => {
      const row = document.createElement('div');
      row.className = 'ev' + (a.isExcused ? ' is-excused' : '');
      const subName = a.subject || (a.subjects ? a.subjects.join(', ') : 'Предмет не указан');
      row.innerHTML = `<span class="ev-ic" aria-hidden="true"></span><div class="ev-body"><div class="fw-bold text-white"></div><div class="small text-secondary"></div><div class="mt-1">${certStatusBadge(a)}</div></div>`;
      row.querySelector('.ev-ic').textContent = a.totalHours;
      row.querySelector('.fw-bold').textContent = `${subName} · ${a.totalHours} ч`;
      row.querySelector('.small').textContent = (a.isExcused ? 'Уважительный' : 'Неуважительный') + (a.comment ? ` · ${a.comment}` : '');
      if (starosta) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ev-link';
        btn.textContent = 'Написать старосте ›';
        const text = encodeURIComponent(`Привет! У меня вопрос по пропуску ${formatDateFull(a.date)} по предмету «${subName}». Можешь помочь?`);
        btn.addEventListener('click', () => openTelegramChat(`https://t.me/${starosta.telegramUsername}?text=${text}`));
        row.querySelector('.ev-body').appendChild(btn);
      }
      list.appendChild(row);
    });
  }
  function shiftCalendarMonth(delta) {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + delta, 1);
    renderCalendar();
  }
  // Предмет в фильтре меняет и календарь; при входе — последний выбранный вид
  afterRender('renderPersonalStats', () => { if (!document.getElementById('statsViewCalendar').classList.contains('d-none')) renderCalendar(); });
  afterRender('showCabinetContent', () => {
    calendarMonth = null; calendarDay = null;
  });
  afterRender('showCabinetContent', () => {
    const s = currentStudent();
    if (s) document.getElementById('cabinetGreeting').innerText = `Привет, ${s.firstName.split(' ')[0]}!`;
  });

  // ===== Аватарка. Фото берём только из того, что Telegram уже передал в initData
  // (initDataUnsafe.user.photo_url) и только если это тот же человек: username в Telegram
  // совпадает с telegramUsername открытого студента. Иначе — инициалы. Никаких запросов к Bot API.
  const AVATAR_COLORS = [['#ff885e', '#ff516a'], ['#ffcd6a', '#ffa85c'], ['#82b1ff', '#665fff'], ['#a0de7e', '#54cb68'],
    ['#53edd6', '#28c9b7'], ['#72d5fd', '#2a9ef1'], ['#e0a2f3', '#d669ed']];
  function studentInitials(s) {
    return (((s.firstName || '').trim()[0] || '') + ((s.lastName || '').trim()[0] || '')).toUpperCase() || '?';
  }
  function telegramPhotoFor(student) {
    const tg = window.Telegram && window.Telegram.WebApp;
    const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (!user || !user.username || !user.photo_url || !student || !student.telegramUsername) return null;
    const norm = (u) => String(u).trim().replace(/^@/, '').toLowerCase();
    if (norm(user.username) !== norm(student.telegramUsername)) return null;
    return /^(https:|data:image\/)/i.test(user.photo_url) ? user.photo_url : null;
  }
  function renderAvatar(el, student, ownUrl) {
    let h = 0;
    for (const ch of String(student.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const [c1, c2] = AVATAR_COLORS[h % AVATAR_COLORS.length];
    el.style.setProperty('--av-bg', `linear-gradient(180deg, ${c1}, ${c2})`);
    el.classList.remove('has-photo');
    el.textContent = studentInitials(student);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${student.firstName} ${student.lastName}`);
    // Порядок: своё фото → фото из Telegram → инициалы. Не загрузилось — пробуем следующее.
    const sources = [ownUrl, telegramPhotoFor(student)].filter(u => u && /^(https:|data:image\/)/i.test(u));
    const tryNext = () => {
      const url = sources.shift();
      if (!url) return;
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => el.classList.add('has-photo');
      img.onerror = () => { img.remove(); el.classList.remove('has-photo'); tryNext(); };
      img.src = url;
      el.appendChild(img);
    };
    tryNext();
  }
  function renderCabinetAvatars() {
    const s = currentStudent();
    if (!s) return;
    document.querySelectorAll('.js-avatar').forEach(el => renderAvatar(el, s, myAvatarUrl));
    document.querySelectorAll('.js-role').forEach(el => { el.innerText = (s.role || '').trim() || 'Студент'; });
  }
  afterRender('showCabinetContent', renderCabinetAvatars);
  // «Сегодня»: средний балл и итог калькулятора обновляются при входе, пересчёте и переключении разделов
  afterRender('showCabinetContent', updateTodayGrades);
  afterRender('recalcRating', updateTodayGrades);
  afterRender('setCabinetSection', updateTodayGrades);
  // ===== Studak: электронный пропуск (оформление и общий код — в studak.js) =====
  // Код в QR — одноразовый токен на 5 минут: его выдаёт issue_pass_token() в Supabase (в базе только хэш),
  // проверяет pass.html через Edge Function verify-pass. Новый код запрашиваем за 20 секунд до конца,
  // прежний при этом сразу гаснет. Пока пропуск закрыт — ничего не запрашиваем.
  const STUDAK_TTL = 300;
  const STUDAK_REFRESH = 20;
  let studakState = null;      // открытый пропуск: { root, timer, stopTilt, loading, retryAt, opener }
  let studakCode = null;       // последний код: { url, expiresAt } — при повторном открытии берём его, если ещё живой
  let studakHideTimer = null;

  function studakIsOpen() { return !!studakState; }
  function studakPassUrl(token) { return new URL(`pass.html?t=${encodeURIComponent(token)}`, location.href).href; }

  function openStudak() {
    const student = currentStudent();
    if (!student || studakState) return;
    clearTimeout(studakHideTimer);
    const overlay = document.getElementById('studakOverlay');
    const stage = document.getElementById('studakStage');
    stage.innerHTML = studakCardHTML({ back: true });
    studakFill(stage, {
      lastName: student.lastName, firstName: student.firstName, role: student.role,
      number: studakNumber(appData.students, student.id),
      login: myProfile && myProfile.login,
      photo: myAvatarUrl || telegramPhotoFor(student),
      initials: studentInitials(student)
    });
    skEl(stage, 'tilt').classList.add('sk-appear');
    const drag = document.getElementById('studakDrag');
    drag.style.transform = drag.style.opacity = '';
    overlay.classList.remove('is-closing');
    overlay.hidden = false;
    overlay.classList.add('is-open');
    document.documentElement.classList.add('sk-lock');
    const st = { root: stage, loading: false, retryAt: 0, opener: document.activeElement };
    studakState = st;
    studakBindFlip(stage, () => haptic('selection'));
    st.stopTilt = studakTilt(stage, document.getElementById('studakTiltBtn'));
    if (studakCode && studakCode.expiresAt - Date.now() > STUDAK_REFRESH * 1000) studakSetQr(stage, studakCode.url);
    else { studakCode = null; studakSetQr(stage, null); }
    studakTick();
    st.timer = setInterval(studakTick, 1000);
    haptic('impact');
    syncTelegramBackButton();
    document.getElementById('studakClose').focus({ preventScroll: true });
  }

  function closeStudak(forget) {
    if (forget) studakCode = null;
    const st = studakState;
    if (!st) return;
    studakState = null;
    clearInterval(st.timer);
    st.stopTilt();
    const overlay = document.getElementById('studakOverlay');
    overlay.classList.add('is-closing');
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    studakHideTimer = setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove('is-open', 'is-closing');
      document.getElementById('studakStage').innerHTML = '';
    }, reduce ? 0 : 200);
    document.documentElement.classList.remove('sk-lock');
    syncTelegramBackButton();
    if (st.opener && st.opener.focus && document.contains(st.opener)) st.opener.focus({ preventScroll: true });
  }

  // Раз в секунду: отсчёт на обороте; пора — просим новый код
  function studakTick() {
    const st = studakState;
    if (!st) return;
    const now = Date.now();
    if (studakCode && studakCode.expiresAt <= now) { studakCode = null; studakSetQr(st.root, null); }
    if (studakCode) studakSetLeft(st.root, (studakCode.expiresAt - now) / 1000, STUDAK_TTL);
    if ((!studakCode || studakCode.expiresAt - now <= STUDAK_REFRESH * 1000) && now >= st.retryAt) studakRequestCode();
  }

  async function studakRequestCode() {
    const st = studakState;
    if (!st || st.loading) return;
    st.loading = true;
    if (!studakCode) studakSetLeft(st.root, 0, 0, 'Получаем код…');
    try {
      if (!sb) throw new Error('offline');
      const sent = Date.now();
      const { data, error } = await sb.rpc('issue_pass_token');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || !row.token) throw new Error('empty');
      // Срок считаем по часам телефона от момента запроса (сервер даёт ровно 5 минут): сбитые часы не мешают
      studakCode = { url: studakPassUrl(row.token), expiresAt: sent + STUDAK_TTL * 1000 };
      if (st !== studakState) return;
      st.retryAt = 0;
      studakSetQr(st.root, studakCode.url);
      studakSetLeft(st.root, (studakCode.expiresAt - Date.now()) / 1000, STUDAK_TTL);
    } catch (e) {
      if (st !== studakState) return;
      const text = String((e && (e.message || e.code)) || '');
      // «too_often» — код выдают не чаще раза в 10 секунд; остальное (нет сети и т.п.) — повтор через 15 секунд
      st.retryAt = Date.now() + (text.includes('too_often') ? 10000 : 15000);
      if (!studakCode) studakSetLeft(st.root, 0, 0, navigator.onLine === false ? 'Нет интернета — код появится, когда связь вернётся' : 'Не удалось получить код, пробуем ещё раз…');
    } finally {
      st.loading = false;
    }
  }

  // Свайп вниз — закрыть (за карту, фон или «ручку» сверху)
  (function () {
    const overlay = document.getElementById('studakOverlay');
    const drag = document.getElementById('studakDrag');
    let start = null;
    overlay.addEventListener('pointerdown', (e) => {
      if (!studakState || !e.isPrimary || e.target.closest('button')) { start = null; return; }
      const pass = skEl(overlay, 'pass');
      if (pass) delete pass.dataset.dragged;
      start = { y: e.clientY, x: e.clientX, t: Date.now(), dy: 0 };
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start || !e.isPrimary) return;
      const dy = e.clientY - start.y;
      if (Math.abs(dy) > 8 || Math.abs(e.clientX - start.x) > 8) { const pass = skEl(overlay, 'pass'); if (pass) pass.dataset.dragged = '1'; }
      start.dy = Math.max(0, dy);
      drag.style.transition = 'none';
      drag.style.transform = `translateY(${start.dy}px)`;
      drag.style.opacity = String(Math.max(.3, 1 - start.dy / 500));
    });
    const end = (e) => {
      if (!start) return;
      const { dy, t } = start;
      start = null;
      drag.style.transition = '';
      if (dy > 120 || (dy > 50 && dy / (Date.now() - t) > .5)) { haptic('impact'); closeStudak(); return; }
      drag.style.transform = drag.style.opacity = '';
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && studakState) closeStudak(); });
  })();

  // Сканер QR в Telegram (Bot API 6.4+): открывает pass.html прямо в мини-приложении.
  // Принимаем только ссылку на pass.html этого же сайта — чужие ссылки из QR не открываем.
  function studakScanTarget(text) {
    try {
      const u = new URL(String(text || '').trim());
      const t = u.searchParams.get('t') || '';
      if (u.origin !== location.origin || !/\/pass\.html$/.test(u.pathname) || !/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
      return `pass.html?t=${encodeURIComponent(t)}`;
    } catch (e) { return null; }
  }
  function scanStudak() {
    if (!tgSupports('6.4') || !TG.showScanQrPopup) return;
    haptic('impact');
    TG.showScanQrPopup({ text: 'Наведите камеру на QR-код Studak' }, (text) => {
      const target = studakScanTarget(text);
      setTimeout(() => {
        if (target) location.href = target;
        else { haptic('error'); showAlert('Это не QR-код Studak. Попросите показать оборот пропуска.'); }
      }, 0);
      return true;
    });
  }
  if (tgSupports('6.4') && TG.showScanQrPopup) document.getElementById('studakScanRow').classList.remove('d-none');
