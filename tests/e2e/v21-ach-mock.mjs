// Достижения в кабинете (п.4): плитка в профиле, экран, шторка значка, выдача клиентских значков, обе темы, без сети: Supabase подменён заглушкой.
// Запуск: node tests/e2e/v21-ach-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs).
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску: «актуально на» = 8 ноября
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
const st = (id, last, first) => ({ id, last_name: last, first_name: first, subgroup: 1, claim_status: 'active', study_form: 'budget' });
const abs = (id, sid, date, hours, ex) => ({ id, student_id: sid, group_id: G, date, subject: 'Логистика', hours, is_excused: ex, lesson_kind: 'lecture', created_by: null, comment: null, cert_type: null, cert_submitted: false, cert_due_date: null });
const day = (d) => ({ day: d, semester: 'fall-2026', group_id: G });
const sa = (code, period, at) => ({ student_id: 's-me', group_id: G, code, period: period || '', semester: 'fall-2026', earned_at: at || '2026-11-03T10:00:00Z' });
const ev = (kind, ref) => ({ user_id: 'u-me', student_id: 's-me', group_id: G, kind, ref: ref || '' });
// Учебные дни: 26–30 окт, 2–6 и 9–13 ноя. «Актуально на» 8 ноября: пройдено 10. Неуважительные у s-me: 2 и 4 ноября (3 ч); 6 ноября — уважительный
const DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
const mk = () => ({
  memberships: [{ user_id: 'u-me', group_id: G, student_id: 's-me', base_role: 'student', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }],
  groups: [{ id: G, name: '24ДММ-2', status: 'active', warn_hours: 8, dean_hours: 12 }],
  students: [st('s-me', 'Тестов', 'Тест'), st('s-a', 'Андреев', 'Антон')],
  schedule_lessons: [], tasks: [], homework_editors: [], absence_cancellations: [], notifications: [], certificates: [],
  schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
  absences: [abs('ab-m1', 's-me', '2026-11-02', 2, false), abs('ab-m2', 's-me', '2026-11-06', 2, true), abs('ab-m3', 's-me', '2026-11-04', 1, false), abs('ab-a', 's-a', '2026-11-03', 4, false)],
  study_days: DAYS.map(day),
  // сервер уже выдал: серии 3 и 5, игру, антидостижение за ноябрь; клиентом выдан welcome
  student_achievements: [sa('streak_3', '', '2026-10-28T10:00:00Z'), sa('streak_5', '', '2026-10-30T10:00:00Z'), sa('game_player', '', '2026-11-01T10:00:00Z'), sa('anti_m2', '2026-11', '2026-11-04T10:00:00Z'), sa('welcome', '', '2026-11-02T10:00:00Z')],
  // события: вход, аватарка, «Что нового» прочитано, три домашки → клиент должен выдать tech, hw_1, hw_3
  app_events: [ev('first_login'), ev('avatar_set'), ev('whats_new_read', '2.1'), ev('homework_done', 'h1'), ev('homework_done', 'h2'), ev('homework_done', 'h3')],
  rpc: { absence_hours_my: { total: 3, excused: 2, unexcused: 3, warn_hours: 8, dean_hours: 12 }, is_sysadmin: false },
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
  for (const [k, v] of u.searchParams) if (/^eq./.test(v) && rows.length && k in rows[0]) rows = rows.filter((r) => String(r[k]) === v.slice(3));
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
const ERR_OK = /Failed to load resource|status of 4|status of 5|ERR_|Service Worker|sw\.js|favicon/i;
async function open(hash, { size = [360, 740], theme = null, mut = null, wait = '.ac-grid' } = {}) {
  DB = mk(); LOG = []; if (mut) mut(DB);
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, locale: 'ru-RU', colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.route(`${SB}/**`, fake); await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* нет памяти */ } }, [KEY, SES]);
  if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem('m_j2_theme', t); } catch (e) { /* нет памяти */ } }, theme);
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !ERR_OK.test(m.text())) errs.push(m.text()); });
  await page.goto(`${BASE}/app.html#${hash}`); await page.waitForSelector(wait, { timeout: 15000 });
  return { ctx, page, errs };
}
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const shot = (page, name) => page.screenshot({ path: join(OUT, `${++n}-ach-${name}.png`), fullPage: true });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const T = (page, sel) => page.locator(sel).first().innerText();
const posts = (table) => LOG.filter((l) => l.m === 'POST' && l.table === table);
// Контраст текста с учётом полупрозрачной подложки: цвет, подложка, фон страницы → отношение яркостей (WCAG)
const contrast = (page, textSel, boxSel) => page.evaluate(([ts, bs]) => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const pg = parse(getComputedStyle(document.body).backgroundColor), box = over(parse(getComputedStyle(document.querySelector(bs)).backgroundColor), pg);
  const fg = over(parse(getComputedStyle(document.querySelector(ts)).color), box), a = lum(fg), b = lum(box);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}, [textSel, boxSel]);
try {
  // ---------- профиль: плитка со счётчиком ----------
  {
    const { page, errs, ctx } = await open('/profile', { wait: '#achTile' });
    check('профиль: плитка «Достижения» — ссылка на экран, не заглушка', await page.locator('#achRow').getAttribute('href') === '#/profile/achievements' && await page.locator('#achSoon').count() === 0);
    check('профиль: счётчик «N из M» (4 из 39: серии 3 и 5, игра, welcome; антидостижение не в счёте)', await until(async () => (await T(page, '#achTile')) === '4 из 39'), await T(page, '#achTile'));
    check('профиль: ошибок страницы нет', !errs.length, errs.join('\n'));
    await ctx.close();
  }
  // ---------- экран: сводка, сетка, выдача ----------
  {
    const { page, errs, ctx } = await open('/profile/achievements');
    check('экран: стрелка «Назад» в профиль', await page.locator('.j2-back').first().getAttribute('href') === '#/profile');
    check('экран: пять категорий', (await page.locator('.cab-h2 > span:first-child').allInnerTexts()).join('|') === 'Посещаемость|Приложение|Домашка|Игры|Антидостижения');
    check('экран: на каждый значок каталога — своя ячейка (49)', await page.locator('.ac-cell').count() === 49);
    check('экран: значки нарисованы из спрайта (use → symbol найден)', await page.evaluate(() => { const u = document.querySelector('.ac-cell use'); return !!u && !!document.querySelector(u.getAttribute('href')) && u.getBoundingClientRect().width > 20; }));
    check('выдача: клиент записал tech, hw_1, hw_3 одним запросом', await until(async () => posts('student_achievements').length === 1));
    const body = posts('student_achievements')[0]?.body || [];
    check('выдача: ровно tech, hw_1, hw_3 (серии, антидостижения и игры клиент не пишет)', body.map((r) => r.code).sort().join() === 'hw_1,hw_3,tech', body.map((r) => r.code).join());
    check('выдача: group_id, student_id, period, semester в каждой строке', body.length > 0 && body.every((r) => r.group_id === G && r.student_id === 's-me' && r.period === '' && r.semester === 'fall-2026'));
    check('всплывашка о новых значках', /Новые достижения: «Дотошный технарь» и ещё 2/.test(await T(page, '#cabToast')), await T(page, '#cabToast'));
    check('сводка: 7 из 39 (4 было + 3 выдано)', (await T(page, '.ac-big b')) === '7' && /из 39/.test(await T(page, '.ac-big span')));
    check('сводка: есть «Последнее» и «Ближайшее»', /Последнее/.test(await T(page, '.ac-sum')) && /Ближайшее/.test(await T(page, '.ac-sum')));
    const on = await page.locator('.ac-cell:not(.off)').count(), locked = await page.locator('.ac-cell svg.ach-icon.is-locked').count();
    check('получено 8 (7 + антидостижение), закрыто 41', on === 8 && locked === 41, `${on}/${locked}`);
    const cnt = (await page.locator('.ac-cnt').allInnerTexts()).join('|');
    check('счётчики категорий: 2 из 9 (справки не считаются), 2 из 5 (welcome, tech), 2 из 5, 1 из 20', cnt === '2 из 9|2 из 5|2 из 5|1 из 20', cnt);
    await shot(page, 'screen-dark');
    check('экран 360 px: без горизонтальной прокрутки', await noOverflow(page));
    const sizes = await page.locator('.ac-cell, .j2-back').evaluateAll((a) => a.filter((x) => { const r = x.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).length);
    check('экран: ячейки и «Назад» не меньше 44 px', sizes === 0);
    // ---------- шторка значка ----------
    await page.locator('.ac-cell[data-c="streak_10"]').click();
    await page.waitForSelector('.cab-sheet');
    const sh = await T(page, '.cab-sheet');
    check('шторка закрытого: «На волне · 10», условие, «Серия 2 из 10 дней» (серию прервал неуважительный 4 ноября, 6-е — уважительный)', /На волне · 10/.test(sh) && /10 учебных дней подряд/.test(sh) && /Ещё не получено/.test(sh) && /Серия 2 из 10 дней/.test(sh), sh);
    check('шторка: шкала прогресса', await page.locator('.cab-sheet .ac-bar').count() === 1);
    const cb = await page.locator('.cab-sheet button').last().boundingBox();
    check('шторка: кнопка «Закрыть» не меньше 44 px', cb.height >= 44);
    await shot(page, 'sheet-locked-dark');
    await page.keyboard.press('Escape');
    check('шторка закрывается по Esc', await page.locator('.cab-sheet').count() === 0);
    await page.locator('.ac-cell[data-c="streak_3"]').click();
    const sh2 = await T(page, '.cab-sheet');
    check('шторка полученного: «Получено 28 октября», шкалы нет', /Получено 28 октября/.test(sh2) && await page.locator('.cab-sheet .ac-bar').count() === 0, sh2);
    await page.keyboard.press('Escape');
    await page.locator('.ac-cell[data-c="anti_m2"]').click();
    const sh3 = await T(page, '.cab-sheet');
    check('шторка антидостижения: «Получено: ноябрь» и часы месяца (3 ч)', /Получено: ноябрь/.test(sh3) && /3 ч неуважительных в этом месяце/.test(sh3), sh3);
    await page.keyboard.press('Escape');
    await page.locator('.ac-cell[data-c="cert_1"]').click();
    check('шторка справки: «Скоро», пока не выдаётся', /Скоро/.test(await T(page, '.cab-sheet')) && /Пока не выдаётся/.test(await T(page, '.cab-sheet')));
    await page.keyboard.press('Escape');
    await page.locator('.ac-cell[data-c="first_steps"]').click();
    check('шторка «Первые шаги»: чек-лист (аватарка есть, студак нет)', (await page.locator('.cab-sheet .ac-check li.done').count()) === 1 && (await page.locator('.cab-sheet .ac-check li').count()) === 2);
    await page.keyboard.press('Escape');
    await page.locator('.ac-cell[data-c="game_snake_30"]').click();
    check('шторка игры: условие без цифр прогресса (значок выдаёт сервер)', /Змейка длиной 30/.test(await T(page, '.cab-sheet')) && await page.locator('.cab-sheet .ac-bar').count() === 0);
    await page.keyboard.press('Escape');
    check('экран: ошибок страницы нет', !errs.length, errs.join('\n'));
    await ctx.close();
  }
  // ---------- идемпотентность и закрытый журнал ----------
  {
    const { page, ctx } = await open('/profile/achievements', { mut: (d) => { d.student_achievements.push(sa('tech'), sa('hw_1'), sa('hw_3')); } });
    await new Promise((r) => setTimeout(r, 700));
    check('повторный подсчёт ничего не дублирует: всё уже выдано, запроса на запись нет', posts('student_achievements').length === 0);
    check('значки не выданы заново: тоже 7 из 39', (await T(page, '.ac-big b')) === '7');
    await ctx.close();
  }
  {
    const { page, ctx } = await open('/profile/achievements', { mut: (d) => { d.groups[0].status = 'archived'; } });
    await new Promise((r) => setTimeout(r, 700));
    check('закрытый журнал: выдача молча пропускается, экран работает', posts('student_achievements').length === 0 && await page.locator('.ac-cell').count() === 49 && (await T(page, '.ac-big b')) === '4');
    await ctx.close();
  }
  // ---------- посещаемость не загрузилась: экран живёт ----------
  {
    const { page, errs, ctx } = await open('/profile/achievements', { mut: (d) => { d.fail = ['absences']; } });
    await page.locator('.ac-cell[data-c="streak_10"]').click();
    check('сбой absences: экран открыт, в шторке — «Данные посещаемости не загрузились»', /Данные посещаемости не загрузились/.test(await T(page, '.cab-sheet')));
    check('сбой absences: ошибок страницы нет', !errs.length, errs.join('\n'));
    await ctx.close();
  }
  {
    const { page, ctx } = await open('/profile/achievements', { mut: (d) => { d.fail = ['student_achievements']; }, wait: '.cab-note' });
    check('сбой student_achievements: понятное сообщение вместо пустой страницы', /не загрузились/.test(await T(page, '.cab-note')));
    await ctx.close();
  }
  // ---------- нет учебных дней у группы: берутся даты занятий ----------
  {
    const { page, ctx } = await open('/profile/achievements', { mut: (d) => { d.study_days = []; d.schedule_lessons = ['2026-11-03', '2026-11-04', '2026-11-05'].map((x) => ({ lesson_date: x, group_id: G })); } });
    await page.locator('.ac-cell[data-c="streak_10"]').click();
    check('без study_days: серия считается по датам занятий (05.11 — 1 день после пропуска 04.11)', /Серия 1 из 10 дней/.test(await T(page, '.cab-sheet')), await T(page, '.cab-sheet'));
    await ctx.close();
  }
  // ---------- выдача после старта, не заходя в раздел ----------
  {
    const { page, ctx } = await open('/profile', { wait: '#achTile' });
    check('после старта (через ~3 с) значки выдаются без захода в раздел', await until(async () => posts('student_achievements').length === 1, 7000));
    check('и показывается всплывашка', await until(async () => /Новые достижения/.test(await T(page, '#cabToast')), 3000));
    await ctx.close();
  }
  // ---------- событие «Всегда в курсе» ----------
  {
    const { page, ctx } = await open('/profile', { wait: '#remSw' });
    await page.locator('#remSw').click(); await until(async () => !(await page.locator('#remSw').evaluate((b) => b.dataset.busy)), 3000);
    await page.locator('#remSw').click();
    check('включение напоминаний пишет событие notifications_on в app_events', await until(async () => posts('app_events').some((l) => l.body && l.body.kind === 'notifications_on'), 4000));
    await ctx.close();
  }
  // ---------- тёмная и светлая тема ----------
  for (const theme of ['dark', 'light']) {
    const { page, errs, ctx } = await open('/profile/achievements', { theme });
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const glyph = await page.evaluate(() => getComputedStyle(document.querySelector('.ac-cell:not(.off) svg.ach-icon')).getPropertyValue('--ach-glyph').trim().toLowerCase());
    check(`${theme}: токены значков берутся из темы (--ach-glyph = ${theme === 'light' ? '#4a6b00' : 'акцент'})`, theme === 'light' ? glyph === '#4a6b00' : glyph === '#c6f432', glyph);
    check(`${theme}: фон страницы ${theme === 'light' ? 'светлый' : 'тёмный'}`, (theme === 'light') === (bg.match(/\d+/g).slice(0, 3).reduce((s, v) => s + Number(v), 0) > 450), bg);
    const c1 = await contrast(page, '.ac-cell:not(.off) .ac-name', '.ac-cell:not(.off)'), c2 = await contrast(page, '.ac-cell.off .ac-name', '.ac-cell.off'), c3 = await contrast(page, '.ac-line small', '.ac-sum');
    check(`${theme}: контраст подписей ≥ 4.5 (получено ${c1.toFixed(1)}, закрыто ${c2.toFixed(1)}, сводка ${c3.toFixed(1)})`, c1 >= 4.5 && c2 >= 4.5 && c3 >= 4.5);
    const ico = await page.evaluate(() => getComputedStyle(document.querySelector('.ac-cell.off svg.ach-icon')).getPropertyValue('--ach-glyph').trim());
    check(`${theme}: закрытый значок — серый силуэт (is-locked)`, ico.toLowerCase() === (theme === 'light' ? '#9aa0aa' : '#6b7280'), ico);
    await shot(page, 'screen-' + theme);
    await page.locator('.ac-cell[data-c="streak_10"]').click();
    const c4 = await contrast(page, '.cab-sheet .ac-sh p', '.cab-sheet');
    check(`${theme}: контраст текста шторки ≥ 4.5 (${c4.toFixed(1)})`, c4 >= 4.5);
    await shot(page, 'sheet-' + theme);
    check(`${theme}: ошибок страницы нет`, !errs.length, errs.join('\n'));
    await ctx.close();
  }
  // ---------- вне токенов жёстких цветов нет ----------
  {
    const bad = [], hard = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/;
    for (const f of ['app-ach.js', 'ach-calc.js', 'app-ach.css']) {
      readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (!/^\s*(\/\/|\*|\/\*)/.test(l) && hard.test(l)) bad.push(f + ':' + (i + 1)); });
    }
    check('достижения: жёстких цветов вне токенов нет', !bad.length, bad.join(', '));
  }
} catch (e) { console.error(e); results.push(false); }
await browser.close(); server.close();
const failed = results.filter((x) => !x).length;
console.log(failed ? '\nПРОВАЛОВ: ' + failed : '\nВсё прошло: ' + results.length + ' проверок. Снимки: ' + OUT);
process.exit(failed ? 1 : 0);
