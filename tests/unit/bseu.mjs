// Разбор расписания bseu.by на живом ответе (read-only POST, как в docs/research/bseu-schedule.md).
// Запуск: node tests/unit/bseu.mjs   (Node 22.6+ читает .ts без сборки). Без сети проверки пропускаются.
import { eventOf, inferConsultations, prevStudyDay, parseSchedule, currentWeek, toRows, expandWeeks, mondayOf, addDaysIso, fetchSemesterHtml, unknownTimes, PAIR_TIMES } from '../../supabase/functions/_shared/bseu.ts';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };

check('expandWeeks «(12-14,16)»', JSON.stringify(expandWeeks('(12-14,16)')) === '[12,13,14,16]');
check('expandWeeks «(5)»', JSON.stringify(expandWeeks('(5)')) === '[5]');
check('mondayOf воскресенье', mondayOf('2026-11-08') === '2026-11-02' && mondayOf('2026-11-02') === '2026-11-02');
check('неделя 1 для недели 10 с понедельником 2 ноября', addDaysIso('2026-11-02', -9 * 7) === '2026-08-31');

// События (2.1): ClassType bseu.by → event, консультация по правилу «учебный день перед экзаменом»
check('eventOf: Экзамен, Зачет, Консультация, обычные занятия', eventOf('Экзамен') === 'exam' && eventOf('Зачет') === 'credit' && eventOf('Зачёт') === 'credit' && eventOf('Консультация') === 'consultation' && eventOf('Лекции') === null && eventOf('Занятие') === null);
check('prevStudyDay: перед понедельником — суббота, иначе вчера', prevStudyDay('2027-01-18') === '2027-01-16' && prevStudyDay('2027-01-09') === '2027-01-08');
{
  const mk = (d, subject, event) => ({ lesson_date: d, pair_no: 1, starts_at: '08:15', ends_at: '09:35', subject, kind: 'other', teacher: null, room: '1', subgroup: null, event });
  const r = inferConsultations([mk('2027-01-16', 'А', null), mk('2027-01-18', 'А', 'exam'), mk('2027-01-07', 'Б', null), mk('2027-01-11', 'Б', 'exam'), mk('2027-01-12', 'В', 'consultation'), mk('2027-01-13', 'В', 'exam'), mk('2027-01-12', 'В', null)]);
  check('выведена: экзамен в понедельник — консультация в субботу', r[0].event === 'consultation');
  check('нет занятия накануне: ничего не выдумываем', r[2].event === null);
  check('явная консультация есть: чужие занятия не трогаем', r[6].event === null);
}

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
  check('события: экзамены и консультации из расписания, у каждого экзамена есть консультация накануне', (() => { const ex = [...new Set(rows.filter((r) => r.event === 'exam').map((r) => r.subject + '|' + r.lesson_date))]; return ex.length === 0 || ex.every((k) => { const [s, d] = k.split('|'); return rows.some((r) => r.subject === s && r.lesson_date === prevStudyDay(d) && r.event === 'consultation'); }); })());
  check('виды занятий узнаны', rows.every((r) => ['lecture', 'practice', 'lab', 'other'].includes(r.kind)) && rows.some((r) => r.kind === 'lecture') && rows.some((r) => r.kind === 'practice'));
  check('подгруппы только 1, 2 или пусто', rows.every((r) => r.subgroup === null || r.subgroup === 1 || r.subgroup === 2));
  check('даты занятий в разумных пределах (около семестра)', rows.every((r) => r.lesson_date >= '2026-08-01' && r.lesson_date <= '2027-02-28'), rows.map((r) => r.lesson_date).sort().filter((d) => d < '2026-08-01' || d > '2027-02-28')[0]);
}
console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
