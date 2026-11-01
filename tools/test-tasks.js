// Тесты разницы списков задач: taskOps (клиент, shared.js) и diffTasks (сервер, _shared/taskdiff.ts).
// Запуск: node tools/test-tasks.js   (нужен node 22.18+ — он читает .ts без сборки)
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
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
const src = fs.readFileSync(path.join(root, 'shared.js'), 'utf8').replace(/^﻿/, '');
vm.runInContext(src + '\n;globalThis.__ops = taskOps;\n', sandbox, { filename: 'shared.js' });
const taskOps = sandbox.__ops;

const hw = (id, extra) => ({ id, subject: 'Логистика', text: id, dueDate: '2026-11-05', ...extra });
const snap = (...recs) => new Map(recs.map((r) => [r.id, JSON.stringify(r)]));
const plain = (v) => JSON.parse(JSON.stringify(v));   // объекты из vm-контекста → обычные
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

(async () => {
  const { diffTasks } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/taskdiff.ts')).href);

  t('клиент: не тронутое не отправляется, новое и изменённое — отправляется', () => {
    const a = hw('hw-1'), b = hw('hw-2');
    const local = { homework: [a, { ...b, text: 'правка' }, hw('hw-3')], deadlines: [{ id: 'dl-1', type: 'zachet' }] };
    const ops = plain(taskOps(local, snap(a, b), new Set()));
    assert.deepEqual(ops.upserts.map((u) => [u.kind, u.rec.id]), [['homework', 'hw-2'], ['homework', 'hw-3'], ['deadline', 'dl-1']]);
    assert.deepEqual(ops.deletes, []);
  });

  t('клиент: запись бота, которой нет на странице, не затрагивается; удалённое админом — в deletes', () => {
    const a = hw('hw-1');
    const ops = plain(taskOps({ homework: [], deadlines: [] }, snap(a), new Set(['hw-1'])));
    assert.deepEqual(ops, { upserts: [], deletes: ['hw-1'] });
  });

  t('клиент: без загруженного снимка отправляется всё; входные данные не меняются', () => {
    const local = { homework: [hw('hw-1')], deadlines: [] };
    const before = JSON.stringify(local);
    assert.equal(taskOps(local, null, null).upserts.length, 1);
    assert.equal(JSON.stringify(local), before);
  });

  t('сервер: diffTasks — добавлено, изменено, удалено; одинаковое пропускается', () => {
    const before = { homework: [hw('hw-1'), hw('hw-2')], deadlines: [{ id: 'dl-1', text: 'a' }] };
    const after = { homework: [hw('hw-1'), hw('hw-2', { text: 'новое' }), hw('hw-3')], deadlines: [] };
    const ops = diffTasks(before, after);
    assert.deepEqual(ops.upserts.map((u) => [u.kind, u.rec.id]), [['homework', 'hw-2'], ['homework', 'hw-3']]);
    assert.deepEqual(ops.deletes, ['dl-1']);
  });

  t('сервер: без изменений — пустая разница', () => {
    const l = { homework: [hw('hw-1')], deadlines: [{ id: 'dl-1' }] };
    assert.deepEqual(diffTasks(l, JSON.parse(JSON.stringify(l))), { upserts: [], deletes: [] });
  });

  console.log(`\nПройдено: ${n}`);
})();
