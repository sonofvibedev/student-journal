// «Журнал 2.0»: утилита системного администратора (sysadmin.html).
// Вход по почте и паролю, проверка is_sysadmin(), пять разделов: Состояние, Логи, Роли, Группы, Служебное.
// Права проверяет сервер (RLS, функции sysadmin_*/ops_*, Edge Functions); эта страница только показывает и вызывает.
// Все тексты из базы выводятся через J2.esc. Никаких alert/confirm/prompt: подтверждения встроены в страницу.
// Одноразовые секреты (код группы, временный пароль) живут только в st.secret и в DOM, пока открыт раздел.
'use strict';
(function () {
  const sb = J2.sb, $ = J2.$, esc = J2.esc;
  const st = {
    tab: 'state', nav: 0, roleSub: 'req', reqs: [], open: new Set(), groups: [], roleGroup: '', rc: null,
    logAction: '', logActions: new Set(), logSub: 'audit', logHours: 168, log: null,
    hours: 24, ask: null, secret: null, tf: null, me: null, gl: [], gcount: {}, imp: {}, teachers: [], admins: [], tg: null,
  };

  // ---------- мелочи ----------
  const ERR = {
    forbidden: 'Нет прав на это действие.',
    already_approved: 'Эта заявка уже одобрена. Код группы показывается один раз; староста может нажать «Показать код» в своей заявке.',
    not_submitted: 'Заявка уже обработана. Список обновлён.',
    not_found: 'Запись не найдена. Обновите список.',
    self: 'Себя менять нельзя.',
    no_active_membership: 'У этого человека нет действующего участия в группе.',
    not_student: 'Старостой или заместителем может быть только студент.',
    bad_thresholds: 'Пороги: целые числа от 1, порог деканата не меньше порога предупреждения.',
    bad_role: 'Неизвестная роль.',
    maintenance: 'Ведутся технические работы. Повторите позже.',
    is_student: 'Эта учётная запись принадлежит студенту группы: студент не может быть преподавателем.',
    bad_subjects: 'Предмет не может быть пустым (до 200 знаков).',
    too_many_subjects: 'Предметов не больше 20.',
    user_not_found: 'Учётная запись не найдена.',
    not_teacher: 'Этот человек не преподаватель группы. Список обновлён.',
    last_sysadmin: 'Последнего сисадмина снять нельзя.',
    bad_payload: 'Проверьте название группы и список студентов.',
    no_students: 'Добавьте хотя бы одного студента.',
    too_many_students: 'Студентов не больше 300.',
    bad_student: 'У студента пустая фамилия или имя, слишком длинная запись или неизвестная форма (бюджет или платная).',
    duplicate_student: 'В списке есть повторяющиеся ФИО.',
    duplicate_group: 'Группа с таким названием уже есть.',
    bad_status: 'Неизвестный статус группы.',
    bad_hours: 'Период указан неверно.',
    not_admin: 'Режим технических работ меняет только староста-администратор журнала. У сисадмина этого права пока нет на сервере.',
  };
  const FN_ERR = {
    too_soon: 'Расписание обновляли совсем недавно. Повторите через 10 минут.',
    not_configured: 'Не настроено на сервере (нет секретов бота).',
    telegram_unavailable: 'Telegram сейчас не отвечает. Повторите позже.',
    bad_email: 'Проверьте адрес почты.',
    student_domain: 'Нельзя создавать адреса студенческого домена: это логины студентов, не почта.',
    create_failed: 'Не удалось создать учётную запись. Повторите позже.',
    backup_failed: 'Копию создать не удалось. Подробности в «Логи → Ошибки сервера».',
    not_found: 'Запись не найдена. Обновите список.',
  };
  function errMsg(e) {
    const m = String((e && e.message) || e || '').trim();
    if (ERR[m]) return ERR[m];
    if (e && e.code === '42501') return ERR.forbidden;
    if (/PGRST202|could not find the function|does not exist/i.test(m + ' ' + ((e && e.code) || ''))) return 'На сервере нет этой функции: нужно применить миграцию этапа 5.';
    if (/jwt|expired|PGRST30/i.test(m + ' ' + ((e && e.code) || ''))) return 'Сессия истекла. Войдите снова.';
    if (/fetch|network|load failed/i.test(m)) return J2.errText('network');
    const t = J2.errText(m);
    return t === J2.errText('') && /^[a-z_]{3,40}$/.test(m) ? t.replace(/\.$/, '') + ' (' + m + ').' : t;
  }
  // Ошибка Edge Function по ответу J2.fn: { ok, status, data }
  function fnErr(r) {
    const d = r.data || {}, c = String(d.error || '');
    if (r.status === 0) return J2.errText('network');
    if (r.status === 404 && !c) return 'Функция не развёрнута на сервере.';
    if (r.status === 401) return 'Сессия истекла. Войдите снова.';
    if (r.status === 403) return ERR.forbidden;
    return FN_ERR[c] || ERR[c] || J2.errText(c || 'server_error');
  }
  const say = (t, kind) => { const m = $('msg'); m.textContent = t || ''; m.className = 'j2-msg' + (kind ? ' ' + kind : ''); };
  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };
  const pl = (n, f) => n + ' ' + plural(n, f);
  const pad = (n) => String(n).padStart(2, '0');
  function when(iso) {
    const d = new Date(iso); if (isNaN(d)) return '—';
    const t = pad(d.getHours()) + ':' + pad(d.getMinutes()), now = new Date(), day = 864e5;
    const sod = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((sod(now) - sod(d)) / day);
    return (diff === 0 ? 'сегодня' : diff === 1 ? 'вчера' : J2.fmtDate(d)) + ', ' + t;
  }
  const fmtCode = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
  const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? String(Math.round(v / 100) / 10).replace('.', ',') + ' с' : Math.round(v) + ' мс');
  const fmtPct = (v) => (v == null ? '—' : String(Math.round(Number(v) * 10) / 10).replace('.', ',') + '%');
  const fmtBytes = (b) => (b == null ? '—' : b < 1024 ? b + ' Б' : b < 1048576 ? Math.round(b / 1024) + ' КБ' : String(Math.round(b / 104857.6) / 10).replace('.', ',') + ' МБ');
  const personName = (s) => s ? [s.last_name || s.lastName, s.first_name || s.firstName].filter(Boolean).join(' ') : '';
  const view = () => $('view');
  async function act(btn, scope, fn) {          // блокирует все кнопки карточки на время запроса
    const all = [...(scope || btn.parentNode).querySelectorAll('button')].filter((b) => !b.disabled);
    return J2.busy(btn, async () => { all.forEach((b) => { b.disabled = true; }); try { return await fn(); } finally { all.forEach((b) => { b.disabled = false; }); } });
  }
  const stale = (n) => n !== st.nav;
  const paint = (n, html, target) => { if (stale(n)) return false; (target || view()).innerHTML = html; return true; };
  const loading = '<p class="sa-note">Загрузка…</p>';
  const failBox = (e, retry, title) => '<div class="j2-card bad"><h2>' + esc(title || 'Не удалось загрузить') + '</h2><p>' + esc(typeof e === 'string' ? e : errMsg(e)) + '</p>' +
    '<div class="sa-actions"><button type="button" class="j2-btn small" data-act="' + (retry || 'retry') + '">Повторить</button></div></div>';
  const pill = (cls, t) => '<span class="sa-pill ' + cls + '">' + esc(t) + '</span>';
  const clearSecrets = () => { st.secret = null; st.ask = null; };

  // ---------- подтверждение действия и одноразовый секрет ----------
  // st.ask = { text, yes, danger, run }: карточка «Подтвердите действие» в #askBox текущего раздела
  function paintAsk() {
    const box = $('askBox'); if (!box) return;
    const a = st.ask;
    box.innerHTML = a ? '<section class="j2-card warn" id="askCard" tabindex="-1" aria-labelledby="askT"><h2 id="askT">Подтвердите действие</h2><p style="color:var(--j-text)">' + esc(a.text) + '</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn ' + (a.danger === false ? 'primary' : 'danger') + '" data-act="ask-yes">' + esc(a.yes) + '</button><button type="button" class="j2-btn" data-act="ask-no">Отмена</button></div></section>' : '';
    if (a && $('askCard')) $('askCard').focus();
  }
  function ask(a) { st.ask = a; say(''); paintAsk(); }
  // st.secret = { title, label, raw, shown, warn, reqId? }: показывается один раз, лайм-блок с «Скопировать»
  function paintSecret() {
    const box = $('secBox'); if (!box) return;
    const c = st.secret;
    box.innerHTML = c ? '<section class="j2-card sa-secret" id="secCard" tabindex="-1" aria-labelledby="secT"><h2 id="secT">' + esc(c.title) + '</h2>' +
      '<p>' + esc(c.label) + '</p><span class="j2-code" id="secVal">' + esc(c.shown) + '</span>' +
      '<p class="sa-warn"><b>' + esc(c.warn) + '</b></p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn" data-act="sec-copy">Скопировать</button><button type="button" class="j2-btn primary" data-act="sec-done">Готово</button></div></section>' : '';
    if (c && $('secCard')) $('secCard').focus();
  }
  async function copySecret() {
    const raw = st.secret && st.secret.raw; if (!raw) return;
    try { await navigator.clipboard.writeText(raw); say('Скопировано.', 'ok'); }
    catch (e) {
      const r = document.createRange(); r.selectNodeContents($('secVal')); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      say('Текст выделен. Скопируйте его вручную.');
    }
  }
  const BOXES = '<div id="askBox"></div><div id="secBox"></div>';

  // ---------- вход ----------
  function tickClock() { const d = new Date(); $('clock').textContent = d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }) + ', ' + J2.fmtTime(d); }
  function showLogin() {
    $('login').classList.remove('j2-hidden'); $('main').classList.add('j2-hidden'); $('nav').classList.add('j2-hidden'); $('logout').classList.add('j2-hidden');
    $('who').textContent = 'Системный администратор';
  }
  function showMain() {
    $('login').classList.add('j2-hidden'); $('main').classList.remove('j2-hidden'); $('nav').classList.remove('j2-hidden'); $('logout').classList.remove('j2-hidden');
    go(st.tab);
  }
  async function checkAccess() {
    const { data, error } = await sb.rpc('is_sysadmin');
    if (error || data !== true) {
      await sb.auth.signOut().catch(() => {});
      showLogin();
      say(error ? 'Нет доступа. ' + errMsg(error) : 'Нет доступа: эта учётная запись не системный администратор.', 'err');
      return false;
    }
    const { data: s } = await sb.auth.getSession();
    st.me = (s && s.session && s.session.user && s.session.user.id) || null;
    return true;
  }
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = $('loginBtn'), email = $('email').value.trim(), password = $('pass').value;
    if (!email || !password) { say('Введите почту и пароль.', 'err'); return; }
    J2.busy(btn, async () => {
      say('Входим…');
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { say(/invalid|credentials/i.test(error.message) ? 'Неверная почта или пароль.' : errMsg(error), 'err'); return; }
      $('pass').value = '';
      if (await checkAccess()) { say(''); showMain(); }
    });
  });
  $('logout').addEventListener('click', async () => { await sb.auth.signOut().catch(() => {}); clearSecrets(); st.tg = null; st.me = null; view().innerHTML = ''; say('Вы вышли.', 'ok'); showLogin(); });

  // ---------- навигация ----------
  const TABS = {
    state: { title: 'Состояние', sub: 'Как работает журнал и что ждёт решения', run: renderState },
    logs: { title: 'Логи', sub: 'Действия, ошибки и замеры', run: renderLogs },
    roles: { title: 'Роли', sub: '', run: renderRoles },
    groups: { title: 'Группы', sub: '', run: renderGroups },
    service: { title: 'Служебное', sub: 'Операции сразу для всех пользователей', run: renderService },
  };
  function go(tab) {
    clearSecrets();                              // секреты и подтверждения живут, пока открыт раздел
    st.tab = tab; const n = ++st.nav, t = TABS[tab];
    document.querySelectorAll('#nav button').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('title').textContent = t.title; $('sub').textContent = t.sub; say('');
    view().innerHTML = loading;
    t.run(n).catch((e) => paint(n, failBox(e)));
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
  function rerun() {
    if (st.tab === 'roles') { const n = ++st.nav; renderRoles(n).catch((x) => paint(n, failBox(x))); } else go(st.tab);
  }

  // ---------- Состояние ----------
  const card = (label, val, sub, amber) => '<div class="j2-card"><p>' + label + '</p><span class="big' + (amber ? ' amber' : '') + '">' + esc(val) + '</span>' + (sub ? '<p class="sa-sub">' + esc(sub) + '</p>' : '') + '</div>';
  const IMP_OK = /^(ok|success)$/i;
  function importLine(m) {
    if (!m || !m.last_import_at) return pill('off', 'не запускался');
    return IMP_OK.test(m.last_status || '') ? pill('ok', 'успешно') : pill('bad', 'сбой');
  }
  function importsHtml(list) {
    if (!list.length) return '<p>Групп с расписанием пока нет.</p>';
    return '<ul class="j2-list">' + list.map((m) => '<li class="sa-log"><div class="sa-head"><b>' + esc(m.name) + '</b>' + importLine(m) + '</div>' +
      '<div class="sa-mono">' + (m.last_import_at ? 'обновлено ' + esc(when(m.last_import_at)) + (m.lessons_count != null ? ', занятий ' + esc(m.lessons_count) : '') : 'расписание ещё не загружалось') +
      (m.last_error && !IMP_OK.test(m.last_status || '') ? '<br>' + esc(String(m.last_error).slice(0, 200)) : '') + '</div></li>').join('') + '</ul>';
  }
  async function renderState(n) {
    const [g, s, sum] = await Promise.all([
      sb.from('groups').select('id', { count: 'exact', head: true }),
      sb.from('students').select('id', { count: 'exact', head: true }),
      sb.rpc('ops_summary', { p_hours: st.hours }),
    ]);
    if (stale(n)) return;
    const o = sum.error ? null : (sum.data || {});
    const v = (x) => (x.error || x.count == null ? '—' : x.count);
    const seg = '<div class="j2-tabs sa-seg" role="tablist" aria-label="Период">' + [[24, '24 часа'], [168, '7 дней']].map(([h, t]) =>
      '<button type="button" role="tab" data-hours="' + h + '" aria-selected="' + (st.hours === h) + '">' + t + '</button>').join('') + '</div>';
    if (!o) return paint(n, seg + failBox(sum.error, 'retry', 'Показатели не загрузились') +
      '<div class="sa-state-grid">' + card('Группы', v(g)) + card('Студенты', v(s)) + '</div>');
    const top = (o.top_errors || []).map((t) => '<li class="sa-log"><div class="sa-head"><b>' + esc(t.name) + '</b><span class="sa-pill off">' + esc(t.count) + '×</span></div>' +
      (t.message ? '<div class="sa-mono">' + esc(t.message) + '</div>' : '') + '</li>').join('');
    const bk = o.backup_last;
    const rep = '<section class="j2-card" id="repCard" aria-labelledby="repT"><h2 id="repT">Отчёты о сбоях</h2>' +
      '<p class="sa-card-p">Сообщение в Telegram и на почту приходит, если за 10 минут накопилось 20 ошибок браузера или доступность за 30 минут упала ниже 80%. Не чаще раза в час.</p>' +
      '<p class="sa-card-p">Последний алерт: ' + esc(o.last_alert_at ? when(o.last_alert_at) : 'не было') + '. Последняя сводка: ' + esc(o.last_digest_at ? when(o.last_digest_at) : 'не отправлялась') + '.</p>' +
      '<p class="sa-res" id="repRes" role="status"></p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn" data-act="digest">Отправить сводку сейчас</button></div></section>';
    paint(n, seg + (o.maintenance ? '<div class="j2-card warn"><h2>Включён режим технических работ</h2><p>Пользователи, кроме старосты, видят экран техработ. Выключить можно в разделе «Служебное».</p></div>' : '') +
      '<div class="sa-state-grid">' +
      card('Доступность', fmtPct(o.availability_pct), o.pings ? pl(o.pings, ['проверка', 'проверки', 'проверок']) : 'проверок ещё нет', o.availability_pct != null && o.availability_pct < 95) +
      card('Ответ базы', fmtMs(o.resp_p95_ms), 'p95; p50 ' + fmtMs(o.resp_p50_ms)) +
      card('Ошибки браузера', String(o.client_errors || 0), null, o.client_errors > 0) +
      card('Ошибки сервера', String(o.server_errors || 0), null, o.server_errors > 0) +
      card('Загрузка страниц', fmtMs(o.page_p95_ms), 'p95; p50 ' + fmtMs(o.page_p50_ms)) +
      card('Заявки ждут решения', String(o.pending_requests || 0), null, o.pending_requests > 0) +
      card('Студенты ждут подтверждения', String(o.pending_students || 0), null, o.pending_students > 0) +
      card('Группы и студенты', v(g) + ' и ' + v(s)) + '</div>' +
      '<section class="j2-card" aria-labelledby="topT"><h2 id="topT">Частые ошибки</h2>' + (top ? '<ul class="j2-list">' + top + '</ul>' : '<p>За этот период ошибок нет.</p>') + '</section>' +
      '<section class="j2-card" aria-labelledby="impT"><h2 id="impT">Импорт расписания</h2>' + importsHtml(o.imports || []) + '</section>' +
      '<section class="j2-card" aria-labelledby="bkT"><h2 id="bkT">Резервная копия</h2>' +
      (bk ? '<p class="sa-card-p">Последняя: ' + esc(when(bk.at)) + ', ' + esc(fmtBytes(bk.size_bytes)) + ' ' + (bk.status === 'ok' ? pill('ok', 'успешно') : pill('bad', 'сбой')) + '</p>' : '<p>Копий ещё не было. Создать можно в разделе «Служебное».</p>') + '</section>' + rep);
  }
  function digest(btn, scope) {
    return act(btn, scope, async () => {
      say('Отправляем сводку…');
      const r = await J2.fn('ops-report', {});
      const box = $('repRes');
      if (!r.ok) { say(''); if (box) { box.className = 'sa-res err'; box.textContent = 'Не отправлено. ' + fnErr(r); } return; }
      say('');
      if (box) { const sent = r.data && r.data.sent !== false; box.className = 'sa-res ' + (sent ? 'ok' : 'warn'); box.textContent = sent ? 'Сводка отправлена в Telegram и на почту.' : 'Сводка собрана, но каналов доставки нет: в настройках сервера не заданы бот Telegram и почта.'; }
    });
  }

  // ---------- Логи ----------
  const ACTION = {
    registration_approve: 'Заявка одобрена', registration_reject: 'Заявка отклонена', membership_approve: 'Студент подтверждён', membership_reject: 'Студент отклонён',
    student_reset_binding: 'Сброс привязки', remind_headman: 'Напоминание старосте', consent_accept: 'Согласие принято', group_code_rotate: 'Новый код группы',
    set_group_role: 'Роль в группе', set_thresholds: 'Пороги пропусков', sysadmin_bootstrap: 'Сисадмин назначен',
    teacher_assign: 'Преподаватель назначен', teacher_remove: 'Преподаватель снят', sysadmin_add: 'Сисадмин добавлен', sysadmin_remove: 'Сисадмин снят',
    group_create: 'Группа создана', group_status: 'Статус группы изменён', sysadmin_user_create: 'Учётная запись создана', backup_manual: 'Копия создана вручную',
    backup_download: 'Копия скачана', ops_report_sent: 'Сводка отправлена', tg_webhook_reinstall: 'Вебхук бота переустановлен',
  };
  const actionLabel = (a) => ACTION[a] || a;
  const LOGSEG = {
    audit: { label: 'Действия' },
    client: { label: 'Ошибки браузера', s: 'client', k: 'error' },
    server: { label: 'Ошибки сервера', s: 'server', k: 'error' },
    perf: { label: 'Замеры', s: 'client', k: 'perf' },
  };
  const PAGE = 50;
  async function renderLogs(n) {
    const seg = '<div class="j2-tabs sa-seg" role="tablist" aria-label="Тип записей">' + Object.keys(LOGSEG).map((k) =>
      '<button type="button" role="tab" data-log="' + k + '" aria-selected="' + (st.logSub === k) + '">' + LOGSEG[k].label + '</button>').join('') + '</div>';
    paint(n, seg + '<div id="logFilters"></div><div id="logBody">' + loading + '</div>');
    st.log = { key: n, rows: [], more: false, err: null };
    await loadLog(n, false);
  }
  async function loadLog(n, more) {
    const L = st.log, sub = st.logSub, spec = LOGSEG[sub], last = L.rows[L.rows.length - 1];
    let data, error;
    if (sub === 'audit') {
      let q = sb.from('audit_log').select('*').order('at', { ascending: false }).limit(PAGE);   // ponytail: курсор по at; записи с одним временем на границе страниц могут пропасть
      if (st.logAction) q = q.eq('action', st.logAction);
      if (more && last) q = q.lt('at', last.at);
      ({ data, error } = await q);
    } else {
      ({ data, error } = await sb.rpc('ops_events', { p_source: spec.s, p_kind: spec.k, p_hours: st.logHours, p_limit: PAGE, p_before: more && last ? last.id : null }));
    }
    if (stale(n) || st.log !== L) return;
    if (error) { L.err = error; if (!more) { paintLogFilters(n); paint(n, failBox(error, 'retry-log'), $('logBody')); return; } say(errMsg(error), 'err'); return; }
    (data || []).forEach((r) => { if (sub === 'audit') st.logActions.add(r.action); });
    L.rows = L.rows.concat(data || []); L.more = (data || []).length === PAGE; L.err = null;
    paintLogFilters(n); paintLog(n);
  }
  function paintLogFilters(n) {
    const box = $('logFilters'); if (!box || stale(n)) return;
    if (st.logSub === 'audit') {
      const opts = [...new Set([...Object.keys(ACTION), ...st.logActions])];
      box.innerHTML = '<label class="j2-field sa-field-sel"><span>Действие</span><select id="logFilter"><option value="">Все действия</option>' +
        opts.map((a) => '<option value="' + esc(a) + '"' + (a === st.logAction ? ' selected' : '') + '>' + esc(actionLabel(a)) + '</option>').join('') + '</select></label>';
    } else {
      box.innerHTML = '<label class="j2-field sa-field-sel"><span>Период</span><select id="logHours">' + [[24, 'Последние 24 часа'], [168, 'Последние 7 дней'], [720, 'Последние 30 дней']].map(([h, t]) =>
        '<option value="' + h + '"' + (st.logHours === h ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>';
    }
  }
  const PERF_LBL = { page: 'Загрузка страницы', api: 'Ответ сервера (медиана)' };
  function logRow(r) {
    if (st.logSub === 'audit') {
      const d = r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : '';
      return '<li class="sa-log"><div class="sa-head"><b>' + esc(actionLabel(r.action)) + '</b><span class="sub">' + esc(when(r.at)) + '</span></div>' +
        '<div class="sa-mono">кто: ' + esc(r.actor ? String(r.actor).slice(0, 8) : 'система') + (d ? ' · ' + esc(d.length > 160 ? d.slice(0, 160) + '…' : d) : '') + '</div></li>';
    }
    const perf = r.kind === 'perf';
    const title = perf ? (PERF_LBL[r.name] || r.name || 'Замер') + ': ' + fmtMs(r.ms) : (r.name || 'Ошибка');
    const more = [r.detail, r.ua ? 'браузер: ' + r.ua : ''].filter(Boolean).join('\n');
    return '<li class="sa-log"><div class="sa-head"><b>' + esc(title) + '</b><span class="sub">' + esc(when(r.at)) + '</span></div>' +
      (r.message ? '<div class="sa-card-p">' + esc(r.message) + '</div>' : '') +
      (more ? '<details><summary>Подробности</summary><div class="sa-mono sa-pre">' + esc(more) + '</div></details>' : '') + '</li>';
  }
  function paintLog(n) {
    const L = st.log, box = $('logBody'); if (!box || stale(n)) return;
    box.innerHTML = '<div class="j2-card">' + (L.rows.length ? '<ul class="j2-list">' + L.rows.map(logRow).join('') + '</ul>' : '<p>Записей нет.</p>') + '</div>' +
      (L.more ? '<button type="button" class="j2-btn" data-act="log-more">Показать ещё</button>' : '') +
      '<p class="sa-note">Показано записей: ' + L.rows.length + (st.logSub === 'audit' ? '. «Кто»: первые символы идентификатора пользователя.' : '. События хранятся 30 дней.') + '</p>';
  }

  // ---------- Роли ----------
  async function renderRoles(n) {
    clearSecrets(); st.rc = null;
    const sub = (id, label) => '<button type="button" role="tab" id="rs-' + id + '" data-sub="' + id + '" aria-selected="' + (st.roleSub === id) + '">' + label + '</button>';
    paint(n, '<div class="j2-tabs sa-seg" role="tablist" aria-label="Раздел ролей">' + sub('req', 'Заявки') + sub('grp', 'Роли групп') + sub('tch', 'Преподаватели') + sub('adm', 'Сисадмины') + '</div><div id="rolesBody" role="tabpanel">' + loading + '</div>');
    const SUBT = { req: 'Заявки новых старост', grp: 'Старосты и заместители в группах', tch: 'Преподаватели групп', adm: 'Кто может открывать эту утилиту' };
    $('sub').textContent = SUBT[st.roleSub];
    await ({ req: loadReqs, grp: loadMembers, tch: loadTeachers, adm: loadAdmins }[st.roleSub])(n);
  }
  async function loadGroups(n) {                                       // список групп и выбранная группа; null, если показывать нечего
    const g = await sb.from('groups').select('*').order('created_at');
    if (stale(n)) return null;
    if (g.error) { paint(n, failBox(g.error), $('rolesBody')); return null; }
    st.groups = g.data || [];
    if (!st.groups.length) { paint(n, '<div class="j2-card"><p>Групп пока нет.</p></div>', $('rolesBody')); return null; }
    if (!st.groups.some((x) => x.id === st.roleGroup)) st.roleGroup = st.groups[0].id;
    return st.groups;
  }
  const groupSelect = () => '<label class="j2-field sa-field-sel"><span>Группа</span><select id="roleGroup">' +
    st.groups.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === st.roleGroup ? ' selected' : '') + '>' + esc(x.name) + (x.status === 'closed' ? ' (отключена)' : '') + '</option>').join('') + '</select></label>';

  async function loadReqs(n) {
    const { data, error } = await sb.from('registration_requests').select('*').eq('status', 'submitted').order('submitted_at');
    if (stale(n)) return;
    if (error) return paint(n, failBox(error), $('rolesBody'));
    st.reqs = data || []; paintReqs(n);
  }
  function reqCard(r) {
    const p = r.payload || {}, g = p.group || {}, o = p.owner || {}, ss = Array.isArray(p.students) ? p.students : [];
    const form = (s) => s.study_form || s.studyForm;
    const bud = ss.filter((s) => form(s) === 'budget').length, paid = ss.filter((s) => form(s) === 'paid').length, other = ss.length - bud - paid;
    const name = g.group_name || g.name || g.group_no || 'Без названия';
    const place = [g.course ? g.course + ' курс' : '', g.faculty, g.study_form].filter(Boolean).join(', ');
    const sch = r.schedule_status === 'found' && p.schedule
      ? 'Расписание найдено: ' + pl((p.schedule.subjects || []).length, ['предмет', 'предмета', 'предметов']) + ', ' + pl((p.schedule.teachers || []).length, ['преподаватель', 'преподавателя', 'преподавателей'])
      : 'Расписание не найдено';
    const open = st.open.has(r.id);
    return '<article class="j2-card warn" data-id="' + esc(r.id) + '" aria-label="Заявка группы ' + esc(name) + '">' +
      '<div class="sa-head"><h2>' + esc(name) + '</h2><span class="sa-pill wait">ждёт решения</span></div>' +
      '<p class="sa-card-p">' + esc(place || 'Данные группы не указаны') + '</p>' +
      '<p class="sa-card-p">Староста: <b style="color:var(--j-text)">' + esc(o.name || 'не указан') + '</b>' + (o.email ? ', ' + esc(o.email) : '') + '</p>' +
      '<p class="sa-card-p">Студентов: ' + ss.length + ' (бюджет ' + bud + ', платная ' + paid + (other ? ', форма не указана ' + other : '') + ')</p>' +
      '<p class="sa-card-p">' + esc(sch) + '</p>' +
      '<details data-id="' + esc(r.id) + '"' + (open ? ' open' : '') + '><summary>Список студентов (' + ss.length + ')</summary><ol class="sa-people">' +
      ss.map((s) => '<li>' + esc(personName(s) || 'без имени') + ' <span class="sub">' + esc(form(s) === 'budget' ? 'бюджет' : form(s) === 'paid' ? 'платная' : '') + '</span></li>').join('') + '</ol></details>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="approve">Одобрить</button><button type="button" class="j2-btn danger" data-act="rej-open" aria-expanded="false">Отклонить</button></div>' +
      '<div class="sa-reject" hidden><label class="j2-field" style="margin-top:10px"><span>Причина</span><textarea rows="3" maxlength="500" placeholder="Что нужно исправить"></textarea></label>' +
      '<div class="sa-actions"><button type="button" class="j2-btn danger" data-act="rej-send">Отклонить заявку</button><button type="button" class="j2-btn" data-act="rej-cancel">Не отклонять</button></div></div>' +
      '</article>';
  }
  function paintReqs(n) {
    const sid = st.secret && st.secret.reqId;
    const list = st.reqs.filter((r) => !sid || r.id !== sid);
    $('sub').textContent = list.length ? 'Заявки новых старост: ' + list.length : 'Новых заявок нет';
    paint(n == null ? st.nav : n, '<div id="secBox"></div>' + (list.length ? list.map(reqCard).join('') : (st.secret ? '' : '<div class="j2-card"><h2>Новых заявок нет</h2><p>Когда староста отправит заявку, она появится здесь.</p></div>')), $('rolesBody'));
    paintSecret();
  }

  const ROLE_LBL = { headman: 'староста', deputy: 'заместитель' };
  const BASE_LBL = { student: 'студент', teacher_lecture: 'преподаватель (лекции)', teacher_practice: 'преподаватель (практика)' };
  const STATUS_LBL = { pending: 'ждёт подтверждения', active: 'действует', rejected: 'отклонён', removed: 'убран из группы' };
  async function loadMembers(n) {
    if (!(await loadGroups(n))) return;
    const gid = st.roleGroup;
    const [m, s] = await Promise.all([
      sb.from('memberships').select('user_id,student_id,base_role,extra_role,status').eq('group_id', gid),
      sb.from('students').select('id,last_name,first_name').eq('group_id', gid),
    ]);
    if (stale(n)) return;
    if (m.error || s.error) return paint(n, failBox(m.error || s.error), $('rolesBody'));
    const names = new Map((s.data || []).map((x) => [x.id, personName(x)]));
    const mem = (m.data || []).map((x) => ({ ...x, name: names.get(x.student_id) || '' }))
      .sort((a, b) => (a.extra_role === 'headman' ? 0 : a.extra_role === 'deputy' ? 1 : 2) - (b.extra_role === 'headman' ? 0 : b.extra_role === 'deputy' ? 1 : 2) || a.name.localeCompare(b.name, 'ru'));
    st.members = mem;
    const items = mem.map((x) => {
      const label = x.name || 'Без привязки к студенту';
      const role = x.extra_role ? ROLE_LBL[x.extra_role] : BASE_LBL[x.base_role] || x.base_role;
      const can = x.status === 'active' && x.base_role === 'student';
      const b = (r, t, cls) => '<button type="button" class="j2-btn small ' + (cls || '') + '" data-act="rc-ask" data-user="' + esc(x.user_id) + '" data-role="' + r + '">' + t + '</button>';
      return '<li class="sa-mem"><div class="sa-head"><div><b>' + esc(label) + '</b><div class="sub">id ' + esc(String(x.user_id).slice(0, 8)) + '</div></div>' +
        '<div style="text-align:right"><span class="sa-pill ' + (x.extra_role ? 'ok' : 'off') + '">' + esc(role) + '</span><div class="sub">' + esc(STATUS_LBL[x.status] || x.status) + '</div></div></div>' +
        (can ? '<div class="sa-actions">' + (x.extra_role !== 'headman' ? b('headman', 'Назначить старостой') : '') + (x.extra_role !== 'deputy' ? b('deputy', 'Назначить заместителем') : '') +
          (x.extra_role ? b('student', 'Снять роль') : '') + b('none', 'Убрать из группы', 'danger') + '</div>' : '') + '</li>';
    }).join('');
    paint(n, groupSelect() + '<div id="rcBox"></div><div class="j2-card"><h2>Участники</h2>' + (items ? '<ul class="j2-list">' + items + '</ul>' : '<p>В группе пока никого нет.</p>') + '</div>' +
      '<p class="sa-note">Роль меняется только у действующих студентов. В группе один староста и один заместитель: прежний держатель роли станет обычным студентом.</p>', $('rolesBody'));
    paintRc();
  }
  function rcText(rc) {
    const g = (st.groups.find((x) => x.id === rc.group) || {}).name || '';
    if (rc.role === 'headman') return 'Назначить «' + rc.name + '» старостой группы ' + g + '? Прежний староста станет обычным студентом.';
    if (rc.role === 'deputy') return 'Назначить «' + rc.name + '» заместителем старосты группы ' + g + '? Прежний заместитель станет обычным студентом.';
    if (rc.role === 'student') return 'Снять с «' + rc.name + '» роль старосты или заместителя? Он останется студентом группы ' + g + '.';
    return 'Убрать «' + rc.name + '» из группы ' + g + '? Фамилия освободится, а человек потеряет доступ к данным группы.';
  }
  function paintRc() {
    const box = $('rcBox'); if (!box) return;
    const rc = st.rc;
    box.innerHTML = rc ? '<section class="j2-card warn" id="rcCard" tabindex="-1" aria-labelledby="rcT"><h2 id="rcT">Подтвердите действие</h2><p style="color:var(--j-text)">' + esc(rcText(rc)) + '</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="rc-yes">Подтвердить</button><button type="button" class="j2-btn" data-act="rc-no">Отмена</button></div></section>' : '';
    if (rc && $('rcCard')) $('rcCard').focus();
  }

  // --- Преподаватели ---
  const TROLE = { teacher_lecture: 'лекции', teacher_practice: 'практика' };
  async function loadTeachers(n) {
    if (!(await loadGroups(n))) return;
    const gid = st.roleGroup;
    const [t, sj] = await Promise.all([sb.rpc('sysadmin_teachers', { p_group: gid }), sb.rpc('sysadmin_group_subjects', { p_group: gid })]);
    if (stale(n)) return;
    if (t.error) return paint(n, groupSelect() + failBox(t.error), $('rolesBody'));
    st.teachers = t.data || [];
    const subj = sj.error || !Array.isArray(sj.data) ? [] : sj.data;
    if (!st.tf || st.tf.group !== gid) st.tf = { group: gid, opts: subj.slice(), sel: new Set(), subjErr: !!sj.error };
    const rows = st.teachers.map((x) => '<li class="sa-mem"><div class="sa-head"><div><b class="sa-wrap-any">' + esc(x.email) + '</b>' +
      '<div class="sub">' + esc(TROLE[x.role] || x.role) + ' · ' + esc(STATUS_LBL[x.status] || x.status) + '</div></div>' +
      (x.status === 'active' ? '<button type="button" class="j2-btn small danger" data-act="tch-rm" data-user="' + esc(x.user_id) + '" data-email="' + esc(x.email) + '">Снять</button>' : '') + '</div>' +
      '<div class="sa-mono">' + (x.subjects && x.subjects.length ? esc(x.subjects.join(', ')) : 'предметы не назначены') + '</div></li>').join('');
    paint(n, groupSelect() + BOXES + '<section class="j2-card" aria-labelledby="tchT"><h2 id="tchT">Преподаватели группы</h2>' +
      (rows ? '<ul class="j2-list">' + rows + '</ul>' : '<p>Преподавателей пока нет.</p>') + '</section>' +
      '<section class="j2-card" id="tchForm" aria-labelledby="addT"><h2 id="addT">Добавить преподавателя</h2>' +
      '<label class="j2-field"><span>Почта</span><input id="tfEmail" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="name@example.com"></label>' +
      '<label class="j2-field sa-field-sel"><span>Ведёт</span><select id="tfRole"><option value="teacher_lecture">Лекции</option><option value="teacher_practice">Практические занятия</option></select></label>' +
      '<p class="sa-card-p" id="tfSubjLbl">Предметы</p><div class="j2-chips" id="tfChips" role="group" aria-labelledby="tfSubjLbl"></div>' +
      (st.tf.subjErr ? '<p class="sa-note">Предметы из расписания не загрузились. Впишите вручную.</p>' : !subj.length ? '<p class="sa-note">В расписании группы предметов нет. Впишите вручную.</p>' : '') +
      '<div class="sa-thr"><label class="j2-field"><span>Свой предмет</span><input id="tfManual" type="text" maxlength="200" autocomplete="off"></label>' +
      '<button type="button" class="j2-btn small" data-act="tch-subj">Добавить предмет</button></div>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="tch-add">Добавить преподавателя</button></div>' +
      '<p class="sa-note">Если учётной записи с такой почтой нет, предложим создать её и покажем временный пароль один раз.</p></section>', $('rolesBody'));
    paintAsk(); paintSecret(); paintChips();
  }
  function paintChips() {
    const box = $('tfChips'); if (!box || !st.tf) return;
    box.innerHTML = st.tf.opts.length ? st.tf.opts.map((s) => '<button type="button" class="j2-chip" aria-pressed="' + st.tf.sel.has(s) + '" data-act="subj" data-s="' + esc(s) + '">' + esc(s) + '</button>').join('') : '<span class="sa-note">Предметы не выбраны</span>';
  }
  function tchAdd(btn, scope) {
    const email = $('tfEmail').value.trim().toLowerCase(), role = $('tfRole').value, subs = [...st.tf.sel], gid = st.roleGroup;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Проверьте адрес почты.', 'err'); $('tfEmail').focus(); return; }
    if (!subs.length) { say('Выберите хотя бы один предмет или впишите свой.', 'err'); return; }
    if (subs.length > 20) { say(ERR.too_many_subjects, 'err'); return; }
    return act(btn, scope, async () => {
      say('Ищем учётную запись…');
      const f = await sb.rpc('sysadmin_find_user', { p_email: email });
      if (f.error) { say(errMsg(f.error), 'err'); return; }
      if (f.data) { await tchAssign(f.data, email, gid, role, subs); return; }
      say('');
      ask({ text: 'Учётной записи «' + email + '» ещё нет. Создать её, выдать временный пароль и назначить преподавателем? Пароль покажется один раз.', yes: 'Создать и назначить', danger: false, run: () => tchCreate(email, gid, role, subs) });
    });
  }
  async function tchAssign(uid, email, gid, role, subs) {
    say('Назначаем…');
    const { error } = await sb.rpc('sysadmin_assign_teacher', { p_user: uid, p_group: gid, p_role: role, p_subjects: subs });
    if (error) { say(errMsg(error), 'err'); return false; }
    const g = (st.groups.find((x) => x.id === gid) || {}).name || '';
    say('Готово: «' + email + '» теперь преподаватель группы ' + g + ' (' + TROLE[role] + ': ' + subs.join(', ') + ').', 'ok');
    st.tf = null; const n = ++st.nav; await loadTeachers(n);
    return true;
  }
  async function tchCreate(email, gid, role, subs) {
    say('Создаём учётную запись…');
    const r = await J2.fn('sysadmin-user', { email });
    if (!r.ok) { say(fnErr(r), 'err'); return; }
    const d = r.data || {};
    if (!d.user_id) { say(J2.errText('server_error'), 'err'); return; }
    const secret = d.created && d.password ? { title: 'Учётная запись создана', label: 'Временный пароль для ' + email, raw: d.password, shown: d.password,
      warn: 'Пароль показывается один раз и нигде не сохраняется. Скопируйте и передайте преподавателю безопасным способом.' } : null;
    const ok = await tchAssign(d.user_id, email, gid, role, subs);
    if (secret) { st.secret = secret; paintSecret(); if (!ok) say('Учётная запись создана, но назначить не удалось: ' + ($('msg').textContent || '') + ' Пароль выше, повторите назначение с этой же почтой.', 'err'); }
  }
  function tchRemove(btn) {
    const uid = btn.dataset.user, email = btn.dataset.email, gid = st.roleGroup, g = (st.groups.find((x) => x.id === gid) || {}).name || '';
    ask({ text: 'Снять «' + email + '» с группы ' + g + '? Предметы будут сняты, доступ к данным и чату группы закроется.', yes: 'Снять преподавателя', run: async () => {
      say('Снимаем…');
      const { error } = await sb.rpc('sysadmin_remove_teacher', { p_user: uid, p_group: gid });
      if (error) { say(errMsg(error), 'err'); return; }
      say('Готово: «' + email + '» больше не преподаватель группы ' + g + '.', 'ok'); const n = ++st.nav; await loadTeachers(n);
    } });
  }

  // --- Сисадмины ---
  async function loadAdmins(n) {
    const r = await sb.rpc('sysadmin_list_sysadmins');
    if (stale(n)) return;
    if (r.error) return paint(n, failBox(r.error), $('rolesBody'));
    st.admins = r.data || [];
    const rows = st.admins.map((x) => {
      const me = x.user_id === st.me;
      return '<li class="sa-mem"><div class="sa-head"><div><b class="sa-wrap-any">' + esc(x.email) + '</b><div class="sub">с ' + esc(J2.fmtDate(x.created_at)) + (me ? ' · это вы' : '') + '</div></div>' +
        (!me && st.admins.length > 1 ? '<button type="button" class="j2-btn small danger" data-act="adm-rm" data-user="' + esc(x.user_id) + '" data-email="' + esc(x.email) + '">Снять</button>' : '') + '</div></li>';
    }).join('');
    paint(n, BOXES + '<section class="j2-card" aria-labelledby="admT"><h2 id="admT">Системные администраторы</h2><ul class="j2-list">' + rows + '</ul></section>' +
      '<section class="j2-card" id="admForm" aria-labelledby="admAddT"><h2 id="admAddT">Назначить сисадмина</h2>' +
      '<label class="j2-field"><span>Почта</span><input id="admEmail" type="email" inputmode="email" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="name@example.com"></label>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="adm-add">Назначить</button></div>' +
      '<p class="sa-note">Учётная запись с этой почтой уже должна существовать. Себя и последнего сисадмина снять нельзя.</p></section>', $('rolesBody'));
    paintAsk();
  }
  function admAdd(btn, scope) {
    const email = $('admEmail').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Проверьте адрес почты.', 'err'); $('admEmail').focus(); return; }
    return act(btn, scope, async () => {
      say('Ищем учётную запись…');
      const f = await sb.rpc('sysadmin_find_user', { p_email: email });
      if (f.error) { say(errMsg(f.error), 'err'); return; }
      if (!f.data) { say('Учётной записи с такой почтой нет. Человек должен сначала зарегистрироваться или войти.', 'err'); return; }
      say('');
      ask({ text: 'Дать «' + email + '» полный доступ системного администратора: все группы, роли, резервные копии и служебные операции?', yes: 'Назначить сисадмином', run: async () => {
        say('Назначаем…');
        const { error } = await sb.rpc('sysadmin_add_sysadmin', { p_user: f.data });
        if (error) { say(errMsg(error), 'err'); return; }
        say('Готово: «' + email + '» теперь сисадмин.', 'ok'); const n = ++st.nav; await loadAdmins(n);
      } });
    });
  }
  function admRemove(btn) {
    const uid = btn.dataset.user, email = btn.dataset.email;
    ask({ text: 'Снять «' + email + '» с роли системного администратора? Доступ к этой утилите пропадёт сразу.', yes: 'Снять сисадмина', run: async () => {
      say('Снимаем…');
      const { error } = await sb.rpc('sysadmin_remove_sysadmin', { p_user: uid });
      if (error) { say(errMsg(error), 'err'); return; }
      say('Готово: «' + email + '» больше не сисадмин.', 'ok'); const n = ++st.nav; await loadAdmins(n);
    } });
  }

  // ---------- Группы ----------
  const GSTAT = { active: ['действует', 'ok'], closed: ['отключена', 'off'], graduated: ['выпустилась', 'off'] };
  function groupCard(x) {
    const s = GSTAT[x.status] || [x.status || 'неизвестно', 'off'], c = st.gcount[x.id], m = st.imp[x.id];
    const impTxt = m && m.last_import_at ? (IMP_OK.test(m.last_status || '') ? 'Расписание обновлено ' + when(m.last_import_at) + (m.lessons_count != null ? ', занятий ' + m.lessons_count : '') + '.' : 'Последний импорт расписания не удался' + (m.last_error ? ': ' + String(m.last_error).slice(0, 160) : '') + '.') : 'Расписание ещё не загружалось.';
    return '<article class="j2-card" data-group="' + esc(x.id) + '"><div class="sa-head"><h2>' + esc(x.name) + '</h2>' + pill(s[1], s[0]) + '</div>' +
      '<p class="sa-card-p">' + esc([x.faculty, x.course ? x.course + ' курс' : '', x.study_form].filter(Boolean).join(', ')) + '</p>' +
      '<p class="sa-card-p">Студентов: ' + (c == null ? '—' : c) + '. Пороги пропусков: предупреждение ' + esc(x.warn_hours) + ' ч, деканат ' + esc(x.dean_hours) + ' ч.</p>' +
      '<p class="sa-card-p">' + esc(impTxt) + '</p><p class="sa-res" role="status"></p>' +
      '<div class="sa-actions">' + (x.status === 'active' ? '<button type="button" class="j2-btn danger" data-act="grp-off">Отключить</button>' : x.status === 'closed' ? '<button type="button" class="j2-btn" data-act="grp-on">Включить</button>' : '') +
      '<button type="button" class="j2-btn" data-act="grp-import">Обновить расписание</button></div>' +
      '<div class="sa-thr"><label class="j2-field"><span>Предупр., ч</span><input type="number" min="1" step="1" inputmode="numeric" data-f="warn" value="' + esc(x.warn_hours) + '"></label>' +
      '<label class="j2-field"><span>Деканат, ч</span><input type="number" min="1" step="1" inputmode="numeric" data-f="dean" value="' + esc(x.dean_hours) + '"></label>' +
      '<button type="button" class="j2-btn small primary" data-act="thr-save">Сохранить</button></div></article>';
  }
  const gcardEl = (gid) => [...document.querySelectorAll('article[data-group]')].find((a) => a.dataset.group === gid) || null;
  function repaintGroup(gid, res, kind) {
    const el = gcardEl(gid), g = st.gl.find((x) => x.id === gid); if (!el || !g) return;
    el.outerHTML = groupCard(g);
    const nel = gcardEl(gid), r = nel && nel.querySelector('.sa-res');
    if (r && res) { r.textContent = res; r.className = 'sa-res ' + (kind || 'ok'); }
  }
  async function renderGroups(n) {
    const [g, sum] = await Promise.all([sb.from('groups').select('*').order('created_at'), sb.rpc('ops_summary', { p_hours: 24 })]);
    if (g.error) return paint(n, failBox(g.error));
    st.gl = g.data || [];
    const counts = await Promise.all(st.gl.map((x) => sb.from('students').select('id', { count: 'exact', head: true }).eq('group_id', x.id)));
    if (stale(n)) return;
    st.gcount = {}; st.gl.forEach((x, i) => { st.gcount[x.id] = counts[i].error ? null : counts[i].count; });
    st.imp = {}; ((sum.data && sum.data.imports) || []).forEach((m) => { st.imp[m.group_id] = m; });
    $('sub').textContent = st.gl.length ? 'Всего групп: ' + st.gl.length : 'Групп пока нет';
    paint(n, BOXES + newGroupForm() + (st.gl.map(groupCard).join('') || '<div class="j2-card"><p>Групп пока нет. Создайте группу формой выше или дождитесь заявки старосты.</p></div>'));
    paintAsk(); paintSecret();
  }
  function groupOff(btn, el) {
    const gid = el.dataset.group, g = st.gl.find((x) => x.id === gid); if (!g) return;
    ask({ text: 'Отключить группу ' + g.name + '? Она станет доступна только для просмотра: пропуски, оценки и другие записи менять будет нельзя, пока вы её не включите.', yes: 'Отключить группу', run: () => setGroupStatus(gid, 'closed') });
  }
  async function setGroupStatus(gid, status) {
    say(status === 'closed' ? 'Отключаем группу…' : 'Включаем группу…');
    const { error } = await sb.rpc('sysadmin_set_group_status', { p_group: gid, p_status: status });
    if (error) { say(errMsg(error), 'err'); return; }
    const g = st.gl.find((x) => x.id === gid); if (g) g.status = status;
    say('Готово: группа ' + (g ? g.name : '') + (status === 'closed' ? ' отключена (только просмотр).' : ' снова действует.'), 'ok');
    repaintGroup(gid, status === 'closed' ? 'Группа отключена: только просмотр.' : 'Группа включена.');
  }
  function groupImport(btn, el) {
    const gid = el.dataset.group;
    return act(btn, el, async () => {
      say('Обновляем расписание…');
      const r = await J2.fn('schedule-import', { group_id: gid });
      say('');
      if (!r.ok) { const e = el.querySelector('.sa-res'); e.className = 'sa-res err'; e.textContent = 'Расписание не обновлено. ' + fnErr(r); return; }
      const d = r.data || {};
      st.imp[gid] = { ...(st.imp[gid] || {}), last_import_at: new Date().toISOString(), last_status: 'ok', last_error: null, lessons_count: d.lessons != null ? d.lessons : (st.imp[gid] || {}).lessons_count };
      repaintGroup(gid, 'Расписание обновлено: добавлено ' + (d.added || 0) + ', убрано ' + (d.removed || 0) + ', изменено ' + (d.changed || 0) + (d.lessons != null ? ', всего занятий ' + d.lessons : '') + '.');
    });
  }
  function saveThr(btn, el) {
    const gid = el.dataset.group, w = el.querySelector('[data-f="warn"]').value.trim(), d = el.querySelector('[data-f="dean"]').value.trim();
    const warn = Number(w), dean = Number(d);
    if (!/^\d+$/.test(w) || !/^\d+$/.test(d) || warn < 1 || dean < warn) { say(ERR.bad_thresholds, 'err'); return; }
    return act(btn, el, async () => {
      say('Сохраняем…');
      const { error } = await sb.rpc('sysadmin_set_thresholds', { p_group: gid, p_warn: warn, p_dean: dean });
      if (error) { say(errMsg(error), 'err'); return; }
      say('Пороги сохранены: предупреждение ' + warn + ' ч, деканат ' + dean + ' ч.', 'ok');
      const g = st.gl.find((x) => x.id === gid); if (g) { g.warn_hours = warn; g.dean_hours = dean; }
      repaintGroup(gid, 'Пороги сохранены.');
    });
  }

  // --- Новая группа ---
  const NG = ['fac', 'frm', 'crs', 'grp'];
  function newGroupForm() {
    const f = (id, label, extra) => '<label class="j2-field"><span>' + label + '</span><input id="' + id + '" type="text" autocomplete="off" ' + (extra || '') + '></label>';
    const sel = (i, label) => '<label class="j2-field sa-field-sel"><span>' + label + '</span><select id="ng-' + NG[i] + '" data-ng="' + i + '" disabled><option value="">Выберите</option></select></label>';
    return '<details class="j2-card sa-new" id="ngBox"><summary>Новая группа</summary>' +
      '<p class="sa-note">Группа создаётся без заявки и без старосты: старосту назначите позже в «Роли». Код группы покажется один раз.</p>' +
      f('ng-name', 'Название группы', 'maxlength="60" placeholder="24ДММ-2"') +
      '<details class="sa-sub-d"><summary>Найти на bseu.by (необязательно)</summary><p class="sa-note">Выбор подставит факультет, форму, курс, название и идентификаторы сам.</p>' +
      sel(0, 'Факультет') + sel(1, 'Форма обучения') + sel(2, 'Курс') + sel(3, 'Группа') + '<p class="j2-msg err" id="ngErr" role="alert"></p></details>' +
      f('ng-faculty', 'Факультет (текстом)', 'maxlength="100"') + f('ng-form', 'Форма обучения (текстом)', 'maxlength="60" placeholder="Дневная"') +
      '<label class="j2-field"><span>Курс</span><input id="ng-course" type="number" min="1" max="8" step="1" inputmode="numeric"></label>' +
      '<details class="sa-sub-d"><summary>Идентификаторы bseu.by</summary><p class="sa-note">Нужны только для автоматической загрузки расписания: числа из адреса и списков на bseu.by/schedule (факультет, форма, группа). Можно оставить пустыми.</p>' +
      f('ng-bf', 'Идентификатор факультета', 'inputmode="numeric" maxlength="12"') + f('ng-bfm', 'Идентификатор формы', 'inputmode="numeric" maxlength="12"') + f('ng-bg', 'Идентификатор группы', 'inputmode="numeric" maxlength="12"') + '</details>' +
      '<label class="j2-field"><span>Студенты: по одному на строку</span><textarea id="ng-students" rows="7" spellcheck="false" placeholder="Иванов Иван; бюджет&#10;Петрова Анна; платная&#10;Сидоров Пётр"></textarea></label>' +
      '<p class="sa-note">Формат строки: «Фамилия Имя; бюджет» или «; платная». Форму можно не указывать.</p>' +
      '<div class="sa-thr"><label class="j2-field"><span>Один студент: Фамилия Имя</span><input id="ng-one" type="text" autocomplete="off" maxlength="200"></label>' +
      '<label class="j2-field sa-field-sel"><span>Форма</span><select id="ng-onef"><option value="">не указана</option><option value="бюджет">бюджет</option><option value="платная">платная</option></select></label></div>' +
      '<div class="sa-actions"><button type="button" class="j2-btn" data-act="ng-one">Добавить в список</button></div>' +
      '<p class="sa-note" id="ngPrev" aria-live="polite">Студентов: 0</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="ng-create">Создать группу</button></div></details>';
  }
  const NG_PARAMS = [
    () => ({ action: 'faculties' }),
    () => ({ action: 'forms', faculty: $('ng-fac').value }),
    () => ({ action: 'courses', faculty: $('ng-fac').value, form: $('ng-frm').value }),
    () => ({ action: 'groups', faculty: $('ng-fac').value, form: $('ng-frm').value, course: $('ng-crs').value }),
  ];
  const ngSeq = [0, 0, 0, 0];
  function ngReset(i, text) { const s = $('ng-' + NG[i]); s.innerHTML = '<option value="">' + esc(text || 'Выберите') + '</option>'; s.disabled = true; }
  async function ngLoad(i) {
    for (let k = i; k < 4; k++) ngReset(k, k === i ? 'Загрузка…' : 'Выберите');
    const my = ++ngSeq[i];
    const r = await J2.fn('schedule-lookup', NG_PARAMS[i](), { anon: true });
    if (my !== ngSeq[i] || !$('ng-' + NG[i])) return;
    const list = r.ok && Array.isArray(r.data) ? r.data : null;
    if (!list) { ngReset(i, 'Не загрузилось'); $('ngErr').textContent = 'Список bseu.by не загрузился. Заполните поля вручную. ' + J2.errText(r.data && r.data.error ? r.data.error : 'network'); return; }
    $('ngErr').textContent = '';
    const s = $('ng-' + NG[i]);
    s.innerHTML = '<option value="">' + (list.length ? 'Выберите' : 'Ничего не найдено') + '</option>' + list.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.text) + '</option>').join('');
    s.disabled = !list.length;
  }
  function ngPick(i) {                                                  // выбор в списке bseu.by заполняет поля формы
    const s = $('ng-' + NG[i]), txt = s.selectedOptions[0] ? s.selectedOptions[0].textContent : '';
    for (let k = i + 1; k < 4; k++) { ngSeq[k]++; ngReset(k); }
    if (i === 0) { $('ng-faculty').value = s.value ? txt : ''; $('ng-bf').value = s.value; }
    if (i === 1) { $('ng-form').value = s.value ? txt : ''; $('ng-bfm').value = s.value; }
    if (i === 2) $('ng-course').value = /^\d+$/.test(s.value) ? s.value : '';
    if (i === 3 && s.value) { $('ng-name').value = txt.split('|')[0].trim().slice(0, 60); $('ng-bg').value = s.value; }
    if (s.value && i < 3) ngLoad(i + 1);
  }
  // «Фамилия Имя; бюджет|платная» по строкам → { rows, bad }
  function parseStudents(text) {
    const rows = [], bad = [], seen = new Set();
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim(); if (!t) return;
      const parts = t.split(/[;\t]/), fio = (parts[0] || '').trim().replace(/\s+/g, ' '), f = (parts[1] || '').trim().toLowerCase(), w = fio.split(' ');
      if (w.length < 2) { bad.push('строка ' + (i + 1) + ': нужны фамилия и имя'); return; }
      let form = null;
      if (f) { if (/^(бюджет|б$|budget)/.test(f)) form = 'budget'; else if (/^(платн|п$|paid)/.test(f)) form = 'paid'; else { bad.push('строка ' + (i + 1) + ': форма «' + parts[1].trim() + '» не распознана (бюджет или платная)'); return; } }
      const key = fio.toLowerCase().replace(/ё/g, 'е');
      if (seen.has(key)) { bad.push('строка ' + (i + 1) + ': повтор «' + fio + '»'); return; }
      seen.add(key);
      rows.push({ last_name: w[0], first_name: w.slice(1).join(' '), study_form: form });
    });
    return { rows, bad };
  }
  function ngPreview() {
    const p = $('ngPrev'); if (!p) return null;
    const { rows, bad } = parseStudents($('ng-students').value);
    const b = rows.filter((r) => r.study_form === 'budget').length, pd = rows.filter((r) => r.study_form === 'paid').length;
    p.textContent = 'Студентов: ' + rows.length + ' (бюджет ' + b + ', платная ' + pd + ', форма не указана ' + (rows.length - b - pd) + ').' + (bad.length ? ' Проблемы: ' + bad.slice(0, 5).join('; ') + (bad.length > 5 ? '…' : '') + '.' : '');
    return { rows, bad };
  }
  function ngAddOne() {
    const v = $('ng-one').value.trim().replace(/\s+/g, ' '), f = $('ng-onef').value;
    if (v.split(' ').length < 2) { say('Напишите фамилию и имя.', 'err'); $('ng-one').focus(); return; }
    const ta = $('ng-students');
    ta.value = ta.value.replace(/\s+$/, '') + (ta.value.trim() ? '\n' : '') + v + (f ? '; ' + f : '');
    $('ng-one').value = ''; say(''); ngPreview(); $('ng-one').focus();
  }
  function ngCreate(btn) {
    const name = $('ng-name').value.trim().replace(/\s+/g, ' '), course = $('ng-course').value.trim();
    const { rows, bad } = ngPreview() || { rows: [], bad: [] };
    if (name.length < 2) { say('Напишите название группы.', 'err'); $('ng-name').focus(); return; }
    if (course && !/^[1-8]$/.test(course)) { say('Курс: число от 1 до 8.', 'err'); return; }
    if (bad.length) { say('Исправьте список студентов: ' + bad[0] + '.', 'err'); $('ng-students').focus(); return; }
    if (!rows.length) { say('Добавьте хотя бы одного студента.', 'err'); $('ng-students').focus(); return; }
    const val = (id) => $(id).value.trim() || null, digits = (id) => (/^\d{1,12}$/.test($(id).value.trim()) ? $(id).value.trim() : null);
    const group = { name, group_no: name, faculty: val('ng-faculty'), study_form: val('ng-form'), course: course ? Number(course) : null,
      bseu_faculty_id: digits('ng-bf'), bseu_form_id: digits('ng-bfm'), bseu_group_id: digits('ng-bg'), university: 'БГЭУ' };
    return act(btn, $('ngBox'), async () => {
      say('Создаём группу…');
      const { data, error } = await sb.rpc('sysadmin_create_group', { p_group: group, p_students: rows });
      if (error) { say(errMsg(error), 'err'); return; }
      st.secret = { title: 'Группа «' + name + '» создана', label: 'Код группы', raw: data && data.code, shown: fmtCode(data && data.code),
        warn: 'Код показывается один раз. Передайте его старосте или студентам: по нему они входят в группу. Потом его можно только перевыпустить.' };
      say('Группа создана, студентов: ' + rows.length + '. Запишите код: он больше не покажется.', 'ok');
      const n = ++st.nav; await renderGroups(n);
    });
  }

  // ---------- Служебное ----------
  async function renderService(n) {
    if (st.tg && st.tg.ask) st.tg = null;
    paint(n, '<div id="askBox"></div>' +
      '<section class="j2-card" id="mtCard" aria-labelledby="mtT"><h2 id="mtT">Режим технических работ</h2><div id="mtBody">' + loading + '</div></section>' +
      '<section class="j2-card" id="botCard" aria-labelledby="botT"><h2 id="botT">Бот Telegram</h2><div id="botBody">' + loading + '</div></section>' +
      '<section class="j2-card" id="impCard" aria-labelledby="impT2"><h2 id="impT2">Импорт расписания</h2><div id="impBody">' + loading + '</div></section>' +
      '<section class="j2-card" id="bkCard" aria-labelledby="bkT2"><h2 id="bkT2">Резервные копии</h2><div id="bkBody">' + loading + '</div></section>' +
      '<section class="j2-card" id="tgCard" aria-labelledby="tgT"><h2 id="tgT">Сброс привязок Telegram</h2>' +
      '<p class="sa-card-p">Сброс нужен, если бот сменился или привязки устарели: каждый пользователь привяжет бота заново. Логины и данные журнала остаются.</p>' +
      '<div id="tgBody"></div></section>');
    paintTg();
    await Promise.all([loadMaint(n), loadBot(n, false), loadImports(n), loadBackups(n)]);
  }
  // --- техработы ---
  async function loadMaint(n) {
    const r = await sb.rpc('maintenance_status');
    const box = $('mtBody'); if (stale(n) || !box) return;
    if (r.error) { box.innerHTML = failBox(r.error, 'retry-mt', 'Статус не загрузился'); return; }
    const on = !!(r.data && r.data.on); st.maint = on;
    box.innerHTML = '<p class="sa-card-p">Сейчас: ' + (on ? pill('wait', 'включён') : pill('ok', 'выключен')) + '</p>' +
      '<p class="sa-card-p">' + (on ? 'Все, кроме старосты, видят экран техработ и не могут читать и писать данные.' : 'Когда режим включён, все, кроме старосты, видят экран техработ и не могут читать и писать данные.') + '</p>' +
      '<p class="sa-res" id="mtRes" role="status"></p>' +
      '<div class="sa-actions">' + (on ? '<button type="button" class="j2-btn primary" data-act="mt-off">Выключить режим</button>' : '<button type="button" class="j2-btn danger" data-act="mt-on">Включить режим</button>') + '</div>';
  }
  async function setMaint(on) {
    say(on ? 'Включаем режим…' : 'Выключаем режим…');
    const { error } = await sb.rpc('set_maintenance', { p_on: on });
    if (error) { say(errMsg(error), 'err'); return; }
    say('Режим технических работ ' + (on ? 'включён.' : 'выключен.'), 'ok');
    await loadMaint(st.nav);
    const r = $('mtRes'); if (r) { r.className = 'sa-res ' + (on ? 'warn' : 'ok'); r.textContent = on ? 'Режим включён. Не забудьте выключить его после работ.' : 'Режим выключен: журнал открыт для всех.'; }
  }
  // --- бот ---
  async function loadBot(n, reinstall) {
    const r = await J2.fn('tg-status', reinstall ? { action: 'reinstall' } : {});
    const box = $('botBody'); if (stale(n) || !box) return;
    if (!r.ok) { box.innerHTML = failBox(fnErr(r), 'retry-bot', 'Бот не отвечает'); return; }
    const d = r.data || {};
    let host = '';
    try { host = d.webhook_url ? new URL(d.webhook_url).host : ''; } catch (e) { host = ''; }
    box.innerHTML = '<p class="sa-card-p">Бот: ' + esc(d.bot_username ? '@' + d.bot_username : 'имя неизвестно') + '</p>' +
      '<p class="sa-card-p">Вебхук: ' + (d.webhook_url ? pill('ok', 'установлен') + ' <span class="sa-mono">' + esc(host) + '</span>' : pill('bad', 'не установлен')) + '</p>' +
      '<p class="sa-card-p">Сообщений в очереди: ' + esc(d.pending_update_count == null ? '—' : d.pending_update_count) + '</p>' +
      (d.last_error ? '<p class="sa-card-p">Последняя ошибка Telegram: <span class="sa-mono">' + esc(d.last_error) + '</span></p>' : '<p class="sa-card-p">Ошибок Telegram нет.</p>') +
      '<p class="sa-res ' + (reinstall ? (d.ok === false ? 'err' : 'ok') : '') + '" id="botRes" role="status">' + (reinstall ? (d.ok === false ? 'Telegram не принял вебхук. Повторите.' : 'Вебхук переустановлен.') : '') + '</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn" data-act="bot-refresh">Обновить</button><button type="button" class="j2-btn" data-act="bot-reinstall">Переустановить вебхук</button></div>';
  }
  // --- импорт ---
  async function loadImports(n) {
    const r = await sb.rpc('ops_summary', { p_hours: 24 });
    const box = $('impBody'); if (stale(n) || !box) return;
    box.innerHTML = r.error ? failBox(r.error, 'retry-imp', 'Состояние импорта не загрузилось') : importsHtml((r.data && r.data.imports) || []) +
      '<p class="sa-note">Ночной импорт идёт сам. Обновить одну группу вручную можно в разделе «Группы».</p>';
  }
  // --- резервные копии ---
  async function loadBackups(n) {
    const r = await sb.from('backups').select('id,at,kind,size_bytes,tables,status,error').order('at', { ascending: false }).limit(10);
    const box = $('bkBody'); if (stale(n) || !box) return;
    if (r.error) { box.innerHTML = failBox(r.error, 'retry-bk', 'Список копий не загрузился'); return; }
    const rows = (r.data || []).map((b) => {
      const cnt = b.tables ? Object.values(b.tables).reduce((s, x) => s + (Number(x) || 0), 0) : null;
      return '<li class="sa-log"><div class="sa-head"><div><b>' + esc(when(b.at)) + '</b><div class="sub">' + (b.kind === 'manual' ? 'вручную' : 'по расписанию') + (b.status === 'ok' ? ', ' + esc(fmtBytes(b.size_bytes)) + (cnt != null ? ', строк ' + cnt : '') : '') + '</div></div>' +
        (b.status === 'ok' ? '<button type="button" class="j2-btn small" data-act="bk-dl" data-id="' + esc(b.id) + '">Скачать</button>' : pill('bad', 'сбой')) + '</div>' +
        (b.status !== 'ok' && b.error ? '<div class="sa-mono">' + esc(b.error) + '</div>' : '') + '</li>';
    }).join('');
    box.innerHTML = (rows ? '<ul class="j2-list">' + rows + '</ul>' : '<p>Копий пока нет.</p>') + '<p class="sa-res" id="bkRes" role="status"></p>' +
      '<p class="sa-note">Ночная копия делается в 03:30 по Минску и хранится 14 дней. В копию не входят чаты и данные Telegram. Ссылка на скачивание действует 5 минут.</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn primary" data-act="bk-run">Создать копию сейчас</button></div>';
  }
  function backupRun(btn, scope) {
    return act(btn, scope, async () => {
      say('Создаём копию… это может занять до минуты.');
      const r = await J2.fn('backup-run', {});
      say('');
      if (!r.ok) { const e = $('bkRes'); if (e) { e.className = 'sa-res err'; e.textContent = 'Копия не создана. ' + fnErr(r); } return; }
      await loadBackups(st.nav);
      const e = $('bkRes'); if (e) { e.className = 'sa-res ok'; e.textContent = 'Копия создана: ' + fmtBytes(r.data && r.data.size_bytes) + '.'; }
    });
  }
  function backupDownload(btn, scope) {
    const id = btn.dataset.id;
    return act(btn, scope, async () => {
      say('Готовим ссылку…');
      const r = await J2.fn('backup-link', { id });
      say('');
      const e = $('bkRes');
      if (!r.ok || !(r.data && r.data.url)) { if (e) { e.className = 'sa-res err'; e.textContent = 'Ссылка не получена. ' + fnErr(r); } return; }
      const a = document.createElement('a'); a.href = r.data.url; a.rel = 'noopener'; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove();
      if (e) { e.className = 'sa-res ok'; e.textContent = 'Скачивание началось. Ссылка действует 5 минут.'; }
    });
  }

  // --- сброс привязок Telegram ---
  // st.tg: null | { ask } подтверждение | { res: {reset, sent, failed}, err } итог; err — человеческий текст сбоя, step — что повторять (reset | broadcast)
  function paintTg() {
    const box = $('tgBody'); if (!box) return;
    const t = st.tg || {}, r = t.res;
    let html = '';
    if (r) html += '<p class="sa-card-p" role="status"><b style="color:var(--j-text)">Сброшено ' + r.reset + ', разослано ' + r.sent + '</b>' + (r.failed ? '. Не доставлено: ' + r.failed + '.' : '') + '</p>';
    if (t.err) html += '<p class="j2-msg err" role="alert">' + esc(t.err) + '</p>';
    if (t.ask) {
      html += '<section class="j2-card warn" id="tgAsk" tabindex="-1" aria-labelledby="tgAskT"><h2 id="tgAskT">Подтвердите действие</h2><p style="color:var(--j-text)">Все пользователи заново привяжут бота. Логины и данные журнала останутся. Продолжить?</p>' +
        '<div class="sa-actions"><button type="button" class="j2-btn danger" data-act="tg-yes">Да, сбросить</button><button type="button" class="j2-btn" data-act="tg-no">Отмена</button></div></section>';
    } else {
      html += '<div class="sa-actions">' +
        (t.step === 'broadcast' ? '<button type="button" class="j2-btn primary" data-act="tg-bc">Повторить рассылку</button>' : '') +
        (t.step === 'reset' ? '<button type="button" class="j2-btn primary" data-act="tg-yes">Повторить</button>' : '') +
        '<button type="button" class="j2-btn danger" data-act="tg-ask">Сбросить привязки Telegram</button></div>';
    }
    box.innerHTML = html;
    if (t.ask && $('tgAsk')) $('tgAsk').focus();
  }
  // Рассылка «Журнал обновился»: функция сама берёт строки tg_rebind без broadcast_at, поэтому повтор безопасен
  async function tgBroadcast(res) {
    const r = await J2.fn('tg-rebind-broadcast', {});
    const d = r.data || {};
    if (!r.ok) {
      const why = r.status === 0 ? J2.errText('network') : r.status === 403 ? ERR.forbidden : d.error === 'not_configured' ? 'Бот Telegram не настроен на сервере.' : J2.errText(d.error || 'server_error');
      st.tg = { res: { reset: res.reset, sent: res.sent, failed: res.failed }, err: 'Привязки сброшены, но рассылка не удалась. ' + why, step: 'broadcast' };
      return;
    }
    const sent = Number(d.sent) || 0, failed = Number(d.failed) || 0;
    st.tg = { res: { reset: res.reset, sent: res.sent + sent, failed }, err: failed ? 'Не всем удалось отправить сообщение: ' + failed + '. Эти пользователи увидят экран входа в журнале. Можно повторить рассылку.' : '', step: failed ? 'broadcast' : '' };
  }
  function tgReset(btn, card) {
    return act(btn, card, async () => {
      say('Сбрасываем привязки…');
      const { data, error } = await sb.rpc('tg_reset_all');
      if (error) { say(''); st.tg = { err: 'Не удалось сбросить привязки. ' + errMsg(error), step: 'reset' }; paintTg(); return; }
      const res = { reset: Number(data && data.reset) || 0, sent: 0, failed: 0 };
      say('Привязки сброшены. Рассылаем сообщения…');
      await tgBroadcast(res);
      say(st.tg.err ? '' : 'Готово.', st.tg.err ? '' : 'ok'); paintTg();
    });
  }
  function tgRetryBroadcast(btn, card) {
    return act(btn, card, async () => {
      say('Рассылаем сообщения…');
      await tgBroadcast({ reset: st.tg.res.reset, sent: st.tg.res.sent, failed: 0 });
      say(st.tg.err ? '' : 'Готово.', st.tg.err ? '' : 'ok'); paintTg();
    });
  }

  // ---------- действия (делегирование) ----------
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName !== 'DETAILS') return;
    if (d.dataset.id) { if (d.open) st.open.add(d.dataset.id); else st.open.delete(d.dataset.id); }
    if (d.id === 'ngBox' && d.open && !d.dataset.loaded) { d.dataset.loaded = '1'; ngLoad(0); }
  }, true);
  view().addEventListener('input', (e) => { if (e.target.id === 'ng-students') ngPreview(); });
  view().addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'tfManual') { e.preventDefault(); addManualSubject(); }
    if (e.target.id === 'ng-one') { e.preventDefault(); ngAddOne(); }
  });
  function addManualSubject() {
    const i = $('tfManual'), v = i.value.trim().replace(/\s+/g, ' ');
    if (!v) { i.focus(); return; }
    if (v.length > 200) { say(ERR.bad_subjects, 'err'); return; }
    if (!st.tf.opts.includes(v)) st.tf.opts.push(v);
    st.tf.sel.add(v); i.value = ''; say(''); paintChips(); i.focus();
  }
  view().addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'logFilter') { st.logAction = t.value; reloadLog(); }
    if (t.id === 'logHours') { st.logHours = Number(t.value); reloadLog(); }
    if (t.id === 'roleGroup') { st.roleGroup = t.value; st.rc = null; st.tf = null; clearSecrets(); const n = ++st.nav; $('rolesBody').innerHTML = loading; ({ grp: loadMembers, tch: loadTeachers }[st.roleSub] || loadMembers)(n); }
    if (t.dataset && t.dataset.ng != null) ngPick(Number(t.dataset.ng));
  });
  function reloadLog() { const n = ++st.nav; st.log = { key: n, rows: [], more: false, err: null }; const b = $('logBody'); if (b) b.innerHTML = loading; loadLog(n, false); }
  view().addEventListener('click', (e) => {
    const t = e.target;
    const sb2 = t.closest('[data-sub]');
    if (sb2) { st.roleSub = sb2.dataset.sub; say(''); const n = ++st.nav; renderRoles(n).catch((x) => paint(n, failBox(x))); return; }
    const hb = t.closest('[data-hours]');
    if (hb) { st.hours = Number(hb.dataset.hours); go('state'); return; }
    const lb = t.closest('[data-log]');
    if (lb) { st.logSub = lb.dataset.log; go('logs'); return; }
    const btn = t.closest('button[data-act]'); if (!btn) return;
    const card = btn.closest('article, section'), id = card && card.dataset.id;
    const a = btn.dataset.act;
    if (a === 'retry') return rerun();
    if (a === 'retry-log') return reloadLog();
    if (a === 'retry-mt') { $('mtBody').innerHTML = loading; return loadMaint(st.nav); }
    if (a === 'retry-bot') { $('botBody').innerHTML = loading; return loadBot(st.nav, false); }
    if (a === 'retry-imp') { $('impBody').innerHTML = loading; return loadImports(st.nav); }
    if (a === 'retry-bk') { $('bkBody').innerHTML = loading; return loadBackups(st.nav); }
    if (a === 'digest') return digest(btn, card);
    if (a === 'log-more') return act(btn, btn.parentNode, () => loadLog(st.nav, true));
    if (a === 'ask-yes') { const q = st.ask; if (!q) return; return act(btn, card, async () => { st.ask = null; try { await q.run(); } finally { paintAsk(); } }); }
    if (a === 'ask-no') { st.ask = null; paintAsk(); return; }
    if (a === 'sec-copy') return copySecret();
    if (a === 'sec-done') { st.secret = null; say(''); paintSecret(); if (st.tab === 'roles' && st.roleSub === 'req') paintReqs(); return; }
    if (a === 'approve') return approve(btn, card, id);
    if (a === 'rej-open') { const p = card.querySelector('.sa-reject'); p.hidden = !p.hidden; btn.setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) p.querySelector('textarea').focus(); return; }
    if (a === 'rej-cancel') { const p = card.querySelector('.sa-reject'); p.hidden = true; const o = card.querySelector('[data-act="rej-open"]'); o.setAttribute('aria-expanded', 'false'); o.focus(); return; }
    if (a === 'rej-send') return reject(btn, card, id);
    if (a === 'rc-ask') {
      const m = (st.members || []).find((x) => x.user_id === btn.dataset.user);
      st.rc = { group: st.roleGroup, user: btn.dataset.user, role: btn.dataset.role, name: (m && m.name) || 'этот участник' }; say(''); paintRc(); return;
    }
    if (a === 'rc-no') { st.rc = null; paintRc(); return; }
    if (a === 'rc-yes') return roleChange(btn, card);
    if (a === 'subj') { const s = btn.dataset.s; if (st.tf.sel.has(s)) st.tf.sel.delete(s); else st.tf.sel.add(s); btn.setAttribute('aria-pressed', String(st.tf.sel.has(s))); return; }
    if (a === 'tch-subj') return addManualSubject();
    if (a === 'tch-add') return tchAdd(btn, card);
    if (a === 'tch-rm') return tchRemove(btn);
    if (a === 'adm-add') return admAdd(btn, card);
    if (a === 'adm-rm') return admRemove(btn);
    if (a === 'thr-save') return saveThr(btn, card);
    if (a === 'grp-off') return groupOff(btn, card);
    if (a === 'grp-on') return act(btn, card, () => setGroupStatus(card.dataset.group, 'active'));
    if (a === 'grp-import') return groupImport(btn, card);
    if (a === 'ng-one') return ngAddOne();
    if (a === 'ng-create') return ngCreate(btn);
    if (a === 'mt-on') return ask({ text: 'Включить режим технических работ? Все, кроме старосты, потеряют доступ к журналу, пока вы его не выключите.', yes: 'Включить режим', run: () => setMaint(true) });
    if (a === 'mt-off') return act(btn, card, () => setMaint(false));
    if (a === 'bot-refresh') return act(btn, card, async () => { await loadBot(st.nav, false); });
    if (a === 'bot-reinstall') return act(btn, card, async () => { say('Переустанавливаем вебхук…'); await loadBot(st.nav, true); say(''); });
    if (a === 'bk-run') return backupRun(btn, card);
    if (a === 'bk-dl') return backupDownload(btn, card);
    if (a === 'tg-ask') { st.tg = { ask: true }; say(''); paintTg(); return; }
    if (a === 'tg-no') { st.tg = null; paintTg(); return; }
    if (a === 'tg-yes') return tgReset(btn, $('tgCard'));
    if (a === 'tg-bc') return tgRetryBroadcast(btn, $('tgCard'));
  });

  function approve(btn, card, id) {
    const g = (st.reqs.find((r) => r.id === id) || {}).payload;
    const name = (g && g.group && (g.group.group_name || g.group.name || g.group.group_no)) || 'новая';
    return act(btn, card, async () => {
      say('Одобряем…');
      const { data, error } = await sb.rpc('sysadmin_approve_registration', { p_request: id });
      if (error) { say(errMsg(error), 'err'); if (/already_approved|not_submitted/.test(error.message || '')) loadReqs(++st.nav); return; }
      J2.fn('notify-registration', { kind: 'decided', request_id: id });   // староста узнаёт решение (без кода)
      st.secret = { reqId: id, title: 'Группа «' + name + '» создана', label: 'Код группы', raw: data && data.code, shown: fmtCode(data && data.code),
        warn: 'Код показывается один раз. Передайте его старосте или нажмите «Показать код» в её заявке.' };
      say('Заявка одобрена. Запишите код группы: он больше не покажется.', 'ok'); paintReqs();
    });
  }
  function reject(btn, card, id) {
    const reason = card.querySelector('textarea').value.trim();
    if (!reason) { say('Напишите причину: староста её увидит.', 'err'); card.querySelector('textarea').focus(); return; }
    return act(btn, card, async () => {
      say('Отклоняем…');
      const { error } = await sb.rpc('sysadmin_reject_registration', { p_request: id, p_reason: reason });
      if (error) { say(errMsg(error), 'err'); if (/not_submitted/.test(error.message || '')) loadReqs(++st.nav); return; }
      J2.fn('notify-registration', { kind: 'decided', request_id: id });
      say('Заявка отклонена.', 'ok'); st.reqs = st.reqs.filter((r) => r.id !== id); paintReqs();
    });
  }
  function roleChange(btn, card) {
    const rc = st.rc; if (!rc) return;
    return act(btn, card, async () => {
      say('Меняем роль…');
      const { error } = await sb.rpc('sysadmin_set_group_role', { p_group: rc.group, p_user: rc.user, p_role: rc.role });
      if (error) { say(errMsg(error), 'err'); return; }
      st.rc = null; say('Готово: роль изменена.', 'ok'); const n = ++st.nav; await loadMembers(n);
    });
  }

  // ---------- старт ----------
  tickClock(); setInterval(tickClock, 30000);
  (async function boot() {
    if (!sb) { showLogin(); say('Не загрузился клиент Supabase. Обновите страницу.', 'err'); return; }
    const { data } = await sb.auth.getSession();
    if (data && data.session && (await checkAccess())) showMain(); else if (!(data && data.session)) showLogin();
  })();
})();
