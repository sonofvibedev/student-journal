// «Журнал 2.0», этап 4: кабинет преподавателя (teacher.html). Оболочка и роутер живут в cab-core.js.
// Экраны: Главная, Группы, Журнал (Занятия, Посещаемость, Оценки), Задания, Тесты (заглушка), Чат (chat-ui.js).
// Права проверяет сервер (RLS и RPC): страница лишь прячет кнопки, которые всё равно не сработают.
'use strict';
(function () {
  const { h, str, q, rpc, toast, plural, num, icon } = Cab;
  const sb = Cab.sb;
  const $ = (r, s) => r.querySelector(s);
  const put = (el, html) => { el.innerHTML = str(html); };
  const day0 = () => Cab.minsk().iso;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const byName = (a, b) => (a.last_name || '').localeCompare(b.last_name || '', 'ru') || (a.first_name || '').localeCompare(b.first_name || '', 'ru');
  const soft = (p) => p.catch((e) => { console.warn('[teacher]', e); return null; });
  const roleText = (ctx) => 'Преподаватель, ' + (ctx.subjects.join(', ') || 'без предметов');
  const head = (back, right, title, sub) => h`${Cab.top(back, right)}<h1 class="cab-title">${title}</h1>${sub ? h`<p class="cab-sub">${sub}</p>` : ''}`;
  const MIN = ['минута', 'минуты', 'минут'], PPL = ['человек', 'человека', 'человек'];
  const grp = (ctx, gid) => ctx.groups.find((g) => g.id === gid) || { id: gid, name: '', status: 'active' };
  const isClosed = (ctx, gid) => grp(ctx, gid).status !== 'active';
  const closedNote = (ctx, gid) => (isClosed(ctx, gid) ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт: только просмотр</h2></div>` : '');
  const mySubj = (ctx, gid) => [...new Set(ctx.assignments.filter((a) => a.group_id === gid && a.lesson_kind === ctx.teacherRole).map((a) => a.subject))];
  const kindWord = (ctx) => (ctx.teacherRole === 'lecture' ? 'лекционные' : 'семинарские');
  // Кнопка «идёт запрос»: защита от двойного нажатия + человеческая ошибка (fail — свой текст для отказа сервера)
  const act = (btn, fn, fail) => J2.busy(btn, async () => { try { return await fn(); } catch (e) { console.error('[teacher]', e); toast(fail || Cab.rpcText(e), 'err'); } });

  // Состояние живёт, пока открыта страница
  const S = { sel: null, pair: null, hours: 2, otherDate: null, lesson: null, marks: new Set(), mode: '10', topic: '', gdate: null, taskFilter: 'all' };

  // ---------- нижний лист и подтверждение (копия из headman.js) ----------
  let opened = null;
  function closeSheet() {
    if (!opened) return;
    const s = opened; opened = null;
    document.removeEventListener('keydown', s.onKey); s.el.remove();
    document.getElementById('cab').inert = false;
    if (s.prev && s.prev.isConnected) s.prev.focus();
  }
  function sheet(title, body, onDismiss) {
    closeSheet();
    const el = document.createElement('div');
    el.className = 'cab-modal';
    el.innerHTML = str(h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="tcSheetT"><h2 class="tc-sheet-h" id="tcSheetT" tabindex="-1">${title}</h2>${body}</div>`);
    const dismiss = () => { if (onDismiss) onDismiss(); closeSheet(); };
    const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
    el.addEventListener('mousedown', (e) => { if (e.target === el) dismiss(); });
    document.addEventListener('keydown', onKey);
    opened = { el, onKey, prev: document.activeElement };
    document.getElementById('cab').inert = true;
    document.body.appendChild(el);
    $(el, '#tcSheetT').focus();
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

  // ---------- выбор «предмет и группа» (один на экраны журнала) ----------
  function pairs(ctx) {
    const out = [];
    [...ctx.groups].sort((a, b) => a.name.localeCompare(b.name, 'ru')).forEach((g) => mySubj(ctx, g.id).sort((a, b) => a.localeCompare(b, 'ru')).forEach((s) => out.push({ key: g.id + '|' + s, gid: g.id, group: g.name, subject: s })));
    return out;
  }
  const pairText = (ctx, p) => `${p.subject}, ${p.group}, ${ctx.teacherRole === 'lecture' ? 'лекции' : 'практические'}`;
  function curPair(ctx) {
    const ps = pairs(ctx);
    if (!ps.some((p) => p.key === S.sel)) S.sel = ps[0] ? ps[0].key : null;
    return ps.find((p) => p.key === S.sel) || null;
  }
  const pickHtml = (ctx) => h`<label class="j2-field tc-pick"><span>Предмет и группа</span><select id="tcSel">${pairs(ctx).map((p) => h`<option value="${p.key}" ${p.key === S.sel ? 'selected' : ''}>${pairText(ctx, p)}</option>`)}</select></label>`;
  function bindPick(el) {
    const s = $(el, '#tcSel');
    if (s) s.onchange = () => { S.sel = s.value; S.pair = null; S.lesson = null; S.marks.clear(); Cab.rerender(); };
  }
  const jtabs = (el, v) => Cab.segmented(el, [{ value: 'journal', label: 'Занятия' }, { value: 'journal/attendance', label: 'Посещаемость' }, { value: 'journal/grades', label: 'Оценки' }], v, (x) => { location.hash = '#/' + x; });
  const jhead = (ctx) => head({ href: '#/home', text: 'Главная' }, roleText(ctx), 'Журнал');
  const noPairs = (el, ctx, seg) => { put(el, h`${jhead(ctx)}<div id="tcSeg"></div><div class="cab-card"><h3>Нет назначенных предметов</h3><p>Вам не назначены ${ctx.teacherRole === 'lecture' ? 'лекции' : 'практические занятия'} в группах. Обратитесь к администратору.</p></div>`); jtabs($(el, '#tcSeg'), seg); };

  // Занятия предмета и вида преподавателя из расписания
  const lessonsIn = async (ctx, pk, from, to) => {
    const rows = await q(sb.from('schedule_lessons').select('lesson_date, pair_no, starts_at, ends_at, room, subgroup').eq('group_id', pk.gid).eq('subject', pk.subject).eq('kind', ctx.teacherRole)
      .gte('lesson_date', from).lte('lesson_date', to).order('lesson_date').order('pair_no'));
    const seen = new Set();        // подгруппы дают одну пару дважды
    return rows.filter((l) => { const k = l.lesson_date + '|' + l.pair_no; if (seen.has(k)) return false; seen.add(k); return true; });
  };

  // Кто из авторов записей староста или заместитель: user_is_staff (кэш на страницу)
  const staffCache = new Map();
  async function staffOf(gid, ids) {
    await Promise.all(ids.filter((u) => u && !staffCache.has(gid + '|' + u)).map(async (u) => {
      const r = await soft(rpc('user_is_staff', { g: gid, u }));
      staffCache.set(gid + '|' + u, r === true);
    }));
  }
  const isStaffUser = (gid, u) => !!u && staffCache.get(gid + '|' + u) === true;

  // =====================================================================================================
  // Главная
  // =====================================================================================================
  async function home(el, ctx, params, nav) {
    const t = Cab.minsk(), day = t.iso, gids = ctx.groups.map((g) => g.id);
    const [stu, ls, thr] = await Promise.all([
      q(sb.from('students').select('id, group_id').in('group_id', gids)),
      q(sb.from('schedule_lessons').select('group_id, pair_no, starts_at, ends_at, subject, kind, room').in('group_id', gids).eq('lesson_date', day).eq('kind', ctx.teacherRole).order('starts_at')),
      soft(rpc('chat_threads_my')),
    ]);
    if (!nav.isCurrent()) return;
    const cnt = (gid) => stu.filter((s) => s.group_id === gid).length;
    const mine = ls.filter((l) => mySubj(ctx, l.group_id).includes(l.subject));
    const nowOf = (gid) => mine.find((l) => (!gid || l.group_id === gid) && Cab.toMin(l.starts_at) <= t.minutes && t.minutes < Cab.toMin(l.ends_at));
    const now = nowOf(), next = mine.find((l) => Cab.toMin(l.starts_at) > t.minutes);
    const left = now ? Cab.toMin(now.ends_at) - t.minutes : 0;
    const lessonCard = now
      ? h`<a class="cab-row t-lime" href="#/journal/attendance"><span><small>Сейчас идёт ${Cab.kindLow(now.kind)}</small><b>${grp(ctx, now.group_id).name}</b><small>${now.subject}, ещё ${left} ${plural(left, MIN)}, ${cnt(now.group_id)} ${plural(cnt(now.group_id), PPL)}</small></span>${now.room ? h`<span class="tc-room"><small>ауд.</small> <b>${now.room}</b></span>` : ''}</a>`
      : h`<a class="cab-row" href="#/journal"><span><b>Пар сейчас нет</b><small>${next ? `Дальше: ${next.subject}, ${grp(ctx, next.group_id).name}, ${Cab.hm(next.starts_at)}` : 'Сегодня занятий больше нет'}</small></span><span class="cab-ico">${icon.chev}</span></a>`;
    const kinds = (gid) => { const k = new Set(ctx.assignments.filter((a) => a.group_id === gid).map((a) => a.lesson_kind)); return k.size > 1 ? 'лекции и практические' : k.has('practice') ? 'практические' : 'лекции'; };
    const groupRows = ctx.groups.map((g) => h`<a class="tc-grp" href="#/groups"><span><b>${g.name}</b><small>${cnt(g.id)} ${plural(cnt(g.id), PPL)}, ${kinds(g.id)}</small></span>${nowOf(g.id) ? h`<span class="tc-pill">идёт пара</span>` : h`<span class="cab-ico sm">${icon.chev}</span>`}</a>`);
    // строки чата: по тредам из chat_threads_my, иначе по одной на группу (RPC может быть недоступен: экран не падает)
    const threads = Array.isArray(thr) ? thr.filter((x) => x.thread_id) : [];
    const chatRows = ctx.groups.flatMap((g) => {
      const mine2 = threads.filter((x) => x.group_id === g.id);
      return mine2.length ? mine2.map((x) => ({ name: x.peer_name || 'Староста ' + g.name, n: Number(x.unread) || 0 })) : [{ name: 'Староста ' + g.name, n: 0 }];
    }).slice(0, 4);
    const m = Cab.minsk();
    put(el, h`<div class="cab-top"><span class="cab-top-r tc-date">${Cab.DOW_S[m.dow]}, ${m.d} ${Cab.MONTHS[m.m]}</span><span class="cab-top-r">${roleText(ctx)}</span></div>
      <h1 class="cab-title">Кабинет преподавателя</h1>
      ${ctx.groups.map((g) => closedNote(ctx, g.id))}
      ${lessonCard}
      <div class="cab-card"><h3>Мои группы</h3>${groupRows}</div>
      <a class="cab-row" href="#/tasks"><b class="tc-b17">Домашки и дедлайны</b><span class="cab-ico">${icon.chev}</span></a>
      ${chatRows.map((c) => h`<a class="cab-row" href="#/chat"><span class="tc-lockn"><span class="cab-ico sm">${icon.lock}</span><b class="tc-b17">${c.name}</b></span>${c.n ? h`<span class="st c-lime">${c.n} ${plural(c.n, ['новое', 'новых', 'новых'])}</span>` : h`<span class="cab-ico">${icon.chev}</span>`}</a>`)}`);
  }

  // =====================================================================================================
  // Группы
  // =====================================================================================================
  async function groups(el, ctx, params, nav) {
    const t = Cab.minsk(), day = t.iso, gids = ctx.groups.map((g) => g.id);
    const [stu, ls, st] = await Promise.all([
      q(sb.from('students').select('id, group_id, last_name, first_name').in('group_id', gids)),
      q(sb.from('schedule_lessons').select('group_id, starts_at, ends_at, subject').in('group_id', gids).eq('kind', ctx.teacherRole).eq('lesson_date', day)),
      Promise.all(gids.map((g) => soft(rpc('teacher_group_stats', { p_group: g })))),     // {students, attendance_pct (30 дней), absences_week (часы)}
    ]);
    if (!nav.isCurrent()) return;
    const total = stu.length, stats = new Map(gids.map((g, i) => [g, st[i] || {}]));
    const card = (g) => {
      const subs = mySubj(ctx, g.id), n = stu.filter((s) => s.group_id === g.id).length, x = stats.get(g.id);
      const pct = x.attendance_pct == null ? null : Math.round(Number(x.attendance_pct)), wk = x.absences_week == null ? null : Number(x.absences_week);
      const live = ls.some((l) => l.group_id === g.id && subs.includes(l.subject) && Cab.toMin(l.starts_at) <= t.minutes && t.minutes < Cab.toMin(l.ends_at));
      return h`<article class="cab-card" data-g="${g.id}"><div class="meta"><h3>${g.name}</h3>${isClosed(ctx, g.id) ? h`<span class="tc-pill mute">журнал закрыт</span>` : live ? h`<span class="tc-pill">идёт пара</span>` : ''}</div>
        <p>${n} ${plural(n, PPL)}, ${ctx.teacherRole === 'lecture' ? 'лекции' : 'практические'}</p>
        <div class="tc-metrics"><span><b class="${pct == null ? 'c-mute' : pct >= 90 ? 'c-lime' : pct >= 80 ? 'c-amber' : 'c-coral'}">${pct == null ? '—' : pct + '%'}</b><small>посещаемость</small></span>
        <span><b class="c-mute">—</b><small>средний балл тестов</small></span><span><b class="${wk ? 'c-amber' : wk === 0 ? 'c-lime' : 'c-mute'}">${wk == null ? '—' : num(wk)}</b><small>${wk == null ? 'пропусков' : plural(Math.round(wk), ['час', 'часа', 'часов'])} за неделю</small></span></div>
        <div class="cab-actions"><button type="button" class="j2-btn" data-list="${g.id}">Список</button><a class="j2-btn tc-write" href="#/chat">Написать старосте</a></div></article>`;
    };
    put(el, h`${head({ href: '#/home', text: 'Главная' }, roleText(ctx), 'Группы', `${ctx.groups.length} ${plural(ctx.groups.length, ['группа', 'группы', 'групп'])}, ${total} ${plural(total, PPL)}`)}
      ${ctx.groups.map(card)}`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-list]'); if (!b) return;
      const g = grp(ctx, b.dataset.list), list = stu.filter((s) => s.group_id === g.id).sort(byName);
      const s = sheet(`${g.name}, список`, h`${list.length ? h`<ul class="j2-list">${list.map((x) => h`<li><span>${Cab.fullName(x)}</span></li>`)}</ul>` : h`<p class="cab-empty">Студентов нет</p>`}<button class="j2-btn" type="button" data-a="close">Закрыть</button>`);
      s.el.addEventListener('click', (ev) => { if (ev.target.closest('button[data-a="close"]')) s.close(); });
    };
  }

  // =====================================================================================================
  // Журнал: занятия
  // =====================================================================================================
  async function lessons(el, ctx, params, nav) {
    const pk = curPair(ctx);
    if (!pk) return noPairs(el, ctx, 'journal');
    const day = day0(), from = Cab.addDays(day, -28), to = Cab.addDays(day, 28), closed = isClosed(ctx, pk.gid);
    const [ls, notes] = await Promise.all([
      lessonsIn(ctx, pk, from, to),
      sb.from('lesson_notes').select('lesson_date, pair_no, topic, plan').eq('group_id', pk.gid).eq('subject', pk.subject).gte('lesson_date', from).lte('lesson_date', to)
        .then((r) => { if (r.error) { console.warn('[teacher] lesson_notes', r.error); return []; } return r.data || []; }),
    ]);
    if (!nav.isCurrent()) return;
    const key = (l) => l.lesson_date + '|' + l.pair_no;
    const note = new Map(notes.map((n) => [n.lesson_date + '|' + n.pair_no, n]));
    const order = (a, b) => key(a).localeCompare(key(b));
    if (!ls.some((l) => key(l) === S.lesson)) {
      const sorted = [...ls].sort(order);
      const pick = sorted.find((l) => l.lesson_date === day) || sorted.find((l) => l.lesson_date > day) || sorted[sorted.length - 1];
      S.lesson = pick ? key(pick) : null;
    }
    const cur = ls.find((l) => key(l) === S.lesson), cn = cur ? note.get(key(cur)) : null;
    const others = ls.filter((l) => l !== cur), up = others.filter((l) => l.lesson_date >= day).sort(order), past = others.filter((l) => l.lesson_date < day).sort(order).reverse();
    const line = (l) => { const n = note.get(key(l)), done = !!(n && String(n.topic || '').trim()); return h`<button type="button" class="tc-line" data-k="${key(l)}"><span><b>${Cab.dateText(l.lesson_date)}</b><small>${done ? n.topic : 'тема не указана'}${done && String(n.plan || '').trim() ? ', план заполнен' : ''}</small></span><span class="tc-st ${done ? 'c-lime' : 'c-amber'}">${done ? 'готово' : 'добавить'}</span></button>`; };
    const when = cur ? `${cur.lesson_date === day ? 'Сегодня' : Cab.dateText(cur.lesson_date)}, ${Cab.hm(cur.starts_at)}${cur.room ? ', ауд. ' + cur.room : ''}` : '';
    put(el, h`${jhead(ctx)}<div id="tcSeg"></div>${closedNote(ctx, pk.gid)}${pickHtml(ctx)}
      ${cur ? h`<div class="cab-card"><h3>${when}</h3>
        <label class="j2-field"><span>Тема</span><input id="tcTopic" type="text" maxlength="200" autocomplete="off" ${closed ? 'disabled' : ''}></label>
        <label class="j2-field"><span>План занятия</span><textarea id="tcPlan" maxlength="2000" rows="4" ${closed ? 'disabled' : ''}></textarea></label></div>
        ${closed ? '' : h`<button type="button" class="j2-btn primary" id="tcSave">Сохранить тему и план</button>`}`
        : h`<div class="cab-card"><h3>Занятий нет</h3><p>В расписании на ближайшие 4 недели нет занятий этого предмета.</p></div>`}
      ${others.length ? h`<div class="cab-card"><h3>Другие занятия</h3>${up.slice(0, 6).map(line)}${past.slice(0, 8).map(line)}</div>` : ''}`);
    jtabs($(el, '#tcSeg'), 'journal'); bindPick(el);
    if (cur) { $(el, '#tcTopic').value = (cn && cn.topic) || ''; $(el, '#tcPlan').value = (cn && cn.plan) || ''; }
    el.onclick = (e) => { const b = e.target.closest('button[data-k]'); if (b) { S.lesson = b.dataset.k; Cab.rerender(); } };
    const save = $(el, '#tcSave');
    if (save) save.onclick = () => act(save, async () => {
      const topic = $(el, '#tcTopic').value.trim(), plan = $(el, '#tcPlan').value.trim();
      // одна запись на (группа, дата, пара, предмет): upsert по этому ключу
      await q(sb.from('lesson_notes').upsert({ group_id: pk.gid, lesson_date: cur.lesson_date, pair_no: cur.pair_no, subject: pk.subject, lesson_kind: ctx.teacherRole, topic, plan }, { onConflict: 'group_id,lesson_date,pair_no,subject' }).select());
      toast('Тема и план сохранены.', 'ok'); Cab.rerender();
    }, 'Не получилось сохранить тему. Проверьте связь и повторите.');
  }

  // =====================================================================================================
  // Журнал: посещаемость
  // =====================================================================================================
  async function attendance(el, ctx, params, nav) {
    const pk = curPair(ctx);
    if (!pk) return noPairs(el, ctx, 'journal/attendance');
    const t = Cab.minsk(), day = t.iso, gid = pk.gid, closed = isClosed(ctx, gid), role = ctx.teacherRole;
    const [stu, ls] = await Promise.all([
      q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid)),
      lessonsIn(ctx, pk, Cab.addDays(day, -14), Cab.addDays(day, 14)),
    ]);
    if (!nav.isCurrent()) return;
    stu.sort(byName);
    const opts = ls.map((l) => ({ key: l.lesson_date + '|' + l.pair_no, date: l.lesson_date, l, now: l.lesson_date === day && Cab.toMin(l.starts_at) <= t.minutes && t.minutes < Cab.toMin(l.ends_at) }));
    if (!opts.some((o) => o.key === S.pair) && S.pair !== 'other') {
      S.pair = (opts.find((o) => o.now) || opts.find((o) => o.date === day) || [...opts].reverse().find((o) => o.date < day) || opts[0] || { key: 'other' }).key;
    }
    S.marks.clear();
    if (!S.otherDate) S.otherDate = day;
    const curDate = () => (S.pair === 'other' ? S.otherDate || day : (opts.find((o) => o.key === S.pair) || { date: day }).date);
    const label = (o) => `${Cab.dateText(o.date)}, ${Cab.hm(o.l.starts_at)}, ${Cab.kindLow(role)}, ${S.hours} ч`;
    put(el, h`${jhead(ctx)}<div id="tcSeg"></div>${closedNote(ctx, gid)}${pickHtml(ctx)}
      <label class="j2-field tc-pick"><span>Пара</span><select id="tcPair">${opts.map((o) => h`<option value="${o.key}">${label(o)}</option>`)}<option value="other">Другое занятие…</option></select></label>
      <div id="tcOther" class="j2-hidden"><label class="j2-field"><span>Дата занятия</span><input id="tcDate" type="date" max="${day}"></label></div>
      ${closed ? '' : h`<div class="tc-step"><span id="tcHrsL">Часов за пару</span><div><button type="button" id="tcMinus" aria-label="Меньше часов" aria-describedby="tcHrsL">−</button><output id="tcHrs" aria-live="polite"></output><button type="button" id="tcPlus" aria-label="Больше часов" aria-describedby="tcHrsL">+</button></div></div>`}
      <div class="tc-bar"><span id="tcCnt"></span><span>${stu.length} ${plural(stu.length, PPL)}</span></div>
      <div class="cab-pick" id="tcList"></div>
      ${closed ? '' : h`<button type="button" class="j2-btn primary" id="tcSave"></button>`}
      <p class="cab-note">Менять «неуважительный» на «уважительный» можно в записях своей дисциплины. Отменить можно свои записи и записи старосты. Только по ${role === 'lecture' ? 'лекциям' : 'практическим занятиям'}.</p>`);
    jtabs($(el, '#tcSeg'), 'journal/attendance'); bindPick(el);
    const sel = $(el, '#tcPair'), other = $(el, '#tcOther'), list = $(el, '#tcList'), save = $(el, '#tcSave');
    sel.value = S.pair; $(el, '#tcDate').value = S.otherDate;
    other.classList.toggle('j2-hidden', S.pair !== 'other');

    let ab = new Map(), seq = 0;                    // student_id → запись пропуска по выбранному предмету и дню
    const who = (a) => (a.created_by === ctx.uid ? 'вы' : !a.created_by || isStaffUser(gid, a.created_by) ? 'староста' : 'другой преподаватель');
    const canDel = (a) => !closed && (a.created_by === ctx.uid || isStaffUser(gid, a.created_by));
    function sync() {
      const n = ab.size + S.marks.size;
      $(el, '#tcCnt').textContent = `Отсутствуют: ${n} из ${stu.length}`;
      if (save) { save.textContent = `Сохранить, отсутствуют ${S.marks.size}`; save.disabled = S.marks.size === 0; }
      const o = $(el, '#tcHrs'); if (o) o.textContent = `${S.hours} ч`;
      const mi = $(el, '#tcMinus'), pl = $(el, '#tcPlus'); if (mi) { mi.disabled = S.hours <= 1; pl.disabled = S.hours >= 4; }
      opts.forEach((x, i) => { sel.options[i].text = label(x); });
    }
    function paint() {
      S.marks.forEach((id) => { if (ab.has(id)) S.marks.delete(id); });
      put(list, h`${stu.map((s) => {
        const a = ab.get(s.id), on = S.marks.has(s.id);
        if (!a) return h`<div class="cab-stu tc-row ${on ? 'abs' : ''}"><span><b>${Cab.initials(s)}</b></span><button type="button" class="mark" data-m="${s.id}" aria-disabled="${closed ? 'true' : 'false'}"><span class="sr-only">${Cab.initials(s)}: </span>${on ? `Н, ${S.hours} ч` : 'был'}</button></div>`;
        return h`<div class="tc-abs tc-row ${a.is_excused ? 'ex' : ''}"><div class="tc-abs-h"><span><b>${Cab.initials(s)}</b><small>Н, ${num(a.hours)} ч, внёс: ${who(a)}</small></span>${a.is_excused ? h`<span class="tc-st c-lime">уважительный</span>` : ''}</div>
          ${closed ? '' : h`<div class="cab-actions"><button type="button" class="j2-btn small ${a.is_excused ? '' : 'tc-ex'}" data-ex="${a.id}" aria-label="${a.is_excused ? 'Снять «уважительный»' : 'Уважительный'}: ${Cab.initials(s)}">${a.is_excused ? 'Снять «уважительный»' : 'Уважительный'}</button>${canDel(a) ? h`<button type="button" class="j2-btn small danger" data-del="${a.id}" aria-label="Отменить пропуск: ${Cab.initials(s)}">Отменить</button>` : ''}</div>`}</div>`;
      })}`);
      sync();
    }
    async function loadExisting() {
      const my = ++seq, d = curDate();
      const rows = (await q(sb.from('absences').select('id, student_id, subject, hours, is_excused, created_by').eq('group_id', gid).eq('date', d))).filter((a) => norm(a.subject) === norm(pk.subject));
      await staffOf(gid, [...new Set(rows.map((a) => a.created_by).filter((u) => u && u !== ctx.uid))]);
      if (my !== seq || !nav.isCurrent()) return;
      ab = new Map(rows.map((a) => [a.student_id, a]));
      paint();
    }
    const later = (p) => p.catch((e) => toast(Cab.rpcText(e), 'err'));
    paint(); later(loadExisting());

    list.onclick = (e) => {
      const m = e.target.closest('button.mark');
      if (m) {
        if (closed || m.getAttribute('aria-disabled') === 'true') return;
        const id = m.dataset.m; if (S.marks.has(id)) S.marks.delete(id); else S.marks.add(id);
        const on = S.marks.has(id);
        m.closest('.cab-stu').classList.toggle('abs', on); m.lastChild.textContent = on ? `Н, ${S.hours} ч` : 'был'; sync();
        return;
      }
      const x = e.target.closest('button[data-ex]'), d = e.target.closest('button[data-del]');
      if (x) {
        const a = [...ab.values()].find((r) => r.id === x.dataset.ex);
        act(x, async () => {
          const r = await q(sb.from('absences').update({ is_excused: !a.is_excused }).eq('id', a.id).select('id'));
          if (!r.length) throw new Error('refused');
          toast(a.is_excused ? 'Пропуск снова неуважительный.' : 'Отмечено: уважительный.', 'ok'); await loadExisting();
        }, 'Не получилось изменить: сервер не разрешил или нет связи.');
      }
      if (d) {
        const a = [...ab.values()].find((r) => r.id === d.dataset.del), s = stu.find((r) => r.id === a.student_id);
        act(d, async () => {
          if (!(await confirmSheet('Отменить пропуск?', `${Cab.initials(s || {})}, ${pk.subject}, ${Cab.dateText(curDate())}, ${num(a.hours)} ч.`, 'Отменить пропуск'))) return;
          const r = await q(sb.from('absences').delete().eq('id', a.id).select('id'));
          toast(r.length ? 'Пропуск отменён.' : 'Не получилось отменить: запись уже изменена.', r.length ? 'ok' : 'err'); await loadExisting();
        }, 'Не получилось отменить: сервер не разрешил или нет связи.');
      }
    };
    sel.onchange = () => { S.pair = sel.value; S.marks.clear(); other.classList.toggle('j2-hidden', S.pair !== 'other'); paint(); later(loadExisting()); };
    $(el, '#tcDate').onchange = (e) => { S.otherDate = e.target.value || day; S.marks.clear(); paint(); later(loadExisting()); };
    if (!closed) {
      const step = (n) => { S.hours = Math.max(1, Math.min(4, S.hours + n)); list.querySelectorAll('.cab-stu.abs .mark').forEach((b) => { b.lastChild.textContent = `Н, ${S.hours} ч`; }); sync(); };
      $(el, '#tcMinus').onclick = () => step(-1); $(el, '#tcPlus').onclick = () => step(1);
      save.onclick = () => act(save, async () => {
        const d = curDate();
        // перед записью ещё раз смотрим, не внёс ли кто-то то же самое
        const fresh = await q(sb.from('absences').select('student_id, subject').eq('group_id', gid).eq('date', d));
        const have = new Set(fresh.filter((a) => norm(a.subject) === norm(pk.subject)).map((a) => a.student_id));
        const ids = [...S.marks].filter((id) => !have.has(id));
        if (ids.length) await q(sb.from('absences').insert(ids.map((id) => ({ group_id: gid, student_id: id, date: d, subject: pk.subject, hours: S.hours, lesson_kind: role, is_excused: false }))));
        S.marks.clear();
        toast(ids.length ? `Внесено: ${ids.length} ${plural(ids.length, ['пропуск', 'пропуска', 'пропусков'])}.` : 'Эти пропуски уже внесены.', 'ok');
        await loadExisting();
      }, 'Не получилось сохранить пропуски. Проверьте связь и повторите.').then(sync);
    }
  }

  // =====================================================================================================
  // Журнал: оценки
  // =====================================================================================================
  async function grades(el, ctx, params, nav) {
    const pk = curPair(ctx);
    if (!pk) return noPairs(el, ctx, 'journal/grades');
    const day = day0(), gid = pk.gid, closed = isClosed(ctx, gid), role = ctx.teacherRole;
    if (!S.gdate) S.gdate = day;
    const stu = await q(sb.from('students').select('id, last_name, first_name').eq('group_id', gid));
    if (!nav.isCurrent()) return;
    stu.sort(byName);
    put(el, h`${jhead(ctx)}<div id="tcSeg"></div>${closedNote(ctx, gid)}${pickHtml(ctx)}
      <div id="tcMode"></div>
      <div class="j2-row"><label class="j2-field"><span>Тема отметки</span><input id="tcTopic" type="text" maxlength="120" autocomplete="off" ${closed ? 'disabled' : ''}></label>
      <label class="j2-field"><span>Дата</span><input id="tcDate" type="date" ${closed ? 'disabled' : ''}></label></div>
      <div class="cab-card tc-gcard"><div class="meta"><h3 id="tcGh"></h3><span class="tc-gg">${pk.group}</span></div><div id="tcList"></div></div>
      ${closed ? '' : h`<button type="button" class="j2-btn primary" id="tcSave">Сохранить отметки</button>`}
      <p class="cab-note">Отметки сразу видны студенту. Ставить можно только ${kindWord(ctx)}, по своей дисциплине. Пустая отметка убирает ранее поставленную.</p>`);
    jtabs($(el, '#tcSeg'), 'journal/grades'); bindPick(el);
    const list = $(el, '#tcList'), save = $(el, '#tcSave'), topicI = $(el, '#tcTopic'), dateI = $(el, '#tcDate');
    topicI.value = S.topic; dateI.value = S.gdate;
    const OPT10 = [['', '—'], ...Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)])], OPTP = [['', '—'], ['p', 'зачтено'], ['n', 'не зачтено']];
    const enc = (r) => (r.value != null ? String(r.value) : r.passed === true ? 'p' : r.passed === false ? 'n' : '');
    const fits = (v) => (S.mode === '10' ? /^\d+$/.test(v) : v === 'p' || v === 'n');
    let ex = new Map(), vals = new Map(), seq = 0;     // ex: уже сохранённые отметки (student_id → строка), vals: выбор на экране
    const gh = () => { $(el, '#tcGh').textContent = S.topic.trim() ? `Отметки: ${S.topic.trim()}` : 'Отметки'; };
    function paint() {
      const opts = S.mode === '10' ? OPT10 : OPTP;
      put(list, h`${stu.map((s) => h`<div class="tc-gr"><b>${Cab.initials(s)}</b><select class="tc-sel" data-s="${s.id}" aria-label="Отметка: ${Cab.initials(s)}" ${closed ? 'disabled' : ''}>${opts.map(([v, t]) => h`<option value="${v}" ${(vals.get(s.id) || '') === v ? 'selected' : ''}>${t}</option>`)}</select></div>`)}`);
      Cab.segmented($(el, '#tcMode'), [{ value: '10', label: '1–10' }, { value: 'pass', label: 'зачтено / не зачтено' }], S.mode, (v) => {
        S.mode = v; vals.forEach((x, k) => { if (!fits(x)) vals.set(k, ''); }); paint();
      });
      gh();
    }
    async function loadExisting() {
      const my = ++seq, topic = norm(S.topic);
      const rows = (await q(sb.from('grades').select('id, student_id, value, passed, comment').eq('group_id', gid).eq('subject', pk.subject).eq('lesson_kind', role).eq('lesson_date', S.gdate || day)))
        .filter((r) => norm(r.comment) === topic);
      if (my !== seq || !nav.isCurrent()) return;
      ex = new Map(rows.map((r) => [r.student_id, r]));
      if (rows.length && rows.every((r) => r.value == null)) S.mode = 'pass'; else if (rows.length) S.mode = '10';
      vals = new Map(rows.map((r) => [r.student_id, enc(r)]));
      paint();
    }
    const later = (p) => p.catch((e) => toast(Cab.rpcText(e), 'err'));
    paint(); later(loadExisting());
    list.onchange = (e) => { const s = e.target.closest('select[data-s]'); if (s) vals.set(s.dataset.s, s.value); };
    topicI.oninput = () => { S.topic = topicI.value; gh(); };
    topicI.onchange = () => later(loadExisting());
    dateI.onchange = () => { S.gdate = dateI.value || day; later(loadExisting()); };
    if (save) save.onclick = () => act(save, async () => {
      const topic = S.topic.trim(), date = S.gdate || day, ops = [];
      const body = (v) => (v === 'p' || v === 'n' ? { value: null, passed: v === 'p' } : { value: Number(v), passed: null });
      stu.forEach((s) => {
        const v = vals.get(s.id) || '', old = ex.get(s.id);
        if (!v) { if (old) ops.push(q(sb.from('grades').delete().eq('id', old.id).select('id'))); return; }
        if (!old) ops.push(q(sb.from('grades').insert({ group_id: gid, student_id: s.id, subject: pk.subject, lesson_kind: role, lesson_date: date, comment: topic || null, ...body(v) })));
        else if (enc(old) !== v) ops.push(q(sb.from('grades').update(body(v)).eq('id', old.id).select('id')));
      });
      if (!ops.length) { toast('Изменений нет.'); return; }
      await Promise.all(ops);
      toast(`Сохранено: ${ops.length} ${plural(ops.length, ['отметка', 'отметки', 'отметок'])}.`, 'ok');
      await loadExisting();
    }, 'Не получилось сохранить отметки: сервер не разрешил или нет связи.');
  }

  // =====================================================================================================
  // Задания
  // =====================================================================================================
  const TYPES = [{ v: 'ПЗ', k: 'homework', t: 'Домашка, ПЗ' }, { v: 'УСР', k: 'homework', t: 'Домашка, УСР' },
    { v: 'deadline', k: 'deadline', t: 'Дедлайн' }, { v: 'zachet', k: 'deadline', t: 'Зачёт' }, { v: 'exam', k: 'deadline', t: 'Экзамен' }];
  const typeText = (x) => (TYPES.find((y) => y.v === x.type && y.k === x.kind) || { t: x.kind === 'homework' ? 'Домашка' : 'Дедлайн' }).t;
  const AUD = ['Вся группа', 'Подгруппа 1', 'Подгруппа 2'];
  const subjOf = (ctx, gid) => [...new Set(ctx.assignments.filter((a) => a.group_id === gid).map((a) => a.subject))].sort((a, b) => a.localeCompare(b, 'ru'));

  async function tasks(el, ctx, params, nav) {
    const day = day0(), gids = ctx.groups.map((g) => g.id), many = ctx.groups.length > 1;
    const rows = (await q(sb.from('tasks').select('id, kind, rec, created_by, group_id').in('group_id', gids))).map((r) => ({ ...Cab.task(r), gid: r.group_id }));
    if (!nav.isCurrent()) return;
    const own = (x) => x.createdBy === ctx.uid;
    const cmp = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
    const live = rows.filter((x) => !x.due || x.due >= day).sort(cmp), past = rows.filter((x) => x.due && x.due < day).sort((a, b) => cmp(b, a)).slice(0, 10);
    const canWrite = ctx.groups.some((g) => g.status === 'active');
    const card = (x, old) => { const d = Cab.due(x.due), ro = isClosed(ctx, x.gid); return h`<article class="cab-card ${old ? 'tc-old' : ''}"><div class="meta"><h3>${x.subject || 'Без предмета'}</h3><span class="st c-${d.cls}">${d.text}</span></div>
      <p>${typeText(x)}${own(x) ? ', внесли вы' : ', от старосты'}${many ? ', ' + grp(ctx, x.gid).name : ''}${x.subgroup ? ', подгруппа ' + x.subgroup : ''}${x.due ? ', до ' + Cab.dateText(x.due) : ''}</p>
      ${x.text ? h`<p class="tc-text">${x.text}</p>` : ''}
      ${ro ? '' : h`<div class="cab-actions"><button type="button" class="j2-btn small" data-e="${x.id}" aria-label="Изменить: ${x.subject}">Изменить</button><button type="button" class="j2-btn small danger" data-d="${x.id}" aria-label="Отменить: ${x.subject}">Отменить</button></div>`}</article>`; };
    put(el, h`${head({ href: '#/home', text: 'Главная' }, roleText(ctx), 'Задания')}
      ${ctx.groups.map((g) => closedNote(ctx, g.id))}
      ${canWrite ? h`<button type="button" class="j2-btn primary" id="tcAdd"><span class="cab-ico sm">${icon.plus}</span>Добавить домашку или дедлайн</button>` : ''}
      <div id="tcSeg"></div><div id="tcTasks"></div>
      <p class="cab-note">Отменять можно свои задания и задания старосты по своей дисциплине.</p>`);
    const box = $(el, '#tcTasks');
    const paint = () => {
      const f = (x) => S.taskFilter === 'all' || (S.taskFilter === 'mine') === own(x);
      const a = live.filter(f), b = past.filter(f);
      put(box, h`${a.length ? a.map((x) => card(x)) : h`<p class="cab-empty">Нет заданий</p>`}${b.length ? h`<h2 class="cab-h2">Прошедшие</h2>${b.map((x) => card(x, true))}` : ''}`);
    };
    Cab.segmented($(el, '#tcSeg'), [{ value: 'all', label: 'Все' }, { value: 'mine', label: 'Мои' }, { value: 'headman', label: 'От старосты' }], S.taskFilter, (v) => { S.taskFilter = v; paint(); });
    paint();
    const add = $(el, '#tcAdd');
    if (add) add.onclick = () => act(add, () => taskSheet(ctx, null));
    box.onclick = (e) => {
      const b = e.target.closest('button[data-e], button[data-d]'); if (!b) return;
      const x = rows.find((r) => r.id === (b.dataset.e || b.dataset.d));
      act(b, async () => {
        if (b.dataset.e) { await taskSheet(ctx, x); return; }
        if (!(await confirmSheet('Отменить задание?', `${x.subject || 'Без предмета'}${x.text ? ': ' + x.text.slice(0, 80) : ''}`, 'Отменить задание'))) return;
        let n = 0;
        try { n = (await q(sb.from('tasks').delete().eq('id', x.id).select('id'))).length; } catch (err) { console.warn('[teacher] task delete', err); }
        toast(n ? 'Задание отменено.' : 'Нельзя отменить это задание', n ? 'ok' : 'err');
        Cab.rerender();
      });
    };
  }

  // Форма задания: row = null — новое, иначе правка (вид «домашка/дедлайн» при правке не меняется: id и kind связаны)
  async function taskSheet(ctx, row) {
    const open = ctx.groups.filter((g) => g.status === 'active');
    const gid0 = row ? row.gid : open[0].id;
    const types = row ? TYPES.filter((x) => x.k === row.kind) : TYPES;
    const subsFor = (gid) => { const s = subjOf(ctx, gid); return row && row.subject && !s.includes(row.subject) ? [...s, row.subject] : s; };
    const s = sheet(row ? 'Изменить задание' : 'Новое задание', h`${!row && open.length > 1 ? h`<label class="j2-field"><span>Группа</span><select id="tfG">${open.map((g) => h`<option value="${g.id}">${g.name}</option>`)}</select></label>` : ''}
      <label class="j2-field"><span>Что</span><select id="tfT">${types.map((x) => h`<option value="${x.v}">${x.t}</option>`)}</select></label>
      <label class="j2-field"><span>Предмет</span><select id="tfS"></select></label>
      <label class="j2-field"><span>Текст</span><textarea id="tfX" maxlength="500" rows="3"></textarea></label>
      <div class="j2-row"><label class="j2-field"><span>Срок</span><input id="tfD" type="date"></label>
      <label class="j2-field"><span>Кому</span><select id="tfA">${AUD.map((x, i) => h`<option value="${i}">${x}</option>`)}</select></label></div>
      <div class="j2-msg err" id="tfM" role="alert"></div>
      <button class="j2-btn primary" type="button" id="tfOk">Сохранить</button><button class="j2-btn" type="button" id="tfNo">Отмена</button>`);
    const g = (id) => $(s.el, id);
    const curG = () => (g('#tfG') ? g('#tfG').value : gid0);
    const fillSubj = (keep) => { g('#tfS').innerHTML = str(h`${subsFor(curG()).map((x) => h`<option value="${x}">${x}</option>`)}`); if (keep) g('#tfS').value = keep; };
    fillSubj(row && row.subject);
    if (g('#tfG')) g('#tfG').onchange = () => fillSubj();
    if (row) { g('#tfT').value = types.some((x) => x.v === row.type) ? row.type : types[0].v; g('#tfX').value = row.text; g('#tfD').value = row.due || ''; g('#tfA').value = String(row.subgroup); }
    g('#tfNo').onclick = s.close;
    const ok = g('#tfOk');
    ok.onclick = () => act(ok, async () => {
      const m = g('#tfM'); m.textContent = '';
      const ty = TYPES.find((x) => x.v === g('#tfT').value), subject = g('#tfS').value.trim(), text = g('#tfX').value.trim(), due = g('#tfD').value;
      if (!subject) { m.textContent = 'У вас нет предметов в этой группе.'; return; }
      if (!text) { m.textContent = 'Напишите, что задано.'; return; }
      if (!due) { m.textContent = 'Укажите срок.'; return; }
      const part = { subject, type: ty.v, text, dueDate: due, subgroup: Number(g('#tfA').value) };
      if (row) {
        let n = 0;
        try { n = (await q(sb.from('tasks').update({ rec: { ...row.raw.rec, ...part } }).eq('id', row.id).select('id'))).length; } catch (err) { console.warn('[teacher] task update', err); }
        if (!n) { m.textContent = 'Нельзя изменить это задание.'; return; }
      } else {
        const id = `${ty.k === 'homework' ? 'hw' : 'dl'}-${Date.now()}`;
        await q(sb.from('tasks').insert({ id, kind: ty.k, rec: { id, ...part, createdAt: new Date().toISOString() }, group_id: curG() }));
      }
      s.close(); toast(row ? 'Задание изменено.' : 'Задание добавлено.', 'ok'); Cab.rerender();
    });
  }

  // =====================================================================================================
  // Тесты (заглушка) и чат
  // =====================================================================================================
  function tests(el, ctx) {
    put(el, h`${head(null, roleText(ctx), 'Тесты')}
      <div class="cab-card"><h3>Тесты появятся в следующем обновлении</h3><p>Пока доступны журнал, задания и чат со старостой.</p></div>`);
  }
  function chat(el, ctx) {
    if (!window.ChatUI) { put(el, h`${head({ href: '#/home', text: 'Главная' }, roleText(ctx), 'Чат')}<div class="cab-card"><h3>Чат недоступен</h3><p>Не удалось загрузить модуль чата. Обновите страницу.</p></div>`); return; }
    el.innerHTML = '';
    return window.ChatUI.mount(el, { sb, ctx, role: 'teacher' });
  }

  // main общий для всех экранов: обработчики прошлого экрана снимаем перед отрисовкой нового
  const R = (fn) => ({ render: (el, ...a) => { el.onclick = el.onchange = null; return fn(el, ...a); } });
  const clip = Cab.raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 4h6v2H9zM9 13l2 2 4-4"/></svg>');
  const tab = (id, label, ico) => ({ id, label, icon: ico, path: id });
  Cab.start({
    kind: 'teacher', start: 'home',
    tabs: [tab('home', 'Главная', icon.home), tab('journal', 'Журнал', icon.journal), tab('tests', 'Тесты', clip), tab('chat', 'Чат', icon.chat)],
    routes: {
      home: R(home), groups: { ...R(groups), tab: 'home' }, tasks: { ...R(tasks), tab: 'home' },
      journal: R(lessons), 'journal/attendance': R(attendance), 'journal/grades': R(grades),
      tests: R(tests), chat: R(chat),
    },
  });
})();
