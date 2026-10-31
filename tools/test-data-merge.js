// Тесты слияния с data.json на GitHub (mergeRemoteData из shared.js).
// Запуск: node tools/test-data-merge.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
  haptic() {}, goView() {}, requestAnimationFrame: (fn) => fn(),
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} })
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8').replace(/^﻿/, '');
vm.runInContext(src + '\n;globalThis.__m = mergeRemoteData;\n', sandbox, { filename: 'shared.js' });
const merge = sandbox.__m;

// массивы из vm-контекста: сравниваем копиями из основного
const ids = (arr) => Array.from(arr, r => r.id);
const hw = (id, extra) => ({ id, subject: 'Логистика', text: id, dueDate: '2026-11-05', ...extra });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('запись бота, добавленная после загрузки, попадает в сохраняемое', () => {
  const local = { homework: [hw('hw-1')], deadlines: [] };
  const remote = { homework: [hw('hw-1'), hw('hw-bot', { source: 'bot' })], deadlines: [{ id: 'dl-bot', source: 'bot' }] };
  const r = merge(local, remote, ['hw-1'], []);
  assert.deepEqual(ids(r.homework), ['hw-1', 'hw-bot']);
  assert.deepEqual(ids(r.deadlines), ['dl-bot']);
  assert.deepEqual(Array.from(r.addedIds).sort(), ['dl-bot', 'hw-bot']);
});

t('запись бота, удалённая ботом или другим админом, из сохраняемого убирается', () => {
  const local = { homework: [hw('hw-1'), hw('hw-bot', { source: 'bot' })], deadlines: [] };
  const remote = { homework: [hw('hw-1')], deadlines: [] };
  const r = merge(local, remote, ['hw-1', 'hw-bot'], []);
  assert.deepEqual(ids(r.homework), ['hw-1']);
  assert.deepEqual(Array.from(r.removedIds), ['hw-bot']);
});

t('запись админа без source не пропадает, даже если её нет в remote', () => {
  const local = { homework: [hw('hw-1'), hw('hw-new')], deadlines: [] };
  const remote = { homework: [hw('hw-1')], deadlines: [] };
  assert.deepEqual(ids(merge(local, remote, ['hw-1'], []).homework), ['hw-1', 'hw-new']);
  assert.deepEqual(ids(merge({ homework: [hw('hw-1')], deadlines: [] }, { homework: [], deadlines: [] }, ['hw-1'], []).homework), ['hw-1']);
});

t('удалённое админом не воскресает из remote', () => {
  const local = { homework: [], deadlines: [] };
  const remote = { homework: [hw('hw-1'), hw('hw-bot', { source: 'bot' })], deadlines: [] };
  const r = merge(local, remote, ['hw-1', 'hw-bot'], ['hw-1', 'hw-bot']);
  assert.deepEqual(ids(r.homework), []);
  // даже если id не попал в loadedIds, deletedIds держит запись удалённой
  assert.deepEqual(ids(merge(local, remote, [], ['hw-1', 'hw-bot']).homework), []);
});

t('одновременные правки: правка админа и новая запись бота сохраняются обе', () => {
  const local = { homework: [hw('hw-1', { text: 'правка админа' })], deadlines: [] };
  const remote = { homework: [hw('hw-1'), hw('hw-bot', { source: 'bot' })], deadlines: [] };
  const r = merge(local, remote, ['hw-1'], []);
  assert.equal(r.homework[0].text, 'правка админа');
  assert.deepEqual(ids(r.homework), ['hw-1', 'hw-bot']);
});

t('бот поправил текст записи: если админ её не трогал, берём версию бота, иначе админа', () => {
  const orig = hw('hw-1', { source: 'bot' });
  const snap = new Map([['hw-1', JSON.stringify(orig)]]);
  const remote = { homework: [{ ...orig, text: 'поправил бот' }], deadlines: [] };
  assert.equal(merge({ homework: [{ ...orig }], deadlines: [] }, remote, ['hw-1'], [], snap).homework[0].text, 'поправил бот');
  assert.equal(merge({ homework: [{ ...orig, text: 'админ' }], deadlines: [] }, remote, ['hw-1'], [], snap).homework[0].text, 'админ');
});

t('пустой или неполный remote: ничего не добавляется, локальное цело', () => {
  const local = { homework: [hw('hw-1')], deadlines: [{ id: 'dl-1' }] };
  for (const remote of [null, undefined, {}, { homework: 'x' }]) {
    const r = merge(local, remote, ['hw-1', 'dl-1'], []);
    assert.deepEqual(ids(r.homework), ['hw-1']);
    assert.deepEqual(ids(r.deadlines), ['dl-1']);
    assert.deepEqual(Array.from(r.addedIds), []);
  }
  const e = merge({}, { homework: [], deadlines: [] }, [], []);
  assert.deepEqual([ids(e.homework), ids(e.deadlines)], [[], []]);
});

t('входные данные не меняются', () => {
  const local = { homework: [hw('hw-1')], deadlines: [] };
  const remote = { homework: [hw('hw-bot', { source: 'bot' })], deadlines: [] };
  const a = JSON.stringify([local, remote]);
  merge(local, remote, ['hw-1'], []);
  assert.equal(JSON.stringify([local, remote]), a);
});

console.log(`\nПройдено: ${n}`);
