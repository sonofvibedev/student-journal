// Тесты суток по Минску из shared.js: «сегодня», «завтра» и «через N дней»
// считаются по календарной дате в Минске (UTC+3), а не по часам устройства.
// Заодно проверяют единый список «горящего» и «ближайшего» (studyHot и др.).
//
// Запуск: node tools/test-minsk-days.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function loadShared() {
  const sandbox = {
    console, setTimeout, clearTimeout, Intl,
    AppState: { auth: 'guest', data: 'ready', studentId: null, onChange() {} },
    appData: { deadlines: [], homework: [] },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, body: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    lsGet: () => null, lsSet: () => true, lsRemove: () => true,
    location: { hash: '', pathname: '/index.html' },
    fetch: () => Promise.reject(new Error('нет сети в тесте')),
    requestAnimationFrame: (fn) => fn(),
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'shared.js'), 'utf8').replace(/^﻿/, '');
  vm.runInContext(source + '\n;globalThis.__m = { minskTodayISO, minskNow, minskDayDiff, deadlineDaysLeft, deadlineRelative, studyHot, studyUpcoming, studyListed, studyArchive };\n', sandbox, { filename: 'shared.js' });
  return { m: sandbox.__m, sandbox };
}

const { m, sandbox } = loadShared();
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const at = (iso) => new Date(iso);   // момент в UTC

console.log('Границы суток по Минску');

test('23:30 UTC — уже следующий день по Минску', () => {
  assert.equal(m.minskTodayISO(at('2026-10-31T23:30:00Z')), '2026-11-01');
});
test('полночь по Минску: 20:59:59 UTC ещё вчера, 21:00:00 UTC уже сегодня', () => {
  assert.equal(m.minskTodayISO(at('2026-10-31T20:59:59Z')), '2026-10-31');
  assert.equal(m.minskTodayISO(at('2026-10-31T21:00:00Z')), '2026-11-01');
});
test('смена месяца и года', () => {
  assert.equal(m.minskTodayISO(at('2026-02-28T22:00:00Z')), '2026-03-01');
  assert.equal(m.minskTodayISO(at('2026-12-31T21:00:00Z')), '2027-01-01');
});
test('перехода на летнее время нет: летом тоже UTC+3', () => {
  assert.equal(m.minskTodayISO(at('2026-07-15T21:00:00Z')), '2026-07-16');
  assert.equal(m.minskTodayISO(at('2026-01-15T21:00:00Z')), '2026-01-16');
});

console.log('Сколько дней до срока');

test('срок сегодня, завтра, вчера', () => {
  const now = at('2026-10-31T23:30:00Z');             // в Минске уже 1 ноября
  assert.equal(m.minskDayDiff('2026-11-01', now), 0);
  assert.equal(m.minskDayDiff('2026-11-02', now), 1);
  assert.equal(m.minskDayDiff('2026-10-31', now), -1);
});
test('через границу месяца и года', () => {
  assert.equal(m.minskDayDiff('2026-11-03', at('2026-10-30T10:00:00Z')), 4);
  assert.equal(m.minskDayDiff('2027-01-02', at('2026-12-30T10:00:00Z')), 3);
});
test('deadlineDaysLeft считает так же, а подпись — словами', () => {
  const now = at('2026-10-31T21:00:00Z');
  assert.equal(m.deadlineDaysLeft('2026-11-01', now), 0);
  assert.equal(m.deadlineRelative(m.deadlineDaysLeft('2026-11-02', now)), 'завтра');
  assert.equal(m.deadlineRelative(m.deadlineDaysLeft('2026-11-05', now)), 'через 4 дня');
});

test('minskNow: локальные поля равны минскому времени', () => {
  const d = m.minskNow(at('2026-10-31T21:05:09Z'));
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2026, 11, 1, 0, 5, 9]);
});

test('часовой пояс устройства ни на что не влияет', () => {
  const now = at('2026-10-31T22:30:00Z');
  const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Europe/Minsk'];
  const before = process.env.TZ;
  try {
    zones.forEach((tz) => {
      process.env.TZ = tz;
      assert.equal(m.minskTodayISO(now), '2026-11-01', tz);
      assert.equal(m.minskDayDiff('2026-11-02', now), 1, tz);
    });
  } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
});

console.log('Единый список «горящего» и «ближайшего»');

// «Сейчас» в песочнице подменяем: Date без аргументов отдаёт заданный момент
const REAL_DATE = Date;
function withToday(iso, fn) {
  const fixed = new REAL_DATE(iso).getTime();
  sandbox.Date = class extends REAL_DATE {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
  try { fn(); } finally { sandbox.Date = REAL_DATE; }
}
// Дата через n суток от 31 октября 2026
const day = (n) => new REAL_DATE(Date.UTC(2026, 9, 31 + n)).toISOString().slice(0, 10);
function setData(deadlines, homework, done) {
  sandbox.appData = { deadlines, homework };
  sandbox.isDeadlineDone = (d) => !!(done && done.has(d.id));
  sandbox.homeworkDone = (h) => !!(done && done.has(h.id));
  sandbox.homeworkLessons = () => [1];
}
const ids = (list) => Array.from(list, (i) => i.id);   // обычный массив этого контекста: deepEqual не любит чужой прототип

test('горит: сегодня, завтра и просрочено, но не выполнено; зачёт и домашка — по своим правилам', () => {
  withToday('2026-10-31T09:00:00Z', () => {
    setData([
      { id: 'd-over', type: 'deadline', subject: 'А', dueDate: day(-3) },
      { id: 'd-old', type: 'deadline', subject: 'Б', dueDate: day(-10) },
      { id: 'd-today', subject: 'В', dueDate: day(0) },
      { id: 'd-done', subject: 'Г', dueDate: day(1) },
      { id: 'd-late', subject: 'Д', dueDate: day(2) },
      { id: 'z-1', type: 'zachet', subject: 'Е', dueDate: day(1) },
      { id: 'z-past', type: 'exam', subject: 'Ж', dueDate: day(-1) }
    ], [
      { id: 'h-today', subject: 'З', dueDate: day(0), type: 'ПЗ' },
      { id: 'h-over', subject: 'И', dueDate: day(-1), type: 'ПЗ' }
    ], new Set(['d-done']));
    assert.deepEqual(ids(m.studyHot()), ['d-over', 'h-today', 'd-today', 'z-1']);
    assert.deepEqual(ids(m.studyHot(['deadline'])), ['d-over', 'd-today']);
  });
});
test('ближайшее: не выполнено, срок не раньше сегодня, по возрастанию', () => {
  withToday('2026-10-31T09:00:00Z', () => {
    setData([
      { id: 'a', subject: 'А', dueDate: day(5) }, { id: 'b', subject: 'Б', dueDate: day(0) },
      { id: 'c', subject: 'В', dueDate: day(2) }, { id: 'x', subject: 'Г', dueDate: day(-1) }
    ], [], new Set(['c']));
    assert.deepEqual(ids(m.studyUpcoming(['deadline'])), ['b', 'a']);
  });
});
test('просроченная домашка скрыта из списка и лежит в архиве', () => {
  withToday('2026-10-31T09:00:00Z', () => {
    setData([], [
      { id: 'h1', subject: 'А', dueDate: day(-9) }, { id: 'h2', subject: 'Б', dueDate: day(-2) },
      { id: 'h3', subject: 'В', dueDate: day(0) }
    ]);
    assert.deepEqual(ids(m.studyListed(['homework'])), ['h3']);
    assert.deepEqual(ids(m.studyArchive()), ['h2', 'h1']);
  });
});
test('в 23:30 UTC (уже завтра по Минску) «сегодняшнее» становится вчерашним', () => {
  withToday('2026-10-31T23:30:00Z', () => {
    setData([{ id: 'a', subject: 'А', dueDate: '2026-10-31' }, { id: 'b', subject: 'Б', dueDate: '2026-11-01' }], []);
    assert.deepEqual(ids(m.studyHot()), ['a', 'b']);
    assert.deepEqual(ids(m.studyUpcoming()), ['b']);
  });
});

console.log('\nПроверок пройдено: ' + passed);
