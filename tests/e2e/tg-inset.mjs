// Шапка Telegram и свайп вниз на ТЕСТОВОМ проекте: tg-app.js, --app-inset-*, жест «потяни, чтобы обновить».
//   Подставляем Telegram.WebApp (initData, отступы 48 + 56 px сверху) и проверяем на каждом экране: контент начинается ниже 104 px.
//   Жест: настоящие касания через CDP; обновление срабатывает, а на шторке, в чате, в поле ввода и на join/register — нет.
// Запуск: node tests/e2e/tg-inset.mjs   (после npm run test:reset; SHOTS_DIR — куда сложить скриншоты; CHROME_PATH — Chromium)
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
const ANON = env.TEST_ANON_KEY, SERVICE = env.TEST_SERVICE_KEY, PW = env.TEST_PASSWORD;
if (!ANON || !SERVICE || !PW) { console.error('Нет ключей в .env.test: запустите npm run test:reset'); process.exit(2); }

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
const shots = resolve(process.env.SHOTS_DIR ?? join(process.env.TEMP ?? '.', 'tg-inset-e2e')); mkdirSync(shots, { recursive: true });
const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => { const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SVC, ...(init.headers ?? {}) } }); const t = await r.text(); if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null; };
const session = async (email, password) => { const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json(); return r.access_token ? r : null; };

const ZONE = 104;                                                           // 48 (системная) + 56 (кнопки Telegram)
// Подделка Telegram.WebApp: сам telegram-web-app.js в тесте не грузится (запрос к telegram.org отклоняется)
const TG_MOCK = (zone) => {
  const w = { initData: 'query_id=e2e', isFullscreen: true, isVersionAtLeast: () => true, expand() { window.__expand = 1; }, ready() {}, setHeaderColor() {}, setBackgroundColor() {}, setBottomBarColor() {},
    disableVerticalSwipes() { window.__dvs = (window.__dvs || 0) + 1; }, onEvent() {}, HapticFeedback: { impactOccurred() { window.__hap = 'impact'; }, notificationOccurred(k) { window.__hap = k; } },
    BackButton: { show() {}, hide() {}, onClick() {} }, safeAreaInset: { top: zone ? 48 : 0 }, contentSafeAreaInset: { top: zone ? 56 : 0 } };
  window.Telegram = { WebApp: w };
  const set = () => { if (zone && document.documentElement) { document.documentElement.style.setProperty('--tg-safe-area-inset-top', '48px'); document.documentElement.style.setProperty('--tg-content-safe-area-inset-top', '56px'); } };
  set(); document.addEventListener('DOMContentLoaded', set);
};

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const created = [];
async function open(ses, { zone = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block', hasTouch: true, isMobile: true });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  if (ses) await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify(ses)]);
  await ctx.addInitScript(TG_MOCK, zone);
  const page = await ctx.newPage(); page.errs = []; page.on('pageerror', (e) => page.errs.push(String(e)));
  page.cdp = await ctx.newCDPSession(page);
  return { ctx, page };
}
// Настоящий свайп вниз пальцем: из (x, y0) на dy пикселей, шагами
async function swipe(page, dy, { x = 195, y0 = 200, hold = false } = {}) {
  const t = (type, y) => page.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await t('touchStart', y0);
  for (let i = 1; i <= 12; i++) { await t('touchMove', y0 + (dy * i) / 12); await page.waitForTimeout(16); }
  if (!hold) await t('touchEnd', y0 + dy);
}
const top = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; }, sel);
const ptrText = (page) => page.locator('.j2-ptr span').innerText().catch(() => '');

try {
  // ---------- фикстуры: согласия, староста, преподаватель, временный сисадмин ----------
  const stu = await session('student02@journal-test.example', PW);
  const [gm] = await api(`/rest/v1/memberships?user_id=eq.${stu.user.id}&select=group_id`);
  const heads = await api(`/rest/v1/memberships?extra_role=eq.headman&group_id=eq.${gm.group_id}&status=eq.active&select=user_id`);
  const hu = await api(`/auth/v1/admin/users/${heads[0].user_id}`);
  const tch = await session('teacher-lecture@journal-test.example', PW);
  for (const uid of [stu.user.id, heads[0].user_id, tch?.user.id].filter(Boolean)) await api(`/rest/v1/memberships?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
  const hses = await session(hu.email, PW);
  const SYS_EMAIL = 'tg-inset-sys@journal-test.example';
  const old = (await api(`/auth/v1/admin/users?per_page=200`)).users?.find((u) => u.email === SYS_EMAIL);
  if (old) { await api(`/rest/v1/sysadmins?user_id=eq.${old.id}`, { method: 'DELETE' }).catch(() => {}); await api(`/auth/v1/admin/users/${old.id}`, { method: 'DELETE' }).catch(() => {}); }
  const su = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: SYS_EMAIL, password: PW, email_confirm: true }) });
  created.push(su.id); await api('/rest/v1/sysadmins', { method: 'POST', body: JSON.stringify({ user_id: su.id }) });
  const sses = await session(SYS_EMAIL, PW);

  // ---------- 1. отступы на каждом экране ----------
  const screens = async (name, ses, file, routes, firstSel, wait) => {
    const { ctx, page } = await open(ses);
    await page.goto(`${BASE}/${file}`);
    for (const r of routes) {
      if (r !== null) await page.evaluate((x) => { location.hash = x; }, r);
      await page.waitForSelector(wait, { timeout: 25000 });
      await page.waitForTimeout(400);
      const y = await top(page, firstSel);
      const label = `${name}${r ? ' ' + r : ''}`;
      check(`${label}: контент начинается ниже ${ZONE} px (сейчас ${y})`, y !== null && y >= ZONE - 1, String(y));
      await page.screenshot({ path: join(shots, `${name}-${(r || 'root').replace(/[^\w]+/g, '_')}.png`) });
    }
    check(`${name}: ошибок JS нет`, page.errs.length === 0, page.errs.join(' | ').slice(0, 200));
    const dvs = await page.evaluate(() => window.__dvs || 0);
    check(`${name}: disableVerticalSwipes и expand вызваны`, dvs >= 1 && (await page.evaluate(() => window.__expand)) === 1, String(dvs));
    await ctx.close();
  };
  await screens('студент', stu, 'app.html', ['#/home', '#/schedule', '#/study', '#/study/homework', '#/study/deadlines', '#/study/exams', '#/study/grades', '#/study/teachers', '#/study/rating', '#/study/games', '#/profile', '#/profile/absences', '#/profile/account', '#/profile/whatsnew', '#/notifications'], '#cabMain > *:first-child', '#cabMain h1');
  await screens('староста', hses, 'headman.html', ['#/summary', '#/journal', '#/tasks', '#/chat'], '#cabMain > *:first-child', '#cabMain h1, #cabMain .cab-title, #cabMain .j2-card');
  if (tch) await screens('преподаватель', tch, 'teacher.html', [null], '#cabMain > *:first-child', '#cabMain h1');
  await screens('сисадмин', sses, 'sysadmin.html', [null], '.j2-wrap > *:first-child', '#nav button');
  await screens('вход', null, 'join.html', [null], '.j2-wrap > section:not([hidden])', 'main.j2-wrap h1');
  await screens('регистрация', null, 'register.html', [null], '.j2-wrap > *:first-child', 'main.j2-wrap h1');
  await screens('вход сисадмина', null, 'sysadmin.html', [null], '.j2-wrap > *:first-child', '#loginForm');

  // таб-бар и плавающие элементы: внизу, над системной зоной; шторка не выше верхнего отступа
  {
    const { ctx, page } = await open(stu);
    await page.goto(`${BASE}/app.html#/profile`); await page.waitForSelector('#pfAva');
    await page.locator('#pfAva').click(); await page.waitForSelector('.cab-sheet');
    const sh = await page.evaluate(() => Math.round(document.querySelector('.cab-sheet').getBoundingClientRect().top));
    check(`шторка (фото профиля) не уходит под шапку Telegram (верх ${sh})`, sh >= ZONE - 1, String(sh));
    await page.screenshot({ path: join(shots, 'студент-шторка.png') });
    await ctx.close();
  }
  // запасной вариант: старый клиент в полноэкранном режиме не сообщает отступы
  {
    const { ctx, page } = await open(stu, { zone: false });
    await page.goto(`${BASE}/app.html#/home`); await page.waitForSelector('#cabMain h1');
    const p = await page.evaluate(() => { const d = document.createElement('div'); d.style.paddingTop = 'var(--app-inset-top)'; document.body.appendChild(d); return [parseFloat(getComputedStyle(d).paddingTop), document.documentElement.classList.contains('tg-fs-fallback')]; });
    check('старый клиент: полноэкранный режим без отступов — верхний отступ 100 px', p[0] >= 100 && p[1], JSON.stringify(p));
    await ctx.close();
  }
  // вне Telegram: ничего не меняется (нет initData, нет класса, нет плашки)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', hasTouch: true });
    await ctx.route('**/*', (route) => { const u = route.request().url(); if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS }); if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue(); return route.abort(); });
    await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify(stu)]);
    const page = await ctx.newPage(); await page.goto(`${BASE}/app.html#/home`); await page.waitForSelector('#cabMain h1');
    const r = await page.evaluate(() => [document.documentElement.classList.contains('tg-fs-fallback'), !!window.TGApp && TGApp.inTelegram, getComputedStyle(document.documentElement).getPropertyValue('--app-inset-top').length > 0]);
    check('вне Telegram: класса запасного отступа нет, TGApp.inTelegram = false', r[0] === false && r[1] === false, JSON.stringify(r));
    await ctx.close();
  }

  // ---------- 2. жест «потяни, чтобы обновить» ----------
  {
    const { ctx, page } = await open(stu);
    await page.goto(`${BASE}/app.html#/schedule`); await page.waitForSelector('#cabMain h1');
    await page.evaluate(() => { window.__ref = 0; window.addEventListener('j2:refresh', () => { window.__ref++; }); window.__main = document.getElementById('cabMain').firstElementChild; });
    await swipe(page, 50);
    check('жест: короткая протяжка (50 px) не обновляет', (await page.evaluate(() => window.__ref)) === 0);
    await page.waitForTimeout(300);
    await swipe(page, 90, { hold: true });
    check('жест: на протяжке видна плашка ниже верхнего отступа', (await top(page, '.j2-ptr')) >= 0 && /Отпустите/.test(await ptrText(page)) && (await page.evaluate(() => { const r = document.querySelector('.j2-ptr').getBoundingClientRect(); return r.top >= 100; })), await ptrText(page));
    await page.screenshot({ path: join(shots, 'жест-протяжка.png') });
    await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => window.__ref === 1, null, { timeout: 5000 }).catch(() => {});
    check('жест: протяжка за порог (90 px) шлёт j2:refresh', (await page.evaluate(() => window.__ref)) === 1);
    await page.waitForFunction(() => /Готово/.test(document.querySelector('.j2-ptr')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    check('жест: после обновления плашка «Готово»', /Готово/.test(await ptrText(page)), await ptrText(page));
    check('жест: экран перерисован заново', (await page.evaluate(() => !document.contains(window.__main) || document.getElementById('cabMain').firstElementChild !== window.__main)));
    await page.screenshot({ path: join(shots, 'жест-готово.png') });
    await page.waitForTimeout(1200);
    // не обновляем: открытая шторка, поле в фокусе, несохранённый ввод
    await page.evaluate(() => { location.hash = '#/profile/account'; }); await page.waitForSelector('#acPw');
    await page.evaluate(() => { window.__ref = 0; });
    await page.locator('#acCur').fill('abc');
    await page.locator('h1').click();                                          // уходим из фокуса, но ввод остался: значит «несохранённое»
    await swipe(page, 100);
    check('жест: несохранённый ввод в поле — не обновляем', (await page.evaluate(() => window.__ref)) === 0);
    await page.locator('#acCur').fill('');
    await page.locator('#acCur').focus();
    await swipe(page, 100);
    check('жест: поле ввода в фокусе — не обновляем', (await page.evaluate(() => window.__ref)) === 0);
    await page.evaluate(() => { document.activeElement.blur(); location.hash = '#/profile'; }); await page.waitForSelector('#pfAva');
    await page.locator('#pfAva').click(); await page.waitForSelector('.cab-sheet');
    await swipe(page, 100, { y0: 120 });
    check('жест: открытая шторка — не обновляем', (await page.evaluate(() => window.__ref)) === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(hses);
    await page.goto(`${BASE}/headman.html#/chat`); await page.waitForSelector('#cabMain h1, #cabMain .cab-title, #cabMain .j2-card');
    await page.evaluate(() => { window.__ref = 0; window.addEventListener('j2:refresh', () => { window.__ref++; }); });
    await swipe(page, 100); await page.waitForTimeout(500);
    check('жест: экран чата — не обновляем', (await page.evaluate(() => window.__ref)) === 0);
    await page.evaluate(() => { location.hash = '#/summary'; }); await page.waitForSelector('#cabMain h1, #cabMain .cab-title');
    await page.waitForTimeout(500);
    await swipe(page, 100);
    await page.waitForFunction(() => window.__ref === 1, null, { timeout: 5000 }).catch(() => {});
    check('жест: сводка старосты обновляется', (await page.evaluate(() => window.__ref)) === 1);
    await page.waitForTimeout(1200);
    // отметки пропусков без сохранения
    await page.evaluate(() => { location.hash = '#/journal'; }); await page.waitForSelector('#hmList button, #hmList .j2-chip, #cabMain .j2-chip', { timeout: 20000 }).catch(() => {});
    const chip = page.locator('#hmList button, #hmList .j2-chip').first();
    if (await chip.count()) {
      await chip.click(); await page.evaluate(() => { window.__ref = 0; document.activeElement.blur(); });
      await swipe(page, 100); await page.waitForTimeout(500);
      check('жест: у старосты есть несохранённые отметки — не обновляем', (await page.evaluate(() => window.__ref)) === 0);
    } else console.log('ПРОПУСК отметки старосты: на тестовой группе нет пар на этот день, проверка по J2_NO_REFRESH ниже');
    check('староста: J2_NO_REFRESH отражает отметки', (await page.evaluate(() => typeof window.J2_NO_REFRESH === 'function')));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(sses);
    await page.goto(`${BASE}/sysadmin.html`); await page.waitForSelector('#nav button');
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__ref = 0; window.addEventListener('j2:refresh', () => { window.__ref++; }); });
    await swipe(page, 100);
    await page.waitForFunction(() => /Готово|Не удалось/.test(document.querySelector('.j2-ptr')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
    check('жест: сисадмин — rerun сработал, плашка «Готово»', (await page.evaluate(() => window.__ref)) === 1 && /Готово/.test(await ptrText(page)), await ptrText(page));
    await ctx.close();
  }
  for (const f of ['join.html', 'register.html']) {
    const { ctx, page } = await open(null);
    await page.goto(`${BASE}/${f}`); await page.waitForSelector('main.j2-wrap h1');
    await page.evaluate(() => { window.__ref = 0; window.addEventListener('j2:refresh', () => { window.__ref++; }); });
    await swipe(page, 100); await page.waitForTimeout(500);
    check(`жест: ${f} — не обновляем`, (await page.evaluate(() => window.__ref)) === 0);
    await ctx.close();
  }
} catch (e) {
  console.error('СБОЙ СЦЕНАРИЯ:', e); check('сценарий дошёл до конца', false, String(e).slice(0, 300));
} finally {
  for (const id of created) { await api(`/rest/v1/sysadmins?user_id=eq.${id}`, { method: 'DELETE' }).catch(() => {}); await api(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }).catch(() => {}); }
  await browser.close(); server.close();
}
const bad = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - bad.length} из ${results.length}. Скриншоты: ${shots}`);
process.exit(bad.length ? 1 : 0);
