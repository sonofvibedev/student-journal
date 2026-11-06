// Кабинет преподавателя (teacher.html) на ТЕСТОВОМ проекте, на настоящей базе и в настоящем браузере (390x844).
// Запуск: node tests/e2e/teacher.mjs   (после npm run test:migrate и npm run test:reset; CHROME_PATH — путь к Chromium)
// Прод не затрагивается: env.js подменяется, любой запрос к прод-ref обрывается, цель проверяет guard.
// «Сейчас» закреплено: чт 5 ноября 2026, 11:40 по Минску (подмена Cab.testNow в cab-core.js на лету).
// Аккаунты: teacher-lecture@ и teacher-practice@journal-test.example (создаёт seed-test.mjs в test:reset).
// Фикстуры (комментарий/текст E2E) создаются сервисным ключом в начале и удаляются в конце.
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
if (!ANON || !SERVICE || !env.TEST_PASSWORD) { console.error('Нет ключей или пароля в .env.test: запустите npm run test:reset'); process.exit(2); }

const G = '00000000-0000-4000-8000-000000000024';
const NOW = Date.UTC(2026, 10, 5, 8, 40);              // 11:40 по Минску (UTC+3)
const TODAY = '2026-11-05';
const OTHER_T = '00000000-0000-4000-8000-0000000000ee';   // «другой преподаватель»: чужой created_by
const SUBJ = 'Эконометрика';

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

const results = [];
const LOGS = []; let LASTPAGE = null;
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const shots = resolve(process.env.TEMP ?? '.', 'teacher-e2e'); mkdirSync(shots, { recursive: true });

const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => { const r = await fetch(URL_SB + path, { ...init, headers: { ...SVC, Prefer: 'return=representation', ...(init.headers ?? {}) } }); const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) { /* не json */ } if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)} → ${r.status} ${String(t).slice(0, 200)}`); return j; };
const get = (path) => api(`/rest/v1/${path}`);
const post = (table, rows) => api(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows) });
const patch = (path, body) => api(`/rest/v1/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => api(`/rest/v1/${path}`, { method: 'DELETE' });
async function session(email, password) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  return r.access_token ? r : null;
}
const initials = (s) => `${s.last_name} ${s.first_name.charAt(0)}.`;
const re = (s) => new RegExp('^\\s*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');

async function open(browser, ses, page0 = 'teacher.html', hash = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.endsWith('/cab-core.js')) {     // «сейчас» = 5 ноября 11:40: cab-core сам сбрасывает testNow в null, поэтому подменяем строку
      const src = readFileSync('cab-core.js', 'utf8').replace('Cab.testNow = null;', `Cab.testNow = ${NOW};`);
      return route.fulfill({ contentType: 'text/javascript', body: src });
    }
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(ses)]);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 220); LOGS.push(t); if (m.type() === 'error' && /\[(cab|teacher)\]/.test(m.text())) errs.push(t); });
  LASTPAGE = page;
  await page.goto(`${BASE}/${page0}${hash}`);
  return { page, errs, ctx };
}

// Экран открыт, когда в нём есть нужный текст
const go = async (page, hash, text) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.locator('#cabMain').getByText(text).first().waitFor({ timeout: 30000 }); };
const noHScroll = async (page, label) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= w[1], JSON.stringify(w)); };
// Нажимаемое не меньше 44 px: для полей берём подпись-обёртку (label)
async function taps(page, label) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('#cab a[href], #cab button, #cab select, #cab input, #cab [role=tab]')].map((el) => {
    if (el.closest('.sr-only, .j2-hidden')) return null;
    const box = (el.closest('label') || el).getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.height < 43.9 ? `${el.tagName}.${el.className}|${(el.textContent || el.id).trim().slice(0, 20)}|${Math.round(box.height)}` : null;
  }).filter(Boolean));
  check(`${label}: нажимаемое не ниже 44 px`, bad.length === 0, bad.slice(0, 5).join('; '));
}
const sheetBtn = (page, name) => page.locator('.cab-sheet').getByRole('button', { name });
const toastText = (page, text) => page.locator('#cabToast', { hasText: text }).waitFor({ timeout: 20000 });
const pollDb = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 500)); } };
const idle = (page) => page.waitForLoadState('networkidle').catch(() => {});

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const orig = [];     // исходные фамилии студентов: возвращаем в finally
let tuids = [];
const wipe = async () => {      // идемпотентно: чистит и остатки прошлых запусков
  await del(`absences?group_id=eq.${G}&comment=like.E2E*`).catch(() => {});
  for (const u of tuids) await del(`absences?group_id=eq.${G}&created_by=eq.${u}`).catch(() => {});
  await del(`grades?group_id=eq.${G}&comment=like.E2E*`).catch(() => {});
  await del(`lesson_notes?group_id=eq.${G}&topic=like.E2E*`).catch(() => {});
  await del(`schedule_lessons?group_id=eq.${G}`).catch(() => {});   // всё расписание группы: настоящее из ручного импорта мешает фикстуре
  await del(`tasks?group_id=eq.${G}&rec-%3E%3Etext=like.E2E*`).catch(() => {});
};
try {
  // ---------- фикстуры ----------
  const tl = await session('teacher-lecture@journal-test.example', env.TEST_PASSWORD);
  const tp = await session('teacher-practice@journal-test.example', env.TEST_PASSWORD);
  if (!tl || !tp) throw new Error('нет аккаунтов преподавателей: запустите npm run test:reset');
  tuids = [tl.user.id, tp.user.id];
  check('преподаватели вошли', true);
  for (const u of tuids) await patch(`memberships?user_id=eq.${u}&group_id=eq.${G}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' }).catch(() => {});
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id,student_id`);
  if (!heads.length) throw new Error('в группе 24ДММ-2 нет старосты: запустите npm run test:reset');
  const HU = heads[0].user_id;
  const plain = await session('student02@journal-test.example', env.TEST_PASSWORD);
  const plainMem = plain ? await get(`memberships?user_id=eq.${plain.user.id}&select=student_id`) : [];
  const skip = new Set([heads[0].student_id, ...plainMem.map((m) => m.student_id)]);
  const all = await get(`students?group_id=eq.${G}&claim_status=eq.active&select=id,last_name,first_name,claimed_by&order=sort`);
  const total = (await get(`students?group_id=eq.${G}&select=id`)).length;
  // студенты без пропусков в окне теста (перенос из прода): иначе счётчики не сойдутся
  const busy = new Set((await get(`absences?group_id=eq.${G}&date=gte.2026-10-25&select=student_id`)).map((a) => a.student_id));
  const pool = all.filter((s) => s.last_name && s.first_name && !skip.has(s.id) && !busy.has(s.id));
  const NAMES = ['Лисин', 'Ежов', 'Зайцев', 'Орлов', 'Волков'];
  const five = pool.slice(0, 5);
  if (five.length < 5) throw new Error('в группе мало студентов для теста');
  five.forEach((s, i) => { orig.push({ id: s.id, last_name: s.last_name }); s.last_name = NAMES[i]; });
  for (const s of five) await patch(`students?id=eq.${s.id}`, { last_name: s.last_name });
  const [S1, S2, S3, S4, S5] = five;
  await wipe();
  const lesson = (date, pair, a, b, subject, kind, room) => ({ group_id: G, lesson_date: date, pair_no: pair, starts_at: a, ends_at: b, subject, kind, teacher: 'Тестов Т.Т.', room });
  await post('schedule_lessons', [
    lesson(TODAY, 3, '11:15', '12:35', SUBJ, 'lecture', '304'),
    lesson(TODAY, 4, '12:50', '14:10', SUBJ, 'practice', '305'),
    lesson('2026-11-12', 3, '11:15', '12:35', SUBJ, 'lecture', '304'),
    lesson('2026-10-29', 3, '11:15', '12:35', SUBJ, 'lecture', '304'),
    lesson('2026-11-04', 2, '09:35', '10:55', 'Маркетинг услуг', 'lecture', '210'),
  ]);
  const ab = (s, kind, by) => ({ group_id: G, student_id: s.id, date: TODAY, subject: SUBJ, hours: 2, lesson_kind: kind, created_by: by, comment: 'E2E' });
  await post('absences', [ab(S3, 'lecture', HU), ab(S4, 'practice', HU), ab(S5, 'lecture', OTHER_T)]);
  const task = (id, by, subject, text) => ({ id, kind: 'homework', group_id: G, created_by: by, rec: { id, subject, type: 'ПЗ', text, dueDate: '2026-11-12', subgroup: 0, createdAt: new Date().toISOString() } });
  await post('tasks', [task('hw-e2e-hm-1', HU, SUBJ, 'E2E задание старосты')]);

  // ---------- 1. четыре вкладки, главная ----------
  const h = await open(browser, tl);
  const p = h.page;
  await p.getByRole('heading', { name: 'Кабинет преподавателя' }).waitFor({ timeout: 30000 });
  const body = () => p.locator('#cabMain').innerText();
  const home = await body();
  check('главная: подпись «Преподаватель, <предметы>» и дата', /Преподаватель, .*Эконометрика/.test(home) && /Чт, 5 ноября/.test(home), home.slice(0, 160));
  check('главная: «Сейчас идёт лекция», группа, аудитория', /Сейчас идёт лекция/.test(home) && /24ДММ-2/.test(home) && /ауд\.\s*304/.test(home), home.slice(0, 260));
  check('главная: «Мои группы», «Домашки и дедлайны», строка «Староста 24ДММ-2»', /Мои группы/.test(home) && /Домашки и дедлайны/.test(home) && /Староста 24ДММ-2/.test(home));
  check('главная: плиток тестов нет', !/Активные тесты|Ждут проверки|Создать тест/.test(home));
  check('нижняя панель: четыре вкладки', await p.locator('.cab-tab').count() === 4);
  await noHScroll(p, 'главная'); await taps(p, 'главная'); await p.screenshot({ path: join(shots, 't1-home.png') });
  await go(p, '#/groups', 'Написать старосте');
  const gtext = await body();
  check('группы: карточка 24ДММ-2, «Список», метрики', /24ДММ-2/.test(gtext) && /посещаемость/.test(gtext) && /за неделю/.test(gtext) && await p.getByRole('button', { name: 'Список' }).count() === 1, gtext.slice(0, 200));
  await noHScroll(p, 'группы'); await taps(p, 'группы'); await p.screenshot({ path: join(shots, 't2-groups.png') });
  await p.getByRole('button', { name: 'Список' }).click();
  await p.locator('.cab-sheet').getByText(initials(S1)).first().waitFor({ timeout: 15000 }).catch(() => {});
  check('группы: «Список» открывает лист со студентами', (await p.locator('.cab-sheet').innerText()).includes(S1.last_name));
  await sheetBtn(p, 'Закрыть').click();

  // ---------- 2. журнал: занятия ----------
  await go(p, '#/journal', 'Предмет и группа');
  await p.selectOption('#tcSel', `${G}|${SUBJ}`);
  await p.locator('#tcTopic').waitFor();
  check('занятия: выбор «предмет и группа», тема и план, «Другие занятия»', /Сегодня, 11:15, ауд\. 304/.test(await body()) && /Другие занятия/.test(await body()) && /тема не указана/.test(await body()), (await body()).slice(0, 300));
  await noHScroll(p, 'занятия'); await taps(p, 'занятия'); await p.screenshot({ path: join(shots, 't3-lessons.png') });
  await p.fill('#tcTopic', 'E2E Стационарность'); await p.fill('#tcPlan', 'E2E 1. Определение. 2. Тест Дики-Фуллера.');
  await p.getByRole('button', { name: 'Сохранить тему и план' }).click();
  await toastText(p, 'Тема и план сохранены');
  const note = (await pollDb(async () => { const r = await get(`lesson_notes?group_id=eq.${G}&lesson_date=eq.${TODAY}&pair_no=eq.3&select=subject,topic,plan`); return r.length ? r : null; }))?.[0];
  check('lesson_notes: запись создана (предмет, тема, план)', note && note.subject === SUBJ && note.topic === 'E2E Стационарность' && /Дики-Фуллера/.test(note.plan), JSON.stringify(note));
  await p.fill('#tcTopic', 'E2E Стационарность 2');                      // повторное сохранение: upsert, а не вторая строка
  await p.getByRole('button', { name: 'Сохранить тему и план' }).click();
  await toastText(p, 'Тема и план сохранены');
  const notes2 = await pollDb(async () => { const r = await get(`lesson_notes?group_id=eq.${G}&lesson_date=eq.${TODAY}&pair_no=eq.3&select=topic`); return r[0]?.topic === 'E2E Стационарность 2' ? r : null; }) ?? await get(`lesson_notes?group_id=eq.${G}&lesson_date=eq.${TODAY}&pair_no=eq.3&select=topic`);
  check('lesson_notes: повтор — одна строка с новой темой (upsert)', notes2.length === 1 && notes2[0].topic === 'E2E Стационарность 2', JSON.stringify(notes2));
  // перезагрузка: открываем другое занятие и возвращаемся к сегодняшнему
  await p.locator('.tc-line', { hasText: '12 ноября' }).click();
  await p.getByRole('heading', { name: /12 ноября, 11:15/ }).waitFor({ timeout: 20000 });
  check('занятия: сохранённое занятие в списке помечено «готово», остальные «добавить»', /готово/.test(await p.locator('.tc-line', { hasText: '5 ноября' }).innerText()) && /добавить/.test(await p.locator('.tc-line', { hasText: '29 октября' }).innerText()));
  await p.locator('.tc-line', { hasText: '5 ноября' }).click();
  await p.getByRole('heading', { name: /Сегодня, 11:15/ }).waitFor({ timeout: 20000 });
  check('занятия: тема и план читаются из базы после перезагрузки экрана', await p.inputValue('#tcTopic') === 'E2E Стационарность 2' && /Дики-Фуллера/.test(await p.inputValue('#tcPlan')));

  // ---------- 3. журнал: посещаемость ----------
  await go(p, '#/journal/attendance', 'Отсутствуют');
  await p.locator('.tc-row').first().waitFor();
  const pairOpts = await p.locator('#tcPair option').allInnerTexts();
  check('посещаемость: пары только лекции (практических нет)', pairOpts.length >= 2 && pairOpts.filter((t) => !/Другое/.test(t)).every((t) => /лекция/.test(t) && !/практическое/.test(t)), JSON.stringify(pairOpts));
  check('посещаемость: выбрана идущая пара (5 ноября, 11:15, лекция, 2 ч)', /5 ноября, 11:15, лекция, 2 ч/.test(await p.locator('#tcPair option:checked').innerText()));
  const row = (s) => p.locator('.tc-row').filter({ has: p.locator('b', { hasText: re(initials(s)) }) });
  await row(S3).getByText('внёс: староста').waitFor({ timeout: 15000 });
  check(`посещаемость: счётчик «Отсутствуют: 2 из ${total}» (записи старосты и другого преподавателя)`, (await p.locator('#tcCnt').innerText()) === `Отсутствуют: 2 из ${total}`, await p.locator('#tcCnt').innerText());
  check('запись старосты: «внёс: староста», «Отменить» есть', await row(S3).getByRole('button', { name: /Отменить/ }).count() === 1);
  check('запись другого преподавателя: «внёс: другой преподаватель», «Отменить» нет, «Уважительный» есть', /другой преподаватель/.test(await row(S5).innerText()) && await row(S5).getByRole('button', { name: /Отменить/ }).count() === 0 && await row(S5).getByRole('button', { name: /Уважительный/ }).count() === 1);
  check('пропуск практики (вид практики) лектору не виден: студент «был»', /был/.test(await row(S4).innerText()) && !/внёс/.test(await row(S4).innerText()));
  await noHScroll(p, 'посещаемость'); await taps(p, 'посещаемость'); await p.screenshot({ path: join(shots, 't4-attendance.png') });
  await row(S1).locator('button.mark').click(); await row(S2).locator('button.mark').click();
  check('отмеченный показывает «Н, 2 ч»', /Н, 2 ч/.test(await row(S1).locator('button.mark').innerText()));
  await p.getByRole('button', { name: /Сохранить, отсутствуют 2/ }).click();
  await toastText(p, 'Внесено: 2');
  const mine = await pollDb(async () => { const r = await get(`absences?group_id=eq.${G}&created_by=eq.${tl.user.id}&select=student_id,date,hours,lesson_kind,subject,is_excused`); return r.length >= 2 ? r : null; }) ?? [];
  check('2 пропуска в базе: вид lecture, предмет, дата, 2 ч, не уважительные', mine.length === 2 && mine.every((a) => a.lesson_kind === 'lecture' && a.subject === SUBJ && a.date === TODAY && Number(a.hours) === 2 && a.is_excused === false)
    && mine.some((a) => a.student_id === S1.id) && mine.some((a) => a.student_id === S2.id), JSON.stringify(mine));
  await row(S1).getByText('внёс: вы').waitFor({ timeout: 15000 });
  check('после сохранения свои записи помечены «внёс: вы», счётчик 4', (await p.locator('#tcCnt').innerText()) === `Отсутствуют: 4 из ${total}`, await p.locator('#tcCnt').innerText());
  // «Уважительный»
  await row(S1).getByRole('button', { name: /Уважительный/ }).click();
  await toastText(p, 'уважительный');
  const ex1 = await pollDb(async () => { const r = await get(`absences?student_id=eq.${S1.id}&subject=eq.${encodeURIComponent(SUBJ)}&date=eq.${TODAY}&select=is_excused`); return r[0]?.is_excused ? r : null; });
  check('«Уважительный» ставит is_excused в своей записи', !!ex1);
  await row(S5).getByRole('button', { name: /Уважительный/ }).click();
  const ex5 = await pollDb(async () => { const r = await get(`absences?student_id=eq.${S5.id}&subject=eq.${encodeURIComponent(SUBJ)}&date=eq.${TODAY}&select=is_excused`); return r[0]?.is_excused ? r : null; });
  check('«Уважительный» работает и в записи другого преподавателя своей дисциплины', !!ex5);
  check('строка с уважительным пропуском подписана «уважительный»', /уважительный/.test(await row(S1).innerText()));
  // отмена своей записи
  await row(S2).getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить пропуск').click();
  await toastText(p, 'Пропуск отменён');
  const aft = await get(`absences?group_id=eq.${G}&created_by=eq.${tl.user.id}&select=student_id`);
  check('отмена своей записи удалила её из базы', aft.length === 1 && aft[0].student_id === S1.id, JSON.stringify(aft));
  // отмена записи старосты
  await row(S3).getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить пропуск').click();
  await toastText(p, 'Пропуск отменён');
  // тост от прошлой отмены ещё на экране, поэтому ждём саму базу, а не текст
  check('запись старосты своей дисциплины отменена преподавателем', !!(await pollDb(async () => (await get(`absences?group_id=eq.${G}&student_id=eq.${S3.id}&date=eq.${TODAY}&select=id`)).length === 0 || null)));
  check('пропуск практики (старосты) в базе остался нетронутым', (await get(`absences?group_id=eq.${G}&student_id=eq.${S4.id}&lesson_kind=eq.practice&select=id`)).length === 1);
  check('запись другого преподавателя осталась на месте', (await get(`absences?group_id=eq.${G}&student_id=eq.${S5.id}&date=eq.${TODAY}&select=id`)).length === 1);

  // ---------- 4. журнал: оценки ----------
  await go(p, '#/journal/grades', 'Сохранить отметки');
  await idle(p);
  check('оценки: переключатель режима, тема, дата, отметки по студентам', await p.getByRole('tab', { name: '1–10' }).count() === 1 && await p.getByRole('tab', { name: 'зачтено / не зачтено' }).count() === 1
    && await p.locator('#tcTopic').count() === 1 && await p.locator('select.tc-sel').count() === total && /лекционные/.test(await body()));
  await noHScroll(p, 'оценки'); await taps(p, 'оценки'); await p.screenshot({ path: join(shots, 't5-grades.png') });
  await p.fill('#tcTopic', 'E2E Тест 2'); await p.locator('#tcTopic').blur();
  await idle(p); await p.waitForTimeout(400);
  const pick = (s, v) => p.locator(`select[data-s="${s.id}"]`).selectOption(v);
  await pick(S1, '10'); await pick(S2, '6'); await pick(S3, '9');
  await p.getByRole('button', { name: 'Сохранить отметки' }).click();
  await toastText(p, 'Сохранено: 3');
  const gr = await pollDb(async () => { const r = await get(`grades?group_id=eq.${G}&comment=eq.${encodeURIComponent('E2E Тест 2')}&select=student_id,value,passed,subject,lesson_kind,lesson_date`); return r.length >= 3 ? r : null; }) ?? [];
  const val = (s, rows = gr) => rows.find((r) => r.student_id === s.id)?.value;
  check('оценки: 3 строки (предмет, вид lecture, дата, значения 10, 6, 9)', gr.length === 3 && gr.every((r) => r.subject === SUBJ && r.lesson_kind === 'lecture' && r.lesson_date === TODAY && r.passed === null) && val(S1) === 10 && val(S2) === 6 && val(S3) === 9, JSON.stringify(gr));
  await idle(p);
  check('оценки: после сохранения значения читаются с сервера', await p.locator(`select[data-s="${S1.id}"]`).inputValue() === '10');
  // правка и очистка
  await pick(S1, '8'); await pick(S3, '');
  await p.getByRole('button', { name: 'Сохранить отметки' }).click();
  await toastText(p, 'Сохранено: 2');
  const gr2 = await pollDb(async () => { const r = await get(`grades?group_id=eq.${G}&comment=eq.${encodeURIComponent('E2E Тест 2')}&select=student_id,value`); return r.length === 2 ? r : null; }) ?? await get(`grades?group_id=eq.${G}&comment=eq.${encodeURIComponent('E2E Тест 2')}&select=student_id,value`);
  check('оценки: правка (10 → 8) сохранена, S2 без изменений, очищенная удалена', gr2.length === 2 && val(S1, gr2) === 8 && val(S2, gr2) === 6 && val(S3, gr2) === undefined, JSON.stringify(gr2));
  await p.getByRole('tab', { name: 'зачтено / не зачтено' }).click();
  check('оценки: режим «зачтено / не зачтено» даёт варианты зачтено и не зачтено', (await p.locator(`select[data-s="${S4.id}"] option`).allInnerTexts()).join('|') === '—|зачтено|не зачтено');
  await p.getByRole('tab', { name: '1–10' }).click();

  // ---------- 5. задания ----------
  await go(p, '#/tasks', 'Добавить домашку или дедлайн');
  await noHScroll(p, 'задания'); await taps(p, 'задания'); await p.screenshot({ path: join(shots, 't6-tasks.png') });
  const hm = p.locator('.cab-card', { hasText: 'E2E задание старосты' });
  check('задание старосты своего предмета видно, подписано «от старосты»', await hm.count() === 1 && /от старосты/.test(await hm.innerText()));
  await p.getByRole('tab', { name: 'Мои' }).click();
  check('фильтр «Мои» прячет задание старосты', await p.locator('.cab-card', { hasText: 'E2E задание старосты' }).count() === 0);
  await p.getByRole('tab', { name: 'От старосты' }).click();
  check('фильтр «От старосты» показывает его', await p.locator('.cab-card', { hasText: 'E2E задание старосты' }).count() === 1);
  await p.getByRole('tab', { name: 'Все' }).click();
  await p.getByRole('button', { name: /Добавить домашку или дедлайн/ }).click();
  const subOpts = await p.locator('#tfS option').allInnerTexts();
  check('форма задания: предметы только из назначений преподавателя', subOpts.length === 2 && subOpts.includes(SUBJ) && subOpts.includes('Маркетинг услуг'), JSON.stringify(subOpts));
  await p.locator('#tfT').selectOption('ПЗ');
  await p.locator('#tfS').selectOption({ label: SUBJ });
  await p.fill('#tfX', 'E2E домашка преподавателя'); await p.fill('#tfD', '2026-11-10'); await p.locator('#tfA').selectOption('0');
  await noHScroll(p, 'лист задания'); await taps(p, 'лист задания'); await p.screenshot({ path: join(shots, 't7-task.png') });
  await p.click('#tfOk');
  await toastText(p, 'Задание добавлено');
  const t1 = (await pollDb(async () => { const r = await get(`tasks?rec-%3E%3Etext=eq.${encodeURIComponent('E2E домашка преподавателя')}&select=id,kind,group_id,created_by,rec`); return r.length ? r : null; }))?.[0];
  check('задание создано: kind, группа, автор-преподаватель, предмет, rec.id = id', t1 && t1.kind === 'homework' && t1.group_id === G && t1.created_by === tl.user.id && t1.rec.id === t1.id && /^hw-\d+$/.test(t1.id) && t1.rec.subject === SUBJ && t1.rec.dueDate === '2026-11-10', JSON.stringify(t1));
  const tc = p.locator('.cab-card', { hasText: 'E2E домашка преподавателя' });
  check('своё задание подписано «внесли вы»', /внесли вы/.test(await tc.innerText()));
  await tc.getByRole('button', { name: /Изменить/ }).click();
  await p.fill('#tfX', 'E2E домашка преподавателя 2'); await p.locator('#tfA').selectOption('1');
  await p.click('#tfOk');
  await toastText(p, 'Задание изменено');
  const t2 = (await pollDb(async () => { const r = await get(`tasks?id=eq.${t1.id}&select=rec`); return r[0]?.rec?.text === 'E2E домашка преподавателя 2' ? r : null; }))?.[0];
  check('правка задания сохранилась (текст, подгруппа), id и createdAt прежние', t2?.rec.text === 'E2E домашка преподавателя 2' && t2.rec.subgroup === 1 && t2.rec.id === t1.id && t2.rec.createdAt === t1.rec.createdAt, JSON.stringify(t2));
  await p.locator('.cab-card', { hasText: 'E2E домашка преподавателя 2' }).getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить задание').click();
  await toastText(p, 'Задание отменено');
  check('отмена своего задания удалила запись', (await get(`tasks?id=eq.${t1.id}&select=id`)).length === 0);
  await p.locator('.cab-card', { hasText: 'E2E задание старосты' }).getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить задание').click();
  await toastText(p, 'Задание отменено');
  check('задание старосты по своему предмету отменено преподавателем', !!(await pollDb(async () => (await get('tasks?id=eq.hw-e2e-hm-1&select=id')).length === 0 || null)));

  // ---------- 6. тесты (заглушка) и чат ----------
  await go(p, '#/tests', 'Тесты появятся в следующем обновлении');
  check('тесты: спокойная заглушка, без плиток', !/Активные тесты|Создать тест/.test(await body()));
  await noHScroll(p, 'тесты'); await taps(p, 'тесты');
  await p.evaluate(() => { location.hash = '#/chat'; });      // текст чата определяет chat-ui.js, ждём любое содержимое
  await p.waitForFunction(() => { const t = document.querySelector('#cabMain').innerText.trim(); return t.length > 0 && !/^Загружаем/.test(t); }, null, { timeout: 30000 });
  const hasChat = await p.evaluate(() => !!window.ChatUI);
  check(hasChat ? 'чат: ChatUI подключён, экран не пустой' : 'чат: без chat-ui.js — «Чат недоступен»', hasChat ? (await body()).trim().length > 0 : /Чат недоступен/.test(await body()), (await body()).slice(0, 120));
  await noHScroll(p, 'чат'); await taps(p, 'чат'); await p.screenshot({ path: join(shots, 't8-chat.png') });

  check('кабинет преподавателя: ошибок JS нет', h.errs.length === 0, h.errs.join(' | ').slice(0, 300));
  await h.ctx.close();

  // ---------- 7. преподаватель практики видит только практику ----------
  const q2 = await open(browser, tp, 'teacher.html', '#/journal/attendance');
  const pp = q2.page;
  await pp.locator('#cabMain').getByText('Предмет и группа').first().waitFor({ timeout: 30000 });
  await pp.selectOption('#tcSel', `${G}|${SUBJ}`);
  await pp.locator('#tcPair').waitFor();
  await pp.locator('.tc-row').first().waitFor();
  const po = await pp.locator('#tcPair option').allInnerTexts();
  check('практик: пары только практические, лекций нет', po.filter((t) => !/Другое/.test(t)).length >= 1 && po.filter((t) => !/Другое/.test(t)).every((t) => /практическое/.test(t) && !/лекция/.test(t)), JSON.stringify(po));
  const prow = (s) => pp.locator('.tc-row').filter({ has: pp.locator('b', { hasText: re(initials(s)) }) });
  await prow(S4).getByText('внёс: староста').waitFor({ timeout: 15000 });
  check('практик: запись старосты по практике видна, лекционные записи не видны', await prow(S4).getByRole('button', { name: /Отменить/ }).count() === 1 && /был/.test(await prow(S5).innerText()) && !/внёс/.test(await prow(S5).innerText()));
  check('практик: «Отсутствуют: 1 из N»', (await pp.locator('#tcCnt').innerText()) === `Отсутствуют: 1 из ${total}`, await pp.locator('#tcCnt').innerText());
  await noHScroll(pp, 'практик, посещаемость'); await taps(pp, 'практик, посещаемость');
  check('практик: ошибок JS нет', q2.errs.length === 0, q2.errs.join(' | ').slice(0, 300));
  await q2.ctx.close();

  // ---------- 8. обычный студент не попадает в кабинет преподавателя ----------
  if (plain) {
    const s = await open(browser, plain);
    await s.page.waitForURL(/app\.html/, { timeout: 30000 }).then(() => check('обычный студент с teacher.html уходит на app.html', true)).catch(() => check('обычный студент с teacher.html уходит на app.html', false, s.page.url()));
    await s.ctx.close();
  } else check('обычный студент с teacher.html уходит на app.html', false, 'нет аккаунта student02@journal-test.example');
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await LASTPAGE.screenshot({ path: join(shots, 't-fail.png') }); console.log('url:', LASTPAGE.url()); } catch (_) { /* страницы уже нет */ }
} finally {
  try {
    await wipe();
    await del('tasks?id=eq.hw-e2e-hm-1').catch(() => {});
    for (const o of orig) await patch(`students?id=eq.${o.id}`, { last_name: o.last_name }).catch(() => {});
  } catch (e) { console.log('Чистка не завершена:', String(e).slice(0, 200)); }
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}. Скриншоты: ${shots}`);
process.exit(failed.length ? 1 : 0);
