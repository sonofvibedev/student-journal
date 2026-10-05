// Достижения: каталог, значки, подсчёт прогресса, события и рейтинг.
//
// Разделение труда между клиентом и сервером:
//   клиент  — считает прогресс для показа (видно сразу, без ожидания сервера);
//   сервер  — выдаёт сами значки с датой и строит рейтинг (Edge Function
//             recalc-achievements). Всё, что считает браузер, браузер может
//             и подделать, поэтому баллы в рейтинге идут только от сервера.
//
// Каталог здесь повторяет таблицу achievement_catalog в Supabase. Повтор
// сознательный: это подписи и пороги для экрана, их нужно показывать
// мгновенно и без сети. Правится в двух местах — в миграции и здесь.
//
// Данные берутся из:
//   data.json        — пропуски и домашка группы (уже загружены в appData);
//   study-days.json  — учебные дни семестра, собирается из schedule.js;
//   app_events       — что студент сделал в приложении (Supabase, только свои);
//   student_achievements, rpc_leaderboard — значки и рейтинг от сервера.

'use strict';

const ACH_POINTS_PER_HOUR = 5;      // столько баллов снимает один неуважительный час
const ACH_HW_MIGRATED_KEY = 'ach_hw_migrated';

// Категории в том порядке, в каком они идут на экране
const ACH_CATEGORIES = [
  { id: 'attendance', title: 'Посещаемость' },
  { id: 'app',        title: 'Приложение' },
  { id: 'homework',   title: 'Домашка' },
  { id: 'anti',       title: 'Антидостижения' }
];

// code, категория, название, за что, баллы, обод, лесенка, порог, повторяемое
const ACHIEVEMENTS = [
  { code: 'clean_sheet', cat: 'attendance', icon: 'clean',  tier: 'accent',   points: 50,  repeatable: true,
    title: 'Чистый лист', about: 'Календарный месяц без единого неуважительного часа' },
  { code: 'streak_3',  cat: 'attendance', icon: 'streak', tier: 'bronze',   points: 10, group: 'streak', need: 3,
    title: 'Разминка', about: '3 учебных дня подряд без неуважительных пропусков' },
  { code: 'streak_5',  cat: 'attendance', icon: 'streak', tier: 'bronze',   points: 15, group: 'streak', need: 5,
    title: 'Пятидневка', about: '5 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_10', cat: 'attendance', icon: 'streak', tier: 'silver',   points: 25, group: 'streak', need: 10,
    title: 'На волне', about: '10 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_15', cat: 'attendance', icon: 'streak', tier: 'silver',   points: 35, group: 'streak', need: 15,
    title: 'Железная воля', about: '15 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_20', cat: 'attendance', icon: 'streak', tier: 'gold',     points: 50, group: 'streak', need: 20,
    title: 'Несгибаемый', about: '20 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_30', cat: 'attendance', icon: 'streak', tier: 'platinum', points: 80, group: 'streak', need: 30,
    title: 'Легенда посещаемости', about: '30 учебных дней подряд без неуважительных пропусков' },
  { code: 'clean_term', cat: 'attendance', icon: 'cup', tier: 'accent', points: 150,
    title: 'Чистый семестр', about: 'Весь семестр без неуважительных часов' },
  { code: 'recovered', cat: 'attendance', icon: 'up', tier: 'accent', points: 30, repeatable: true,
    title: 'Исправился', about: 'Месяц без неуважительных сразу после месяца, в котором они были' },
  { code: 'cert_1', cat: 'attendance', icon: 'cert', tier: 'bronze', points: 10, group: 'cert', need: 1,
    title: 'Справка вовремя', about: 'Одна справка сдана до срока' },
  { code: 'cert_3', cat: 'attendance', icon: 'cert', tier: 'silver', points: 10, group: 'cert', need: 3,
    title: 'Справка вовремя · 3', about: 'Три справки сданы до срока' },
  { code: 'cert_5', cat: 'attendance', icon: 'cert', tier: 'gold', points: 10, group: 'cert', need: 5,
    title: 'Справка вовремя · 5', about: 'Пять справок сданы до срока' },

  { code: 'welcome', cat: 'app', icon: 'door', tier: 'accent', points: 5,
    title: 'Добро пожаловать', about: 'Первый вход после обновления' },
  { code: 'first_steps', cat: 'app', icon: 'steps', tier: 'accent', points: 15, need: 2,
    title: 'Первые шаги', about: 'Поставить аватарку и открыть свой студак MarketPass' },
  { code: 'tech', cat: 'app', icon: 'tech', tier: 'accent', points: 5,
    title: 'Дотошный технарь', about: 'Прочитать «Что нового» до конца' },
  { code: 'notify_on', cat: 'app', icon: 'bell', tier: 'accent', points: 5,
    title: 'Всегда в курсе', about: 'Включить уведомления о дедлайнах и домашке' },
  { code: 'collector', cat: 'app', icon: 'collector', tier: 'accent', points: 20, need: 10,
    title: 'Коллекционер', about: 'Собрать 10 достижений' },

  { code: 'hw_1',  cat: 'homework', icon: 'book', tier: 'bronze',   points: 5,  group: 'homework', need: 1,
    title: 'Первая ласточка', about: 'Одна домашка отмечена сделанной' },
  { code: 'hw_3',  cat: 'homework', icon: 'book', tier: 'bronze',   points: 10, group: 'homework', need: 3,
    title: 'Втянулся', about: 'Три домашки отмечены сделанными' },
  { code: 'hw_10', cat: 'homework', icon: 'book', tier: 'silver',   points: 20, group: 'homework', need: 10,
    title: 'Прилежный', about: 'Десять домашек отмечены сделанными' },
  { code: 'hw_25', cat: 'homework', icon: 'book', tier: 'gold',     points: 30, group: 'homework', need: 25,
    title: 'Книжный червь', about: 'Двадцать пять домашек отмечены сделанными' },
  { code: 'hw_50', cat: 'homework', icon: 'book', tier: 'platinum', points: 50, group: 'homework', need: 50,
    title: 'Машина знаний', about: 'Пятьдесят домашек отмечены сделанными' },

  { code: 'anti_2',  cat: 'anti', icon: 'shoe',  tier: 'anti', points: 0, group: 'anti', need: 2,  anti: true,
    title: 'Прогулял — бывает', about: '2 неуважительных часа за семестр' },
  { code: 'anti_6',  cat: 'anti', icon: 'desk',  tier: 'anti', points: 0, group: 'anti', need: 6,  anti: true,
    title: 'Ярый прогульщик', about: '6 неуважительных часов за семестр' },
  { code: 'anti_9',  cat: 'anti', icon: 'warn',  tier: 'anti', points: 0, group: 'anti', need: 9,  anti: true,
    title: 'Красная зона', about: '9 неуважительных часов за семестр' },
  { code: 'anti_18', cat: 'anti', icon: 'ghost', tier: 'anti', points: 0, group: 'anti', need: 18, anti: true,
    title: 'Призрак аудитории', about: '18 неуважительных часов за семестр' }
];

const ACH_BY_CODE = {};
ACHIEVEMENTS.forEach((a) => { ACH_BY_CODE[a.code] = a; });
const achLadder = (group) => ACHIEVEMENTS.filter((a) => a.group === group).sort((a, b) => a.need - b.need);

// ===== Значки =====
// Контурные иконки в стиле приложения: viewBox 24, stroke 1.8, круглые концы.
// {n} подставляется числом (дни серии, количество домашек).
const ACH_ICONS = {
  clean: '<path d="M7 3.5h7l4 4V20a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5v4h4"/><path d="M9 14.2l2.1 2.1L15.4 12"/>',
  streak: '<path d="M12.4 2.6c.5 2.5-.6 4-1.9 5.2-1.6 1.5-3.2 3-3.2 5.8a4.7 4.7 0 0 0 9.4 0c0-2.2-.9-3.8-2.1-5-.4.9-1 1.5-1.8 1.8.6-2.6 0-5.1-.4-7.8z"/><text x="12" y="17.6" text-anchor="middle" font-size="6.4" font-weight="700" stroke="none" fill="currentColor">{n}</text>',
  cup: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5.5H5.5V7a3 3 0 0 0 2.9 3M16 5.5h2.5V7a3 3 0 0 1-2.9 3"/><path d="M12 13v3.5M9 20.5h6l-.6-3.5h-4.8z"/>',
  up: '<path d="M12 20.5V5.6"/><path d="M6.5 11.1L12 5.6l5.5 5.5"/><path d="M5 3h14"/>',
  cert: '<path d="M12.6 20.5H7a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1h6.5L17 7v4.3"/><path d="M13.5 3.5V7H17"/><circle cx="16.6" cy="16.6" r="4.4"/><path d="M16.6 14.3v2.4l1.6 1"/>',
  door: '<path d="M3.4 20.8h17.2"/><path d="M14.6 4.4h4.2v16.4h-4.2"/><path d="M14.6 2.4L7.2 4.8v14l7.4 2.4z"/><path d="M13 12.1v1.8"/>',
  // Единственная заливная иконка набора: контурный след на 36 px читается как клякса
  steps: '<g fill="currentColor" stroke="none"><path d="M8.7 4.4c1.3 0 2.1 1.3 2.1 3.1 0 1.5-.5 2.8-.5 3.9 0 1-.5 1.5-1.8 1.5-1.8 0-3-1.3-3-3.3 0-2.9 1.4-5.2 3.2-5.2z"/><ellipse cx="8.4" cy="15.2" rx="1.8" ry="1.6"/><path d="M15.3 9.1c1.3 0 2.1 1.3 2.1 3.1 0 1.5-.5 2.8-.5 3.9 0 1-.5 1.5-1.8 1.5-1.8 0-3-1.3-3-3.3 0-2.9 1.4-5.2 3.2-5.2z"/><ellipse cx="15" cy="19.9" rx="1.8" ry="1.6"/></g>',
  tech: '<circle cx="10.4" cy="10.4" r="3.1"/><path d="M10.4 4.1v1.7M10.4 15v1.7M4.1 10.4h1.7M15 10.4h1.7M5.9 5.9l1.2 1.2M13.7 13.7l1.2 1.2M14.9 5.9l-1.2 1.2M5.9 14.9l1.2-1.2"/><circle cx="16.1" cy="16.1" r="3.4"/><path d="M18.5 18.5l2.3 2.3"/>',
  bell: '<path d="M12 3v1.4"/><path d="M6.4 16.6V11a5.6 5.6 0 0 1 11.2 0v5.6l1.5 1.7H4.9z"/><path d="M10 20.4a2.2 2.2 0 0 0 4 0"/>',
  collector: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2"/><path d="M3.4 8.2h17.2"/><path d="M7.4 8.2l1.1 2.6M9.6 8.2l-1.1 2.6"/><circle cx="8.5" cy="15" r="2.4"/><path d="M14.4 8.2l1.1 2.6M16.6 8.2l-1.1 2.6"/><circle cx="15.5" cy="15" r="2.4"/>',
  book: '<rect x="6.2" y="3.8" width="12.4" height="16.4" rx="1.8"/><path d="M9.4 3.8v16.4"/><path d="M6.8 6.8h2M6.8 9.8h2M6.8 12.8h2M6.8 15.8h2"/><text x="14" y="14.6" text-anchor="middle" font-size="6.4" font-weight="700" stroke="none" fill="currentColor">{n}</text>',
  shoe: '<path d="M3.4 16.8v-5.4h3.3l2.6 1.9 3.6.6 4.4 1.9a3.1 3.1 0 0 1 1.8 2.8v.5H3.4z"/><path d="M3.4 19.1h17.2"/><path d="M6.8 11.4l1.3 2.3M10 13l1.1 2M13.3 13.9l1.1 2"/>',
  desk: '<path d="M3.2 10.6h17.6"/><path d="M5.8 10.6V20.4M18.2 10.6V20.4"/><path d="M6.9 15h10.2"/><path d="M8.6 10.6V7.4a1.2 1.2 0 0 1 1.2-1.2h4.4a1.2 1.2 0 0 1 1.2 1.2v3.2"/>',
  warn: '<path d="M12 3.8L21 19.8H3z"/><path d="M12 9.8v4.3"/><circle cx="12" cy="16.9" r=".95" fill="currentColor" stroke="none"/>',
  ghost: '<path d="M5.6 20.6V10a6.4 6.4 0 0 1 12.8 0v10.6l-2.1-1.8-2.2 1.8-2.1-1.8-2.2 1.8z"/><circle cx="9.9" cy="10.3" r=".95" fill="currentColor" stroke="none"/><circle cx="14.1" cy="10.3" r=".95" fill="currentColor" stroke="none"/>'
};

const ACH_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/></svg>';

// Значок: круглая медаль. locked — серый, полупрозрачный, с замочком.
function achBadgeHtml(code, locked) {
  const a = ACH_BY_CODE[code];
  if (!a) return '';
  const body = (ACH_ICONS[a.icon] || '').replace('{n}', a.need == null || a.group === 'cert' ? '' : a.need);
  return '<span class="ach-badge tier-' + a.tier + (locked ? ' is-locked' : '') + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body + '</svg>' +
    (locked ? '<span class="ach-lock">' + ACH_LOCK + '</span>' : '') +
    '</span>';
}

// ===== Состояние =====
// studyDays — учебные дни семестра, earned — выданные сервером значки,
// events — свои события из app_events, board — рейтинг.
const achState = {
  studyDays: null,       // { semester, days: [], semesterStart, semesterEnd }
  earned: new Map(),     // code -> { earned_at, period, points }
  kinds: new Set(),      // first_login, avatar_set, …
  homeworkDone: new Set(),
  board: [],
  loaded: false
};

async function achLoadStudyDays() {
  if (achState.studyDays) return achState.studyDays;
  try {
    const res = await fetch('./study-days.json?t=' + Date.now());
    achState.studyDays = await res.json();
  } catch (e) {
    achState.studyDays = { semester: 'unknown', days: [] };
  }
  return achState.studyDays;
}

// Свои значки и события. Гостю ничего не грузим: у него нет аккаунта.
async function achLoadMine() {
  achState.earned.clear();
  achState.kinds.clear();
  achState.homeworkDone.clear();
  if (!sb || AppState.auth !== 'signed') return;
  try {
    const [{ data: badges }, { data: events }] = await Promise.all([
      sb.from('student_achievements').select('code, period, points, earned_at'),
      sb.from('app_events').select('kind, ref')
    ]);
    (badges || []).forEach((b) => {
      const prev = achState.earned.get(b.code);
      if (!prev || String(b.earned_at) < String(prev.earned_at)) achState.earned.set(b.code, b);
    });
    (events || []).forEach((e) => {
      if (e.kind === 'homework_done') achState.homeworkDone.add(e.ref);
      else achState.kinds.add(e.kind);
    });
  } catch (e) { console.error('Достижения не загрузились:', e); }
}

async function achLoadBoard() {
  achState.board = [];
  if (!sb || AppState.auth !== 'signed') return;
  try {
    const { data, error } = await sb.rpc('rpc_leaderboard', { p_semester: null });
    if (error) throw error;
    achState.board = data || [];
  } catch (e) { console.error('Рейтинг не загрузился:', e); }
}

async function achLoadAll() {
  await Promise.all([achLoadStudyDays(), achLoadMine(), achLoadBoard()]);
  achState.loaded = true;
}

// ===== Запись событий =====
// user_id и student_id ставит база, клиент их не передаёт. Повтор не страшен:
// уникальный индекс не даст записать одно и то же дважды.
async function achLogEvent(kind, ref) {
  if (!sb || AppState.auth !== 'signed') return false;
  const key = String(ref || '');
  if (kind === 'homework_done' ? achState.homeworkDone.has(key) : (achState.kinds.has(kind) && !key)) return false;
  try {
    const { error } = await sb.from('app_events').insert({ kind, ref: key });
    if (error && error.code !== '23505') throw error;     // 23505 — уже отмечено
    if (kind === 'homework_done') achState.homeworkDone.add(key); else achState.kinds.add(kind);
    return true;
  } catch (e) { console.error('Событие не записалось:', kind, e); return false; }
}

async function achUnlogHomework(homeworkId) {
  if (!sb || AppState.auth !== 'signed') return;
  try {
    await sb.from('app_events').delete().eq('kind', 'homework_done').eq('ref', String(homeworkId));
    achState.homeworkDone.delete(String(homeworkId));
  } catch (e) { console.error('Отметка не снялась:', e); }
}

// Отметки «Сделано», накопленные на устройстве до перехода на Supabase.
// Переносим один раз: ключ hw_done_<student_id> хранил «дата|занятие»,
// а в базе отметка привязана к самому заданию.
async function achMigrateLocalHomework() {
  if (!sb || AppState.auth !== 'signed') return;
  if (lsGet(ACH_HW_MIGRATED_KEY)) return;
  try {
    let map = {};
    try { map = JSON.parse(lsGet('hw_done_' + AppState.studentId) || '{}'); } catch (e) { map = {}; }
    const ids = new Set();
    Object.keys(map).forEach((key) => {
      if (!map[key]) return;
      const [iso, lessonId] = String(key).split('|');
      if (!iso || !lessonId || typeof lessonsOfDay !== 'function') return;
      const date = deadlineDate(iso);
      const week = currentSemesterWeek(date);
      const day = date.getDay() === 0 ? 7 : date.getDay();
      if (!week || day > 6) return;
      (lessonsOfDay(week, day) || [])
        .filter((l) => String(l.id) === lessonId)
        .forEach((l) => homeworkForLesson(l, iso).forEach((h) => ids.add(h.id)));
    });
    for (const id of ids) await achLogEvent('homework_done', id);
    lsSet(ACH_HW_MIGRATED_KEY, '1');
  } catch (e) { console.error('Перенос отметок «Сделано» не удался:', e); }
}

// ===== Подсчёт прогресса на клиенте =====
const achMonthOf = (date) => String(date).slice(0, 7);

function achAsOf() {
  const iso = String((typeof appData !== 'undefined' && appData.lastUpdated) || '').slice(0, 10);
  return iso || dayKey(new Date());
}

function achMyAbsences() {
  const id = AppState.studentId;
  const days = (achState.studyDays && achState.studyDays.days) || [];
  const from = days[0] || '0000-01-01';
  const to = days[days.length - 1] || '9999-12-31';
  if (!id || typeof appData === 'undefined') return [];
  return (appData.absences || []).filter((a) => a.studentId === id && a.date >= from && a.date <= to);
}

// Самая длинная серия учебных дней подряд без неуважительного пропуска
function achStreak(studyDays, badDays) {
  let best = 0, run = 0;
  studyDays.forEach((day) => {
    if (badDays.has(day)) run = 0; else best = Math.max(best, ++run);
  });
  return best;
}

// Текущая серия — та, что идёт прямо сейчас, с конца списка дней
function achCurrentStreak(studyDays, badDays) {
  let run = 0;
  for (let i = studyDays.length - 1; i >= 0; i--) {
    if (badDays.has(studyDays[i])) break;
    run++;
  }
  return run;
}

// Всё, что нужно экрану: часы, серия, месяцы, справки, домашка, баллы
function achStats() {
  const asOf = achAsOf();
  const all = ((achState.studyDays && achState.studyDays.days) || []).slice().sort();
  const studyDays = all.filter((d) => d <= asOf);
  const mine = achMyAbsences();
  const unexcusedHours = mine.filter((a) => !a.isExcused).reduce((s, a) => s + (Number(a.totalHours) || 0), 0);
  const badDays = new Set(mine.filter((a) => !a.isExcused && a.date).map((a) => a.date));

  const month = achMonthOf(asOf);
  const monthDays = all.filter((d) => achMonthOf(d) === month);
  const monthPassed = monthDays.filter((d) => d <= asOf);
  const monthHasBad = mine.some((a) => !a.isExcused && achMonthOf(a.date) === month);

  // Предыдущий месяц семестра — нужен «Исправился»
  const months = [...new Set(all.map(achMonthOf))].sort();
  const prevMonth = months[months.indexOf(month) - 1] || null;
  const prevMonthHadBad = prevMonth
    ? mine.some((a) => !a.isExcused && achMonthOf(a.date) === prevMonth) : false;

  return {
    asOf,
    semester: (achState.studyDays && achState.studyDays.semester) || '',
    unexcusedHours,
    studyDaysPassed: studyDays.length,
    studyDaysTotal: all.length,
    streak: achCurrentStreak(studyDays, badDays),
    bestStreak: achStreak(studyDays, badDays),
    month, monthDaysPassed: monthPassed.length, monthDaysTotal: monthDays.length, monthHasBad,
    prevMonth, prevMonthHadBad,
    termHasBad: badDays.size > 0,
    certsOnTime: mine.filter((a) => a.isExcused && a.certSubmittedAt && a.certDueDate && a.certSubmittedAt <= a.certDueDate).length,
    homeworkDone: achState.homeworkDone.size,
    badgesCount: [...achState.earned.keys()].filter((c) => !(ACH_BY_CODE[c] || {}).anti).length,
    points: achMyPoints()
  };
}

// Баллы за семестр: сумма за полученные значки минус 5 за каждый неуважительный час
function achMyPoints() {
  let sum = 0;
  achState.earned.forEach((row, code) => {
    const a = ACH_BY_CODE[code];
    if (a && !a.anti) sum += Number(row.points) || a.points || 0;
  });
  const mine = achMyAbsences();
  const hours = mine.filter((a) => !a.isExcused).reduce((s, a) => s + (Number(a.totalHours) || 0), 0);
  return sum - Math.round(hours * ACH_POINTS_PER_HOUR);
}

// Шкала выполнения одной карточки: сколько есть, сколько нужно и подпись
function achProgressOf(code, stats) {
  const a = ACH_BY_CODE[code];
  const earned = achState.earned.has(code);
  if (!a) return null;

  if (a.code === 'clean_sheet') {
    if (stats.monthHasBad) {
      return { have: 0, need: 1, text: 'В этом месяце уже не получить, новая попытка с 1-го', blocked: true, earned };
    }
    return {
      have: stats.monthDaysPassed, need: Math.max(1, stats.monthDaysTotal), earned,
      text: `Прошло ${stats.monthDaysPassed} из ${stats.monthDaysTotal} учебных дней месяца без неуважительных`
    };
  }
  if (a.code === 'clean_term') {
    if (stats.termHasBad) {
      return { have: 0, need: 1, text: 'В этом семестре уже не получить', blocked: true, earned };
    }
    return {
      have: stats.studyDaysPassed, need: Math.max(1, stats.studyDaysTotal), earned,
      text: `${stats.studyDaysPassed} из ${stats.studyDaysTotal} учебных дней семестра`
    };
  }
  if (a.code === 'recovered') {
    if (!stats.prevMonthHadBad) {
      return { have: 0, need: 1, earned, text: 'В прошлом месяце неуважительных не было — исправляться не от чего' };
    }
    if (stats.monthHasBad) {
      return { have: 0, need: 1, earned, blocked: true, text: 'В этом месяце уже есть неуважительные, новая попытка с 1-го' };
    }
    return {
      have: stats.monthDaysPassed, need: Math.max(1, stats.monthDaysTotal), earned,
      text: `Доучиться месяц без неуважительных: ${stats.monthDaysPassed} из ${stats.monthDaysTotal} дней`
    };
  }
  if (a.group === 'streak') {
    return { have: Math.min(stats.streak, a.need), need: a.need, earned, text: `Серия ${stats.streak} из ${a.need} дней` };
  }
  if (a.group === 'cert') {
    return { have: Math.min(stats.certsOnTime, a.need), need: a.need, earned, text: `${stats.certsOnTime} из ${a.need} справок вовремя` };
  }
  if (a.group === 'homework') {
    return { have: Math.min(stats.homeworkDone, a.need), need: a.need, earned, text: `${stats.homeworkDone} из ${a.need} домашек` };
  }
  if (a.group === 'anti') {
    return { have: Math.min(stats.unexcusedHours, a.need), need: a.need, earned, anti: true,
      text: `${stats.unexcusedHours} ч неуважительных за семестр` };
  }
  if (a.code === 'first_steps') {
    const done = (achState.kinds.has('avatar_set') ? 1 : 0) + (achState.kinds.has('pass_opened') ? 1 : 0);
    return { have: done, need: 2, earned, text: `${done} из 2`,
      checklist: [
        { text: 'Поставить аватарку', done: achState.kinds.has('avatar_set') },
        { text: 'Открыть студак MarketPass', done: achState.kinds.has('pass_opened') }
      ] };
  }
  if (a.code === 'collector') {
    return { have: Math.min(stats.badgesCount, 10), need: 10, earned, text: `${stats.badgesCount} из 10` };
  }
  // Одношаговые: Добро пожаловать, Дотошный технарь, Всегда в курсе
  return { have: earned ? 1 : 0, need: 1, earned, text: earned ? 'Получено' : '0 из 1' };
}

// Ближайшее достижение — то, до которого осталось меньше всего
function achNextUp(stats) {
  let best = null;
  ACHIEVEMENTS.forEach((a) => {
    if (a.anti || achState.earned.has(a.code)) return;
    const p = achProgressOf(a.code, stats);
    if (!p || p.blocked || !p.need) return;
    const left = (p.need - p.have) / p.need;
    if (!best || left < best.left) best = { a, p, left };
  });
  return best;
}

// Последний полученный значок
function achLatest() {
  let best = null;
  achState.earned.forEach((row, code) => {
    if ((ACH_BY_CODE[code] || {}).anti) return;
    if (!best || String(row.earned_at) > String(best.row.earned_at)) best = { code, row };
  });
  return best;
}

// Моё место в рейтинге
function achMyPlace() {
  const id = AppState.studentId;
  const row = achState.board.find((r) => r.student_id === id);
  return row ? row.place : null;
}
