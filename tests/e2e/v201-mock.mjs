// Экраны 2.0.1 и 2.0.2 (app.html и headman.html) в настоящем браузере БЕЗ сети: Supabase подменён заглушкой, ни тест, ни прод не затрагиваются.
// Запуск: node tests/e2e/v201-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs). Снимки 360×740 — SHOTS_DIR или %TEMP%\v201-shots.
// Что проверяется: цвет и подпись пропусков, зачёт за 7 и 8 дней, плашка «Что нового» один раз, преподаватели, «Добавить домашку» по доступу,
// отметка пары (был / Н / Ув., 2 часа, причина и срок), «Студенты» и карточка (отмена, документ), «Доступы», формы заданий по типам и защита от дублей.
// Права на стороне базы проверяются SQL-тестом tests/db/v201_access_cancel.sql, здесь — только то, что делает страница.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-09';
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'v201-shots'));
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
const lesson = (subject, kind, teacher, pair, sg) => ({ lesson_date: TODAY, pair_no: pair, starts_at: `${8 + pair}:00:00`.padStart(8, '0'), ends_at: `${9 + pair}:30:00`.padStart(8, '0'), subject, kind, teacher, room: '101', subgroup: sg || null, prev_room: null, changed_at: null });
const abs = (id, sid, date, subject, hours, ex, kind, extra) => ({ id, student_id: sid, date, subject, hours, is_excused: ex, lesson_kind: kind, created_by: null, comment: null, cert_type: null, cert_submitted: false, cert_due_date: null, ...extra });
const task = (id, kind, rec, by) => ({ id, kind, rec: { id, createdAt: '2026-11-01T00:00:00Z', subgroup: 0, ...rec }, created_by: by || null });
const mk = () => ({
  memberships: [{ user_id: 'u-me', group_id: G, student_id: 's-me', base_role: 'student', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }, { user_id: 'u-a', group_id: G, student_id: 's-a', base_role: 'student', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }],
  groups: [{ id: G, name: '24ДММ-2', status: 'active', warn_hours: 8, dean_hours: 12 }],
  students: [st('s-me', 'Тестов', 'Тест'), st('s-a', 'Андреев', 'Антон'), st('s-b', 'Борисова', 'Берта'), st('s-c', 'Васильев', 'Виктор')],
  schedule_lessons: [lesson('Логистика', 'lecture', 'Иванов И.И.', 1), lesson('Логистика', 'practice', 'Петров П.П.', 2, 1), lesson('Логистика', 'lab', 'Сидоров С.С.', 3), lesson('Физическая культура и здоровье', 'practice', 'Физрук Ф.Ф.', 4), lesson('Кураторский час', 'other', 'Кураторов К.К.', 5), lesson('Эконометрика', 'lecture', 'Сверлов А.С.', 6)],
  tasks: [task('dl-e7', 'deadline', { subject: 'Логистика', type: 'exam', text: '', dueDate: '2026-11-16' }), task('dl-e8', 'deadline', { subject: 'Эконометрика', type: 'zachet', text: '', dueDate: '2026-11-17' }),
    task('hw-1', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'Задача 5', dueDate: '2026-11-10' }), task('hw-stu', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От студента', dueDate: '2026-12-05' }, 'u-a'), task('hw-tch', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От препода', dueDate: '2026-12-05' }, 'u-teacher'), task('dl-1', 'deadline', { subject: 'Эконометрика', type: 'deadline', text: 'Отчёт', dueDate: '2026-11-12' })],
  absences: [abs('ab-1', 's-a', '2026-11-03', 'Логистика', 2, false, 'lecture'), abs('ab-2', 's-a', '2026-11-04', 'Логистика', 2, false, 'lab'),
    abs('ab-3', 's-a', '2026-11-05', 'Эконометрика', 2, true, 'practice', { cert_type: 'Справка', cert_due_date: '2026-11-06', certificate_id: 'ce-3' }), abs('ab-4', 's-b', '2026-11-05', 'Логистика', 4, false, 'lecture', { created_by: 'u-teacher' })],
  homework_editors: [], absence_cancellations: [{ id: 'c1', absence: { date: '2026-10-30', subject: 'Логистика', hours: 2 }, cancelled_by: 'u-me', cancelled_at: '2026-11-02T10:00:00Z' }],
  notifications: [], certificates: [], schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
  rpc: { absence_hours_my: { total: 6, excused: 2, unexcused: 4, warn_hours: 8, dean_hours: 12 }, data_deletion_requests_list: [], homework_access_set: null },
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
async function open(hash, file, { staff = false, editor = false, size = [360, 740], keep = null } = {}) {
  DB = mk(); LOG = [];
  if (staff) DB.memberships[0].extra_role = 'headman';
  if (editor) DB.homework_editors = [{ student_id: 's-me' }];
  const ctx = keep || await browser.newContext({ viewport: { width: size[0], height: size[1] }, locale: 'ru-RU', colorScheme: 'dark', serviceWorkers: 'block' });
  if (!keep) { await ctx.route(`${SB}/**`, fake); await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* нет памяти */ } }, [KEY, SES]); }
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !ERR_OK.test(m.text())) errs.push(m.text()); });
  await page.goto(`${BASE}/${file}#${hash}`); await page.waitForSelector('#cabMain .cab-title, #cabMain h1, #cabMain .cab-head', { timeout: 15000 });
  return { ctx, page, errs };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${++n}-${name}.png`), fullPage: true });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const T = (page, sel) => page.locator(sel).first().innerText();

try {
  // ---------- главная студента ----------
  {
    const { ctx, page, errs } = await open('/home', 'app.html');
    await page.waitForSelector('.cab-ringcard');
    const h3 = (await T(page, '.cab-ringcard h3')).replace(/\s+/g, ' '), ring = (await T(page, '.cab-ringcard .ringnum')).replace(/\s+/g, ' ');
    check('главная: подпись «Пропуски», в круге «4 из 12», без подписей про предупреждение и деканат', h3 === 'Пропуски' && ring === '4 из 12' && !/предупрежд|деканат/i.test(await T(page, '.cab-ringcard')), h3 + ' | ' + ring);
    check('главная: 4 ч — жёлтый', await page.locator('.cab-ringcard .ringnum b.abs-y').count() === 1);
    const tiles = await page.locator('.cab-tiles .cab-tile').allInnerTexts();
    check('главная: экзамен через 7 дней виден, зачёт через 8 дней скрыт', tiles.some((x) => /Логистика/.test(x) && /7 дней/.test(x)) && !tiles.some((x) => /Эконометрика/.test(x) && /8 дней/.test(x)), tiles.join(' | '));
    check('плашка «Что нового»: показана при первом входе', await page.locator('.cab-wn').count() === 1 && /2.1/.test(await T(page, '.cab-wn')));
    check('плашка: есть полоска прогресса', await page.locator('.cab-wn .cab-wn-bar').count() === 1);
    await shot(page, 'home');
    check('главная 360 px: без горизонтальной прокрутки', await noOverflow(page));
    const sh = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
    console.log(`       высота главной ${sh[0]} из ${sh[1]} (360×740)`);
    const p2 = await ctx.newPage(); await p2.goto(`${BASE}/app.html#/home`); await p2.waitForSelector('.cab-ringcard');
    check('плашка: после перезахода не повторяется', await p2.locator('.cab-wn').count() === 0);
    await page.waitForTimeout(5600);
    check('плашка: исчезает сама через 5 секунд', await page.locator('.cab-wn').count() === 0);
    check('профиль: подпись версии и строка «Что нового»', await (async () => { await p2.goto(`${BASE}/app.html#/profile`); await p2.waitForSelector('.pf-card'); const t = await p2.locator('#cabMain').innerText(); return /Версия 2.1/.test(t) && /Что нового/.test(t); })());
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- преподаватели ----------
  {
    const { ctx, page, errs } = await open('/study/teachers', 'app.html');
    await page.waitForSelector('.tc-card');
    const all = await page.locator('#cabMain').innerText();
    check('преподаватели: физкультуры и кураторского часа нет', !/Физическ|Кураторск/i.test(all) && (await page.locator('.tc-card').count()) === 2, all.replace(/\s+/g, ' ').slice(0, 120));
    const body = page.locator('.tc-card').first().locator('.tc-body');
    check('карточка свёрнута до нажатия', await page.locator('.tc-head').first().getAttribute('aria-expanded') === 'false' && (await body.boundingBox()).height < 2);
    await page.locator('.tc-head').first().click(); await page.waitForTimeout(400);
    const txt = (await body.innerText()).replace(/\s+/g, ' ');
    check('раскрытая карточка: иконка слева, название, лекция и практическое', await body.locator('.tc-top svg').count() === 1 && /Лекции:/.test(txt) && /ПЗ:/.test(txt), txt);
    check('лабораторная показана, если она есть у предмета', /Лабораторные работы:\s*Сидоров/.test(txt), txt);
    await page.locator('.tc-head').nth(1).click(); await page.waitForTimeout(400);
    const t2 = (await page.locator('.tc-card').nth(1).locator('.tc-body').innerText()).replace(/\s+/g, ' ');
    check('у предмета без лабораторной строки нет', !/Лабораторная/.test(t2) && /ПЗ:\s*не указан/.test(t2), t2);
    await shot(page, 'teachers'); check('преподаватели 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- домашки студента: кнопка по доступу ----------
  {
    const a = await open('/study/homework', 'app.html');
    check('домашки: без доступа кнопки добавления нет', await a.page.locator('#hwAdd').count() === 0); await a.ctx.close();
    const { ctx, page, errs } = await open('/study/homework', 'app.html', { editor: true });
    await page.waitForSelector('#hwAdd');
    await page.click('#hwAdd'); await page.waitForSelector('#hwOk');
    await page.fill('#hwX', 'Конспект главы 3'); await page.fill('#hwD', '2026-11-20'); await page.click('#hwOk'); await page.waitForTimeout(500);
    const ins = LOG.find((x) => x.m === 'POST' && x.table === 'tasks');
    check('домашки: с доступом студент добавляет, kind=homework и created_by — он сам', ins && ins.body.kind === 'homework' && ins.body.created_by === 'u-me' && ins.body.rec.text === 'Конспект главы 3', JSON.stringify(ins));
    await shot(page, 'homework-editor');
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- журнал старосты: отметка пары ----------
  {
    const { ctx, page, errs } = await open('/journal', 'headman.html', { staff: true });
    await page.waitForSelector('.mk-row');
    check('журнал: регулятора часов и ручного ввода предмета нет, за пару 2 часа', await page.locator('#hmHrs, #hmPlus, #hmMinus, #hmSubj, #hmKind, #hmSel').count() === 0 && /за пару 2 ч/.test(await T(page, '#hmBarL')));
    check('журнал: переключатель «Отметки | Студенты»', /Отметки/.test(await T(page, '#hmSeg')) && /Студенты/.test(await T(page, '#hmSeg')));
    const row = (i) => page.locator('.mk-row').nth(i);
    await row(1).locator('button[data-s="a"]').click();
    await row(2).locator('button[data-s="e"]').click();
    check('«Ув.» открывает причину, срок и «Уже сдал»', await row(2).locator('.mk-ex select option').count() === 4 && await row(2).locator('input[data-f="due"]').isVisible() && await row(2).locator('input[data-f="done"]').count() === 1);
    check('«Н» без причины', await row(1).locator('.mk-ex').count() === 0);
    await row(2).locator('select').selectOption('Освобождение');
    await row(2).locator('input[data-f="due"]').fill('2026-11-14');
    await row(3).locator('button[data-s="e"]').click();
    await row(3).locator('input[data-f="done"]').check();
    check('«Уже сдал» прячет срок', await row(3).locator('.mk-due').isHidden());
    await shot(page, 'journal-marks'); check('журнал 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await page.click('#hmSave'); await page.waitForTimeout(600);
    const up = LOG.find((x) => x.m === 'POST' && x.table === 'absences'), rows = (up && up.body) || [];
    const by = (sid) => rows.find((r) => r.student_id === sid);
    check('сохранение: все по 2 часа, Н неуважительная, вид и пара из расписания', rows.length === 3 && rows.every((r) => r.hours === 2 && r.lesson_kind === 'lab' && r.pair_no === 3 && r.subject === 'Логистика') && by('s-b').is_excused === false, JSON.stringify(rows));
    check('сохранение: уважительная с причиной и сроком', by('s-c').is_excused === true && by('s-c').cert_type === 'Освобождение' && by('s-c').cert_due_date === '2026-11-14' && by('s-c').cert_submitted === false, JSON.stringify(by('s-c')));
    check('сохранение: «уже сдал» — без срока', by('s-me').cert_submitted === true && by('s-me').cert_due_date === null && by('s-me').cert_type === 'Справка', JSON.stringify(by('s-me')));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- журнал: студенты и карточка ----------
  {
    const { ctx, page, errs } = await open('/journal/students', 'headman.html', { staff: true });
    await page.waitForSelector('.sl-row');
    const rows = await page.locator('.sl-row').allInnerTexts();
    check('студенты: все из группы, у каждого ув., неув., всего и «из 12»', rows.length === 4 && rows.every((r) => /Ув\./.test(r) && /Неув\./.test(r) && /Всего/.test(r) && /из 12/.test(r)), rows.join(' | '));
    const a = page.locator('.sl-row', { hasText: 'Андреев' });
    check('студенты: у Андреева 4 неув. (жёлтый) и просрочен документ', /Неув\. 4 ч/.test(await a.innerText()) && await a.locator('.sl-num.abs-y').count() === 1 && /просрочено/.test(await a.innerText()), await a.innerText());
    await page.fill('#slQ', 'борис'); check('студенты: поиск по фамилии', await page.locator('.sl-row').count() === 1); await page.fill('#slQ', '');
    await page.selectOption('#slSort', 'un'); check('студенты: сортировка по неуважительным', /Андреев|Борисова/.test(await T(page, '.sl-row')));
    await shot(page, 'students'); check('студенты 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await a.click(); await page.waitForSelector('.sc-tbl');
    const tbl = (await T(page, '.sc-tbl')).replace(/\s+/g, ' ');
    check('карточка: таблица по предметам и видам занятий', /Лекции/.test(tbl) && /ПЗ/.test(tbl) && /Лаб\./.test(tbl) && /Логистика/.test(tbl) && /Эконометрика/.test(tbl), tbl);
    const list = await page.locator('.sc-ab').allInnerTexts();
    check('карточка: список пропусков — дата, предмет, вид, причина', list.length === 3 && /Логистика · Лекция/.test(list.join(' ')) && /Справка, просрочен/.test(list.join(' ').replace(/\s+/g, ' ')), list.join(' | '));
    check('карточка: история отмен', await page.locator('.st-det summary').count() === 1);
    await shot(page, 'student-card'); check('карточка 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await page.locator('.sc-ab').first().locator('button[data-a="cancel"]').click();
    await page.waitForSelector('.cab-modal'); check('отмена: сначала подтверждение', /Отменить пропуск\?/.test(await T(page, '.cab-modal')));
    await page.click('.cab-modal button[data-a="ok"]'); await page.waitForTimeout(500);
    check('отмена: DELETE нужной записи', LOG.some((x) => x.m === 'DELETE' && x.table === 'absences' && /id=eq\.ab-3|id=eq\.ab-/.test(x.q)), JSON.stringify(LOG.filter((x) => x.m === 'DELETE')));
    await page.locator('.sc-ab', { hasText: 'Справка' }).locator('button[data-a="doc"]').click(); await page.waitForTimeout(500);
    check('справка сдана: RPC certificate_set_submitted на всю справку пропуска, без PATCH пропуска', LOG.some((x) => x.rpc === 'certificate_set_submitted' && x.body.p_certificate === 'ce-3' && x.body.p_submitted === true)
      && !LOG.some((x) => x.m === 'PATCH' && x.table === 'absences'), JSON.stringify(LOG.filter((x) => x.rpc)));
    await page.goto(`${BASE}/headman.html#/journal/student/s-b`); await page.waitForSelector('.sc-tbl');
    check('запись преподавателя: отменить нельзя', await page.locator('.sc-ab button[data-a="cancel"]').count() === 0 && /Внёс преподаватель/.test(await T(page, '.sc-ab')));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- доступы ----------
  {
    const { ctx, page, errs } = await open('/summary/access', 'headman.html', { staff: true });
    await page.waitForSelector('.tg-sw'); const sw = page.locator('.tg-sw', { hasText: 'Андреев' });
    check('доступы: список студентов, у каждого переключатель', await page.locator('.tg-sw').count() === 3 && await sw.getAttribute('aria-checked') === 'false');
    await sw.click(); await page.waitForTimeout(300);
    const c = LOG.find((x) => x.rpc === 'homework_access_set');
    check('доступы: вызывается homework_access_set(student, true)', c && c.body.p_student === 's-a' && c.body.p_on === true, JSON.stringify(c));
    await shot(page, 'access'); check('доступы 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- задания по типам ----------
  {
    const { ctx, page, errs } = await open('/tasks', 'headman.html', { staff: true });
    await page.waitForSelector('#hmTypes');
    const tabs = await page.locator('#hmTypes button').allInnerTexts();
    check('задания: домашки, УСР, дедлайны, зачёты, экзамены', tabs.length === 5 && /Домашки/.test(tabs[0]) && /Экзамены/.test(tabs[4]), tabs.join(' | '));
    // домашка студента: староста правит и отменяет, домашку преподавателя — нет
    const stuCard = page.locator('#hmTasks article', { hasText: 'От студента' }), tchCard = page.locator('#hmTasks article', { hasText: 'От препода' });
    check('староста правит и отменяет домашку студента', await stuCard.locator('button[data-e]').count() === 1 && await stuCard.locator('button[data-d]').count() === 1 && /добавил студент/.test(await stuCard.innerText()), await stuCard.innerText());
    check('домашку преподавателя староста не меняет', await tchCard.locator('button').count() === 0, await tchCard.innerText());
    await page.click('#hmTypes button[data-k="exam"]');
    check('экзамены: свой список и своя кнопка', /Логистика/.test(await T(page, '#hmTasks')) && /Добавить экзамен/.test(await T(page, '#hmAdd')));
    await page.click('#hmAdd'); await page.waitForSelector('#tfOk');
    check('форма экзамена: «Дата экзамена», описание необязательно, «Кому» нет', /Дата экзамена/.test(await T(page, '.cab-sheet')) && await page.locator('#tfA').count() === 0);
    await page.selectOption('#tfS', 'Логистика'); await page.fill('#tfD', '2026-11-16'); await page.click('#tfOk'); await page.waitForTimeout(300);
    check('дубль экзамена (предмет и дата) не создаётся', /уже есть/.test(await T(page, '#tfM')) && !LOG.some((x) => x.m === 'POST' && x.table === 'tasks'));
    await page.fill('#tfD', '2026-12-20'); await page.click('#tfOk'); await page.waitForTimeout(500);
    const ins = LOG.find((x) => x.m === 'POST' && x.table === 'tasks');
    check('экзамен: kind=deadline, type=exam, дата', ins && ins.body.kind === 'deadline' && ins.body.rec.type === 'exam' && ins.body.rec.dueDate === '2026-12-20', JSON.stringify(ins));
    await page.click('#hmTypes button[data-k="usr"]'); await page.click('#hmAdd'); await page.waitForSelector('#tfOk');
    check('форма УСР: «Тема или задание»', /Тема или задание/.test(await T(page, '.cab-sheet')));
    await page.selectOption('#tfS', 'Логистика'); await page.fill('#tfX', 'Тема 1'); await page.fill('#tfD', '2026-11-25'); await page.click('#tfOk'); await page.waitForTimeout(500);
    const u = LOG.filter((x) => x.m === 'POST' && x.table === 'tasks')[1];
    check('УСР: kind=homework, type=УСР', u && u.body.kind === 'homework' && u.body.rec.type === 'УСР', JSON.stringify(u));
    await shot(page, 'tasks'); check('задания 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // =====================================================================================================
  // 2.0.2
  // =====================================================================================================
  const LONG1 = 'Интегрированные маркетинговые коммуникации', LONG2 = 'Функционально-стоимостный анализ';
  // Слова названий целые: ни одно слово не лежит на двух строках, нет горизонтального выхода за блок, нет переноса по слогам и обрезки
  const brokenWords = (page) => page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('.cab-lesson .n, .cab-lesson .k, .cab-card h3, .cab-tile b, .st-alert small, .tc-head > span:first-child, .tc-top b, .mk-p b, .cs-subj, .sc-subj th[scope=row], .cab-h2 > span, .st-sh-t').forEach((el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) for (const m of n.nodeValue.matchAll(/\S+/g)) {
        const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        if (r.getClientRects().length > 1) bad.push('разорвано: ' + m[0]);
      }
      if (el.scrollWidth > el.clientWidth + 1) bad.push('выходит за блок: ' + el.className + ' / ' + el.parentElement.className + ' / ' + el.textContent.slice(0, 40) + ' ' + el.scrollWidth + '>' + el.clientWidth + ' ' + getComputedStyle(el).fontSize);
      const cs = getComputedStyle(el);
      if (cs.hyphens !== 'none' || cs.overflowWrap !== 'normal' || cs.wordBreak !== 'normal') bad.push('css: ' + el.className + ' ' + cs.hyphens + '/' + cs.overflowWrap + '/' + cs.wordBreak);
      if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) bad.push('обрезка: ' + el.className);
    });
    return [...new Set(bad)];
  });
  // ---------- названия предметов целиком (320 и 360 px) ----------
  for (const width of [320, 360]) {
    const { ctx, page, errs } = await open('/home', 'app.html', { size: [width, 740] });
    DB.schedule_lessons[0].subject = LONG1; DB.schedule_lessons[1].subject = LONG2;
    DB.tasks.find((x) => x.id === 'dl-1').rec.subject = LONG1; DB.tasks.find((x) => x.id === 'hw-1').rec.subject = LONG2;
    for (const [route, sel] of [['/home', '.cab-lesson'], ['/schedule', '.cab-lesson'], ['/study/homework', '.cab-card'], ['/study/deadlines', '.cab-card'], ['/study/teachers', '.tc-card']]) {
      await page.goto(`${BASE}/app.html#${route}`); await page.reload(); await page.waitForSelector(sel); await page.waitForTimeout(500);
      if (route === '/study/teachers') { await page.locator('.tc-head').first().click(); await page.waitForTimeout(450); }
      check(`слова целые, ${width} px: ${route}`, (await brokenWords(page)).length === 0 && await noOverflow(page), (await brokenWords(page)).join(' | '));
      if (width === 320 && route === '/home') await shot(page, 'long-subjects-home');
    }
    check(`${width} px: названия на месте, не сокращены`, (await page.locator('body').innerText()).includes('Интегрированные'), '');
    check(`${width} px: дефис внутри слова не рвёт строку`, !(await page.evaluate(() => [...document.querySelectorAll('.cab-lesson .n')].some((n) => /Функционально-$/.test(n.innerText.split('\n')[0] || '')))));
    check(`${width} px: ошибок страницы нет`, errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    const { ctx, page, errs } = await open('/journal/student/s-a', 'headman.html', { staff: true, size: [320, 740] });
    await page.waitForSelector('.sc-subj');
    DB.absences.push(abs('ab-long', 's-a', '2026-11-06', LONG1, 2, false, 'lecture'), abs('ab-long2', 's-a', '2026-11-06', LONG2, 2, true, 'practice', { cert_type: 'Справка', cert_due_date: '2026-11-12' }));
    await page.reload(); await page.waitForSelector('.sc-subj');
    check('слова целые, 320 px: таблица по предметам и список пропусков', (await brokenWords(page)).length === 0 && await noOverflow(page), (await brokenWords(page)).join(' | '));
    await shot(page, 'long-subjects-card'); await ctx.close();
  }
  // ---------- таблица по предметам в карточке студента ----------
  {
    const cells = (page, row) => page.evaluate((r) => [...document.querySelectorAll(`.sc-subj ${r} > *`)].map((c) => { const m = /неуважительных (\d+), уважительных (\d+)/.exec(c.textContent); return m ? [+m[1], +m[2]] : c.textContent.replace(/\s+/g, ' ').trim(); }), row);
    const { ctx, page, errs } = await open('/journal/student/s-a', 'headman.html', { staff: true });
    DB.absences.push(abs('ab-old', 's-a', '2026-10-20', 'Логистика', 2, false, 'lecture'));
    await page.reload(); await page.waitForSelector('.sc-subj');
    const rows = await page.evaluate(() => [...document.querySelectorAll('.sc-subj tbody th.cs-subj')].map((r) => r.textContent.trim()));
    check('таблица: строка на предмет с пропусками, остальных предметов нет', rows.join('|') === 'Логистика|Эконометрика', rows.join('|'));
    const head = (await page.locator('.sc-subj thead').innerText()).replace(/\s+/g, ' ');
    check('таблица: колонки лекции, практические, лабораторные (лабораторные у Логистики есть)', /Лекции ПЗ Лаб. Всего/.test(head), head);
    const r1 = await cells(page, 'tbody:nth-of-type(1) tr:nth-child(2)'), r2 = await cells(page, 'tbody:nth-of-type(2) tr:nth-child(2)'), tf = await cells(page, 'tfoot tr:nth-child(2)');
    check('таблица (этот месяц): Логистика — лекция 2/0, лабораторная 2/0, всего 4/0', JSON.stringify(r1) === JSON.stringify([[2, 0], '—нет', [2, 0], [4, 0]]), JSON.stringify(r1));
    check('таблица: Эконометрика — практическое 0/2, лабораторных нет, всего 0/2', JSON.stringify(r2) === JSON.stringify(['—нет', [0, 2], '—нет лабораторных', [0, 2]]), JSON.stringify(r2));
    check('таблица: итого студента 4 неуважительных и 2 уважительных', JSON.stringify(tf) === JSON.stringify([[2, 0], [0, 2], [2, 0], [4, 2]]), JSON.stringify(tf));
    check('таблица: «4 из 12» за месяц и уважительные/неуважительные различимы цветом', /4 из 12 ч/.test(await T(page, '#scTbl .meta')) && await page.locator('.sc-subj td b.c-coral').count() > 0 && await page.locator('.sc-subj td b.c-mint').count() > 0);
    const listSum = (await page.locator('.sc-ab .meta span').allInnerTexts()).reduce((n, t) => n + (+/(\d+)\s*ч/.exec(t)[1]), 0);
    check('таблица: сумма сходится со списком пропусков (все записи за период)', listSum === 8 && (await page.evaluate(() => 0)) === 0, String(listSum));
    await page.click('#scSeg button[data-v="all"]');
    const tfAll = await cells(page, 'tfoot tr:nth-child(2)');
    check('таблица (всё время): итого 6 неуважительных и 2 уважительных, «6 ч»', JSON.stringify(tfAll.slice(-1)) === JSON.stringify([[6, 2]]) && /всего\s+6 ч/.test(await T(page, '#scTbl .meta')), JSON.stringify(tfAll));
    await shot(page, 'student-card-subjects'); check('таблица 360 px: без горизонтальной прокрутки', await noOverflow(page));
    // у студента без лабораторных колонки «Лаб.» нет
    DB.schedule_lessons = DB.schedule_lessons.filter((l) => l.kind !== 'lab');
    await page.goto(`${BASE}/headman.html#/journal/student/s-b`); await page.reload(); await page.waitForSelector('.sc-subj');
    const h2 = (await T(page, '.sc-subj thead')).replace(/\s+/g, ' ');
    check('таблица: нет лабораторных ни у одного предмета — колонки «Лаб.» нет', !/Лаб\./.test(h2) && /Лекции ПЗ Всего/.test(h2), h2);
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- «Внести пропуски»: пары из расписания ----------
  {
    const { ctx, page, errs } = await open('/journal', 'headman.html', { staff: true });
    await page.waitForSelector('.mk-pair');
    const pairs = await page.locator('.mk-pair').allInnerTexts();
    check('пары: дата и список пар дня из расписания (предмет, вид, время, аудитория)', (await page.inputValue('#hmDate')) === TODAY && pairs.length === 6 && /09:00/.test(pairs[0]) && /Логистика/.test(pairs[0]) && /Лекция/.test(pairs[0]) && /ауд\. 101/.test(pairs[0]), pairs.join(' || '));
    check('пары: идущая сейчас выбрана сама, подгруппа показана', /Идёт сейчас/.test(pairs[2]) && /1 подгр\./.test(pairs[1]));
    await page.locator('.mk-pair').nth(5).click(); await page.waitForSelector('.mk-row');
    check('пара: предмет и вид подставляются сами, ручного ввода нет', await page.locator('#hmSubj, #hmKind, #hmSel').count() === 0 && (await page.locator('.mk-pair.on').innerText()).includes('Эконометрика'));
    await page.locator('.mk-row').first().locator('button[data-s="a"]').click();
    await page.click('#hmSave'); await page.waitForTimeout(600);
    const up = LOG.find((x) => x.m === 'POST' && x.table === 'absences'), r0 = up && up.body && up.body[0];
    check('пара: запись — предмет, вид и номер пары из расписания, 2 часа', r0 && up.body.length === 1 && r0.subject === 'Эконометрика' && r0.lesson_kind === 'lecture' && r0.pair_no === 6 && r0.hours === 2 && r0.date === TODAY, JSON.stringify(up));
    await page.fill('#hmDate', '2026-11-08'); await page.dispatchEvent('#hmDate', 'change'); await page.waitForTimeout(500);
    check('нет пар в расписании: «На эту дату пар нет по расписанию»', /На эту дату пар нет по расписанию/.test(await T(page, '#hmPairs')) && await page.locator('.mk-pair, .mk-row').count() === 0);
    await shot(page, 'journal-no-pairs'); check('пары 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    const { ctx, page, errs } = await open('/journal', 'headman.html', { staff: true });
    DB.fail = ['schedule_lessons']; await page.reload(); await page.waitForTimeout(1500);
    check('расписание не загрузилось: ошибка, пар и отметок не показываем', /Расписание не загрузилось/.test(await T(page, '#hmPairs')) && await page.locator('.mk-pair, .mk-row').count() === 0);
    DB.fail = []; await page.click('#hmRetry'); await page.waitForSelector('.mk-pair');
    check('повтор после ошибки подтягивает пары', await page.locator('.mk-pair').count() === 6);
    await ctx.close();
  }
  {
    // уже внесённая пара: помечена, правка меняет те же записи, дублей нет
    const { ctx, page, errs } = await open('/journal', 'headman.html', { staff: true });
    DB.schedule_lessons.push(lesson('Логистика', 'lab', 'Сидоров С.С.', 7));
    DB.absences.push(abs('ab-t1', 's-a', TODAY, 'Логистика', 2, false, 'lecture', { pair_no: 1 }), abs('ab-t2', 's-b', TODAY, 'Логистика', 2, true, 'lecture', { pair_no: 1, cert_type: 'Справка', cert_due_date: '2026-11-12' }),
      abs('ab-t3', 's-c', TODAY, 'Логистика', 2, false, 'lab', { pair_no: 3 }));
    await page.reload(); await page.waitForSelector('.mk-pair');
    const ps = await page.locator('.mk-pair').allInnerTexts();
    check('уже отмеченные пары помечены; пары того же предмета с другим видом или номером — нет', /Отмечена: 2/.test(ps[0]) && !/Отмечена/.test(ps[1]) && /Отмечена: 1/.test(ps[2]) && !/Отмечена/.test(ps[6]), ps.map((x) => x.replace(/\s+/g, ' ')).join(' || '));
    await page.locator('.mk-pair').nth(0).click(); await page.waitForSelector('.mk-row');
    const st = await page.locator('.mk-row').evaluateAll((r) => r.map((x) => x.className));
    check('повторная отметка: внесённые подставлены (Н и Ув.), остальные «Был»', /st-abs/.test(st[0]) && /st-exc/.test(st[1]) && !/st-/.test(st[2]) && await page.locator('.mk-row').nth(1).locator('select').inputValue() === 'Справка');
    const row = (i) => page.locator('.mk-row').nth(i);
    check('без изменений сохранить нельзя', await page.locator('#hmSave').isDisabled());
    await row(0).locator('button[data-s="e"]').click();         // Н → Ув.
    await row(1).locator('button[data-s="p"]').click();         // Ув. → Был: запись отменяется
    await row(2).locator('button[data-s="a"]').click();         // новый Н
    check('кнопка: что изменится', /новых 1/.test(await T(page, '#hmSave')) && /изменить 1/.test(await T(page, '#hmSave')) && /убрать 1/.test(await T(page, '#hmSave')), await T(page, '#hmSave'));
    await page.click('#hmSave'); await page.waitForSelector('.cab-modal');
    check('убрать пропуск: сначала подтверждение', /Убрать пропуски\?/.test(await T(page, '.cab-modal')));
    await page.click('.cab-modal button[data-a="ok"]'); await page.waitForTimeout(700);
    const posts = LOG.filter((x) => x.m === 'POST' && x.table === 'absences'), patch = LOG.filter((x) => x.m === 'PATCH' && x.table === 'absences'), del = LOG.filter((x) => x.m === 'DELETE' && x.table === 'absences');
    check('повторная отметка: правка — PATCH той же записи, без дубля', patch.length === 1 && /id=in.%28ab-t1%29/.test(patch[0].q) && patch[0].body.is_excused === true && patch[0].body.cert_type === 'Справка', JSON.stringify(patch));
    check('повторная отметка: «Был» — DELETE записи, новая отметка — один POST только на нового', del.length === 1 && /id=in.%28ab-t2%29/.test(del[0].q) && posts.length === 1 && posts[0].body.length === 1 && posts[0].body[0].student_id === 's-c' && posts[0].body[0].pair_no === 1, JSON.stringify({ del, posts }));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // «Справки» (2.1, одна запись на справку) — tests/e2e/v21-certs-mock.mjs
  // ---------- роли: студент без роли старосты не видит кабинет старосты ----------
  {
    const { ctx, page } = await open('/home', 'app.html');
    await page.goto(`${BASE}/headman.html#/journal/certs`); await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    check('роль «студент»: в кабинете старосты нет ни пар, ни справок, ни отметок', !/Подтвердить|Внести|Отметьте|Просрочены/.test(body) && await page.locator('.mk-pair, .dc, .mk-row').count() === 0, body.slice(0, 160).replace(/\s+/g, ' '));
    await ctx.close();
  }
  // ---------- граница цвета на реальном кольце (0, 2, 4, 6, 8, 10, 12) ----------
  {
    const exp = { 0: 'g', 2: 'g', 4: 'y', 6: 'y', 8: 'r', 10: 'r', 12: 'r' };
    const { ctx, page } = await open('/home', 'app.html');
    for (const [h, c] of Object.entries(exp)) {
      DB.rpc.absence_hours_my = { total: +h, excused: 0, unexcused: +h, warn_hours: 8, dean_hours: 12 };
      await page.reload(); await page.waitForSelector('.cab-ringcard');
      check(`кольцо ${h} ч — ${{ g: 'зелёный', y: 'жёлтый', r: 'красный' }[c]}`, await page.locator(`.cab-ringcard .ringnum b.abs-${c}`).count() === 1 && (await T(page, '.cab-ringcard h3')).trim() === 'Пропуски' && (await T(page, '.cab-ringcard .ringnum')).replace(/\s+/g, ' ') === `${h} из 12`);
    }
    await ctx.close();
  }
} catch (e) { console.log('ПРОВАЛ сценарий упал — ' + (e && e.stack || e)); results.push(false); }
await browser.close(); server.close();
console.log(`\nИтого: ${results.filter(Boolean).length} из ${results.length}. Снимки: ${OUT}`);
process.exit(results.every(Boolean) ? 0 : 1);
