// Достижения: значки за учёбу, домашку и приложение.
//
// Баллов и рейтинга группы здесь нет — только личная коллекция значков.
// Раз соревнования нет, то и подделывать нечего, поэтому всё считает сам
// клиент: так значок появляется сразу, без ожидания сервера и без cron.
// Supabase нужен только чтобы коллекция не терялась при смене устройства:
//   app_events           — что студент сделал в приложении;
//   student_achievements — выданные значки с датой.
//
// Данные для подсчёта:
//   data.json       — пропуски и домашка группы (уже загружены в appData);
//   study-days.json — учебные дни семестра, собирается из schedule.js;
//   app_events      — свои события.

'use strict';

const ACH_HW_MIGRATED_KEY = 'ach_hw_migrated';

// Категории в том порядке, в каком они идут на экране
const ACH_CATEGORIES = [
  { id: 'attendance', title: 'Посещаемость' },
  { id: 'app',        title: 'Приложение' },
  { id: 'homework',   title: 'Домашка' },
  { id: 'anti',       title: 'Антидостижения' }
];

// code, категория, иконка, обод, лесенка, порог, название, за что
const ACHIEVEMENTS = [
  { code: 'clean_sheet', cat: 'attendance', icon: 'clean',  tier: 'accent', repeatable: true,
    title: 'Чистый лист', about: 'Календарный месяц без единого неуважительного часа' },
  { code: 'streak_3',  cat: 'attendance', icon: 'streak', tier: 'bronze',   group: 'streak', need: 3,
    title: 'Разминка', about: '3 учебных дня подряд без неуважительных пропусков' },
  { code: 'streak_5',  cat: 'attendance', icon: 'streak', tier: 'bronze',   group: 'streak', need: 5,
    title: 'Пятидневка', about: '5 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_10', cat: 'attendance', icon: 'streak', tier: 'silver',   group: 'streak', need: 10,
    title: 'На волне', about: '10 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_15', cat: 'attendance', icon: 'streak', tier: 'silver',   group: 'streak', need: 15,
    title: 'Железная воля', about: '15 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_20', cat: 'attendance', icon: 'streak', tier: 'gold',     group: 'streak', need: 20,
    title: 'Несгибаемый', about: '20 учебных дней подряд без неуважительных пропусков' },
  { code: 'streak_30', cat: 'attendance', icon: 'streak', tier: 'platinum', group: 'streak', need: 30,
    title: 'Легенда посещаемости', about: '30 учебных дней подряд без неуважительных пропусков' },
  { code: 'clean_term', cat: 'attendance', icon: 'cup', tier: 'accent',
    title: 'Чистый семестр', about: 'Весь семестр без неуважительных часов' },
  { code: 'recovered', cat: 'attendance', icon: 'up', tier: 'accent', repeatable: true,
    title: 'Исправился', about: 'Месяц без неуважительных сразу после месяца, в котором они были' },
  { code: 'cert_1', cat: 'attendance', icon: 'cert', tier: 'bronze', group: 'cert', need: 1,
    title: 'Справка вовремя', about: 'Одна справка сдана до срока' },
  { code: 'cert_3', cat: 'attendance', icon: 'cert', tier: 'silver', group: 'cert', need: 3,
    title: 'Справка вовремя · 3', about: 'Три справки сданы до срока' },
  { code: 'cert_5', cat: 'attendance', icon: 'cert', tier: 'gold', group: 'cert', need: 5,
    title: 'Справка вовремя · 5', about: 'Пять справок сданы до срока' },

  { code: 'welcome', cat: 'app', icon: 'door', tier: 'accent',
    title: 'Добро пожаловать', about: 'Первый вход после обновления' },
  { code: 'first_steps', cat: 'app', icon: 'steps', tier: 'accent', need: 2,
    title: 'Первые шаги', about: 'Поставить аватарку и открыть свой студак MarketPass' },
  { code: 'tech', cat: 'app', icon: 'tech', tier: 'accent',
    title: 'Дотошный технарь', about: 'Прочитать «Что нового» до конца' },
  { code: 'notify_on', cat: 'app', icon: 'bell', tier: 'accent',
    title: 'Всегда в курсе', about: 'Включить уведомления о дедлайнах и домашке' },
  { code: 'collector', cat: 'app', icon: 'collector', tier: 'accent', need: 10,
    title: 'Коллекционер', about: 'Собрать 10 значков' },

  { code: 'hw_1',  cat: 'homework', icon: 'book', tier: 'bronze',   group: 'homework', need: 1,
    title: 'Первая ласточка', about: 'Одна домашка отмечена сделанной' },
  { code: 'hw_3',  cat: 'homework', icon: 'book', tier: 'bronze',   group: 'homework', need: 3,
    title: 'Втянулся', about: 'Три домашки отмечены сделанными' },
  { code: 'hw_10', cat: 'homework', icon: 'book', tier: 'silver',   group: 'homework', need: 10,
    title: 'Прилежный', about: 'Десять домашек отмечены сделанными' },
  { code: 'hw_25', cat: 'homework', icon: 'book', tier: 'gold',     group: 'homework', need: 25,
    title: 'Книжный червь', about: 'Двадцать пять домашек отмечены сделанными' },
  { code: 'hw_50', cat: 'homework', icon: 'book', tier: 'platinum', group: 'homework', need: 50,
    title: 'Машина знаний', about: 'Пятьдесят домашек отмечены сделанными' },

  { code: 'anti_2',  cat: 'anti', icon: 'shoe',  tier: 'anti', group: 'anti', need: 2,  anti: true,
    title: 'Прогулял — бывает', about: '2 неуважительных часа за семестр' },
  { code: 'anti_6',  cat: 'anti', icon: 'desk',  tier: 'anti', group: 'anti', need: 6,  anti: true,
    title: 'Ярый прогульщик', about: '6 неуважительных часов за семестр' },
  { code: 'anti_9',  cat: 'anti', icon: 'warn',  tier: 'anti', group: 'anti', need: 9,  anti: true,
    title: 'Красная зона', about: '9 неуважительных часов за семестр' },
  { code: 'anti_18', cat: 'anti', icon: 'ghost', tier: 'anti', group: 'anti', need: 18, anti: true,
    title: 'Призрак аудитории', about: '18 неуважительных часов за семестр' }
];

const ACH_BY_CODE = {};
ACHIEVEMENTS.forEach((a) => { ACH_BY_CODE[a.code] = a; });
const achLadder = (group) => ACHIEVEMENTS.filter((a) => a.group === group).sort((a, b) => a.need - b.need);
const ACH_TOTAL = ACHIEVEMENTS.filter((a) => !a.anti).length;

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
const achState = {
  studyDays: null,        // { semester, days: [] }
  earned: new Map(),      // code -> { earned_at, period }
  kinds: new Set(),       // first_login, avatar_set, …
  homeworkDone: new Set(),
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
      sb.from('student_achievements').select('code, period, earned_at'),
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
    achCheckEarned();
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

// ===== Подсчёт =====
const achMonthOf = (date) => String(date).slice(0, 7);

// Считаем по данным, которые староста уже внёс: «Пропуски актуальны на»
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

// Текущая серия — та, что идёт прямо сейчас, с конца списка учебных дней.
// Уважительный пропуск её не прерывает, день без пар в счёт не идёт.
function achCurrentStreak(studyDays, badDays) {
  let run = 0;
  for (let i = studyDays.length - 1; i >= 0; i--) {
    if (badDays.has(studyDays[i])) break;
    run++;
  }
  return run;
}
// Самая длинная серия за семестр — по ней и выдаются ступени
function achBestStreak(studyDays, badDays) {
  let best = 0, run = 0;
  studyDays.forEach((day) => {
    if (badDays.has(day)) run = 0; else best = Math.max(best, ++run);
  });
  return best;
}

// Всё, что нужно экрану: часы, серия, месяцы, справки, домашка
function achStats() {
  const asOf = achAsOf();
  const all = ((achState.studyDays && achState.studyDays.days) || []).slice().sort();
  const studyDays = all.filter((d) => d <= asOf);
  const mine = achMyAbsences();
  const unexcusedHours = mine.filter((a) => !a.isExcused).reduce((s, a) => s + (Number(a.totalHours) || 0), 0);
  const badDays = new Set(mine.filter((a) => !a.isExcused && a.date).map((a) => a.date));

  const month = achMonthOf(asOf);
  const monthDays = all.filter((d) => achMonthOf(d) === month);
  const monthHasBad = mine.some((a) => !a.isExcused && achMonthOf(a.date) === month);

  const months = [...new Set(all.map(achMonthOf))].sort();
  const prevMonth = months[months.indexOf(month) - 1] || null;
  const prevMonthHadBad = prevMonth ? mine.some((a) => !a.isExcused && achMonthOf(a.date) === prevMonth) : false;

  // Месяц закрыт, когда все его учебные дни уже прошли по данным журнала
  const closedMonths = months.filter((m) => {
    const days = all.filter((d) => achMonthOf(d) === m);
    return days.length > 0 && days[days.length - 1] <= asOf;
  });

  return {
    asOf, all, studyDays, mine, closedMonths,
    semester: (achState.studyDays && achState.studyDays.semester) || '',
    unexcusedHours,
    studyDaysPassed: studyDays.length,
    studyDaysTotal: all.length,
    streak: achCurrentStreak(studyDays, badDays),
    bestStreak: achBestStreak(studyDays, badDays),
    month,
    monthDaysPassed: monthDays.filter((d) => d <= asOf).length,
    monthDaysTotal: monthDays.length,
    monthHasBad, prevMonth, prevMonthHadBad,
    termOver: asOf >= (all[all.length - 1] || '9999-12-31'),
    termHasBad: badDays.size > 0,
    certsOnTime: mine.filter((a) => a.isExcused && a.certSubmittedAt && a.certDueDate && a.certSubmittedAt <= a.certDueDate).length,
    homeworkDone: achState.homeworkDone.size,
    badgesCount: [...achState.earned.keys()].filter((c) => !(ACH_BY_CODE[c] || {}).anti).length
  };
}

// Какие значки заслужены прямо сейчас: [{ code, period }]
function achDeserved(stats) {
  const out = [];
  const add = (code, period) => out.push({ code, period: period || '' });

  achLadder('streak').forEach((s) => { if (stats.bestStreak >= s.need) add(s.code); });
  stats.closedMonths.forEach((m) => {
    const bad = stats.mine.some((a) => !a.isExcused && achMonthOf(a.date) === m);
    if (!bad) add('clean_sheet', m);
  });
  for (let i = 1; i < stats.closedMonths.length; i++) {
    const prev = stats.closedMonths[i - 1], m = stats.closedMonths[i];
    const prevBad = stats.mine.some((a) => !a.isExcused && achMonthOf(a.date) === prev);
    const nowBad = stats.mine.some((a) => !a.isExcused && achMonthOf(a.date) === m);
    if (prevBad && !nowBad) add('recovered', m);
  }
  if (stats.termOver && !stats.termHasBad) add('clean_term');
  achLadder('cert').forEach((s) => { if (stats.certsOnTime >= s.need) add(s.code); });

  if (achState.kinds.has('first_login')) add('welcome');
  if (achState.kinds.has('avatar_set') && achState.kinds.has('pass_opened')) add('first_steps');
  if (achState.kinds.has('whats_new_read')) add('tech');
  if (achState.kinds.has('notifications_on')) add('notify_on');
  achLadder('homework').forEach((s) => { if (stats.homeworkDone >= s.need) add(s.code); });

  // Коллекционер — последним: считает уже собранные и только что заслуженные
  const collected = new Set([...achState.earned.keys()].concat(out.map((o) => o.code)));
  const nonAnti = [...collected].filter((c) => !(ACH_BY_CODE[c] || {}).anti).length;
  if (nonAnti >= 10) add('collector');

  achLadder('anti').forEach((s) => { if (stats.unexcusedHours >= s.need) add(s.code); });
  return out;
}

// Заслуженное, но ещё не записанное — записываем и показываем всплывашку
async function achCheckEarned() {
  if (!sb || AppState.auth !== 'signed' || !achState.studyDays) return;
  const stats = achStats();
  const fresh = achDeserved(stats).filter((d) => !achState.earned.has(d.code));
  if (!fresh.length) return;

  const now = new Date().toISOString();
  const rows = fresh.map((d) => ({
    student_id: AppState.studentId, code: d.code, period: d.period,
    semester: stats.semester, earned_at: now
  }));
  try {
    const { error } = await sb.from('student_achievements').insert(rows);
    if (error && error.code !== '23505') throw error;
  } catch (e) { console.error('Значок не записался:', e); }

  fresh.forEach((d) => achState.earned.set(d.code, { code: d.code, period: d.period, earned_at: now }));
  achShowNewBadges();
  renderHomeAchievements();
  renderProfileBadges();
  if (currentViewName === 'achievements') renderAchievementsView();
}

// Шкала выполнения одной карточки: сколько есть, сколько нужно и подпись
function achProgressOf(code, stats) {
  const a = ACH_BY_CODE[code];
  const earned = achState.earned.has(code);
  if (!a) return null;

  if (a.code === 'clean_sheet') {
    if (stats.monthHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом месяце уже не получить, новая попытка с 1-го' };
    return { have: stats.monthDaysPassed, need: Math.max(1, stats.monthDaysTotal), earned,
      text: `Прошло ${stats.monthDaysPassed} из ${stats.monthDaysTotal} учебных дней месяца без неуважительных` };
  }
  if (a.code === 'clean_term') {
    if (stats.termHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом семестре уже не получить' };
    return { have: stats.studyDaysPassed, need: Math.max(1, stats.studyDaysTotal), earned,
      text: `${stats.studyDaysPassed} из ${stats.studyDaysTotal} учебных дней семестра` };
  }
  if (a.code === 'recovered') {
    if (!stats.prevMonthHadBad) return { have: 0, need: 1, earned, text: 'В прошлом месяце неуважительных не было — исправляться не от чего' };
    if (stats.monthHasBad) return { have: 0, need: 1, earned, blocked: true, text: 'В этом месяце уже есть неуважительные, новая попытка с 1-го' };
    return { have: stats.monthDaysPassed, need: Math.max(1, stats.monthDaysTotal), earned,
      text: `Доучиться месяц без неуважительных: ${stats.monthDaysPassed} из ${stats.monthDaysTotal} дней` };
  }
  if (a.group === 'streak')   return { have: Math.min(stats.streak, a.need), need: a.need, earned, text: `Серия ${stats.streak} из ${a.need} дней` };
  if (a.group === 'cert')     return { have: Math.min(stats.certsOnTime, a.need), need: a.need, earned, text: `${stats.certsOnTime} из ${a.need} справок вовремя` };
  if (a.group === 'homework') return { have: Math.min(stats.homeworkDone, a.need), need: a.need, earned, text: `${stats.homeworkDone} из ${a.need} домашек` };
  if (a.group === 'anti')     return { have: Math.min(stats.unexcusedHours, a.need), need: a.need, earned, anti: true,
    text: `${stats.unexcusedHours} ч неуважительных за семестр` };

  if (a.code === 'first_steps') {
    const done = (achState.kinds.has('avatar_set') ? 1 : 0) + (achState.kinds.has('pass_opened') ? 1 : 0);
    return { have: done, need: 2, earned, text: `${done} из 2`,
      checklist: [
        { text: 'Поставить аватарку', done: achState.kinds.has('avatar_set') },
        { text: 'Открыть студак MarketPass', done: achState.kinds.has('pass_opened') }
      ] };
  }
  if (a.code === 'collector') return { have: Math.min(stats.badgesCount, 10), need: 10, earned, text: `${stats.badgesCount} из 10` };

  // Одношаговые: Добро пожаловать, Дотошный технарь, Всегда в курсе
  return { have: earned ? 1 : 0, need: 1, earned, text: earned ? 'Получено' : '0 из 1' };
}

// Ближайший значок — тот, до которого осталось меньше всего
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

// Все данные экрана: учебные дни и своя коллекция
async function achLoadAll() {
  await Promise.all([achLoadStudyDays(), achLoadMine()]);
  achState.loaded = true;
  await achCheckEarned();
}

// ============================================================================
// Экраны: плитка на главной, раздел «Достижения», полоска значков в профиле,
// всплывашка о новом значке.
// ============================================================================

const achFormatDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '' : dlFormatDate(d);
};

// Склонение: 1 значок, 2 значка, 5 значков
function achBadgeWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'значков';
  if (b === 1) return 'значок';
  if (b >= 2 && b <= 4) return 'значка';
  return 'значков';
}

// ===== Плитка на главной =====
function renderHomeAchievements() {
  const tile = document.getElementById('homeAchievementsTile');
  if (!tile) return;
  const signed = AppState.auth === 'signed';
  tile.classList.toggle('d-none', !signed);
  if (!signed || !achState.loaded) return;

  const stats = achStats();
  const latest = achLatest();
  const next = achNextUp(stats);

  // Пока значков нет — кубок «Чистого семестра» серым, как цель
  const badgeBox = document.getElementById('homeAchBadge');
  badgeBox.innerHTML = achBadgeHtml(latest ? latest.code : 'clean_term', !latest);
  if (badgeBox.firstElementChild) badgeBox.firstElementChild.style.setProperty('--ach-size', '34px');
  document.getElementById('homeAchCount').textContent = stats.badgesCount;
  document.getElementById('homeAchTotal').textContent = achBadgeWord(stats.badgesCount) + ' из ' + ACH_TOTAL;

  const bar = tile.querySelector('.ach-bar i');
  const note = document.getElementById('homeAchNext');
  if (next) {
    bar.style.setProperty('--ach-fill', String(Math.max(0, Math.min(1, next.p.have / next.p.need))));
    note.textContent = `${next.a.title}: ${next.p.text}`;
  } else {
    bar.style.setProperty('--ach-fill', '1');
    note.textContent = latest ? `Последний значок: ${ACH_BY_CODE[latest.code].title}` : 'Собирайте значки за учёбу';
  }
}

// ===== Раздел «Достижения» =====
let achTab = 'mine';

function setAchTab(tab) {
  achTab = tab === 'rules' ? 'rules' : 'mine';
  haptic('selection');
  [['mine', 'achTabMine', 'achPaneMine'], ['rules', 'achTabRules', 'achPaneRules']]
    .forEach(([id, tabId, paneId]) => {
      const on = id === achTab;
      const btn = document.getElementById(tabId);
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      document.getElementById(paneId).classList.toggle('d-none', !on);
    });
}

async function renderAchievementsView() {
  if (!achState.loaded) await achLoadAll();
  else achLoadMine();              // обновляем в фоне, экран рисуем сразу
  renderAchSummary();
  renderAchMine();
  renderAchRules();
  setAchTab(achTab);
}

function renderAchSummary() {
  const box = document.getElementById('achSummary');
  if (!box) return;
  if (AppState.auth !== 'signed') {
    box.innerHTML = '<div class="ach-sum-note">Войдите в кабинет, чтобы собирать значки</div>';
    return;
  }
  const stats = achStats();
  box.innerHTML =
    '<div><div class="ach-sum-num">' + stats.badgesCount + '</div>' +
    '<div class="ach-sum-note">' + achBadgeWord(stats.badgesCount) + ' из ' + ACH_TOTAL + '</div></div>' +
    '<div class="ms-auto text-end"><div class="ach-sum-num">' + stats.streak + '</div>' +
    '<div class="ach-sum-note">дней серии</div></div>';
}

// Карточка достижения со шкалой выполнения
function achCardHtml(a, stats) {
  const p = achProgressOf(a.code, stats) || { have: 0, need: 1, text: '' };
  const row = achState.earned.get(a.code);
  const fill = p.need ? Math.max(0, Math.min(1, p.have / p.need)) : 0;
  const cls = ['ach-card'];
  if (p.earned) cls.push('is-earned');
  if (a.anti) cls.push('is-anti');
  if (p.blocked) cls.push('is-blocked');

  let extra = '';
  if (p.checklist) {
    extra = '<ul class="ach-check">' + p.checklist.map((c) =>
      '<li class="' + (c.done ? 'done' : '') + '">' + (c.done ? '✓' : '○') + ' ' + escapeHtml(c.text) + '</li>').join('') + '</ul>';
  }

  return '<div class="' + cls.join(' ') + '">' +
    achBadgeHtml(a.code, !p.earned) +
    '<div class="ach-card-body">' +
      '<div class="ach-card-title"><b>' + escapeHtml(a.title) + '</b></div>' +
      '<div class="ach-about">' + escapeHtml(a.about) + '</div>' +
      extra +
      '<div class="ach-bar"><i style="--ach-fill:' + fill + '"></i></div>' +
      '<div class="ach-bar-text">' + escapeHtml(p.text) + '</div>' +
      (row ? '<div class="ach-when">Получено ' + escapeHtml(achFormatDate(row.earned_at)) + '</div>' : '') +
    '</div></div>';
}

// Серия — одна карточка-лесенка из шести ступеней
function achStreakCardHtml(stats) {
  const steps = achLadder('streak');
  const nextStep = steps.find((s) => stats.streak < s.need) || steps[steps.length - 1];
  const fill = Math.max(0, Math.min(1, stats.streak / nextStep.need));
  const code = [...steps].reverse().find((s) => achState.earned.has(s.code));
  return '<div class="ach-card' + (code ? ' is-earned' : '') + '">' +
    achBadgeHtml(code ? code.code : steps[0].code, !code) +
    '<div class="ach-card-body">' +
      '<div class="ach-card-title"><b>Серия без пропусков</b></div>' +
      '<div class="ach-about">Учебные дни подряд без неуважительных пропусков</div>' +
      '<div class="ach-bar"><i style="--ach-fill:' + fill + '"></i></div>' +
      '<div class="ach-bar-text">Серия ' + stats.streak + ' из ' + nextStep.need + ' дней</div>' +
      '<div class="ach-steps">' + steps.map((s) =>
        '<span class="ach-step' + (achState.earned.has(s.code) ? ' done' : '') + '">' +
        s.need + ' · ' + escapeHtml(s.title) + '</span>').join('') + '</div>' +
    '</div></div>';
}

function renderAchMine() {
  const box = document.getElementById('achPaneMine');
  if (!box) return;
  if (AppState.auth !== 'signed') {
    box.innerHTML = '<div class="feed-empty">Значки появятся после входа в кабинет</div>';
    return;
  }
  const stats = achStats();
  box.innerHTML = ACH_CATEGORIES.map((cat) => {
    const list = ACHIEVEMENTS.filter((a) => a.cat === cat.id);
    const cards = cat.id === 'attendance'
      ? [achStreakCardHtml(stats)].concat(list.filter((a) => a.group !== 'streak').map((a) => achCardHtml(a, stats)))
      : list.map((a) => achCardHtml(a, stats));
    const warn = cat.id === 'anti' ? achAntiWarning(stats) : '';
    return '<div class="kicker mt-3">' + cat.title + '</div>' + warn + cards.join('');
  }).join('');
}

// Предупреждение под антидостижениями: сколько часов до следующего
function achAntiWarning(stats) {
  const next = achLadder('anti').find((a) => stats.unexcusedHours < a.need);
  if (!next) return '';
  const left = next.need - stats.unexcusedHours;
  return '<div class="ach-bar-text mb-2">Ещё ' + left + ' ч — и следующее антидостижение</div>';
}

// ===== Как это работает =====
function renderAchRules() {
  const box = document.getElementById('achPaneRules');
  if (!box) return;
  box.innerHTML =
    '<div class="group"><div class="inset p-3">' +
    '<p class="mb-2"><b>Баллов и рейтинга группы здесь нет.</b> Значки — личная коллекция: чужих вы не видите, и никто не видит ваших.</p>' +
    '<p class="mb-2">Коллекция остаётся с вами и в новом семестре. Серия, чистый месяц и чистый семестр считаются заново.</p>' +
    '<p class="mb-2">Уважительные часы серию не прерывают.</p>' +
    '<p class="mb-2">Серия считается только по учебным дням — тем, когда по расписанию были пары, — и до даты «Пропуски актуальны на».</p>' +
    '<p class="mb-2">Домашку можно отметить сделанной только у заданий, которые внёс староста, и только один раз за задание.</p>' +
    '<p class="mb-0">Антидостижения видны только вам.</p>' +
    '</div></div>';
}

// ===== Полоска значков в профиле =====
function renderProfileBadges() {
  const box = document.getElementById('profileBadges');
  if (!box) return;
  const codes = [...achState.earned.entries()]
    .filter(([code]) => !(ACH_BY_CODE[code] || {}).anti)
    .sort((a, b) => String(b[1].earned_at).localeCompare(String(a[1].earned_at)))
    .map(([code]) => code);
  box.closest('.group')?.classList.toggle('d-none', codes.length === 0);
  if (!codes.length) { box.innerHTML = ''; return; }
  box.innerHTML = codes.slice(0, 8).map((c) => achBadgeHtml(c, false)).join('') +
    (codes.length > 8 ? '<span class="ach-strip-more">+' + (codes.length - 8) + '</span>' : '');
}

// ===== Всплывашка о новом значке =====
// Показывается один раз на значок: что уже показали, помним на устройстве.
const ACH_SHOWN_KEY = 'ach_shown';

function achShownSet() {
  try { return new Set(JSON.parse(lsGet(ACH_SHOWN_KEY) || '[]')); } catch (e) { return new Set(); }
}
function achMarkShown(codes) {
  const set = achShownSet();
  codes.forEach((c) => set.add(c));
  try { lsSet(ACH_SHOWN_KEY, JSON.stringify([...set])); } catch (e) {}
}

function achToast(code) {
  const a = ACH_BY_CODE[code];
  if (!a || !document.body) return;
  const el = document.createElement('div');
  el.className = 'ach-toast';
  el.setAttribute('role', 'status');
  el.innerHTML = achBadgeHtml(code, false) +
    '<div><div class="ach-toast-kicker">Новое достижение</div>' +
    '<div class="ach-toast-title">' + escapeHtml(a.title) + '</div></div>';
  el.addEventListener('click', () => { el.remove(); goView('achievements'); });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4200);
}

// Новые значки с прошлого раза: показываем всплывашку по очереди
function achShowNewBadges() {
  const shown = achShownSet();
  const fresh = [...achState.earned.keys()].filter((c) => !shown.has(c));
  if (!fresh.length) return;
  achMarkShown(fresh);
  // При первом запуске после обновления значков может быть сразу много:
  // показываем только три, остальные студент увидит в разделе
  fresh.slice(0, 3).forEach((code, i) => setTimeout(() => achToast(code), i * 900));
}

// ===== Запуск =====
// Данные грузим после входа и после загрузки журнала; экраны перерисовываются сами.
let achInitDone = false;
async function achInit() {
  if (AppState.auth !== 'signed' || AppState.data !== 'ready') return;
  if (achInitDone) return;
  achInitDone = true;
  await achMigrateLocalHomework();
  await achLoadAll();
  achLogEvent('first_login');
  renderHomeAchievements();
  renderProfileBadges();
  achShowNewBadges();
  if (currentViewName === 'achievements') renderAchievementsView();
}

AppState.onChange(() => {
  if (AppState.auth === 'signed' && AppState.data === 'ready') achInit();
  else { achInitDone = false; renderHomeAchievements(); }
});
if (AppState.auth === 'signed' && AppState.data === 'ready') achInit();
