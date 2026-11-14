// 2.1 п.13, справки: одна запись = одна справка. Кабинет старосты (headman.html) и профиль студента (app.html) в настоящем браузере
// БЕЗ сети: Supabase подменён заглушкой, ни тест, ни прод не затрагиваются. Привязку пропусков к справке делает база (триггер,
// проверка — tests/db/certificates.sql); здесь — только то, что делает страница: что она шлёт и что показывает.
// Запуск: node tests/e2e/v21-certs-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs). Снимки — SHOTS_DIR или %TEMP%\v21-certs-shots.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 9, 8, 40);                       // пн 9 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-09';
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'v21-certs-shots'));
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
const lesson = (subject, kind, pair) => ({ lesson_date: TODAY, pair_no: pair, starts_at: `${8 + pair}:00:00`.padStart(8, '0'), ends_at: `${9 + pair}:30:00`.padStart(8, '0'), subject, kind, teacher: 'Иванов И.И.', room: '101', subgroup: null, prev_room: null, changed_at: null, event: null });
const abs = (id, sid, date, subject, extra) => ({ id, student_id: sid, date, subject, hours: 2, is_excused: true, lesson_kind: 'lecture', created_by: null, comment: null, cert_type: null, cert_submitted: false, cert_due_date: null, certificate_id: null, pair_no: null, ...extra });
const cert = (id, sid, kind, from, to, extra) => ({ id, group_id: G, student_id: sid, kind, date_from: from, date_to: to, due_date: null, status: 'waiting', open: false, ...extra });
const mk = () => ({
  memberships: [{ user_id: 'u-me', group_id: G, student_id: 's-me', base_role: 'student', extra_role: 'headman', status: 'active', consent_at: '2026-11-01T00:00:00Z' }],
  groups: [{ id: G, name: '24ДММ-2', status: 'active', warn_hours: 8, dean_hours: 12 }],
  students: [st('s-me', 'Тестов', 'Тест'), st('s-a', 'Андреев', 'Антон'), st('s-b', 'Борисова', 'Берта'), st('s-c', 'Васильев', 'Виктор')],
  schedule_lessons: [lesson('Логистика', 'lecture', 1), lesson('Эконометрика', 'lecture', 3)],
  // открытый больничный Андреева с 05.11 (3 пропуска, 2 предмета), заявление Борисовой, просроченная справка Васильева,
  // сданное освобождение самого старосты, справка вне семестра (не показывается)
  certificates: [cert('ce-open', 's-a', 'sick', '2026-11-05', null, { open: true }), cert('ce-st', 's-b', 'statement', '2026-11-06', '2026-11-06', { due_date: '2026-11-12' }),
    cert('ce-late', 's-c', 'other', '2026-11-04', '2026-11-04', { due_date: '2026-11-06' }), cert('ce-ex', 's-me', 'exemption', '2026-11-02', '2026-11-02', { status: 'received' }),
    cert('ce-old', 's-a', 'other', '2026-05-01', '2026-05-01', { due_date: '2026-05-05' })],
  absences: [abs('ab-1', 's-a', '2026-11-05', 'Логистика', { cert_type: 'Больничный', certificate_id: 'ce-open' }), abs('ab-2', 's-a', '2026-11-05', 'Эконометрика', { cert_type: 'Больничный', certificate_id: 'ce-open' }),
    abs('ab-3', 's-a', '2026-11-06', 'Логистика', { cert_type: 'Больничный', certificate_id: 'ce-open' }), abs('ab-4', 's-b', '2026-11-06', 'Логистика', { cert_type: 'Заявление', cert_due_date: '2026-11-12', certificate_id: 'ce-st' }),
    abs('ab-5', 's-c', '2026-11-04', 'Эконометрика', { cert_type: 'Справка', cert_due_date: '2026-11-06', certificate_id: 'ce-late' }), abs('ab-6', 's-me', '2026-11-02', 'Логистика', { cert_type: 'Освобождение', cert_submitted: true, certificate_id: 'ce-ex' })],
  tasks: [], homework_editors: [], absence_cancellations: [], notifications: [],
  schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
  rpc: { certificate_set_open: { ok: true, open: false, date_from: '2026-11-05', date_to: '2026-11-06', due_date: '2026-11-09' }, certificate_set_submitted: { ok: true, status: 'received', absences: 3 },
    absence_hours_my: { total: 2, excused: 2, unexcused: 0, warn_hours: 8, dean_hours: 12 }, data_deletion_requests_list: [] },
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
async function open(hash, file, { size = [360, 740], theme = null } = {}) {
  DB = mk(); LOG = [];
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, locale: 'ru-RU', colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.route(`${SB}/**`, fake); await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* нет памяти */ } }, [KEY, SES]);
  if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem('m_j2_theme', t); } catch (e) { /* нет памяти */ } }, theme);
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !ERR_OK.test(m.text())) errs.push(m.text()); });
  await page.goto(`${BASE}/${file}#${hash}`); await page.waitForSelector('#cabMain .cab-title, #cabMain h1, #cabMain .cab-head', { timeout: 15000 });
  return { ctx, page, errs };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${++n}-${name}.png`), fullPage: true });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const T = (page, sel) => page.locator(sel).first().innerText();
const sp = (s) => s.replace(/\s+/g, ' ');

try {
  // ---------- отметки: больничный открывается сам, «тот же больничный» по умолчанию ----------
  {
    const { ctx, page, errs } = await open('/journal', 'headman.html');
    await page.locator('button.mk-pair').first().click(); await page.waitForSelector('.mk-row');
    const row = (nm) => page.locator('.mk-row', { hasText: nm });
    await row('Андреев').locator('button[data-s="e"]').click();
    await row('Андреев').locator('select[data-f="doc"]').selectOption('Больничный');
    const same = row('Андреев').locator('input[data-f="same"]');
    check('больничный при открытом: галочка «Тот же больничный, что открыт 05.11», включена по умолчанию',
      await same.count() === 1 && await same.isChecked() && /Тот же больничный, что открыт 05\.11/.test(await row('Андреев').innerText()), await row('Андреев').innerText());
    check('больничный: срока и «Уже сдал» нет (срок — при закрытии)', await row('Андреев').locator('input[data-f="due"], input[data-f="done"]').count() === 0);
    await row('Борисова').locator('button[data-s="e"]').click();
    await row('Борисова').locator('select[data-f="doc"]').selectOption('Больничный');
    check('больничный без открытого: «Откроется больничный с 09.11»', /Откроется больничный с 09\.11/.test(await row('Борисова').innerText()) && await row('Борисова').locator('input[data-f="same"]').count() === 0, await row('Борисова').innerText());
    await shot(page, 'marks-sick'); check('отметки 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await page.click('#hmSave'); await page.waitForTimeout(700);
    const post = LOG.find((x) => x.m === 'POST' && x.table === 'absences'), rows = (post && post.body) || [];
    const by = (sid) => rows.find((r) => r.student_id === sid) || {};
    check('сохранение: причина «Больничный», без срока и «сдана», справку не трогаем руками',
      rows.length === 2 && ['s-a', 's-b'].every((s) => by(s).cert_type === 'Больничный' && by(s).is_excused === true && by(s).cert_due_date === null && by(s).cert_submitted === false && !('certificate_id' in by(s))), JSON.stringify(rows));
    check('«тот же больничный»: открытый не закрывается', !LOG.some((x) => x.rpc === 'certificate_set_open'), JSON.stringify(LOG.filter((x) => x.rpc)));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- отметки: «не тот же» — сначала закрыть открытый, потом вставка (база откроет новый) ----------
  {
    const { ctx, page, errs } = await open('/journal', 'headman.html');
    await page.locator('button.mk-pair').first().click(); await page.waitForSelector('.mk-row');
    const r = page.locator('.mk-row', { hasText: 'Андреев' });
    await r.locator('button[data-s="e"]').click(); await r.locator('select[data-f="doc"]').selectOption('Больничный');
    await r.locator('input[data-f="same"]').uncheck();
    await page.click('#hmSave'); await page.waitForTimeout(700);
    const iClose = LOG.findIndex((x) => x.rpc === 'certificate_set_open'), iPost = LOG.findIndex((x) => x.m === 'POST' && x.table === 'absences');
    const c = LOG[iClose];
    check('новый больничный: certificate_set_open(ce-open, false) до вставки пропуска', c && c.body.p_certificate === 'ce-open' && c.body.p_open === false && iPost > iClose, JSON.stringify(LOG));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- вкладка «Справки» ----------
  {
    const { ctx, page, errs } = await open('/journal/certs', 'headman.html');
    await page.waitForSelector('.dc');
    const cnt = await page.evaluate(() => [...document.querySelectorAll('.dc-cnt .big, .dc-done-cnt .j2-num')].map((x) => x.textContent.trim()));
    check('справки: счётчики — срок прошёл 1, не сданы 3, сданы 1; справка вне семестра не считается', cnt.join(',') === '1,3,1', cnt.join(','));
    check('справки: одна карточка на справку (4 в семестре), не на пропуск', await page.locator('.dc').count() === 4);
    const sick = sp(await page.locator('.dc', { hasText: 'Андреев' }).innerText());
    check('карточка больничного: ФИО, тип, срок «с 05.11, открыт», часы и предметы, «не сдана»',
      /Андреев Антон/.test(sick) && /Больничный · с 05\.11, открыт/.test(sick) && /6 часов, 2 предмета/.test(sick) && /не сдана/.test(sick), sick);
    check('открытый больничный: кнопки «Закрыть больничный» и «Сдана»', await page.locator('.dc', { hasText: 'Андреев' }).locator('button[data-a="close"], button[data-a="ok"]').count() === 2);
    const st1 = sp(await page.locator('.dc', { hasText: 'Борисова' }).innerText());
    check('однодневная справка: «Заявление · 06.11», 2 часа, 1 предмет, сдать до 12.11, без «Закрыть»',
      /Заявление · 06\.11/.test(st1) && /2 часа, 1 предмет/.test(st1) && /сдать до 12\.11/.test(st1) && await page.locator('.dc', { hasText: 'Борисова' }).locator('button[data-a="close"]').count() === 0, st1);
    const done = page.locator('.dc', { hasText: 'Тестов' });
    check('сданная: статус «сдана», кнопок нет', /сдана/.test(await done.innerText()) && !/не сдана/.test(await done.innerText()) && await done.locator('button').count() === 0);
    const heads = await page.locator('#dcList .cab-h2 span:first-child').allInnerTexts();
    check('справки: группы «срок прошёл», «не сданы», «сданы»', heads.join('|') === 'Не сданы, срок прошёл|Не сданы|Сданы', heads.join('|'));
    await page.click('#dcF button[data-v="done"]'); check('фильтр «Сданы»', await page.locator('.dc').count() === 1);
    await page.click('#dcF button[data-v="wait"]'); check('фильтр «Не сданы»', await page.locator('.dc').count() === 3);
    await page.click('#dcF button[data-v="all"]'); await page.fill('#dcQ', 'борис'); check('поиск по фамилии', await page.locator('.dc').count() === 1); await page.fill('#dcQ', '');
    await shot(page, 'certs'); check('справки 360 px: без горизонтальной прокрутки', await noOverflow(page));
    await page.locator('.dc', { hasText: 'Андреев' }).locator('button[data-a="close"]').click(); await page.waitForTimeout(600);
    const cl = LOG.filter((x) => /^certificate_/.test(x.rpc || ''));
    check('«Закрыть больничный»: certificate_set_open(ce-open, false), отметки «сдана» нет', cl.length === 1 && cl[0].rpc === 'certificate_set_open' && cl[0].body.p_certificate === 'ce-open' && cl[0].body.p_open === false, JSON.stringify(cl));
    LOG = [];
    await page.waitForSelector('.dc'); await page.locator('.dc', { hasText: 'Андреев' }).locator('button[data-a="ok"]').click(); await page.waitForTimeout(600);
    const ok = LOG.filter((x) => /^certificate_/.test(x.rpc || '')).map((x) => `${x.rpc}:${x.body.p_certificate}:${x.body.p_open ?? x.body.p_submitted}`);
    check('«Сдана» у открытого больничного: одно нажатие — закрыть и отметить всю справку', ok.join(',') === 'certificate_set_open:ce-open:false,certificate_set_submitted:ce-open:true', ok.join(','));
    LOG = [];
    await page.waitForSelector('.dc'); await page.locator('.dc', { hasText: 'Борисова' }).locator('button[data-a="ok"]').click(); await page.waitForTimeout(600);
    const ok2 = LOG.filter((x) => /^certificate_/.test(x.rpc || '')).map((x) => `${x.rpc}:${x.body.p_certificate}:${x.body.p_submitted}`);
    check('«Сдана» у заявления: только certificate_set_submitted, пропуски напрямую не правятся', ok2.join(',') === 'certificate_set_submitted:ce-st:true' && !LOG.some((x) => x.m === 'PATCH'), ok2.join(','));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  {
    const { ctx, page, errs } = await open('/journal/certs', 'headman.html', { size: [320, 740], theme: 'light' });
    await page.waitForSelector('.dc'); await shot(page, 'certs-light-320');
    check('справки 320 px, светлая тема: без горизонтальной прокрутки', await noOverflow(page));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- сводка: плитка «Справки» считает справки, а не пропуски ----------
  {
    const { ctx, page, errs } = await open('/summary', 'headman.html');
    await page.waitForSelector('.cab-tile');
    const tile = sp(await page.locator('.cab-tile', { hasText: 'Справки' }).innerText());
    check('сводка: плитка «Справки» — не сданы 3 (вместе с открытым больничным), просрочено 1', /Справки 3/.test(tile) && /просрочено 1/.test(tile), tile);
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- студенты: справка считается один раз, сколько бы пропусков она ни покрывала ----------
  {
    const { ctx, page, errs } = await open('/journal/students', 'headman.html');
    await page.waitForSelector('.sl-row');
    const a = sp(await page.locator('.sl-row', { hasText: 'Андреев' }).innerText());
    check('студенты: у Андреева «Ждём документов: 1» (один больничный на 3 пропуска)', /Ждём документов: 1\b/.test(a), a);
    await page.locator('.sl-row', { hasText: 'Андреев' }).click(); await page.waitForSelector('.sc-ab');
    await page.locator('.sc-ab').first().locator('button[data-a="doc"]').click(); await page.waitForTimeout(600);
    const rp = LOG.filter((x) => x.rpc).map((x) => x.rpc);
    check('карточка: «Справка сдана» — RPC на справку пропуска, без PATCH пропуска', rp.includes('certificate_set_submitted') && !LOG.some((x) => x.m === 'PATCH'), rp.join(','));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- перенос пропуска в другой больничный ----------
  {
    const { ctx, page, errs } = await open('/journal/students', 'headman.html');
    await page.waitForSelector('.sl-row');
    DB.certificates.push(cert('ce-s2', 's-a', 'sick', '2026-10-20', '2026-10-22'));                // второй, закрытый больничный Андреева
    await page.locator('.sl-row', { hasText: 'Андреев' }).click(); await page.waitForSelector('.sc-ab');
    check('карточка: у пропуска под больничным есть «Перенести в другой больничный»', await page.locator('.sc-ab').first().locator('button[data-a="relink"]').count() === 1);
    await page.locator('.sc-ab').first().locator('button[data-a="relink"]').click();
    await page.waitForSelector('.cab-sheet button[data-c]');
    const opts = (await page.locator('.cab-sheet button[data-c]').allInnerTexts()).map(sp);
    check('перенос: в списке только другой больничный, срок 20.10–22.10', opts.some((x) => /Больничный 20\.10–22\.10/.test(x)) && !opts.some((x) => /ce-open|с 05\.11/.test(x)), opts.join(' | '));
    check('перенос: кнопки не меньше 44 px', (await page.locator('.cab-sheet button[data-c]').first().boundingBox()).height >= 44);
    await page.locator('.cab-sheet button[data-c="ce-s2"]').click(); await page.waitForTimeout(600);
    const link = LOG.find((x) => x.rpc === 'certificate_link');
    check('перенос: RPC certificate_link с выбранной справкой и одним пропуском', !!link && link.body.p_certificate === 'ce-s2' && link.body.p_absence_ids.length === 1, JSON.stringify(link && link.body));
    check('перенос: пропуски не правятся напрямую', !LOG.some((x) => x.m === 'PATCH'));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
  // ---------- профиль студента: свои справки ----------
  {
    const { ctx, page, errs } = await open('/profile', 'app.html');
    await page.waitForSelector('.pf-card');
    const t = sp(await page.locator('#cabMain').innerText());
    check('профиль: «Освобождение, 2 ноября — сдана»', /Освобождение, 2 ноября сдана/.test(t), t.slice(0, 400));
    check('ошибок страницы нет', errs.length === 0, errs.join(' / ')); await ctx.close();
  }
} catch (e) { console.log('ПРОВАЛ сценарий упал — ' + (e && e.stack || e)); results.push(false); }
await browser.close(); server.close();
console.log(`\nИтого: ${results.filter(Boolean).length} из ${results.length}. Снимки: ${OUT}`);
process.exit(results.every(Boolean) ? 0 : 1);
