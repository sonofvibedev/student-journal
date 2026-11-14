// Экраны 2.1 (app.html, headman.html, sysadmin) в настоящем браузере БЕЗ сети: Supabase подменён заглушкой, ни тест, ни прод не затрагиваются.
// Запуск: node tests/e2e/v21-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs). Снимки — SHOTS_DIR или %TEMP%21-shots.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-09';
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'v21-shots'));
mkdirSync(OUT, { recursive: true });

const ENV_JS = readFileSync('env.js', 'utf8').replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${SB}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`).replace("const LS_PREFIX = ''", "const LS_PREFIX = 'm_'");
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let b; try { b = readFileSync(resolve(join('.', p === '/' ? 'index.html' : p))); } catch (_) { res.writeHead(404).end(); return; }
  if (p.endsWith('/env.js')) b = Buffer.from(ENV_JS);
  else if (p.endsWith('/cab-core.js')) b = Buffer.from(b.toString('utf8').replace('Cab.testNow = null;', `Cab.testNow = ${NOW};`));
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(b);
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- заглушка базы ----------
const st = (id, last, first, sub) => ({ id, last_name: last, first_name: first, subgroup: sub || 1, claim_status: 'active', study_form: 'budget' });
const lesson = (subject, kind, teacher, pair, sg) => ({ lesson_date: TODAY, pair_no: pair, starts_at: `${8 + pair}:00:00`.padStart(8, '0'), ends_at: `${9 + pair}:30:00`.padStart(8, '0'), subject, kind, teacher, room: '101', subgroup: sg || null, prev_room: null, changed_at: null, event: null });
const abs = (id, sid, date, subject, hours, ex, kind, extra) => ({ id, student_id: sid, date, subject, hours, is_excused: ex, lesson_kind: kind, created_by: null, comment: null, cert_type: null, cert_submitted: false, cert_due_date: null, ...extra });
const task = (id, kind, rec, by) => ({ id, kind, rec: { id, createdAt: '2026-11-01T00:00:00Z', subgroup: 0, ...rec }, created_by: by || null });
const mk = () => ({
  memberships: [{ user_id: 'u-me', group_id: G, student_id: 's-me', base_role: 'student', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }, { user_id: 'u-a', group_id: G, student_id: 's-a', base_role: 'student', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }],
  groups: [{ id: G, name: '24ДММ-2', status: 'active', warn_hours: 8, dean_hours: 12 }],
  students: [st('s-me', 'Тестов', 'Тест'), st('s-a', 'Андреев', 'Антон'), st('s-b', 'Борисова', 'Берта'), st('s-c', 'Васильев', 'Виктор')],
  schedule_lessons: [lesson('Логистика', 'lecture', 'Иванов И.И.', 1), lesson('Логистика', 'practice', 'Петров П.П.', 2, 1), lesson('Логистика', 'lab', 'Сидоров С.С.', 3), lesson('Физическая культура и здоровье', 'practice', 'Физрук Ф.Ф.', 4), lesson('Кураторский час', 'other', 'Кураторов К.К.', 5), lesson('Эконометрика', 'lecture', 'Сверлов А.С.', 6),
    { ...lesson('Логистика', 'other', 'Иванов И.И.', 1), lesson_date: '2026-11-14', event: 'consultation', room: '3/230' },
    { ...lesson('Логистика', 'other', 'Иванов И.И.', 1), lesson_date: '2026-11-16', event: 'exam', room: '3/230' }, { ...lesson('Логистика', 'other', 'Иванов И.И.', 2), lesson_date: '2026-11-16', event: 'exam', room: '3/230' }, { ...lesson('Логистика', 'other', 'Иванов И.И.', 3), lesson_date: '2026-11-16', event: 'exam', room: null },
    { ...lesson('Эконометрика', 'other', 'Миксюк С.Ф.', 2), lesson_date: '2026-12-20', event: 'exam', room: '3/233' }, { ...lesson('Эконометрика', 'other', 'Миксюк С.Ф.', 1), lesson_date: '2026-12-19', event: 'credit', room: '3/233' }],
  tasks: [task('dl-e7', 'deadline', { subject: 'Логистика', type: 'exam', text: '', dueDate: '2026-11-16' }), task('dl-e8', 'deadline', { subject: 'Эконометрика', type: 'zachet', text: '', dueDate: '2026-11-17' }),
    task('hw-1', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'Задача 5', dueDate: '2026-11-10' }), task('hw-stu', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От студента', dueDate: '2026-12-05' }, 'u-a'), task('hw-tch', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От препода', dueDate: '2026-12-05' }, 'u-teacher'), task('dl-1', 'deadline', { subject: 'Эконометрика', type: 'deadline', text: 'Отчёт', dueDate: '2026-11-12' })],
  absences: [abs('ab-1', 's-a', '2026-11-03', 'Логистика', 2, false, 'lecture'), abs('ab-2', 's-a', '2026-11-04', 'Логистика', 2, false, 'lab'),
    abs('ab-3', 's-a', '2026-11-05', 'Эконометрика', 2, true, 'practice', { cert_type: 'Справка', cert_due_date: '2026-11-06' }), abs('ab-4', 's-b', '2026-11-05', 'Логистика', 4, false, 'lecture', { created_by: 'u-teacher' }), abs('ab-m1', 's-me', '2026-11-02', 'Логистика', 2, false, 'lecture'), abs('ab-m2', 's-me', '2026-11-06', 'Эконометрика', 2, true, 'practice', { cert_type: 'Больничный', cert_due_date: '2026-11-13' }), abs('ab-m3', 's-me', '2026-11-04', 'Логистика', 1, false, 'lab')],
  homework_editors: [], absence_cancellations: [{ id: 'c1', absence: { date: '2026-10-30', subject: 'Логистика', hours: 2 }, cancelled_by: 'u-me', cancelled_at: '2026-11-02T10:00:00Z' }],
  notifications: [], certificates: [], schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
  rpc: { is_sysadmin: true, sysadmin_usage_people: [{ user_id: 'u-a', user_name: 'Андреев Антон', role: 'student' }], sysadmin_prefs_get: { new_device: true, roles: true, deletes: true, errors: true, digest: false }, sysadmin_usage_log: [{ at: '2026-11-09T08:30:00Z', kind: 'login', name: '', user_id: 'u-a', user_name: 'Андреев Антон', role: 'student', group_name: '24ДММ-2', device: 'Android · Chrome (телефон)', new_device: true }, { at: '2026-11-09T08:31:00Z', kind: 'action', name: 'Добавить домашку', user_id: 'u-a', user_name: 'Андреев Антон', role: 'student', group_name: '24ДММ-2', device: 'Android · Chrome (телефон)', new_device: false }], sysadmin_prefs_set: null, absence_hours_my: { total: 6, excused: 2, unexcused: 4, warn_hours: 8, dean_hours: 12 }, data_deletion_requests_list: [], homework_access_set: null },
});
let DB = mk(), LOG = [];
const J = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*', ...extra }, body: JSON.stringify(body) });
async function fake(route) {
  const req = route.request(), u = new URL(req.url()), m = req.method(), path = u.pathname;
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (path.startsWith('/auth/v1')) return route.fulfill(J(200, { id: 'u-me', email: 'me@j.example', aud: 'authenticated', app_metadata: {}, user_metadata: {} }));
  if (path.startsWith('/storage/')) return route.fulfill(J(404, { message: 'not found' }));
  if (path.startsWith('/functions/')) return route.fulfill(J(200, {}));
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(path);
  if (rpc) { LOG.push({ m, rpc: rpc[1], body: req.postDataJSON() }); return route.fulfill(J(200, DB.rpc[rpc[1]] ?? null)); }
  const t = /^\/rest\/v1\/(.+)$/.exec(path); if (!t) return route.fulfill(J(404, {}));
  if ((DB.fail || []).includes(t[1])) return route.fulfill(J(500, { message: 'boom' }));
  let rows = DB[t[1]] || [];
  for (const [k, v] of u.searchParams) if (/^eq./.test(v) && rows.length && k in rows[0]) rows = rows.filter((r) => String(r[k]) === v.slice(3));   // фильтры eq: только по столбцам, которые есть в строках
  if (m === 'GET' || m === 'HEAD') {
    const one = /pgrst\.object/.test(req.headers().accept || '');
    if (m === 'HEAD' || /count=exact/.test(req.headers().prefer || '')) return route.fulfill(J(200, m === 'HEAD' ? '' : rows, { 'content-range': `0-0/${rows.length}` }));
    return route.fulfill(one ? (rows.length ? J(200, rows[0]) : J(406, { code: 'PGRST116', message: 'no rows' })) : J(200, rows));
  }
  let body = null; try { body = req.postDataJSON(); } catch (_) { /* без тела */ }
  LOG.push({ m, table: t[1], body, q: u.search });
  if (m === 'DELETE' || m === 'PATCH') return route.fulfill(J(200, [{ id: 'x' }]));
  return route.fulfill(J(201, Array.isArray(body) ? body : [body]));
}

const results = []; let n = 0;
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const browser = await chromium.launch({ executablePath: findChrome() });
const SES = JSON.stringify({ access_token: 'x.' + Buffer.from(JSON.stringify({ sub: 'u-me', exp: 4102444800, role: 'authenticated' })).toString('base64url') + '.y', refresh_token: 'r', token_type: 'bearer', expires_in: 99999999, expires_at: 4102444800,
  user: { id: 'u-me', email: 'me@j.example', aud: 'authenticated', app_metadata: {}, user_metadata: {} } });
const ERR_OK = /Failed to load resource|status of 4|ERR_|Service Worker|sw\.js|favicon/i;
async function open(hash, file, { staff = false, editor = false, size = [360, 740], keep = null, theme = null } = {}) {
  DB = mk(); LOG = [];
  if (staff) DB.memberships[0].extra_role = 'headman';
  if (editor) DB.homework_editors = [{ student_id: 's-me' }];
  const ctx = keep || await browser.newContext({ viewport: { width: size[0], height: size[1] }, locale: 'ru-RU', colorScheme: 'dark', serviceWorkers: 'block' });
  if (!keep) { await ctx.route(`${SB}/**`, fake); await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* нет памяти */ } }, [KEY, SES]); }
  if (theme && !keep) await ctx.addInitScript((t) => { try { localStorage.setItem('m_j2_theme', t); } catch (e) { /* нет памяти */ } }, theme);
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !ERR_OK.test(m.text())) errs.push(m.text()); });
  await page.goto(`${BASE}/${file}#${hash}`); await page.waitForSelector('#cabMain .cab-title, #cabMain h1, #cabMain .cab-head', { timeout: 15000 });
  return { ctx, page, errs };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${++n}-${name}.png`), fullPage: true });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const T = (page, sel) => page.locator(sel).first().innerText();
try {
  // ---------- п.8 подгруппа в расписании, не в профиле ----------
  {
    const { page, errs } = await open('/schedule', 'app.html');
    await page.waitForSelector('#sgSeg');
    check('расписание: справа от заголовка переключатель «1 | 2»', (await page.locator('.cab-head #sgSeg button').allInnerTexts()).join('|') === '1|2');
    const box = await page.locator('.cab-head h1').boundingBox(), sb = await page.locator('#sgSeg').boundingBox();
    check('расписание: переключатель справа от надписи, на одной строке', sb.x > box.x + box.width - 1 && Math.abs(sb.y + sb.height / 2 - (box.y + box.height / 2)) < 30, JSON.stringify([box, sb]));
    check('расписание: кнопки не меньше 44 px', (await page.locator('#sgSeg button').first().boundingBox()).height >= 44);
    await page.locator('#sgSeg button[data-sg="2"]').click();
    await page.waitForFunction(() => document.querySelector('#sgSeg button[data-sg="2"]')?.getAttribute('aria-pressed') === 'true');
    check('расписание: выбор подгруппы уходит в базу', LOG.some((x) => x.rpc === 'student_set_subgroup' && x.body.p_subgroup === 2));
    check('расписание: после выбора подгруппы пары 1 подгруппы скрыты', !(await page.locator('.cab-lessons').innerText()).includes('Петров'));
    await shot(page, 'schedule-sg');
    check('расписание 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('расписание: ошибок страницы нет', !errs.length, errs.join('\n'));
    await page.goto(`${BASE}/app.html#/profile`); await page.waitForSelector('.pf-card');
    check('профиль: переключателя подгруппы нет', await page.locator('#sgSeg').count() === 0 && !/Подгруппа/.test(await page.locator('#cabMain').innerText()));
  }
  // ---------- п.9 преподаватели: множественное число ----------
  {
    const { page } = await open('/study/teachers', 'app.html');
    await page.locator('.tc-head').first().click();
    const txt = (await page.locator('.tc-body').first().innerText()).replace(/\s+/g, ' ');
    check('преподаватели: «Лекции», «ПЗ», «Лабораторные работы» во множественном числе', /Лекции:/.test(txt) && /ПЗ:/.test(txt) && /Лабораторные работы:/.test(txt) && !/Лекция:|Лабораторная работа:/.test(txt), txt);
  }
  // ---------- п.10 пропуски: по порядку дат ----------
  {
    DB = mk();
    const { page } = await open('/profile/absences', 'app.html');
    const days = await page.locator('.ab-day').evaluateAll((els) => els.map((e) => [e.querySelector('.ab-dh').innerText.replace(/\s+/g, ' '), e.className]));   // блоки по дням (2.1.1); подробно — v211-mock.mjs
    check('пропуски: блоки по дням, новые сверху (6, 4, 2 ноября)', days.map((d) => d[0].split(' ')[0]).join(',') === '6,4,2', JSON.stringify(days));
    check('пропуски: в заголовке блока дата и часы за день', days.every(([t]) => /\d+ .* \d+(,\d)? (час|часа|часов)/.test(t)), JSON.stringify(days));
    await shot(page, 'absences');
    check('пропуски 360 px: без горизонтальной прокрутки', await noOverflow(page));
  }
  // ---------- п.7 напоминания ----------
  {
    const { page, errs } = await open('/profile/reminders', 'app.html');
    const txt = (await page.locator('#cabMain').innerText()).replace(/s+/g, ' ');
    check('напоминания: за 1 день до срока в 09:00 по Минску для домашек, дедлайнов, УСР, зачётов и экзаменов', /За 1 день до срока, один раз, в 09:00 по Минску/.test(txt) && /Домашки, дедлайны, УСР, зачёты и экзамены/.test(txt), txt);
    check('напоминания: справки, расписание, оценки, пропуски, порог деканата', /Срок сдачи справки/.test(txt) && /Изменения расписания/.test(txt) && /Новая оценка/.test(txt) && /Внесённый пропуск/.test(txt) && /Порог деканата/.test(txt), txt);
    check('напоминания: у студента нет строки про семестр', !/закрытие семестра/.test(txt));
    check('напоминания: 7 переключателей, все включены', await page.locator('button.tg-sw[aria-checked="true"]').count() === 7, String(await page.locator('button.tg-sw').count()));
    await page.locator('button.tg-sw[data-k="grade"]').click();
    await page.waitForFunction(() => document.querySelector('button.tg-sw[data-k="grade"]')?.getAttribute('aria-checked') === 'false');
    check('напоминания: переключатель пишет настройку в базу', LOG.some((x) => x.table === 'notification_prefs' && x.body && x.body.kind === 'grade' && x.body.enabled === false), JSON.stringify(LOG));
    await shot(page, 'reminders');
    check('напоминания 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('напоминания: ошибок страницы нет', !errs.length, errs.join(' | '));
    const h2 = await open('/home', 'app.html', { staff: true }); await h2.page.goto(BASE + '/app.html#/profile/reminders'); await h2.page.waitForSelector('#remTimed');
    check('напоминания: у старосты есть строка про закрытие семестра', /закрытие семестра/.test(await h2.page.locator('#cabMain').innerText()));
    const p3 = await open('/profile', 'app.html'); await p3.page.waitForSelector('#remAll');
    check('профиль: в карточке напоминаний время и ссылка на подробности', /09:00 по Минску/.test(await p3.page.locator('#remSw').innerText()) && await p3.page.locator('#remAll').getAttribute('href') === '#/profile/reminders');
  }
  // ---------- п.5 экзамены и консультации в расписании ----------
  {
    const { page, errs } = await open('/schedule', 'app.html');
    await page.locator('#day-2026-11-14').click();
    const sat = (await page.locator('.cab-lessons').innerText()).replace(/s+/g, ' ');
    check('расписание: консультация подписана «Консультация» и с аудиторией', /Консультация/.test(sat) && /ауд\. 3\/230/.test(sat), sat);
    check('расписание: у консультации свой цвет и значок', await page.locator('.cab-lesson.kd-ev-consultation .ev-ico').count() === 1);
    await page.locator('button[aria-label="Следующая неделя"]').click();
    await page.waitForFunction(() => document.querySelector('#day-2026-11-16'));
    await page.locator('#day-2026-11-16').click();
    const mon = (await page.locator('.cab-lessons').innerText()).replace(/s+/g, ' ');
    check('расписание: три пары экзамена подписаны «Экзамен», аудитория показана', (mon.match(/Экзамен/g) || []).length === 3 && /ауд\. 3\/230/.test(mon) && /аудитория не указана/.test(mon), mon);
    check('расписание: у экзамена свой цвет и значок', await page.locator('.cab-lesson.kd-ev-exam .ev-ico').count() === 3);
    await shot(page, 'schedule-exam');
    check('расписание (экзамен) 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('расписание (экзамен): ошибок страницы нет', !errs.length, errs.join(' | '));
  }
  // ---------- п.11 экзамены из расписания во вкладке «Зачёты и экзамены» ----------
  {
    const { page, errs } = await open('/study/exams', 'app.html');
    const t = (await page.locator('#cabMain').innerText()).replace(/s+/g, ' ');
    check('вкладка: экзамен Логистика (внесён старостой) дополнен временем, аудиторией и преподавателем из расписания', /Логистика/.test(t) && /09:00–12:30|0?9:00–1d:dd/.test(t) && /3\/230/.test(t) && /Иванов И\.И\./.test(t), t);
    check('вкладка: экзамен из расписания, которого нет у старосты (Эконометрика, 20 декабря), добавлен', /Эконометрика/.test(t) && /3\/233/.test(t) && /Миксюк/.test(t), t);
    check('вкладка: консультаций и зачёта из расписания нет', !/Консультац/.test(t), t);
    check('вкладка: экзамен Логистика показан один раз (без дубля)', (t.match(/Логистика/g) || []).length === 1, t);
    check('вкладка: зачёт, внесённый старостой, остался', /Зачёт/.test(t) && /Эконометрика/.test(t), t);
    await shot(page, 'exams-tab');
    check('вкладка 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('вкладка: ошибок страницы нет', !errs.length, errs.join(' | '));
  }
  // ---------- п.2 журнал действий ----------
  {
    const { page } = await open('/home', 'app.html');
    await page.waitForFunction(() => window.J2Act && J2Act.flush);
    await page.waitForTimeout(400);
    await page.goto(BASE + '/app.html#/study'); await page.waitForSelector('.cab-title');
    await page.locator('a[href="#/profile"]').first().click(); await page.waitForSelector('.pf-card');
    await page.locator('#thSeg button[data-th="light"]').click();
    await page.goto(BASE + '/app.html#/chat/abc'); await page.waitForTimeout(300);
    await page.evaluate(() => J2Act.flush()); await page.waitForTimeout(600);
    const sent = LOG.filter((x) => x.rpc === 'usage_log_batch').flatMap((x) => x.body.p_events);
    check('лог: вход и открытые экраны уходят пачкой в usage_log_batch', sent.some((e) => e.k === 'login') && sent.some((e) => e.k === 'screen' && /study/.test(e.n)), JSON.stringify(sent).slice(0, 300));
    check('лог: нажатая кнопка записана по подписи', sent.some((e) => e.k === 'action' && /Светлая/.test(e.n)), JSON.stringify(sent.map((e) => e.n)));
    check('лог: экраны чата и их кнопки не пишутся', !sent.some((e) => /chat/.test(e.n)));
    check('лог: у события есть устройство и id устройства, нет паролей и адресных параметров', sent.every((e) => e.d && e.di && !/пароль|password|token|[?]/.test(e.n)));
    check('лог: событий не больше 50 за вызов', LOG.filter((x) => x.rpc === 'usage_log_batch').every((x) => x.body.p_events.length <= 50));
  }
  // ---------- п.2 лента активности в утилите сисадмина ----------
  {
    const { ctx, page, errs } = await open('/home', 'app.html');
    await page.goto(BASE + '/sysadmin.html'); await page.waitForSelector('#nav button[data-tab="logs"]', { timeout: 15000 });
    await page.locator('#nav button[data-tab="logs"]').click();
    await page.locator('button[data-log="usage"]').click();
    await page.waitForSelector('#ufUser'); await page.waitForSelector('li.sa-log');
    const t = (await page.locator('#view').innerText()).replace(/s+/g, ' ');
    check('активность: лента — кто, что сделал, устройство, новое устройство помечено', /Андреев Антон [(]студент[)]/.test(t) && /Вход/.test(t) && /Нажал: Добавить домашку/.test(t) && /новое устройство/.test(t) && /Android · Chrome/.test(t), t.slice(0, 300));
    check('активность: фильтры — человек, роль, что произошло, даты, поиск', await page.locator('#ufUser, #ufRole, #ufKind, #ufFrom, #ufTo, #ufQ').count() === 6);
    await page.locator('#ufKind').selectOption('action');
    await page.waitForTimeout(400);
    check('активность: фильтр по типу уходит в запрос', LOG.some((x) => x.rpc === 'sysadmin_usage_log' && x.body.p_kind === 'action'));
    await page.locator('#ufQ').fill('домашку'); await page.locator('#ufQ').dispatchEvent('change'); await page.waitForTimeout(400);
    check('активность: поиск уходит в запрос', LOG.some((x) => x.rpc === 'sysadmin_usage_log' && x.body.p_q === 'домашку'));
    check('активность: 5 переключателей уведомлений в Telegram, дайджест выключен', await page.locator('button[data-pref]').count() === 5 && await page.locator('button[data-pref="digest"]').getAttribute('aria-checked') === 'false');
    await page.locator('button[data-pref="digest"]').click(); await page.waitForTimeout(400);
    check('активность: переключатель пишет настройку в базу', LOG.some((x) => x.rpc === 'sysadmin_prefs_set' && x.body.p_key === 'digest' && x.body.p_on === true));
    await shot(page, 'sysadmin-usage');
    check('активность 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('активность: ошибок страницы нет', !errs.length, errs.join(' | '));
    await ctx.close();
  }
} catch (e) { console.error(e); results.push(false); }
await browser.close();
const bad = results.filter((x) => !x).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}. Снимки: ${OUT}`);
process.exit(bad ? 1 : 0);
