// «Журнал 2.0»: утилита системного администратора (sysadmin.html).
// Вход по почте и паролю, проверка is_sysadmin(), четыре раздела: Состояние, Логи, Роли, Группы.
// Права проверяет сервер (RLS и функции sysadmin_*); эта страница только показывает и вызывает.
// Все тексты из базы выводятся через J2.esc. Никаких alert/confirm/prompt: подтверждения встроены в страницу.
'use strict';
(function () {
  const sb = J2.sb, $ = J2.$, esc = J2.esc;
  const st = { tab: 'state', nav: 0, roleSub: 'req', reqs: [], open: new Set(), code: null, groups: [], roleGroup: '', rc: null, logAction: '', logActions: new Set() };

  // ---------- мелочи ----------
  const ERR = {
    forbidden: 'Нет прав на это действие.',
    already_approved: 'Эта заявка уже одобрена. Код группы показывается один раз; староста может нажать «Показать код» в своей заявке.',
    not_submitted: 'Заявка уже обработана. Список обновлён.',
    not_found: 'Запись не найдена. Обновите список.',
    self: 'Свою собственную роль менять нельзя.',
    no_active_membership: 'У этого человека нет действующего участия в группе.',
    not_student: 'Старостой или заместителем может быть только студент.',
    bad_thresholds: 'Пороги: целые числа от 1, порог деканата не меньше порога предупреждения.',
    bad_role: 'Неизвестная роль.',
  };
  function errMsg(e) {
    const m = String((e && e.message) || e || '').trim();
    if (ERR[m]) return ERR[m];
    if (e && e.code === '42501') return ERR.forbidden;
    if (/jwt|expired|PGRST30/i.test(m + ' ' + ((e && e.code) || ''))) return 'Сессия истекла. Войдите снова.';
    if (/fetch|network|load failed/i.test(m)) return J2.errText('network');
    return J2.errText(m);
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
  const personName = (s) => s ? [s.last_name || s.lastName, s.first_name || s.firstName].filter(Boolean).join(' ') : '';
  const view = () => $('view');
  async function act(btn, scope, fn) {          // блокирует все кнопки карточки на время запроса
    const all = [...(scope || btn.parentNode).querySelectorAll('button')].filter((b) => !b.disabled);
    return J2.busy(btn, async () => { all.forEach((b) => { b.disabled = true; }); try { return await fn(); } finally { all.forEach((b) => { b.disabled = false; }); } });
  }
  const stale = (n) => n !== st.nav;
  const paint = (n, html, target) => { if (stale(n)) return false; (target || view()).innerHTML = html; return true; };
  const loading = '<p class="sa-note">Загрузка…</p>';
  const failBox = (e) => '<div class="j2-card bad"><h2>Не удалось загрузить</h2><p>' + esc(errMsg(e)) + '</p></div>';

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
  $('logout').addEventListener('click', async () => { await sb.auth.signOut().catch(() => {}); st.code = null; say('Вы вышли.', 'ok'); showLogin(); });

  // ---------- навигация ----------
  const TABS = {
    state: { title: 'Состояние', sub: 'Сколько всего и что ждёт решения', run: renderState },
    logs: { title: 'Логи', sub: 'Последние 50 записей журнала действий', run: renderLogs },
    roles: { title: 'Роли', sub: '', run: renderRoles },
    groups: { title: 'Группы', sub: '', run: renderGroups },
  };
  function go(tab) {
    st.tab = tab; const n = ++st.nav, t = TABS[tab];
    document.querySelectorAll('#nav button').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('title').textContent = t.title; $('sub').textContent = t.sub; say('');
    view().innerHTML = loading;
    t.run(n).catch((e) => paint(n, failBox(e)));
  }
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });

  // ---------- Состояние ----------
  async function renderState(n) {
    const [g, s, r, p] = await Promise.all([
      sb.from('groups').select('id', { count: 'exact', head: true }),
      sb.from('students').select('id', { count: 'exact', head: true }),
      sb.from('registration_requests').select('id', { count: 'exact', head: true }).eq('status', 'submitted'),
      sb.from('students').select('id', { count: 'exact', head: true }).eq('claim_status', 'pending'),
    ]);
    const bad = [g, s, r, p].find((x) => x.error);
    const v = (x) => (x.error || x.count == null ? '—' : x.count);
    const card = (label, x, amber) => '<div class="j2-card"><p>' + label + '</p><span class="big' + (amber && x.count > 0 ? ' amber' : '') + '">' + v(x) + '</span></div>';
    paint(n, (bad ? '<div class="j2-card bad"><h2>Часть счётчиков не загрузилась</h2><p>' + esc(errMsg(bad.error)) + '</p></div>' : '') +
      '<div class="sa-state-grid">' + card('Группы', g) + card('Студенты', s) + card('Заявки ждут решения', r, true) + card('Студенты ждут подтверждения', p, true) + '</div>' +
      '<div class="j2-card warn"><h2>Остальное позже</h2><p>Остальное (замеры, ошибки, импорт, бот, резервные копии) появится на этапе утилиты сисадмина.</p></div>');
  }

  // ---------- Логи ----------
  const ACTION = {
    registration_approve: 'Заявка одобрена', registration_reject: 'Заявка отклонена', membership_approve: 'Студент подтверждён', membership_reject: 'Студент отклонён',
    student_reset_binding: 'Сброс привязки', remind_headman: 'Напоминание старосте', consent_accept: 'Согласие принято', group_code_rotate: 'Новый код группы',
    set_group_role: 'Роль в группе', set_thresholds: 'Пороги пропусков', sysadmin_bootstrap: 'Сисадмин назначен',
  };
  const actionLabel = (a) => ACTION[a] || a;
  async function renderLogs(n) {
    let q = sb.from('audit_log').select('*').order('at', { ascending: false }).limit(50);
    if (st.logAction) q = q.eq('action', st.logAction);
    const { data, error } = await q;
    if (error) return paint(n, failBox(error));
    (data || []).forEach((r) => st.logActions.add(r.action));
    const opts = [...new Set([...Object.keys(ACTION), ...st.logActions])];
    const sel = '<label class="j2-field sa-field-sel"><span>Действие</span><select id="logFilter"><option value="">Все действия</option>' +
      opts.map((a) => '<option value="' + esc(a) + '"' + (a === st.logAction ? ' selected' : '') + '>' + esc(actionLabel(a)) + '</option>').join('') + '</select></label>';
    const rows = (data || []).map((r) => {
      const d = r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : '';
      return '<li class="sa-log"><div class="sa-head"><b>' + esc(actionLabel(r.action)) + '</b><span class="sub">' + esc(when(r.at)) + '</span></div>' +
        '<div class="sa-mono">кто: ' + esc(r.actor ? String(r.actor).slice(0, 8) : 'система') + (d ? ' · ' + esc(d.length > 160 ? d.slice(0, 160) + '…' : d) : '') + '</div></li>';
    }).join('');
    paint(n, sel + '<div class="j2-card">' + (rows ? '<ul class="j2-list">' + rows + '</ul>' : '<p>Записей нет.</p>') + '</div>' +
      '<p class="sa-note">Показано записей: ' + (data || []).length + '. «Кто» — первые символы идентификатора пользователя.</p>');
  }

  // ---------- Роли ----------
  async function renderRoles(n) {
    const sub = (id, label) => '<button type="button" role="tab" id="rs-' + id + '" data-sub="' + id + '" aria-selected="' + (st.roleSub === id) + '">' + label + '</button>';
    paint(n, '<div class="j2-tabs" role="tablist" aria-label="Раздел ролей">' + sub('req', 'Заявки') + sub('grp', 'Роли групп') + '</div><div id="rolesBody" role="tabpanel">' + loading + '</div>');
    $('sub').textContent = st.roleSub === 'req' ? 'Заявки новых старост' : 'Старосты и заместители в группах';
    await (st.roleSub === 'req' ? loadReqs(n) : loadMembers(n));
  }

  async function loadReqs(n) {
    const { data, error } = await sb.from('registration_requests').select('*').eq('status', 'submitted').order('submitted_at');
    if (stale(n)) return;
    if (error) return paint(n, failBox(error), $('rolesBody'));
    st.reqs = data || []; paintReqs(n);
  }
  function codeCard() {
    const c = st.code; if (!c) return '';
    return '<section class="j2-card warn" id="codeCard" tabindex="-1" aria-labelledby="codeTitle"><h2 id="codeTitle">Группа «' + esc(c.name) + '» создана</h2>' +
      '<p>Код группы</p><span class="j2-code" id="codeVal">' + esc(fmtCode(c.code)) + '</span>' +
      '<p><b>Код показывается один раз.</b> Передайте его старосте или нажмите «Показать код» в её заявке.</p>' +
      '<div class="sa-actions"><button type="button" class="j2-btn" data-act="code-copy">Скопировать</button><button type="button" class="j2-btn primary" data-act="code-done">Готово</button></div></section>';
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
    const list = st.reqs.filter((r) => !st.code || r.id !== st.code.reqId);
    $('sub').textContent = list.length ? 'Заявки новых старост: ' + list.length : 'Новых заявок нет';
    paint(n == null ? st.nav : n, codeCard() + (list.length ? list.map(reqCard).join('') : (st.code ? '' : '<div class="j2-card"><h2>Новых заявок нет</h2><p>Когда староста отправит заявку, она появится здесь.</p></div>')), $('rolesBody'));
    if (st.code && $('codeCard')) $('codeCard').focus();
  }

  const ROLE_LBL = { headman: 'староста', deputy: 'заместитель' };
  const BASE_LBL = { student: 'студент', teacher_lecture: 'преподаватель (лекции)', teacher_practice: 'преподаватель (практика)' };
  const STATUS_LBL = { pending: 'ждёт подтверждения', active: 'действует', rejected: 'отклонён', removed: 'убран из группы' };
  async function loadMembers(n) {
    const g = await sb.from('groups').select('*').order('created_at');
    if (stale(n)) return;
    if (g.error) return paint(n, failBox(g.error), $('rolesBody'));
    st.groups = g.data || [];
    if (!st.groups.length) return paint(n, '<div class="j2-card"><p>Групп пока нет.</p></div>', $('rolesBody'));
    if (!st.groups.some((x) => x.id === st.roleGroup)) st.roleGroup = st.groups[0].id;
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
    const sel = '<label class="j2-field sa-field-sel"><span>Группа</span><select id="roleGroup">' +
      st.groups.map((x) => '<option value="' + esc(x.id) + '"' + (x.id === gid ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></label>';
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
    paint(n, sel + '<div id="rcBox"></div><div class="j2-card"><h2>Участники</h2>' + (items ? '<ul class="j2-list">' + items + '</ul>' : '<p>В группе пока никого нет.</p>') + '</div>' +
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

  // ---------- Группы ----------
  async function renderGroups(n) {
    const g = await sb.from('groups').select('*').order('created_at');
    if (g.error) return paint(n, failBox(g.error));
    const list = g.data || [];
    const counts = await Promise.all(list.map((x) => sb.from('students').select('id', { count: 'exact', head: true }).eq('group_id', x.id)));
    if (stale(n)) return;
    const STAT = { active: ['действует', 'ok'], closed: ['закрыта', 'off'], graduated: ['выпустилась', 'off'] };
    $('sub').textContent = list.length ? 'Всего групп: ' + list.length : 'Групп пока нет';
    paint(n, (list.map((x, i) => {
      const s = STAT[x.status] || [x.status || 'неизвестно', 'off'], c = counts[i];
      return '<article class="j2-card" data-group="' + esc(x.id) + '"><div class="sa-head"><h2>' + esc(x.name) + '</h2><span class="sa-pill ' + s[1] + '">' + esc(s[0]) + '</span></div>' +
        '<p class="sa-card-p">' + esc([x.faculty, x.course ? x.course + ' курс' : '', x.study_form].filter(Boolean).join(', ')) + '</p>' +
        '<p class="sa-card-p">Студентов: ' + (c.error ? '—' : c.count) + '. Пороги пропусков: предупреждение ' + esc(x.warn_hours) + ' ч, деканат ' + esc(x.dean_hours) + ' ч.</p>' +
        '<div class="sa-thr"><label class="j2-field"><span>Предупр., ч</span><input type="number" min="1" step="1" inputmode="numeric" data-f="warn" value="' + esc(x.warn_hours) + '"></label>' +
        '<label class="j2-field"><span>Деканат, ч</span><input type="number" min="1" step="1" inputmode="numeric" data-f="dean" value="' + esc(x.dean_hours) + '"></label>' +
        '<button type="button" class="j2-btn small primary" data-act="thr-save">Сохранить</button></div></article>';
    }).join('') || '<div class="j2-card"><p>Групп пока нет. Новая группа появляется после одобрения заявки старосты.</p></div>'));
  }

  // ---------- действия (делегирование) ----------
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.tagName === 'DETAILS' && d.dataset.id) { if (d.open) st.open.add(d.dataset.id); else st.open.delete(d.dataset.id); } }, true);
  view().addEventListener('change', (e) => {
    if (e.target.id === 'logFilter') { st.logAction = e.target.value; go('logs'); }
    if (e.target.id === 'roleGroup') { st.roleGroup = e.target.value; st.rc = null; const n = ++st.nav; $('rolesBody').innerHTML = loading; loadMembers(n); }
  });
  view().addEventListener('click', (e) => {
    const sb2 = e.target.closest('[data-sub]');
    if (sb2) { st.roleSub = sb2.dataset.sub; st.rc = null; say(''); const n = ++st.nav; renderRoles(n).catch((x) => paint(n, failBox(x))); return; }
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const card = btn.closest('article, section'), id = card && card.dataset.id;
    const a = btn.dataset.act;
    if (a === 'approve') return approve(btn, card, id);
    if (a === 'rej-open') { const p = card.querySelector('.sa-reject'); p.hidden = !p.hidden; btn.setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) p.querySelector('textarea').focus(); return; }
    if (a === 'rej-cancel') { const p = card.querySelector('.sa-reject'); p.hidden = true; const o = card.querySelector('[data-act="rej-open"]'); o.setAttribute('aria-expanded', 'false'); o.focus(); return; }
    if (a === 'rej-send') return reject(btn, card, id);
    if (a === 'code-copy') return copyCode();
    if (a === 'code-done') { st.code = null; say(''); const n = ++st.nav; loadReqs(n); return; }
    if (a === 'rc-ask') {
      const m = (st.members || []).find((x) => x.user_id === btn.dataset.user);
      st.rc = { group: st.roleGroup, user: btn.dataset.user, role: btn.dataset.role, name: (m && m.name) || 'этот участник' }; say(''); paintRc(); return;
    }
    if (a === 'rc-no') { st.rc = null; paintRc(); return; }
    if (a === 'rc-yes') return roleChange(btn, card);
    if (a === 'thr-save') return saveThr(btn, card);
  });

  function approve(btn, card, id) {
    const g = (st.reqs.find((r) => r.id === id) || {}).payload;
    const name = (g && g.group && (g.group.group_name || g.group.name || g.group.group_no)) || 'новая';
    return act(btn, card, async () => {
      say('Одобряем…');
      const { data, error } = await sb.rpc('sysadmin_approve_registration', { p_request: id });
      if (error) { say(errMsg(error), 'err'); if (/already_approved|not_submitted/.test(error.message || '')) loadReqs(++st.nav); return; }
      J2.fn('notify-registration', { kind: 'decided', request_id: id });   // староста узнаёт решение (без кода)
      st.code = { reqId: id, code: data && data.code, groupId: data && data.group_id, name };
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
  async function copyCode() {
    const raw = st.code && st.code.code; if (!raw) return;
    try { await navigator.clipboard.writeText(raw); say('Код скопирован.', 'ok'); }
    catch (e) {
      const r = document.createRange(); r.selectNodeContents($('codeVal')); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      say('Код выделен. Скопируйте его вручную.');
    }
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
  function saveThr(btn, card) {
    const gid = card.dataset.group, w = card.querySelector('[data-f="warn"]').value.trim(), d = card.querySelector('[data-f="dean"]').value.trim();
    const warn = Number(w), dean = Number(d);
    if (!/^\d+$/.test(w) || !/^\d+$/.test(d) || warn < 1 || dean < warn) { say(ERR.bad_thresholds, 'err'); return; }
    return act(btn, card, async () => {
      say('Сохраняем…');
      const { error } = await sb.rpc('sysadmin_set_thresholds', { p_group: gid, p_warn: warn, p_dean: dean });
      if (error) { say(errMsg(error), 'err'); return; }
      say('Пороги сохранены: предупреждение ' + warn + ' ч, деканат ' + dean + ' ч.', 'ok');
      const g = st.groups.find((x) => x.id === gid); if (g) { g.warn_hours = warn; g.dean_hours = dean; }
      const p = card.querySelectorAll('.sa-card-p')[1]; if (p) p.textContent = p.textContent.replace(/Пороги пропусков:.*$/, 'Пороги пропусков: предупреждение ' + warn + ' ч, деканат ' + dean + ' ч.');
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
