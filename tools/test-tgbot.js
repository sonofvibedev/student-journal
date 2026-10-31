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

  test('права на правку: после заявок только админ', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const rec = { id: 'hw-1', source: 'bot', author: 'st-1', createdAt: new Date(now - 3600000).toISOString() };
    assert.equal(T.canModify(rec, { studentId: 'st-1', isAdmin: false }, now), false);   // даже свою одобренную автор не правит
    assert.equal(T.canModify(rec, { studentId: 'x', isAdmin: true }, now), true);
    assert.equal(T.canModify(null, { studentId: 'x', isAdmin: true }, now), false);
  });

  test('запись из заявки: заранее назначенный id', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const rec = T.buildRecord('homework', { subject: 'Логистика', type: 'УСР', text: 'х', dueDate: '2026-11-05' }, 'st-1', now, new Set(), 'hw-42');
    assert.equal(rec.id, 'hw-42');
    assert.equal(T.recordIdFor('deadline', 7), 'dl-7');
  });

  test('сообщение коммита', () => {
    assert.equal(T.commitMessage('добавлено', 'homework', 'Эконометрика', '2026-11-05'), 'Бот: домашка Эконометрика — 05.11 (добавлено)');
  });

  // ---------- заявки ----------
  test('дубль: нормализация, вхождение, Жаккар >= 0.6', () => {
    assert.equal(T.normText('  КР №2, по всем-ТЕМАМ!! Ёлка '), 'кр 2 по всем темам елка');
    assert.equal(T.similarText('Выставки по подгруппам', 'выставки  по подгруппам.'), true);
    assert.equal(T.similarText('Выставки', 'Выставки по подгруппам'), true);                 // одно содержит другое
    assert.equal(T.similarText('сделать задачи 1 2 3 из учебника', 'из учебника сделать задачи 1 2'), true);   // Жаккар 5/6
    assert.equal(T.similarText('Гостиницы', 'Рестораны'), false);
    assert.equal(T.similarText('', 'что-то'), false);
    const c = { subject: 'Маркетинг услуг', dueDate: '2026-11-04', text: 'Гостиницы' };
    assert.equal(T.findDuplicate(c, [{ subject: 'Маркетинг услуг', dueDate: '2026-11-04', text: 'гостиницы!' }], []), 'record');
    assert.equal(T.findDuplicate(c, [], [{ subject: 'Маркетинг услуг', due_date: '2026-11-04', text: 'Гостиницы (страница 5)' }]), 'request');
    assert.equal(T.findDuplicate(c, [{ subject: 'Маркетинг услуг', dueDate: '2026-11-05', text: 'Гостиницы' }], []), null);   // другая дата
    assert.equal(T.findDuplicate(c, [{ subject: 'Логистика', dueDate: '2026-11-04', text: 'Гостиницы' }], []), null);        // другой предмет
  });

  test('лимит заявок на проверке: пятая можно, шестая нет', () => {
    assert.equal(T.pendingAllowed(4), true);
    assert.equal(T.pendingAllowed(5), false);
    assert.equal(T.PENDING_MAX, 5);
  });

  test('кто может решать: только telegram_id из TG_ADMIN_IDS', () => {
    const ids = new Set(['111', '222']);
    assert.equal(T.canDecide(111, ids), true);
    assert.equal(T.canDecide('222', ids), true);
    assert.equal(T.canDecide(333, ids), false);
    assert.equal(T.canDecide(null, ids), false);
    assert.equal(T.canDecide(111, new Set()), false);        // админы не заданы — никто
  });

  test('переходы статусов: только по схеме', () => {
    assert.equal(T.transition('pending', 'claim'), 'approving');
    assert.equal(T.transition('approving', 'commit'), 'approved');
    assert.equal(T.transition('approving', 'rollback'), 'pending');
    assert.equal(T.transition('pending', 'reject'), 'rejected');
    assert.equal(T.transition('pending', 'withdraw'), 'withdrawn');
    assert.equal(T.transition('pending', 'expire'), 'expired');
    // решённую заявку ничем не изменить
    for (const done of ['approved', 'rejected', 'withdrawn', 'expired']) {
      for (const ev of Object.keys(T.TRANSITIONS)) assert.equal(T.transition(done, ev), null, done + ' + ' + ev);
    }
    // нельзя отклонить/отозвать заявку, которую уже вносят
    assert.equal(T.transition('approving', 'reject'), null);
    assert.equal(T.transition('approving', 'withdraw'), null);
    assert.equal(T.transition('approving', 'expire'), null);
  });

  test('идемпотентность: условный UPDATE «WHERE status = from» отдаёт строку только первому', () => {
    // Модель БД: update(event) меняет заявку, только если статус совпал (как UPDATE ... WHERE status = $from)
    const row = { status: 'pending', writes: 0 };
    const update = (event) => {
      const t = T.TRANSITIONS[event];
      if (row.status !== t.from) return null;
      row.status = t.to;
      return { ...row };
    };
    const first = update('claim'), second = update('claim');       // двойное нажатие «Одобрить»
    assert.ok(first);
    assert.equal(second, null);
    if (first) row.writes++;                                       // запись в data.json только после успешного claim
    assert.equal(row.writes, 1);
    // сбой GitHub: откат возвращает заявку, и повтор снова проходит
    assert.ok(update('rollback'));
    assert.equal(row.status, 'pending');
    assert.ok(update('claim'));
    assert.ok(update('commit'));
    assert.equal(update('reject'), null);                          // одобренную уже не отклонить
  });

  test('зависшее «вносится»: подхватить можно через 2 минуты', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    assert.equal(T.approvingStale(new Date(now - 60000).toISOString(), now), false);
    assert.equal(T.approvingStale(new Date(now - 121000).toISOString(), now), true);
  });

  test('истечение заявки через 7 суток', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    assert.equal(T.requestExpired('2026-11-01T12:00:01Z', now), false);
    assert.equal(T.requestExpired('2026-11-01T12:00:00Z', now), true);
    assert.equal(T.requestExpired('2026-10-20T00:00:00Z', now), true);
  });

  test('текст заявки для админа', () => {
    const s = T.requestSummary({ kind: 'homework', subtype: 'ПЗ', subject: 'Эконометрика', due_date: '2026-11-05', text: 'КР' }, 'Иванов Иван');
    assert.match(s, /^Иванов Иван хочет внести домашку \(ПЗ\)/);
    assert.match(s, /Срок: Чт 05\.11\.2026/);
    assert.match(T.requestSummary({ kind: 'deadline', subject: 'А', due_date: '2026-11-05', text: 'Т' }, ''), /^Студент хочет внести дедлайн/);
  });

  test('миграция заявок: клиент не меняет таблицы, функция только для service_role', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261101140000_tg_task_requests.sql'), 'utf8');
    assert.match(sql, /alter table public\.tg_task_requests enable row level security/);
    assert.match(sql, /revoke all on public\.tg_task_requests from anon, authenticated/);
    assert.match(sql, /alter table public\.tg_action_log enable row level security/);
    assert.match(sql, /revoke all on public\.tg_action_log from anon, authenticated/);
    // единственная выдача прав клиенту — чтение своих заявок
    const grants = (sql.match(/^grant [^;]+;/gm) || []).filter((g) => /\b(anon|authenticated)\b/.test(g));
    assert.deepEqual(grants, ['grant select on public.tg_task_requests to authenticated;']);
    assert.ok(!/create policy[^;]+for (insert|update|delete|all)/i.test(sql));
    assert.match(sql, /revoke all on function public\.tg_submit_request[^;]*from public, anon, authenticated/);
    assert.match(sql, /grant execute on function public\.tg_submit_request[^;]* to service_role/);
    for (const st of ['pending', 'approving', 'approved', 'rejected', 'withdrawn', 'expired']) assert.ok(sql.includes(`'${st}'`), st);
    for (const k of ['request_created', 'approved', 'rejected', 'withdrawn', 'expired', 'admin_direct']) assert.ok(sql.includes(`'${k}'`), k);
    assert.match(sql, /cron\.schedule\(\s*'journal-tg-requests-expire'/);
    assert.ok(!/beyJ|bsk_|ghp_|github_pat/.test(sql));   // секретов в файле нет
  });

  console.log(`\n${passed} проверок прошло`);
})();
