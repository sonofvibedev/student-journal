// Кабинет старосты (headman.html) на ТЕСТОВОМ проекте, на настоящей базе и в настоящем браузере (390x844).
// Запуск: node tests/e2e/headman.mjs   (после npm run test:migrate и npm run test:reset; CHROME_PATH — путь к Chromium)
// Прод не затрагивается: env.js подменяется, любой запрос к прод-ref обрывается, цель проверяет guard.
// «Сейчас» закреплено: чт 5 ноября 2026, 11:40 по Минску (подмена Cab.testNow в cab-core.js на лету).
// Фикстуры (всё с пометкой E2E) создаются сервисным ключом в начале и удаляются в конце.
import { readFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
const TEACHER = '00000000-0000-4000-8000-0000000000ee';   // «преподаватель»: чужой created_by

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
const shots = resolve(process.env.TEMP ?? '.', 'headman-e2e'); mkdirSync(shots, { recursive: true });

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

async function open(browser, ses, hash = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.split('?')[0].endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.split('?')[0].endsWith('/cab-core.js')) {     // «сейчас» = 5 ноября 11:40: cab-core сам сбрасывает testNow в null, поэтому подменяем строку
      const src = readFileSync('cab-core.js', 'utf8').replace('Cab.testNow = null;', `Cab.testNow = ${NOW};`);
      return route.fulfill({ contentType: 'text/javascript', body: src });
    }
    if (u.includes('/vendor/telegram-web-app.js')) return route.abort();   // в тестах Telegram подделан, настоящий скрипт его бы затёр
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(ses)]);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 220); LOGS.push(t); if (m.type() === 'error' && /\[(cab|headman)\]/.test(m.text())) errs.push(t); });
  LASTPAGE = page;
  await page.goto(`${BASE}/headman.html${hash}`);
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

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
let victim = null, certId = null;
const orig = [];     // исходные фамилии пятерых студентов: возвращаем в finally
const wipe = async () => {      // идемпотентно: чистит и остатки прошлых запусков
  await del(`absences?group_id=eq.${G}&subject=like.E2E*`).catch(() => {});
  await del(`certificates?group_id=eq.${G}&note=like.E2E*`).catch(() => {});
  await del(`schedule_lessons?group_id=eq.${G}`).catch(() => {});   // всё расписание группы: настоящее из ручного импорта мешает фикстуре
  await del(`tasks?group_id=eq.${G}&rec-%3E%3Esubject=like.E2E*`).catch(() => {});
};
try {
  // ---------- фикстуры ----------
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id,student_id`);
  if (!heads.length) throw new Error('в группе 24ДММ-2 нет старосты: запустите npm run test:reset');
  const hu = await api(`/auth/v1/admin/users/${heads[0].user_id}`);
  await patch(`memberships?user_id=eq.${heads[0].user_id}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' });
  const plain = await session('student02@journal-test.example', env.TEST_PASSWORD);
  const plainMem = plain ? await get(`memberships?user_id=eq.${plain.user.id}&select=student_id,extra_role`) : [];
  const skip = new Set([heads[0].student_id, ...plainMem.map((m) => m.student_id)]);
  const all = await get(`students?group_id=eq.${G}&claim_status=eq.active&select=id,last_name,first_name,claimed_by&order=sort`);
  // студенты без свежих пропусков (перенос из прода): иначе «4 ч» на экране справки не сойдутся
  const busy = new Set((await get(`absences?group_id=eq.${G}&date=gte.2026-10-25&select=student_id`)).map((a) => a.student_id));
  // В маскированной копии фамилии «Студент NN» не различаются по инициалам, поэтому пятерым на время теста даём уникальные фамилии
  const pool = all.filter((s) => s.last_name && s.first_name && !skip.has(s.id) && !busy.has(s.id));
  const V = pool.filter((s) => s.claimed_by).pop();
  const five = [V, ...pool.filter((s) => s !== V).slice(0, 4)].filter(Boolean);
  const NAMES = ['Лисин', 'Ежов', 'Зайцев', 'Орлов', 'Волков'];
  five.forEach((s, i) => { orig.push({ id: s.id, last_name: s.last_name }); s.last_name = NAMES[i]; });
  for (const s of five) await patch(`students?id=eq.${s.id}`, { last_name: s.last_name });
  const [S1, S2, S3, S4] = five.filter((s) => s !== V);
  if (!V || !S4) throw new Error('в группе мало студентов для теста');
  victim = V;
  await wipe();
  await post('schedule_lessons', { group_id: G, lesson_date: TODAY, pair_no: 3, starts_at: '11:15', ends_at: '12:35', subject: 'E2E Эконометрика', kind: 'lecture', teacher: 'Тестов Т.Т.', room: '101' });
  // запись «преподавателя» (чужой created_by) и два пропуска S3 для справки + один вне периода справки
  await post('absences', [
    { group_id: G, student_id: S4.id, date: '2026-11-02', subject: 'E2E Чужая запись', hours: 2, lesson_kind: 'lecture', created_by: TEACHER },
    { group_id: G, student_id: S3.id, date: '2026-11-03', subject: 'E2E Маркетинг', hours: 2, lesson_kind: 'practice', created_by: null },
    { group_id: G, student_id: S3.id, date: '2026-11-04', subject: 'E2E Маркетинг', hours: 2, lesson_kind: 'practice', created_by: null },
    { group_id: G, student_id: S3.id, date: '2026-11-01', subject: 'E2E Маркетинг', hours: 2, lesson_kind: 'practice', created_by: null },
  ]);
  await post('tasks', { id: 'hw-e2e-teacher', kind: 'homework', group_id: G, created_by: TEACHER, rec: { id: 'hw-e2e-teacher', subject: 'E2E Чужое', type: 'ПЗ', text: 'E2E чужое задание', dueDate: '2026-11-12', subgroup: 0, createdAt: new Date().toISOString() } });
  // ожидающий студент
  await patch(`students?id=eq.${V.id}`, { claim_status: 'pending' });
  await patch(`memberships?user_id=eq.${V.claimed_by}&group_id=eq.${G}`, { status: 'pending' });

  const hs = await session(hu.email, env.TEST_PASSWORD);
  check('староста вошёл', !!hs);
  const h = await open(browser, hs, '#/summary');
  const p = h.page;
  await p.getByRole('heading', { name: 'Кабинет старосты' }).waitFor({ timeout: 30000 });

  // ---------- 1. четыре вкладки и сводка ----------
  const body = () => p.locator('#cabMain').innerText();
  check('сводка: «Староста, 24ДММ-2» и дата', /Староста, 24ДММ-2/.test(await body()) && /Четверг, 5 ноября/.test(await body()), (await body()).slice(0, 120));
  check('сводка: идёт лекция, «Отметить пропуски», предмет и время', /Сейчас идёт лекция/.test(await body()) && /Отметить пропуски/.test(await body()) && /E2E Эконометрика, 11:15–12:35/.test(await body()));
  check('сводка: плашка ожидающих студентов', await p.locator('a[href="#/summary/requests"]').count() === 1);
  check('сводка: чат с замком, ссылка на отчёт', /Зашифрован/.test(await body()) && !/Появится в следующей версии/.test(await body()) && await p.locator('a[href="#/summary/report"]').count() === 1);
  await noHScroll(p, 'сводка'); await taps(p, 'сводка'); await p.screenshot({ path: join(shots, 'h1-summary.png') });
  await go(p, '#/journal', 'Отметьте отсутствующих');
  await p.locator('.cab-stu').first().waitFor();
  await noHScroll(p, 'журнал'); await taps(p, 'журнал'); await p.screenshot({ path: join(shots, 'h2-journal.png') });
  await go(p, '#/tasks', 'Добавить домашку или дедлайн');
  await noHScroll(p, 'задания'); await taps(p, 'задания'); await p.screenshot({ path: join(shots, 'h3-tasks.png') });
  await go(p, '#/chat', 'Защитите переписку');
  await noHScroll(p, 'чат'); await taps(p, 'чат'); await p.screenshot({ path: join(shots, 'h4-chat.png') });
  check('нижняя панель: четыре вкладки', await p.locator('.cab-tab').count() === 4);

  // ---------- 2. отметка пропусков ----------
  await go(p, '#/journal', 'Отметьте отсутствующих');
  const o = await p.evaluate(() => { const x = [...document.querySelectorAll('#hmSel option')].find((y) => y.text.startsWith('E2E Эконометрика')); return x && { v: x.value, t: x.text }; });
  check('пара из расписания есть в списке (лекция, 2 ч)', !!o && /лекция, 2 ч/.test(o.t), JSON.stringify(o));
  await p.selectOption('#hmSel', o.v);
  const row = (s) => p.locator('.cab-stu').filter({ has: p.locator('b', { hasText: re(initials(s)) }) });
  await row(S1).locator('button.mark').click(); await row(S2).locator('button.mark').click();
  check('отмеченный показывает «Н, 2 ч»', /Н, 2 ч/.test(await row(S1).locator('button.mark').innerText()));
  const saveBtn = p.getByRole('button', { name: /Сохранить, отсутствуют 2/ });
  await saveBtn.waitFor();
  await p.screenshot({ path: join(shots, 'h5-marks.png') });
  await saveBtn.click();
  await toastText(p, 'Внесено: 2');
  const abs = await pollDb(async () => { const r = await get(`absences?group_id=eq.${G}&subject=eq.E2E%20Эконометрика&select=student_id,date,hours,lesson_kind,is_excused,created_by`); return r.length >= 2 ? r : null; }) ?? [];
  check('сохранение создало ровно 2 пропуска', abs.length === 2, String(abs.length));
  check('поля пропусков: дата, часы, вид, не уважительный, автор', abs.every((a) => a.date === TODAY && Number(a.hours) === 2 && a.lesson_kind === 'lecture' && a.is_excused === false && a.created_by === hs.user.id)
    && new Set(abs.map((a) => a.student_id)).size === 2 && abs.some((a) => a.student_id === S1.id) && abs.some((a) => a.student_id === S2.id), JSON.stringify(abs));
  await row(S1).locator('.hm-lock', { hasText: 'уже внесено' }).waitFor({ timeout: 15000 });
  check('после сохранения внесённые заблокированы «уже внесено»', await p.locator('.cab-stu.locked').count() === 2);
  await go(p, '#/summary', 'Отметить пропуски');
  check('сводка: счётчик «2 отмечено»', (await p.locator('.hm-count').innerText()).replace(/\s+/g, ' ').trim() === '2 отмечено');

  // ---------- 3. история и отмена ----------
  await p.evaluate(() => { location.hash = '#/journal/history'; });
  await p.getByRole('heading', { name: 'История пропусков' }).waitFor({ timeout: 30000 });
  await p.locator('.cab-card').first().waitFor();
  await noHScroll(p, 'история'); await taps(p, 'история');
  const foreign = p.locator('.cab-card', { hasText: 'E2E Чужая запись' });
  check('запись преподавателя видна, кнопки «Отменить» нет', await foreign.count() === 1 && await foreign.getByRole('button').count() === 0 && /преподаватель/.test(await foreign.innerText()));
  const mine = p.locator('.cab-card', { hasText: 'E2E Эконометрика' }).filter({ hasText: initials(S1) });
  check('своя запись помечена «вы» и с кнопкой «Отменить»', /внёс: вы/.test(await mine.innerText()) && await mine.getByRole('button', { name: /Отменить/ }).count() === 1);
  await mine.getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить пропуск').click();
  await toastText(p, 'Пропуск отменён');
  const after = await get(`absences?group_id=eq.${G}&subject=eq.E2E%20Эконометрика&select=student_id`);
  check('отмена своей записи удалила её из базы', after.length === 1 && after[0].student_id === S2.id, JSON.stringify(after));

  // ---------- 4. справка ----------
  await go(p, '#/journal/certs', 'Новая справка');
  await noHScroll(p, 'справки'); await taps(p, 'справки');
  await p.getByRole('button', { name: /Новая справка/ }).click();
  await p.locator('#ncS').selectOption({ label: initials(S3) });
  await p.fill('#ncF', '2026-11-03'); await p.fill('#ncT', '2026-11-04'); await p.fill('#ncN', 'E2E справка');
  await noHScroll(p, 'лист «Новая справка»'); await p.screenshot({ path: join(shots, 'h6-newcert.png') });
  await p.click('#ncOk');
  await toastText(p, 'Справка добавлена');
  const cert = (await pollDb(async () => { const r = await get(`certificates?student_id=eq.${S3.id}&note=eq.E2E%20справка&select=id,status,date_from,date_to,due_date,kind`); return r.length ? r : null; }))?.[0];
  certId = cert?.id;
  check('справка создана: ожидается, период 3–4 ноября, срок +3 дня', cert?.status === 'waiting' && cert.date_from === '2026-11-03' && cert.date_to === '2026-11-04' && cert.due_date === '2026-11-07', JSON.stringify(cert));
  const card = p.locator('article.cab-card', { hasText: initials(S3) }).filter({ has: p.getByRole('link', { name: /Справка получена/ }) });
  await card.getByRole('link', { name: /Справка получена/ }).click();
  await p.locator('#cdOk').waitFor({ timeout: 20000 });
  check('экран справки: два пропуска периода, оба отмечены, вне периода нет', await p.locator('.cab-chk input').count() === 2 && await p.locator('.cab-chk input:checked').count() === 2);
  check('«Станут уважительными 4 ч» и кнопка «Закрыть 4 ч справкой»', (await p.locator('#cdSum').innerText()).trim() === '4 ч' && /Закрыть 4 ч справкой/.test(await p.locator('#cdOk').innerText()));
  await noHScroll(p, 'экран справки'); await taps(p, 'экран справки'); await p.screenshot({ path: join(shots, 'h7-cert.png') });
  await p.click('#cdOk');
  await toastText(p, 'Закрыто 4 ч');
  const ca = await pollDb(async () => { const r = await get(`absences?student_id=eq.${S3.id}&subject=eq.E2E%20Маркетинг&select=date,is_excused,certificate_id&order=date`); return r.every((a) => a.date === '2026-11-01' || a.is_excused) ? r : null; }) ?? await get(`absences?student_id=eq.${S3.id}&subject=eq.E2E%20Маркетинг&select=date,is_excused,certificate_id&order=date`);
  check('пропуски 3 и 4 ноября стали уважительными и привязаны к справке', ca.filter((a) => a.date !== '2026-11-01').every((a) => a.is_excused && a.certificate_id === certId), JSON.stringify(ca));
  check('пропуск вне периода (1 ноября) остался неуважительным', ca.find((a) => a.date === '2026-11-01')?.is_excused === false);
  check('справка получена (status received)', (await get(`certificates?id=eq.${certId}&select=status`))[0]?.status === 'received');
  await p.locator('#cabMain').getByText('получена').first().waitFor({ timeout: 20000 });

  // ---------- 5. задания ----------
  await go(p, '#/tasks', 'Добавить домашку или дедлайн');
  const foreignTask = p.locator('.cab-card', { hasText: 'E2E чужое задание' });
  check('задание преподавателя: «отменить нельзя», кнопок нет', await foreignTask.count() === 1 && /отменить нельзя/.test(await foreignTask.innerText()) && await foreignTask.getByRole('button').count() === 0);
  await p.getByRole('button', { name: /Добавить домашку или дедлайн/ }).click();
  await p.locator('#tfT').selectOption('ПЗ');
  await p.locator('#tfS').selectOption({ label: 'E2E Эконометрика' });
  await p.fill('#tfX', 'E2E домашка'); await p.fill('#tfD', '2026-11-10'); await p.locator('#tfA').selectOption('0');
  await noHScroll(p, 'лист задания'); await taps(p, 'лист задания'); await p.screenshot({ path: join(shots, 'h8-task.png') });
  await p.click('#tfOk');
  await toastText(p, 'Задание добавлено');
  const t1 = (await pollDb(async () => { const r = await get(`tasks?rec-%3E%3Etext=eq.E2E%20домашка&select=id,kind,group_id,created_by,rec`); return r.length ? r : null; }))?.[0];
  check('задание создано: kind, группа, автор, rec.id = id', t1 && t1.kind === 'homework' && t1.group_id === G && t1.created_by === hs.user.id && t1.rec.id === t1.id && /^hw-\d+$/.test(t1.id) && t1.rec.type === 'ПЗ' && t1.rec.subgroup === 0 && t1.rec.dueDate === '2026-11-10', JSON.stringify(t1));
  const tc = p.locator('.cab-card', { hasText: 'E2E домашка' });
  await tc.getByRole('button', { name: /Изменить/ }).click();
  await p.fill('#tfX', 'E2E домашка 2'); await p.locator('#tfA').selectOption('2');
  await p.click('#tfOk');
  await toastText(p, 'Задание изменено');
  const t2 = (await pollDb(async () => { const r = await get(`tasks?id=eq.${t1.id}&select=rec`); return r[0]?.rec?.text === 'E2E домашка 2' ? r : null; }))?.[0];
  check('правка задания сохранилась (текст, подгруппа), id и createdAt прежние', t2?.rec.text === 'E2E домашка 2' && t2.rec.subgroup === 2 && t2.rec.id === t1.id && t2.rec.createdAt === t1.rec.createdAt, JSON.stringify(t2));
  await p.locator('.cab-card', { hasText: 'E2E домашка 2' }).getByRole('button', { name: /Отменить/ }).click();
  await sheetBtn(p, 'Отменить задание').click();
  await toastText(p, 'Задание отменено');
  check('отмена задания удалила запись', (await get(`tasks?id=eq.${t1.id}&select=id`)).length === 0);
  check('задание преподавателя осталось на месте', (await get('tasks?id=eq.hw-e2e-teacher&select=id')).length === 1);

  // ---------- 6. заявки: «Это он» ----------
  await go(p, '#/summary', 'Кабинет старосты');
  await p.locator('a[href="#/summary/requests"]').click();
  await p.locator('#cabMain').getByText('Заявки студентов').first().waitFor();
  await noHScroll(p, 'заявки'); await taps(p, 'заявки'); await p.screenshot({ path: join(shots, 'h9-requests.png') });
  const vcard = p.locator('article.cab-card', { hasText: `${V.last_name} ${V.first_name}` });
  await vcard.getByRole('button', { name: /Не он/ }).click();
  check('«Не он» просит подтверждения, а не отклоняет сразу', await vcard.getByRole('button', { name: 'Да, не он' }).isVisible() && (await get(`students?id=eq.${V.id}&select=claim_status`))[0].claim_status === 'pending');
  await vcard.getByRole('button', { name: 'Отмена' }).click();
  await vcard.getByRole('button', { name: /Это он/ }).click();
  await toastText(p, 'Подтверждён');
  const vs = await pollDb(async () => { const r = await get(`students?id=eq.${V.id}&select=claim_status`); return r[0]?.claim_status === 'active' ? r : null; });
  check('«Это он» подтверждает студента в базе', !!vs, 'студент не стал active');

  // ---------- 7. отчёт для деканата ----------
  await go(p, '#/summary/report', 'Отчёт для деканата');
  await p.locator('#hmRep .cab-tile').first().waitFor({ timeout: 20000 });
  await noHScroll(p, 'отчёт'); await taps(p, 'отчёт'); await p.screenshot({ path: join(shots, 'h10-report.png') });
  check('отчёт: плитки «часов пропущено» и «по уважительной»', /часов пропущено/.test(await p.locator('#hmRep').innerText()) && /по уважительной/.test(await p.locator('#hmRep').innerText()));
  const dl = async (btn) => { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), btn.click()]); const f = await d.path(); const sz = statSync(f).size; const fd = openSync(f, 'r'); const b = Buffer.alloc(2); readSync(fd, b, 0, 2, 0); closeSync(fd); return { name: d.suggestedFilename(), sz, zip: b.toString() === 'PK' }; };
  const m = await dl(p.getByRole('button', { name: 'Скачать Excel' }));
  check('«Скачать Excel» (месяц): файл .xlsx не пустой', /^Пропуски_2026-11\.xlsx$/.test(m.name) && m.sz > 0 && m.zip, JSON.stringify(m));
  await p.getByRole('tab', { name: 'Семестр' }).click();
  await p.locator('#hmRep .cab-tile').first().waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: 'Скачать Excel' }).waitFor();
  const sm = await dl(p.getByRole('button', { name: 'Скачать Excel' }));
  check('«Скачать Excel» (семестр): файл .xlsx не пустой', /^Пропуски_семестр_[0-9]{4}-[0-9]{2}\.xlsx$/.test(sm.name) && sm.sz > 0 && sm.zip, JSON.stringify(sm));

  check('кабинет старосты: ошибок JS нет', h.errs.length === 0, h.errs.join(' | ').slice(0, 300));
  await h.ctx.close();

  // ---------- 8. обычный студент не попадает в кабинет старосты ----------
  if (plain) {
    const s = await open(browser, plain);
    await s.page.waitForURL(/app\.html/, { timeout: 30000 }).then(() => check('обычный студент с headman.html уходит на app.html', true)).catch(() => check('обычный студент с headman.html уходит на app.html', false, s.page.url()));
    await s.ctx.close();
  } else check('обычный студент с headman.html уходит на app.html', false, 'нет аккаунта student02@journal-test.example');
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await LASTPAGE.screenshot({ path: join(shots, 'h-fail.png') }); console.log('url:', LASTPAGE.url()); } catch (_) { /* страницы уже нет */ }
} finally {
  try {
    await wipe();
    await del('tasks?id=eq.hw-e2e-teacher').catch(() => {});
    for (const o of orig) await patch(`students?id=eq.${o.id}`, { last_name: o.last_name }).catch(() => {});
    if (victim) {     // вернуть как было
      await patch(`students?id=eq.${victim.id}`, { claim_status: 'active' });
      await patch(`memberships?user_id=eq.${victim.claimed_by}&group_id=eq.${G}`, { status: 'active' });
    }
  } catch (e) { console.log('Чистка не завершена:', String(e).slice(0, 200)); }
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}. Скриншоты: ${shots}`);
process.exit(failed.length ? 1 : 0);
