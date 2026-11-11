// Модульные проверки 2.0.2 (cab-core.js): пропуски по предметам и видам занятий, состояние документа по сроку, версия.
//   node tests/unit/v202.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('OK     ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); } };

const ctx = {
  J2: { sb: null, esc: (s) => String(s) }, location: { pathname: '/app.html', hash: '', href: '' }, sessionStorage: { getItem: () => null, setItem() {} },
  document: { body: {}, querySelector: () => null, createElement: () => ({}) }, navigator: { onLine: true }, console, JSON, Array, String, Math, Date, Promise, Set, Map, setTimeout: () => 0, clearTimeout() {},
  lsGet: () => null, lsSet: () => true,
};
ctx.window = ctx;
vm.runInNewContext(readFileSync('cab-core.js', 'utf8'), ctx);
const Cab = ctx.Cab;
const a = (subject, hours, ex, kind) => ({ subject, hours, is_excused: ex, lesson_kind: kind });

t('запись 2.0.2 в «Что нового» осталась (текущую версию проверяет v203.mjs)', () => {
  const src = readFileSync('changelog.js', 'utf8');
  assert.ok(/version: '2\.0\.2',\s*date: '09\.11\.2026'/.test(src));
});

t('по предметам: часы по видам, уважительные и неуважительные отдельно, итоги сходятся', () => {
  const rows = [a('Логистика', 2, false, 'lecture'), a('логистика ', 2, true, 'lecture'), a('Логистика', 2, false, 'lab'), a('Эконометрика', 2, true, 'practice'), a('Эконометрика', 4, false, null)];
  const s = Cab.subjStats(rows, new Set());
  assert.equal(JSON.stringify(s.list.map((r) => r.subject)), JSON.stringify(['Логистика', 'Эконометрика']));            // «логистика » — тот же предмет; сверху у кого часов больше
  const l = s.list[0], e = s.list[1];
  assert.equal(JSON.stringify([l.lecture.un, l.lecture.ex, l.lab.un, l.un, l.ex, l.tot]), JSON.stringify([2, 2, 2, 4, 2, 6]));
  assert.equal(JSON.stringify([e.practice.ex, e.none.un, e.tot]), JSON.stringify([2, 4, 6]));
  assert.equal(JSON.stringify([s.total.un, s.total.ex, s.total.tot]), JSON.stringify([8, 4, 12]));
  assert.equal(s.total.tot, rows.reduce((n, r) => n + r.hours, 0));                         // сумма таблицы = сумма списка пропусков
  assert.equal(s.lab, true); assert.equal(s.none, true);
});
t('по предметам: предмет без пропусков не появляется, лабораторные — только если они есть', () => {
  const s = Cab.subjStats([a('Логистика', 2, false, 'lecture'), a('Нулевой', 0, false, 'lecture')], new Set(['эконометрика']));
  assert.equal(JSON.stringify(s.list.map((r) => r.subject)), JSON.stringify(['Логистика']));
  assert.equal(s.lab, false); assert.equal(s.none, false);
  const s2 = Cab.subjStats([a('Эконометрика', 2, false, 'lecture')], new Set(['эконометрика']));
  assert.equal(s2.lab, true); assert.equal(s2.list[0].hasLab, true);                          // лабораторные есть в расписании предмета
  assert.equal(Cab.subjStats([], new Set()).list.length, 0);
});

t('документ по сроку: ждём, срок сегодня — ещё ждём, вчера — просрочен, сдан — сдан', () => {
  const today = '2026-11-09';
  assert.equal(Cab.docKind({ cert_due_date: '2026-11-12' }, today), 'wait');
  assert.equal(Cab.docKind({ cert_due_date: '2026-11-09' }, today), 'wait');
  assert.equal(Cab.docKind({ cert_due_date: '2026-11-08' }, today), 'late');
  assert.equal(Cab.docKind({}, today), 'wait');                                                // срок не указан
  assert.equal(Cab.docKind({ cert_submitted: true, cert_due_date: '2026-01-01' }, today), 'done');
});

process.exit(failed ? 1 : 0);
