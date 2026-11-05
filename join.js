// «Журнал 2.0»: вход студента в группу по коду (join.html).
// Поток: код → выбор себя → согласие → логин и пароль → ожидание старосты.
// Права проверяет сервер (Edge Function join-group, RLS). Здесь только экраны и вызовы.
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const SECS = ['code', 'login', 'pick', 'confirm', 'consent', 'account', 'wait'];
  const POLL_MS = 15000;
  let cur = 'code';
  let S = { code: '', group: null, students: [], student: null };
  let pollTimer = null, polling = false, redirecting = false;

  function setMsg(sec, text, kind) {
    const el = $('msg-' + sec);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'j2-msg' + (kind ? ' ' + kind : '');
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function show(name, focus) {
    stopPoll();
    cur = name;
    SECS.forEach((n) => $('sec-' + n).classList.toggle('j2-hidden', n !== name));
    if (focus !== false) {
      const h = $('sec-' + name).querySelector('h1');
      if (h) h.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }

  if (!window.J2 || !J2.sb) {
    show('code', false);
    setMsg('code', 'Не удалось загрузить страницу. Обновите её или проверьте интернет.', 'err');
    document.querySelectorAll('#sec-code button, #sec-code input').forEach((e) => { e.disabled = true; });
    return;
  }

  // Код ошибки из ответа сервера
  function errCode(r) {
    if (r.data && r.data.error) return r.data.error;
    if (r.status === 0) return 'network';
    if (r.status === 503) return 'maintenance';
    if (r.status === 429) return 'too_many_attempts';
    return 'server_error';
  }
  const normCode = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const fmtCode = (r) => (r.length > 4 ? r.slice(0, 4) + ' ' + r.slice(4) : r);
  const fullName = (s) => [s.last_name, s.first_name].filter(Boolean).join(' ');

  // Кнопка на время запроса + защита от неожиданных исключений
  function onClick(id, sec, fn) {
    const b = $(id);
    b.addEventListener('click', async () => {
      try { await J2.busy(b, fn); } catch (e) { setMsg(sec, J2.errText('x'), 'err'); }
    });
  }
  function onSubmit(id, sec, fn) {
    const f = $(id);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = f.querySelector('button[type=submit]');
      try { await J2.busy(b, fn); } catch (err) { setMsg(sec, J2.errText('x'), 'err'); }
    });
  }
  window.addEventListener('unhandledrejection', () => setMsg(cur, J2.errText('x'), 'err'));

  function invalid(fieldId, inputId) {
    $(fieldId).classList.add('invalid');
    $(inputId).setAttribute('aria-invalid', 'true');
    $(inputId).focus();
  }
  function clearInvalid(sec) {
    $('sec-' + sec).querySelectorAll('.j2-field.invalid').forEach((f) => f.classList.remove('invalid'));
    $('sec-' + sec).querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  }
  ['login', 'pw', 'pw2'].forEach((id) => $(id).addEventListener('input', () => clearInvalid('account')));
  ['lg-login', 'lg-pw'].forEach((id) => $(id).addEventListener('input', () => clearInvalid('login')));
  $('code').addEventListener('input', () => {
    clearInvalid('code');
    const f = fmtCode(normCode($('code').value));
    if ($('code').value !== f) $('code').value = f;
  });

  // Показать/скрыть пароль
  document.querySelectorAll('[data-for]').forEach((b) => b.addEventListener('click', () => {
    const ids = b.dataset.for.split(',');
    const showIt = $(ids[0]).type === 'password';
    ids.forEach((id) => { $(id).type = showIt ? 'text' : 'password'; });
    b.textContent = showIt ? 'Скрыть пароль' : 'Показать пароль';
  }));

  function resetAll() {
    S = { code: '', group: null, students: [], student: null };
    ['code', 'search', 'login', 'pw', 'pw2', 'lg-login', 'lg-pw'].forEach((id) => { $(id).value = ''; });
    $('agree').checked = false;
    $('consent-ok').disabled = true;
    SECS.forEach((n) => { setMsg(n, ''); clearInvalid(n); });
    redirecting = false;
  }

  // ---------- 1. Код ----------
  async function lookup(code) {
    const r = await J2.fn('join-group', { action: 'lookup', code }, { anon: true });
    if (!r.ok || !r.data || r.data.error || !r.data.group) return { err: errCode(r) };
    return { group: r.data.group, students: Array.isArray(r.data.students) ? r.data.students : [] };
  }
  onSubmit('f-code', 'code', async () => {
    const code = normCode($('code').value);
    setMsg('code', '');
    clearInvalid('code');
    if (code.length !== 8) {
      setMsg('code', 'Введите 8 символов кода.', 'err');
      invalid('field-code', 'code');
      return;
    }
    const r = await lookup(code);
    if (r.err) {
      setMsg('code', J2.errText(r.err), 'err');
      if (r.err === 'invalid_code') invalid('field-code', 'code');
      return;
    }
    S.code = code; S.group = r.group; S.students = r.students;
    showPick();
  });
  $('to-login').addEventListener('click', () => { setMsg('login', ''); show('login'); });
  $('login-back').addEventListener('click', () => show('code'));

  // ---------- Вход в существующий аккаунт ----------
  async function signIn(login, password) {
    try {
      const { error } = await J2.sb.auth.signInWithPassword({ email: J2.loginToEmail(login), password });
      return error ? { error } : {};
    } catch (e) { return { error: { status: 0 } }; }
  }
  onSubmit('f-login', 'login', async () => {
    const login = $('lg-login').value.trim().toLowerCase(), pw = $('lg-pw').value;
    setMsg('login', '');
    clearInvalid('login');
    if (!login) { setMsg('login', 'Введите логин.', 'err'); invalid('field-lg-login', 'lg-login'); return; }
    if (!pw) { setMsg('login', 'Введите пароль.', 'err'); invalid('field-lg-pw', 'lg-pw'); return; }
    const r = await signIn(login, pw);
    if (r.error) {
      const net = r.error.status === 0 || r.error.status === undefined || /fetch|network/i.test(r.error.message || '');
      setMsg('login', net ? J2.errText('network') : 'Неверный логин или пароль.', 'err');
      if (!net) invalid('field-lg-pw', 'lg-pw');
      return;
    }
    $('lg-pw').value = '';
    await route(true);
  });

  // ---------- 2. Выбор себя ----------
  function showPick() {
    $('pick-group').textContent = 'Группа ' + (S.group && S.group.name ? S.group.name : '');
    $('search').value = '';
    $('f-search').classList.toggle('j2-hidden', S.students.length === 0);
    renderPick();
    show('pick');
  }
  function renderPick() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('pick-list');
    list.textContent = '';
    const items = S.students
      .filter((s) => String(s.name).toLowerCase().includes(q))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    items.forEach((s) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'j2-btn pick';
      const t = document.createElement('span'); t.textContent = s.name;
      const c = document.createElement('span'); c.className = 'chev'; c.setAttribute('aria-hidden', 'true'); c.textContent = '›';
      b.append(t, c);
      b.addEventListener('click', () => { S.student = s; $('confirm-name').textContent = s.name; setMsg('confirm', ''); show('confirm'); });
      li.appendChild(b);
      list.appendChild(li);
    });
    const empty = items.length === 0;
    $('pick-empty').classList.toggle('j2-hidden', !empty);
    if (empty) $('pick-empty-t').textContent = S.students.length ? 'Никого не нашли. Проверьте написание фамилии.' : 'Свободных записей нет. Обратитесь к старосте.';
  }
  $('search').addEventListener('input', renderPick);
  $('f-search').addEventListener('submit', (e) => e.preventDefault());
  $('pick-back').addEventListener('click', () => show('code'));
  $('confirm-no').addEventListener('click', () => show('pick'));
  onClick('confirm-yes', 'confirm', async () => {
    $('agree').checked = false; $('consent-ok').disabled = true; setMsg('consent', '');
    show('consent');
  });

  // ---------- 3. Согласие ----------
  (function buildConsent() {
    const box = $('consent-cards');
    J2.CONSENT_TEXT.forEach(([title, text]) => {
      const d = document.createElement('div'); d.className = 'j2-card';
      const h = document.createElement('h2'); h.textContent = title;
      const p = document.createElement('p'); p.textContent = text;
      d.append(h, p); box.appendChild(d);
    });
  })();
  $('agree').addEventListener('change', () => { $('consent-ok').disabled = !$('agree').checked; });
  $('consent-ok').addEventListener('click', () => {
    if (!$('agree').checked) return;
    setMsg('account', ''); clearInvalid('account');
    show('account');
  });
  $('consent-no').addEventListener('click', () => { resetAll(); show('code'); });
  $('account-back').addEventListener('click', () => show('consent'));

  // ---------- 4. Логин и пароль ----------
  onSubmit('f-account', 'account', async () => {
    const login = $('login').value.trim().toLowerCase(), pw = $('pw').value, pw2 = $('pw2').value;
    $('login').value = login;
    setMsg('account', '');
    clearInvalid('account');
    if (!J2.LOGIN_RE.test(login)) { setMsg('account', J2.errText('bad_login'), 'err'); invalid('field-login', 'login'); return; }
    if (pw.length < J2.PASSWORD_MIN || pw.length > J2.PASSWORD_MAX) { setMsg('account', J2.errText('bad_password'), 'err'); invalid('field-pw', 'pw'); return; }
    if (pw !== pw2) { setMsg('account', 'Пароли не совпадают.', 'err'); invalid('field-pw2', 'pw2'); return; }
    const hash = await J2.consentHash();
    const r = await J2.fn('join-group', {
      action: 'claim', code: S.code, student_id: S.student.id, login, password: pw,
      consent: { accepted: true, version: J2.CONSENT_VERSION, text_hash: hash },
    }, { anon: true });
    if (r.ok && r.data && r.data.ok && !r.data.error) {
      const si = await signIn(r.data.login || login, pw);
      $('pw').value = ''; $('pw2').value = '';
      if (si.error) {
        $('lg-login').value = r.data.login || login; $('lg-pw').value = '';
        show('login');
        setMsg('login', 'Аккаунт создан, но войти автоматически не удалось. Войдите вручную.', 'err');
        return;
      }
      await showWait(null);
      return;
    }
    const code = errCode(r);
    if (code === 'login_taken' || code === 'bad_login') { setMsg('account', J2.errText(code), 'err'); invalid('field-login', 'login'); }
    else if (code === 'bad_password') { setMsg('account', J2.errText(code), 'err'); invalid('field-pw', 'pw'); }
    else if (code === 'consent_required') { show('consent'); setMsg('consent', J2.errText(code), 'err'); }
    else if (code === 'student_taken' || code === 'no_student') {
      const l = await lookup(S.code);
      if (l.err) { setMsg('account', J2.errText(l.err), 'err'); return; }
      S.group = l.group; S.students = l.students; S.student = null;
      showPick();
      setMsg('pick', J2.errText(code), 'err');
    } else setMsg('account', J2.errText(code), 'err');
  });

  // ---------- Состояние из базы ----------
  async function loadState() {
    try {
      const { data } = await J2.sb.auth.getSession();
      const session = data && data.session;
      if (!session) return { session: null };
      const m = await J2.sb.from('memberships').select('group_id,student_id,status,created_at').limit(1);
      if (m.error) return { error: true };
      const membership = (m.data || [])[0] || null;
      if (!membership) return { session, membership: null };
      const st = await J2.sb.from('students').select('id,last_name,first_name,group_id').eq('claimed_by', session.user.id);
      const rows = (st && st.data) || [];
      const stu = rows.find((x) => x.id === membership.student_id) || rows[0] || null;
      let groupName = '';
      if (membership.group_id) {
        const g = await J2.sb.from('groups').select('name').eq('id', membership.group_id);
        groupName = (g && g.data && g.data[0] && g.data[0].name) || '';
      }
      return { session, membership, studentName: stu ? fullName(stu) : '', groupName };
    } catch (e) { return { error: true }; }
  }
  async function route(fromLogin) {
    const st = await loadState();
    if (st.error) { show('code'); setMsg('code', J2.errText('network'), 'err'); return; }
    if (!st.session) { show('code'); return; }
    if (!st.membership) {
      show('code');
      setMsg('code', 'Вы вошли, но не состоите в группе. Введите код группы.', 'err');
      return;
    }
    if (st.membership.status === 'active') { redirecting = true; location.replace('index.html'); return; }
    await showWait(st);
  }

  // ---------- 5. Ожидание ----------
  function renderTimeline(status) {
    const ol = $('tl');
    ol.textContent = '';
    const done = status === 'active';
    const items = [
      ['Вы вошли по коду группы', 'Согласие на данные принято', 'done'],
      ['Староста подтверждает', 'Пока данные группы закрыты. Сообщим в Telegram и в колокольчике', done ? 'done' : 'now'],
      ['Журнал открыт', 'Расписание, пропуски и оценки появятся сразу', done ? 'done' : 'todo'],
    ];
    const label = { done: 'Готово: ', now: 'Сейчас: ', todo: 'Дальше: ' };
    items.forEach(([title, desc, state]) => {
      const li = document.createElement('li');
      if (state === 'todo') li.className = 'todo';
      const dot = document.createElement('span');
      dot.className = 'j2-dot' + (state === 'todo' ? '' : ' ' + state);
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = state === 'done' ? '✓' : '';
      const body = document.createElement('div');
      const sr = document.createElement('span'); sr.className = 'sr'; sr.textContent = label[state];
      const b = document.createElement('b'); b.textContent = title;
      const sp = document.createElement('span'); sp.textContent = desc;
      body.append(sr, b, sp);
      li.append(dot, body);
      ol.appendChild(li);
    });
  }
  function applyStatus(status) {
    const rejected = status === 'rejected', active = status === 'active';
    $('wait-bad').classList.toggle('j2-hidden', !rejected);
    $('wait-tl').classList.toggle('j2-hidden', rejected);
    $('wait-actions').classList.toggle('j2-hidden', rejected || active);
    $('wait-rej-actions').classList.toggle('j2-hidden', !rejected);
    $('h-wait').textContent = active ? 'Журнал открыт' : rejected ? 'Запись не подтверждена' : 'Ждём подтверждения';
    if (!rejected) renderTimeline(status);
    if (active && !redirecting) {
      redirecting = true;
      stopPoll();
      setMsg('wait', 'Открываем журнал…', 'ok');
      setTimeout(() => location.replace('index.html'), 1500);
    }
  }
  function hideRelease() {
    $('rel-confirm').classList.add('j2-hidden');
    $('rel-actions').classList.add('j2-hidden');
  }
  async function showWait(st) {
    if (!st) st = await loadState();
    if (st && st.error) { st = { membership: { status: 'pending' } }; }
    const name = (st && st.studentName) || (S.student && S.student.name) || '';
    const group = (st && st.groupName) || (S.group && S.group.name) || '';
    $('wait-group').textContent = group ? 'Группа ' + group : '';
    $('wait-group').classList.toggle('j2-hidden', !group);
    $('wait-name').textContent = name;
    $('wait-who').classList.toggle('j2-hidden', !name);
    setMsg('wait', '');
    hideRelease();
    show('wait');
    applyStatus((st && st.membership && st.membership.status) || 'pending');
    if (!redirecting) pollTimer = setInterval(poll, POLL_MS);
  }
  async function poll() {
    if (polling || cur !== 'wait' || redirecting) return;
    polling = true;
    try {
      const st = await loadState();
      if (cur !== 'wait' || st.error) return;
      if (!st.session) { resetAll(); show('code'); setMsg('code', 'Сессия закончилась. Введите код группы или войдите заново.', 'err'); return; }
      if (!st.membership) { resetAll(); show('code'); setMsg('code', 'Запись в группе не найдена. Введите код группы заново.', 'err'); return; }
      applyStatus(st.membership.status);
    } finally { polling = false; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cur === 'wait') poll(); });

  onClick('remind', 'wait', async () => {
    setMsg('wait', '');
    let r;
    try { r = await J2.sb.rpc('remind_headman'); } catch (e) { r = { error: e }; }
    if (r.error) { setMsg('wait', J2.errText('network'), 'err'); return; }
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    if (d && d.ok) setMsg('wait', 'Напоминание отправлено старосте.', 'ok');
    else if (d && d.next_at) setMsg('wait', 'Напоминать можно раз в час, следующее после ' + J2.fmtTime(d.next_at) + '.', 'err');
    else setMsg('wait', J2.errText((d && d.error) || 'x'), 'err');
  });

  $('notme').addEventListener('click', () => {
    setMsg('wait', '');
    $('wait-actions').classList.add('j2-hidden');
    $('rel-confirm').classList.remove('j2-hidden');
    $('rel-actions').classList.remove('j2-hidden');
    $('rel-h').focus();
  });
  $('rel-no').addEventListener('click', () => { hideRelease(); $('wait-actions').classList.remove('j2-hidden'); $('notme').focus(); });

  // Освободить фамилию, выйти и начать с кода
  async function release() {
    const r = await J2.fn('join-group', { action: 'release' });
    if (!r.ok || (r.data && r.data.error)) {
      setMsg('wait', J2.errText(errCode(r)), 'err');
      if (errCode(r) === 'not_pending') poll();
      return;
    }
    try { await J2.sb.auth.signOut({ scope: 'local' }); } catch (e) { /* сессия и так сброшена */ }
    resetAll();
    show('code');
    setMsg('code', 'Фамилия освобождена. Введите код группы заново.', 'ok');
  }
  onClick('rel-yes', 'wait', release);
  onClick('rej-again', 'wait', release);

  // ---------- Старт ----------
  show('code', false);
  route(false).catch(() => { show('code', false); setMsg('code', J2.errText('network'), 'err'); });
})();
