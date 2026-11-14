// «Журнал 2.1»: достижения в кабинете студента — каталог и правила подсчёта (чистые функции, без DOM и без сети).
// Правила 1:1 с achDeserved()/achProgressOf() из achievements.js (его не трогаем: он нужен старому index.html),
// но вход другой: не data.json, а строки новых таблиц (absences, study_days, app_events, student_achievements).
// Кто выдаёт значки (поле server в каталоге):
//   сервер — посещаемость и антидостижения (attendance_badges_deserved, триггер на absences: ещё и отзывает),
//            значки за игры (submit-game-score). Политика «Свои значки добавляются» клиенту их не даёт вставлять.
//   клиент — welcome, first_steps, tech, notify_on, hw_*, collector (по app_events и уже собранному).
// Для посещаемости клиент только считает прогресс на экране (серия, часы за месяц), сами значки читает из базы.
// Тест: tools/test-ach-new.js (грузит файл в vm с заглушкой window)
'use strict';
(function (root) {
  const CATEGORIES = [
    { id: 'attendance', title: 'Посещаемость' }, { id: 'app', title: 'Приложение' }, { id: 'homework', title: 'Домашка' },
    { id: 'games', title: 'Игры' }, { id: 'anti', title: 'Антидостижения' },
  ];

  // code, категория, название, условие; group/need — ступень лесенки; server — выдаёт база; soon — пока не выдаётся
  const A = (code, cat, title, about, o) => Object.assign({ code, cat, title, about }, o);
  const ATT = { server: true }, ANTI = { anti: true, repeatable: true, group: 'anti', server: true }, GAME = { server: true };
  const CATALOG = [
    A('clean_sheet', 'attendance', 'Чистый лист', 'Календарный месяц без единого неуважительного часа', { server: true, repeatable: true }),
    A('streak_3', 'attendance', 'Разминка', '3 учебных дня подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 3 }),
    A('streak_5', 'attendance', 'Пятидневка', '5 учебных дней подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 5 }),
    A('streak_10', 'attendance', 'На волне', '10 учебных дней подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 10 }),
    A('streak_15', 'attendance', 'Железная воля', '15 учебных дней подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 15 }),
    A('streak_20', 'attendance', 'Несгибаемый', '20 учебных дней подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 20 }),
    A('streak_30', 'attendance', 'Легенда посещаемости', '30 учебных дней подряд без неуважительных пропусков', { ...ATT, group: 'streak', need: 30 }),
    A('clean_term', 'attendance', 'Чистый семестр', 'Весь семестр без неуважительных часов', ATT),
    A('recovered', 'attendance', 'Исправился', 'Месяц без неуважительных сразу после месяца, в котором они были', { server: true, repeatable: true }),
    // Даты сдачи справки в данных нет, поэтому, как и в 1.x, значок не выдаётся (сервер отзывает выданные)
    A('cert_1', 'attendance', 'Справка вовремя', 'Одна справка сдана до срока', { server: true, soon: true, group: 'cert', need: 1 }),
    A('cert_3', 'attendance', 'Справка вовремя · 3', 'Три справки сданы до срока', { server: true, soon: true, group: 'cert', need: 3 }),
    A('cert_5', 'attendance', 'Справка вовремя · 5', 'Пять справок сданы до срока', { server: true, soon: true, group: 'cert', need: 5 }),

    A('welcome', 'app', 'Добро пожаловать', 'Первый вход после обновления'),
    A('first_steps', 'app', 'Первые шаги', 'Поставить аватарку и открыть свой студак MarketPass', { need: 2 }),
    A('tech', 'app', 'Дотошный технарь', 'Прочитать «Что нового» до конца'),
    A('notify_on', 'app', 'Всегда в курсе', 'Включить уведомления о дедлайнах и домашке'),
    A('collector', 'app', 'Коллекционер', 'Собрать 10 значков', { need: 10 }),

    A('hw_1', 'homework', 'Первая ласточка', 'Одна домашка отмечена сделанной', { group: 'homework', need: 1 }),
    A('hw_3', 'homework', 'Втянулся', 'Три домашки отмечены сделанными', { group: 'homework', need: 3 }),
    A('hw_10', 'homework', 'Прилежный', 'Десять домашек отмечены сделанными', { group: 'homework', need: 10 }),
    A('hw_25', 'homework', 'Книжный червь', 'Двадцать пять домашек отмечены сделанными', { group: 'homework', need: 25 }),
    A('hw_50', 'homework', 'Машина знаний', 'Пятьдесят домашек отмечены сделанными', { group: 'homework', need: 50 }),

    // Антидостижения — за календарный месяц: 1-го числа счёт заново, значок можно получить снова (period = YYYY-MM)
    A('anti_m2', 'anti', 'Мимо пары', '2 неуважительных часа за месяц', { ...ANTI, need: 2 }),
    A('anti_m4', 'anti', 'Коридорный житель', '4 неуважительных часа за месяц', { ...ANTI, need: 4 }),
    A('anti_m6', 'anti', 'Завсегдатай буфета', '6 неуважительных часов за месяц', { ...ANTI, need: 6 }),
    A('anti_m8', 'anti', 'Слышал о расписании', '8 неуважительных часов за месяц', { ...ANTI, need: 8 }),
    A('anti_m10', 'anti', 'Дальний родственник группы', '10 неуважительных часов за месяц', { ...ANTI, need: 10 }),
    A('anti_m12', 'anti', 'Красная зона', '12 неуважительных часов за месяц', { ...ANTI, need: 12 }),
    A('anti_m14', 'anti', 'Вызов в деканат', '12 и больше неуважительных часов за месяц — порог деканата', { ...ANTI, need: 12 }),

    // Игры: пороги и очки живут в games-core.js, значок выдаёт сервер после проверенной партии; здесь только название и условие
    A('game_sudoku_fast', 'games', 'Быстрый ум', 'Судоку на лёгкой сложности быстрее 5 минут', GAME),
    A('game_sudoku_speed', 'games', 'Скоростной решатель', 'Судоку на средней сложности быстрее 8 минут', GAME),
    A('game_sudoku_master', 'games', 'Гроссмейстер клеток', 'Судоку на трудной сложности быстрее 12 минут', GAME),
    A('game_mines_steady', 'games', 'Твёрдая рука', 'Сапёр на лёгком уровне быстрее 45 секунд', GAME),
    A('game_mines_pro', 'games', 'Сапёр-профи', 'Сапёр на среднем уровне быстрее 3 минут', GAME),
    A('game_mines_perfect', 'games', 'Без права на ошибку', 'Сапёр на трудном уровне быстрее 6 минут', GAME),
    A('game_flappy_25', 'games', 'Набрал высоту', '25 труб во Flappy Bird', GAME),
    A('game_flappy_75', 'games', 'Покоритель небес', '75 труб во Flappy Bird', GAME),
    A('game_snake_bite', 'games', 'Первый перекус', 'Змейка съела первую еду', GAME),
    A('game_snake_30', 'games', 'Удав', 'Змейка длиной 30 клеток', GAME),
    A('game_snake_60', 'games', 'Анаконда', 'Змейка длиной 60 клеток', GAME),
    A('game_snake_top5', 'games', 'Заклинатель змей', 'Попасть в топ-5 рейтинга змейки', GAME),
    A('game_assoc_first', 'games', 'Догадливый', 'Первое угаданное «Слово дня»', GAME),
    A('game_assoc_flash', 'games', 'С полуслова', '«Слово дня» угадано за 10 попыток и без подсказок', GAME),
    A('game_assoc_week', 'games', 'Неделя догадок', '«Слово дня» угадано семь дней подряд', GAME),
    A('game_assoc_top5', 'games', 'Ассоциатор', 'Попасть в топ-5 «Ассоциаций» за месяц', GAME),
    A('game_player', 'games', 'Игрок', 'Сыграть хотя бы в одну игру журнала', GAME),
    A('game_all_five', 'games', 'Мастер на все руки', 'Сыграть во все пять игр', GAME),
    A('game_three_top5', 'games', 'Трижды в пятёрке', 'Одновременно в топ-5 любых трёх игр', GAME),
    A('game_five_top5', 'games', 'Пятёрка в пятёрке', 'Одновременно в топ-5 всех пяти игр', GAME),
  ];
  const BY_CODE = {};
  CATALOG.forEach((a) => { BY_CODE[a.code] = a; });
  const ladder = (group) => CATALOG.filter((a) => a.group === group).sort((a, b) => a.need - b.need);
  // «N из M»: антидостижения в счёт не идут, справки пока не выдаются — их в M нет
  const TOTAL = CATALOG.filter((a) => !a.anti && !a.soon).length;
  const counted = (code) => { const a = BY_CODE[code]; return !!a && !a.anti && !a.soon; };

  const monthOf = (d) => String(d).slice(0, 7);
  const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const monthName = (p) => MONTH_NAMES[Number(String(p).split('-')[1]) - 1] || p;

  // Текущая серия — с конца списка учебных дней; уважительный пропуск её не прерывает, день без пар в счёт не идёт
  function currentStreak(days, bad) { let run = 0; for (let i = days.length - 1; i >= 0; i--) { if (bad.has(days[i])) break; run++; } return run; }
  function bestStreak(days, bad) { let best = 0, run = 0; days.forEach((d) => { if (bad.has(d)) run = 0; else best = Math.max(best, ++run); }); return best; }

  // in: { asOf: 'YYYY-MM-DD' (последний учтённый день), studyDays: [iso], absences: [{ date, hours, isExcused }] (только свои),
  //       kinds: Set видов событий, homework: число отмеченных домашек, earned: Map code -> { earned_at, periods: Set } }
  function stats(inp) {
    const asOf = inp.asOf;
    const all = (inp.studyDays || []).slice().sort();
    const days = all.filter((d) => d <= asOf);
    const from = all[0] || '0000-01-01', to = all[all.length - 1] || '9999-12-31';
    const mine = (inp.absences || []).filter((a) => a.date && a.date >= from && a.date <= to);       // как achMyAbsences: только внутри учебного периода
    const bad = mine.filter((a) => !a.isExcused);
    const badDays = new Set(bad.map((a) => a.date));
    const month = monthOf(asOf);
    const monthDays = all.filter((d) => monthOf(d) === month);
    const months = [...new Set(all.map(monthOf))].sort();
    const prevMonth = months[months.indexOf(month) - 1] || null;
    const monthHours = {};
    bad.forEach((a) => { const m = monthOf(a.date); monthHours[m] = (monthHours[m] || 0) + (Number(a.hours) || 0); });
    const earned = inp.earned || new Map();
    return {
      asOf, all, days, bad, month, monthHours, kinds: inp.kinds || new Set(), homework: inp.homework || 0, earned,
      // месяц закрыт, когда все его учебные дни уже прошли
      closedMonths: months.filter((m) => { const d = all.filter((x) => monthOf(x) === m); return d.length > 0 && d[d.length - 1] <= asOf; }),
      monthUnexcused: monthHours[month] || 0,
      studyDaysPassed: days.length, studyDaysTotal: all.length,
      streak: currentStreak(days, badDays), bestStreak: bestStreak(days, badDays),
      monthDaysPassed: monthDays.filter((d) => d <= asOf).length, monthDaysTotal: monthDays.length,
      monthHasBad: bad.some((a) => monthOf(a.date) === month),
      prevMonth, prevMonthHadBad: prevMonth ? bad.some((a) => monthOf(a.date) === prevMonth) : false,
      termOver: asOf >= to, termHasBad: badDays.size > 0,
      badgesCount: [...earned.keys()].filter(counted).length,
    };
  }

  // Что заслужено прямо сейчас: [{ code, period }]. Для посещаемости это зеркало серверной attendance_badges_deserved
  // (клиент её не пишет, но проверяет тестом, что правила не разошлись); без cert_* — как в 1.x
  function deserved(s) {
    const out = [], add = (code, period) => out.push({ code, period: period || '' });
    ladder('streak').forEach((a) => { if (s.bestStreak >= a.need) add(a.code); });
    const hasBad = (m) => s.bad.some((a) => monthOf(a.date) === m);
    s.closedMonths.forEach((m) => { if (!hasBad(m)) add('clean_sheet', m); });
    for (let i = 1; i < s.closedMonths.length; i++) if (hasBad(s.closedMonths[i - 1]) && !hasBad(s.closedMonths[i])) add('recovered', s.closedMonths[i]);
    if (s.termOver && !s.termHasBad) add('clean_term');
    if (s.kinds.has('first_login')) add('welcome');
    if (s.kinds.has('avatar_set') && s.kinds.has('pass_opened')) add('first_steps');
    if (s.kinds.has('whats_new_read')) add('tech');
    if (s.kinds.has('notifications_on')) add('notify_on');
    ladder('homework').forEach((a) => { if (s.homework >= a.need) add(a.code); });
    // Коллекционер — последним: считает собранное и только что заслуженное
    const got = new Set([...s.earned.keys()].concat(out.map((o) => o.code)));
    if ([...got].filter(counted).length >= 10) add('collector');
    Object.keys(s.monthHours).sort().forEach((m) => ladder('anti').forEach((a) => { if (s.monthHours[m] >= a.need) add(a.code, m); }));
    return out;
  }
  // Заслуженное, но не записанное, из того, что вправе выдать клиент
  const clientDue = (s) => deserved(s).filter((d) => !BY_CODE[d.code].server && !(s.earned.get(d.code) && s.earned.get(d.code).periods.has(d.period)));

  const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };
  // Шкала одной карточки: { have, need, earned, text, blocked?, months?, checklist?, soon? }
  function progress(code, s) {
    const a = BY_CODE[code], e = s.earned.get(code), earned = !!e;
    if (!a) return null;
    if (a.soon) return { have: 0, need: a.need, earned, soon: true, text: 'Пока не выдаётся: в журнале нет даты сдачи справки' };
    if (code === 'clean_sheet') {
      if (s.monthHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом месяце уже не получить, новая попытка с 1-го' };
      return { have: s.monthDaysPassed, need: Math.max(1, s.monthDaysTotal), earned, text: `Прошло ${s.monthDaysPassed} из ${s.monthDaysTotal} учебных дней месяца без неуважительных` };
    }
    if (code === 'clean_term') {
      if (s.termHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом семестре уже не получить' };
      return { have: s.studyDaysPassed, need: Math.max(1, s.studyDaysTotal), earned, text: `${s.studyDaysPassed} из ${s.studyDaysTotal} учебных дней семестра` };
    }
    if (code === 'recovered') {
      if (!s.prevMonthHadBad) return { have: 0, need: 1, earned, text: 'В прошлом месяце неуважительных не было — исправляться не от чего' };
      if (s.monthHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом месяце уже есть неуважительные, новая попытка с 1-го' };
      return { have: s.monthDaysPassed, need: Math.max(1, s.monthDaysTotal), earned, text: `Доучиться месяц без неуважительных: ${s.monthDaysPassed} из ${s.monthDaysTotal} дней` };
    }
    if (a.group === 'streak') { const v = Math.min(s.streak, a.need); return { have: v, need: a.need, earned, text: `Серия ${v} из ${a.need} дней` }; }
    if (a.group === 'homework') { const v = Math.min(s.homework, a.need); return { have: v, need: a.need, earned, text: `${s.homework} из ${a.need} домашек` }; }
    if (a.group === 'anti') {
      const have = s.monthUnexcused, next = ladder('anti').find((x) => have < x.need);
      const tail = next && have < a.need ? ` · ещё ${next.need - have} ч — и следующее` : '';
      const months = e ? [...e.periods].filter(Boolean).sort().map(monthName) : [];
      return { have: Math.min(have, a.need), need: a.need, earned: months.length > 0 || earned, anti: true, months, text: `${have} ч неуважительных в этом месяце${tail}` };
    }
    if (code === 'first_steps') {
      const av = s.kinds.has('avatar_set'), ps = s.kinds.has('pass_opened'), done = (av ? 1 : 0) + (ps ? 1 : 0);
      return { have: done, need: 2, earned, text: `${done} из 2`, checklist: [{ text: 'Поставить аватарку', done: av }, { text: 'Открыть студак MarketPass', done: ps }] };
    }
    if (code === 'collector') return { have: Math.min(s.badgesCount, 10), need: 10, earned, text: `${s.badgesCount} из 10` };
    if (a.server) return { have: earned ? 1 : 0, need: 1, earned, text: earned ? 'Получено' : 'Выдаётся автоматически' };   // игры
    return { have: earned ? 1 : 0, need: 1, earned, text: earned ? 'Получено' : '0 из 1' };
  }

  // Ближайший значок — тот, до которого осталось меньше всего
  function nextUp(s) {
    let best = null;
    CATALOG.forEach((a) => {
      if (a.anti || a.soon || a.cat === 'games' || s.earned.has(a.code)) return;
      const p = progress(a.code, s);
      if (!p || p.blocked || !p.need) return;
      const left = (p.need - p.have) / p.need;
      if (!best || left < best.left) best = { a, p, left };
    });
    return best;
  }
  // Последний полученный значок (антидостижения не считаем)
  function latest(earned) {
    let best = null;
    earned.forEach((e, code) => { if (counted(code) && (!best || String(e.earned_at) > String(best.e.earned_at))) best = { a: BY_CODE[code], e }; });
    return best;
  }
  // Строки student_achievements → Map code -> { earned_at (самая ранняя), periods }
  function earnedMap(rows) {
    const m = new Map();
    (rows || []).forEach((r) => {
      if (!BY_CODE[r.code]) return;                                   // чужой/устаревший код (anti_2 и т. п.) на экран не попадает
      const p = m.get(r.code);
      if (!p) m.set(r.code, { earned_at: r.earned_at, periods: new Set([r.period || '']) });
      else { p.periods.add(r.period || ''); if (String(r.earned_at) < String(p.earned_at)) p.earned_at = r.earned_at; }
    });
    return m;
  }

  const api = { CATEGORIES, CATALOG, BY_CODE, TOTAL, ladder, counted, stats, deserved, clientDue, progress, nextUp, latest, earnedMap, plural, monthName };
  root.AchCalc = api;
})(window);
