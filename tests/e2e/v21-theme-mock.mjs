// Светлая и тёмная темы 2.1: снимки и автоматическая проверка контраста текста на всех экранах кабинета (заглушка Supabase, без сети).
// Запуск: node tests/e2e/v21-theme-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs). Снимки — SHOTS_DIR или %TEMP%21-shots.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-09';
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'v21-theme-shots'));
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
async function open(hash, file, { staff = false, editor = false, size = [360, 740], keep = null, theme = null } = {}) {
  DB = mk(); LOG = [];
  if (staff) DB.memberships[0].extra_role = 'headman';
  if (editor) DB.homework_editors = [{ student_id: 's-me' }];
  const ctx = keep || await browser.newContext({ viewport: { width: size[0], height: size[1] }, locale: 'ru-RU', serviceWorkers: 'block' });
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

// Проверка контраста: для каждого видимого текстового элемента считаем цвет текста и фон (с учётом прозрачности предков), порог WCAG AA: 4,5 (крупный текст 3)
const audit = (page) => page.evaluate(() => {
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const blend = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); return a ? [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a) : [0, 0, 0, 0]; };
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let out = [0, 0, 0, 0]; for (let i = chain.length - 1; i >= 0; i--) out = blend(chain[i], out); return out[3] < 1 ? blend(out, parse(getComputedStyle(document.documentElement).backgroundColor).concat ? parse(getComputedStyle(document.documentElement).backgroundColor) : [255, 255, 255, 1]) : out; };
  const bad = [], seen = new Set();
  const walker = document.createTreeWalker(document.getElementById('cab') || document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim(); if (!text) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    if (el.closest('.cab-tab[aria-current], .cab-tab.on, .cab-tabbar .on, .boot, [hidden], [aria-hidden="true"], .sr-only, .boot-sr, option, script, style')) continue;
    let fg = parse(cs.color); const bg = bgOf(el); fg = blend(fg, bg);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700, large = size >= 24 || (size >= 18.66 && bold);
    const ratio = cr(fg, bg), need = large ? 3 : 4.5;
    // у выключенных элементов и «прошедших» занятий нет требования (WCAG: неактивные компоненты исключены); сами «прошла» затемнены opacity — их тоже проверяем по факту
    if (ratio < need && !el.closest('[disabled], [aria-disabled="true"]')) bad.push(`${(el.className && String(el.className).slice(0, 30)) || el.tagName} «${text.slice(0, 24)}» ${ratio.toFixed(2)}<${need}`);
  }
  return bad;
});

const SCREENS = [
  ['home', '/home', 'app.html', {}], ['schedule', '/schedule', 'app.html', {}], ['study', '/study', 'app.html', {}], ['profile', '/profile', 'app.html', {}],
  ['absences', '/profile/absences', 'app.html', {}], ['reminders', '/profile/reminders', 'app.html', {}], ['exams', '/study/exams', 'app.html', {}], ['homework', '/study/homework', 'app.html', {}],
  ['teachers', '/study/teachers', 'app.html', {}], ['grades', '/study/grades', 'app.html', {}], ['telegram', '/profile/telegram', 'app.html', {}], ['account', '/profile/account', 'app.html', {}],
  ['games', '/study/games', 'app.html', {}], ['h-summary', '/summary', 'headman.html', { staff: true }], ['h-students', '/students', 'headman.html', { staff: true }],
  ['h-access', '/access', 'headman.html', { staff: true }], ['h-tasks', '/tasks', 'headman.html', { staff: true }],
];
const only = process.env.SCREENS ? process.env.SCREENS.split(',') : null;
const failures = {};
try {
  for (const theme of ['dark', 'light']) {
    for (const [name, hash, file, opt] of SCREENS) {
      if (only && !only.includes(name)) continue;
      let page, errs;
      try { ({ page, errs } = await open(hash, file, { ...opt, theme })); } catch (e) { check(`${theme} ${name}: экран открылся`, false, String(e.message).slice(0, 120)); continue; }
      await page.waitForTimeout(500);
      const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      check(`${theme} ${name}: data-theme = ${theme}`, attr === theme, String(attr));
      const bad = await audit(page);
      failures[`${theme}/${name}`] = bad;
      check(`${theme} ${name}: контраст текста не ниже AA`, bad.length === 0, bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ` … всего ${bad.length}` : ''));
      check(`${theme} ${name}: без горизонтальной прокрутки`, await noOverflow(page));
      check(`${theme} ${name}: ошибок страницы нет`, !errs.length, errs.join(' | '));
      await shot(page, `${theme}-${name}`);
      await page.context().close();
    }
  }
} catch (e) { console.error(e); results.push(false); }
await browser.close();
const bad = results.filter((x) => !x).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}. Снимки: ${OUT}`);
process.exit(bad ? 1 : 0);
