// Этап 7: пропуски без сети (headman.html) на ТЕСТОВОМ проекте, настоящая база, настоящий браузер (390x844).
// Запуск: node tests/e2e/offline.mjs   (после npm run test:migrate и npm run test:reset; CHROME_PATH — путь к Chromium)
// Что проверяет: отметка при обрыве связи уходит в очередь, очередь отправляется без дублей, кабинет открывается из памяти
// телефона, отказ сервера (журнал закрыт) не зацикливает очередь, PWA-файлы на месте. Прод не затрагивается (guard).
import { readFileSync, existsSync } from 'node:fs';
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
const NOW = Date.UTC(2026, 10, 5, 8, 40);              // чт 5 ноября 2026, 11:40 по Минску
const TODAY = '2026-11-05';
const SUBJ = 'E2E Офлайн';

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
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
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
const pollDb = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 400)); } };
const rowsOf = () => get(`absences?group_id=eq.${G}&subject=eq.${encodeURIComponent(SUBJ)}&select=id,student_id,created_by,created_at&order=student_id`);
const queueLen = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('j2.oq.v1') || '[]').length);

async function open(ctx, hash = '#/journal') {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await page.goto(`${BASE}/headman.html${hash}`);
  return page;
}

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const wipe = async () => {
  await del(`absences?group_id=eq.${G}&subject=like.E2E*`).catch(() => {});
  await del(`schedule_lessons?group_id=eq.${G}`).catch(() => {});
};
try {
  // ---------- фикстуры ----------
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id,student_id`);
  if (!heads.length) throw new Error('в группе 24ДММ-2 нет старосты: запустите npm run test:reset');
  const hu = await api(`/auth/v1/admin/users/${heads[0].user_id}`);
  await patch(`memberships?user_id=eq.${heads[0].user_id}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' });
  await patch(`groups?id=eq.${G}`, { status: 'active', semester_closed_for: null });
  const stu = (await get(`students?group_id=eq.${G}&claim_status=eq.active&select=id&order=sort&limit=6`)).map((s) => s.id);
  if (stu.length < 4) throw new Error('в группе мало студентов для теста');
  await wipe();
  await post('schedule_lessons', { group_id: G, lesson_date: TODAY, pair_no: 3, starts_at: '11:15', ends_at: '12:35', subject: SUBJ, kind: 'lecture', teacher: 'Тестов Т.Т.', room: '101' });

  const hs = await session(hu.email, env.TEST_PASSWORD);
  check('староста вошёл', !!hs);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  const routeAll = async (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.endsWith('/cab-core.js')) return route.fulfill({ contentType: 'text/javascript', body: readFileSync('cab-core.js', 'utf8').replace('Cab.testNow = null;', `Cab.testNow = ${NOW};`) });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  };
  await ctx.route('**/*', routeAll);
  await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(hs)]);

  // ---------- 1. онлайн: кэш сохраняется ----------
  const p = await open(ctx);
  await p.getByText('Отметьте отсутствующих').waitFor({ timeout: 30000 });
  await p.locator('.cab-stu').first().waitFor();
  const cache = await p.evaluate((g) => ({ ctx: !!localStorage.getItem('j2.ctx.headman'), marks: JSON.parse(localStorage.getItem('j2.cache.marks.' + g) || 'null') }), G);
  check('онлайн: контекст и список группы сохранены на телефоне', cache.ctx && cache.marks && cache.marks.stu.length >= 4 && cache.marks.lessons.length === 1, JSON.stringify(cache.marks && cache.marks.stu.length));
  const mark = (page, id) => page.locator(`button.mark[data-id="${id}"]`).click();

  // ---------- 2. обрыв связи: отметка уходит в очередь ----------
  await ctx.setOffline(true);
  await p.waitForFunction(() => navigator.onLine === false);
  await p.locator('#cabNet').waitFor({ state: 'visible' });
  check('полоса «Нет связи» видна', /Нет связи/.test(await p.locator('#cabNet').innerText()));
  await mark(p, stu[0]); await mark(p, stu[1]);
  await p.getByRole('button', { name: /Сохранить, отсутствуют 2/ }).click();
  await p.locator('#cabToast', { hasText: 'Сохранено на телефоне: 2' }).waitFor({ timeout: 20000 });
  check('без сети: 2 записи в очереди', await queueLen(p) === 2);
  await pollDb(async () => (await p.locator('.cab-stu.locked').count()) === 2);
  check('без сети: отмеченные заблокированы как «уже внесено»', await p.locator('.cab-stu.locked').count() === 2, String(await p.locator('.cab-stu.locked').count()));
  check('без сети: полоса показывает очередь', /в очереди: 2/.test(await p.locator('#cabNet').innerText()), await p.locator('#cabNet').innerText());
  check('без сети: на сервере пока ничего', (await rowsOf()).length === 0);

  // ---------- 3. связь вернулась: очередь уходит сама, без дублей ----------
  await ctx.setOffline(false);
  await p.locator('#cabToast', { hasText: 'Отметки отправлены: 2' }).waitFor({ timeout: 30000 });
  const sent = await pollDb(async () => { const r = await rowsOf(); return r.length === 2 ? r : null; });
  check('связь вернулась: 2 записи на сервере, очередь пуста', !!sent && await queueLen(p) === 0, JSON.stringify(sent));
  check('записи принадлежат старосте и сохранили время отметки', !!sent && sent.every((r) => r.created_by === heads[0].user_id) && sent.every((r) => Date.parse(r.created_at) < Date.now()));
  check('полоса скрыта после отправки', await p.locator('#cabNet').isHidden());

  // ---------- 4. холодный старт без доступа к серверу: кабинет из памяти ----------
  await p.close();
  const p2 = await ctx.newPage();
  await p2.route(`${URL_SB}/**`, (r) => r.abort('failed'));
  p2.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
  await p2.goto(`${BASE}/headman.html`);                  // без hash: офлайн-вход должен сам открыть журнал
  await p2.getByText('Список группы взят из памяти телефона').waitFor({ timeout: 30000 });
  check('холодный старт без сервера: открылся журнал из памяти', await p2.locator('.cab-stu').count() >= 4);
  await mark(p2, stu[2]); await p2.getByRole('button', { name: /Сохранить, отсутствуют 1/ }).click();
  await p2.locator('#cabToast', { hasText: 'Сохранено на телефоне: 1' }).waitFor({ timeout: 20000 });
  check('холодный старт: запись встала в очередь', await queueLen(p2) === 1);
  await p2.unroute(`${URL_SB}/**`);
  await p2.evaluate(() => window.dispatchEvent(new Event('online')));
  const third = await pollDb(async () => { const r = await rowsOf(); return r.length === 3 ? r : null; });
  check('после возврата связи третья запись на сервере', !!third && await queueLen(p2) === 0);

  // ---------- 5. повторная отправка ничего не дублирует ----------
  await p2.evaluate(([g, sid]) => { const q = JSON.parse(localStorage.getItem('j2.oq.v1') || '[]'); const uid = JSON.parse(localStorage.getItem('j2.ctx.headman')).uid;
    localStorage.setItem('j2.oq.v1', JSON.stringify([{ id: OQ.newId(), uid, group_id: g, student_id: sid, date: '2026-11-05', subject: 'E2E Офлайн', hours: 2, lesson_kind: 'lecture', at: new Date().toISOString() }])); }, [G, stu[0]]);
  await p2.evaluate(() => Cab.flushQueue());
  check('то же самое, внесённое раньше, второй раз не вносится', (await rowsOf()).length === 3 && await queueLen(p2) === 0);

  // ---------- 6. журнал закрыли, пока отметки лежали в очереди ----------
  await ctx.setOffline(true);
  await p2.waitForFunction(() => navigator.onLine === false);
  await mark(p2, stu[3]); await p2.getByRole('button', { name: /Сохранить, отсутствуют 1/ }).click();
  await p2.locator('#cabToast', { hasText: 'Сохранено на телефоне: 1' }).waitFor({ timeout: 20000 });
  await patch(`groups?id=eq.${G}`, { status: 'closed' });
  await ctx.setOffline(false);
  await p2.locator('#cabToast', { hasText: 'не принята' }).waitFor({ timeout: 30000 });
  check('журнал закрыт: очередь снята, на сервер ничего не попало', await queueLen(p2) === 0 && (await rowsOf()).length === 3);
  await patch(`groups?id=eq.${G}`, { status: 'active' });

  // ---------- 7. PWA ----------
  const man = JSON.parse(readFileSync('manifest.json', 'utf8'));
  check('manifest: standalone, иконки на месте, maskable есть', man.display === 'standalone' && man.icons.length >= 4 && man.icons.every((i) => existsSync(i.src)) && man.icons.some((i) => i.purpose === 'maskable'));
  const sw = readFileSync('sw.js', 'utf8');
  check('сервис-воркер кэширует pwa.js и offline-queue.js', sw.includes("'./pwa.js'") && sw.includes("'./offline-queue.js'"));
  for (const f of ['app.html', 'headman.html', 'teacher.html']) {
    const s = readFileSync(f, 'utf8');
    check(`${f}: манифест, pwa.js, apple-touch-icon`, s.includes('rel="manifest"') && s.includes('src="pwa.js"') && s.includes('rel="apple-touch-icon"'));
  }
  // воркер в основном контексте заблокирован (его запросы идут мимо route и вернули бы прод-env.js): регистрацию проверяем в отдельном
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await ctx2.route('**/*', routeAll);
  await ctx2.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(hs)]);
  const reg = await (async () => {
    const pp = await ctx2.newPage(); await pp.goto(`${BASE}/headman.html#/summary`); await pp.getByText('Кабинет старосты').first().waitFor({ timeout: 30000 });
    const r = await pp.evaluate(async () => !!(await navigator.serviceWorker.ready)); await pp.close(); return r;
  })();
  await ctx2.close();
  check('сервис-воркер зарегистрирован со страницы кабинета', reg);
} catch (e) {
  console.error('ОШИБКА ТЕСТА:', e); results.push({ name: 'прогон теста', ok: false });
} finally {
  await patch(`groups?id=eq.${G}`, { status: 'active' }).catch(() => {});
  await wipe();
  await browser.close(); server.close();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
