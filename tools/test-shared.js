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
  vm.runInContext(source + '\n;globalThis.__shared = { dataFreshness };\n', sandbox, { filename: 'shared.js' });
  return sandbox.__shared;
}

const { dataFreshness } = loadShared();

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

console.log(`\nПроверок пройдено: ${passed}`);
