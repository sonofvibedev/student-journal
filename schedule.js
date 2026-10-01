// Расписание группы 24ДММ-2 на семестр и разбор недель.
//
// Источника в сети нет: расписание хранится здесь, в репозитории. Меняется оно
// раз в семестр, поэтому таблица правится руками — строки ниже.
//
// Строка занятия:
//   [день, пара, недели, предмет, вид, преподаватель, аудитория, подгруппа?]
//     день    1 = понедельник … 6 = суббота
//     пара    номер пары по звонкам (см. PAIR_TIMES), а не буква
//     недели  как в таблице деканата: '5', '2-14', '4,7-15', '3,5,7,9'
//     предмет, вид, преподаватель — ключи из SUBJECTS / LESSON_KINDS / TEACHERS
//     подгруппа 1 или 2; без неё — занятие у всей группы
//
// Домашние задания в расписании не лежат: они общие для группы и хранятся
// в data.json (массив homework), чтобы их видели все и мог прочитать сервер
// напоминаний. Связь — по предмету, виду занятия и дате сдачи.

'use strict';

const SCHEDULE_GROUP = '24ДММ-2';
const SEMESTER_START = '2026-09-01';   // понедельник первой учебной недели
const SEMESTER_WEEKS = 16;

// Звонки БГЭУ: номер пары → [начало, конец]
const PAIR_TIMES = {
  1: ['08:15', '09:35'],
  2: ['09:45', '11:05'],
  3: ['11:15', '12:35'],
  4: ['13:05', '14:25'],
  5: ['14:35', '15:55'],
  6: ['16:05', '17:25'],
  7: ['17:45', '19:05'],
  8: ['19:15', '20:35']
};

const LESSON_KINDS = { K: 'ЛК', P: 'ПЗ', L: 'ЛР', Z: 'ЗЧ', N: 'ЗН' };
const LESSON_KIND_FULL = { 'ЛК': 'Лекция', 'ПЗ': 'Практическое', 'ЛР': 'Лабораторная', 'ЗЧ': 'Зачёт', 'ЗН': 'Занятие' };

// Названия совпадают со списком subjects в data.json — по ним связываются домашка и пропуски
const SCHEDULE_SUBJECTS = {
  sm: 'Стратегический маркетинг',
  mu: 'Маркетинг услуг',
  kh: 'Кураторский час',
  ek: 'Эконометрика',
  imk: 'Интегрированные маркетинговые коммуникации',
  mi: 'Маркетинг инноваций',
  fsa: 'Функционально-стоимостный анализ',
  mia: 'Маркетинговые исследования и аналитика',
  lg: 'Логистика',
  fk: 'Физическая культура'
};

const SCHEDULE_TEACHERS = {
  sv: 'Сверлов А.С.', sh: 'Шумских И.С.', mk: 'Миксюк С.Ф.', st: 'Стасева А.А.',
  pu: 'Пушкин С.А.', le: 'Левчук К.А.', an: 'Анкинович Ю.Е.', tr: 'Трушкевич Н.Л.',
  sy: 'Синявская О.А.', pr: 'Протасеня В.С.', bu: 'Бутеня В.Е.', ko: 'Ковалева О.Л.',
  ar: 'Артёменко С.В.', vo: 'Волонтей А.В.', de: 'Демченко Е.В.', ve: 'Верниковская О.В.',
  ya: 'Яровская Е.С.', kp: 'Коптур Д.В.', re: 'Рехтин В.А.', kz: 'Козловская О.И.'
};

const SCHEDULE_ROWS = [
  // понедельник
  [1, 3, '5', 'sm', 'K', 'sv', '1/903'],
  [1, 3, '6', 'mia', 'L', 're', '3/138', 2],
  [1, 3, '7', 'mia', 'P', 're', '3/329'],
  [1, 3, '11', 'kh', 'N', 'kz', ''],
  [1, 4, '2-14', 'ek', 'K', 'mk', '1/703'],
  [1, 5, '2', 'ek', 'K', 'mk', '1/703'],
  [1, 5, '4-11', 'imk', 'P', 'le', '1/706'],
  [1, 5, '12-14,16', 'imk', 'L', 'le', '2/301', 2],
  [1, 5, '12-14', 'mi', 'L', 'an', '3/138', 1],
  [1, 5, '15', 'imk', 'L', 'le', '', 2],
  [1, 6, '3,7', 'ek', 'P', 'st', '1/704'],
  [1, 6, '8-16', 'ek', 'L', 'pu', '2/200а', 1],
  [1, 6, '8-16', 'ek', 'L', 'st', '2/200', 2],
  [1, 7, '8', 'mia', 'P', 're', '2/424'],
  // вторник
  [2, 3, '16', 'mu', 'P', 'sh', '3/450'],
  [2, 4, '6', 'ek', 'P', 'st', '2/222'],
  [2, 4, '14', 'imk', 'L', 'le', '2/302', 1],
  [2, 4, '14', 'mi', 'L', 'an', '3/138', 2],
  [2, 4, '16', 'fsa', 'P', 'tr', '2/220'],
  [2, 5, '1-2', 'fsa', 'K', 'sy', '1/1203'],
  [2, 5, '3', 'kh', 'N', 'kz', '4/701'],
  [2, 5, '6-8,11,13-14', 'mia', 'L', 're', '3/138', 1],
  [2, 5, '6-8,11,13-15', 'sm', 'L', 'vo', '2/200а', 2],
  [2, 6, '1-14', 'fsa', 'K', 'sy', '1/1203'],
  [2, 7, '1-2', 'mi', 'K', 'pr', '1/1003'],
  [2, 7, '8', 'ek', 'P', 'st', '1/704'],
  // среда
  [3, 3, '3,5,7,9', 'mi', 'K', 'pr', '1/403'],
  [3, 3, '4,6,8,10,12-13', 'imk', 'K', 'bu', '1/403'],
  [3, 3, '14', 'mi', 'L', 'an', '2/200а', 1],
  [3, 4, '1,3-15', 'mia', 'K', 'ko', '1/903'],
  [3, 4, '2', 'mi', 'K', 'pr', '3/136'],
  [3, 5, '1-2', 'ek', 'K', 'mk', '1/1203'],
  [3, 5, '3-16', 'fsa', 'P', 'tr', '1/1005'],
  [3, 6, '1', 'mi', 'K', 'pr', '1/1203'],
  [3, 6, '2', 'imk', 'K', 'bu', '1/1203'],
  [3, 6, '3-9', 'mi', 'P', 'an', '1/1005'],
  [3, 6, '10', 'mu', 'P', 'sh', '1/801'],
  [3, 6, '15', 'imk', 'L', 'le', '2/218', 1],
  [3, 6, '16', 'mi', 'Z', 'pr', '3/140'],
  [3, 7, '2', 'mia', 'K', 'ko', '1/1203'],
  [3, 7, '3', 'fsa', 'K', 'sy', '1/903'],
  [3, 7, '16', 'mi', 'Z', 'pr', '3/140'],
  // четверг
  [4, 3, '4', 'ek', 'K', 'mk', '1/603'],
  [4, 3, '7', 'kh', 'N', 'kz', ''],
  [4, 3, '8-9,12-13', 'mia', 'L', 're', '3/226', 2],
  [4, 3, '8-9', 'sm', 'L', 'vo', '2/218', 1],
  [4, 3, '10', 'mia', 'L', 're', '2/218', 2],
  [4, 3, '10,15', 'sm', 'L', 'vo', '2/200', 1],
  [4, 3, '11', 'mia', 'L', 're', '2/200а', 2],
  [4, 3, '11', 'sm', 'L', 'vo', '2/306', 1],
  [4, 3, '12', 'sm', 'L', 'vo', '2/200а', 1],
  [4, 4, '1-13', 'mu', 'K', 'de', '1/903'],
  [4, 4, '14', 'mia', 'L', 're', '3/224а', 2],
  [4, 4, '14', 'sm', 'L', 'vo', '2/200а', 1],
  [4, 4, '15', 'mu', 'P', 'sh', '1/801'],
  [4, 5, '1-2', 'imk', 'K', 'bu', '1/1203'],
  [4, 5, '3,6-14', 'mu', 'P', 'sh', '1/801'],
  [4, 5, '4-5', 'ek', 'P', 'st', '1/901'],
  [4, 6, '1-2', 'imk', 'K', 'bu', '1/1203'],
  [4, 6, '3', 'ek', 'P', 'st', '1/901'],
  [4, 6, '4-5', 'mu', 'P', 'sh', '1/801'],
  [4, 6, '6-7', 'sm', 'L', 'vo', '2/218', 1],
  [4, 6, '7', 'mia', 'L', 're', '3/226', 2],
  [4, 7, '3', 'sm', 'K', 'sv', '1/403'],
  // пятница
  [5, 3, '1-16', 'fk', 'P', 'kp', ''],
  [5, 4, '1', 'lg', 'K', 've', '1/403'],
  [5, 4, '2', 'sm', 'K', 'sv', '1/403'],
  [5, 4, '3-14', 'lg', 'P', 'ya', '1/801'],
  [5, 4, '15', 'lg', 'Z', 've', '1/1005'],
  [5, 4, '16', 'fsa', 'Z', 'sy', '1/1005'],
  [5, 5, '1-2', 'lg', 'K', 've', '1/403'],
  [5, 5, '3-12', 'sm', 'P', 'vo', '1/1005'],
  [5, 5, '13', 'sm', 'L', 'vo', '2/202', 1],
  [5, 5, '14', 'kh', 'N', 'kz', ''],
  [5, 5, '15', 'lg', 'Z', 've', '1/1005'],
  [5, 5, '16', 'fsa', 'Z', 'sy', '1/1005'],
  [5, 6, '3-11', 'lg', 'K', 've', '1/703'],
  [5, 6, '14', 'fsa', 'K', 'sy', '1/403'],
  [5, 7, '10', 'sm', 'K', 'sv', '1/703'],
  // суббота
  [6, 4, '1', 'sm', 'K', 'sv', '1/403'],
  [6, 4, '3-4', 'mia', 'P', 'ar', '2/320'],
  [6, 4, '5,8-9', 'mia', 'P', 're', '2/320'],
  [6, 4, '11-13', 'imk', 'L', 'le', '2/200', 1],
  [6, 4, '11-13', 'mi', 'L', 'an', '2/200а', 2],
  [6, 5, '1,3-9,11-13', 'sm', 'K', 'sv', '1/703'],
  [6, 6, '9', 'ek', 'P', 'st', '3/232']
];

const DAY_NAMES = ['', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const DAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// '4,7-15' → [4, 7, 8, …, 15]
function parseWeekList(text) {
  const out = [];
  String(text).split(',').forEach((part) => {
    const [from, to] = part.split('-').map((n) => parseInt(n, 10));
    if (!Number.isFinite(from)) return;
    if (Number.isFinite(to)) { for (let w = from; w <= to; w++) out.push(w); }
    else out.push(from);
  });
  return out;
}

// Разворачиваем строки в занятия один раз при загрузке
const SCHEDULE_LESSONS = SCHEDULE_ROWS.map((row, i) => {
  const [day, pair, weeks, subject, kind, teacher, room, subgroup] = row;
  const times = PAIR_TIMES[pair] || ['', ''];
  return {
    id: 'ls-' + i,
    day,
    pair,
    start: times[0],
    end: times[1],
    weeks: parseWeekList(weeks),
    subject: SCHEDULE_SUBJECTS[subject] || subject,
    subjectKey: subject,
    type: LESSON_KINDS[kind] || kind,
    teacher: SCHEDULE_TEACHERS[teacher] || '',
    room: room || '',
    subgroup: subgroup || 0
  };
});

// --- Недели семестра ---
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // понедельник — первый день недели
  return d;
}
function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}
const semesterMonday = () => {
  const [y, m, d] = SEMESTER_START.split('-').map(Number);
  return mondayOf(new Date(y, m - 1, d));
};
// Номер текущей учебной недели, обрезанный границами семестра
function currentSemesterWeek(now) {
  const diff = mondayOf(now || new Date()) - semesterMonday();
  const week = Math.floor(diff / (7 * 24 * 3600 * 1000)) + 1;
  return Math.min(SEMESTER_WEEKS, Math.max(1, week));
}
// Дата конкретного дня выбранной недели
function dateOfLesson(week, day) {
  return addDays(semesterMonday(), (week - 1) * 7 + (day - 1));
}

// Занятия одного дня: только нужная неделя и подгруппа, по времени начала
function lessonsOfDay(week, day, subgroup) {
  return SCHEDULE_LESSONS
    .filter((l) => l.day === day && l.weeks.includes(week))
    .filter((l) => !l.subgroup || !subgroup || l.subgroup === Number(subgroup))
    .sort((a, b) => a.pair - b.pair || a.subject.localeCompare(b.subject));
}
// В какие дни недели вообще есть занятия (для полоски дней)
function daysWithLessons(week, subgroup) {
  const map = {};
  for (let d = 1; d <= 6; d++) map[d] = lessonsOfDay(week, d, subgroup).length;
  return map;
}

// Все предметы расписания — для выпадающего списка в форме домашки
function scheduleSubjectNames() {
  return [...new Set(SCHEDULE_LESSONS.map((l) => l.subject))].sort((a, b) => a.localeCompare(b));
}

// Ближайшие даты, когда будет такое же занятие (предмет + вид) — подсказка срока сдачи
function nextLessonDates(subject, type, from, count) {
  const out = [];
  const startWeek = currentSemesterWeek(from);
  for (let week = startWeek; week <= SEMESTER_WEEKS && out.length < (count || 3); week++) {
    for (let day = 1; day <= 6 && out.length < (count || 3); day++) {
      const date = dateOfLesson(week, day);
      if (date < from) continue;
      const has = lessonsOfDay(week, day, 0).some((l) => l.subject === subject && (!type || l.type === type));
      if (has) out.push(date);
    }
  }
  return out;
}
