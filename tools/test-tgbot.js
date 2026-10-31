// Тесты чистой логики Telegram-бота задач (supabase/functions/_shared/tgbot.ts).
// Запуск: node tools/test-tgbot.js   (нужен node 22.18+ — он читает .ts без сборки)

'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const T = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/tgbot.ts')).href);
  const TODAY = '2026-10-31';

  test('секретный заголовок: совпадение, пустой секрет, чужое значение', () => {
    assert.equal(T.checkSecret('abc123', 'abc123'), true);
    assert.equal(T.checkSecret('abc124', 'abc123'), false);
    assert.equal(T.checkSecret('abc12', 'abc123'), false);
    assert.equal(T.checkSecret(null, 'abc123'), false);
    assert.equal(T.checkSecret('', ''), false);          // секрет не задан — всё закрыто
    assert.equal(T.checkSecret('x', undefined), false);
  });

  test('код привязки: нормализация и узнавание', () => {
    assert.equal(T.normalizeCode('abcd-efgh'), 'ABCDEFGH');
    assert.equal(T.normalizeCode('АВСD EFGH'), 'ABCDEFGH');   // кириллица-двойники
    assert.equal(T.looksLikeCode('K7M2-QX9P'), true);
    assert.equal(T.looksLikeCode('K7M2-QX9'), false);
    assert.equal(T.looksLikeCode('K7M2-QX0P'), false);        // 0 нет в алфавите
    assert.equal(T.looksLikeCode('привет'), false);
  });

  test('срок кода: 10 минут, одноразовость', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const mk = (min, used) => ({ expires_at: new Date(now + min * 60000).toISOString(), used_at: used ? 'x' : null });
    assert.equal(T.linkCodeState(mk(5, false), now), 'ok');
    assert.equal(T.linkCodeState(mk(0, false), now), 'expired');
    assert.equal(T.linkCodeState(mk(-1, false), now), 'expired');
    assert.equal(T.linkCodeState(mk(5, true), now), 'used');
    assert.equal(T.linkCodeState(null, now), 'none');
    assert.equal(T.LINK_CODE_TTL_MS, 600000);
  });

  test('лимит: 20 записей в час', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const ago = (min) => new Date(now - min * 60000).toISOString();
    assert.equal(T.rateAllowed(Array(19).fill(ago(10)), now), true);
    assert.equal(T.rateAllowed(Array(20).fill(ago(10)), now), false);
    assert.equal(T.rateAllowed(Array(20).fill(ago(61)), now), true);   // старше часа не считаются
  });

  test('состояние диалога: TTL 30 минут', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    assert.equal(T.dialogFresh(new Date(now - 29 * 60000).toISOString(), now), true);
    assert.equal(T.dialogFresh(new Date(now - 30 * 60000).toISOString(), now), false);
    assert.equal(T.dialogFresh(null, now), false);
  });

  test('разбор даты ДД.ММ', () => {
    assert.deepEqual(T.parseDmy('05.11', TODAY), { ok: true, date: '2026-11-05' });
    assert.deepEqual(T.parseDmy(' 5/11 ', TODAY), { ok: true, date: '2026-11-05' });
    assert.deepEqual(T.parseDmy('31.10', TODAY), { ok: true, date: '2026-10-31' });   // сегодня можно
    assert.deepEqual(T.parseDmy('05.11.27', TODAY), { ok: true, date: '2027-11-05' });
    assert.deepEqual(T.parseDmy('10.01', TODAY), { ok: true, date: '2027-01-10' });   // без года — следующий
    assert.deepEqual(T.parseDmy('30.10', TODAY), { ok: false, reason: 'past' });
    assert.deepEqual(T.parseDmy('31.02', TODAY), { ok: false, reason: 'format' });
    assert.deepEqual(T.parseDmy('завтра', TODAY), { ok: false, reason: 'format' });
    assert.deepEqual(T.parseDmy('01.01.2030', TODAY), { ok: false, reason: 'far' });
  });

  test('даты: сдвиг, формат, Минск', () => {
    assert.equal(T.addDaysYmd('2026-12-30', 3), '2027-01-02');
    assert.equal(T.fmtDm('2026-11-05'), '05.11');
    assert.equal(T.dowShort('2026-11-05'), 'Чт');
    assert.equal(T.minskYmd(Date.parse('2026-10-31T22:00:00Z')), '2026-11-01');   // 01:00 по Минску
  });

  // Расписание читаем из настоящего schedule.js — заодно ловим, если его формат изменится
  const sched = T.parseSchedule(fs.readFileSync(path.join(root, 'schedule.js'), 'utf8'));

  test('расписание: schedule.js разбирается', () => {
    assert.ok(sched);
    assert.equal(sched.start, '2026-09-01');
    assert.equal(sched.weeksCount, 16);
    assert.ok(sched.lessons.length > 50);
    assert.ok(sched.lessons.every((l) => l.kind !== 'ЗЧ'));
    assert.ok(sched.lessons.some((l) => l.subject === 'Эконометрика' && l.kind === 'ПЗ'));
  });

  test('расписание: ближайшие даты по предмету', () => {
    // Маркетинг услуг: чт (4) пары «1-13» лекции, пт/чт — ПЗ; неделя 9 начинается 2026-10-26
    const d = T.nextLessonDates(sched, 'Маркетинг услуг', TODAY, 4);
    assert.equal(d.length, 4);
    assert.deepEqual([...d].sort(), d);                       // по возрастанию
    assert.ok(d.every((x) => x >= TODAY));
    assert.equal(new Set(d).size, d.length);                  // без повторов
    assert.deepEqual(T.nextLessonDates(sched, 'Несуществующий', TODAY, 4), []);
    // 2026-11-05 — четверг 10-й недели; лекции по МУ идут «1-13», значит среди дат он есть
    assert.ok(T.nextLessonDates(sched, 'Маркетинг услуг', TODAY, 4).includes('2026-11-05'));
    // после конца семестра занятий нет
    assert.deepEqual(T.nextLessonDates(sched, 'Маркетинг услуг', '2027-03-01', 4), []);
  });

  test('запасные даты: сегодня / завтра / через неделю', () => {
    assert.deepEqual(T.fallbackDates(TODAY), ['2026-10-31', '2026-11-01', '2026-11-07']);
  });

  test('запись домашки и дедлайна: поля как у админки + author/source', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const hw = T.buildRecord('homework', { subject: 'Эконометрика', type: 'ПЗ', text: 'КР', dueDate: '2026-11-05' }, 'st-1', now);
    assert.deepEqual(Object.keys(hw), ['id', 'subject', 'type', 'text', 'dueDate', 'subgroup', 'createdAt', 'author', 'source']);
    assert.equal(hw.id, 'hw-' + now);
    assert.equal(hw.source, 'bot');
    assert.equal(hw.author, 'st-1');
    const dl = T.buildRecord('deadline', { subject: 'Логистика', type: 'ПЗ', text: 'Эссе', dueDate: '2026-11-05' }, 'st-1', now, new Set(['dl-' + now]));
    assert.equal(dl.type, 'deadline');
    assert.equal(dl.id, 'dl-' + (now + 1));                   // занятый id пропускаем
    assert.equal('subgroup' in dl, false);
  });

  test('очистка текста', () => {
    assert.equal(T.cleanText('  привет\u0000\r\nмир  '), 'привет\nмир');
    assert.equal(T.cleanText('я'.repeat(900)).length, T.TEXT_MAX);
  });

  test('права на правку: автор в течение суток, админ всегда, чужое никогда', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const rec = (over) => ({ id: 'hw-1', source: 'bot', author: 'st-1', createdAt: new Date(now - 3600000).toISOString(), ...over });
    const me = { studentId: 'st-1', isAdmin: false };
    assert.equal(T.canModify(rec({}), me, now), true);
    assert.equal(T.canModify(rec({ createdAt: new Date(now - 25 * 3600000).toISOString() }), me, now), false);
    assert.equal(T.canModify(rec({ author: 'st-2' }), me, now), false);
    assert.equal(T.canModify(rec({ source: undefined, author: undefined }), me, now), false);   // запись админа из браузера
    assert.equal(T.canModify(rec({ author: 'st-2', createdAt: '2020-01-01T00:00:00Z' }), { studentId: 'x', isAdmin: true }, now), true);
    assert.equal(T.canModify(null, me, now), false);
  });

  test('сообщение коммита', () => {
    assert.equal(T.commitMessage('добавлено', 'homework', 'Эконометрика', '2026-11-05'), 'Бот: домашка Эконометрика — 05.11 (добавлено)');
  });

  console.log(`\n${passed} проверок прошло`);
})();
