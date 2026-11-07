// Свайп влево-вправо между разделами (cab-core.js: Cab.swipe) на ТЕСТОВОМ проекте при 390×844 с эмуляцией касаний.
//   Жесты — настоящие касания через CDP Input.dispatchTouchEvent (touchscreen.tap свайп не умеет).
//   Меняет раздел: влево/вправо на корневых экранах; не меняет: короткий сдвиг, вертикаль, диагональ, медленный жест, края экрана,
//   .no-swipe, .cab-modal, лента с горизонтальной прокруткой, поле ввода, вложенный экран, .cab-bare, выделенный текст; на крайних разделах нет кольца.
// Запуск: node tests/e2e/swipe.mjs   (после npm run test:reset; CHROME_PATH — Chromium)
import { readFileSync } from 'node:fs';
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

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }
await fetch(`${URL_SB}/rest/v1/memberships?user_id=eq.${ses.user.id}`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });

const browser = await chromium.launch({ executablePath: findChrome() });
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.split('?')[0].endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.includes('/vendor/telegram-web-app.js')) return route.abort();   // в тестах Telegram подделан, настоящий скрипт его бы затёр
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify(ses)]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errs.push(m.text().slice(0, 200)); });   // сетевой шум теста (telegram.org заблокирован, нет аватара) не считаем
  const cdp = await ctx.newCDPSession(page);
  const tp = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  // Жест от (x0,y0) к (x1,y1) за steps шагов и ms миллисекунд
  const swipe = async (x0, y0, x1, y1, ms = 160, steps = 8) => {
    await tp('touchStart', x0, y0);
    for (let i = 1; i <= steps; i++) { await tp('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await page.waitForTimeout(ms / steps); }
    await tp('touchEnd'); await page.waitForTimeout(500);
  };
  const L = (y = 500) => swipe(320, y, 120, y), R = (y = 500) => swipe(70, y, 270, y);   // влево / вправо, мимо краёв (24 px)
  const hash = () => page.evaluate(() => location.hash);
  const settle = async () => { await page.waitForSelector('#cabMain > :not(.cab-load)', { timeout: 20000 }); await page.waitForTimeout(400); };
  const go = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); await settle(); };
  const add = (html) => page.evaluate((x) => document.body.insertAdjacentHTML('beforeend', x), html);
  const rm = (id) => page.evaluate((x) => document.getElementById(x).remove(), id);

  await page.goto(`${BASE}/app.html#/home`); await settle();
  check('старт: #/home, вкладка «Главная»', (await hash()) === '#/home' && (await page.locator('.cab-tab.on').innerText()).includes('Главная'));

  await L(); check('свайп влево: Главная → Расписание', (await hash()) === '#/schedule', await hash());
  const st1 = await page.evaluate(() => JSON.parse(sessionStorage.getItem('j2.nav') || '[]'));
  check('«Назад»: в стеке тот же адрес, что при тапе по вкладке', JSON.stringify(st1) === JSON.stringify(['app.html#/home', 'app.html#/schedule']), JSON.stringify(st1));
  check('вкладка подсвечена и экран наверху', (await page.locator('.cab-tab.on').innerText()).includes('Расписание') && (await page.evaluate(() => scrollY)) === 0);
  await settle();
  await L(); check('свайп влево: Расписание → Учёба (на «Расписании» разделы переключаются)', (await hash()) === '#/study', await hash());
  await settle(); await L(); check('свайп влево: Учёба → Профиль', (await hash()) === '#/profile', await hash());
  await settle(); await L(); check('на последнем разделе влево — ничего (без кольца)', (await hash()) === '#/profile', await hash());
  await R(); check('свайп вправо: Профиль → Учёба', (await hash()) === '#/study', await hash());
  await settle(); await R(); await settle(); await R(); check('свайп вправо ×2: Учёба → Главная', (await hash()) === '#/home', await hash());
  await settle(); await R(); check('на первом разделе вправо — ничего', (await hash()) === '#/home', await hash());

  // жесты, которые раздел менять не должны
  await swipe(320, 500, 290, 500); check('короткий сдвиг (30 px) не меняет раздел', (await hash()) === '#/home');
  await swipe(200, 300, 210, 650); check('вертикальный жест не меняет раздел', (await hash()) === '#/home');
  await swipe(320, 500, 120, 650); check('диагональный жест (вниз сильнее, чем в 1,5 раза меньше вбок) не меняет раздел', (await hash()) === '#/home');
  await swipe(320, 500, 120, 500, 900, 10); check('медленный жест (900 мс) не меняет раздел', (await hash()) === '#/home');
  await swipe(10, 500, 210, 500); check('старт у левого края (10 px) не меняет раздел', (await hash()) === '#/home');
  await swipe(380, 500, 180, 500); check('старт у правого края (380 px) не меняет раздел', (await hash()) === '#/home');
  await add('<div class="no-swipe" id="nsw" style="position:fixed;left:0;right:0;top:300px;height:200px;z-index:5;background:#222"></div>');
  await swipe(320, 400, 120, 400); check('внутри .no-swipe раздел не меняется', (await hash()) === '#/home'); await rm('nsw');
  await add('<div class="cab-modal" id="mdl" style="position:fixed;inset:0;z-index:50"></div>');
  await swipe(320, 400, 120, 400); check('при открытом окне (.cab-modal) раздел не меняется', (await hash()) === '#/home'); await rm('mdl');
  await add('<div id="hscr" style="position:fixed;left:0;right:0;top:300px;height:120px;z-index:5;overflow-x:auto;background:#333"><div style="width:1200px;height:80px"></div></div>');
  await swipe(320, 340, 120, 340); check('на ленте с горизонтальной прокруткой раздел не меняется', (await hash()) === '#/home'); await rm('hscr');
  await add('<input id="inp" style="position:fixed;left:20px;right:20px;top:300px;height:60px;z-index:5">');
  await swipe(320, 330, 120, 330); check('на поле ввода раздел не меняется', (await hash()) === '#/home'); await rm('inp');

  // вложенные экраны и экран без нижней панели
  await go('#/profile/account'); await L(); check('на вложенном экране (#/profile/account) раздел не меняется', (await hash()) === '#/profile/account', await hash());
  await go('#/study/homework'); await R(); check('на вложенном экране (#/study/homework) раздел не меняется', (await hash()) === '#/study/homework', await hash());
  await go('#/home');
  await page.evaluate(() => document.body.classList.add('cab-bare'));
  await L(); check('в режиме без нижней панели (.cab-bare) раздел не меняется', (await hash()) === '#/home');
  await page.evaluate(() => document.body.classList.remove('cab-bare'));
  await L(); check('после снятия .cab-bare свайп снова работает', (await hash()) === '#/schedule', await hash());

  // выделенный текст
  await go('#/home');
  await page.evaluate(() => { const h = document.querySelector('#cabMain h1'); const r = document.createRange(); r.selectNodeContents(h); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await L(); check('при выделенном тексте раздел не меняется', (await hash()) === '#/home', await hash());
  await page.evaluate(() => getSelection().removeAllRanges());

  check('ошибок в консоли нет', errs.length === 0, errs.join(' | ').slice(0, 300));
} catch (e) { check('прогон завершился без исключения', false, String((e && e.stack) || e).slice(0, 400)); }
finally { await browser.close(); server.close(); }
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
