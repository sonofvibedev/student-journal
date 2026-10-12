// Тесты общих функций из shared.js, которые не трогают DOM.
//
// Запуск: node tools/test-shared.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

// shared.js рассчитан на браузер: поднимаем его с заглушками
function loadShared() {
  const sandbox = {
    console, setTimeout, clearTimeout,
    AppState: { auth: 'guest', data: 'ready', studentId: null, onChange() {} },
    appData: { deadlines: [], students: [], absences: [], homework: [] },
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, body: null },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    lsGet: () => null, lsSet: () => true, lsRemove: () => true,
    location: { hash: '', pathname: '/index.html' },
    fetch: () => Promise.reject(new Error('нет сети в тесте')),
    escapeHtml: (v) => String(v == null ? '' : v),
    haptic() {}, goView() {},
    requestAnimationFrame: (fn) => fn(),
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'shared.js'), 'utf8').replace(/^﻿/, '');
  vm.runInContext(source + '\n;globalThis.__shared = { dataFreshness, ratingStoreRead, ratingStoreFor, ratingStoreWrite, ratingLegacyRead, ratingSubjectsDone };\n', sandbox, { filename: 'shared.js' });
  return sandbox.__shared;
}

const { dataFreshness, ratingStoreRead, ratingStoreFor, ratingStoreWrite,
        ratingLegacyRead, ratingSubjectsDone } = loadShared();

// Значения приходят из песочницы vm: у их объектов и массивов свой прототип,
// поэтому deepEqual считает их неравными при одинаковом содержимом. Приводим
// к обычным объектам этого контекста.
const plain = (v) => JSON.parse(JSON.stringify(v));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const now = new Date('2026-10-12T15:00:00');

console.log('Свежесть данных');

test('дата показывается как ДД.ММ.ГГГГ, ЧЧ:ММ', () => {
  const f = dataFreshness('2026-10-12T09:05:00', now);
  assert.equal(f.text, 'Данные актуальны на 12.10.2026, 09:05');
  assert.equal(f.stale, false);
});

test('данные старше трёх дней помечаются', () => {
  const f = dataFreshness('2026-10-08T09:00:00', now);   // 4 дня назад
  assert.equal(f.stale, true, 'пометки нет, хотя данным 4 дня');
  assert.ok(f.note.includes('давно не обновлялись'), 'нет текста пометки: ' + f.note);
});

test('ровно три дня — ещё не «давно»', () => {
  const f = dataFreshness('2026-10-09T15:00:00', now);
  assert.equal(f.stale, false);
});

test('чуть больше трёх дней — уже «давно»', () => {
  const f = dataFreshness('2026-10-09T14:59:00', now);
  assert.equal(f.stale, true);
});

test('без даты и с мусором ничего не показываем', () => {
  assert.equal(dataFreshness(null, now).text, '');
  assert.equal(dataFreshness('не дата', now).text, '');
  assert.equal(dataFreshness(undefined, now).stale, false);
});

console.log('Калькулятор по предметам');

const EMPTY = { control: [], oral: [], exam: '', k1: 0.5, w1: 0.6 };

test('у каждого предмета свой расчёт', () => {
  let store = ratingStoreRead(null);
  store = ratingStoreWrite(store, 'Математика', { ...EMPTY, control: [9, 8], exam: '7' });
  store = ratingStoreWrite(store, 'Физика', { ...EMPTY, oral: [5], exam: '10' });

  assert.deepEqual(plain(ratingStoreFor(store, 'Математика').control), [9, 8]);
  assert.deepEqual(plain(ratingStoreFor(store, 'Математика').oral), []);
  assert.equal(ratingStoreFor(store, 'Математика').exam, '7');
  assert.deepEqual(plain(ratingStoreFor(store, 'Физика').oral), [5]);
  assert.equal(ratingStoreFor(store, 'Физика').exam, '10');
});

test('расчёт восстанавливается из строки хранилища', () => {
  let store = ratingStoreWrite(ratingStoreRead(null), 'Химия', { ...EMPTY, control: [6], k1: 0.7, w1: 0.4 });
  const again = ratingStoreRead(JSON.stringify(store));
  const calc = ratingStoreFor(again, 'Химия');
  assert.deepEqual(plain(calc.control), [6]);
  assert.equal(calc.k1, 0.7);
  assert.equal(calc.w1, 0.4);
});

test('незнакомый предмет даёт пустой расчёт, а не чужой', () => {
  const store = ratingStoreWrite(ratingStoreRead(null), 'Химия', { ...EMPTY, control: [6] });
  assert.deepEqual(plain(ratingStoreFor(store, 'Биология').control), []);
  assert.deepEqual(plain(ratingStoreFor(store, 'Биология').oral), []);
});

test('мусор в хранилище не роняет калькулятор', () => {
  assert.deepEqual(plain(ratingStoreFor(ratingStoreRead('не json'), 'Химия')), EMPTY);
  assert.deepEqual(plain(ratingStoreFor(ratingStoreRead('{"Химия": 5}'), 'Химия')), EMPTY);
  assert.deepEqual(plain(ratingStoreFor(ratingStoreRead('[]'), 'Химия')), EMPTY);
});

test('старый общий расчёт читается целиком', () => {
  const legacy = ratingLegacyRead('{"control":[9,8],"oral":[7]}', '8', '0.7', '0.4');
  assert.deepEqual(plain(legacy.control), [9, 8]);
  assert.deepEqual(plain(legacy.oral), [7]);
  assert.equal(legacy.exam, '8', 'потеряна оценка за экзамен');
  assert.equal(legacy.k1, 0.7, 'потерян коэффициент семинаров');
  assert.equal(legacy.w1, 0.4, 'потерян коэффициент экзамена');
});

test('переносить нечего, когда старых оценок нет', () => {
  assert.equal(ratingLegacyRead(null, '', '', ''), null);
  assert.equal(ratingLegacyRead('{"control":[],"oral":[]}', '', '', ''), null);
  assert.equal(ratingLegacyRead('мусор', '', '', ''), null);
});

test('перенос старого расчёта ничего не теряет', () => {
  const legacy = ratingLegacyRead('{"control":[9,8],"oral":[7]}', '8', '0.7', '0.4');
  const store = ratingStoreWrite(ratingStoreRead(null), 'Математика', legacy);
  assert.deepEqual(plain(ratingStoreFor(store, 'Математика')), plain(legacy));
});

test('список предметов с расчётом — только те, где есть оценки', () => {
  let store = ratingStoreRead(null);
  store = ratingStoreWrite(store, 'Математика', { ...EMPTY, control: [9] });
  store = ratingStoreWrite(store, 'Физика', { ...EMPTY });
  store = ratingStoreWrite(store, 'Химия', { ...EMPTY, oral: [5] });
  assert.equal([...ratingSubjectsDone(store)].sort().join(','), 'Математика,Химия');
});

console.log(`\nПроверок пройдено: ${passed}`);
