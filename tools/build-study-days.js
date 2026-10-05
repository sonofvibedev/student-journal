// Генератор study-days.json — списка учебных дней семестра.
//
// Зачем он нужен. Серия «столько-то учебных дней подряд без пропусков» считается
// только по дням, когда по расписанию реально были пары. Расписание лежит
// в schedule.js — это браузерный скрипт, и Edge Function его не прочитает.
// Дублировать таблицу занятий в двух местах нельзя: при правке расписания
// про вторую копию забудут. Поэтому один источник правды — schedule.js,
// а этот скрипт разворачивает его в простой список дат, который одинаково
// читают и клиент, и сервер.
//
// Запуск (после любой правки расписания):
//   node tools/build-study-days.js
//
// Скрипты деплоя запускают его сами, так что обычно руками не нужен.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const schedulePath = path.join(root, 'schedule.js');
const outPath = path.join(root, 'study-days.json');

// schedule.js — обычный скрипт без DOM: выполняем его в песочнице.
// Объявленное через const в область видимости песочницы не попадает,
// поэтому нужное отдаём явной строкой в конце — она видит те же переменные.
const source = fs.readFileSync(schedulePath, 'utf8').replace(/^﻿/, '');
const handover = '\n;globalThis.__schedule = { SEMESTER_START, SEMESTER_WEEKS, SCHEDULE_GROUP, lessonsOfDay, dateOfLesson };\n';
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source + handover, sandbox, { filename: 'schedule.js' });

const { SEMESTER_START, SEMESTER_WEEKS, SCHEDULE_GROUP, lessonsOfDay, dateOfLesson } = sandbox.__schedule || {};
if (typeof lessonsOfDay !== 'function' || typeof dateOfLesson !== 'function') {
  console.error('schedule.js не отдал lessonsOfDay/dateOfLesson — расписание изменилось?');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Учебный день — тот, где у группы есть хотя бы одно занятие. Суббота считается
// так же, как будни: важно не «рабочий день», а «были ли пары».
const days = [];
for (let week = 1; week <= SEMESTER_WEEKS; week++) {
  for (let day = 1; day <= 6; day++) {
    if (lessonsOfDay(week, day).length === 0) continue;
    days.push(dayKey(dateOfLesson(week, day)));
  }
}
days.sort();

// Ключ семестра: осенний — с сентября, весенний — с февраля
const [startYear, startMonth] = SEMESTER_START.split('-').map(Number);
const semester = (startMonth >= 8 ? 'fall-' : 'spring-') + startYear;

const out = {
  semester,
  group: SCHEDULE_GROUP,
  semesterStart: SEMESTER_START,
  semesterEnd: days[days.length - 1] || SEMESTER_START,
  weeks: SEMESTER_WEEKS,
  generatedFrom: 'schedule.js',
  days
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`study-days.json: ${days.length} учебных дней, ${semester}, ${out.semesterStart} — ${out.semesterEnd}`);
