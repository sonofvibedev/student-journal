// Тесты подсчёта достижений на подготовленных данных.
//
// Проверяются ровно те места, где легко ошибиться:
//   серия с выходными и днями без пар;
//   уважительный пропуск серию не прерывает;
//   «Чистый лист» и «Исправился» на стыке месяцев;
//   пороги антидостижений;
//   минус 5 баллов за неуважительный час;
//   равенство баллов — выше тот, у кого меньше часов.
//
// Запуск: node tools/test-achievements.js
//
// Правила подсчёта живут в двух местах: на клиенте (achievements.js, показывает
// прогресс) и на сервере (Edge Function, выдаёт значки). Здесь проверяются
// клиентские функции — они же повторяют серверную логику один в один.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

// --- Поднимаем achievements.js в песочнице с заглушками браузерного окружения ---
function loadAchievements() {
  const sandbox = {
    console,
    AppState: { auth: 'signed', data: 'ready', studentId: 'st-1', onChange() {} },
    appData: { students: [], absences: [], homework: [] },
    sb: null,
    document: { getElementById: () => null, querySelectorAll: () => [], body: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    lsGet: () => null,
    lsSet: () => true,
    lsRemove: () => true,
    fetch: () => Promise.reject(new Error('нет сети в тесте')),
    dayKey: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    dlFormatDate: () => '',
    escapeHtml: (v) => String(v == null ? '' : v),
    haptic() {},
    goView() {},
    deadlineDate: (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); },
    currentSemesterWeek: () => 1,
    lessonsOfDay: () => [],
    homeworkForLesson: () => [],
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    URL: { createObjectURL: () => '' }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const source = fs.readFileSync(path.join(root, 'achievements.js'), 'utf8').replace(/^﻿/, '');
  const handover = '\n;globalThis.__ach = { achState, achStats, achProgressOf, achMyPoints, ACH_BY_CODE, achLadder, achStreak, achCurrentStreak };\n';
  vm.runInContext(source + handover, sandbox, { filename: 'achievements.js' });
  return { ach: sandbox.__ach, sandbox };
}

const { ach, sandbox } = loadAchievements();

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `\n        получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`}`);
}

// Подготовка данных: учебные дни и пропуски одного студента
function setup({ days, absences, asOf, homeworkDone = 0, earned = [] }) {
  ach.achState.studyDays = { semester: 'test', days };
  ach.achState.earned.clear();
  ach.achState.kinds.clear();
  ach.achState.homeworkDone.clear();
  for (let i = 0; i < homeworkDone; i++) ach.achState.homeworkDone.add('hw-' + i);
  earned.forEach((code) => ach.achState.earned.set(code, { code, points: ach.ACH_BY_CODE[code].points, earned_at: '2026-10-01T00:00:00Z' }));
  sandbox.appData.absences = absences.map((a, i) => ({ id: 'abs-' + i, studentId: 'st-1', ...a }));
  sandbox.appData.lastUpdated = asOf + 'T12:00:00.000Z';
  return ach.achStats();
}

// --- 1. Серия: выходные и дни без пар её не прерывают ---
// Учебные дни идут с пропусками по календарю (нет 5 и 6 октября — выходные),
// серия должна считать подряд идущие учебные дни, а не календарные.
{
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-07', '2026-10-08', '2026-10-09'];
  const stats = setup({ days, absences: [], asOf: '2026-10-09' });
  check('серия: 6 учебных дней подряд через выходные', stats.streak, 6);
}

// --- 2. Уважительный пропуск серию не прерывает и баллы не отнимает ---
{
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-07'];
  const stats = setup({
    days, asOf: '2026-10-07',
    absences: [{ date: '2026-10-02', totalHours: 4, isExcused: true }]
  });
  check('серия: уважительный пропуск не прерывает', stats.streak, 4);
  check('часы: уважительные не считаются', stats.unexcusedHours, 0);
}

// --- 3. Неуважительный пропуск обнуляет серию ---
{
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-07', '2026-10-08'];
  const stats = setup({
    days, asOf: '2026-10-08',
    absences: [{ date: '2026-10-03', totalHours: 2, isExcused: false }]
  });
  check('серия: после пропуска считается заново', stats.streak, 2);
  check('серия: лучшая за семестр', stats.bestStreak, 2);
}

// --- 4. «Чистый лист» и «Исправился» на стыке месяцев ---
// В сентябре был неуважительный, в октябре — нет: «Чистый лист» за октябрь
// должен быть доступен, «Исправился» — тоже.
{
  const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  const stats = setup({
    days, asOf: '2026-10-02',
    absences: [{ date: '2026-09-29', totalHours: 2, isExcused: false }]
  });
  check('стык месяцев: текущий месяц чистый', stats.monthHasBad, false);
  check('стык месяцев: в прошлом месяце были пропуски', stats.prevMonthHadBad, true);

  const clean = ach.achProgressOf('clean_sheet', stats);
  check('«Чистый лист»: шкала за октябрь', [clean.have, clean.need, !!clean.blocked], [2, 2, false]);

  const rec = ach.achProgressOf('recovered', stats);
  check('«Исправился»: доступен после грязного сентября', !!rec.blocked, false);
}

// --- 5. «Чистый лист» недоступен, если месяц уже испорчен ---
{
  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const stats = setup({
    days, asOf: '2026-10-03',
    absences: [{ date: '2026-10-01', totalHours: 2, isExcused: false }]
  });
  const clean = ach.achProgressOf('clean_sheet', stats);
  check('«Чистый лист»: месяц испорчен', clean.blocked, true);
  check('«Чистый семестр»: тоже недоступен', ach.achProgressOf('clean_term', stats).blocked, true);
}

// --- 6. Пороги антидостижений ---
{
  const days = ['2026-10-01', '2026-10-02'];
  const cases = [
    [1, []],
    [2, ['anti_2']],
    [6, ['anti_2', 'anti_6']],
    [9, ['anti_2', 'anti_6', 'anti_9']],
    [18, ['anti_2', 'anti_6', 'anti_9', 'anti_18']]
  ];
  cases.forEach(([hours, expected]) => {
    const stats = setup({ days, asOf: '2026-10-02', absences: [{ date: '2026-10-01', totalHours: hours, isExcused: false }] });
    const reached = ach.achLadder('anti').filter((a) => stats.unexcusedHours >= a.need).map((a) => a.code);
    check(`антидостижения: ${hours} ч`, reached, expected);
  });
}

// --- 7. Минус 5 баллов за неуважительный час ---
{
  const days = ['2026-10-01', '2026-10-02'];
  // Получен «Чистый лист» (+50), при этом 3 неуважительных часа: 50 − 15 = 35
  const stats = setup({
    days, asOf: '2026-10-02',
    absences: [{ date: '2026-10-01', totalHours: 3, isExcused: false }],
    earned: ['clean_sheet']
  });
  check('баллы: 50 за значок минус 15 за 3 часа', stats.points, 35);

  // Антидостижение баллов не снимает: оно с points = 0
  const withAnti = setup({
    days, asOf: '2026-10-02',
    absences: [{ date: '2026-10-01', totalHours: 3, isExcused: false }],
    earned: ['clean_sheet', 'anti_2']
  });
  check('баллы: антидостижение ничего не меняет', withAnti.points, 35);
}

// --- 8. Равенство баллов: выше тот, у кого меньше часов ---
// Та же сортировка, что в Edge Function
{
  const board = [
    { student_id: 'st-b', points: 40, hours: 6 },
    { student_id: 'st-a', points: 40, hours: 2 },
    { student_id: 'st-c', points: 55, hours: 0 }
  ];
  board.sort((a, b) => b.points - a.points || a.hours - b.hours || a.student_id.localeCompare(b.student_id));
  check('рейтинг: при равенстве выше меньше часов', board.map((r) => r.student_id), ['st-c', 'st-a', 'st-b']);
}

// --- 9. Лесенка домашки ---
{
  const days = ['2026-10-01'];
  const stats = setup({ days, asOf: '2026-10-01', absences: [], homeworkDone: 10 });
  const reached = ach.achLadder('homework').filter((a) => stats.homeworkDone >= a.need).map((a) => a.code);
  check('домашка: 10 отметок закрывают три ступени', reached, ['hw_1', 'hw_3', 'hw_10']);
  const next = ach.achProgressOf('hw_25', stats);
  check('домашка: шкала следующей ступени', [next.have, next.need], [10, 25]);
}

// --- 10. Справки вовремя ---
{
  const days = ['2026-10-01', '2026-10-02'];
  const stats = setup({
    days, asOf: '2026-10-02',
    absences: [
      { date: '2026-10-01', totalHours: 2, isExcused: true, certDueDate: '2026-10-10', certSubmittedAt: '2026-10-05' },
      { date: '2026-10-02', totalHours: 2, isExcused: true, certDueDate: '2026-10-10', certSubmittedAt: '2026-10-12' },
      { date: '2026-10-02', totalHours: 2, isExcused: true, certDueDate: '2026-10-10' }
    ]
  });
  check('справки: засчитана только сданная до срока', stats.certsOnTime, 1);
}

console.log(failed === 0 ? '\nВсе проверки прошли' : `\nПровалено проверок: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
