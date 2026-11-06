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

async function cleanup() {
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
  ].map((t) => ({ ...t, group_id: GID }))) });
  await api('/rest/v1/grades', { method: 'POST', body: JSON.stringify([
    { id: 'gr-e2e1', group_id: GID, student_id: SID, subject: subj.mkt, lesson_kind: 'practice', value: 9, passed: null, lesson_date: D },
    { id: 'gr-e2e2', group_id: GID, student_id: SID, subject: subj.psy, lesson_kind: 'lecture', value: null, passed: true, lesson_date: '2026-11-02' }]) });
  await api('/rest/v1/certificates', { method: 'POST', body: JSON.stringify([
    { id: 'ce-e2e1', group_id: GID, student_id: SID, kind: 'sick', date_from: '2026-11-03', date_to: '2026-11-04', status: 'received' },
    { id: 'ce-e2e2', group_id: GID, student_id: SID, kind: 'statement', date_from: '2026-10-28', date_to: '2026-10-28', status: 'waiting' }]) });
  await api(`/rest/v1/notifications?user_id=eq.${uid}&created_at=gte.${startISO}`, { method: 'DELETE' });   // то, что создали триггеры при вставке выше
  const NT = { task: 'Горит домашка' + SUF, grade: 'Новая оценка' + SUF, abs: 'Внесён пропуск' + SUF };
  await api('/rest/v1/notifications', { method: 'POST', body: JSON.stringify([
    { user_id: uid, group_id: GID, kind: 'task', title: NT.task, body: 'Эконометрика, срок завтра', created_at: '2026-11-05T06:00:00Z', read_at: null },
    { user_id: uid, group_id: GID, kind: 'grade', title: NT.grade, body: 'Маркетинг услуг: 9', created_at: '2026-11-05T05:30:00Z', read_at: null },
    { user_id: uid, group_id: GID, kind: 'absence', title: NT.abs, body: 'Психология, 2 часа', created_at: '2026-11-04T10:00:00Z', read_at: '2026-11-04T11:00:00Z' }]) });
  const ids = Object.fromEntries((await api(`/rest/v1/notifications?user_id=eq.${uid}&title=like.*${encodeURIComponent(SUF)}&select=id,kind`)).map((n) => [n.kind, n.id]));
  const unreadDb = async () => (await api(`/rest/v1/notifications?user_id=eq.${uid}&read_at=is.null&select=id`)).length;
  const readAt = async (id) => (await api(`/rest/v1/notifications?id=eq.${id}&select=read_at`))[0]?.read_at;

  // ----- страница -----
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.endsWith('/cab-core.js') || u.includes('/cab-core.js?')) return route.fulfill({ contentType: 'text/javascript', body: CAB_JS });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v, now]) => { try { localStorage.setItem(k, v); } catch (e) {} window.__NOW = now; }, [KEY, JSON.stringify(ses), NOW]);
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
  const unr = await unreadDb();
  check('главная: колокольчик показывает число новых', (await page.locator('.cab-bell .cab-badge').innerText()) === String(unr), `${unr}`);
  if ((await page.locator('.cab-lesson').count()) === 4 && tiles === 3) {
    const bottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll('#cabMain *')].map((e) => e.getBoundingClientRect().bottom)));
    check('главная: 4 пары и 3 плитки помещаются над нижней панелью без прокрутки', bottom <= 844 - 82, `низ контента ${Math.round(bottom)} px`);
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
  check('учёба: «Рейтинг» и «Игры» ведут в старый журнал', hrefs.includes('index.html#zachetka') && hrefs.includes('index.html#games'), hrefs.join(','));
  await noHScroll('учёба'); await taps('учёба');
  await page.screenshot({ path: join(shots, 's-study.png') });
  await page.locator('.cab-row', { hasText: 'Домашки и УСР' }).click(); await h1('Домашки и УСР');
  check('домашки: задание видно, ссылка безопасна', (await text()).includes(subj.eco) && (await page.locator('a.st-a[href="https://example.com/task"][target="_blank"][rel~="noopener"][rel~="noreferrer"]').count()) === 1);
  check('домашки: разметка в тексте не превращается в теги', (await page.locator('.st-text b').count()) === 0 && (await text()).includes('<b>x</b>'));
  check('домашки: просроченное лежит в архиве', await page.locator('details.st-det summary', { hasText: 'Архив' }).count() === 1);
  await noHScroll('домашки'); await taps('домашки');
  await open('#/study/deadlines', 'Дедлайны'); check('дедлайны: задание видно', (await text()).includes('эссе'));
  await open('#/study/exams', 'Зачёты и экзамены'); check('экзамены: видно время и аудиторию', (await text()).includes('Экзамен 12:00, ауд. 310'));
  await open('#/study/grades', 'Оценки'); const gt = await text();
  check('оценки: балл и «зачтено», без среднего', gt.includes(subj.mkt) && /\b9\b/.test(gt) && gt.includes('зачтено') && !/средн/i.test(gt), gt.slice(0, 200));
  await open('#/study/teachers', 'Преподаватели'); check('преподаватели: из расписания', (await text()).includes(`Лекции: ${TEACHER}`) || (await text()).includes(TEACHER));
  await noHScroll('оценки и преподаватели'); await taps('преподаватели');

  // 4. профиль
  await page.locator('.cab-tab', { hasText: 'Профиль' }).click(); await h1('Профиль');
  const pt = await text();
  check('профиль: имя и группа', pt.includes('Студент, группа 24ДММ-2'));
  check('профиль: справки со статусом словами', pt.includes('Больничный, 3–4 ноября') && pt.includes('подтверждена') && pt.includes('Заявление, 28 октября') && pt.includes('не подтверждена'), pt.slice(0, 300));
  check('профиль: кабинета старосты у обычного студента нет', (await page.locator('a[href="headman.html"]').count()) === 0);
  check('профиль: строка Telegram с id tgRow', (await page.locator('#tgRow').count()) === 1);
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

  // 5. уведомления
  await page.locator('.cab-tab', { hasText: 'Главная' }).click(); await page.waitForSelector('.cab-bell');
  await page.locator('.cab-bell').click(); await h1('Уведомления');
  const nt = await text();
  check('уведомления: группы «Сегодня» и «Вчера», счётчик', nt.includes('Сегодня') && nt.includes('Вчера') && /нов/.test(nt), nt.slice(0, 200));
  await page.screenshot({ path: join(shots, 's-notifications.png') });
  await noHScroll('уведомления'); await taps('уведомления');
  await page.locator('a.cab-ntf', { hasText: NT.task }).click(); await h1('Домашки и УСР');
  check('уведомление «задание»: отмечено прочитанным в базе и ведёт к домашкам', !!(await until(async () => await readAt(ids.task))));
  check('другое уведомление осталось непрочитанным', !(await readAt(ids.grade)));
  await open('#/notifications', 'Уведомления');
  await page.getByRole('tab', { name: 'Новые' }).click();
  check('фильтр «Новые» скрывает прочитанное', (await page.locator('a.cab-ntf', { hasText: NT.task }).count()) === 0 && (await page.locator('a.cab-ntf', { hasText: NT.grade }).count()) === 1);
  await page.getByRole('button', { name: 'Отметить всё прочитанным' }).click();
  check('«Отметить всё»: в базе не осталось непрочитанных', !!(await until(async () => (await unreadDb()) === 0)));
  await page.locator('.cab-tab', { hasText: 'Главная' }).click(); await page.waitForSelector('.cab-lesson');
  check('после «Отметить всё» значок на колокольчике исчез', (await page.locator('.cab-bell .cab-badge').count()) === 0);
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
