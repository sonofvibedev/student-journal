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
  // УСР в данных — задание kind='homework' с rec.type='УСР'. Домашки идут отдельно, дедлайны и УСР вместе, зачёты и экзамены в своём разделе.
  const isUsr = (t) => t.kind === 'homework' && String(t.type).trim().toUpperCase() === 'УСР';
  const isHw = (t) => t.kind === 'homework' && !t.isExam && !isUsr(t);
  const isDl = (t) => (t.kind === 'deadline' || isUsr(t)) && !t.isExam;
  Object.assign(Cab.st, { isUsr, isHw, isDl });
  const taskRoute = (t) => (t.isExam ? 'study/exams' : isDl(t) ? 'study/deadlines' : 'study/homework');
  const typeLabel = (t) => {
    if (t.type === 'zachet') return 'Зачёт';
    if (t.type === 'exam') return 'Экзамен';
    if (isUsr(t)) return 'УСР';
    const base = t.kind === 'deadline' ? 'Дедлайн' : 'Домашка';
    return t.type && t.type !== 'deadline' ? base + ', ' + t.type : base;
  };

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
  // Плитка пары: одна разметка для главной и расписания, чтобы они не расходились.
  // o: { st: ''|'past'|'now', note: ', прошла', button: номер пары (кнопка, открывает шторку) или undefined (просто строка),
  //      room: 'col' (крупно справа) | 'line' (в строке под названием), hints: ['Есть домашка', …], bar: процент идущей пары или null }
  function lessonTile(l, o) {
    const kind = Cab.KIND[l.kind] || 'Занятие', sg = Number(l.subgroup) || 0, kd = ['lecture', 'practice', 'lab'].includes(l.kind) ? l.kind : 'other';
    const hints = (o.hints || []).slice();
    const moved = l.prev_room && l.prev_room !== l.room;
    if (moved && o.room !== 'col') hints.push(`Аудитория изменилась, была ${l.prev_room}`);   // на главной места мало: там пометка в строке
    const line = h`${kind}${sg ? h` · <span class="sg">${sg} подгр.<span class="sr-only">, подгруппа ${sg}</span></span>` : ''}${o.room === 'line' && l.room ? ` · ауд. ${l.room}` : ''}${o.note || ''}${moved && o.room === 'col' ? h`, <span class="warn">аудитория сменилась</span>` : ''}`;
    const inner = h`<div class="t">${Cab.hm(l.starts_at)}<small>${Cab.hm(l.ends_at)}</small></div>
      <div><div class="n">${l.subject}</div><div class="k">${line}</div>${hints.map((x, i) => h`<div class="k ${/^Аудитория/.test(x) ? 'warn' : 'st-hw'}">${x}</div>`)}</div>
      ${o.room === 'col' ? (l.room ? h`<div class="r"><small>ауд.</small> ${l.room}</div>` : raw('<div></div>')) : ''}
      ${o.bar != null ? h`<div class="bar" role="progressbar" aria-label="Прошло ${o.bar}% пары" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${o.bar}"><i style="width:${o.bar}%"></i></div>` : ''}`;
    const cls = `cab-lesson kd-${kd} ${o.st || ''}`;
    if (o.button == null) return h`<li class="${cls}">${inner}</li>`;
    const label = [l.subject, Cab.kindLow(l.kind), sg ? `подгруппа ${sg}` : '', `${Cab.hm(l.starts_at)}–${Cab.hm(l.ends_at)}`, l.room ? `аудитория ${l.room}` : '', (o.note || '').replace(/^, /, ''), ...hints].filter(Boolean).join(', ');
    return h`<li><button type="button" class="${cls} st-btn st-two" data-i="${o.button}" aria-label="${label}">${inner}</button></li>`;
  }
  // Лента пар дня. nowMin — минуты «сейчас» для сегодняшнего дня, иначе null
  function lessonItems(ls, nowMin) {
    let end = null;
    return ls.map((l) => {
      const s = Cab.toMin(l.starts_at), e = Cab.toMin(l.ends_at);
      const st = nowMin == null ? '' : nowMin >= e ? 'past' : nowMin >= s ? 'now' : '';
      const gap = end == null ? 0 : s - end; end = Math.max(end == null ? 0 : end, e);
      const pct = Math.max(0, Math.min(100, Math.round(((nowMin - s) / (e - s)) * 100)));
      const note = st === 'past' ? ', прошла' : st === 'now' ? `, идёт, ещё ${mins(e - nowMin)}` : '';
      return h`${gap > 0 ? h`<li class="cab-break">перемена ${mins(gap)}</li>` : ''}${lessonTile(l, { st, note, room: 'col', bar: st === 'now' ? pct : null })}`;
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
    const urgent = (tasks || []).filter((t) => t.due && !t.isExam && Cab.taskVisible(t, sgOf(ctx)) && Cab.dayDiff(today, t.due) >= 0 && Cab.dayDiff(today, t.due) <= 1).sort(byDue);
    const badge = unread ? (unread > 99 ? '99+' : unread) : '';
    put(el, nav, h`<div class="st-home">${banner(ctx)}
      <div class="cab-head"><div><h1 class="cab-title">${Cab.dateText(today)}</h1><p class="cab-sub">${Cab.DOW[now.dow]}, ${ctx.group.name}</p></div>
        <div class="st-hr"><a class="cab-bell" href="#/notifications" aria-label="${unread ? `Уведомления, новых: ${unread}` : 'Уведомления'}"><span class="cab-ico">${Cab.icon.bell}</span>${badge ? h`<span class="cab-badge" aria-hidden="true">${badge}</span>` : ''}</a>
        <a class="cab-link" href="#/schedule">Вся неделя ${chev}</a></div></div>
      ${ls.length ? h`<ul class="cab-lessons">${lessonItems(ls, now.minutes)}</ul>`
        : noData ? h`<div class="j2-card"><h2>Расписание ещё не загружено</h2><p>Оно появится после загрузки с bseu.by.</p></div>`
        : h`<div class="j2-card"><h2>Сегодня пар нет</h2></div>`}
      ${absCard(stats, true)}
      ${urgent.length ? h`<a class="st-alert" href="${'#/' + (urgent.length === 1 ? taskRoute(urgent[0]) : 'study')}"><span class="cab-ico" aria-hidden="true">${Cab.icon.bell}</span><span><b>Срок сегодня или завтра</b><small>${urgent.length} ${Cab.plural(urgent.length, ['задание', 'задания', 'заданий'])}: ${urgent.slice(0, 2).map((t) => t.subject || 'Без предмета').join(', ')}${urgent.length > 2 ? ' и ещё ' + (urgent.length - 2) : ''}</small></span>${chev}</a>` : ''}
      <div class="cab-h2"><span>Горит</span><a href="#/study">Все задания ${chev}</a></div>
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
    const dated = (tasks || []).filter((t) => t.due && Cab.taskVisible(t, sg));
    const hw = dated.filter(isHw), usr = dated.filter((t) => isUsr(t) && !t.isExam);
    const has = (list) => (l) => list.some((t) => t.due >= l.lesson_date && one(t.subject).toLowerCase() === one(l.subject).toLowerCase());
    const hasHw = has(hw), hasUsr = has(usr);
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
        return lessonTile(l, { st, note: when, button: i, room: 'line', hints: hasHw(l) ? ['Есть домашка'] : hasUsr(l) ? ['Есть УСР'] : [] });
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
    const active = (pick) => tasks ? tasks.filter((t) => pick(t) && Cab.taskVisible(t, sgOf(ctx)) && (!t.due || t.due >= today)).length : null;
    put(el, nav, h`${banner(ctx)}<h1 class="cab-title">Учёба</h1><p class="cab-sub">Предметы, задания, сессия</p>
      ${hubRow('#/study/homework', 't-lime', 'Домашки', 'Все задания и архив', active(isHw))}
      ${hubRow('#/study/deadlines', 't-amber', 'Дедлайны и УСР', 'Все сроки и УСР', active(isDl))}
      ${hubRow('#/study/exams', 't-mint', 'Зачёты и экзамены', 'Даты и формы контроля')}
      ${hubRow('#/study/grades', 't-blue', 'Оценки', 'Средний балл появится позже')}
      ${hubRow('#/study/rating', 't-pink', 'Рейтинг', 'Калькулятор')}
      ${hubRow('#/study/teachers', 't-violet', 'Преподаватели', 'Лекции и практические')}
      ${hubRow('#/study/games', '', 'Игры', 'Скоро')}`);
  }

  const TASK_SCREENS = {
    homework: { title: 'Домашки', pick: isHw, empty: 'Домашних заданий пока нет' },
    deadlines: { title: 'Дедлайны и УСР', pick: isDl, empty: 'Дедлайнов и УСР пока нет' },
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

  // Экран-заглушка: иконка, короткий текст, кнопка назад. Для разделов, которые вернутся в следующих обновлениях
  const STUB_ICO = {
    games: h`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="15.5" cy="11.5" r=".9" fill="currentColor"/><circle cx="18" cy="13.5" r=".9" fill="currentColor"/></svg>`,
  };
  function stub(el, nav, o) {
    put(el, nav, h`${Cab.top({ href: o.back, text: o.backText })}<h1 class="cab-title">${o.title}</h1>
      <div class="cab-card st-stub"><span class="st-stub-ico">${o.icon}</span><h3>${o.head}</h3><p>${o.text}</p></div>
      <a class="j2-btn primary" href="${o.back}">${o.button}</a>`);
  }
  const games = (el, ctx, nav) => stub(el, nav, { back: '#/study', backText: 'Учёба', title: 'Игры', icon: STUB_ICO.games, head: 'Игры вернутся в ближайшем обновлении', text: 'Судоку, сапёр и другие игры скоро появятся в новом кабинете.', button: 'К учёбе' });

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

  // Преподаватели: карточки по предметам, по нажатию шторка с полным ФИО по видам занятий.
  // ФИО берём из schedule_lessons.teacher; сокращённые («Стасева А.А.») для группы 24ДММ-2 дополняем из data.json (Cab.teacherFull).
  const KIND_ORDER = ['lecture', 'practice', 'lab', 'other'], KIND_PL = { lecture: 'Лекции', practice: 'Практические', lab: 'Лабораторные', other: 'Занятия' };
  async function teachers(el, ctx, nav) {
    const rows = (await q(sb.from('schedule_lessons').select('subject,kind,teacher,subgroup').eq('group_id', ctx.group.id).limit(2000))).filter(mine(ctx));
    let dt = [];
    if (ctx.group.name === '24ДММ-2' && rows.some((l) => Cab.isAbbrevName(l.teacher))) {
      try { dt = (await (await fetch('data.json', { cache: 'no-store' })).json()).teachers || []; } catch (e) { dt = []; }   // нет файла — показываем как в расписании
    }
    // предмет → вид занятия → подгруппа (0 — вся группа) → множество преподавателей
    const by = new Map();
    rows.forEach((l) => {
      if (!l.subject) return;
      const kind = KIND_ORDER.includes(l.kind) ? l.kind : 'other', sg = Number(l.subgroup) || 0;
      const ks = by.get(l.subject) || by.set(l.subject, new Map()).get(l.subject);
      const sgs = ks.get(kind) || ks.set(kind, new Map()).get(kind);
      const set = sgs.get(sg) || sgs.set(sg, new Set()).get(sg);
      if (l.teacher) set.add(Cab.teacherFull(l.teacher, l.subject, dt));
    });
    const names = (set) => (set.size ? [...set].join(', ') : 'не указан');
    const block = (kind, sgs) => {
      const e = [...sgs].sort((a, b) => a[0] - b[0]), same = new Set(e.map(([, set]) => [...set].sort().join('|'))).size === 1;
      return same ? h`<p class="st-tl"><b>${KIND_PL[kind]}</b> — ${names(e[0][1])}</p>`
        : h`<p class="st-tl"><b>${KIND_PL[kind]}:</b> ${e.map(([sg, set]) => `${sg ? sg + ' подгруппа' : 'все подгруппы'} — ${names(set)}`).join(', ')}</p>`;
    };
    const list = [...by].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
    put(el, nav, h`${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Преподаватели</h1><p class="cab-sub">Нажмите на предмет</p>
      ${list.length ? list.map(([subj, ks], i) => h`<button type="button" class="cab-row" data-i="${i}"><span><b>${subj}</b><small>${ks.size} ${Cab.plural(ks.size, ['вид занятий', 'вида занятий', 'видов занятий'])}</small></span><span class="cab-ico">${Cab.icon.chev}</span></button>`)
        : h`<div class="cab-empty">Список появится после загрузки расписания</div>`}`);
    el.onclick = (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const [subj, ks] = list[+b.dataset.i];
      sheet(subj, h`${KIND_ORDER.filter((k) => ks.has(k)).map((k) => block(k, ks.get(k)))}`);
    };
  }

  // ---------- профиль ----------
  const CERT = { sick: 'Больничный', statement: 'Заявление', other: 'Другое' };
  const CERT_ST = { received: ['подтверждена', 'c-mint'], waiting: ['не подтверждена', 'c-amber'], none: ['не сдана', 'c-coral'] };
  async function profile(el, ctx, nav) {
    const [certs, tg, pref] = await Promise.all([
      soft(q(sb.from('certificates').select('id,kind,date_from,date_to,status').eq('student_id', ctx.student.id).order('date_from', { ascending: false }))),
      soft(myLink(ctx)),
      soft(q(sb.from('notification_prefs').select('enabled').eq('user_id', ctx.uid).eq('kind', 'deadline_soon').maybeSingle()))]);
    const remOn = !pref || pref.enabled !== false;                                                                   // ошибка запроса = «не привязан», без шума
    const s = ctx.student, sg = sgOf(ctx);
    const roleName = ctx.role === 'headman' ? 'Староста' : ctx.role === 'deputy' ? 'Заместитель старосты' : 'Студент';
    const ini = ((s.last_name || '').charAt(0) + (s.first_name || '').charAt(0)).toUpperCase() || '?';
    if (!put(el, nav, h`${banner(ctx)}<h1 class="cab-title">Профиль</h1>
      <section class="pf-card" aria-label="Мой профиль">
        <button type="button" class="pf-ava" id="pfAva" aria-haspopup="dialog" aria-label="Фото профиля: изменить"></button>
        <h2 class="pf-name">${Cab.fullName(s)}</h2>
        <div class="pf-tags"><span class="pf-tag role">${roleName}</span><span class="pf-tag">${ctx.group.name}</span></div>
        <button type="button" class="pf-stu" id="pfStu">Studak · скоро</button>
      </section>
      ${raw(J2.roleSwitch('student', { student: true, staff: ctx.isStaff, sysadmin: ctx.isSysadmin }))}
      <div class="st-sg"><span id="sgLbl">Подгруппа</span><div class="cab-seg2" id="sgSeg" role="group" aria-labelledby="sgLbl">${[1, 2].map((n) => h`<button type="button" data-sg="${n}" aria-pressed="${String(sg === n)}"${ctx.closed ? raw(' disabled') : ''}>${n}</button>`)}</div></div>
      <h2 class="cab-h2"><span>Мои справки</span></h2>
      ${!certs ? h`<p class="cab-note">Справки не загрузились. Обновите страницу.</p>`
        : !certs.length ? h`<p class="cab-note">Справок пока нет.</p>`
        : certs.map((c) => { const st = CERT_ST[c.status] || CERT_ST.none;
          return h`<div class="cab-kv"><span>${CERT[c.kind] || CERT.other}, ${period(c.date_from, c.date_to)}</span><b class="${st[1]} st-s">${st[0]}</b></div>`; })}
      <nav class="st-tri" aria-label="Мои данные" style="margin-top:14px"><a href="#/profile/absences"><b>Пропуски</b><small>по предметам</small></a><a href="#/study/grades"><b>Оценки</b><small>мои отметки</small></a><button type="button" class="st-soon" id="achSoon" aria-disabled="true"><b>Достижения</b><small>скоро</small></button></nav>
      <section class="cab-card" aria-labelledby="remT"><h3 id="remT">Напоминания о сроках</h3>
        <div class="st-grp" style="margin:10px 0 8px"><button type="button" class="tg-sw" role="switch" id="remSw" aria-checked="${String(remOn)}"><span><span class="tg-t">Напоминать о горящих заданиях</span><small>За день до срока</small></span><span class="tg-k" aria-hidden="true"></span></button></div>
        ${tg ? h`<p class="cab-note" style="margin:0">Telegram привязан: напоминание придёт в бота и в колокольчик журнала.</p>`
          : h`<p class="cab-note c-amber" style="margin:0">Telegram не привязан: напоминание придёт только в колокольчик журнала. <a class="st-a" id="remTg" href="#/profile/telegram">Привязать Telegram</a></p>`}</section>
      <section class="cab-card" aria-labelledby="thT"><h3 id="thT">Оформление</h3>
        <div class="cab-seg2" role="group" aria-label="Тема"><button type="button" disabled aria-pressed="false" aria-describedby="thNote">Светлая</button><button type="button" aria-pressed="true">Тёмная</button></div>
        <p class="cab-note" id="thNote">Светлая тема появится позже</p>
        <div class="cab-colors" id="stColors" role="group" aria-label="Цвет акцента">${ACCENTS.map(([c, n]) => h`<button type="button" class="cab-color" data-c="${c}" style="background:${c}" aria-label="${n}" aria-pressed="${String(c === accent)}"></button>`)}</div></section>
      ${Cab.installCard()}
      <div class="st-grp"><a class="st-line" id="acRow" href="#/profile/account"><span>Логин и пароль</span><span class="tg-st">${chev}</span></a></div>
      <div class="st-grp"><a class="st-line" href="#/profile/privacy"><span>Мои данные и удаление</span><span class="tg-st">${chev}</span></a></div>
      <div class="st-grp"><a class="st-line" id="tgRow" href="#/profile/telegram"><span>Telegram-уведомления</span><span class="tg-st ${tg ? 'c-mint' : 'c-amber'}">${tg ? 'привязан' : 'не привязан'}${chev}</span></a></div>
      <div class="st-grp"><a class="st-line" id="wnRow" href="#/profile/whatsnew"><span>Что нового</span><span class="tg-st">${wnNew() ? h`<span class="c-lime">новое</span>` : ''}${chev}</span></a></div>
      <button class="j2-btn danger" id="outBtn" type="button">Выйти</button>`)) return;
    Cab.bindInstall(el);
    avatarInit(el, ctx, ini);
    el.querySelector('#achSoon').onclick = () => Cab.toast('Раздел достижений вернётся в ближайшем обновлении');   // значки по-прежнему копятся в базе
    el.querySelector('#pfStu').onclick = () => Cab.toast('Пропуск Studak вернётся в ближайшем обновлении');
    const rem = el.querySelector('#remSw');
    rem.onclick = async () => {                                                             // запись сразу, при ошибке откат
      if (rem.dataset.busy) return;
      const prev = rem.getAttribute('aria-checked') === 'true'; rem.setAttribute('aria-checked', String(!prev)); rem.dataset.busy = '1';
      try { await setPref(ctx, 'deadline_soon', !prev); }
      catch (err) { rem.setAttribute('aria-checked', String(prev)); Cab.toast('Не удалось сохранить настройку. Повторите.', 'err'); }
      finally { delete rem.dataset.busy; }
    };
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

  // ---------- фото профиля: приватный бакет avatars, путь <user_id>.jpg (как в старом журнале, старые фото видны) ----------
  // Квадрат 256×256 JPEG по центру. Копия в localStorage (data-URL): фото видно и без сети.
  const AV_KEY = 'journal_avatar', AV_SIZE = 256, AV_MAX = 1024 * 1024, AV_SRC_MAX = 25 * 1024 * 1024;
  let avSynced = null;                                                                      // для какого uid фото уже сверили с хранилищем в эту загрузку
  const avCache = (uid) => { try { const c = JSON.parse(lsGet(AV_KEY) || 'null'); return c && c.user_id === uid ? c.data : null; } catch (e) { return null; } };
  const avStore = (uid, data) => { try { if (data) lsSet(AV_KEY, JSON.stringify({ user_id: uid, data })); else lsRemove(AV_KEY); } catch (e) { /* память переполнена: фото покажем из сети */ } };
  const avBad = (text) => Object.assign(new Error(text), { user: true });
  const avNet = (e) => navigator.onLine === false || /failed to fetch|network|load failed/i.test(String(e && e.message));
  const blobToUrl = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(b); });
  // Снимок с учётом ориентации (EXIF): createImageBitmap, а если его нет — через <img>
  async function decodeImage(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* пробуем через <img> */ } }
    return new Promise((ok, no) => { const u = URL.createObjectURL(file), img = new Image(); img.onload = () => { URL.revokeObjectURL(u); ok(img); }; img.onerror = () => { URL.revokeObjectURL(u); no(new Error('decode')); }; img.src = u; });
  }
  async function squareAvatarJpeg(file) {
    const src = await decodeImage(file), w = src.naturalWidth || src.width, hh = src.naturalHeight || src.height;
    if (!w || !hh) throw new Error('decode');
    const side = Math.min(w, hh), cv = document.createElement('canvas'), c2 = cv.getContext('2d');
    cv.width = cv.height = AV_SIZE;
    c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, AV_SIZE, AV_SIZE);                          // прозрачный PNG ложится на белое, а не на чёрное
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(src, (w - side) / 2, (hh - side) / 2, side, side, 0, 0, AV_SIZE, AV_SIZE);
    if (src.close) src.close();
    return new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.85));
  }
  const avPaint = (ini, data) => {
    const b = document.getElementById('pfAva'); if (!b) return;
    b.textContent = ''; b.classList.toggle('has-img', !!data);
    if (data) { const i = document.createElement('img'); i.alt = ''; i.src = data; b.appendChild(i); } else b.appendChild(document.createTextNode(ini));
    b.insertAdjacentHTML('beforeend', '<span class="pf-cam" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span>');
  };
  async function avSync(ctx, ini) {
    if (avSynced === ctx.uid || navigator.onLine === false) return;
    avSynced = ctx.uid;
    try {
      const { data, error } = await sb.storage.from('avatars').download(`${ctx.uid}.jpg`);
      if (error) {
        if (avNet(error)) { avSynced = null; return; }
        if (error.status === 400 || error.status === 404 || /not found/i.test(error.message || '')) { avStore(ctx.uid, null); avPaint(ini, null); }   // своего фото нет
        return;
      }
      const d = await blobToUrl(data); avStore(ctx.uid, d); avPaint(ini, d);
    } catch (e) { avSynced = null; }
  }
  // События для значков старого журнала (achievements.js): та же app_events, user_id и student_id ставит база, повтор не страшен (23505).
  // Сами значки пока записывает клиент старого журнала при следующем открытии: сервер для этих кодов ничего не считает.
  function logEvent(kind, ref) {
    const k = `ach_ev_${Cab.ctx.uid}_${kind}_${ref || ''}`;
    if (lsGet(k)) return;
    Promise.resolve(sb.from('app_events').insert({ kind, ref: ref || '' })).then(({ error }) => { if (!error || error.code === '23505') lsSet(k, '1'); }, () => {});
  }
  async function avUpload(ctx, file) {
    if (file.type && !file.type.startsWith('image/')) throw avBad('Выберите фотографию.');
    if (file.size > AV_SRC_MAX) throw avBad('Файл слишком большой. Выберите фото поменьше.');
    let blob; try { blob = await squareAvatarJpeg(file); } catch (e) { throw avBad('Не удалось открыть это фото. Выберите другое: JPEG или PNG.'); }
    if (blob.size > AV_MAX) throw avBad('Файл слишком большой. Выберите фото поменьше.');
    const { error } = await sb.storage.from('avatars').upload(`${ctx.uid}.jpg`, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '60' });
    if (error) throw error;
    const d = await blobToUrl(blob); avStore(ctx.uid, d); logEvent('avatar_set'); return d;   // «Первые шаги»
  }
  const avFail = (e) => Cab.toast(e && e.user ? e.message : avNet(e) ? 'Нет связи. Проверьте интернет и повторите.' : 'Не удалось сохранить фото. Повторите.', 'err');
  // Тап по аватарке: лист «Выбрать фото / Удалить фото / Отмена»
  function avatarInit(el, ctx, ini) {
    avPaint(ini, avCache(ctx.uid));
    avSync(ctx, ini);
    el.querySelector('#pfAva').onclick = () => {
      if (ctx.offline) { Cab.toast('Нет связи. Фото можно изменить, когда появится интернет.', 'err'); return; }
      const has = !!avCache(ctx.uid), root = document.getElementById('cab'), back = document.activeElement, m = document.createElement('div');
      m.className = 'cab-modal';
      m.innerHTML = str(h`<div class="cab-sheet" role="dialog" aria-modal="true" aria-labelledby="avT"><h2 class="st-sh-t" id="avT">Фото профиля</h2>
        <button class="j2-btn primary" data-a="pick" type="button">Выбрать фото</button>${has ? h`<button class="j2-btn danger" data-a="del" type="button">Удалить фото</button>` : ''}<button class="j2-btn" data-a="no" type="button">Отмена</button>
        <input type="file" accept="image/*" hidden></div>`);
      const file = m.querySelector('input'), key = (e) => { if (e.key === 'Escape') close(); };
      function close() { m.remove(); root.inert = false; document.removeEventListener('keydown', key); window.removeEventListener('hashchange', close); if (back && back.focus) back.focus(); }
      const busy = (on) => { const b = document.getElementById('pfAva'); if (b) { b.classList.toggle('busy', on); b.disabled = on; } };
      file.onchange = async () => {
        const f = file.files && file.files[0]; close(); if (!f) return;
        busy(true);
        try { const d = await avUpload(ctx, f); avPaint(ini, d); Cab.toast('Фото сохранено', 'ok'); } catch (e) { avFail(e); } finally { busy(false); }
      };
      m.onclick = async (e) => {
        if (e.target === m) { close(); return; }
        const a = e.target.closest('button[data-a]'); if (!a) return;
        if (a.dataset.a === 'pick') { file.click(); return; }                                // лист закроется, когда выберут файл
        close();
        if (a.dataset.a !== 'del') return;
        busy(true);
        try {
          const { error } = await sb.storage.from('avatars').remove([`${ctx.uid}.jpg`]);
          if (error) throw error;
          avStore(ctx.uid, null); avPaint(ini, null); Cab.toast('Фото удалено', 'ok');
        } catch (err) { avFail(err); } finally { busy(false); }
      };
      document.body.appendChild(m); root.inert = true;
      document.addEventListener('keydown', key); window.addEventListener('hashchange', close);
      m.querySelector('button').focus();
    };
  }

  // ---------- «Что нового»: история версий из changelog.js, метка «новое», пока текущую версию не открыли ----------
  const wnNew = () => lsGet('whats_new_seen') !== APP_VERSION;
  function whatsNew(el, ctx, nav) {
    lsSet('whats_new_seen', APP_VERSION);
    // «Дотошный технарь»: список прочитан до конца (если помещается на экран, засчитываем сразу)
    const atEnd = () => document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 8;
    const seen = () => { if (atEnd()) { logEvent('whats_new_read', APP_VERSION); window.removeEventListener('scroll', seen); } };
    window.addEventListener('scroll', seen, { passive: true }); window.addEventListener('hashchange', () => window.removeEventListener('scroll', seen), { once: true }); setTimeout(seen, 700);
    const list = (e) => h`<ul class="wn-list">${e.items.map((t) => h`<li>${t}</li>`)}</ul>`;
    put(el, nav, h`${Cab.top({ href: '#/profile', text: 'Профиль' })}<h1 class="cab-title">Что нового</h1>
      ${CHANGELOG.map((e, i) => i === 0
        ? h`<section class="cab-card"><h3>Версия ${e.version}</h3><p class="wn-date">${changelogDate(e)}${e.title ? ' · ' + e.title : ''}</p>${list(e)}</section>`
        : h`<details class="st-det"><summary>Версия ${e.version} · ${changelogDate(e)}</summary>${list(e)}</details>`)}`);
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
  const ntfTask = (n, byId) => { const t = byId && n.ref && byId.get(n.ref.task_id); return '#/' + (t ? taskRoute(t) : n.ref && n.ref.kind === 'deadline' ? 'study/deadlines' : 'study/homework'); };
  const NTF_GO = { task: ntfTask, deadline_soon: ntfTask, absence: () => '#/profile/absences', certificate: () => '#/profile', grade: () => '#/study/grades', schedule: () => '#/schedule', achievement: () => '#/profile' };
  const NTF_TONE = { task: 'st-coral', schedule: 'st-amber', certificate: 'st-mint', grade: 'st-lime' };
  async function notifications(el, ctx, nav) {
    const [list, tasks] = await Promise.all([q(sb.from('notifications').select('id,kind,title,body,ref,created_at,read_at').eq('user_id', ctx.uid).order('created_at', { ascending: false }).limit(100)), soft(loadTasks(ctx))]);
    const byId = new Map((tasks || []).map((t) => [t.id, t]));
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
        return h`${head}<a class="cab-ntf ${n.read_at ? '' : 'new ' + (NTF_TONE[n.kind] || '')}" href="${(NTF_GO[n.kind] || (() => '#/home'))(n, byId)}" data-id="${n.id}"><div class="meta"><b>${n.read_at ? '' : h`<span class="sr-only">Новое: </span>`}${n.title}</b><span class="c-mute">${day === today ? hmOf(ms) : Cab.dateShort(day)}</span></div>${n.body ? h`<p>${n.body}</p>` : ''}</a>`;
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

  // ---------- Telegram: привязка бота и настройки уведомлений ----------
  const TG_KINDS = [['deadline_soon', 'Горящие домашки и дедлайны'], ['task', 'Новые домашки и дедлайны'], ['schedule', 'Изменения расписания'], ['grade', 'Новые оценки'],
    ['absence', 'Внесённые пропуски'], ['dean_threshold', 'Приближение к порогу деканата'], ['certificate', 'Справки: срок и подтверждение']];
  const TG_STAFF = [['semester', 'Скорое закрытие семестра'], ['chat', 'Сообщения в чате', 'появится позже']];       // чат появится на этапе 4
  const BOT_RE = /^[A-Za-z0-9_]{3,64}$/;
  let botName = null, tgDone = false;                                                      // имя бота (кэш успеха), «только что привязали»
  const plane = h`<span class="cab-ico sm" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg></span>`;
  const setPref = (ctx, kind, enabled) => q(sb.from('notification_prefs').upsert({ user_id: ctx.uid, kind, enabled }, { onConflict: 'user_id,kind' }));   // нет строки = включено
  const myLink = (ctx) => q(sb.from('tg_links').select('user_id,linked_at').eq('user_id', ctx.uid).maybeSingle());
  async function botUser() {                                                               // имя бота из Edge Function; нет ответа = null (экран покажет текст вместо кнопки)
    if (botName) return botName;
    const r = await J2.fn('tg-info', {}, { anon: true });
    const n = r.ok && r.data ? String(r.data.bot_username || '').replace(/^@/, '') : '';
    if (BOT_RE.test(n)) botName = n;
    return botName;
  }
  const ask = Cab.ask;                                                                     // подтверждение вынесено в cab-core.js

  // Блок «код → бот» (общий для профиля и экрана «Журнал обновился»): три шага, код с отсчётом, кнопка бота, опрос tg_links.
  // o: { pollMs, auto — сразу взять код, onLinked(row) }
  function linkBlock(box, ctx, nav, o) {
    let state = 'idle', code = '', end = 0, err = '', last = 0, polling = false, timer = null, bot = botName ? 'ok' : 'wait';
    const clock = () => { const s = Math.max(0, Math.ceil((end - Date.now()) / 1000)); return `${Math.floor(s / 60)}:${p2(s % 60)}`; };
    const stop = () => { clearInterval(timer); timer = null; };
    const step = (n, t, sub) => h`<li><span class="tg-n" aria-hidden="true">${n}</span><div><b>${t}</b><small>${sub}</small></div></li>`;
    function draw() {
      const raw10 = code.replace('-', '');
      box.innerHTML = str(h`<ol class="tg-steps">${step(1, 'Получите код', 'Код действует 10 минут')}
        ${state === 'code' ? h`<li class="tg-codeli"><span class="j2-code" id="tgCode">${code}</span><small class="tg-left" id="tgLeft">Код действует ${clock()}</small></li>`
          : state === 'expired' ? h`<li class="tg-codeli"><b class="c-coral" role="status">Код истёк</b></li>` : ''}
        ${step(2, 'Отправьте код боту', 'Откройте бота журнала и вставьте код')}${step(3, 'Готово', 'Бот ответит, что вы вошли, и включит уведомления')}</ol>
        ${err ? h`<p class="j2-msg err" role="alert">${err}</p>` : ''}
        ${state === 'code'
          ? (bot === 'ok' && /^[A-Z2-9]{8}$/.test(raw10) ? h`<a class="j2-btn primary" id="tgOpen" href="${'https://t.me/' + botName + '?start=' + raw10}" target="_blank" rel="noopener noreferrer">${plane}Открыть бота в Telegram</a>`
            : bot === 'wait' ? '' : h`<p class="cab-note" id="tgNoBot">Откройте бота журнала в Telegram и отправьте код</p>`)
          : h`<button class="j2-btn primary" id="tgGet" type="button"${state === 'busy' ? raw(' disabled') : ''}>${state === 'busy' ? 'Получаем код…' : err ? 'Повторить' : 'Получить код'}</button>`}`);
    }
    async function request() {
      if (state === 'busy') return;
      state = 'busy'; err = ''; draw();
      try {
        const x = await rpc('tg_create_link_code'), c = Array.isArray(x) ? x[0] : x;
        if (typeof c !== 'string' || !c) throw new Error('code');
        code = c; end = Date.now() + 10 * 60e3; last = Date.now(); state = 'code';
        if (!timer) timer = setInterval(tick, 1000);
      } catch (e) { state = 'idle'; err = Cab.rpcText(e); }
      if (box.isConnected && nav.isCurrent()) draw();
    }
    async function tick() {
      if (!box.isConnected || !nav.isCurrent()) return stop();                              // ушли с экрана
      if (state !== 'code') return;
      if (end - Date.now() <= 0) { state = 'expired'; stop(); draw(); return; }
      const left = box.querySelector('#tgLeft'); if (left) left.textContent = `Код действует ${clock()}`;
      if (polling || Date.now() - last < o.pollMs) return;
      polling = true; last = Date.now();
      let row = null;
      try { row = await myLink(ctx); } catch (e) { /* связь моргнула: спросим в следующий раз */ }
      polling = false;
      if (row && box.isConnected && nav.isCurrent() && state === 'code') { stop(); o.onLinked(row); }
    }
    box.onclick = (e) => { if (e.target.closest('#tgGet')) request(); };
    draw();
    if (!botName) botUser().then(() => { bot = botName ? 'ok' : 'none'; if (box.isConnected && nav.isCurrent() && state !== 'busy') draw(); });
    if (o.auto) request();
  }

  // ---------- логин и пароль (поведение из profile.js: saveNewLogin, saveNewPassword) ----------
  // Логин меняет Edge Function change-login: она переписывает почту аккаунта на «логин@домен». Поэтому смена показана только тем, у кого почта уже синтетическая:
  // у старосты или сисадмина с настоящей почтой функция затёрла бы её. Им доступна смена пароля.
  const AC_FN = { unauthorized: 'Сессия закончилась. Войдите заново.', no_profile: 'Аккаунт не привязан к студенту. Обратитесь к старосте.', login_taken: 'Этот логин уже занят. Придумайте другой.', bad_login: 'Логин: от 3 до 32 символов — латинские буквы, цифры, «_» и «.».' };
  const acNet = (e) => navigator.onLine === false || /Failed to fetch|NetworkError|Load failed|network/i.test(String((e && e.message) || ''));
  function acPwErr(e) {
    const c = (e && e.code) || '';
    if (acNet(e)) return J2.errText('network');
    if (c === 'invalid_credentials') return 'Текущий пароль введён неверно.';
    if (c === 'same_password') return 'Новый пароль совпадает с текущим.';
    if (c === 'weak_password') return J2.errText('bad_password');
    if (c === 'over_request_rate_limit' || (e && e.status === 429)) return 'Слишком много попыток. Подождите несколько минут и попробуйте снова.';
    if (c === 'session_not_found' || c === 'unauthorized') return 'Сессия закончилась. Войдите заново.';
    return 'Что-то пошло не так. Попробуйте ещё раз.';
  }
  async function account(el, ctx, nav) {
    const suffix = '@' + J2.EMAIL_DOMAIN, email = String(ctx.email || ''), synth = email.toLowerCase().endsWith(suffix), login = synth ? email.slice(0, -suffix.length) : '';
    if (!put(el, nav, h`${Cab.top({ href: '#/profile', text: 'Профиль' })}<h1 class="cab-title">Логин и пароль</h1><p class="cab-sub">Данные для входа в журнал</p>
      ${synth ? h`<form class="cab-card" id="acLg" novalidate><h3>Логин</h3><p>Сейчас: <b>${login}</b></p>
          <label class="j2-field" style="margin-top:10px"><span>Новый логин</span><input id="acLgIn" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="32" value="${login}"></label>
          <div class="j2-msg err" id="acLgMsg" role="alert"></div><button class="j2-btn primary" type="submit">Сменить логин</button></form>`
        : h`<div class="cab-card"><h3>Почта для входа</h3><p>${email}</p><p style="margin-top:6px">Этот аккаунт входит по почте, сменить её здесь нельзя. Пароль менять можно.</p></div>`}
      <form class="cab-card" id="acPw" novalidate><h3>Пароль</h3>
        <input type="text" autocomplete="username" value="${email}" hidden>
        <label class="j2-field" style="margin-top:10px"><span>Текущий пароль</span><input id="acCur" type="password" autocomplete="current-password"></label>
        <label class="j2-field"><span>Новый пароль (8–72 символа)</span><input id="acNew" type="password" autocomplete="new-password" maxlength="72"></label>
        <label class="j2-field"><span>Новый пароль ещё раз</span><input id="acRep" type="password" autocomplete="new-password" maxlength="72"></label>
        <div class="j2-msg err" id="acPwMsg" role="alert"></div><button class="j2-btn primary" type="submit">Сменить пароль</button></form>`)) return;
    const lg = el.querySelector('#acLg');
    if (lg) lg.onsubmit = (ev) => {
      ev.preventDefault();
      const msg = el.querySelector('#acLgMsg'), v = el.querySelector('#acLgIn').value.trim().toLowerCase(); msg.textContent = '';
      if (!J2.LOGIN_RE.test(v)) { msg.textContent = AC_FN.bad_login; return; }
      if (v === login) { msg.textContent = 'Это ваш текущий логин.'; return; }
      J2.busy(lg.querySelector('button'), async () => {
        const r = await J2.fn('change-login', { login: v });
        if (!r.ok) { const c = (r.data && r.data.error) || ''; msg.textContent = r.status === 0 ? J2.errText('network') : r.status === 429 ? J2.errText('too_many_requests') : AC_FN[c] || J2.errText(c); return; }
        try { await sb.auth.refreshSession(); } catch (e) { /* вход обновится сам при следующем запросе */ }
        ctx.email = v + suffix;
        Cab.toast(`Логин изменён. Теперь входите с логином «${v}».`, 'ok'); Cab.rerender();
      });
    };
    const pw = el.querySelector('#acPw');
    pw.onsubmit = (ev) => {
      ev.preventDefault();
      const msg = el.querySelector('#acPwMsg'), cur = el.querySelector('#acCur').value, nw = el.querySelector('#acNew').value, rep = el.querySelector('#acRep').value; msg.textContent = '';
      if (!cur) { msg.textContent = 'Введите текущий пароль.'; return; }
      if (nw.length < J2.PASSWORD_MIN || nw.length > J2.PASSWORD_MAX) { msg.textContent = J2.errText('bad_password'); return; }
      if (nw !== rep) { msg.textContent = 'Новые пароли не совпадают.'; return; }
      if (nw === cur) { msg.textContent = 'Новый пароль совпадает с текущим.'; return; }
      J2.busy(pw.querySelector('button'), async () => {
        try {
          // сначала подтверждаем текущий пароль: чужой человек с открытым журналом не сменит его
          const chk = await sb.auth.signInWithPassword({ email: ctx.email, password: cur });
          if (chk.error) throw chk.error;
          const { error } = await sb.auth.updateUser({ password: nw });
          if (error) throw error;
          ['#acCur', '#acNew', '#acRep'].forEach((s) => { el.querySelector(s).value = ''; });
          Cab.toast('Пароль изменён.', 'ok');
        } catch (e) { msg.textContent = acPwErr(e); }
      });
    };
  }

  // Удаление данных по просьбе (ТЗ, раздел 5): заявка → староста (или сисадмин, если просит сам староста) решает → стирание на сервере
  const DEL_ST = { pending: ['Заявка отправлена, ждём решения', 'c-amber'], rejected: ['Заявку отклонили', 'c-coral'], done: ['Данные удалены', 'c-mint'], withdrawn: ['Заявку отозвали', 'c-mute'] };
  async function privacy(el, ctx, nav) {
    const r = await soft(rpc('my_data_deletion', {}));
    const open = r && r.status === 'pending', st = r && DEL_ST[r.status];
    if (!put(el, nav, h`${Cab.top({ href: '#/profile', text: 'Профиль' })}<h1 class="cab-title">Мои данные</h1>
      <p class="cab-sub">Вы можете попросить удалить ваши данные из журнала.</p>
      <div class="cab-card"><h3>Что будет удалено</h3><p>Ваш вход (логин и пароль), согласия, уведомления, привязка Telegram, ключи и переписка в чате, достижения и результаты игр. Ваше имя в журнале заменяется на «Удалён студент».</p></div>
      <div class="cab-card"><h3>Что останется</h3><p>Пропуски и оценки без имени: они нужны для статистики группы и отчёта деканата. Вернуть удалённое нельзя.</p></div>
      ${st ? h`<div class="cab-card"><h3 class="${st[1]}">${st[0]}</h3>${r.status === 'rejected' && r.note ? h`<p>${r.note}</p>` : ''}</div>` : ''}
      ${open ? h`<button class="j2-btn" id="dlWd" type="button">Отозвать заявку</button>`
        : ctx.closed ? '' : h`<div id="dlA"><button class="j2-btn danger" id="dlAsk" type="button">Попросить удалить мои данные</button></div>
          <div id="dlB" class="j2-hidden"><p class="cab-note c-amber">${ctx.isStaff ? 'Заявку старосты или заместителя рассматривает системный администратор.' : 'Заявку рассмотрит староста.'} После подтверждения данные удалятся навсегда.</p><button class="j2-btn danger" id="dlOk" type="button">Да, отправить заявку</button><button class="j2-btn" id="dlNo" type="button">Отмена</button></div>`}
      <div class="j2-msg err" id="dlErr" role="alert"></div>`)) return;
    const err = el.querySelector('#dlErr'), run = (b, fn) => J2.busy(b, async () => { try { err.textContent = ''; await fn(); Cab.rerender(); } catch (e) { err.textContent = Cab.rpcText(e); } });
    const ask = el.querySelector('#dlAsk');
    if (ask) {
      ask.onclick = () => { el.querySelector('#dlA').classList.add('j2-hidden'); el.querySelector('#dlB').classList.remove('j2-hidden'); el.querySelector('#dlOk').focus(); };
      el.querySelector('#dlNo').onclick = () => { el.querySelector('#dlB').classList.add('j2-hidden'); el.querySelector('#dlA').classList.remove('j2-hidden'); ask.focus(); };
      const ok = el.querySelector('#dlOk'); ok.onclick = () => run(ok, async () => { await rpc('request_data_deletion', { p_group: ctx.group.id }); Cab.toast('Заявка отправлена.', 'ok'); });
    }
    const wd = el.querySelector('#dlWd');
    if (wd) wd.onclick = () => run(wd, async () => { await rpc('withdraw_data_deletion', {}); Cab.toast('Заявка отозвана.', 'ok'); });
  }

  async function telegram(el, ctx, nav) {
    const [link, rows] = await Promise.all([myLink(ctx), q(sb.from('notification_prefs').select('kind,enabled').eq('user_id', ctx.uid))]);
    const on = new Map(rows.map((r) => [r.kind, r.enabled !== false]));                     // нет строки = включено
    const just = tgDone; tgDone = false;
    const sw = ([k, t, hint]) => h`<button type="button" class="tg-sw" role="switch" data-k="${k}" aria-checked="${String(!hint && (on.has(k) ? on.get(k) : true))}"${hint ? raw(' disabled') : ''}><span><span class="tg-t">${t}</span>${hint ? h`<small>${hint}</small>` : ''}</span><span class="tg-k" aria-hidden="true"></span></button>`;
    if (!put(el, nav, h`${Cab.top({ href: '#/profile', text: 'Профиль' })}<h1 class="cab-title tg-h1">Telegram-уведомления</h1>
      ${link ? h`<p class="cab-sub">Бот присылает уведомления из журнала.</p>${just ? h`<p class="cab-ok" role="status">Готово: бот ответил, что вы вошли</p>` : ''}
          <div class="cab-card mint"><h3>Привязан с ${Cab.dateText(Cab.minsk(Date.parse(link.linked_at)).iso)}</h3><p>Уведомления приходят в Telegram</p></div>
          <button class="j2-btn danger" id="tgOut" type="button">Отвязать</button>`
        : h`<p class="cab-sub">Привяжите Telegram, чтобы горящие домашки, расписание, оценки и пропуски приходили в бота. Это займёт минуту.</p><div id="tgLink"></div>`}
      <h2 class="cab-h2"><span>Какие уведомления присылать</span></h2>
      <div class="st-grp" id="tgPrefs">${(ctx.isStaff ? TG_KINDS.concat(TG_STAFF) : TG_KINDS).map(sw)}</div>
      <p class="cab-note">В колокольчике внутри журнала события остаются всегда.</p>`)) return;
    if (link) {
      const out = el.querySelector('#tgOut');
      out.onclick = async () => {
        if (out.disabled) return;
        if (!(await ask('Отвязать Telegram?', 'Уведомления перестанут приходить в Telegram. В колокольчике журнала они останутся.', 'Отвязать'))) return;
        out.disabled = true;
        try { await rpc('tg_unlink'); Cab.toast('Telegram отвязан', 'ok'); Cab.rerender(); }
        catch (err) { out.disabled = false; Cab.toast(Cab.rpcText(err), 'err'); }
      };
    } else linkBlock(el.querySelector('#tgLink'), ctx, nav, { pollMs: 4000, onLinked: () => { tgDone = true; Cab.rerender(); } });
    el.querySelector('#tgPrefs').onclick = async (e) => {                                 // запись сразу, при ошибке откат
      const b = e.target.closest('button.tg-sw'); if (!b || b.disabled || b.dataset.busy) return;
      const prev = b.getAttribute('aria-checked') === 'true';
      b.setAttribute('aria-checked', String(!prev)); b.dataset.busy = '1';
      try { await setPref(ctx, b.dataset.k, !prev); }
      catch (err) { b.setAttribute('aria-checked', String(prev)); Cab.toast('Не удалось сохранить настройку. Повторите.', 'err'); }
      finally { delete b.dataset.busy; }
    };
  }

  // Экран «Журнал обновился»: после сброса привязок бот просит войти заново (макет s03, средний)
  async function rebind(el, ctx, nav) {
    const link = await soft(myLink(ctx));
    const done = () => put(el, nav, h`<h1 class="cab-title">Журнал обновился</h1>
      <div class="cab-card mint" role="status"><h3>Готово: бот ответил, что вы вошли</h3><p>Уведомления включены. Настроить их можно в профиле.</p></div><a class="j2-btn primary" href="#/home">В журнал</a>`);
    if (link) return done();
    if (!put(el, nav, h`<h1 class="cab-title">Журнал обновился</h1><p class="cab-sub">Чтобы получать уведомления, привяжите Telegram заново. Это один раз.</p>
      <div id="tgLink"></div><button class="j2-btn link" id="rbSkip" type="button">Пропустить, привяжу позже</button>`)) return;
    linkBlock(el.querySelector('#tgLink'), ctx, nav, { pollMs: 5000, auto: true, onLinked: done });
    const skip = el.querySelector('#rbSkip');
    skip.onclick = async () => {
      if (skip.disabled) return; skip.disabled = true;
      try { await rpc('tg_rebind_dismiss'); } catch (err) { Cab.toast('Не удалось запомнить выбор. Спросим в следующий раз.', 'err'); }
      location.hash = '#/home';
    };
  }
  // После обновления: один раз за сеанс ведём на этот экран, если есть своя строка tg_rebind без dismissed_at и нет привязки
  async function rebindCheck(ctx) {
    const KEY = 'j2_rebind';
    try {
      if (sessionStorage.getItem(KEY)) return;
      const [rb, link] = await Promise.all([q(sb.from('tg_rebind').select('user_id').eq('user_id', ctx.uid).is('dismissed_at', null).maybeSingle()), myLink(ctx)]);
      sessionStorage.setItem(KEY, '1');
      if (rb && !link && location.hash !== '#/rebind') location.hash = '#/rebind';
    } catch (e) { /* проверка не должна мешать входу */ }
  }

  // ---------- маршруты ----------
  // Автообновление при возврате во вкладку нужно только главной и уведомлениям; остальные его сбрасывают
  // bare: без нижней панели (экран «Журнал обновился»), класс на body снимается на любом другом экране
  const route = (tab, fn, bare) => ({ tab, render: async (el, ctx, params, nav) => { Cab.autoRefresh = null; document.body.classList.toggle('cab-bare', !!bare); await fn(el, ctx, nav); } });
  const routes = {
    home: route('home', home), notifications: route('home', notifications),
    schedule: route('schedule', schedule),
    study: route('study', study), 'study/homework': route('study', (e, c, n) => taskScreen(e, c, n, 'homework')),
    'study/deadlines': route('study', (e, c, n) => taskScreen(e, c, n, 'deadlines')), 'study/exams': route('study', (e, c, n) => taskScreen(e, c, n, 'exams')),
    'study/grades': route('study', grades), 'study/teachers': route('study', teachers), 'study/rating': route('study', (e, c, n) => Cab.ratingScreen(e, c, n)), 'study/games': route('study', games),
    profile: route('profile', profile), 'profile/account': route('profile', account), 'profile/whatsnew': route('profile', whatsNew), 'profile/absences': route('profile', absences), 'profile/telegram': route('profile', telegram), 'profile/privacy': route('profile', privacy),
    rebind: route('profile', rebind, true),
  };
  Cab.start({
    kind: 'student', start: 'home', routes,
    tabs: [{ id: 'home', label: 'Главная', icon: Cab.icon.home, path: 'home' }, { id: 'schedule', label: 'Расписание', icon: Cab.icon.calendar, path: 'schedule' },
      { id: 'study', label: 'Учёба', icon: Cab.icon.study, path: 'study' }, { id: 'profile', label: 'Профиль', icon: Cab.icon.user, path: 'profile' }],
  }).then((ctx) => { if (ctx) { rebindCheck(ctx); logEvent('first_login'); } }).catch((e) => { console.error('[st]', e); Cab.fatal('Не получилось открыть журнал. Обновите страницу.'); });
})();
