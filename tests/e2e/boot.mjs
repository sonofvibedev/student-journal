// Запуск кабинета (app.html) на ТЕСТОВОМ проекте: заставка, «Долго грузится», таймауты старта, быстрый старт из сохранённого
// контекста и сервис-воркер (первая загрузка, повторная, без сети, медленная сеть, выкат новой версии и чистка старого кэша).
// Запуск: node tests/e2e/boot.mjs   Снимки 390×844 — в %TEMP%\boot-e2e (или SHOTS_DIR).
// Сайт отдаёт свой сервер: env.js подменён на тестовый проект, ответам можно добавить задержку (hold), sw.js — другую версию кэша (swVer).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { assertTestTarget, PROD_REF } from '../../tools/test/guard.mjs';
import { findChrome } from '../../tools/test/chrome.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);
const URL_SB = `https://${TEST}.supabase.co`;
assertTestTarget(TEST, URL_SB);
const ANON = env.TEST_ANON_KEY;
const KEY = `sb-${TEST}-auth-token`;
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'boot-e2e'));
mkdirSync(OUT, { recursive: true });
const ENV_JS = readFileSync('env.js', 'utf8')
  .replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${URL_SB}'`)
  .replace(/const SUPABASE_KEY = '[^']*'/, `const SUPABASE_KEY = '${ANON}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`)
  .replace("const LS_PREFIX = ''", "const LS_PREFIX = 't_'");
if (ENV_JS.includes(PROD_REF)) { console.error('СТОП: в подменённом env.js остался прод'); process.exit(2); }
const SW_JS = readFileSync('sw.js', 'utf8');
const VER = /const CACHE_VERSION = '([^']+)'/.exec(SW_JS)[1];

const S = { hold: null, swVer: null };      // hold: { test(path), ms } — задержка ответов; swVer — подменить CACHE_VERSION в sw.js
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = resolve(join(resolve('.'), p === '/' ? 'index.html' : p));
  let b;
  try { b = readFileSync(f); } catch (_) { res.writeHead(404).end(); return; }
  if (p.endsWith('/env.js')) b = Buffer.from(ENV_JS);
  else if (p.endsWith('/sw.js') && S.swVer) b = Buffer.from(SW_JS.replace(VER, S.swVer));
  else if (p.endsWith('.html')) b = Buffer.from(b.toString('utf8').replaceAll(PROD_REF, TEST));
  if (S.hold && S.hold.test(p)) await new Promise((r) => setTimeout(r, S.hold.ms));
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(b);
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }

const browser = await chromium.launch({ executablePath: findChrome() });
const ERR_OK = /status of 409|ERR_FAILED|ERR_INTERNET_DISCONNECTED|Service Worker registration blocked|Failed to fetch|сверка входа|\[cab\]/;   // ожидаемые: обрывы связи в сценариях и 409 first_login
async function newCtx(sw) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: sw ? 'allow' : 'block' });
  await ctx.route(`**/*${PROD_REF}*/**`, (r) => r.abort());
  await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(ses)]);
  return ctx;
}
const errsOf = (page) => { const a = []; page.on('pageerror', (e) => a.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !ERR_OK.test(m.text())) a.push(m.text()); }); return a; };
// снимок во время загрузки: page.screenshot ждёт document.fonts.ready, а он не готов, пока документ грузится — снимаем через CDP
const rawShot = async (page, file) => { const c = await page.context().newCDPSession(page); const { data } = await c.send('Page.captureScreenshot'); writeFileSync(join(OUT, file), Buffer.from(data, 'base64')); await c.detach(); };
const shell = (page, ms = 30000) => page.waitForSelector('#cabMain', { timeout: ms });
const homeDone = (page, ms = 30000) => page.waitForSelector('#cabMain .cab-head', { timeout: ms });

try {
  // ---------- 1. заставка видна сразу, пока скрипты не пришли; через 8 с — «Долго грузится» ----------
  {
    const ctx = await newCtx(false); const page = await ctx.newPage(); const errs = errsOf(page);
    S.hold = { test: (p) => p.endsWith('.js'), ms: 12000 };
    const t0 = Date.now();
    await page.goto(`${BASE}/app.html#/home`, { waitUntil: 'commit' });
    await page.waitForSelector('#cab .boot svg', { state: 'visible', timeout: 5000 });
    const tBoot = Date.now() - t0;
    const fcp = await page.evaluate(() => new Promise((r) => new PerformanceObserver((l) => r(Math.round(l.getEntries()[0].startTime))).observe({ type: 'paint', buffered: true })));
    check(`заставка видна до загрузки скриптов (через ${tBoot} мс, FCP ${fcp} мс)`, tBoot < 2000 && fcp < 1500, `${tBoot} / ${fcp}`);
    const geo = await page.evaluate(() => { const b = document.querySelector('.boot svg').getBoundingClientRect(), bar = document.querySelector('.boot-bar').getBoundingClientRect(); return { cx: b.left + b.width / 2, bar: bar.bottom, bg: getComputedStyle(document.body).backgroundColor }; });
    check('заставка: монограмма по центру, каркас панели внизу, фон #0A0C11', Math.abs(geo.cx - 195) < 2 && geo.bar <= 844 - 14 && geo.bg === 'rgb(10, 12, 17)', JSON.stringify(geo));
    check('заставка: сообщения «Долго грузится» сначала нет', await page.locator('#bootSlow').isHidden());
    await rawShot(page, 'boot-splash.png');
    await page.locator('#bootSlow').waitFor({ state: 'visible', timeout: 9500 });
    const tSlow = Date.now() - t0;
    check(`через 8 с: «Долго грузится. Проверьте связь» и «Повторить» (${tSlow} мс)`, tSlow >= 7900 && (await page.locator('#bootSlow').innerText()).includes('Долго грузится. Проверьте связь') && await page.getByRole('button', { name: 'Повторить' }).isVisible());
    await rawShot(page, 'boot-splash-slow.png');
    S.hold = null;
    await homeDone(page);
    check('после загрузки заставка заменена кабинетом', (await page.locator('#cab .boot').count()) === 0 && (await page.locator('.cab-tabbar').count()) === 1);
    check('заставка: без ошибок в консоли', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // prefers-reduced-motion: монограмма не мерцает
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await ctx.newPage(); await ctx.route('**/*.js*', () => {});        // скрипты не приходят: остаётся заставка
    await page.goto(`${BASE}/app.html`, { waitUntil: 'commit' }); await page.waitForSelector('#cab .boot svg');
    check('reduced motion: у заставки нет анимации', (await page.evaluate(() => getComputedStyle(document.querySelector('.boot svg')).animationName)) === 'none');
    await ctx.close();
  }

  // ---------- 2. без сохранённого контекста сервер молчит: через 10 с «Не получилось загрузить» и «Повторить» ----------
  {
    const ctx = await newCtx(false); const page = await ctx.newPage(); const errs = errsOf(page);
    await page.route(`${URL_SB}/rest/**`, () => {});                              // запросы висят без ответа
    const t0 = Date.now();
    await page.goto(`${BASE}/app.html#/home`);
    await page.getByText('Не получилось загрузить').waitFor({ timeout: 16000 });
    const t = Date.now() - t0;
    check(`без контекста и ответа сервера: экран «Не получилось загрузить» через ~10 с (${t} мс)`, t >= 9500 && t < 15000 && await page.getByRole('button', { name: 'Повторить' }).isVisible());
    check('без контекста: ошибок кода нет', errs.filter((x) => !/timeout/.test(x)).length === 0, errs.join(' | '));
    await page.unroute(`${URL_SB}/rest/**`);
    await page.getByRole('button', { name: 'Повторить' }).click();
    await homeDone(page);
    check('«Повторить» перезагружает и открывает главную', true);
    await page.screenshot({ path: join(OUT, 'boot-home.png') });
    // ---------- 3. быстрый старт: есть контекст и сессия того же пользователя — кабинет сразу, сверка в фоне ----------
    check('контекст сохранён после входа', await page.evaluate(() => !!localStorage.getItem('j2.ctx.student')));
    await page.route(`${URL_SB}/rest/**`, () => {});
    const t1 = Date.now();
    await page.reload();
    await shell(page, 8000);
    const tShell = Date.now() - t1;
    check(`быстрый старт: оболочка кабинета без ответа сервера (${tShell} мс)`, tShell < 3000);
    await page.locator('#cabNet', { hasText: 'Связь слабая, данные могут быть старыми' }).waitFor({ timeout: 13000 });
    check('сервер не ответил за 10 с: полоса «Связь слабая, данные могут быть старыми»', true);
    await page.screenshot({ path: join(OUT, 'boot-weak.png') });
    // ---------- 4. другой пользователь в сессии: чужой сохранённый контекст не используется ----------
    await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('j2.ctx.student')); c.uid = '00000000-0000-0000-0000-000000000000'; c.group.name = 'ЧУЖАЯ'; localStorage.setItem('j2.ctx.student', JSON.stringify(c)); });
    await page.reload();
    await page.getByText('Не получилось загрузить').waitFor({ timeout: 16000 });
    check('контекст другого uid не показан (без сервера — экран ошибки, а не чужой кабинет)', !(await page.locator('body').innerText()).includes('ЧУЖАЯ'));
    await page.unroute(`${URL_SB}/rest/**`);
    // ---------- 5. сверка нашла изменения: экран перерисован по свежему контексту ----------
    await page.evaluate(() => localStorage.removeItem('j2.ctx.student'));
    await page.reload(); await homeDone(page);
    const real = await page.evaluate(() => JSON.parse(localStorage.getItem('j2.ctx.student')).group.name);
    await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('j2.ctx.student')); c.group.name = 'СТАРОЕ-ИМЯ'; localStorage.setItem('j2.ctx.student', JSON.stringify(c)); });
    await page.reload();
    await page.waitForFunction((n) => document.querySelector('#cabMain .cab-sub')?.textContent.includes(n), real, { timeout: 20000 });
    check('сверка: устаревший контекст заменён свежим и экран перерисован', (await page.evaluate(() => JSON.parse(localStorage.getItem('j2.ctx.student')).group.name)) === real);
    // ---------- 6. выход: сохранённый контекст стирается и больше не используется ----------
    await page.evaluate(() => Cab.signOut());
    await page.waitForURL(/join\.html/, { timeout: 15000 });
    check('выход: сохранённые контексты кабинетов стёрты', await page.evaluate(() => !localStorage.getItem('j2.ctx.student') && !localStorage.getItem('j2.ctx.headman')));
    await ctx.close();
  }

  // ---------- 7. сервис-воркер ----------
  {
    const ctx = await newCtx(true); const page = await ctx.newPage(); const errs = errsOf(page);
    await page.goto(`${BASE}/app.html#/home`); await homeDone(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await homeDone(page);
    check('SW: после первой загрузки страница под управлением воркера', await page.evaluate(() => !!navigator.serviceWorker.controller));
    const c1 = await page.evaluate(async () => ({ keys: await caches.keys(), urls: (await (await caches.open((await caches.keys())[0])).keys()).map((r) => new URL(r.url).pathname) }));
    check(`SW: один кэш ${VER}`, c1.keys.length === 1 && c1.keys[0] === VER, c1.keys.join(','));
    check('SW: тяжёлые библиотеки старого журнала заранее не скачаны', !c1.urls.some((u) => /exceljs|chart\.umd|bootstrap|qrcode/.test(u)), c1.urls.filter((u) => /vendor/.test(u)).join(','));
    check('SW: файлы кабинета в кэше', ['/app.html', '/cab-core.js', '/app-student.js', '/vendor/supabase.js', '/offline-queue.js', '/headman.js'].every((u) => c1.urls.includes(u)));
    // выкат новой версии: старый кэш удаляется
    S.swVer = VER + '-next';
    await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    // waitForFunction с async-условием не ждёт (Promise всегда «истина»): опрашиваем сами
    const until = async (fn, arg, ms) => { for (const t = Date.now(); Date.now() - t < ms; await page.waitForTimeout(300)) if (await page.evaluate(fn, arg)) return true; return false; };
    await until(async (v) => { const k = await caches.keys(); return k.length === 1 && k[0] === v; }, S.swVer, 30000);
    const k2 = await page.evaluate(() => caches.keys());
    if (process.env.DEBUG_SW) console.log(await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return JSON.stringify({ i: r.installing && r.installing.state, w: r.waiting && r.waiting.state, a: r.active && r.active.state }); }));
    check('SW: выкат новой версии — новый кэш, старый удалён', k2.length === 1 && k2[0] === S.swVer, k2.join(','));
    await page.reload(); await homeDone(page);
    check('SW: после выката кабинет открывается', await page.evaluate(() => !!navigator.serviceWorker.controller));
    S.swVer = null;
    // медленная сеть: файлы сайта отвечают через 8 с — кэш через ~3 с, кабинет открывается
    S.hold = { test: (p) => !p.endsWith('/sw.js'), ms: 8000 };
    let t = Date.now(); await page.reload({ waitUntil: 'commit' }); await shell(page, 15000);   // reload() ждал бы load (шрифты), а нам важна оболочка
    const tSlow = Date.now() - t;
    check(`SW: сеть «висит» 8 с — кабинет из кэша за ${tSlow} мс (ожидание сети не дольше 3 с на запрос)`, tSlow < 7500, String(tSlow));
    S.hold = null;
    await page.waitForTimeout(8500);          // «висящие» запросы прошлого шага держат соединения с сайтом (до 6 на адрес): ждём, пока они закончатся
    // без сети
    await ctx.setOffline(true);
    t = Date.now(); await page.reload(); await shell(page, 15000);
    const tOff = Date.now() - t;
    check(`SW: без сети кабинет открывается из кэша (${tOff} мс)`, tOff < 2000 && (await page.locator('.cab-tabbar').count()) === 1, String(tOff));
    await ctx.setOffline(false);
    check('SW: без ошибок в консоли', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
} catch (e) {
  console.error('ОШИБКА ТЕСТА:', e); results.push({ name: 'прогон теста', ok: false });
} finally {
  await browser.close(); server.close();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}${bad ? `, провалов ${bad}` : ''}\nСнимки: ${OUT}`);
process.exit(bad ? 1 : 0);
