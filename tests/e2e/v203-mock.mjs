// Журнал 2.0.3 в настоящем браузере БЕЗ сети: Supabase подменён заглушкой, ни тест, ни прод не затрагиваются
// Запуск: node tests/e2e/v203-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs).
// Что проверяется: цветовая гамма (5 акцентов: фон, шторки, нижняя панель, theme-color, после перезагрузки), сокращения предметов и «ПЗ» на экране,
// массовое внесение пропусков старостой (28 студентов; обрыв с повтором; обрыв насовсем → очередь → отправка без дублей; 4 пары пачками по 40).
// Настоящая база не нужна: проверяется то, что делает страница. Права и SQL — tests/db.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-09';
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'v203-shots'));
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
  students: [...Array.from({ length: 24 }, (_, i) => st('s-x' + String(i).padStart(2, '0'), 'Студентов' + (i + 1), 'Имя')), st('s-me', 'Тестов', 'Тест'), st('s-a', 'Андреев', 'Антон'), st('s-b', 'Борисова', 'Берта'), st('s-c', 'Васильев', 'Виктор')],
  schedule_lessons: [lesson('Логистика', 'lecture', 'Иванов И.И.', 1), lesson('Логистика', 'practice', 'Петров П.П.', 2, 1), lesson('Логистика', 'lab', 'Сидоров С.С.', 3), lesson('Физическая культура и здоровье', 'practice', 'Физрук Ф.Ф.', 4), lesson('Кураторский час', 'other', 'Кураторов К.К.', 5), lesson('Эконометрика', 'lecture', 'Сверлов А.С.', 6)],
  tasks: [task('dl-e7', 'deadline', { subject: 'Логистика', type: 'exam', text: '', dueDate: '2026-11-16' }), task('dl-e8', 'deadline', { subject: 'Эконометрика', type: 'zachet', text: '', dueDate: '2026-11-17' }),
    task('hw-1', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'Задача 5', dueDate: '2026-11-10' }), task('hw-stu', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От студента', dueDate: '2026-12-05' }, 'u-a'), task('hw-tch', 'homework', { subject: 'Логистика', type: 'ПЗ', text: 'От препода', dueDate: '2026-12-05' }, 'u-teacher'), task('dl-1', 'deadline', { subject: 'Эконометрика', type: 'deadline', text: 'Отчёт', dueDate: '2026-11-12' })],
  absences: [abs('ab-1', 's-a', '2026-11-03', 'Логистика', 2, false, 'lecture'), abs('ab-2', 's-a', '2026-11-04', 'Логистика', 2, false, 'lab'),
    abs('ab-3', 's-a', '2026-11-05', 'Эконометрика', 2, true, 'practice', { cert_type: 'Справка', cert_due_date: '2026-11-06' }), abs('ab-4', 's-b', '2026-11-05', 'Логистика', 4, false, 'lecture', { created_by: 'u-teacher' })],
  homework_editors: [], absence_cancellations: [{ id: 'c1', absence: { date: '2026-10-30', subject: 'Логистика', hours: 2 }, cancelled_by: 'u-me', cancelled_at: '2026-11-02T10:00:00Z' }],
  notifications: [], certificates: [], schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
  rpc: { absence_hours_my: { total: 6, excused: 2, unexcused: 4, warn_hours: 8, dean_hours: 12 }, data_deletion_requests_list: [], homework_access_set: null },
});
let DB = mk(), LOG = []; const POSTS = [];                  // POSTS: размеры запросов вставки пропусков, в том числе оборванных
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
  if (m === 'POST' && t[1] === 'absences') {                      // вставка пропусков: сохраняем в «базу», DB.drop — сколько запросов оборвать
    const body = req.postDataJSON(); POSTS.push(body.length);
    if (DB.drop > 0) { DB.drop--; return route.abort('connectionreset'); }
    body.forEach((r) => { if (!DB.absences.some((x) => x.id === r.id)) DB.absences.push({ created_by: 'u-me', ...r }); });
    LOG.push({ m, table: 'absences', body, q: u.search });
    return route.fulfill(J(201, body));
  }
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
  DB = mk(); LOG = []; POSTS.length = 0;
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
  const toast = (page) => page.locator('#cabToast').innerText();
  const waitToast = (page, re, ms = 12000) => page.waitForFunction((s) => new RegExp(s).test((document.getElementById('cabToast') || {}).textContent || ''), re.source, { timeout: ms });
  const queueN = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('j2.oq.v1') || '[]').length);
  const fast = (page) => page.evaluate(() => { OQ.DELAYS = [400, 400]; });                    // паузы повторов короче, чтобы тест не ждал
  const rgb = (t) => 'rgb(' + t + ')';

  // ---------- 1. цветовая гамма ----------
  {
    const { ctx, page, errs } = await open('/profile', 'app.html');
    await page.waitForSelector('#stColors');
    const css = (sel, prop) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
    const meta = () => page.evaluate(() => document.querySelector('meta[name="theme-color"]').content);
    const lime = await page.evaluate(() => J2Accent.palette('#C6F432'));
    check('лайм по умолчанию: фон как раньше (#0A0C11), у html и body один', (await css('body', 'backgroundColor')) === 'rgb(10, 12, 17)' && (await css('html', 'backgroundColor')) === 'rgb(10, 12, 17)' && lime.bg === '#0A0C11');
    const ACC = [['#A78BFA', 'Фиолетовый'], ['#FFB347', 'Оранжевый'], ['#78A0FF', 'Синий'], ['#FF8CBE', 'Розовый'], ['#C6F432', 'Лайм']];
    const seen = new Set();
    for (const [c, name] of ACC) {
      await page.locator(`#stColors [data-c="${c}"]`).click();
      const p = await page.evaluate((x) => J2Accent.palette(x), c); seen.add(p.bg);
      const body = await css('body', 'backgroundColor'), html = await css('html', 'backgroundColor'), nav = await css('.cab-tabbar', 'backgroundColor');
      await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="cab-sheet" id="tSheet"></div>'));
      const sheet = await css('#tSheet', 'backgroundColor'); await page.evaluate(() => document.getElementById('tSheet').remove());
      const glow = await css('body', 'backgroundImage');
      check(`${name}: фон body и html, шторка, нижняя панель, theme-color, пятна света`, body === rgb(p.bgRgb) && html === rgb(p.bgRgb) && sheet === rgb(p.sheet.length === 7 ? [1, 3, 5].map((i) => parseInt(p.sheet.slice(i, i + 2), 16)).join(', ') : p.sheet)
        && nav === p.nav.replace(/, \.(\d+)\)/, ', 0.$1)') && (await meta()) === p.bg && glow.includes('rgba(' + p.glow2 + ',') && glow.includes('rgba(' + p.glow1 + ',') && glow.includes('rgba(' + p.glow3 + ','), JSON.stringify({ body, html, sheet, nav, meta: await meta(), glow: glow.slice(0, 120) }));
    }
    check('пять акцентов дают пять разных фонов', seen.size === 5, [...seen].join(' '));
    await page.locator('#stColors [data-c="#FF8CBE"]').click(); await page.reload(); await page.waitForSelector('#stColors');
    const p2 = await page.evaluate(() => J2Accent.palette('#FF8CBE'));
    check('после перезагрузки фон и акцент те же (розовый)', (await css('body', 'backgroundColor')) === rgb(p2.bgRgb) && (await css('html', 'backgroundColor')) === rgb(p2.bgRgb) && (await meta()) === p2.bg && (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--j-lime').trim().toUpperCase())) === '#FF8CBE');
    await shot(page, 'accent-pink'); check('профиль 360 px: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }

  // ---------- 2. сокращения предметов и «ПЗ» на экране ----------
  {
    const FSA = 'Функционально-стоимостный анализ';
    const { ctx, page, errs } = await open('/home', 'app.html');
    DB.schedule_lessons.push(lesson(FSA, 'practice', 'Иванов И.И.', 7), lesson('Интегрированные маркетинговые коммуникации', 'lecture', 'Петров П.П.', 8));
    await page.reload(); await page.waitForSelector('.cab-lesson');
    const names = await page.locator('.cab-lesson .n').allInnerTexts();
    check('расписание дня: ФСА и ИМК сокращены, остальные предметы целиком', names.includes('ФСА') && names.includes('ИМК') && names.includes('Логистика') && !names.some((n) => n.includes(FSA)), JSON.stringify(names));
    await page.goto(`${BASE}/app.html#/schedule`); await page.waitForSelector('button.cab-lesson');
    const lab = await page.locator('button.cab-lesson').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
    check('aria-label остаётся с полным названием и видом «ПЗ»', lab.some((l) => l.startsWith(FSA + ', ПЗ')), JSON.stringify(lab).slice(0, 300));
    await page.locator('button.cab-lesson', { hasText: 'ФСА' }).first().click(); await page.waitForSelector('.cab-modal');
    const mt = await page.locator('.cab-modal').innerText();
    check('шторка занятия: полное название (с неразрывными дефисами) и «ПЗ»', mt.replace(/\u2011/g, '-').includes(FSA) && /ПЗ/.test(mt) && !/Практическ/.test(mt), mt.slice(0, 200));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }

  // ---------- 3. массовое внесение пропусков старостой ----------
  const journal = async () => {
    const o = await open('/journal', 'headman.html', { staff: true });
    await o.page.waitForSelector('.mk-pair'); await fast(o.page); return o;
  };
  const idle = (page) => page.waitForFunction(() => document.getElementById('hmSave').textContent.trim() === 'Сохранить', null, { timeout: 8000 });   // сохранение закончилось, список перерисован
  const markAll = async (page, i) => {
    await page.locator('.mk-pair').nth(i).click(); await page.waitForSelector('.mk-row');
    const n = await page.locator('.mk-row').count(); const rows = page.locator('.mk-row');
    for (let k = 0; k < n; k++) { const b = rows.nth(k).locator('button[data-s="a"]'); if (!(await b.isDisabled())) await b.click(); }
    return n;
  };
  {
    // 3а. обрыв дважды подряд: повтор того же запроса, запись одна на студента
    const { ctx, page, errs } = await journal();
    const n = await markAll(page, 0); DB.drop = 2;
    await page.click('#hmSave');
    await page.waitForFunction(() => /Сохранение: \d+ из \d+/.test(document.getElementById('hmSave').textContent), null, { timeout: 4000 }).then(() => check('на кнопке виден прогресс «Сохранение: N из M»', true), () => check('на кнопке виден прогресс «Сохранение: N из M»', false, 'текст не появился'));
    await waitToast(page, /Внесено \d+/);
    const mine = DB.absences.filter((a) => a.date === TODAY && a.pair_no === 1 && a.created_by === 'u-me'), ids = new Set(mine.map((a) => a.id));
    check(`обрыв дважды: пропуски внесены после повторов (${n} студентов), без дублей`, mine.length === n && ids.size === n && POSTS.length === 3 && POSTS[0] === n, JSON.stringify({ n, mine: mine.length, POSTS }));
    check('обрыв дважды: сообщение «Внесено N», очередь пуста', new RegExp(`Внесено ${n}`).test(await toast(page)) && (await queueN(page)) === 0, await toast(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    // 3б. связь пропала насовсем: всё в очередь на телефоне, потом уходит сама, без дублей
    const { ctx, page, errs } = await journal();
    const n = await markAll(page, 0); DB.drop = 99;
    await page.click('#hmSave'); await waitToast(page, /Нет связи\. Сохранено на телефоне: \d+/);
    check(`связи нет: сохранено на телефоне ${n}, на сервере ничего`, (await queueN(page)) === n && DB.absences.filter((a) => a.id.startsWith('ab-') && a.date === TODAY && a.pair_no === 1 && a.created_by === 'u-me').length === 0, `${await queueN(page)} ${await toast(page)}`);
    DB.drop = 0; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('j2.oq.v1') || '[]').length === 0, null, { timeout: 12000 });
    await page.waitForTimeout(400);
    const mine = DB.absences.filter((a) => a.date === TODAY && a.pair_no === 1 && a.created_by === 'u-me');
    check('связь вернулась: очередь ушла сама, на сервере по одной записи на студента', mine.length === n && new Set(mine.map((a) => a.student_id)).size === n, `${mine.length} из ${n}`);
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    // 3в. четыре пары подряд без связи: очередь, потом отправка пачками по 40 без дублей
    const { ctx, page, errs } = await journal();
    DB.drop = 999; let total = 0;
    for (let i = 0; i < 4; i++) {
      await page.locator('.mk-pair').nth(i).click(); await page.waitForSelector('.mk-row');
      const rows = page.locator('.mk-row'), c = await rows.count();
      for (let k = 0; k < c; k++) { const b = rows.nth(k).locator('button[data-s="a"]'); if (!(await b.isDisabled())) { await b.click(); total++; } }
      await page.click('#hmSave'); await waitToast(page, /Нет связи\. Сохранено на телефоне/); await idle(page); await page.waitForTimeout(300);
    }
    check(`четыре пары (${total} отметок) без связи: все в очереди`, (await queueN(page)) === total && total > 40, `${await queueN(page)} из ${total}`);
    POSTS.length = 0; DB.drop = 0; await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('j2.oq.v1') || '[]').length === 0, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    const mine = DB.absences.filter((a) => a.date === TODAY && a.created_by === 'u-me' && String(a.id).startsWith('ab-'));
    const key = (a) => [a.student_id, a.pair_no].join('|');
    check('очередь ушла пачками не больше 40, суммарно столько же, сколько отмечено', POSTS.length >= 2 && POSTS.every((x) => x <= 40) && POSTS.reduce((s, x) => s + x, 0) === total, JSON.stringify(POSTS));
    check('на сервере нет дублей (студент + пара), id уникальны', mine.length === total && new Set(mine.map(key)).size === total && new Set(mine.map((a) => a.id)).size === total, `${mine.length}/${total}`);
    await shot(page, 'mass-queue-flushed'); check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    // 3г. обрыв в середине правки: сообщение о частичном успехе, отметки остаются на экране, повторное нажатие не дублирует
    const { ctx, page, errs } = await journal();
    DB.absences.push(...Array.from({ length: 6 }, (_, i) => abs('ab-pre' + i, DB.students[i].id, TODAY, 'Логистика', 2, false, 'lecture', { pair_no: 1 })));
    await page.reload(); await page.waitForSelector('.mk-pair'); await fast(page);
    await page.locator('.mk-pair').nth(0).click(); await page.waitForSelector('.mk-row');
    check('внесённые подставлены', /st-abs/.test(await page.locator('.mk-row').nth(0).getAttribute('class')) || (await page.locator('.mk-row.st-abs').count()) >= 1);
    const was = DB.absences.length;
    await page.locator('.mk-row.st-abs').first().locator('button[data-s="p"]').click();             // Н → Был: отмена записи
    await page.locator('.mk-row:not(.st-abs):not(.st-exc)').last().locator('button[data-s="a"]').click();   // плюс новая отметка
    DB.dropAll = true;
    await page.route('**/rest/v1/absences?*', async (route) => (route.request().method() === 'DELETE' && DB.dropAll ? route.abort('connectionreset') : route.fallback()));
    await page.click('#hmSave'); await page.waitForSelector('.cab-modal'); await page.click('.cab-modal button[data-a="ok"]');     // «Убрать пропуски?» — подтверждаем
    await waitToast(page, /Сохранено \d+ из \d+/);
    const tx = await toast(page);
    check('обрыв при отмене: «Нет связи», сколько сохранено, что делать', /Нет связи/.test(tx) && /Сохранено \d+ из 2/.test(tx) && /нажмите «Сохранить» ещё раз/.test(tx), tx);
    check('отметки остались на экране, кнопка снова активна', (await page.locator('#hmSave').isDisabled()) === false);
    DB.dropAll = false; await page.click('#hmSave'); await page.waitForSelector('.cab-modal'); await page.click('.cab-modal button[data-a="ok"]'); await waitToast(page, /Убрано 1|убрано 1/i);
    const fin = DB.absences.filter((a) => a.date === TODAY && a.pair_no === 1 && a.created_by === 'u-me');
    check('повторное нажатие: отмена прошла, новая запись одна, второго POST нет (внесённое второй раз не добавилось)', DB.absences.length === was + 1 && fin.length === 1 && POSTS.length === 1 && new Set(DB.absences.map((a) => a.id)).size === DB.absences.length, `${DB.absences.length} было ${was}, POST ${JSON.stringify(POSTS)} ${await toast(page)}`);
    check('ошибок страницы нет', errs.length === 0 || errs.every((e) => /Failed to load resource|ERR_/.test(e)), errs.join(' / ')); await ctx.close();
  }
} catch (e) { console.log('ПРОВАЛ сценарий упал — ' + (e && e.stack || e)); results.push(false); }
await browser.close(); server.close();
console.log(`\nИтого: ${results.filter(Boolean).length} из ${results.length}. Снимки: ${OUT}`);
process.exit(results.every(Boolean) ? 0 : 1);
