// Чистая логика уведомлений: строки расписания, «и ещё N», подгруппа, кнопка и экранирование HTML. Без сети и без Deno.
// Запуск: node tests/unit/schedule-notify.mjs   (Node 22.6+ читает .ts без сборки)
import { changeLine, changesFor, scheduleBody, fitsSubgroup, ruDate } from '../../supabase/functions/_shared/schedule-text.ts';
import { esc, buttonUrl, dispatchText } from '../../supabase/functions/_shared/notify.ts';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const ch = (o) => ({ date: '2026-11-12', pair_no: 2, subject: 'Стратегический маркетинг', kind: 'room', subgroup: null, ...o });

check('дата «12 ноября»', ruDate('2026-11-12') === '12 ноября' && ruDate('2026-01-05') === '5 января');
check('аудитория', changeLine(ch({ from: '402', to: '405' })) === 'Стратегический маркетинг, 12 ноября: аудитория 402 → 405');
check('аудитория без прежней', changeLine(ch({ from: null, to: '405' })).endsWith('аудитория не указана → 405'));
check('время', changeLine(ch({ kind: 'time', from: '11:15', to: '13:05' })).endsWith('время 11:15 → 13:05'));
check('преподаватель', changeLine(ch({ kind: 'teacher', from: 'Иванов И.И.', to: 'Петров П.П.' })).endsWith('преподаватель Иванов И.И. → Петров П.П.'));
check('добавлено и отменено', changeLine(ch({ kind: 'added' })).endsWith('добавлено занятие') && changeLine(ch({ kind: 'removed' })).endsWith('занятие отменено'));

const many = (n) => Array.from({ length: n }, (_, i) => ch({ kind: 'added', date: `2026-11-${String(10 + i).padStart(2, '0')}` }));
check('5 строк без «и ещё»', scheduleBody(many(5)).split('\n').length === 5 && !scheduleBody(many(5)).includes('и ещё'));
check('8 строк: 5 + «и ещё 3»', (() => { const l = scheduleBody(many(8)).split('\n'); return l.length === 6 && l[5] === 'и ещё 3'; })());
check('сортировка по дате и паре', scheduleBody([ch({ kind: 'added', date: '2026-11-20' }), ch({ kind: 'removed', date: '2026-11-11' })]).startsWith('Стратегический маркетинг, 11 ноября'));

check('подгруппа: не выбрана — подходят все', fitsSubgroup(1, null) && fitsSubgroup(2, undefined) && fitsSubgroup(2, 0));
check('подгруппа: занятие общее — подходит всем', fitsSubgroup(null, 1) && fitsSubgroup(null, 2));
check('подгруппа: своя да, чужая нет (в т. ч. строкой)', fitsSubgroup(1, 1) && fitsSubgroup(1, '1') && !fitsSubgroup(2, 1) && !fitsSubgroup(1, '2'));
const mixed = [ch({ subgroup: 1 }), ch({ subgroup: 2 }), ch({ subgroup: null })];
check('changesFor отбирает строки получателя', changesFor(mixed, 1).length === 2 && changesFor(mixed, 2).length === 2 && changesFor(mixed, null).length === 3);

check('esc экранирует < > &', esc('<b>&"x"</b>') === '&lt;b&gt;&amp;"x"&lt;/b&gt;' && esc(null) === '');
check('текст уведомления экранирован', dispatchText('grade', 'Оценка <5>', 'a & b') === '<b>Оценка &lt;5&gt;</b>\na &amp; b');
check('без текста — только заголовок', dispatchText('task', 'Новая задача', null) === '<b>Новая задача</b>');
check('чат: фиксированный текст, содержимое строки не попадает', (() => { const t = dispatchText('chat', 'Секретный заголовок', 'секретный текст'); return !t.includes('Секретный') && !t.includes('секретный'); })());
check('кнопка: приложение, для семестра кабинет старосты', buttonUrl('grade', 'https://x.example') === 'https://x.example/app.html' && buttonUrl('semester', 'https://x.example') === 'https://x.example/headman.html');
check('кнопка: только https', buttonUrl('grade', 'http://localhost:8080') === '' && buttonUrl('grade', '') === '');

console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
