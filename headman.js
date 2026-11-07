// «Журнал 2.0», этап 2: кабинет старосты и заместителя (headman.html). Оболочка и роутер живут в cab-core.js.
// Здесь только экраны: Сводка (+ заявки, отчёт для деканата), Журнал (пропуски, справки, история), Задания, Чат (экран чата рисует chat-ui.js).
// Права проверяет сервер (RLS и RPC): страница лишь прячет кнопки, которые всё равно не сработают.
'use strict';
(function () {
  const { h, str, q, rpc, toast, plural, num, icon } = Cab;
  const sb = Cab.sb;
  const $ = (r, s) => r.querySelector(s);
  const $$ = (r, s) => [...r.querySelectorAll(s)];
  const put = (el, html) => { el.innerHTML = str(html); };
  const day0 = () => Cab.minsk().iso;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const sum = (a, f) => a.reduce((n, x) => n + (Number(f(x)) || 0), 0);
  const byName = (a, b) => (a.last_name || '').localeCompare(b.last_name || '', 'ru') || (a.first_name || '').localeCompare(b.first_name || '', 'ru');
  const roleText = (ctx) => (ctx.role === 'deputy' ? 'Заместитель старосты' : 'Староста') + ', ' + ctx.group.name;
  const dateRight = () => { const m = Cab.minsk(); return `${Cab.DOW_S[m.dow]}, ${m.d} ${Cab.MONTHS[m.m]}`; };
  const head = (back, right, title, sub) => h`${Cab.top(back, right)}<h1 class="cab-title">${title}</h1>${sub ? h`<p class="cab-sub">${sub}</p>` : ''}`;
  const closedNote = (ctx) => (ctx.closed ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт: только просмотр</h2></div>` : '');
  const HRS = ['час', 'часа', 'часов'];
  // «5 ноября», «3–4 ноября», «30 окт – 2 нояб»
  const period = (a, b) => {
    if (!a || a === b || !b) return Cab.dateText(a || b);
    const [, m1, d1] = a.split('-').map(Number), [, m2, d2] = b.split('-').map(Number);
    return m1 === m2 ? `${d1}–${d2} ${Cab.MONTHS[m2 - 1]}` : `${Cab.dateShort(a)} – ${Cab.dateShort(b)}`;
  };
  // Ошибка запроса человеческим языком; «уже обработано» узнаём по коду из RPC
  const ERR = { already_received: 'Справка уже отмечена как полученная.', bad_absence: 'Список пропусков изменился: обновите страницу.', bad_dates: 'Проверьте даты справки.', bad_kind: 'Проверьте вид справки.' };
  const errText = (e) => ERR[e && e.rpc] || (e && /^(not_pending|no_student)$/.test(e.rpc || '') ? J2.errText(e.rpc) : Cab.rpcText(e));
  // Кнопка «идёт запрос»: защита от двойного нажатия + человеческая ошибка
  const act = (btn, fn) => J2.busy(btn, async () => { try { return await fn(); } catch (e) { console.error('[headman]', e); toast(errText(e), 'err'); } });
  // Постранично: PostgREST отдаёт не больше 1000 строк за раз
  async function fetchAll(mk) {
    const out = [];
    for (let i = 0; ; i += 1000) { const r = await q(mk().range(i, i + 999)); out.push(...r); if (r.length < 1000) return out; }
  }
  const semEndNote = (end) => {            // сколько дней до закрытия семестра, если ≤ 14
    if (!end) return null;
    const n = Cab.dayDiff(day0(), end);
    return n >= 0 && n <= 14 ? n : null;
  };

  // Состояние живёт, пока открыта страница: выбор пары, часы, фильтр заданий, период отчёта
  const S = { sel: null, hours: 2, other: { subject: '', kind: 'lecture', date: null }, marks: new Set(), taskFilter: 'all', rep: { mode: 'month', month: null } };

  // ---------- нижний лист и подтверждение ----------
  let opened = null;
  function closeSheet() {
    if (!opened) return;
    const s = opened; opened = null;
    document.removeEventListener('keydown', s.onKey); s.el.remove();
    document.getElementById('cab').inert = false;
    if (s.prev && s.prev.isConnected) s.prev.focus();
  }
  // Лист закрывает страницу под собой для клавиатуры и диктора (inert); Esc и тап по фону = «Отмена»
  function sheet(title, body, onDismiss) {
    closeSheet();
    const el = document.createElement('div');
    el.className = 'cab-modal';
    el.innerHTML = str(h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="hmSheetT"><h2 class="hm-sheet-h" id="hmSheetT" tabindex="-1">${title}</h2>${body}</div>`);
    const dismiss = () => { if (onDismiss) onDismiss(); closeSheet(); };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    el.addEventListener('mousedown', (e) => { if (e.target === el) dismiss(); });
    document.addEventListener('keydown', onKey);
    opened = { el, onKey, prev: document.activeElement };
    document.getElementById('cab').inert = true;
    document.body.appendChild(el);
    $(el, '#hmSheetT').focus();
    return { el, close: closeSheet };
  }
  window.addEventListener('hashchange', closeSheet);
  function confirmSheet(title, text, okText) {
    return new Promise((res) => {
      let done = false;
      const fin = (v) => { if (done) return; done = true; closeSheet(); res(v); };
      const s = sheet(title, h`<p class="cab-note">${text}</p><button class="j2-btn danger" data-a="ok" type="button">${okText}</button><button class="j2-btn" data-a="no" type="button">Отмена</button>`, () => fin(false));
      s.el.addEventListener('click', (e) => { const b = e.target.closest('button[data-a]'); if (b) fin(b.dataset.a === 'ok'); });
    });
  }

  // =====================================================================================================
  // Сводка
  // =====================================================================================================
  async function summary(el, ctx, params, nav) {
    const gid = ctx.group.id, t = Cab.minsk(), day = t.iso;
    const [pend, lessons, abs, certs, tasks, meta, chatNew, delRows] = await Promise.all([
      q(sb.from('students').select('id').eq('group_id', gid).eq('claim_status', 'pending')),
      q(sb.from('schedule_lessons').select('pair_no, starts_at, ends_at, subject, kind').eq('group_id', gid).eq('lesson_date', day).order('pair_no')),
      q(sb.from('absences').select('subject').eq('group_id', gid).eq('date', day)),
      q(sb.from('certificates').select('id, due_date').eq('group_id', gid).eq('status', 'waiting').order('due_date')),
      q(sb.from('tasks').select('id, kind, rec, created_by').eq('group_id', gid)),
      q(sb.from('schedule_meta').select('semester_end, last_import_at, last_status').eq('group_id', gid).maybeSingle()),
      // сбой запроса чата не мешает сводке: тогда просто «Зашифрован»
      window.ChatUI ? ChatUI.unreadTotal(sb).catch(() => 0) : 0,
      rpc('data_deletion_requests_list', { p_group: gid }).catch(() => []),      // сбой не мешает сводке
    ]);
    if (!nav.isCurrent()) return;
    const delN = (delRows || []).filter((r) => r.status === 'pending' && r.can_resolve).length;
    const now = lessons.find((l) => Cab.toMin(l.starts_at) <= t.minutes && t.minutes < Cab.toMin(l.ends_at));
    const next = lessons.find((l) => Cab.toMin(l.starts_at) > t.minutes);
    const marked = now ? abs.filter((a) => norm(a.subject) === norm(now.subject)).length : 0;
    const active = tasks.map(Cab.task).filter((x) => !x.due || x.due >= day);
    const mine = active.filter((x) => !x.createdBy || x.createdBy === ctx.uid).length;
    const left = semEndNote(meta && meta.semester_end);
    const lessonCard = now
      ? h`<a class="cab-row t-lime" href="#/journal"><span><small>Сейчас идёт ${Cab.kindLow(now.kind)}</small><b>${ctx.closed ? 'Пропуски' : 'Отметить пропуски'}</b><small>${now.subject}, ${Cab.hm(now.starts_at)}–${Cab.hm(now.ends_at)}</small></span><span class="hm-count"><b>${marked}</b><small>отмечено</small></span></a>`
      : h`<a class="cab-row" href="#/journal"><span><b>Пар сейчас нет</b><small>${next ? `Дальше: ${next.subject}, ${Cab.hm(next.starts_at)}` : 'Пропуски можно отметить за любое занятие'}</small></span><span class="cab-ico">${icon.chev}</span></a>`;
    put(el, h`${Cab.top({ href: 'app.html', text: 'Кабинет студента' }, roleText(ctx))}
      <h1 class="cab-title">Кабинет старосты</h1><p class="cab-sub">${Cab.DOW[t.dow]}, ${t.d} ${Cab.MONTHS[t.m]}</p>
      ${Cab.raw(J2.roleSwitch('staff', { student: true, staff: true, sysadmin: ctx.isSysadmin }))}
      ${closedNote(ctx)}
      ${Cab.installCard()}
      ${delN ? h`<a class="cab-row t-amber" href="#/summary/erasure"><b>${delN} ${plural(delN, ['просьба удалить данные', 'просьбы удалить данные', 'просьб удалить данные'])}</b><span class="cab-ico">${icon.chev}</span></a>` : ''}
      ${pend.length ? h`<a class="cab-row t-amber" href="#/summary/requests"><b>${pend.length} ${plural(pend.length, ['студент ждёт', 'студента ждут', 'студентов ждут'])} подтверждения</b><span class="cab-ico">${icon.chev}</span></a>` : ''}
      ${pend.length ? '' : h`<a class="cab-row" href="#/summary/requests"><span><b>Студенты</b><small>Заявки, код группы, сброс пароля</small></span><span class="cab-ico">${icon.chev}</span></a>`}
      ${lessonCard}
      <div class="cab-tiles two">
        <a class="cab-tile t-amber" href="#/journal/certs"><b>Справки</b><span class="big">${certs.length}</span><small>${certs.length ? `ждём${certs[0].due_date ? ', срок до ' + Cab.dateText(certs[0].due_date) : ''}` : 'никто не ждёт'}</small></a>
        <a class="cab-tile t-mint" href="#/tasks"><b class="hm-tt">Задания<span class="cab-ico sm">${icon.plus}</span></b><span class="big">${active.length}</span><small>активных, ваших ${mine}</small></a>
      </div>
      <a class="cab-row t-violet" href="#/chat" style="margin-top:10px"><span><b>Чат с преподавателями</b><small class="ch-sub"><span class="cab-ico sm">${icon.lock}</span>Зашифрован</small></span>${chatNew > 0 ? h`<span class="ch-new">${chatNew} ${plural(chatNew, ['новое', 'новых', 'новых'])}</span>` : ''}</a>
      <a class="cab-row" href="#/summary/report"><span><b>Отчёт для деканата</b><small>Пропуски и справки, выгрузка в Excel</small></span><span class="cab-ico">${icon.chev}</span></a>
      ${ctx.closed ? '' : h`<div class="cab-card"><h3>Расписание</h3><p>${meta && meta.last_import_at ? 'Обновлено с bseu.by ' + Cab.dateText(Cab.minsk(Date.parse(meta.last_import_at)).iso) + (meta.last_status && meta.last_status !== 'ok' ? '. Последняя попытка не удалась.' : '.') : 'Расписание ещё не загружено.'}</p><div class="cab-actions"><button type="button" class="j2-btn" id="hmSched">Обновить с bseu.by</button></div></div>`}
      ${left == null ? '' : h`<p class="cab-note c-amber">${left === 0 ? 'Сегодня журнал закроется до следующего семестра.' : `Через ${left} ${plural(left, ['день', 'дня', 'дней'])} журнал закроется до следующего семестра.`}</p>`}`);
    Cab.bindInstall(el);
    const sb2 = $(el, '#hmSched');
    if (sb2) sb2.onclick = () => act(sb2, async () => {
      const r = await J2.fn('schedule-import', { group_id: gid });
      const d = r.data || {};
      if (r.ok && d.ok) toast(`Расписание обновлено: добавлено ${d.added}, изменено ${d.changed}, убрано ${d.removed}.`, 'ok');
      else toast(d.error === 'too_soon' ? 'Обновляли недавно. Повторите через 10 минут.' : d.error === 'bseu_unavailable' ? 'Сайт bseu.by не отвечает. Повторите позже.' : 'Не удалось обновить расписание. Прежнее осталось.', 'err');
      Cab.rerender();
    });
  }

  // =====================================================================================================
  // Просьбы удалить данные (ТЗ, раздел 5): решение необратимо, поэтому второй шаг подтверждения
  // =====================================================================================================
  async function erasure(el, ctx, params, nav) {
    const rows = await rpc('data_deletion_requests_list', { p_group: ctx.group.id });
    if (!nav.isCurrent()) return;
    const pend = rows.filter((r) => r.status === 'pending');
    const card = (r) => h`<article class="cab-card amber" data-id="${r.id}"><h3>${r.student_name}</h3><p>${r.requester_role === 'student' ? 'Студент' : 'Староста или заместитель'} просит удалить свои данные. Подана ${Cab.dateText(Cab.minsk(Date.parse(r.created_at)).iso)}.</p>
      ${r.can_resolve && !ctx.closed ? h`<div class="cab-actions" data-s="a"><button type="button" class="j2-btn primary" data-a="ask" aria-label="Удалить данные: ${r.student_name}">Удалить данные</button><button type="button" class="j2-btn" data-a="no" aria-label="Отклонить: ${r.student_name}">Отклонить</button></div>
      <div class="cab-actions j2-hidden" data-s="b"><p>Данные студента удалятся навсегда, аккаунт будет закрыт. Пропуски и оценки останутся без имени.</p><button type="button" class="j2-btn danger" data-a="ok">Да, удалить навсегда</button><button type="button" class="j2-btn" data-a="back">Назад</button></div>`
      : h`<p class="cab-note">Решит системный администратор.</p>`}</article>`;
    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, roleText(ctx), 'Удаление данных', pend.length ? `${pend.length} ${plural(pend.length, ['просьба', 'просьбы', 'просьб'])}` : 'Новых просьб нет')}
      ${closedNote(ctx)}
      ${pend.length ? pend.map(card) : h`<div class="cab-card"><h3>Просьб нет</h3><p>Студент может попросить удалить свои данные в профиле. Вы увидите просьбу здесь.</p></div>`}
      <p class="cab-note">Отклонить можно без объяснений: студент увидит, что заявку отклонили.</p>`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const c = b.closest('article'), a = b.dataset.a;
      if (a === 'ask' || a === 'back') {
        $(c, '[data-s="a"]').classList.toggle('j2-hidden', a === 'ask'); $(c, '[data-s="b"]').classList.toggle('j2-hidden', a === 'back');
        $(c, a === 'ask' ? '[data-a="back"]' : '[data-a="ask"]').focus(); return;
      }
      act(b, async () => {
        $$(c, 'button').forEach((x) => { x.disabled = true; });
        try { await rpc('resolve_data_deletion', { p_request: c.dataset.id, p_approve: a === 'ok', p_note: null }); toast(a === 'ok' ? 'Данные удалены.' : 'Просьба отклонена.', 'ok'); }
        finally { Cab.rerender(); }
      });
    };
  }

  // =====================================================================================================
  // Заявки студентов
  // =====================================================================================================
  async function requests(el, ctx, params, nav) {
    const gid = ctx.group.id;
    const [stu, ms] = await Promise.all([
      q(sb.from('students').select('id, last_name, first_name, claim_status, sort').eq('group_id', gid).order('sort')),
      q(sb.from('memberships').select('student_id, created_at').eq('group_id', gid).eq('status', 'pending')).catch(() => []),
    ]);
    if (!nav.isCurrent()) return;
    const at = new Map(ms.map((x) => [x.student_id, x.created_at]));
    const pend = stu.filter((s) => s.claim_status === 'pending');
    const act0 = stu.filter((s) => s.claim_status === 'active').length;
    const joined = (iso) => {
      if (!iso) return 'Вход по коду группы';
      const m = Cab.minsk(Date.parse(iso)), d = Cab.dayDiff(m.iso, day0()), p = (n) => String(n).padStart(2, '0');
      return `Вход по коду группы ${d === 0 ? 'сегодня' : d === 1 ? 'вчера' : Cab.dateText(m.iso)} в ${p(m.hh)}:${p(m.mm)}`;
    };
    const card = (s) => h`<article class="cab-card amber" data-id="${s.id}"><h3>${Cab.fullName(s)}</h3><p>${joined(at.get(s.id))}</p>
      ${ctx.closed ? '' : h`<div class="cab-actions" data-s="a"><button type="button" class="j2-btn primary" data-a="ok" aria-label="Это он: ${Cab.fullName(s)}">Это он</button><button type="button" class="j2-btn" data-a="ask" aria-label="Не он: ${Cab.fullName(s)}">Не он</button></div>
      <div class="cab-actions j2-hidden" data-s="b"><p>Отклонить заявку? Студент сможет выбрать другую фамилию.</p><button type="button" class="j2-btn danger" data-a="no">Да, не он</button><button type="button" class="j2-btn" data-a="back">Отмена</button></div>`}</article>`;
    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, roleText(ctx), 'Заявки студентов', pend.length ? `${pend.length} ${plural(pend.length, ['ждёт', 'ждут', 'ждут'])} подтверждения` : 'Новых заявок нет')}
      ${closedNote(ctx)}
      ${pend.length ? pend.map(card) : h`<div class="cab-card"><h3>Заявок нет</h3><p>Когда студент войдёт по коду группы, он появится здесь.</p></div>`}
      <div class="cab-card"><div class="meta"><span><b>Подтверждены</b><p>вход открыт</p></span><span class="j2-num">${act0} из ${stu.length}</span></div></div>
      <p class="cab-note">Подтверждайте только тех, кого знаете. Пока вы не подтвердили, студент не видит данные группы.</p>
      ${ctx.closed ? '' : h`<div class="cab-card"><h3>Код группы</h3><p>Если код попал не туда, выпустите новый: старый перестанет работать.</p><div class="cab-actions"><button type="button" class="j2-btn" id="hmRot">Новый код группы</button></div></div>
      <div class="cab-card"><h3>Забыл пароль</h3><p>Выпустите студенту одноразовый код: на странице входа («Забыли пароль?») он сам задаст новый пароль. Код действует сутки.</p>
        <label class="j2-field"><span>Студент</span><select id="hmRsS"><option value="">Выберите студента</option>${stu.filter((s) => s.claim_status === 'active').map((s) => h`<option value="${s.id}">${Cab.fullName(s)}</option>`)}</select></label>
        <div class="cab-actions"><button type="button" class="j2-btn" id="hmRs">Выпустить код сброса</button></div></div>`}`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-a]'); if (!b) return;
      const c = b.closest('article'), a = b.dataset.a;
      if (a === 'ask' || a === 'back') {
        $(c, '[data-s="a"]').classList.toggle('j2-hidden', a === 'ask'); $(c, '[data-s="b"]').classList.toggle('j2-hidden', a === 'back');
        $(c, a === 'ask' ? '[data-a="back"]' : '[data-a="ask"]').focus(); return;
      }
      act(b, async () => {
        $$(c, 'button').forEach((x) => { x.disabled = true; });
        try { await rpc(a === 'ok' ? 'membership_approve' : 'membership_reject', { p_student_id: c.dataset.id }); toast(a === 'ok' ? 'Подтверждён.' : 'Заявка отклонена.', 'ok'); }
        finally { Cab.rerender(); }
      });
    };
    const rs = $(el, '#hmRs');
    if (rs) rs.onclick = () => act(rs, async () => {
      const sid = $(el, '#hmRsS').value;
      if (!sid) { toast('Выберите студента.'); return; }
      const r = await J2.fn('password-reset-issue', { student_id: sid });
      const d = r.data || {};
      if (!r.ok || !d.code) {
        const why = { self: 'Свой пароль меняется в настройках кабинета.', no_account: 'У студента нет действующего аккаунта.', forbidden_target: 'Для этого человека код выпускает системный администратор.', forbidden: 'Нет прав на этого студента.', maintenance: 'Ведутся технические работы.' };
        toast(why[d.error] || 'Не удалось выпустить код. Повторите позже.', 'err');
        return;
      }
      const s = sheet('Код сброса пароля', h`<p class="cab-note c-amber">Код виден только сейчас и действует сутки. Передайте его студенту лично: с ним можно сменить пароль.</p><div class="j2-code" role="status">${d.code}</div><button class="j2-btn primary" type="button" data-a="copy">Скопировать</button><button class="j2-btn" type="button" data-a="close">Готово</button>`);
      s.el.addEventListener('click', async (e) => {
        const x = e.target.closest('button[data-a]'); if (!x) return;
        if (x.dataset.a === 'close') { s.close(); return; }
        try { await navigator.clipboard.writeText(String(d.code)); toast('Код скопирован.', 'ok'); } catch (err) { toast('Выделите код и скопируйте вручную.'); }
      });
    });
    const rot = $(el, '#hmRot');
    if (rot) rot.onclick = () => act(rot, async () => {
      if (!(await confirmSheet('Новый код группы?', 'Старый код перестанет работать. Новый покажем один раз.', 'Выпустить новый код'))) return;
      const code = await rpc('group_code_rotate', { p_group: gid });
      const s = sheet('Новый код группы', h`<p class="cab-note c-amber">Код виден только сейчас. Запишите или скопируйте его.</p><div class="j2-code" role="status">${code}</div><button class="j2-btn primary" type="button" data-a="copy">Скопировать</button><button class="j2-btn" type="button" data-a="close">Готово</button>`);
      s.el.addEventListener('click', async (e) => {
        const x = e.target.closest('button[data-a]'); if (!x) return;
        if (x.dataset.a === 'close') { s.close(); return; }
        try { await navigator.clipboard.writeText(String(code)); toast('Код скопирован.', 'ok'); } catch (err) { toast('Выделите код и скопируйте вручную.'); }
      });
    });
  }

  // =====================================================================================================
  // Журнал: сегменты, пропуски
  // =====================================================================================================
  const jtabs = (el, v) => Cab.segmented(el, [{ value: 'journal', label: 'Пропуски' }, { value: 'journal/certs', label: 'Справки' }], v, (x) => { location.hash = '#/' + x; });

  function journal(el, ctx, params, nav) {
    return params[0] === 'cert' && params[1] ? certDetail(el, ctx, decodeURIComponent(params[1]), nav) : marks(el, ctx, nav);
  }

  async function marks(el, ctx, nav) {
    const gid = ctx.group.id, t = Cab.minsk(), day = t.iso, ro = ctx.closed;
    // Список группы и пары дня запоминаем на телефоне: без сети журнал открывается из памяти, отметки уходят в очередь (offline-queue.js)
    const ckey = 'j2.cache.marks.' + gid;
    let stu, lessons, offline = false;
    try {
      [stu, lessons] = await Promise.all([
        q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid).neq('claim_status', 'erased')),
        q(sb.from('schedule_lessons').select('pair_no, starts_at, ends_at, subject, kind, subgroup').eq('group_id', gid).eq('lesson_date', day).order('pair_no')),
      ]);
      try { localStorage.setItem(ckey, JSON.stringify({ day, stu, lessons })); } catch (_) { /* память переполнена */ }
    } catch (e) {
      let c = null; try { c = JSON.parse(localStorage.getItem(ckey)); } catch (_) { /* битый кэш */ }
      if (!window.OQ || !OQ.isNetError(e) || !c) throw e;
      stu = c.stu; lessons = c.day === day ? c.lessons : []; offline = true;
    }
    if (!nav.isCurrent()) return;
    stu.sort(byName);
    const opts = lessons.map((l) => ({ key: [l.pair_no, l.subject, l.kind, l.subgroup || 0].join('|'), subject: l.subject, kind: l.kind, sg: l.subgroup,
      now: Cab.toMin(l.starts_at) <= t.minutes && t.minutes < Cab.toMin(l.ends_at) }));
    if (!opts.some((o) => o.key === S.sel) && S.sel !== 'other') S.sel = (opts.find((o) => o.now) || opts[0] || { key: 'other' }).key;
    S.marks.clear();
    if (!S.other.date) S.other.date = day;
    const cur = () => (S.sel === 'other' ? { subject: S.other.subject.trim(), kind: S.other.kind, date: S.other.date || day } : { ...opts.find((o) => o.key === S.sel), date: day });
    const label = (o) => `${o.subject}, ${Cab.kindLow(o.kind)}, ${S.hours} ч${o.sg ? `, ${o.sg} подгр.` : ''}`;

    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, dateRight(), 'Журнал')}
      <div id="hmSeg"></div>
      ${closedNote(ctx)}
      ${offline ? h`<div class="j2-card warn" role="status"><h2>Нет связи</h2><p>Список группы взят из памяти телефона. Отметки сохранятся и отправятся сами, когда появится сеть.</p></div>` : ''}
      ${lessons.length ? '' : h`<div class="cab-card"><h3>Пар сегодня нет</h3><p>Можно отметить пропуски за другое занятие.</p></div>`}
      <label class="j2-field hm-pair"><span>Пара</span><select id="hmSel">${opts.map((o) => h`<option value="${o.key}">${label(o)}</option>`)}<option value="other">Другое занятие…</option></select></label>
      <div id="hmOther" class="j2-hidden">
        <label class="j2-field"><span>Предмет</span><input id="hmSubj" type="text" maxlength="120" autocomplete="off"></label>
        <div class="j2-row"><label class="j2-field"><span>Вид</span><select id="hmKind"><option value="lecture">Лекция</option><option value="practice">Практическое</option></select></label>
        <label class="j2-field"><span>Дата</span><input id="hmDate" type="date" max="${day}"></label></div>
      </div>
      ${ro ? '' : h`<div class="hm-step"><span id="hmHrsL">Часов за пару</span><div><button type="button" id="hmMinus" aria-label="Меньше часов" aria-describedby="hmHrsL">−</button><output id="hmHrs" aria-live="polite"></output><button type="button" id="hmPlus" aria-label="Больше часов" aria-describedby="hmHrsL">+</button></div></div>`}
      <div class="hm-bar"><span>${ro ? 'Кто отсутствовал' : 'Отметьте отсутствующих'}</span><span>${stu.length} ${plural(stu.length, ['человек', 'человека', 'человек'])}</span></div>
      <div class="cab-pick no-swipe" id="hmList"></div>
      ${ro ? '' : h`<button type="button" class="j2-btn primary" id="hmSave"></button><p class="cab-note">Отменить можно только свои записи. Записи преподавателя видны, но не меняются.</p>`}
      <a class="cab-row" href="#/journal/history"><span><b>История пропусков</b><small>Последние 30 дней, отмена своих записей</small></span><span class="cab-ico">${icon.chev}</span></a>`);
    jtabs($(el, '#hmSeg'), 'journal');
    const sel = $(el, '#hmSel'), other = $(el, '#hmOther'), list = $(el, '#hmList'), save = $(el, '#hmSave');
    sel.value = S.sel;
    $(el, '#hmSubj').value = S.other.subject; $(el, '#hmKind').value = S.other.kind; $(el, '#hmDate').value = S.other.date;
    other.classList.toggle('j2-hidden', S.sel !== 'other');

    let existing = new Map(), seq = 0;           // student_id → часы уже внесённого пропуска по выбранному предмету и дню
    const mine = () => { const c = cur(); return new Map(existing.get(norm(c.subject)) || []); };
    const hrsText = (b) => { b.lastChild.textContent = `Н, ${S.hours} ч`; };
    function sync() {
      const n = S.marks.size;
      if (save) { save.textContent = `Сохранить, отсутствуют ${n}`; save.disabled = n === 0; }
      const o = $(el, '#hmHrs'); if (o) o.textContent = `${S.hours} ч`;
      const mi = $(el, '#hmMinus'), pl = $(el, '#hmPlus'); if (mi) { mi.disabled = S.hours <= 1; pl.disabled = S.hours >= 4; }
      opts.forEach((x, i) => { sel.options[i].text = label(x); });
    }
    function paint() {
      const lk = mine();
      S.marks.forEach((id) => { if (lk.has(id)) S.marks.delete(id); });
      put(list, h`${stu.map((s) => { const lo = lk.has(s.id), on = lo || S.marks.has(s.id);
        return h`<div class="cab-stu ${on ? 'abs' : ''} ${lo ? 'locked' : ''}"><span><b>${Cab.initials(s)}</b>${lo ? h`<small class="hm-lock">уже внесено</small>` : ''}</span><button type="button" class="mark" data-id="${s.id}" aria-disabled="${lo || ro ? 'true' : 'false'}"><span class="sr-only">${Cab.initials(s)}: </span>${on ? `Н, ${num(lo ? lk.get(s.id) : S.hours)} ч` : 'был'}</button></div>`; })}`);
      sync();
    }
    async function loadExisting() {
      const my = ++seq, d = cur().date || day;
      let rows = [];
      try { rows = await q(sb.from('absences').select('student_id, subject, hours').eq('group_id', gid).eq('date', d)); }
      catch (e) { if (!window.OQ || !OQ.isNetError(e)) throw e; }      // без сети видим только то, что стоит в очереди
      if (my !== seq || !nav.isCurrent()) return;
      if (window.OQ) rows = rows.concat(OQ.list(ctx.uid).filter((x) => x.group_id === gid && x.date === d));   // отмеченное без сети тоже «уже внесено»
      existing = new Map();
      rows.forEach((a) => { const k = norm(a.subject); if (!existing.has(k)) existing.set(k, new Map()); existing.get(k).set(a.student_id, a.hours); });
      paint();
    }
    const later = (p) => p.catch((e) => toast(errText(e), 'err'));
    paint(); later(loadExisting());
    Cab.onFlushed = () => { if (nav.isCurrent()) later(loadExisting()); };       // очередь ушла: показать записи с сервера

    list.onclick = (e) => {
      const b = e.target.closest('button.mark'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
      const id = b.dataset.id;
      if (S.marks.has(id)) S.marks.delete(id); else S.marks.add(id);
      const on = S.marks.has(id);
      b.closest('.cab-stu').classList.toggle('abs', on);
      b.lastChild.textContent = on ? `Н, ${S.hours} ч` : 'был';
      sync();
    };
    sel.onchange = () => { S.sel = sel.value; S.marks.clear(); other.classList.toggle('j2-hidden', S.sel !== 'other'); paint(); later(loadExisting()); };
    $(el, '#hmSubj').oninput = (e) => { S.other.subject = e.target.value; paint(); };
    $(el, '#hmKind').onchange = (e) => { S.other.kind = e.target.value; };
    $(el, '#hmDate').onchange = (e) => { S.other.date = e.target.value || day; S.marks.clear(); paint(); later(loadExisting()); };
    const step = (d) => { S.hours = Math.max(1, Math.min(4, S.hours + d)); $$(list, '.cab-stu.abs:not(.locked) .mark').forEach(hrsText); sync(); };
    if (!ro) {
      $(el, '#hmMinus').onclick = () => step(-1); $(el, '#hmPlus').onclick = () => step(1);
      save.onclick = () => act(save, async () => {
        const c = cur(), d = c.date || day;
        if (!c.subject) { toast('Укажите предмет.', 'err'); return; }
        // id у каждой записи свой с самого начала: повторная отправка (обрыв, очередь) вставку не дублирует (ON CONFLICT DO NOTHING)
        const mk = (sid) => ({ id: OQ.newId(), group_id: gid, student_id: sid, date: d, subject: c.subject, hours: S.hours,
          lesson_kind: c.kind === 'lecture' || c.kind === 'practice' ? c.kind : null });
        const all = [...S.marks].map(mk);
        let n = 0, queued = false;
        try {
          // перед записью ещё раз смотрим, не внёс ли кто-то то же самое
          const fresh = await q(sb.from('absences').select('student_id, subject').eq('group_id', gid).eq('date', d));
          const have = new Set(fresh.filter((a) => norm(a.subject) === norm(c.subject)).map((a) => a.student_id));
          const todo = all.filter((r) => !have.has(r.student_id));
          if (todo.length) await q(sb.from('absences').upsert(todo.map((r) => ({ ...r, is_excused: false })), { onConflict: 'id', ignoreDuplicates: true }));
          n = todo.length;
        } catch (e) {
          if (!OQ.isNetError(e)) throw e;
          const lk = OQ.pending(ctx.uid, gid, d, c.subject);
          n = OQ.add(ctx.uid, all.filter((r) => !lk.has(r.student_id))); queued = true;
          Cab.netBar();
        }
        S.marks.clear();
        toast(queued ? `Нет связи. Сохранено на телефоне: ${n}. Отправится, когда появится сеть.`
          : n ? `Внесено: ${n} ${plural(n, ['пропуск', 'пропуска', 'пропусков'])}.` : 'Эти пропуски уже внесены.', 'ok');
        await loadExisting();
      }).then(sync);
    }
  }

  // ---------- история ----------
  async function history(el, ctx, params, nav) {
    const gid = ctx.group.id, from = Cab.addDays(day0(), -30);
    const [rows, stu] = await Promise.all([
      q(sb.from('absences').select('id, student_id, date, subject, hours, is_excused, created_by').eq('group_id', gid).gte('date', from).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(500)),
      q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid)),
    ]);
    if (!nav.isCurrent()) return;
    const name = new Map(stu.map((s) => [s.id, s]));
    const own = (a) => !a.created_by || a.created_by === ctx.uid;                 // свои и легаси; запись преподавателя не меняется
    const who = (a) => (a.created_by === ctx.uid ? 'вы' : a.created_by ? 'преподаватель' : 'староста');
    const days = [...new Set(rows.map((a) => a.date))];
    put(el, h`${head({ href: '#/journal', text: 'Журнал' }, dateRight(), 'История пропусков', 'Последние 30 дней')}
      ${closedNote(ctx)}
      ${rows.length ? days.map((d) => h`<h2 class="cab-h2">${Cab.dateText(d)}, ${Cab.DOW_S[Cab.dowOf(d)].toLowerCase()}</h2>${rows.filter((a) => a.date === d).map((a) => h`<div class="cab-card" data-id="${a.id}"><div class="meta"><b>${Cab.initials(name.get(a.student_id) || {})}</b><span class="st">${num(a.hours)} ч</span></div><p>${a.subject || 'Без предмета'}${a.is_excused ? ', уважительный' : ''}, внёс: ${who(a)}</p>${own(a) && !ctx.closed ? h`<div class="cab-actions"><button type="button" class="j2-btn small danger" data-id="${a.id}" aria-label="Отменить пропуск: ${Cab.initials(name.get(a.student_id) || {})}, ${a.subject || ''}">Отменить</button></div>` : ''}</div>`)}`)
        : h`<p class="cab-empty">За 30 дней пропусков нет.</p>`}
      <p class="cab-note">Отменить можно только свои записи. Записи преподавателя видны, но не меняются.</p>`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      const a = rows.find((x) => x.id === b.dataset.id);
      act(b, async () => {
        if (!(await confirmSheet('Отменить пропуск?', `${Cab.initials(name.get(a.student_id) || {})}, ${a.subject || 'без предмета'}, ${Cab.dateText(a.date)}, ${num(a.hours)} ч.`, 'Отменить пропуск'))) return;
        const del = await q(sb.from('absences').delete().eq('id', a.id).select('id'));
        toast(del.length ? 'Пропуск отменён.' : 'Не получилось отменить: запись уже изменена.', del.length ? 'ok' : 'err');
        Cab.rerender();
      });
    };
  }

  // =====================================================================================================
  // Журнал: справки
  // =====================================================================================================
  const KIND = { sick: 'больничный', statement: 'заявление', other: 'другое' };
  const dueWords = (iso) => { const d = Cab.due(iso); return d.days < 0 ? 'просрочен' : d.days <= 1 ? d.text : 'через ' + d.text; };

  async function certs(el, ctx, params, nav) {
    const gid = ctx.group.id;
    const [cs, stu] = await Promise.all([
      q(sb.from('certificates').select('id, student_id, kind, date_from, date_to, due_date, status, received_at').eq('group_id', gid).order('due_date')),
      q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid)),
    ]);
    if (!nav.isCurrent()) return;
    stu.sort(byName);
    const name = new Map(stu.map((s) => [s.id, s]));
    const wait = cs.filter((c) => c.status === 'waiting');
    const done = cs.filter((c) => c.status !== 'waiting').sort((a, b) => String(b.received_at || b.date_to).localeCompare(String(a.received_at || a.date_to))).slice(0, 10);
    const shown = [...wait, ...done];
    let ab = [];
    if (shown.length) {            // часы справки: неуважительные пропуски периода, у полученной — закрытые ею
      const f = shown.map((c) => c.date_from).filter(Boolean).sort()[0], t = shown.map((c) => c.date_to).filter(Boolean).sort().pop();
      if (f && t) ab = await q(sb.from('absences').select('student_id, date, hours, is_excused, certificate_id').eq('group_id', gid).gte('date', f).lte('date', t));
      if (!nav.isCurrent()) return;
    }
    const hours = (c) => sum(ab.filter((a) => (c.status === 'received' ? a.certificate_id === c.id
      : a.student_id === c.student_id && !a.is_excused && a.date >= c.date_from && a.date <= c.date_to)), (a) => a.hours);
    const nm = (c) => Cab.initials(name.get(c.student_id) || {});
    const wcard = (c) => { const d = Cab.due(c.due_date); return h`<article class="cab-card"><div class="meta"><h3>${nm(c)}</h3><span class="st c-${d.cls}">${d.text}</span></div>
      <p>${period(c.date_from, c.date_to)}, ${num(hours(c))} ч${c.due_date ? ', срок до ' + Cab.dateText(c.due_date) : ''}</p>
      ${ctx.closed ? '' : h`<div class="cab-actions"><a class="j2-btn primary" href="${'#/journal/cert/' + encodeURIComponent(c.id)}" aria-label="Справка получена: ${nm(c)}">Справка получена</a><button type="button" class="j2-btn" data-no="${c.id}" aria-label="Нет справки: ${nm(c)}">Нет справки</button></div>`}</article>`; };
    const dcard = (c) => h`<article class="cab-card"><div class="meta"><h3>${nm(c)}</h3><span class="st ${c.status === 'received' ? 'c-lime' : 'c-coral'}">${c.status === 'received' ? 'получена' : 'не сдана'}</span></div><p>${period(c.date_from, c.date_to)}, ${num(hours(c))} ч, ${KIND[c.kind] || 'справка'}</p></article>`;
    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, dateRight(), 'Журнал')}
      <div id="hmSeg"></div>
      ${closedNote(ctx)}
      ${wait.length ? h`<div class="j2-card warn"><h2>Ждём ${wait.length} ${plural(wait.length, ['справку', 'справки', 'справок'])}</h2><p>Ближайший срок: ${wait[0].due_date ? dueWords(wait[0].due_date) : 'не указан'}</p></div>` : ''}
      ${ctx.closed ? '' : h`<button type="button" class="j2-btn" id="hmNew"><span class="cab-ico sm">${icon.plus}</span>Новая справка</button>`}
      ${cs.length ? '' : h`<p class="cab-empty">Нет справок</p>`}
      ${wait.map(wcard)}
      ${done.length ? h`<h2 class="cab-h2">Закрытые</h2>${done.map(dcard)}` : ''}`);
    jtabs($(el, '#hmSeg'), 'journal/certs');
    const nb = $(el, '#hmNew');
    if (nb) nb.onclick = () => newCert(ctx, stu);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-no]'); if (!b) return;
      act(b, async () => {
        const c = wait.find((x) => x.id === b.dataset.no);
        if (!(await confirmSheet('Справки нет?', `${nm(c)}: пропуски ${period(c.date_from, c.date_to)} останутся неуважительными.`, 'Да, справки нет'))) return;
        await rpc('certificate_resolve', { p_certificate: c.id, p_status: 'none', p_absence_ids: [] });
        toast('Отмечено: справки нет.', 'ok'); Cab.rerender();
      });
    };
  }

  function newCert(ctx, stu) {
    const day = day0();
    const s = sheet('Новая справка', h`<label class="j2-field"><span>Студент</span><select id="ncS"><option value="">Выберите студента</option>${stu.map((x) => h`<option value="${x.id}">${Cab.initials(x)}</option>`)}</select></label>
      <label class="j2-field"><span>Вид</span><select id="ncK"><option value="sick">Больничный</option><option value="statement">Заявление</option><option value="other">Другое</option></select></label>
      <div class="j2-row"><label class="j2-field"><span>С</span><input id="ncF" type="date" value="${day}"></label><label class="j2-field"><span>По</span><input id="ncT" type="date" value="${day}"></label></div>
      <label class="j2-field"><span>Срок сдачи</span><input id="ncD" type="date" value="${Cab.addDays(day, 3)}"></label>
      <label class="j2-field"><span>Заметка</span><textarea id="ncN" maxlength="300" rows="2"></textarea></label>
      <div class="j2-msg err" id="ncM" role="alert"></div>
      <button class="j2-btn primary" type="button" id="ncOk">Добавить справку</button><button class="j2-btn" type="button" id="ncNo">Отмена</button>`);
    const v = (id) => $(s.el, id).value;
    let dueSet = false;
    $(s.el, '#ncD').oninput = () => { dueSet = true; };
    $(s.el, '#ncF').onchange = () => { if (v('#ncT') < v('#ncF')) $(s.el, '#ncT').value = v('#ncF'); $(s.el, '#ncT').onchange(); };
    $(s.el, '#ncT').onchange = () => { if (!dueSet && v('#ncT')) $(s.el, '#ncD').value = Cab.addDays(v('#ncT'), 3); };
    $(s.el, '#ncNo').onclick = s.close;
    const ok = $(s.el, '#ncOk');
    ok.onclick = () => act(ok, async () => {
      const m = $(s.el, '#ncM'); m.textContent = '';
      if (!v('#ncS')) { m.textContent = 'Выберите студента.'; return; }
      if (!v('#ncF') || !v('#ncT') || !v('#ncD')) { m.textContent = 'Заполните даты.'; return; }
      if (v('#ncT') < v('#ncF')) { m.textContent = 'Дата «по» раньше даты «с».'; return; }
      await rpc('certificate_create', { p_student_id: v('#ncS'), p_kind: v('#ncK'), p_from: v('#ncF'), p_to: v('#ncT'), p_due: v('#ncD'), p_note: v('#ncN').trim() || null });
      s.close(); toast('Справка добавлена.', 'ok'); Cab.rerender();
    });
  }

  // ---------- «Справка получена»: какие пропуски она закрывает ----------
  async function certDetail(el, ctx, id, nav) {
    const c = await q(sb.from('certificates').select('id, student_id, kind, date_from, date_to, due_date, status, note').eq('id', id).eq('group_id', ctx.group.id).maybeSingle());
    if (!c) { put(el, h`${head({ href: '#/journal/certs', text: 'Справки' }, roleText(ctx), 'Справка')}<p class="cab-empty">Справка не найдена. Возможно, её уже убрали.</p>`); return; }
    const [stu, ab] = await Promise.all([
      q(sb.from('students').select('id, last_name, first_name').eq('id', c.student_id).single()),
      q(sb.from('absences').select('id, date, subject, hours, lesson_kind').eq('group_id', ctx.group.id).eq('student_id', c.student_id).eq('is_excused', false).gte('date', c.date_from).lte('date', c.date_to).order('date').order('created_at')),
    ]);
    if (!nav.isCurrent()) return;
    const can = c.status === 'waiting' && !ctx.closed;
    put(el, h`${head({ href: '#/journal/certs', text: 'Справки' }, roleText(ctx), 'Справка ' + Cab.initials(stu))}
      ${closedNote(ctx)}
      <div class="j2-field" style="cursor:default"><span>Справка</span><b style="font-size:17px">${period(c.date_from, c.date_to)}, ${KIND[c.kind] || 'справка'}</b>${c.note ? h`<span>${c.note}</span>` : ''}</div>
      ${c.status === 'waiting' ? '' : h`<div class="j2-card"><h2>${c.status === 'received' ? 'Справка получена' : 'Справки нет'}</h2><p>Эта справка уже обработана.</p></div>`}
      <div class="cab-card"><h3>Какие пропуски она закрывает</h3>
        ${ab.length ? ab.map((a) => h`<label class="cab-chk"><input type="checkbox" value="${a.id}" ${can ? 'checked' : 'disabled'}><span>${Cab.dateText(a.date)}<small>${a.subject || 'Без предмета'}${a.lesson_kind ? ', ' + Cab.kindLow(a.lesson_kind) : ''}</small></span><b>${num(a.hours)} ч</b></label>`) : h`<p>В этот период неуважительных пропусков нет.</p>`}</div>
      <div class="cab-card"><div class="meta"><b>Станут уважительными</b><span class="j2-num" id="cdSum"></span></div><p>Студент и преподаватели увидят новый статус</p></div>
      ${can ? h`<button class="j2-btn primary" type="button" id="cdOk"></button><a class="j2-btn" href="#/journal/certs">Отмена</a>` : ''}`);
    if (!can) { $(el, '#cdSum').textContent = '—'; return; }
    const ok = $(el, '#cdOk');
    const ids = () => $$(el, 'input:checked').map((x) => x.value);
    const sync = () => {
      const on = new Set(ids()), n = sum(ab.filter((a) => on.has(a.id)), (a) => a.hours);
      $(el, '#cdSum').textContent = `${num(n)} ч`;
      ok.textContent = on.size ? `Закрыть ${num(n)} ч справкой` : 'Отметить справку полученной';
    };
    el.onchange = sync; sync();
    ok.onclick = () => act(ok, async () => {
      const r = await rpc('certificate_resolve', { p_certificate: c.id, p_status: 'received', p_absence_ids: ids() });
      toast(`Закрыто ${num(r && r.hours != null ? r.hours : 0)} ч справкой.`, 'ok');
      location.hash = '#/journal/certs';
    });
  }

  // =====================================================================================================
  // Задания
  // =====================================================================================================
  const TYPES = [{ v: 'ПЗ', k: 'homework', t: 'Домашка, ПЗ' }, { v: 'УСР', k: 'homework', t: 'Домашка, УСР' },
    { v: 'deadline', k: 'deadline', t: 'Дедлайн' }, { v: 'zachet', k: 'deadline', t: 'Зачёт' }, { v: 'exam', k: 'deadline', t: 'Экзамен' }];
  const typeText = (x) => (TYPES.find((y) => y.v === x.type && y.k === x.kind) || { t: x.kind === 'homework' ? 'Домашка' : 'Дедлайн' }).t;
  const AUD = ['Вся группа', 'Подгруппа 1', 'Подгруппа 2'];
  let subjCache = null;
  async function subjects(gid) {
    if (!subjCache) {
      const r = await q(sb.from('schedule_lessons').select('subject').eq('group_id', gid).limit(1000));
      subjCache = [...new Set(r.map((x) => x.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    }
    return subjCache;
  }

  async function tasks(el, ctx, params, nav) {
    const gid = ctx.group.id, day = day0();
    const rows = (await q(sb.from('tasks').select('id, kind, rec, created_by').eq('group_id', gid))).map(Cab.task);
    if (!nav.isCurrent()) return;
    const own = (x) => !x.createdBy || x.createdBy === ctx.uid;
    const cmp = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
    const live = rows.filter((x) => !x.due || x.due >= day).sort(cmp), past = rows.filter((x) => x.due && x.due < day).sort((a, b) => cmp(b, a)).slice(0, 10);
    const card = (x, old) => { const d = Cab.due(x.due), mine = own(x); return h`<article class="cab-card ${old ? 'hm-old' : ''}"><div class="meta"><h3>${x.subject || 'Без предмета'}</h3><span class="st c-${d.cls}">${d.text}</span></div>
      <p>${typeText(x)}${mine ? x.createdBy ? ', добавили вы' : ', добавил староста' : ', от преподавателя'}${x.subgroup ? ', подгруппа ' + x.subgroup : ''}${x.due ? ', до ' + Cab.dateText(x.due) : ''}</p>
      ${x.text ? h`<p class="hm-text">${x.text}</p>` : ''}
      ${ctx.closed ? '' : mine ? h`<div class="cab-actions"><button type="button" class="j2-btn small" data-e="${x.id}" aria-label="Изменить: ${x.subject}">Изменить</button><button type="button" class="j2-btn small danger" data-d="${x.id}" aria-label="Отменить: ${x.subject}">Отменить</button></div>` : h`<p class="cab-note">От преподавателя, отменить нельзя.</p>`}</article>`; };
    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, `${live.length} ${plural(live.length, ['активное', 'активных', 'активных'])}`, 'Задания')}
      ${closedNote(ctx)}
      ${ctx.closed ? '' : h`<button type="button" class="j2-btn primary" id="hmAdd"><span class="cab-ico sm">${icon.plus}</span>Добавить домашку или дедлайн</button>`}
      <div id="hmSeg"></div><div id="hmTasks"></div>`);
    const box = $(el, '#hmTasks');
    const paint = () => {
      const f = (x) => S.taskFilter === 'all' || (S.taskFilter === 'mine') === own(x);
      const a = live.filter(f), b = past.filter(f);
      put(box, h`${a.length ? a.map((x) => card(x)) : h`<p class="cab-empty">Нет заданий</p>`}${b.length ? h`<h2 class="cab-h2">Прошедшие</h2>${b.map((x) => card(x, true))}` : ''}`);
    };
    Cab.segmented($(el, '#hmSeg'), [{ value: 'all', label: 'Все' }, { value: 'mine', label: 'Мои' }, { value: 'teachers', label: 'От преподавателей' }], S.taskFilter, (v) => { S.taskFilter = v; paint(); });
    paint();
    const add = $(el, '#hmAdd');
    if (add) add.onclick = () => act(add, () => taskSheet(ctx, null));
    box.onclick = (e) => {
      const b = e.target.closest('button[data-e], button[data-d]'); if (!b) return;
      const x = rows.find((r) => r.id === (b.dataset.e || b.dataset.d));
      act(b, async () => {
        if (b.dataset.e) { await taskSheet(ctx, x); return; }
        if (!(await confirmSheet('Отменить задание?', `${x.subject || 'Без предмета'}${x.text ? ': ' + x.text.slice(0, 80) : ''}`, 'Отменить задание'))) return;
        const del = await q(sb.from('tasks').delete().eq('id', x.id).select('id'));
        toast(del.length ? 'Задание отменено.' : 'Не получилось отменить: запись уже изменена.', del.length ? 'ok' : 'err');
        Cab.rerender();
      });
    };
  }

  // Форма задания: row = null — новое, иначе правка (вид «домашка/дедлайн» при правке не меняется: id и kind связаны)
  async function taskSheet(ctx, row) {
    const subs = await subjects(ctx.group.id), t = row;
    const types = row ? TYPES.filter((x) => x.k === row.kind) : TYPES;
    const sub0 = t && t.subject && !subs.includes(t.subject) ? [...subs, t.subject] : subs;
    const s = sheet(row ? 'Изменить задание' : 'Новое задание', h`<label class="j2-field"><span>Что</span><select id="tfT">${types.map((x) => h`<option value="${x.v}">${x.t}</option>`)}</select></label>
      <label class="j2-field"><span>Предмет</span><select id="tfS">${sub0.map((x) => h`<option value="${x}">${x}</option>`)}<option value="__other">Другой предмет…</option></select></label>
      <label class="j2-field j2-hidden" id="tfOw"><span>Название предмета</span><input id="tfO" type="text" maxlength="120" autocomplete="off"></label>
      <label class="j2-field"><span>Текст</span><textarea id="tfX" maxlength="500" rows="3"></textarea></label>
      <div class="j2-row"><label class="j2-field"><span>Срок</span><input id="tfD" type="date"></label>
      <label class="j2-field"><span>Кому</span><select id="tfA">${AUD.map((x, i) => h`<option value="${i}">${x}</option>`)}</select></label></div>
      <div class="j2-msg err" id="tfM" role="alert"></div>
      <button class="j2-btn primary" type="button" id="tfOk">Сохранить</button><button class="j2-btn" type="button" id="tfNo">Отмена</button>`);
    const g = (id) => $(s.el, id);
    if (t) { g('#tfT').value = types.some((x) => x.v === t.type) ? t.type : types[0].v; g('#tfS').value = t.subject || '__other'; g('#tfX').value = t.text; g('#tfD').value = t.due || ''; g('#tfA').value = String(t.subgroup); }
    const tog = () => g('#tfOw').classList.toggle('j2-hidden', g('#tfS').value !== '__other');
    g('#tfS').onchange = tog; tog();
    g('#tfNo').onclick = s.close;
    const ok = g('#tfOk');
    ok.onclick = () => act(ok, async () => {
      const m = g('#tfM'); m.textContent = '';
      const ty = TYPES.find((x) => x.v === g('#tfT').value), subject = (g('#tfS').value === '__other' ? g('#tfO').value : g('#tfS').value).trim(), text = g('#tfX').value.trim(), due = g('#tfD').value;
      if (!subject) { m.textContent = 'Укажите предмет.'; return; }
      if (!text) { m.textContent = 'Напишите, что задано.'; return; }
      if (!due) { m.textContent = 'Укажите срок.'; return; }
      const part = { subject, type: ty.v, text, dueDate: due, subgroup: Number(g('#tfA').value) };
      if (row) {
        const r = await q(sb.from('tasks').update({ rec: { ...row.raw.rec, ...part } }).eq('id', row.id).select('id'));
        if (!r.length) { m.textContent = 'Не получилось сохранить: запись уже изменена.'; return; }
      } else {
        const id = `${ty.k === 'homework' ? 'hw' : 'dl'}-${Date.now()}`;
        await q(sb.from('tasks').insert({ id, kind: ty.k, rec: { id, ...part, createdAt: new Date().toISOString() }, group_id: ctx.group.id }));
      }
      s.close(); toast(row ? 'Задание изменено.' : 'Задание добавлено.', 'ok'); Cab.rerender();
    });
  }

  // =====================================================================================================
  // Отчёт для деканата
  // =====================================================================================================
  const MON = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const loaded = {};
  const loadScript = (src) => loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => { s.remove(); delete loaded[src]; rej(new Error('script ' + src)); };
    document.head.appendChild(s);
  }));
  const download = (blob, name) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  async function report(el, ctx, params, nav) {
    const gid = ctx.group.id, now = Cab.minsk();
    const meta = await q(sb.from('schedule_meta').select('semester_start, semester_end').eq('group_id', gid).maybeSingle());
    if (!nav.isCurrent()) return;
    if (!S.rep.month) S.rep.month = now.iso.slice(0, 7);
    const left = semEndNote(meta && meta.semester_end);
    // период: месяц или семестр (без данных о семестре — с 1 сентября учебного года до сегодня)
    const range = () => {
      if (S.rep.mode === 'month') {
        const [y, m] = S.rep.month.split('-').map(Number);
        return { from: `${S.rep.month}-01`, to: Cab.addDays(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), -1) };
      }
      return { from: (meta && meta.semester_start) || `${now.m >= 8 ? now.y : now.y - 1}-09-01`, to: (meta && meta.semester_end) || now.iso };
    };
    put(el, h`${head({ href: '#/summary', text: 'Сводка' }, dateRight(), 'Отчёт для деканата')}
      ${ctx.closed ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт</h2><p>Данные только для просмотра. Отчёт можно скачать в любой момент. Журнал откроется, когда в расписании появится новый семестр.</p></div>`
      : left == null ? '' : h`<div class="j2-card warn"><h2>Конец семестра</h2><p>${left === 0 ? 'Сегодня журнал закроется.' : `Через ${left} ${plural(left, ['день', 'дня', 'дней'])} журнал закроется.`} Выгрузите отчёт заранее.</p></div>`}
      <div id="hmSeg"></div>
      <label class="j2-field" id="hmMw"><span>Месяц</span><input id="hmMonth" type="month"></label>
      <div id="hmRep" aria-live="polite"></div>
      <button type="button" class="j2-btn primary" id="hmXls">Скачать Excel</button>
      <div class="j2-msg err" id="hmErr" role="alert"></div>`);
    const mw = $(el, '#hmMw'), box = $(el, '#hmRep'), xls = $(el, '#hmXls'), err = $(el, '#hmErr');
    $(el, '#hmMonth').value = S.rep.month;
    let seq = 0;
    async function load() {
      const my = ++seq, r = range();
      mw.classList.toggle('j2-hidden', S.rep.mode !== 'month');
      box.innerHTML = '<p class="cab-load">Считаем…</p>';
      try {
        const rows = await rpc('group_absence_summary', { p_group: gid, p_from: r.from, p_to: r.to });
        if (my !== seq || !nav.isCurrent()) return;
        const top = rows.filter((x) => Number(x.total) > 0).sort((a, b) => Number(b.total) - Number(a.total)).slice(0, 5);
        put(box, h`<div class="cab-tiles two"><div class="cab-tile t-amber"><span class="big">${num(sum(rows, (x) => x.total))}</span><small>часов пропущено</small></div><div class="cab-tile t-mint"><span class="big">${num(sum(rows, (x) => x.excused))}</span><small>по уважительной</small></div></div>
          <h2 class="cab-h2">Больше всего пропусков</h2>
          ${top.length ? h`<ul class="j2-list">${top.map((x) => h`<li><span>${x.student_name}${Number(x.cert_waiting) > 0 ? h`<small class="hm-lock c-coral">справка не сдана</small>` : ''}</span><span class="j2-num amber">${num(x.total)} ч</span></li>`)}</ul>` : h`<p class="cab-empty">За этот период пропусков нет.</p>`}`);
      } catch (e) {
        if (my !== seq) return;
        put(box, h`<div class="j2-card bad"><h2>Не получилось посчитать</h2><p>${errText(e)}</p></div><button type="button" class="j2-btn" id="hmAgain">Повторить</button>`);
        $(box, '#hmAgain').onclick = load;
      }
    }
    Cab.segmented($(el, '#hmSeg'), [{ value: 'month', label: 'Месяц' }, { value: 'sem', label: 'Семестр' }], S.rep.mode, (v) => { S.rep.mode = v; load(); });
    $(el, '#hmMonth').onchange = (e) => { if (e.target.value) { S.rep.month = e.target.value; load(); } };
    load();

    xls.onclick = () => act(xls, async () => {
      err.textContent = ''; xls.textContent = 'Готовим файл…';
      try {
        try {
          if (!window.ExcelJS) await loadScript('vendor/exceljs.min.js');
          if (!window.buildDeanReport) await loadScript('dean-report.js');
        } catch (e) { err.textContent = 'Не удалось загрузить библиотеку Excel. Проверьте связь и повторите.'; return; }
        const r = range();
        const [stu, ab] = await Promise.all([
          q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid)),
          fetchAll(() => sb.from('absences').select('id, student_id, date, hours, is_excused').eq('group_id', gid).gte('date', r.from).lte('date', r.to).order('id')),
        ]);
        const students = stu.map((s) => ({ id: s.id, lastName: s.last_name, firstName: s.first_name }));
        const items = ab.map((a) => ({ studentId: a.student_id, date: a.date, isExcused: a.is_excused, totalHours: a.hours }));
        const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        let wb, file;
        if (S.rep.mode === 'month') {
          const [y, m] = S.rep.month.split('-').map(Number);
          wb = buildDeanReport(ExcelJS, students, items, y, m - 1); file = `Пропуски_${S.rep.month}.xlsx`;
        } else {
          // один файл на семестр: buildDeanReport на каждый месяц, а листы кладём в общую книгу через подменённый Workbook
          wb = new ExcelJS.Workbook();
          let sheetName = '';
          const proxy = { Workbook: function () { return { addWorksheet: () => wb.addWorksheet(sheetName) }; } };
          const a = r.from.split('-').map(Number), z = r.to.split('-').map(Number);
          for (let y = a[0], m = a[1]; (y < z[0] || (y === z[0] && m <= z[1])) && wb.worksheets.length < 12; m === 12 ? (y++, m = 1) : m++) {
            const pre = `${y}-${String(m).padStart(2, '0')}`;
            sheetName = `${MON[m - 1]} ${y}`;
            buildDeanReport(proxy, students, items.filter((x) => x.date.startsWith(pre)), y, m - 1);
          }
          const y0 = a[1] >= 9 ? a[0] : a[0] - 1;
          file = `Пропуски_семестр_${y0}-${String(y0 + 1).slice(2)}.xlsx`;
        }
        download(new Blob([await wb.xlsx.writeBuffer()], { type: MIME }), file);
        toast('Файл готов.', 'ok');
      } catch (e) {
        console.error('[headman] excel', e);
        err.textContent = 'Не удалось подготовить файл. Повторите.';
      } finally { xls.textContent = 'Скачать Excel'; }
    });
  }

  // =====================================================================================================
  // Чат: настоящий чат появится на этапе 4
  // =====================================================================================================
  // Экран чата рисует chat-ui.js (шифрование в chat-crypto.js)
  function chat(el, ctx) {
    if (!window.ChatUI) { put(el, h`${head({ href: '#/summary', text: 'Сводка' }, ctx.group.name, 'Чат')}<div class="j2-card bad"><h2>Чат недоступен</h2><p>Обновите страницу.</p></div>`); return; }
    return ChatUI.mount(el, { sb, ctx, role: 'headman' });
  }

  // Жест «потяни, чтобы обновить» (tg-app.js) не должен стирать отметки пропусков, которые ещё не сохранены
  window.J2_NO_REFRESH = () => S.marks.size > 0;
  // main общий для всех экранов: обработчики прошлого экрана снимаем перед отрисовкой нового
  const R = (fn) => ({ render: (el, ...a) => { el.onclick = el.onchange = null; return fn(el, ...a); } });
  const tab = (id, label, ico) => ({ id, label, icon: ico, path: id });
  Cab.start({
    kind: 'headman', start: 'summary',
    tabs: [tab('summary', 'Сводка', icon.home), tab('journal', 'Журнал', icon.journal), tab('tasks', 'Задания', icon.tasks), tab('chat', 'Чат', icon.chat)],
    routes: {
      summary: R(summary), 'summary/requests': R(requests), 'summary/report': R(report), 'summary/erasure': R(erasure),
      journal: R(journal), 'journal/certs': R(certs), 'journal/history': R(history),
      tasks: R(tasks), chat: R(chat),
    },
  });
})();
