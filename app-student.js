// «Журнал 2.0», этап 2: кабинет студента (app.html). Данные читаются под токеном студента, права решает RLS.
// Экраны: главная, расписание, учёба (и её разделы), профиль (и пропуски), уведомления. Оболочка и роутер: cab-core.js.
'use strict';
(function () {
  const { h, raw, str, q, rpc, sb } = Cab;
  const esc = J2.esc;

  // ---------- мелкие помощники ----------
  const p2 = (n) => String(n).padStart(2, '0');
  const hmOf = (ms) => { const m = Cab.minsk(ms); return `${p2(m.hh)}:${p2(m.mm)}`; };      // время по Минску
  const isoOf = (ms) => Cab.minsk(ms).iso;
  const MIN = ['минута', 'минуты', 'минут'];
  const mins = (n) => `${n} ${Cab.plural(n, MIN)}`;
  const hrs = (n) => `${Cab.num(n)} ${Number.isInteger(+n) ? Cab.plural(+n, ['час', 'часа', 'часов']) : 'часа'}`;
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // Второстепенные данные не должны ронять экран: ошибка → null, экран покажет спокойную строку
  const soft = (p) => p.catch((e) => { console.warn('[st]', e); return null; });
  const put = (el, nav, html) => { if (nav.isCurrent()) el.innerHTML = str(html); return nav.isCurrent(); };
  const sgOf = (ctx) => Number(ctx.student.subgroup) || 0;                                  // 0 — подгруппа не выбрана
  const mine = (ctx) => (l) => !l.subgroup || !sgOf(ctx) || Number(l.subgroup) === sgOf(ctx);
  const banner = (ctx) => (ctx.closed ? h`<div class="j2-card warn" role="status"><h2>Журнал закрыт: только просмотр</h2></div>` : '');
  const chev = h`<span class="cab-ico sm" aria-hidden="true">${Cab.icon.chev}</span>`;

  // Ссылки в тексте задания: сначала экранируем всё, потом оборачиваем только http(s)-адреса
  function linkify(text) {
    const s = String(text == null ? '' : text), re = /https?:\/\/[^\s<>"']+/g;
    let out = '', i = 0, m;
    while ((m = re.exec(s))) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      out += esc(s.slice(i, m.index)) + `<a class="st-a" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
      i = m.index + url.length; re.lastIndex = i;                                           // хвостовая пунктуация остаётся текстом
    }
    return raw(out + esc(s.slice(i)));
  }
  // «3–4 ноября», «28 октября», «30 октября – 2 ноября»
  function period(a, b) {
    if (!a) return '';
    if (!b || b === a) return Cab.dateText(a);
    const [, m1, d1] = a.split('-').map(Number), [, m2, d2] = b.split('-').map(Number);
    return m1 === m2 ? `${d1}–${d2} ${Cab.MONTHS[m1 - 1]}` : `${Cab.dateText(a)} – ${Cab.dateText(b)}`;
  }
  Cab.st = { linkify, period, hrs };                                                        // для проверок

  // ---------- акцентный цвет: хранится в localStorage, применяется на всех экранах ----------
  const ACCENTS = [['#C6F432', 'Лайм'], ['#A78BFA', 'Фиолетовый'], ['#FFB347', 'Оранжевый'], ['#78A0FF', 'Синий'], ['#FF8CBE', 'Розовый']];
  let accent = ACCENTS[0][0];
  function setAccent(c, save) {
    if (!ACCENTS.some((a) => a[0] === c)) return;
    accent = c; document.documentElement.style.setProperty('--j-lime', c);
    if (save) lsSet('j2_accent', c);
  }
  setAccent(lsGet('j2_accent'));

  // ---------- данные ----------
  const loadLessons = (ctx, from, to) => q(sb.from('schedule_lessons')
    .select('lesson_date,pair_no,starts_at,ends_at,subject,kind,teacher,room,subgroup,prev_room,changed_at')
    .eq('group_id', ctx.group.id).gte('lesson_date', from).lte('lesson_date', to).order('lesson_date').order('starts_at'));
  const loadTasks = async (ctx) => (await q(sb.from('tasks').select('id,kind,rec,created_by').eq('group_id', ctx.group.id))).map(Cab.task);
  const unreadCount = async (ctx) => {
    const { count, error } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ctx.uid).is('read_at', null);
    if (error) throw new Error(error.message);
    return count || 0;
  };
  // часы пропусков для кольца: идут неуважительные (порог деканата считается по ним)
  async function absStats(ctx) {
    const x = await soft(rpc('absence_hours_my', { p_group: ctx.group.id })), r = Array.isArray(x) ? x[0] : x;
    if (!r) return null;
    return { v: Number(r.unexcused != null ? r.unexcused : r.total) || 0, excused: Number(r.excused) || 0, unexcused: Number(r.unexcused) || 0,
      warn: Number(r.warn_hours != null ? r.warn_hours : ctx.group.warn_hours), dean: Number(r.dean_hours != null ? r.dean_hours : ctx.group.dean_hours) };
  }
  const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');
  const taskRoute = (t) => (t.isExam ? 'study/exams' : t.kind === 'deadline' ? 'study/deadlines' : 'study/homework');
  const typeLabel = (t) => ({ zachet: 'Зачёт', exam: 'Экзамен', deadline: 'Дедлайн', '': t.kind === 'deadline' ? 'Дедлайн' : 'Домашка' }[t.type] || t.type);

  // ---------- общие куски разметки ----------
  // Текст под кольцом пропусков
  function absText(s) {
    if (s.v >= s.dean) return 'Порог деканата достигнут';
    const left = `до деканата ${hrs(s.dean - s.v)}`;
    return s.v >= s.warn ? `Порог предупреждения превышен, ${left}` : `До предупреждения ${hrs(s.warn - s.v)}, ${left}`;
  }
  function absCard(s, link) {
    const open = raw(link ? '<a class="cab-ringcard" href="#/profile/absences">' : '<div class="cab-ringcard">'), end = raw(link ? '</a>' : '</div>');
    if (!s) return h`${open}<div><h3>Пропуски</h3><p>Не удалось загрузить часы пропусков</p></div>${link ? chev : ''}${end}`;
    return h`${open}<div class="ringwrap">${Cab.ring(s.v, s.dean, 84)}<div class="ringnum" aria-hidden="true"><b>${Cab.num(s.v)}</b>из ${Cab.num(s.dean)} ч</div></div>
      <div style="flex:1;min-width:0"><h3>Пропуски</h3><p>${absText(s)}</p></div>${link ? chev : ''}${end}`;
  }
  // Лента пар дня. nowMin — минуты «сейчас» для сегодняшнего дня, иначе null
  function lessonItems(ls, nowMin) {
    let end = null;
    return ls.map((l) => {
      const s = Cab.toMin(l.starts_at), e = Cab.toMin(l.ends_at);
      const st = nowMin == null ? '' : nowMin >= e ? 'past' : nowMin >= s ? 'now' : '';
      const gap = end == null ? 0 : s - end; end = Math.max(end == null ? 0 : end, e);
      const pct = Math.max(0, Math.min(100, Math.round(((nowMin - s) / (e - s)) * 100)));
      const kind = Cab.KIND[l.kind] || 'Занятие';
      const note = st === 'past' ? ', прошла' : st === 'now' ? `, идёт, ещё ${mins(e - nowMin)}` : '';
      return h`${gap > 0 ? h`<li class="cab-break">перемена ${mins(gap)}</li>` : ''}<li class="cab-lesson ${st}"><div class="t">${Cab.hm(l.starts_at)}<small>${Cab.hm(l.ends_at)}</small></div>
        <div><div class="n">${l.subject}</div><div class="k">${kind}${note}${l.prev_room && l.prev_room !== l.room ? h`, <span class="warn">аудитория сменилась</span>` : ''}</div></div>
        ${l.room ? h`<div class="r"><small>ауд.</small> ${l.room}</div>` : raw('<div></div>')}
        ${st === 'now' ? h`<div class="bar" role="progressbar" aria-label="Прошло ${pct}% пары" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>` : ''}</li>`;
    });
  }
  // Нижний лист с подробностями (преподаватель): фон страницы закрыт inert, Esc и тап по фону закрывают
  function sheet(title, body) {
    const back = document.activeElement, root = document.getElementById('cab'), m = document.createElement('div');
    m.className = 'cab-modal';
    m.innerHTML = str(h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="stSheetT"><h2 class="st-sh-t" id="stSheetT">${title}</h2>${body}<button class="j2-btn" type="button">Закрыть</button></div>`);
    const key = (e) => { if (e.key === 'Escape') close(); };
    function close() { m.remove(); root.inert = false; document.removeEventListener('keydown', key); window.removeEventListener('hashchange', close); if (back && back.focus) back.focus(); }
    m.onclick = (e) => { if (e.target === m) close(); };
    m.querySelector('button').onclick = close;
    document.body.appendChild(m); root.inert = true;
    document.addEventListener('keydown', key); window.addEventListener('hashchange', close);
    m.querySelector('button').focus();
  }

  // ---------- главная ----------
  async function home(el, ctx, nav) {
    const now = Cab.minsk(), today = now.iso;
    const [lessons, stats, tasks, unread] = await Promise.all([loadLessons(ctx, today, today), absStats(ctx), soft(loadTasks(ctx)), soft(unreadCount(ctx))]);
    const ls = lessons.filter(mine(ctx));
    // «расписания нет совсем» отличаем от «сегодня пар нет»
    const noData = !ls.length && !(await soft(q(sb.from('schedule_lessons').select('lesson_date').eq('group_id', ctx.group.id).limit(1))) || []).length;
    const fire = (tasks || []).filter((t) => t.due && t.due >= today && Cab.taskVisible(t, sgOf(ctx))).sort(byDue).slice(0, 3);
    const badge = unread ? (unread > 99 ? '99+' : unread) : '';
    put(el, nav, h`<div class="st-home">${banner(ctx)}
      <div class="cab-head"><div><h1 class="cab-title">${Cab.dateText(today)}</h1><p class="cab-sub">${Cab.DOW[now.dow]}, ${ctx.group.name}</p></div>
        <div class="st-hr"><a class="cab-bell" href="#/notifications" aria-label="${unread ? `Уведомления, новых: ${unread}` : 'Уведомления'}"><span class="cab-ico">${Cab.icon.bell}</span>${badge ? h`<span class="cab-badge" aria-hidden="true">${badge}</span>` : ''}</a>
        <a class="cab-link" href="#/schedule">Вся неделя ${chev}</a></div></div>
      ${ls.length ? h`<ul class="cab-lessons">${lessonItems(ls, now.minutes)}</ul>`
        : noData ? h`<div class="j2-card"><h2>Расписание ещё не загружено</h2><p>Оно появится после загрузки с bseu.by.</p></div>`
        : h`<div class="j2-card"><h2>Сегодня пар нет</h2></div>`}
      ${absCard(stats, true)}
      <div class="cab-h2"><span>Горит</span><a href="#/study/homework">Все задания ${chev}</a></div>
      ${!tasks ? h`<p class="cab-note">Задания не загрузились. Обновите страницу.</p>`
        : !fire.length ? h`<p class="cab-note">Горящих заданий нет.</p>`
        : h`<div class="cab-tiles">${fire.map((t) => { const d = Cab.due(t.due);
          return h`<a class="cab-tile ${d.cls === 'mute' ? '' : d.cls}" href="#/${taskRoute(t)}"><div><b class="st-clamp">${t.subject || 'Без предмета'}</b><small class="st-clamp">${typeLabel(t)}${t.text ? ', ' + one(t.text) : ''}</small></div><span class="when">${d.text}</span></a>`; })}</div>`}</div>`);
    Cab.autoRefresh = () => true;
  }

  // ---------- расписание ----------
  async function schedule(el, ctx, nav) {
    const now = Cab.minsk(), today = now.iso, sg = sgOf(ctx);
    let mon = Cab.mondayOf(now.dow === 6 ? Cab.addDays(today, 1) : today), sel = null, rows = [], any = true;     // в воскресенье показываем следующую неделю
    const [meta, tasks] = await Promise.all([soft(q(sb.from('schedule_meta').select('last_import_at').eq('group_id', ctx.group.id).maybeSingle())), soft(loadTasks(ctx))]);
    const hw = (tasks || []).filter((t) => t.kind === 'homework' && !t.isExam && t.due && Cab.taskVisible(t, sg));
    const hasHw = (l) => hw.some((t) => t.due >= l.lesson_date && one(t.subject).toLowerCase() === one(l.subject).toLowerCase());
    async function load() {
      rows = (await loadLessons(ctx, mon, Cab.addDays(mon, 5))).filter(mine(ctx));
      any = rows.length > 0 || ((await soft(q(sb.from('schedule_lessons').select('lesson_date').eq('group_id', ctx.group.id).limit(1)))) || []).length > 0;
      const days = [0, 1, 2, 3, 4, 5].map((i) => Cab.addDays(mon, i));
      sel = days.includes(today) ? today : days[0];
    }
    await load();
    const upd = !meta || !meta.last_import_at ? 'Расписание ещё не обновлялось'
      : (() => { const ms = Date.parse(meta.last_import_at), d = Cab.dayDiff(isoOf(ms), today); return `Обновлено с bseu.by ${d === 0 ? 'сегодня' : d === 1 ? 'вчера' : Cab.dateText(isoOf(ms))} в ${hmOf(ms)}`; })();
    const rangeOf = () => { const sat = Cab.addDays(mon, 5), d1 = +mon.slice(8), d2 = +sat.slice(8); return mon.slice(5, 7) === sat.slice(5, 7) ? `${d1}–${d2} ${Cab.MONTHS[+mon.slice(5, 7) - 1]}` : `${Cab.dateShort(mon)} – ${Cab.dateShort(sat)}`; };   // считается при каждой отрисовке: неделя переключается
    const wkBtn = (id, label, icon) => h`<button class="j2-back" id="${id}" type="button" aria-label="${label}"><span class="cab-ico sm">${icon}</span></button>`;

    function draw() {
      const day = rows.filter((l) => l.lesson_date === sel), isToday = sel === today;
      const items = day.map((l, i) => {
        const s = Cab.toMin(l.starts_at), e = Cab.toMin(l.ends_at), n = now.minutes;
        const st = !isToday ? '' : n >= e ? 'past' : n >= s ? 'now' : '';
        const when = !isToday ? '' : st === 'past' ? ', прошла' : st === 'now' ? ', идёт сейчас' : ', дальше';
        return h`<li><button type="button" class="cab-lesson st-btn st-two ${st}" data-i="${i}"><div class="t">${Cab.hm(l.starts_at)}<small>${Cab.hm(l.ends_at)}</small></div>
          <div><div class="n">${l.subject}</div><div class="k">${Cab.KIND[l.kind] || 'Занятие'}${l.room ? ', ауд. ' + l.room : ''}${when}</div>
          ${hasHw(l) ? h`<div class="k st-hw">Есть домашка</div>` : ''}
          ${l.prev_room && l.prev_room !== l.room ? h`<div class="k warn">Аудитория изменилась, была ${l.prev_room}</div>` : ''}</div></button></li>`;
      });
      el.innerHTML = str(h`${banner(ctx)}
        <div class="cab-head"><h1 class="cab-title">Расписание</h1></div>
        <div class="st-wk">${wkBtn('wkPrev', 'Предыдущая неделя', Cab.icon.back)}<b aria-live="polite">${rangeOf()}</b>${wkBtn('wkNext', 'Следующая неделя', Cab.icon.chev)}</div>
        <div class="cab-days" role="tablist" aria-label="Дни недели">${[0, 1, 2, 3, 4, 5].map((i) => { const d = Cab.addDays(mon, i);
          return h`<button type="button" role="tab" class="cab-day" id="day-${d}" data-d="${d}" aria-selected="${String(d === sel)}" tabindex="${d === sel ? 0 : -1}" ${d === today ? raw('aria-current="date"') : ''}>${Cab.DOW_S[i]}<b>${+d.slice(8)}</b></button>`; })}</div>
        <p class="st-upd">${upd === 'Расписание ещё не обновлялось' ? '' : h`<span class="cab-ico sm" aria-hidden="true">${Cab.icon.check}</span>`}${upd}</p>
        <div role="tabpanel" aria-labelledby="day-${sel}">${items.length ? h`<ul class="cab-lessons">${items}</ul>`
          : !any ? h`<div class="j2-card"><h2>Расписание ещё не загружено</h2><p>Оно появится после загрузки с bseu.by.</p></div>`
          : h`<div class="j2-card"><h2>${isToday ? 'Сегодня пар нет' : 'В этот день пар нет'}</h2></div>`}</div>
        <p class="cab-note">Данные с bseu.by. Сверяйте с деканатом.</p>`);
      const days = el.querySelector('.cab-days');
      const pick = (d, focus) => { sel = d; draw(); if (focus) el.querySelector(`[data-d="${d}"]`).focus(); };
      days.onclick = (e) => { const b = e.target.closest('[data-d]'); if (b) pick(b.dataset.d); };
      days.onkeydown = (e) => {                                                            // стрелки переключают день, как у вкладок
        const i = [...days.children].findIndex((b) => b.dataset.d === sel), k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (k) { e.preventDefault(); pick(days.children[(i + k + 6) % 6].dataset.d, true); }
      };
      const go = async (n) => {
        const prev = mon; mon = Cab.addDays(mon, n * 7);
        try { await load(); } catch (err) { mon = prev; Cab.toast('Не удалось загрузить неделю. Повторите.', 'err'); return; }
        if (nav.isCurrent()) { draw(); el.querySelector(n < 0 ? '#wkPrev' : '#wkNext').focus(); }
      };
      el.querySelector('#wkPrev').onclick = () => go(-1);
      el.querySelector('#wkNext').onclick = () => go(1);
      el.querySelector('.cab-lessons') && (el.querySelector('.cab-lessons').onclick = (e) => {
        const b = e.target.closest('[data-i]'); if (!b) return;
        const l = day[+b.dataset.i];
        sheet(l.subject, h`<p class="cab-note">${Cab.KIND[l.kind] || 'Занятие'} · ${Cab.dateText(l.lesson_date)}, ${Cab.hm(l.starts_at)}–${Cab.hm(l.ends_at)}</p>
          <div class="cab-kv"><span>Преподаватель</span><b>${l.teacher || 'не указан'}</b></div>
          <div class="cab-kv"><span>Аудитория</span><b>${l.room || 'не указана'}</b></div>
          ${l.prev_room && l.prev_room !== l.room ? h`<div class="cab-kv"><span>Была</span><b class="c-amber">${l.prev_room}</b></div>` : ''}
          ${l.subgroup ? h`<div class="cab-kv"><span>Подгруппа</span><b>${l.subgroup}</b></div>` : ''}`);
      });
    }
    if (nav.isCurrent()) draw();
  }

  // ---------- учёба ----------
  const hubRow = (href, cls, title, sub, cnt) => h`<a class="cab-row ${cls}" href="${href}"><span><b>${title}</b><small>${sub}</small></span><span style="display:flex;align-items:center;gap:8px">${cnt == null ? '' : h`<span class="cnt">${cnt}</span>`}<span class="cab-ico" aria-hidden="true">${Cab.icon.chev}</span></span></a>`;
  async function study(el, ctx, nav) {
    const tasks = await soft(loadTasks(ctx)), today = Cab.minsk().iso;
    const active = (kind) => tasks ? tasks.filter((t) => t.kind === kind && !t.isExam && Cab.taskVisible(t, sgOf(ctx)) && (!t.due || t.due >= today)).length : null;
    put(el, nav, h`${banner(ctx)}<h1 class="cab-title">Учёба</h1><p class="cab-sub">Предметы, задания, сессия</p>
      ${hubRow('#/study/homework', 't-lime', 'Домашки и УСР', 'Все задания и архив', active('homework'))}
      ${hubRow('#/study/deadlines', 't-amber', 'Дедлайны', 'Все сроки', active('deadline'))}
      ${hubRow('#/study/exams', 't-mint', 'Зачёты и экзамены', 'Даты и формы контроля')}
      ${hubRow('#/study/grades', 't-blue', 'Оценки', 'Средний балл появится позже')}
      ${hubRow('index.html#zachetka', 't-pink', 'Рейтинг', 'Калькулятор')}
      ${hubRow('#/study/teachers', 't-violet', 'Преподаватели', 'Лекции и практические')}
      ${hubRow('index.html#games', '', 'Игры', 'Судоку, сапёр, flappy и ещё 2')}`);
  }

  const TASK_SCREENS = {
    homework: { title: 'Домашки и УСР', pick: (t) => t.kind === 'homework' && !t.isExam, empty: 'Домашних заданий пока нет' },
    deadlines: { title: 'Дедлайны', pick: (t) => t.kind === 'deadline' && !t.isExam, empty: 'Дедлайнов пока нет' },
    exams: { title: 'Зачёты и экзамены', pick: (t) => t.isExam, empty: 'Зачётов и экзаменов пока нет' },
  };
  const taskCard = (t, arch) => {
    const d = Cab.due(t.due);
    return h`<article class="cab-card${arch ? ' st-old' : ''}"><div class="meta"><h3>${t.subject || 'Без предмета'}</h3><span class="st ${arch ? 'c-mute' : 'c-' + d.cls}">${arch ? 'срок был' : d.text}</span></div>
      <p>${typeLabel(t)}${t.due ? ' · до ' + Cab.dateText(t.due) : ''}${t.subgroup ? ` · ${t.subgroup} подгруппа` : ''}</p>${t.text ? h`<p class="st-text">${linkify(t.text)}</p>` : ''}</article>`;
  };
  async function taskScreen(el, ctx, nav, key) {
    const cfg = TASK_SCREENS[key], today = Cab.minsk().iso;
    const all = (await loadTasks(ctx)).filter((t) => cfg.pick(t) && Cab.taskVisible(t, sgOf(ctx)));
    const act = all.filter((t) => !t.due || t.due >= today).sort(byDue), old = all.filter((t) => t.due && t.due < today).sort((a, b) => b.due.localeCompare(a.due));
    put(el, nav, h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">${cfg.title}</h1><p class="cab-sub">Активных: ${act.length}</p>
      ${act.length ? act.map((t) => taskCard(t, false)) : h`<div class="cab-empty">${all.length ? 'Активных заданий нет' : cfg.empty}</div>`}
      ${old.length ? h`<details class="st-det"><summary>Архив: ${old.length}</summary>${old.map((t) => taskCard(t, true))}</details>` : ''}`);
  }

  async function grades(el, ctx, nav) {
    const rows = await q(sb.from('grades').select('id,subject,lesson_kind,value,passed,lesson_date,comment').eq('student_id', ctx.student.id).order('lesson_date', { ascending: false }));
    const by = new Map();
    rows.forEach((g) => { const k = g.subject || 'Без предмета'; if (!by.has(k)) by.set(k, []); by.get(k).push(g); });
    const val = (g) => g.value != null ? h`<b class="c-lime"><span class="sr-only">Оценка </span>${g.value}</b>`
      : g.passed === true ? h`<b class="c-mint">зачтено</b>` : g.passed === false ? h`<b class="c-coral">не зачтено</b>` : h`<b class="c-mute">без оценки</b>`;
    put(el, nav, h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Оценки</h1><p class="cab-sub">Ваши отметки по предметам</p>
      ${rows.length ? [...by].map(([subj, gs]) => h`<h2 class="cab-h2"><span>${subj}</span></h2><div class="cab-card">${gs.map((g) =>
        h`<div class="cab-kv"><span>${g.lesson_date ? Cab.dateText(g.lesson_date) : 'без даты'}${g.lesson_kind ? ' · ' + (Cab.KIND[g.lesson_kind] || '') : ''}${g.comment ? h`<small class="c-mute" style="display:block">${g.comment}</small>` : ''}</span>${val(g)}</div>`)}</div>`)
        : h`<div class="cab-empty">Оценок пока нет</div>`}`);
  }

  async function teachers(el, ctx, nav) {
    const rows = (await q(sb.from('schedule_lessons').select('subject,kind,teacher,subgroup').eq('group_id', ctx.group.id).limit(2000))).filter(mine(ctx));
    const by = new Map();
    rows.forEach((l) => {
      if (!l.subject) return;
      const s = by.get(l.subject) || by.set(l.subject, new Map()).get(l.subject);
      if (l.teacher) (s.get(l.kind) || s.set(l.kind, new Set()).get(l.kind)).add(l.teacher);
    });
    const KL = { lecture: 'Лекции', practice: 'Практические', lab: 'Лабораторные', other: 'Занятия' };
    put(el, nav, h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Преподаватели</h1><p class="cab-sub">Лекции и практические</p>
      ${by.size ? [...by].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([subj, ks]) => h`<div class="cab-card"><h3>${subj}</h3>
        <p>${ks.size ? [...ks].map(([k, set]) => `${KL[k] || KL.other}: ${[...set].join(', ')}`).join(' · ') : 'Преподаватель не указан'}</p></div>`)
        : h`<div class="cab-empty">Список появится после загрузки расписания</div>`}`);
  }

  // ---------- профиль ----------
  const CERT = { sick: 'Больничный', statement: 'Заявление', other: 'Другое' };
  const CERT_ST = { received: ['подтверждена', 'c-mint'], waiting: ['не подтверждена', 'c-amber'], none: ['не сдана', 'c-coral'] };
  async function profile(el, ctx, nav) {
    const certs = await soft(q(sb.from('certificates').select('id,kind,date_from,date_to,status').eq('student_id', ctx.student.id).order('date_from', { ascending: false })));
    const s = ctx.student, sg = sgOf(ctx);
    const ini = ((s.last_name || '').charAt(0) + (s.first_name || '').charAt(0)).toUpperCase() || '?';
    if (!put(el, nav, h`${banner(ctx)}<h1 class="cab-title">Профиль</h1>
      <div class="cab-person"><div class="cab-avatar" aria-hidden="true">${ini}</div><div><b>${Cab.fullName(s)}</b><span>Студент, группа ${ctx.group.name}</span></div></div>
      <div class="st-sg"><span id="sgLbl">Подгруппа</span><div class="cab-seg2" id="sgSeg" role="group" aria-labelledby="sgLbl">${[1, 2].map((n) => h`<button type="button" data-sg="${n}" aria-pressed="${String(sg === n)}"${ctx.closed ? raw(' disabled') : ''}>${n}</button>`)}</div></div>
      <h2 class="cab-h2"><span>Мои справки</span></h2>
      ${!certs ? h`<p class="cab-note">Справки не загрузились. Обновите страницу.</p>`
        : !certs.length ? h`<p class="cab-note">Справок пока нет.</p>`
        : certs.map((c) => { const st = CERT_ST[c.status] || CERT_ST.none;
          return h`<div class="cab-kv"><span>${CERT[c.kind] || CERT.other}, ${period(c.date_from, c.date_to)}</span><b class="${st[1]} st-s">${st[0]}</b></div>`; })}
      <nav class="st-tri" aria-label="Мои данные" style="margin-top:14px"><a href="#/profile/absences"><b>Пропуски</b><small>по предметам</small></a><a href="#/study/grades"><b>Оценки</b><small>мои отметки</small></a><a href="index.html#achievements"><b>Достижения</b><small>мои значки</small></a></nav>
      <section class="cab-card" aria-labelledby="thT"><h3 id="thT">Оформление</h3>
        <div class="cab-seg2" role="group" aria-label="Тема"><button type="button" disabled aria-pressed="false" aria-describedby="thNote">Светлая</button><button type="button" aria-pressed="true">Тёмная</button></div>
        <p class="cab-note" id="thNote">Светлая тема появится позже</p>
        <div class="cab-colors" id="stColors" role="group" aria-label="Цвет акцента">${ACCENTS.map(([c, n]) => h`<button type="button" class="cab-color" data-c="${c}" style="background:${c}" aria-label="${n}" aria-pressed="${String(c === accent)}"></button>`)}</div></section>
      <div class="st-grp"><a class="st-line" id="tgRow" href="index.html#profile"><span>Telegram-уведомления</span><span class="c-amber">не привязан</span></a></div>
      ${ctx.isStaff ? h`<a class="cab-row st-staff" href="headman.html"><b>Кабинет старосты</b><span class="c-mute">только у старост</span></a>` : ''}
      <button class="j2-btn danger" id="outBtn" type="button">Выйти</button>`)) return;
    const seg = el.querySelector('#sgSeg');
    seg.onclick = async (e) => {
      const b = e.target.closest('button[data-sg]'); if (!b || seg.dataset.busy) return;
      const n = +b.dataset.sg, prev = sgOf(ctx); if (n === prev) return;
      const mark = (v) => seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.sg === v)));
      mark(n); ctx.student.subgroup = String(n); seg.dataset.busy = '1';                // сразу показываем, при ошибке откатываем
      try { await rpc('student_set_subgroup', { p_subgroup: n }); Cab.toast('Подгруппа сохранена', 'ok'); }
      catch (err) { ctx.student.subgroup = prev ? String(prev) : null; mark(prev); Cab.toast(Cab.rpcText(err), 'err'); }
      finally { delete seg.dataset.busy; }
    };
    const box = el.querySelector('#stColors');
    box.onclick = (e) => {
      const b = e.target.closest('button[data-c]'); if (!b) return;
      setAccent(b.dataset.c, true);
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
    el.querySelector('#outBtn').onclick = () => Cab.signOut();
  }

  async function absences(el, ctx, nav) {
    const [rows, stats] = await Promise.all([q(sb.from('absences').select('id,date,subject,hours,is_excused,lesson_kind').eq('student_id', ctx.student.id).order('date', { ascending: false })), absStats(ctx)]);
    const month = Cab.minsk().iso.slice(0, 7), sum = (f) => rows.filter((r) => f(r) && (r.date || '').slice(0, 7) === month).reduce((a, r) => a + (Number(r.hours) || 0), 0);
    const s = stats || { v: sum((r) => !r.is_excused), excused: sum((r) => r.is_excused), unexcused: sum((r) => !r.is_excused), warn: Number(ctx.group.warn_hours), dean: Number(ctx.group.dean_hours) };
    const by = new Map();
    rows.forEach((r) => { const k = r.subject || 'Без предмета'; if (!by.has(k)) by.set(k, { h: 0, rows: [] }); const g = by.get(k); g.h += Number(r.hours) || 0; g.rows.push(r); });
    put(el, nav, h`${Cab.top({ href: '#/profile', text: 'Профиль' })}<h1 class="cab-title">Пропуски</h1><p class="cab-sub">По предметам</p>
      ${absCard(s, false)}
      <p class="cab-note">Кольцо и итоги: за текущий месяц. Ниже все пропуски по предметам.</p>
      <div class="cab-card"><div class="cab-kv"><span>Неуважительные</span><b class="c-coral">${hrs(s.unexcused)}</b></div><div class="cab-kv"><span>Уважительные</span><b class="c-mint">${hrs(s.excused)}</b></div>
        <div class="cab-kv"><span>Предупреждение с</span><b>${hrs(s.warn)}</b></div><div class="cab-kv"><span>Деканат с</span><b>${hrs(s.dean)}</b></div></div>
      ${rows.length ? [...by].sort((a, b) => b[1].h - a[1].h).map(([subj, g]) => h`<h2 class="cab-h2"><span>${subj}</span><span class="c-mute">${hrs(g.h)}</span></h2><div class="cab-card">${g.rows.map((r) =>
        h`<div class="cab-kv"><span>${r.date ? Cab.dateText(r.date) : 'без даты'}${r.lesson_kind ? ' · ' + (Cab.KIND[r.lesson_kind] || '') : ''}</span><b class="${r.is_excused ? 'c-mint' : 'c-coral'} st-s">${hrs(r.hours || 0)}, ${r.is_excused ? 'уважительная' : 'неуважительная'}</b></div>`)}</div>`)
        : h`<div class="cab-empty">Пропусков нет</div>`}`);
  }

  // ---------- уведомления ----------
  const NTF_GO = { task: (n) => (n.ref && n.ref.kind === 'deadline' ? '#/study/deadlines' : '#/study/homework'), absence: () => '#/profile/absences', certificate: () => '#/profile', grade: () => '#/study/grades', schedule: () => '#/schedule' };
  const NTF_TONE = { task: 'st-coral', schedule: 'st-amber', certificate: 'st-mint', grade: 'st-lime' };
  async function notifications(el, ctx, nav) {
    const list = await q(sb.from('notifications').select('id,kind,title,body,ref,created_at,read_at').eq('user_id', ctx.uid).order('created_at', { ascending: false }).limit(100));
    const today = Cab.minsk().iso, yest = Cab.addDays(today, -1);
    let mode = 'all';
    if (!put(el, nav, h`${Cab.top({ href: '#/home', text: 'Главная' }, Cab.dateText(today))}<h1 class="cab-title">Уведомления</h1><p class="cab-sub" id="ntfSub" aria-live="polite"></p>
      <div id="ntfSeg"></div><div id="ntfList"></div><button class="j2-btn" id="ntfAll" type="button" style="color:var(--j-lime)">Отметить всё прочитанным</button>`)) return;
    const sub = el.querySelector('#ntfSub'), box = el.querySelector('#ntfList'), all = el.querySelector('#ntfAll');
    function fill() {
      const unread = list.filter((n) => !n.read_at).length;
      sub.textContent = unread ? `${unread} ${Cab.plural(unread, ['новое', 'новых', 'новых'])}` : 'Новых нет';
      all.disabled = !unread;
      const shown = mode === 'new' ? list.filter((n) => !n.read_at) : list;
      let cur = null;
      box.innerHTML = shown.length ? str(h`${shown.map((n) => {
        const ms = Date.parse(n.created_at), day = isoOf(ms), label = day === today ? 'Сегодня' : day === yest ? 'Вчера' : Cab.dateText(day);
        const head = label !== cur ? h`<h2 class="cab-h2" style="font-size:15px;color:var(--j-muted)"><span>${label}</span></h2>` : ''; cur = label;
        return h`${head}<a class="cab-ntf ${n.read_at ? '' : 'new ' + (NTF_TONE[n.kind] || '')}" href="${(NTF_GO[n.kind] || (() => '#/home'))(n)}" data-id="${n.id}"><div class="meta"><b>${n.read_at ? '' : h`<span class="sr-only">Новое: </span>`}${n.title}</b><span class="c-mute">${day === today ? hmOf(ms) : Cab.dateShort(day)}</span></div>${n.body ? h`<p>${n.body}</p>` : ''}</a>`;
      })}`) : str(h`<div class="cab-empty">${mode === 'new' ? 'Новых уведомлений нет' : 'Уведомлений пока нет'}</div>`);
    }
    Cab.segmented(el.querySelector('#ntfSeg'), [{ value: 'all', label: 'Все' }, { value: 'new', label: 'Новые' }], mode, (v) => { mode = v; fill(); });
    box.onclick = async (e) => {
      const a = e.target.closest('a[data-id]'); if (!a) return;
      e.preventDefault();
      const n = list.find((x) => x.id === a.dataset.id);
      if (n && !n.read_at) {                                                                 // дождаться записи, иначе счётчик на главной отстанет
        try { await rpc('notifications_mark_read', { p_ids: [n.id] }); n.read_at = new Date().toISOString(); } catch (err) { Cab.toast(Cab.rpcText(err), 'err'); }
      }
      location.hash = a.getAttribute('href');
    };
    all.onclick = async () => {
      if (all.dataset.busy) return; all.dataset.busy = '1';
      try { await rpc('notifications_mark_all_read'); const t = new Date().toISOString(); list.forEach((n) => { n.read_at = n.read_at || t; }); fill(); Cab.toast('Все уведомления прочитаны', 'ok'); }
      catch (err) { Cab.toast(Cab.rpcText(err), 'err'); }
      finally { delete all.dataset.busy; }
    };
    fill();
    Cab.autoRefresh = () => true;
  }

  // ---------- маршруты ----------
  // Автообновление при возврате во вкладку нужно только главной и уведомлениям; остальные его сбрасывают
  const route = (tab, fn) => ({ tab, render: async (el, ctx, params, nav) => { Cab.autoRefresh = null; await fn(el, ctx, nav); } });
  const routes = {
    home: route('home', home), notifications: route('home', notifications),
    schedule: route('schedule', schedule),
    study: route('study', study), 'study/homework': route('study', (e, c, n) => taskScreen(e, c, n, 'homework')),
    'study/deadlines': route('study', (e, c, n) => taskScreen(e, c, n, 'deadlines')), 'study/exams': route('study', (e, c, n) => taskScreen(e, c, n, 'exams')),
    'study/grades': route('study', grades), 'study/teachers': route('study', teachers),
    profile: route('profile', profile), 'profile/absences': route('profile', absences),
  };
  Cab.start({
    kind: 'student', start: 'home', routes,
    tabs: [{ id: 'home', label: 'Главная', icon: Cab.icon.home, path: 'home' }, { id: 'schedule', label: 'Расписание', icon: Cab.icon.calendar, path: 'schedule' },
      { id: 'study', label: 'Учёба', icon: Cab.icon.study, path: 'study' }, { id: 'profile', label: 'Профиль', icon: Cab.icon.user, path: 'profile' }],
  }).catch((e) => { console.error('[st]', e); Cab.fatal('Не получилось открыть журнал. Обновите страницу.'); });
})();
