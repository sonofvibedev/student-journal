// Игры в кабинете (п.3): раздел, экраны игр, лист рейтинга, обе темы, без сети: Supabase подменён заглушкой.
// Запуск: node tests/e2e/v21-games-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs).
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
const bright = (c) => { const m = c.match(/[\d.]+/g).map(Number); return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };
const onHub = (u) => /#\/study\/games$/.test(u);
try {
  // ---------- список игр ----------
  {
    const { page, errs } = await open('/study/games', 'app.html');
    await page.waitForSelector('#gamesArcade .tile', { timeout: 10000 });
    check('игры: четыре плитки аркады', await page.locator('#gamesArcade .tile').count() === 4);
    check('игры: плитки «Ассоциации» и «Таблица лидеров»', await page.locator('#gamesExtra .tile').count() === 2);
    check('игры: стрелка «Назад» в «Учёбу»', await page.locator('.j2-back').first().getAttribute('href') === '#/study');
    await shot(page, 'games-hub-dark');
    check('игры 360 px: без горизонтальной прокрутки', await noOverflow(page));
    const small = await page.locator('#gamesArcade .tile').evaluateAll((a) => a.filter((x) => x.getBoundingClientRect().height < 44).length);
    check('игры: плитки не ниже 44 px', small === 0);
    await page.locator('#gamesExtra .tile').nth(1).click();
    await page.waitForSelector('#gameRatingSheet.open');
    check('игры: лист рейтинга открывается без Bootstrap', await page.locator('#gameRatingBody').count() === 1);
    await shot(page, 'games-rating');
    await page.locator('.gm-sheet-close').click();
    check('игры: лист рейтинга закрывается', await page.locator('#gameRatingSheet.open').count() === 0);
    check('игры: ошибок страницы нет', !errs.length, errs.join('\n'));
  }
  // ---------- каждая игра открывается, есть «Назад», нет прокрутки ----------
  for (const g of ['sudoku', 'minesweeper', 'flappy', 'snake']) {
    const { page, errs } = await open('/study/games/' + g, 'app.html');
    await page.waitForSelector('.game-screen .game-body > *', { timeout: 10000 });
    check(g + ': поле нарисовано', await page.locator('.game-screen .game-body > *').count() > 0);
    const back = await page.locator('.game-back').boundingBox();
    check(g + ': кнопка «Назад» не меньше 44 px', back.width >= 44 && back.height >= 44);
    await shot(page, g + '-dark');
    check(g + ' 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await page.locator('.game-back').click();
    await page.waitForSelector('#gamesArcade .tile');
    check(g + ': «Назад» ведёт к списку игр', onHub(page.url()));
    check(g + ': полноэкранный режим снят', await page.evaluate(() => !document.body.classList.contains('game-fs')));
    check(g + ': ошибок страницы нет', !errs.length, errs.join('\n'));
  }
  // ---------- «Ассоциации» ----------
  {
    const { page, errs } = await open('/study/games/words', 'app.html');
    await page.waitForSelector('#wordsHost > *', { timeout: 10000 });
    check('ассоциации: экран открылся с «Назад» в игры', await page.locator('.j2-back').first().getAttribute('href') === '#/study/games');
    await shot(page, 'words-dark');
    check('ассоциации: ошибок страницы нет', !errs.length, errs.join('\n'));
  }
  // ---------- светлая тема ----------
  {
    const { page, errs } = await open('/study/games', 'app.html', { theme: 'light' });
    await page.waitForSelector('#gamesArcade .tile');
    await shot(page, 'games-hub-light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const tile = await page.evaluate(() => getComputedStyle(document.querySelector('#gamesArcade .tile .tile-name')).color);
    check('игры, светлая: текст плиток тёмный на светлом фоне', bright(bg) > 180 && bright(tile) < 120, bg + ' / ' + tile);
    for (const g of ['sudoku', 'minesweeper']) {
      await page.goto(BASE + '/app.html#/study/games/' + g); await page.waitForSelector('.game-screen .game-body > *');
      await shot(page, g + '-light');
      const c = await page.evaluate(() => [getComputedStyle(document.querySelector('.game-name')).color, getComputedStyle(document.querySelector('.game-screen')).backgroundColor]);
      check(g + ', светлая: заголовок контрастен фону', Math.abs(bright(c[0]) - bright(c[1])) > 100, c.join(' / '));
    }
    check('игры, светлая: ошибок страницы нет', !errs.length, errs.join('\n'));
  }
  // ---------- вне токенов жёстких цветов нет ----------
  {
    const bad = [], hard = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/;
    for (const f of ['games.js', 'snake.js', 'words.js', 'app-games.js', 'games2.css']) {
      readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (!/^\s*(\/\/|\*|\/\*)/.test(l) && hard.test(l)) bad.push(f + ':' + (i + 1)); });
    }
    readFileSync('games.css', 'utf8').split('\n').forEach((l, i) => { if (i > 40 && hard.test(l)) bad.push('games.css:' + (i + 1)); });
    check('игры: жёстких цветов вне токенов нет', !bad.length, bad.join(', '));
  }
} catch (e) { console.error(e); results.push(false); }
await browser.close(); server.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? '\nПРОВАЛОВ: ' + failed : '\nВсё прошло: ' + results.length + ' проверок. Снимки: ' + OUT);
process.exit(failed ? 1 : 0);
