// Чистые функции activity.js (журнал действий 2.1): название экрана, подпись кнопки, устройство. Запуск: node tests/unit/activity.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const ctx = {}; ctx.window = ctx; ctx.globalThis = ctx;           // как в браузере без документа: только чистые функции
vm.runInNewContext(readFileSync(new URL('../../activity.js', import.meta.url), 'utf8'), ctx);
const { screenName, clickLabel, deviceLabel } = ctx.J2Act;
let failed = 0;
const t = (name, fn) => { try { fn(); console.log('OK    ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e.message || e)); } };

t('экран: страница и маршрут без параметров', () => {
  assert.equal(screenName('app.html', '#/study/homework'), 'app#/study/homework');
  assert.equal(screenName('app.html', '#/home?x=1&token=abc'), 'app#/home');
  assert.equal(screenName('app.html', ''), 'app');
});
t('экран: идентификаторы заменяются, чат не пишется вовсе', () => {
  assert.equal(screenName('headman.html', '#/student/st-1758300000008'), 'headman#/student/…');
  assert.equal(screenName('headman.html', '#/student/6f9619ff-8b86-d011-b42d-00c04fc964ff/edit'), 'headman#/student/…/edit');
  assert.equal(screenName('app.html', '#/chat/abc'), null);
  assert.equal(screenName('teacher.html', '#/chat'), null);
});
t('кнопка: aria-label главнее текста, пробелы схлопнуты, длина до 40', () => {
  assert.equal(clickLabel('Назад', '', 'x'), 'Назад');
  assert.equal(clickLabel('', 'hw-add', 'Добавить'), 'hw-add');
  assert.equal(clickLabel('', '', '  Добавить \n домашку '), 'Добавить домашку');
  assert.equal(clickLabel('', '', 'а'.repeat(100)).length, 40);
  assert.equal(clickLabel('', '', '   '), '');
});
t('устройство: ОС и браузер словами, без версий', () => {
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', 390, false), 'Android · Chrome (телефон)');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1', 390, false), 'iOS · Safari (телефон)');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Edg/126.0', 1280, false), 'Windows · Edge (ПК)');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile', 390, true), 'Android · Telegram (телефон)');
});
console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
