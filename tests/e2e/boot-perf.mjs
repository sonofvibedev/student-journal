// Замер запуска кабинета студента (app.html) на медленной сети, ТЕСТОВЫЙ проект.
//   node tests/e2e/boot-perf.mjs [метка] [повторов]      например: node tests/e2e/boot-perf.mjs before 3
// Профили (Chrome DevTools через CDP Network.emulateNetworkConditions):
//   «Slow 4G» — 150 мс задержки, 1,6 Мбит/с вниз, 750 кбит/с вверх (как задано в задаче);
//   «Fast 3G» — классический пресет DevTools: 562,5 мс, 1,44 Мбит/с вниз, 675 кбит/с вверх.
// Для каждого: «чистый» (новый профиль браузера: нет HTTP-кэша, сервис-воркера и localStorage, кроме сессии)
// и «прогретый» (тот же профиль после первого захода: сервис-воркер установлен, кэш и сохранённый контекст есть).
// Что меряем (мс от начала навигации): первый кадр с содержимым (FCP: что видно — заставка или кабинет),
// появление оболочки кабинета (#cabMain = конец Cab.load), первый экран (в #cabMain не каркас, а данные), и водопад запросов.
// Сервис-воркер запросов в обход страницы не делает только к supabase.co и data.json; его собственные запросы к сайту
// throttling страницы не видит, поэтому сам сервер добавляет к ответам ту же задержку и режет скорость (см. shape()).
// Сайт отдаётся локально; env.js и адрес Supabase в html подменяются на тестовый проект, прод не вызывается (route abort).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const LABEL = process.argv[2] || 'run';
const REPEAT = Number(process.argv[3] || 3);
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'boot-e2e'));
mkdirSync(OUT, { recursive: true });

const PROFILES = {
  'Slow 4G': { latency: 150, down: 1.6e6 / 8, up: 750e3 / 8 },
  'Fast 3G': { latency: 562.5, down: 1.44e6 / 8, up: 675e3 / 8 },
};
let shapeNow = null;                                            // профиль для ответов локального сервера (см. ниже)

const ROOT = resolve('.');
const KEY = `sb-${TEST}-auth-token`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ENV_JS = readFileSync('env.js', 'utf8')
  .replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${URL_SB}'`)
  .replace(/const SUPABASE_KEY = '[^']*'/, `const SUPABASE_KEY = '${ANON}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`)
  .replace(/const TG_APP_KEY = '[^']*'/, "const TG_APP_KEY = ''")
  .replace("const LS_PREFIX = ''", "const LS_PREFIX = 't_'");
if (ENV_JS.includes(PROD_REF)) { console.error('СТОП: в подменённом env.js остался прод'); process.exit(2); }

// Запросы, пришедшие от сервис-воркера (его fetch), страница не тормозит: тормозим сами — задержка + скорость.
// Запросы страницы мимо воркера уже заторможены CDP, второй раз их не тормозим (заголовок x-page от route не нужен:
// у fetch из воркера Sec-Fetch-Dest = empty, у загрузок страницы — script/style/document/font).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = resolve(join(ROOT, p === '/' ? 'index.html' : p));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  let b;
  try { b = readFileSync(f); } catch (_) { res.writeHead(404).end(); return; }
  if (f.endsWith('env.js')) b = Buffer.from(ENV_JS);
  else if (f.endsWith('.html')) b = Buffer.from(b.toString('utf8').replaceAll(PROD_REF, TEST));   // preconnect и т. п. — на тестовый проект
  const fromSw = req.headers['sec-fetch-dest'] === 'empty' || req.headers['service-worker'] === 'script';
  // как GitHub Pages: max-age=600 и ETag; проверка «не изменилось» отвечает 304 без тела
  const tag = '"' + createHash('sha1').update(b).digest('hex').slice(0, 16) + '"';
  const same = req.headers['if-none-match'] === tag;
  if (shapeNow && fromSw) await sleep(shapeNow.latency + (same ? 0 : (b.length / shapeNow.down) * 1000));
  if (same) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'max-age=600' }).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600', ETag: tag }).end(b);
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
if (!ses.access_token) { console.error('студент не вошёл'); process.exit(1); }

// Наблюдатель в странице: время появления заставки, оболочки, первого экрана; FCP
const PROBE = () => {
  const T = (window.__boot = { marks: {} });
  const mark = (k) => { if (T.marks[k] == null) T.marks[k] = Math.round(performance.now()); };
  new PerformanceObserver((l) => l.getEntries().forEach((e) => { if (e.name === 'first-contentful-paint') { T.marks.fcp = Math.round(e.startTime); T.fcpWhat = T.what(); } })).observe({ type: 'paint', buffered: true });
  T.what = () => document.getElementById('cabMain') ? (document.querySelector('#cabMain > .cab-load') ? 'оболочка + каркас' : 'кабинет') : document.querySelector('#cab .boot') ? 'заставка' : document.querySelector('#cab')?.children.length ? 'что-то в #cab' : 'пусто';
  const tick = () => {
    if (document.querySelector('#cab .boot')) mark('splash');
    if (document.getElementById('cabMain')) mark('shell');
    if (document.querySelector('#cabMain .cab-head, #cabMain h1')) mark('screen');
    if (document.querySelector('.boot-slow:not([hidden])')) mark('slowMsg');
    if (!T.marks.screen) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.addEventListener('DOMContentLoaded', () => mark('dcl'));
};

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const rows = [];
async function run(profileName, rep) {
  const prof = PROFILES[profileName];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await ctx.route(`**/*${PROD_REF}*/**`, (r) => r.abort());
  await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* нет хранилища */ } }, [KEY, JSON.stringify(ses)]);
  await ctx.addInitScript(PROBE);
  const one = async (mode) => {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.latency, downloadThroughput: prof.down, uploadThroughput: prof.up });
    shapeNow = prof;
    const t0 = Date.now();
    await page.goto(`${BASE}/app.html#/home`, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__boot && window.__boot.marks.screen, null, { timeout: 90000, polling: 100 }).catch(() => {});
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource').map((e) => ({ n: e.name.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').slice(0, 70) + (e.name.includes('supabase.co') ? ' [sb]' : ''),
        s: Math.round(e.startTime), e: Math.round(e.responseEnd), kb: Math.round((e.transferSize || 0) / 1024), sw: e.workerStart > 0 }));
      return { marks: window.__boot.marks, fcpWhat: window.__boot.fcpWhat, navEnd: Math.round(nav.responseEnd), res };
    });
    shapeNow = null;
    const swCtl = await page.evaluate(() => !!navigator.serviceWorker.controller);
    await page.screenshot({ path: join(OUT, `perf-${LABEL}-${profileName.replace(' ', '')}-${mode}-${rep}.png`) });
    await page.close();
    return { ...r, errs, swCtl, wall: Date.now() - t0 };
  };
  const cold = await one('cold');
  // прогрев: дождаться воркера и его кэша
  const wp = await ctx.newPage();
  await wp.goto(`${BASE}/app.html#/home`);
  await wp.evaluate(() => navigator.serviceWorker.ready).catch(() => {});
  await wp.reload();
  await wp.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 60000 }).catch(() => {});
  await wp.waitForTimeout(1500);
  await wp.close();
  const warm = await one('warm');
  await ctx.close();
  return { cold, warm };
}

for (const name of Object.keys(PROFILES)) {
  for (let i = 0; i < REPEAT; i++) {
    const r = await run(name, i);
    for (const mode of ['cold', 'warm']) {
      const x = r[mode];
      rows.push({ profile: name, mode, rep: i, ...x.marks, fcpWhat: x.fcpWhat, swCtl: x.swCtl, errs: x.errs, res: x.res });
      console.log(`${name} ${mode} #${i}: FCP ${x.marks.fcp} (${x.fcpWhat}), заставка ${x.marks.splash ?? '—'}, оболочка ${x.marks.shell}, экран ${x.marks.screen}, SW ${x.swCtl}, ошибок ${x.errs.length}${x.errs.length ? ' ' + x.errs.join(' | ') : ''}`);
    }
  }
}
await browser.close(); server.close();
writeFileSync(join(OUT, `perf-${LABEL}.json`), JSON.stringify(rows, null, 1));
// сводка: медианы
const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
console.log(`\n| профиль | кэш | первый кадр, мс (что видно) | заставка | конец Cab.load (оболочка) | первый экран |`);
console.log('|---|---|---|---|---|---|');
for (const name of Object.keys(PROFILES)) for (const mode of ['cold', 'warm']) {
  const rs = rows.filter((r) => r.profile === name && r.mode === mode);
  console.log(`| ${name} | ${mode === 'cold' ? 'чистый' : 'прогретый + SW'} | ${med(rs.map((r) => r.fcp))} (${[...new Set(rs.map((r) => r.fcpWhat))].join('/')}) | ${med(rs.map((r) => r.splash)) ?? '—'} | ${med(rs.map((r) => r.shell))} | ${med(rs.map((r) => r.screen))} |`);
}
// водопад первого повтора каждого режима
for (const name of Object.keys(PROFILES)) for (const mode of ['cold', 'warm']) {
  const r = rows.find((x) => x.profile === name && x.mode === mode);
  console.log(`\n--- водопад: ${name}, ${mode} (start→end мс, КБ, через SW) ---`);
  r.res.sort((a, b) => a.s - b.s).forEach((q) => console.log(`${String(q.s).padStart(6)} → ${String(q.e).padStart(6)}  ${String(q.kb).padStart(4)}КБ ${q.sw ? 'SW ' : '   '} ${q.n}`));
}
console.log(`\nJSON и снимки: ${OUT}`);
