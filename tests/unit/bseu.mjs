// Разбор расписания bseu.by на живом ответе (read-only POST, как в docs/research/bseu-schedule.md).
// Запуск: node tests/unit/bseu.mjs   (Node 22.6+ читает .ts без сборки). Без сети проверки пропускаются.
import { parseSchedule, currentWeek, toRows, expandWeeks, mondayOf, addDaysIso, fetchSemesterHtml, unknownTimes, PAIR_TIMES } from '../../supabase/functions/_shared/bseu.ts';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };

check('expandWeeks «(12-14,16)»', JSON.stringify(expandWeeks('(12-14,16)')) === '[12,13,14,16]');
check('expandWeeks «(5)»', JSON.stringify(expandWeeks('(5)')) === '[5]');
check('mondayOf воскресенье', mondayOf('2026-11-08') === '2026-11-02' && mondayOf('2026-11-02') === '2026-11-02');
check('неделя 1 для недели 10 с понедельником 2 ноября', addDaysIso('2026-11-02', -9 * 7) === '2026-08-31');

let html = null;
try { html = await fetchSemesterHtml({ faculty: '13', form: '10', course: '3', group: '9457' }); } catch (e) { console.log('нет связи с bseu.by, живые проверки пропущены:', String(e.message ?? e)); }
if (html) {
  const { lessons } = parseSchedule(html);
  check('занятия найдены', lessons.length > 20, String(lessons.length));
  check('все времена из таблицы страницы есть в таблице звонков', unknownTimes(html).length === 0, unknownTimes(html).join(', '));
  check('номера пар у занятий известны', lessons.every((l) => PAIR_TIMES[Number(l.pair)]), JSON.stringify(lessons.find((l) => !PAIR_TIMES[Number(l.pair)])));
  const cw = currentWeek(html);
  check('номер текущей недели найден', cw >= 1 && cw <= 25, String(cw));
  const rows = toRows(lessons, addDaysIso(mondayOf(new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)), -(cw - 1) * 7));
  check('строки с датами получены', rows.length >= lessons.length, `${rows.length} из ${lessons.length}`);
  check('в строках нет дублей (дата, пара, предмет, подгруппа)', new Set(rows.map((r) => `${r.lesson_date}|${r.pair_no}|${r.subject}|${r.subgroup ?? 0}`)).size === rows.length);
  check('виды занятий узнаны', rows.every((r) => ['lecture', 'practice', 'lab', 'other'].includes(r.kind)) && rows.some((r) => r.kind === 'lecture') && rows.some((r) => r.kind === 'practice'));
  check('подгруппы только 1, 2 или пусто', rows.every((r) => r.subgroup === null || r.subgroup === 1 || r.subgroup === 2));
  check('даты занятий в разумных пределах (около семестра)', rows.every((r) => r.lesson_date >= '2026-08-01' && r.lesson_date <= '2027-02-28'), rows.map((r) => r.lesson_date).sort().filter((d) => d < '2026-08-01' || d > '2027-02-28')[0]);
}
console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
