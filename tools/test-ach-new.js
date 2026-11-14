// Тесты правил достижений нового кабинета (ach-calc.js) на заглушечных absences / study_days / app_events.
// Правила должны совпадать с achDeserved() из achievements.js (старый журнал) и с серверной attendance_badges_deserved().
// Запуск: node tools/test-ach-new.js
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const win = {};
runInNewContext(readFileSync('ach-calc.js', 'utf8'), { window: win });
const C = win.AchCalc;

let bad = 0;
const check = (name, ok, extra = '') => { if (!ok) bad++; console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + extra}`); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codes = (s, f) => C.deserved(s).filter(f || (() => true)).map((d) => d.code + (d.period ? '@' + d.period : ''));

// Учебные дни: ноябрь 2026 без выходных и с «днём без пар» 11.11 (его в списке нет)
const D = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'];
const ab = (date, hours, isExcused) => ({ date, hours, isExcused: !!isExcused });
const mk = (o = {}) => C.stats({ asOf: '2026-11-13', studyDays: D, absences: [], kinds: new Set(), homework: 0, earned: new Map(), ...o });
const got = (...cs) => new Map(cs.map((c) => [c, { earned_at: '2026-11-01T00:00:00Z', periods: new Set(['']) }]));

// ---------- серия ----------
{
  let s = mk();
  check('серия без пропусков = все учебные дни (день без пар в счёт не идёт)', s.streak === 9 && s.bestStreak === 9);
  check('серия 9 дней: streak_3, 5 есть, 10 нет', eq(codes(s, (d) => d.code.startsWith('streak')), ['streak_3', 'streak_5']));
  s = mk({ absences: [ab('2026-11-05', 2, true)] });
  check('уважительный пропуск серию не прерывает', s.streak === 9);
  s = mk({ absences: [ab('2026-11-05', 2, false)] });
  check('неуважительный прерывает: текущая 5 (06, 09, 10, 12, 13), лучшая 5', s.streak === 5 && s.bestStreak === 5, s.streak + '/' + s.bestStreak);
  s = mk({ absences: [ab('2026-11-09', 1, false)] });
  check('лучшая серия — до пропуска (02–06 = 5), текущая — после (10, 12, 13 = 3)', s.bestStreak === 5 && s.streak === 3, s.streak + '/' + s.bestStreak);
  s = mk({ asOf: '2026-11-04' });
  check('«актуально на»: дни после даты в серию не входят', s.streak === 3 && s.studyDaysPassed === 3);
  s = mk({ absences: [ab('2026-10-30', 4, false), ab('2026-12-30', 4, false)] });
  check('пропуски вне учебного периода игнорируются', s.bad.length === 0 && s.streak === 9);
  check('два пропуска в один день — один плохой день', mk({ absences: [ab('2026-11-05', 2, false), ab('2026-11-05', 2, false)] }).bestStreak === 5);
}
// ---------- месяцы ----------
{
  const days = ['2026-09-01', '2026-09-02', '2026-10-01', '2026-10-02', '2026-11-02', '2026-11-03'];
  const st = (o) => C.stats({ asOf: '2026-11-03', studyDays: days, absences: [], kinds: new Set(), homework: 0, earned: new Map(), ...o });
  let s = st();
  check('чистый лист за каждый закрытый месяц, чистый семестр после конца', eq(codes(s, (d) => /clean/.test(d.code)), ['clean_sheet@2026-09', 'clean_sheet@2026-10', 'clean_sheet@2026-11', 'clean_term']));
  s = st({ asOf: '2026-11-02' });
  check('ноябрь ещё не закрыт (03.11 впереди): листа за него нет, семестр не закончен', eq(codes(s, (d) => /clean/.test(d.code)), ['clean_sheet@2026-09', 'clean_sheet@2026-10']));
  s = st({ absences: [ab('2026-09-02', 2, false)] });
  check('«Исправился»: сентябрь с пропуском, октябрь чистый → recovered@2026-10', codes(s).includes('recovered@2026-10') && !codes(s).includes('clean_sheet@2026-09') && !codes(s).includes('clean_term'));
  check('«Исправился» только один раз: ноябрь после чистого октября не считается', !codes(s).includes('recovered@2026-11'));
  s = st({ absences: [ab('2026-10-02', 2, true)] });
  check('уважительный пропуск лист и семестр не портит', codes(s).includes('clean_sheet@2026-10') && codes(s).includes('clean_term'));
  s = st({ absences: [ab('2026-10-01', 2, false), ab('2026-10-02', 2, false)] });
  check('антидостижения: 4 ч в октябре → anti_m2 и anti_m4 с периодом', eq(codes(s, (d) => d.code.startsWith('anti')), ['anti_m2@2026-10', 'anti_m4@2026-10']));
  s = st({ absences: [ab('2026-09-01', 6, false), ab('2026-10-01', 6, false), ab('2026-11-02', 12, false)] });
  const anti = codes(s, (d) => d.code.startsWith('anti'));
  check('антидостижения считаются по месяцам отдельно (6+6 не складываются в 12)', anti.includes('anti_m6@2026-09') && anti.includes('anti_m6@2026-10') && !anti.includes('anti_m8@2026-09') && !anti.includes('anti_m12@2026-10'));
  check('12 часов — и anti_m12, и «Вызов в деканат» (порог тот же, как в 1.x)', anti.includes('anti_m12@2026-11') && anti.includes('anti_m14@2026-11'));
  check('часы по месяцу: monthUnexcused — текущий месяц по «актуально на»', s.monthUnexcused === 12 && s.month === '2026-11');
}
// ---------- значки, которые выдаёт клиент ----------
{
  const due = (o) => C.clientDue(mk(o)).map((d) => d.code);
  check('без событий клиенту выдавать нечего', eq(due(), []));
  check('first_login → welcome', eq(due({ kinds: new Set(['first_login']) }), ['welcome']));
  check('первые шаги: только аватарка — не хватает, оба события — выдаётся', !due({ kinds: new Set(['avatar_set']) }).includes('first_steps') && due({ kinds: new Set(['avatar_set', 'pass_opened']) }).includes('first_steps'));
  check('whats_new_read → tech, notifications_on → notify_on', eq(due({ kinds: new Set(['whats_new_read', 'notifications_on']) }), ['tech', 'notify_on']));
  check('домашки: 3 → hw_1, hw_3', eq(due({ homework: 3 }), ['hw_1', 'hw_3']));
  check('домашки: 50 → вся лесенка', eq(due({ homework: 50 }), ['hw_1', 'hw_3', 'hw_10', 'hw_25', 'hw_50']));
  check('идемпотентность: уже полученное повторно не выдаётся', eq(due({ homework: 3, earned: got('hw_1', 'hw_3') }), []));
  check('серверные коды (серии, чистый лист, игры) клиент не выдаёт, даже когда они заслужены', !C.clientDue(mk()).some((d) => C.BY_CODE[d.code].server) && codes(mk()).includes('streak_5'));
  check('cert_* не заслуживается никогда', !codes(mk({ absences: [ab('2026-11-05', 2, true)] })).some((c) => c.startsWith('cert')));
  const nine = new Map(['streak_3', 'streak_5', 'clean_sheet', 'clean_term', 'tech', 'hw_1', 'hw_3', 'game_player', 'game_snake_bite'].map((c) => [c, { earned_at: 'x', periods: new Set(['']) }]));
  check('«Коллекционер»: 9 значков — ещё нет, 10-й (в том числе только что заслуженный) — да',
    !due({ earned: nine }).includes('collector') && due({ earned: nine, homework: 10 }).includes('collector'));
  const ten = new Map(nine); ten.set('anti_m2', { earned_at: 'x', periods: new Set(['2026-10']) });
  check('антидостижения в «Коллекционера» не идут', !due({ earned: ten }).includes('collector'));
  check('повторяемые значки: счёт по коду, а не по периодам', mk({ earned: new Map([['clean_sheet', { earned_at: 'x', periods: new Set(['2026-09', '2026-10']) }]]) }).badgesCount === 1);
}
// ---------- прогресс и экран ----------
{
  const s = mk({ absences: [ab('2026-11-05', 2, false)], earned: got('streak_3') });
  const p = C.progress('streak_10', s);
  check('прогресс серии: «Серия 5 из 10 дней»', p.have === 5 && p.need === 10 && /Серия 5 из 10/.test(p.text), p.text);
  check('прогресс домашки', C.progress('hw_10', mk({ homework: 4 })).text === '4 из 10 домашек');
  check('anti_m4: часов в этом месяце и «ещё N ч»', /^2 ч неуважительных в этом месяце · ещё 2 ч/.test(C.progress('anti_m4', mk({ absences: [ab('2026-11-05', 2, false)] })).text));
  check('чистый лист заблокирован после пропуска в месяце', C.progress('clean_sheet', s).blocked === true);
  check('справка: «Пока не выдаётся»', C.progress('cert_1', s).soon === true);
  check('первые шаги: чек-лист из двух пунктов', C.progress('first_steps', mk({ kinds: new Set(['avatar_set']) })).checklist.map((c) => c.done).join() === 'true,false');
  const nx = C.nextUp(mk({ earned: got('streak_3', 'streak_5') }));
  check('ближайший значок: не антидостижение, не игра, не справка', !!nx && !nx.a.anti && nx.a.cat !== 'games' && !nx.a.soon, nx && nx.a.code);
  const lt = C.latest(new Map([['streak_3', { earned_at: '2026-11-01' }], ['hw_1', { earned_at: '2026-11-08' }], ['anti_m2', { earned_at: '2026-11-12' }]]));
  check('последнее — самое позднее, без антидостижений', lt.a.code === 'hw_1');
  const em = C.earnedMap([{ code: 'streak_3', period: '', earned_at: '2026-11-03' }, { code: 'anti_2', period: '', earned_at: 'x' }, { code: 'clean_sheet', period: '2026-09', earned_at: '2026-10-01' }, { code: 'clean_sheet', period: '2026-10', earned_at: '2026-11-01' }]);
  check('earnedMap: чужой код отброшен, периоды собраны, дата — самая ранняя', !em.has('anti_2') && em.get('clean_sheet').periods.size === 2 && em.get('clean_sheet').earned_at === '2026-10-01');
  check('всего значков в «N из M»: без антидостижений и справок', C.TOTAL === C.CATALOG.filter((a) => !a.anti && !a.soon).length && C.TOTAL === 39, String(C.TOTAL));
}
// ---------- каталог не разошёлся со старым achievements.js и набором иконок ----------
{
  const src = readFileSync('achievements.js', 'utf8');
  const old = new Function(src.slice(src.indexOf('const ACHIEVEMENTS'), src.indexOf('// Значки за рекорды выдаёт сервер')) + '; return ACHIEVEMENTS;')();
  const same = old.length === C.CATALOG.length && old.every((o, i) => { const n = C.CATALOG[i]; return n.code === o.code && n.cat === o.cat && n.title === o.title && n.about === o.about && (n.need || 0) === (o.need || 0) && !!n.anti === !!o.anti; });
  check('каталог ach-calc.js 1:1 с ACHIEVEMENTS из achievements.js (коды, порядок, тексты, пороги)', same, `${old.length} vs ${C.CATALOG.length}`);
  const sprite = readFileSync('icons/achievements/sprite.svg', 'utf8');
  const miss = C.CATALOG.filter((a) => !sprite.includes(`id="a-${a.code}"`) || !existsSync(`icons/achievements/${a.code}.svg`)).map((a) => a.code);
  check('для каждого значка каталога есть иконка и символ в спрайте', !miss.length, miss.join(', '));
  const serverCodes = C.CATALOG.filter((a) => a.server).map((a) => a.code).sort();
  const mig = readFileSync('supabase/migrations/20261103120000_attendance_badges_server.sql', 'utf8');
  const sql = (mig.match(/attendance_badge_codes\(\)[\s\S]*?array\[([^\]]*)\]/) || [])[1] || '';
  const sqlCodes = sql.split(',').map((x) => x.replace(/'/g, '').trim()).filter(Boolean);
  check('серверные коды посещаемости в каталоге = attendance_badge_codes() в миграции', eq(serverCodes.filter((c) => !c.startsWith('game_')), sqlCodes.slice().sort()), sqlCodes.join());
}
console.log(bad ? `\nПРОВАЛОВ: ${bad}` : '\nВсё прошло');
process.exit(bad ? 1 : 0);
