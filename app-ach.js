// «Журнал 2.1»: «Достижения» в кабинете студента (#/profile/achievements); правила и каталог — ach-calc.js.
// Что откуда: значки посещаемости, антидостижения и значки за игры выдаёт и отзывает сервер, клиент их читает из
// student_achievements (политика «Свои значки добавляются» не даёт клиенту вставлять эти коды). Клиент сам выдаёт только
// welcome, first_steps, tech, notify_on, hw_* и collector — по app_events и уже собранному. Прогресс на экране
// (серия, часы за месяц) клиент считает по absences и study_days (нет их — по датам из schedule_lessons).
// Стили и спрайт значков подгружаются при первом открытии раздела; выдача и всплывашка — через несколько секунд после старта.
'use strict';
(function () {
  if (!window.Cab || !window.AchCalc) return;
  const { h, raw, str, q, sb } = Cab, C = window.AchCalc;
  const SELF = (document.currentScript && document.currentScript.src) || '';
  const VER = (SELF.match(/[?&]v=([\w.-]+)/) || [])[1] || '';
  const asset = (f) => f + (VER ? '?v=' + VER : '');

  // ---------- ленивая загрузка ----------
  let assets = null;
  const css = (f) => new Promise((ok) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = asset(f); l.onload = l.onerror = ok; document.head.appendChild(l); });
  function loadAssets() {
    if (!assets) {
      assets = (async () => {
        const [, , r] = await Promise.all([css('icons/achievements/achievements-icons.css'), css('app-ach.css'), fetch(asset('icons/achievements/sprite.svg'))]);
        if (!r.ok) throw new Error('sprite ' + r.status);
        const box = document.createElement('div');                       // значки рисуются через <use href="#a-код">: так они берут цвета из токенов темы
        box.setAttribute('aria-hidden', 'true'); box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        box.innerHTML = await r.text(); document.body.appendChild(box);
      })().catch((e) => { assets = null; throw e; });
    }
    return assets;
  }
  // .ach-sm (мелкий значок) прячет ярлык с номером ступени, поэтому номер уходит в подпись
  const numTag = (a) => (a.need && a.group && a.group !== 'anti' && a.group !== 'cert' ? ' · ' + a.need : '');
  const icon = (code, size, o = {}) => raw(`<svg class="ach-icon${size <= 32 ? ' ach-sm' : ''}${o.locked ? ' is-locked' : ''}" style="--ach-size:${size}px" viewBox="0 0 64 64" focusable="false" aria-hidden="true"><use href="#a-${code}"/></svg>`);

  // ---------- данные ----------
  const filt = (t, cols, ctx) => sb.from(t).select(cols).eq('student_id', ctx.student.id).eq('group_id', ctx.group.id);
  async function loadMine(ctx) {
    const [rows, ev] = await Promise.all([q(filt('student_achievements', 'code,period,earned_at', ctx)), q(filt('app_events', 'kind,ref', ctx))]);
    const hw = new Set(), kinds = new Set();
    ev.forEach((e) => { if (e.kind === 'homework_done') hw.add(e.ref); else if (e.kind !== 'deadline_done') kinds.add(e.kind); });   // deadline_done на значки не влияет
    return { earned: C.earnedMap(rows), kinds, homework: hw.size };
  }
  // Пропуски и учебные дни для прогресса. Учебные дни группы — study_days; у групп без них — даты занятий из расписания
  async function loadAttendance(ctx) {
    try {
      const g = ctx.group.id;
      const [abs, sd] = await Promise.all([q(filt('absences', 'date,hours,is_excused', ctx)), q(sb.from('study_days').select('day').eq('group_id', g))]);
      let days = sd.map((x) => x.day);
      if (!days.length) days = [...new Set((await q(sb.from('schedule_lessons').select('lesson_date').eq('group_id', g).order('lesson_date').limit(1000))).map((x) => x.lesson_date))];
      return { days, abs: abs.map((a) => ({ date: a.date, hours: a.hours, isExcused: a.is_excused })) };
    } catch (e) { console.warn('[ach]', e); return { days: [], abs: [], failed: true }; }
  }
  // «Считаем до вчерашнего дня»: сегодняшние пропуски могут быть ещё не внесены (так же считает сервер у новых групп)
  const statsOf = (mine, att) => C.stats({ asOf: Cab.addDays(Cab.minsk().iso, -1), studyDays: att ? att.days : [], absences: att ? att.abs : [], kinds: mine.kinds, homework: mine.homework, earned: mine.earned });

  // Выдача того, что вправе выдать клиент. Закрытый журнал и офлайн — молча пропускаем (RLS всё равно откажет).
  async function grant(ctx, mine, st) {
    if (ctx.closed || ctx.offline) return [];
    const due = C.clientDue(st);
    if (!due.length) return [];
    try {
      const sem = (await q(sb.from('study_days').select('semester').eq('group_id', ctx.group.id).order('day').limit(1)).catch(() => []))[0];
      const now = new Date().toISOString();
      const { error } = await sb.from('student_achievements').insert(due.map((d) => ({ student_id: ctx.student.id, group_id: ctx.group.id, code: d.code, period: d.period, semester: (sem && sem.semester) || '', earned_at: now })));
      if (error) { if (error.code !== '23505') console.warn('[ach]', error.message); return []; }   // 23505: другая вкладка успела раньше, при следующей проверке подтянется
      due.forEach((d) => { const e = mine.earned.get(d.code); if (e) e.periods.add(d.period); else mine.earned.set(d.code, { earned_at: now, periods: new Set([d.period]) }); });
      return due.map((d) => d.code);
    } catch (e) { console.warn('[ach]', e); return []; }
  }

  // Всплывашка: «показано» помним на устройстве. На первом запуске уже имеющееся новым не считаем (кроме только что выданного).
  function announce(ctx, mine, fresh) {
    const key = 'ach_shown_' + ctx.uid;
    let seen; try { seen = new Set(JSON.parse(lsGet(key) || 'null')); } catch (e) { seen = null; }
    if (!seen || !seen.size) seen = new Set([...mine.earned.keys()].filter((c) => !fresh.includes(c)));
    const codes = [...mine.earned.keys()].filter((c) => !C.BY_CODE[c].anti && !seen.has(c));     // антидостижения не празднуем
    if (!codes.length) return;
    codes.forEach((c) => seen.add(c)); try { lsSet(key, JSON.stringify([...seen])); } catch (e) { /* без хранилища покажем снова */ }
    const t = (c) => '«' + C.BY_CODE[c].title + '»';
    Cab.toast(codes.length === 1 ? 'Новое достижение: ' + t(codes[0]) : `Новые достижения: ${t(codes[0])} и ещё ${codes.length - 1}`, 'ok', 4200);
  }

  // Проверка после старта: события и значки (без посещаемости: клиент её не выдаёт)
  async function sync(ctx) {
    try {
      const mine = await loadMine(ctx);
      announce(ctx, mine, await grant(ctx, mine, statsOf(mine, null)));
    } catch (e) { console.warn('[ach]', e); }
  }
  let started = false;
  function start(ctx) { if (started || !ctx || !ctx.student) return; started = true; setTimeout(() => sync(ctx), 3000); }

  // Плитка в профиле: «N из M»
  async function tile(ctx) {
    const m = await loadMine(ctx);
    return `${[...m.earned.keys()].filter(C.counted).length} из ${C.TOTAL}`;
  }

  // ---------- экран ----------
  const dateOf = (iso) => Cab.dateText(Cab.minsk(Date.parse(iso)).iso);
  const cell = (a, st) => { const on = st.earned.has(a.code);
    return h`<button type="button" class="ac-cell${on ? '' : ' off'}${a.anti ? ' anti' : ''}" data-c="${a.code}" aria-label="${a.title}: ${on ? 'получено' : a.soon ? 'скоро' : 'ещё не получено'}">${icon(a.code, 56, { locked: !on })}<span class="ac-name">${a.title}</span></button>`; };
  const bar = (p, anti) => h`<div class="ac-bar${anti ? ' anti' : ''}" role="img" aria-label="${p.text}"><i style="--ac-fill:${p.need ? Math.max(0, Math.min(1, p.have / p.need)) : 0}"></i></div>`;
  // Прогресс одного значка; если посещаемость не загрузилась, цифр нет
  const progOf = (a, st, att) => (att.failed && (a.cat === 'attendance' || a.anti) && !a.soon ? { have: 0, need: 1, earned: st.earned.has(a.code), text: 'Данные посещаемости не загрузились. Обновите страницу.' } : C.progress(a.code, st));

  function details(a, st, att) {
    const p = progOf(a, st, att), e = st.earned.get(a.code), on = !!e;
    const when = a.anti ? (p.months && p.months.length ? 'Получено: ' + p.months.join(', ') : '')
      : e ? 'Получено ' + dateOf(e.earned_at) + (a.repeatable && e.periods.size > 1 ? ` · ещё раз: ${[...e.periods].filter(Boolean).sort().map(C.monthName).join(', ')}` : '') : '';
    const showBar = !p.soon && (!on || a.anti) && !(a.cat === 'games' && !on);        // у игр шкалы нет: значок выдаёт сервер после партии
    return h`<div class="ac-sh">${icon(a.code, 88, { locked: !on })}<p>${a.about}</p>
      <span class="ac-state${on ? '' : ' off'}">${on ? 'Получено' : a.soon ? 'Скоро' : 'Ещё не получено'}</span></div>
      ${showBar ? h`<div class="ac-sh-bar">${bar(p, a.anti)}</div><p class="ac-sh-t">${p.text}</p>` : (p.soon || (!on && a.cat === 'games')) ? h`<p class="ac-sh-t">${p.text}</p>` : ''}
      ${p.checklist && !on ? h`<ul class="ac-check">${p.checklist.map((c) => h`<li class="${c.done ? 'done' : ''}">${c.text}</li>`)}</ul>` : ''}
      ${when ? h`<p class="ac-sh-t">${when}</p>` : ''}`;
  }

  async function screen(el, ctx, nav) {
    const back = Cab.top({ href: '#/profile', text: 'Профиль' });
    let mine, att;
    try { [mine, att] = await Promise.all([loadMine(ctx), loadAttendance(ctx), loadAssets()]); }
    catch (e) {
      console.warn('[ach]', e);
      if (nav.isCurrent()) el.innerHTML = str(h`${back}<h1 class="cab-title">Достижения</h1><p class="cab-note">Достижения не загрузились. Проверьте связь и обновите страницу.</p>`);
      return;
    }
    if (!nav.isCurrent()) return;
    let st = statsOf(mine, att);
    const fresh = await grant(ctx, mine, st);
    if (fresh.length) st = statsOf(mine, att);
    if (!nav.isCurrent()) return;
    const last = C.latest(st.earned), next = C.nextUp(st);
    const bs = st.badgesCount / C.TOTAL;
    el.innerHTML = str(h`${back}<h1 class="cab-title">Достижения</h1>
      <p class="cab-sub">Значки за учёбу, домашку и приложение. Видите их только вы</p>
      <section class="cab-card ac-sum" aria-label="Сводка">
        <div class="ac-big"><b>${st.badgesCount}</b><span>из ${C.TOTAL} значков</span></div>
        <div class="ac-bar" role="img" aria-label="${st.badgesCount} из ${C.TOTAL}"><i style="--ac-fill:${bs}"></i></div>
        ${last ? h`<div class="ac-line">${icon(last.a.code, 32)}<span><small>Последнее</small><b>${last.a.title + numTag(last.a)}</b><small>${dateOf(last.e.earned_at)}</small></span></div>` : h`<p class="cab-note" style="margin:0">Значков пока нет: они появятся за учёбу и за игры</p>`}
        ${next ? h`<div class="ac-line">${icon(next.a.code, 32, { locked: true })}<span><small>Ближайшее</small><b>${next.a.title + numTag(next.a)}</b><small>${next.p.text}</small></span></div>` : ''}
      </section>
      ${C.CATEGORIES.map((cat) => { const list = C.CATALOG.filter((a) => a.cat === cat.id), got = list.filter((a) => st.earned.has(a.code) && C.counted(a.code)).length;
        return h`<h2 class="cab-h2"><span>${cat.title}</span>${cat.id === 'anti' ? '' : h`<span class="ac-cnt">${got} из ${list.filter((a) => !a.soon).length}</span>`}</h2>
          ${cat.id === 'anti' ? h`<p class="cab-note" style="margin:0 2px 8px">${st.monthUnexcused} ч неуважительных в этом месяце. С 1-го числа счёт заново. В «N из ${C.TOTAL}» не входят</p>` : ''}
          <div class="ac-grid">${list.map((a) => cell(a, st))}</div>`; })}`);
    el.querySelectorAll('.ac-cell').forEach((b) => {
      b.onclick = () => { const a = C.BY_CODE[b.dataset.c]; if (Cab.sheet) Cab.sheet(a.title + numTag(a), details(a, st, att)); };
    });
    announce(ctx, mine, fresh);
  }

  window.Cab.ach = { screen, start, tile };
})();
