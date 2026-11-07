// Кабинет студента (app.html + app-student.js) на ТЕСТОВОМ проекте, на настоящей базе:
//   четыре вкладки и экраны учёбы/профиля/уведомлений при 390×844: без горизонтальной прокрутки, крупные цели нажатия,
//   главная с парами, кольцом и плитками, подгруппа и «прочитано» сохраняются в базе, кабинет старосты студенту не виден.
// Запуск: node tests/e2e/student.mjs   (после npm run test:reset и применённой миграции этапа 2; CHROME_PATH — путь к Chromium)
// Фикстуры (расписание, задания, оценки, справки, уведомления) вставляются service-ключом в начале и удаляются в конце.
// «Сейчас» подменяется на 2026-11-05 11:40 по Минску: cab-core.js отдаётся с Cab.testNow из window.__NOW.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { assertTestTarget, PROD_REF } from '../../tools/test/guard.mjs';
import { findChrome } from '../../tools/test/chrome.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL_SB = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL_SB);
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY;
if (!ANON || !SERVICE || !env.TEST_PASSWORD) { console.error('Нет ключей в .env.test: запустите npm run test:reset'); process.exit(2); }

const ROOT = resolve('.');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = resolve(join(ROOT, p === '/' ? 'index.html' : p));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const b = readFileSync(f); res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' }).end(b); } catch (_) { res.writeHead(404).end(); }
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const KEY = `sb-${TEST}-auth-token`;
const ENV_JS = readFileSync('env.js', 'utf8')
  .replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${URL_SB}'`)
  .replace(/const SUPABASE_KEY = '[^']*'/, `const SUPABASE_KEY = '${ANON}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`)
  .replace(/const TG_APP_KEY = '[^']*'/, "const TG_APP_KEY = ''")
  .replace("const LS_PREFIX = ''", "const LS_PREFIX = 't_'");
if (ENV_JS.includes(PROD_REF)) { console.error('СТОП: в подменённом env.js остался прод'); process.exit(2); }
const NOW = Date.UTC(2026, 10, 5, 8, 40);                                   // 11:40 по Минску, четверг
const CAB_JS = readFileSync('cab-core.js', 'utf8').replace('Cab.testNow = null;', 'Cab.testNow = window.__NOW ?? null;');
if (!CAB_JS.includes('window.__NOW')) { console.error('СТОП: в cab-core.js не нашёл Cab.testNow = null'); process.exit(2); }

const results = [];
const LOGS = []; let PAGE = null;
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const shots = resolve(process.env.TEMP ?? '.', 'student-e2e'); mkdirSync(shots, { recursive: true });
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SH, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const until = async (fn, ms = 12000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 300)); } };

const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }
const uid = ses.user.id;
const [stu] = await api(`/rest/v1/students?claimed_by=eq.${uid}&select=id,group_id,subgroup`);
const GID = stu.group_id, SID = stu.id, startISO = new Date().toISOString();
const SUF = ' (e2e)', D = '2026-11-05';
const subj = { psy: 'Психология', eco: 'Эконометрика', mkt: 'Маркетинг услуг', str: 'Стратегический маркетинг' };
const TEACHER = 'E2E Тестов';
const metaBefore = (await api(`/rest/v1/schedule_meta?group_id=eq.${GID}&select=*`))[0] ?? null;

const prefBefore = (await api(`/rest/v1/notification_prefs?user_id=eq.${uid}&kind=eq.deadline_soon&select=enabled`))[0] ?? null;

async function cleanup() {
  await api(`/rest/v1/app_events?user_id=eq.${uid}&kind=in.(first_login,whats_new_read,avatar_set)`, { method: 'DELETE' }).catch(() => {});   // события, которые пишет сам кабинет
  if (prefBefore) await api(`/rest/v1/notification_prefs?user_id=eq.${uid}&kind=eq.deadline_soon`, { method: 'PATCH', body: JSON.stringify({ enabled: prefBefore.enabled }) }).catch(() => {});
  else await api(`/rest/v1/notification_prefs?user_id=eq.${uid}&kind=eq.deadline_soon`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${URL_SB}/auth/v1/admin/users/${uid}`, { method: 'PUT', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: env.TEST_PASSWORD }) }).catch(() => {});   // пароль после проверки смены
  await api(`/rest/v1/schedule_lessons?group_id=eq.${GID}`, { method: 'DELETE' }).catch(() => {});   // и настоящее расписание из ручного импорта: оно мешает фикстуре
  await api('/rest/v1/tasks?id=like.e2e-*', { method: 'DELETE' }).catch(() => {});
  await api('/rest/v1/grades?id=like.gr-e2e*', { method: 'DELETE' }).catch(() => {});
  await api('/rest/v1/certificates?id=like.ce-e2e*', { method: 'DELETE' }).catch(() => {});
  await api(`/rest/v1/notifications?user_id=eq.${uid}&created_at=gte.${startISO}`, { method: 'DELETE' }).catch(() => {});
  await api(`/rest/v1/notifications?user_id=eq.${uid}&title=like.*${encodeURIComponent(SUF)}`, { method: 'DELETE' }).catch(() => {});
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: stu.subgroup }) }).catch(() => {});
  if (metaBefore) await api(`/rest/v1/schedule_meta?group_id=eq.${GID}`, { method: 'PATCH', body: JSON.stringify({ last_import_at: metaBefore.last_import_at, last_status: metaBefore.last_status }) }).catch(() => {});
  else await api(`/rest/v1/schedule_meta?group_id=eq.${GID}`, { method: 'DELETE' }).catch(() => {});
}

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
try {
  await cleanup();                                                          // хвосты прошлого прогона
  // ----- фикстуры -----
  await api(`/rest/v1/memberships?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: null }) });
  const L = (pair_no, a, b, subject, kind, room, extra = {}) => ({ group_id: GID, lesson_date: D, pair_no, starts_at: a, ends_at: b, subject, kind, teacher: TEACHER, room, subgroup: null, prev_room: null, changed_at: null, ...extra });
  await api('/rest/v1/schedule_lessons', { method: 'POST', body: JSON.stringify([
    L(1, '09:35', '10:55', subj.psy, 'lecture', '120'), L(3, '11:15', '12:35', subj.eco, 'lecture', '304'),
    L(4, '12:55', '14:15', subj.mkt, 'practice', '217'), L(5, '14:35', '15:55', subj.str, 'practice', '405', { prev_room: '402', changed_at: '2026-11-04T10:00:00Z' })]) });
  await api('/rest/v1/schedule_meta', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ group_id: GID, last_import_at: '2026-11-05T00:00:00Z', last_status: 'ok' }) });
  const rec = (id, o) => ({ id, createdAt: new Date().toISOString(), subgroup: 0, ...o });
  await api('/rest/v1/tasks', { method: 'POST', body: JSON.stringify([
    { id: 'e2e-hw-1', kind: 'homework', rec: rec('e2e-hw-1', { subject: subj.eco, type: 'ПЗ', text: 'Задачи 4–6. Мудл: https://example.com/task. <b>x</b>', dueDate: '2026-11-06' }) },
    { id: 'e2e-hw-old', kind: 'homework', rec: rec('e2e-hw-old', { subject: subj.psy, type: 'УСР', text: 'старое задание', dueDate: '2026-10-20' }) },
    { id: 'e2e-dl-1', kind: 'deadline', rec: rec('e2e-dl-1', { subject: subj.psy, type: 'deadline', text: 'эссе', dueDate: '2026-11-07' }) },
    { id: 'e2e-ex-1', kind: 'deadline', rec: rec('e2e-ex-1', { subject: subj.mkt, type: 'exam', text: 'Экзамен 12:00, ауд. 310', dueDate: '2026-12-20' }) },
    { id: 'e2e-usr-1', kind: 'homework', rec: rec('e2e-usr-1', { subject: subj.str, type: 'УСР', text: 'УСР по теме 3', dueDate: '2026-11-09' }) },
    { id: 'e2e-zc-1', kind: 'deadline', rec: rec('e2e-zc-1', { subject: subj.psy, type: 'zachet', text: 'Зачёт 10:00', dueDate: '2026-12-25' }) },
  ].map((t) => ({ ...t, group_id: GID }))) });
  await api('/rest/v1/grades', { method: 'POST', body: JSON.stringify([
    { id: 'gr-e2e1', group_id: GID, student_id: SID, subject: subj.mkt, lesson_kind: 'practice', value: 9, passed: null, lesson_date: D },
    { id: 'gr-e2e2', group_id: GID, student_id: SID, subject: subj.psy, lesson_kind: 'lecture', value: null, passed: true, lesson_date: '2026-11-02' }]) });
  await api('/rest/v1/certificates', { method: 'POST', body: JSON.stringify([
    { id: 'ce-e2e1', group_id: GID, student_id: SID, kind: 'sick', date_from: '2026-11-03', date_to: '2026-11-04', status: 'received' },
    { id: 'ce-e2e2', group_id: GID, student_id: SID, kind: 'statement', date_from: '2026-10-28', date_to: '2026-10-28', status: 'waiting' }]) });
  await api(`/rest/v1/notifications?user_id=eq.${uid}&created_at=gte.${startISO}`, { method: 'DELETE' });   // то, что создали триггеры при вставке выше
  const NT = { task: 'Горит домашка' + SUF, usr: 'Новое УСР' + SUF, grade: 'Новая оценка' + SUF, abs: 'Внесён пропуск' + SUF };
  await api('/rest/v1/notifications', { method: 'POST', body: JSON.stringify([
    { user_id: uid, group_id: GID, kind: 'task', title: NT.task, ref: null, body: 'Эконометрика, срок завтра', created_at: '2026-11-05T06:00:00Z', read_at: null },
    { user_id: uid, group_id: GID, kind: 'task', title: NT.usr, body: 'Стратегический маркетинг: УСР по теме 3', ref: { task_id: 'e2e-usr-1', kind: 'homework', due: '2026-11-09' }, created_at: '2026-11-05T06:30:00Z', read_at: null },
    { user_id: uid, group_id: GID, kind: 'grade', title: NT.grade, ref: null, body: 'Маркетинг услуг: 9', created_at: '2026-11-05T05:30:00Z', read_at: null },
    { user_id: uid, group_id: GID, kind: 'absence', title: NT.abs, ref: null, body: 'Психология, 2 часа', created_at: '2026-11-04T10:00:00Z', read_at: '2026-11-04T11:00:00Z' }]) });
  const ids = Object.fromEntries((await api(`/rest/v1/notifications?user_id=eq.${uid}&title=like.*${encodeURIComponent(SUF)}&select=id,title`)).map((n) => [n.title, n.id]));
  const unreadDb = async () => (await api(`/rest/v1/notifications?user_id=eq.${uid}&read_at=is.null&select=id`)).length;
  const readAt = async (id) => (await api(`/rest/v1/notifications?id=eq.${id}&select=read_at`))[0]?.read_at;

  // ----- страница -----
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.split('?')[0].endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.split('?')[0].endsWith('/cab-core.js') || u.includes('/cab-core.js?')) return route.fulfill({ contentType: 'text/javascript', body: CAB_JS });
    if (u.includes('/vendor/telegram-web-app.js')) return route.abort();   // в тестах Telegram подделан, настоящий скрипт его бы затёр
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v, now]) => { try { localStorage.setItem(k, v); } catch (e) {} window.__NOW = now; }, [KEY, JSON.stringify(ses), NOW]);
  // Подделка Telegram.WebApp для проверки кнопки «Назад»: сам telegram-web-app.js в тесте не грузится (запрос к telegram.org отклоняется)
  await ctx.addInitScript(() => { window.Telegram = { WebApp: { initData: 'query_id=e2e', isVersionAtLeast: () => true, ready() {}, BackButton: { show() { window.__bb = 'show'; }, hide() { window.__bb = 'hide'; }, onClick(cb) { window.__bbClick = cb; } } } }; });
  const page = await ctx.newPage(); PAGE = page;
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { LOGS.push(`${m.type()}: ${m.text()}`.slice(0, 200)); });

  const h1 = (t) => page.locator('#cabMain h1', { hasText: t }).waitFor({ timeout: 20000 });
  const open = async (hash, title) => { await page.evaluate((x) => { location.hash = x; }, hash); await h1(title); };
  const noHScroll = async (label) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= 390 && w[0] <= w[1], JSON.stringify(w)); };
  const taps = async (label) => {
    const bad = await page.evaluate(() => [...document.querySelectorAll('.cab-tab, #cabMain a:not(.st-a), #cabMain button:not(:disabled), #cabMain summary')]
      .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 43.5).map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`));
    check(`${label}: все кнопки и ссылки не ниже 44 px`, bad.length === 0, bad.join(', '));
  };
  const text = () => page.locator('#cabMain').innerText();

  // 1. главная
  await page.goto(`${BASE}/app.html#/home`);
  await page.waitForSelector('.cab-lesson', { timeout: 30000 });
  const lessonsText = await page.locator('.cab-lesson').allInnerTexts();
  check('главная: видны 4 пары дня', Object.values(subj).every((s) => lessonsText.some((t) => t.includes(s))), lessonsText.join(' | ').slice(0, 200));
  check('главная: прошедшая пара приглушена', (await page.locator('.cab-lesson.past', { hasText: subj.psy }).count()) === 1);
  const nowText = await page.locator('.cab-lesson.now').innerText();
  check('главная: текущая пара подсвечена с «ещё 55 минут» и полосой', nowText.includes(subj.eco) && nowText.includes('ещё 55 минут') && (await page.locator('.cab-lesson.now .bar').count()) === 1, nowText);
  check('главная: «аудитория сменилась» у пары со сменой', (await page.locator('.cab-lesson', { hasText: subj.str }).innerText()).includes('аудитория сменилась'));
  check('главная: между парами есть «перемена 20 минут»', (await page.locator('.cab-break', { hasText: 'перемена 20 минут' }).count()) >= 1);
  check('главная: кольцо пропусков и ссылка на пропуски', (await page.locator('a.cab-ringcard[href="#/profile/absences"] svg.cab-ring').count()) === 1);
  const tiles = await page.locator('.cab-tile').count();
  check('главная: плитки «Горит» (1–3)', tiles >= 1 && tiles <= 3, String(tiles));
  const whenTxt = await page.locator('.cab-tile .when').allInnerTexts();
  check('главная: у плиток подпись срока', whenTxt.every((t) => /сегодня|завтра|\d+ (день|дня|дней)/.test(t)), whenTxt.join(','));
  const hdr = await text();
  check('главная: дата и группа в шапке', hdr.includes('5 ноября') && hdr.includes('Четверг, 24ДММ-2'), hdr.slice(0, 80));
  check('главная: «Все задания» ведёт в хаб «Учёба»', (await page.locator('.cab-h2 a', { hasText: 'Все задания' }).getAttribute('href')) === '#/study');
  const alertTxt = await page.locator('a.st-alert').innerText().catch(() => '');
  check('главная: над «Горит» заметная строка про срок сегодня или завтра', alertTxt.includes('Срок сегодня или завтра') && alertTxt.includes(subj.eco), alertTxt);
  const unr = await unreadDb();
  check('главная: колокольчик показывает число новых', (await page.locator('.cab-bell .cab-badge').innerText()) === String(unr), `${unr}`);
  if ((await page.locator('.cab-lesson').count()) === 4 && tiles === 3) {
    const fit = await page.evaluate(() => { const r = [...document.querySelectorAll('#cabMain *')].map((e) => [e.getBoundingClientRect().bottom, e.className || e.tagName]); r.sort((a, b) => b[0] - a[0]); return { bottom: r[0][0], who: r.slice(0, 3).map((x) => Math.round(x[0]) + ' ' + String(x[1]).slice(0, 40)).join(' | '), alert: Math.round((document.querySelector('a.st-alert') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height) }; });
    const bottom = fit.bottom;
    check('главная: 4 пары и 3 плитки помещаются над нижней панелью без прокрутки (строка «срок сегодня или завтра» — отдельная добавка: она может выдвинуть плитки под панель, их видно прокруткой)', bottom - (fit.alert ? fit.alert + 8 : 0) <= 844 - 82, `низ контента ${Math.round(bottom)} px; ${fit.who}; строка «срок» ${fit.alert} px`);
  } else console.log('ПРОПУСК главная: «без прокрутки» проверяется только при ровно 4 парах и 3 плитках');
  await noHScroll('главная'); await taps('главная');
  await page.screenshot({ path: join(shots, 's-home.png') });
  check('вкладка «Главная» подсвечена', (await page.locator('.cab-tab.on').innerText()).includes('Главная'));

  // 2. расписание
  await page.locator('.cab-tab', { hasText: 'Расписание' }).click(); await h1('Расписание');
  check('расписание: вкладки Пн–Сб, выбран сегодняшний день', (await page.locator('.cab-day').count()) === 6 && (await page.locator('#day-2026-11-05[aria-selected="true"]').count()) === 1);
  const st = await text();
  check('расписание: диапазон недели, обновление и подпись', st.includes('2–7 ноября') && st.includes('Обновлено с bseu.by сегодня в 03:00') && st.includes('Данные с bseu.by. Сверяйте с деканатом.'), st.slice(0, 200));
  check('расписание: «Есть домашка» и «Аудитория изменилась, была 402»', st.includes('Есть домашка') && st.includes('Аудитория изменилась, была 402'));
  const strTxt = await page.locator('.cab-lesson', { hasText: subj.str }).innerText();
  check('расписание: по паре, где только УСР, написано «Есть УСР»', strTxt.includes('Есть УСР') && !strTxt.includes('Есть домашка'), strTxt);
  await page.locator('.cab-lesson', { hasText: subj.eco }).click();
  check('расписание: тап по паре открывает подробности с преподавателем', await page.getByRole('dialog').getByText(TEACHER).isVisible());
  await page.keyboard.press('Escape');
  check('расписание: Esc закрывает подробности', (await page.getByRole('dialog').count()) === 0);
  await page.getByRole('button', { name: 'Следующая неделя' }).click();
  check('расписание: переключение на следующую неделю', await page.getByText('9–14 ноября').waitFor({ timeout: 10000 }).then(() => true, () => false));
  await page.getByRole('button', { name: 'Предыдущая неделя' }).click(); await page.getByText('2–7 ноября').waitFor({ timeout: 10000 });
  await noHScroll('расписание'); await taps('расписание');
  await page.screenshot({ path: join(shots, 's-schedule.png') });

  // 3. учёба и разделы
  await page.locator('.cab-tab', { hasText: 'Учёба' }).click(); await h1('Учёба');
  check('учёба: семь блоков', (await page.locator('.cab-row').count()) === 7);
  const hrefs = await page.locator('.cab-row').evaluateAll((a) => a.map((x) => x.getAttribute('href')));
  check('учёба: «Рейтинг» и «Игры» ведут внутри нового кабинета, в старый журнал ничего не ведёт', hrefs.includes('#/study/rating') && hrefs.includes('#/study/games') && !hrefs.some((x) => /^index\.html/.test(x)), hrefs.join(','));
  const dbTasks = (await api(`/rest/v1/tasks?group_id=eq.${GID}&select=kind,rec`)).filter((x) => !x.rec.subgroup || x.rec.subgroup === 0), liveT = (x) => !x.rec.dueDate || x.rec.dueDate >= D, examT = (x) => x.rec.type === 'zachet' || x.rec.type === 'exam', usrT = (x) => x.kind === 'homework' && x.rec.type === 'УСР';
  const wantHw = dbTasks.filter((x) => x.kind === 'homework' && !examT(x) && !usrT(x) && liveT(x)).length, wantDl = dbTasks.filter((x) => (x.kind === 'deadline' || usrT(x)) && !examT(x) && liveT(x)).length;
  const hubTxt = await text(), cnts = await page.locator('.cab-row .cnt').allInnerTexts();
  check('учёба: «Домашки» и «Дедлайны и УСР», у «Игр» подпись «Скоро»', hubTxt.includes('Домашки') && hubTxt.includes('Дедлайны и УСР') && !hubTxt.includes('Домашки и УСР') && (await page.locator('.cab-row', { hasText: 'Игры' }).innerText()).includes('Скоро'), hubTxt.slice(0, 200));
  check('учёба: счётчики активных считаются отдельно (домашки без УСР; дедлайны вместе с УСР; экзамен, зачёт и просроченное не в счёт)', cnts.join(',') === `${wantHw},${wantDl}` && wantDl >= 2 && wantHw >= 1, `${cnts.join(',')} ждали ${wantHw},${wantDl}`);
  await noHScroll('учёба'); await taps('учёба');
  await page.screenshot({ path: join(shots, 's-study.png') });
  await page.locator('.cab-row', { hasText: 'Домашки' }).click(); await h1('Домашки');
  check('домашки: задание видно, ссылка безопасна', (await text()).includes(subj.eco) && (await page.locator('a.st-a[href="https://example.com/task"][target="_blank"][rel~="noopener"][rel~="noreferrer"]').count()) === 1);
  check('домашки: разметка в тексте не превращается в теги', (await page.locator('.st-text b').count()) === 0 && (await text()).includes('<b>x</b>'));
  check('домашки: УСР здесь нет, подпись типа «Домашка, ПЗ»', (await page.locator('.cab-card', { hasText: 'УСР по теме 3' }).count()) === 0 && (await text()).includes('Домашка, ПЗ') && (await page.locator('details.st-det').count()) === 0);
  await noHScroll('домашки'); await taps('домашки');
  await open('#/study/deadlines', 'Дедлайны и УСР'); const dlTxt = await text();
  check('дедлайны и УСР: дедлайн и УСР вместе, домашки нет', dlTxt.includes('эссе') && dlTxt.includes('УСР по теме 3') && !dlTxt.includes('Задачи 4–6') && dlTxt.includes(`Активных: ${wantDl}`), dlTxt.slice(0, 200));
  check('дедлайны и УСР: подпись типа «УСР», просроченное УСР лежит в архиве', (await page.locator('.cab-card', { hasText: 'УСР по теме 3' }).innerText()).includes('УСР · до 9 ноября') && (await page.locator('details.st-det .cab-card', { hasText: 'старое задание' }).count()) === 1);
  await open('#/study/exams', 'Зачёты и экзамены'); check('экзамены: видно время и аудиторию, зачёт рядом', (await text()).includes('Экзамен 12:00, ауд. 310') && (await text()).includes('Зачёт 10:00'));
  await open('#/study/grades', 'Оценки'); const gt = await text();
  check('оценки: балл и «зачтено», без среднего', gt.includes(subj.mkt) && /\b9\b/.test(gt) && gt.includes('зачтено') && !/средн/i.test(gt), gt.slice(0, 200));
  await open('#/study/teachers', 'Преподаватели');
  check('преподаватели: карточки по предметам, без списка преподавателей на странице', (await page.locator('#cabMain button.cab-row').count()) === 4 && !(await text()).includes(TEACHER) && !(await text()).includes('Лекции:'));
  await page.locator('#cabMain button.cab-row', { hasText: subj.eco }).click();
  check('преподаватели: по нажатию шторка с предметом и преподавателем', await page.getByRole('dialog').getByText(TEACHER).isVisible() && (await page.getByRole('dialog').innerText()).includes(subj.eco));
  await page.keyboard.press('Escape');
  await noHScroll('оценки и преподаватели'); await taps('преподаватели');
  // 3б. рейтинг: калькулятор внутри кабинета, формулы и формат хранения прежние
  const OLD_PSY = { control: [5, 5], oral: [5], exam: '4', k1: 0.6, w1: 0.5 };
  await page.evaluate((o) => { localStorage.setItem('t_rating_calc_subjects', JSON.stringify({ 'Психология': o })); localStorage.removeItem('t_rating_calc_subject'); localStorage.setItem('t_rating_calc_state', '{"control":[1]}'); }, OLD_PSY);
  await open('#/study/rating', 'Рейтинг');
  check('рейтинг: нет перехода в старый журнал', (await page.locator('#cabMain a[href^="index.html"]').count()) === 0);
  const opts = await page.locator('#rcSubj option').allInnerTexts();
  check('рейтинг: предметы из расписания и заданий группы', Object.values(subj).every((s) => opts.includes(s)), opts.join(','));
  const doneTxt = await page.locator('#rcDone').innerText();
  check('рейтинг: «Уже посчитано» показывает старый расчёт; у зачёта без экзамена итог = семестр (5,00)', doneTxt.includes('Психология') && doneTxt.includes('5,00'), doneTxt);
  await page.selectOption('#rcSubj', 'Эконометрика');
  const fin = () => page.locator('#rcFinal .rc-big').innerText();
  const finCls = () => page.locator('#rcFinal').getAttribute('class');
  check('рейтинг: без оценок итога нет', (await fin()) === '—' && (await text()).includes('Добавьте оценки за семинары'));
  await page.locator('[data-add="control"][data-v="8"]').click(); await page.locator('[data-add="oral"][data-v="6"]').click();
  check('рейтинг: экзамен ещё не сдан — итога нет, подсказка', (await fin()) === '—' && (await text()).includes('Укажите оценку на экзамене') && await page.locator('#rcNot').isChecked());
  await page.locator('#rcNot').uncheck();
  check('рейтинг: итог = семинарские×w1 + экзамен×(1−w1): (8×0,5+6×0,5)×0,5 + 8×0,5 = 7,50, порог «7 и выше»', (await fin()) === '7,50' && (await finCls()).includes('rc-high') && (await page.locator('#rcFinal .rc-band').innerText()) === '7 и выше');
  await page.locator('[data-k1="0.7"]').click();
  check('рейтинг: k1 = 0,7: (8×0,7+6×0,3)×0,5 + 8×0,5 = 7,70', (await fin()) === '7,70');
  await page.locator('[data-w1="0.4"]').click();
  check('рейтинг: w1 = 0,4: 7,4×0,4 + 8×0,6 = 7,76', (await fin()) === '7,76');
  await page.locator('#rcMinus').click();
  check('рейтинг: экзамен 7,5 (шаг 0,5): 7,4×0,4 + 7,5×0,6 = 7,46', (await fin()) === '7,46' && (await page.locator('#rcExam').innerText()) === '7,5');
  const st1 = await page.evaluate(() => JSON.parse(localStorage.getItem('t_rating_calc_subjects')));
  check('рейтинг: расчёт сохранён в прежнем формате (rating_calc_subjects), расчёт по другому предмету не тронут',
    JSON.stringify(st1['Эконометрика']) === JSON.stringify({ control: [8], oral: [6], exam: '7.5', k1: 0.7, w1: 0.4 }) && JSON.stringify(st1['Психология']) === JSON.stringify(OLD_PSY), JSON.stringify(st1));
  check('рейтинг: выбранный предмет запомнен', (await page.evaluate(() => localStorage.getItem('t_rating_calc_subject'))) === 'Эконометрика');
  await page.locator('.rc-pill[data-rm="control"]').click();
  check('рейтинг: оценку можно убрать тапом; пустое среднее считается нулём, как в старом калькуляторе: (0×0,7+6×0,3)×0,4 + 7,5×0,6 = 5,22, порог «от 4 до 7»', (await fin()) === '5,22' && (await finCls()).includes('rc-mid') && (await page.locator('#rcFinal .rc-band').innerText()) === 'от 4 до 7');
  await page.locator('[data-add="control"][data-v="10"]').click();
  check('рейтинг: средний балл контрольных виден', (await page.locator('#rcAvg-control').innerText()).includes('10,00'));
  await page.locator('#rcSubj').selectOption('Психология');
  check('рейтинг: зачётный предмет без экзамена — экзаменационной части нет, итог = семестр', (await page.locator('#rcExamBox.j2-hidden').count()) === 1 && (await fin()) === '5,00' && (await text()).includes('Зачёт без экзамена'));
  await page.locator('#rcSubj').selectOption('Эконометрика');
  await noHScroll('рейтинг'); await taps('рейтинг');
  await page.screenshot({ path: join(shots, 's-rating.png'), fullPage: true });
  await page.locator('#rcClear').click();
  check('рейтинг: «Очистить» спрашивает подтверждение', await page.getByRole('dialog').getByText('Очистить расчёт?').isVisible());
  await page.getByRole('dialog').getByRole('button', { name: 'Очистить', exact: true }).click();
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('t_rating_calc_subjects')));
  check('рейтинг: после очистки оценок нет, коэффициенты остались, другие предметы целы', st2['Эконометрика'].control.length === 0 && st2['Эконометрика'].oral.length === 0 && st2['Эконометрика'].exam === '' && st2['Эконометрика'].k1 === 0.7 && JSON.stringify(st2['Психология']) === JSON.stringify(OLD_PSY));
  check('рейтинг: старые ключи localStorage не удаляются', (await page.evaluate(() => localStorage.getItem('t_rating_calc_state'))) === '{"control":[1]}');
  await page.evaluate(() => { localStorage.removeItem('t_rating_calc_subjects'); localStorage.removeItem('t_rating_calc_subject'); localStorage.removeItem('t_rating_calc_state'); });
  // 3в. заглушки
  await open('#/study/games', 'Игры');
  check('игры: экран-заглушка с текстом и кнопкой «К учёбе»', (await text()).includes('Игры вернутся в ближайшем обновлении') && (await page.locator('#cabMain a.j2-btn[href="#/study"]', { hasText: 'К учёбе' }).count()) === 1);
  await noHScroll('игры'); await taps('игры');
  await page.screenshot({ path: join(shots, 's-games.png') });
  await page.locator('#cabMain a.j2-btn', { hasText: 'К учёбе' }).click(); await h1('Учёба');

  // 4. профиль
  await page.locator('.cab-tab', { hasText: 'Профиль' }).click(); await h1('Профиль');
  const pt = await text();
  check('профиль: одна карточка, имя, роль «Студент» и группа «24ДММ-2» отдельными плашками, без слова «группа»',
    (await page.locator('.pf-card .pf-tag.role').innerText()) === 'Студент' && (await page.locator('.pf-card .pf-tag:not(.role)').innerText()) === '24ДММ-2' && !pt.includes('группа 24ДММ-2') && (await page.locator('.pf-card .pf-name').count()) === 1);
  check('профиль: справки со статусом словами', pt.includes('Больничный, 3–4 ноября') && pt.includes('подтверждена') && pt.includes('Заявление, 28 октября') && pt.includes('не подтверждена'), pt.slice(0, 300));
  check('профиль: кабинета старосты у обычного студента нет', (await page.locator('a[href="headman.html"]').count()) === 0);
  check('профиль: Studak — плашка внутри карточки, отдельной строки и экрана нет', (await page.locator('.pf-card #pfStu').innerText()).includes('Studak · скоро') && (await page.locator('a[href="#/profile/studak"]').count()) === 0);
  await page.locator('#pfStu').click();
  check('профиль: тап по плашке Studak — короткое сообщение', (await page.locator('#cabToast').innerText()).includes('Пропуск Studak вернётся в ближайшем обновлении'));
  check('профиль: «Достижения» — неактивная плитка «скоро», ссылки на старый журнал нет', (await page.locator('.st-tri #achSoon').innerText()).includes('скоро') && (await page.locator('#achSoon[aria-disabled="true"]').count()) === 1 && (await page.locator('a[href*="index.html#achievements"]').count()) === 0);
  await page.locator('#achSoon').click({ force: true });   // aria-disabled: Playwright ждёт «включения», живой тап проходит
  check('профиль: тап по «Достижения» — короткое сообщение, остаёмся в профиле', (await page.locator('#cabToast').innerText()).includes('Раздел достижений вернётся в ближайшем обновлении') && (await page.evaluate(() => location.hash)) === '#/profile');
  check('вход в новый кабинет записал событие first_login в app_events (для значка «Добро пожаловать»)', !!(await until(async () => (await api(`/rest/v1/app_events?user_id=eq.${uid}&kind=eq.first_login&select=kind`)).length === 1)));
  await page.locator('#pfAva').click();
  const avs = page.getByRole('dialog', { name: 'Фото профиля' });
  check('профиль: тап по аватарке открывает лист «Выбрать фото» и «Отмена», «Удалить фото» нет, пока нет фото', await avs.getByRole('button', { name: 'Выбрать фото' }).isVisible() && await avs.getByRole('button', { name: 'Отмена' }).isVisible() && (await avs.getByRole('button', { name: 'Удалить фото' }).count()) === 0);
  await avs.getByRole('button', { name: 'Отмена' }).click();
  check('профиль: лист фото закрылся', (await page.locator('.cab-modal').count()) === 0);
  check('профиль: у студента с одной ролью переключателя ролей нет', (await page.locator('.j2-roles').count()) === 0);
  check('профиль: блок «Напоминания о сроках», по умолчанию включён, Telegram не привязан — есть ссылка на привязку', (await page.locator('#remSw').getAttribute('aria-checked')) === 'true' && (await page.locator('#remTg[href="#/profile/telegram"]').count()) === 1);
  const prefNow = async () => (await api(`/rest/v1/notification_prefs?user_id=eq.${uid}&kind=eq.deadline_soon&select=enabled`))[0]?.enabled;
  await page.locator('#remSw').click();
  check('профиль: напоминания выключены и сохранены в notification_prefs (deadline_soon)', !!(await until(async () => (await prefNow()) === false)) && (await page.locator('#remSw').getAttribute('aria-checked')) === 'false');
  await page.locator('#remSw').click();
  check('профиль: напоминания снова включены', !!(await until(async () => (await prefNow()) === true)) && (await page.locator('#remSw').getAttribute('aria-checked')) === 'true');
  check('профиль: строка «Логин и пароль»', (await page.locator('#acRow[href="#/profile/account"]').count()) === 1);
  check('профиль: строка Telegram с id tgRow', (await page.locator('#tgRow').count()) === 1);
  check('профиль: «Что нового» внизу, сразу над «Выйти», с меткой «новое»', (await page.locator('#wnRow + #outBtn, .st-grp:has(#wnRow) + #outBtn').count()) === 1 && (await page.locator('#wnRow').innerText()).includes('новое'));
  await page.locator('#wnRow').click(); await h1('Что нового');
  const wn = await page.locator('.wn-list').first().locator('li').allInnerTexts();
  check('«Что нового»: текущая версия, короткие пункты в формате «Раздел: что изменилось», прошлые версии свёрнуты', wn.length >= 8 && wn.every((t) => t.includes(':') || t.length < 70) && wn.some((t) => t.startsWith('Telegram: свайп вниз')) && (await page.locator('details.st-det').count()) >= 1 && (await page.locator('details[open]').count()) === 0);
  await noHScroll('что нового');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  check('«Что нового»: прочитано до конца — событие whats_new_read в app_events (значок «Дотошный технарь»)', !!(await until(async () => (await api(`/rest/v1/app_events?user_id=eq.${uid}&kind=eq.whats_new_read&select=kind`)).length === 1)));
  await page.locator('#cabMain .j2-back').click(); await h1('Профиль');
  check('«Что нового»: после просмотра метки «новое» нет', !(await page.locator('#wnRow').innerText()).includes('новое'));
  check('профиль: «Светлая» отключена, есть пояснение', (await page.getByRole('button', { name: 'Светлая' }).isDisabled()) && pt.includes('Светлая тема появится позже'));
  await page.getByRole('button', { name: 'Фиолетовый' }).click();
  const acc = await page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue('--j-lime').trim().toUpperCase(), localStorage.getItem('t_j2_accent')]);
  check('профиль: акцентный цвет применён и сохранён', acc[0] === '#A78BFA' && acc[1] === '#A78BFA', JSON.stringify(acc));
  await page.getByRole('group', { name: 'Подгруппа' }).getByRole('button', { name: '2', exact: true }).click();
  const sg = await until(async () => (await api(`/rest/v1/students?id=eq.${SID}&select=subgroup`))[0]?.subgroup == 2);
  check('профиль: подгруппа 2 сохранилась в базе', !!sg);
  check('профиль: кнопка подгруппы 2 нажата', (await page.locator('#sgSeg button[data-sg="2"]').getAttribute('aria-pressed')) === 'true');
  await noHScroll('профиль'); await taps('профиль');
  await page.screenshot({ path: join(shots, 's-profile.png') });
  await page.reload(); await h1('Профиль');
  check('после перезагрузки акцент и подгруппа на месте', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--j-lime').trim().toUpperCase())) === '#A78BFA' && (await page.locator('#sgSeg button[data-sg="2"]').getAttribute('aria-pressed')) === 'true');
  await page.locator('a[href="#/profile/absences"]').first().click(); await h1('Пропуски');
  check('пропуски: кольцо и пороги', (await page.locator('svg.cab-ring').count()) === 1 && (await text()).includes('Деканат с'));
  await noHScroll('пропуски'); await taps('пропуски');
  // 4б. логин и пароль
  await open('#/profile/account', 'Логин и пароль');
  check('логин и пароль: у аккаунта с настоящей почтой показана почта, смены логина нет', (await text()).includes('student02@journal-test.example') && (await page.locator('#acLg').count()) === 0);
  const pwForm = async (cur, nw, rep) => {
    await page.locator('#acCur').fill(cur); await page.locator('#acNew').fill(nw); await page.locator('#acRep').fill(rep);
    await page.locator('#acPw button[type="submit"]').click();
  };
  const pwMsg = () => page.locator('#acPwMsg').innerText();
  await pwForm('', 'Newpass-12345', 'Newpass-12345');
  check('пароль: пустой текущий — ошибка', (await pwMsg()) === 'Введите текущий пароль.');
  await pwForm('x', 'short', 'short');
  check('пароль: короче 8 символов — ошибка', (await pwMsg()).includes('от 8 до 72'));
  await pwForm('x', 'Newpass-12345', 'Newpass-54321');
  check('пароль: не совпали — ошибка', (await pwMsg()) === 'Новые пароли не совпадают.');
  await pwForm('Newpass-12345', 'Newpass-12345', 'Newpass-12345');
  check('пароль: новый равен текущему — ошибка', (await pwMsg()) === 'Новый пароль совпадает с текущим.');
  await pwForm('wrong-password-1', 'Newpass-12345', 'Newpass-12345');
  check('пароль: неверный текущий — «введён неверно», пароль не менялся', !!(await until(async () => (await pwMsg()) === 'Текущий пароль введён неверно.')));
  const NEWPW = 'E2e-' + Math.random().toString(36).slice(2, 10) + '-1A';
  await pwForm(env.TEST_PASSWORD, NEWPW, NEWPW);
  check('пароль: смена прошла, сообщение об успехе', !!(await until(async () => (await page.locator('#cabToast').innerText()).includes('Пароль изменён.'))));
  const login = (password) => fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password }) }).then((r) => r.status);
  check('пароль: войти можно с новым, со старым нельзя', (await login(NEWPW)) === 200 && (await login(env.TEST_PASSWORD)) === 400);
  check('пароль: поля очищены после смены', (await page.locator('#acCur').inputValue()) === '' && (await page.locator('#acNew').inputValue()) === '');
  await noHScroll('логин и пароль'); await taps('логин и пароль');
  // у аккаунта с логином (синтетическая почта) появляется смена логина; проверяем только проверку ввода, функцию не вызываем
  await page.evaluate(() => { Cab.ctx.email = 'tester@students.journal-24dmm2.app'; Cab.rerender(); });
  await page.locator('#acLg').waitFor({ timeout: 10000 });
  check('логин: у аккаунта с синтетической почтой видна смена логина с текущим значением', (await page.locator('#acLgIn').inputValue()) === 'tester' && (await text()).includes('Сейчас: tester'));
  await page.locator('#acLgIn').fill('A!'); await page.locator('#acLg button[type="submit"]').click();
  check('логин: неверный формат — ошибка без запроса', (await page.locator('#acLgMsg').innerText()).includes('от 3 до 32 символов'));
  await page.locator('#acLgIn').fill('tester'); await page.locator('#acLg button[type="submit"]').click();
  check('логин: тот же логин — подсказка', (await page.locator('#acLgMsg').innerText()) === 'Это ваш текущий логин.');
  await page.evaluate(() => { Cab.ctx.email = 'student02@journal-test.example'; });

  // 5. уведомления
  await page.locator('.cab-tab', { hasText: 'Главная' }).click(); await page.waitForSelector('.cab-bell');
  await page.locator('.cab-bell').click(); await h1('Уведомления');
  const nt = await text();
  check('уведомления: группы «Сегодня» и «Вчера», счётчик', nt.includes('Сегодня') && nt.includes('Вчера') && /нов/.test(nt), nt.slice(0, 200));
  await page.screenshot({ path: join(shots, 's-notifications.png') });
  await noHScroll('уведомления'); await taps('уведомления');
  await page.locator('a.cab-ntf', { hasText: NT.task }).click(); await h1('Домашки');
  check('уведомление «задание»: отмечено прочитанным в базе и ведёт к домашкам', !!(await until(async () => await readAt(ids[NT.task]))));
  check('другое уведомление осталось непрочитанным', !(await readAt(ids[NT.grade])));
  await open('#/notifications', 'Уведомления');
  await page.locator('a.cab-ntf', { hasText: NT.usr }).click(); await h1('Дедлайны и УСР');
  check('уведомление про УСР ведёт в «Дедлайны и УСР» и отмечено прочитанным', !!(await until(async () => await readAt(ids[NT.usr]))));
  await open('#/notifications', 'Уведомления');
  await page.getByRole('tab', { name: 'Новые' }).click();
  check('фильтр «Новые» скрывает прочитанное', (await page.locator('a.cab-ntf', { hasText: NT.task }).count()) === 0 && (await page.locator('a.cab-ntf', { hasText: NT.grade }).count()) === 1);
  await page.getByRole('button', { name: 'Отметить всё прочитанным' }).click();
  check('«Отметить всё»: в базе не осталось непрочитанных', !!(await until(async () => (await unreadDb()) === 0)));
  await page.locator('.cab-tab', { hasText: 'Главная' }).click(); await page.waitForSelector('.cab-lesson');
  check('после «Отметить всё» значок на колокольчике исчез', (await page.locator('.cab-bell .cab-badge').count()) === 0);
  // 6. кнопка «Назад» Telegram (подделка Telegram.WebApp из addInitScript) и переключатель ролей
  await page.evaluate(() => { sessionStorage.removeItem('j2.nav'); });
  await page.reload(); await page.waitForSelector('.cab-lesson', { timeout: 30000 });
  const bb = () => page.evaluate(() => window.__bb);
  const hashNow = () => page.evaluate(() => location.hash);
  check('Назад: на корне кнопка скрыта', (await bb()) === 'hide', String(await bb()) + ' ' + (await hashNow()));
  await page.locator('.cab-tab', { hasText: 'Учёба' }).click(); await h1('Учёба');
  check('Назад: после перехода кнопка видна', (await bb()) === 'show', String(await bb()) + ' ' + (await page.evaluate(() => sessionStorage.getItem('j2.nav'))));
  await open('#/study/rating', 'Рейтинг');
  await page.evaluate(() => window.__bbClick()); await h1('Учёба');
  check('Назад: возвращает на предыдущий раздел', (await hashNow()) === '#/study');
  check('Назад: на этом экране кнопка ещё видна (стек > 1)', (await bb()) === 'show');
  await page.evaluate(() => window.__bbClick()); await page.waitForSelector('.cab-lesson', { timeout: 20000 });
  check('Назад: вернулись на корень, кнопка скрыта', (await hashNow()) === '#/home' && (await bb()) === 'hide');
  check('Назад: стек не растёт при возвратах', (await page.evaluate(() => JSON.parse(sessionStorage.getItem('j2.nav')).length)) === 1);
  await page.locator('.cab-tab', { hasText: 'Расписание' }).click(); await h1('Расписание');
  await page.locator('.cab-lesson', { hasText: subj.eco }).click(); await page.getByRole('dialog').waitFor();
  check('Назад: при открытом окне кнопка видна', (await bb()) === 'show');
  await page.evaluate(() => window.__bbClick());
  await page.waitForFunction(() => !document.querySelector('.cab-modal'), null, { timeout: 5000 });
  check('Назад: сначала закрывает окно и остаётся на экране', (await hashNow()) === '#/schedule' && (await page.getByRole('dialog').count()) === 0);
  await page.evaluate(() => window.__bbClick()); await page.waitForSelector('.cab-lesson', { timeout: 20000 });
  check('Назад: следующее нажатие уходит на предыдущий раздел', (await hashNow()) === '#/home');
  const sw1 = await page.evaluate(() => J2.roleSwitch('student', { student: true, staff: true, sysadmin: false }));
  const sw0 = await page.evaluate(() => [J2.roleSwitch('student', { student: true }), J2.roleSwitch('sysadmin', { sysadmin: true }), J2.roleSwitch('student', {})]);
  check('роли: при двух ролях ссылки на app.html и headman.html, текущая отмечена', sw1.includes('href="app.html" aria-current="page"') && sw1.includes('href="headman.html"') && !sw1.includes('sysadmin.html'), sw1);
  check('роли: при одной роли переключатель не показывается', sw0.every((x) => x === ''), JSON.stringify(sw0));
  check('роли: все три роли', (await page.evaluate(() => J2.roleSwitch('staff', { student: true, staff: true, sysadmin: true }))).split('<a ').length === 4);
  check('кабинет: ошибок JS нет', errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await PAGE.screenshot({ path: join(shots, 's-fail.png') }); console.log('url:', PAGE.url()); } catch (_) {}
} finally {
  await cleanup().catch((e) => console.log('очистка не удалась:', String(e).slice(0, 200)));
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
