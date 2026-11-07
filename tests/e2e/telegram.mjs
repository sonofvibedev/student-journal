// Telegram в кабинете студента и у сисадмина (этап 3) на ТЕСТОВОМ проекте, на настоящей базе, 390×844:
//   профиль и экран «Telegram-уведомления» (код, привязка, переключатели, отвязка), экран «Журнал обновился» (#/rebind),
//   «Служебное» в sysadmin.html (сброс привязок + рассылка).
// Запуск: node tests/e2e/telegram.mjs   (после npm run test:reset и применённой миграции этапа 3; CHROME_PATH — путь к Chromium)
// Бота в тесте нет: привязку «делает бот» вставкой в tg_links service-ключом. Прод не затрагивается (env.js подменяется, guard, запросы к прод-ref обрываются).
// Сброс у сисадмина трогает ВСЕХ пользователей тестового проекта: tg_links и tg_rebind снимаются до сценария и возвращаются в конце.
// Рассылка по фиктивным telegram_id из диапазона 900000000–900999999 никому не уходит (бот не может написать тому, кто ему не писал).
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

const results = [];
const LOGS = []; let PAGE = null;
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const shots = resolve(process.env.TEMP ?? '.', 'telegram-e2e'); mkdirSync(shots, { recursive: true });
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SH, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch (_) { return t; }
};
const get = (path) => api(`/rest/v1/${path}`);
const post = (table, rows, prefer) => api(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows), ...(prefer ? { headers: { Prefer: prefer } } : {}) });
const del = (path) => api(`/rest/v1/${path}`, { method: 'DELETE' });
const until = async (fn, ms = 14000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 300)); } };

const run = Date.now().toString(36);
const SYS_EMAIL = 'tg-e2e-sys@journal-test.example', SYS_PW = `T${run}x9Qz!aa`;
const FAKE_LO = 900000000, FAKE_HI = 900999999;
const fakeTg = () => FAKE_LO + Math.floor(Math.random() * 999000);

const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }
const uid = ses.user.id;
const [mem] = await get(`memberships?user_id=eq.${uid}&base_role=eq.student&status=eq.active&select=extra_role`);
const isStaff = mem?.extra_role === 'headman' || mem?.extra_role === 'deputy';

async function dropUserRows() {
  await del(`tg_links?user_id=eq.${uid}`).catch(() => {});
  await del(`tg_link_codes?user_id=eq.${uid}`).catch(() => {});
  await del(`notification_prefs?user_id=eq.${uid}`).catch(() => {});
  await del(`tg_rebind?user_id=eq.${uid}`).catch(() => {});
}
async function dropSys() {                                        // идемпотентно: находит и остатки прошлых запусков
  const list = await api('/auth/v1/admin/users?per_page=1000').catch(() => null);
  for (const u of (list?.users ?? []).filter((x) => x.email === SYS_EMAIL)) {
    await del(`sysadmins?user_id=eq.${u.id}`).catch(() => {});
    await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' }).catch(() => {});
  }
}
let snapLinks = null, snapRebind = null;                          // состояние всего проекта до массового сброса

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const ctxs = [];
async function newCtx(storage) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  ctxs.push(ctx);
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.split('?')[0].endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.includes('/vendor/telegram-web-app.js')) return route.abort();   // в тестах Telegram подделан, настоящий скрипт его бы затёр
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  if (storage) await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify(storage)]);
  return ctx;
}
const errsAll = [];
async function newPage(ctx) {
  const page = await ctx.newPage(); PAGE = page;
  page.on('pageerror', (e) => errsAll.push(String(e)));
  page.on('console', (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 200); LOGS.push(t); if (m.type() === 'error' && /\[(st|cab)\]/.test(m.text())) errsAll.push(t); });
  return page;
}
const noHScroll = async (page, label) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= 390 && w[0] <= w[1], JSON.stringify(w)); };
const taps = async (page, label, roots = ['#cab']) => {
  const sel = roots.flatMap((r) => [`${r} a[href]`, `${r} button:not(:disabled)`, `${r} [role=switch]:not(:disabled)`]).join(', ');
  const bad = await page.evaluate((q) => [...document.querySelectorAll(q)]
    .filter((e) => e.offsetParent && !e.closest('.sr-only, .j2-hidden') && e.getBoundingClientRect().height < 43.5).map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`), sel);
  check(`${label}: нажимаемое не ниже 44 px`, bad.length === 0, bad.join(', '));
};
const h1 = (page, t) => page.locator('#cabMain h1', { hasText: t }).waitFor({ timeout: 25000 });
const sw = (page, name) => page.getByRole('switch', { name });
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

try {
  // ----- хвосты прошлого прогона и фикстуры -----
  await dropUserRows(); await dropSys();
  await del(`tg_links?telegram_id=gte.${FAKE_LO}&telegram_id=lte.${FAKE_HI}`).catch(() => {});
  await api(`/rest/v1/memberships?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });

  // ===== 1. профиль и экран Telegram =====
  const ctx1 = await newCtx(ses); const page = await newPage(ctx1);
  await page.goto(`${BASE}/app.html#/profile`);
  await h1(page, 'Профиль');
  const row = page.locator('#tgRow');
  check('профиль: Telegram «не привязан»', (await row.innerText()).includes('не привязан'), await row.innerText());
  check('профиль: строка ведёт на #/profile/telegram', (await row.getAttribute('href')) === '#/profile/telegram');
  await noHScroll(page, 'профиль'); await taps(page, 'профиль');
  await row.click(); await h1(page, 'Telegram-уведомления');
  check('экран: шапка «Профиль» и кнопка «Получить код»', (await page.locator('.cab-top .j2-back', { hasText: 'Профиль' }).count()) === 1 && (await page.getByRole('button', { name: 'Получить код' }).count()) === 1);
  const nSw = await page.getByRole('switch').count();
  check(`экран: переключатели типов (${isStaff ? 9 : 7} для этой роли)`, nSw === (isStaff ? 9 : 7), String(nSw));
  check('экран: у студента нет «Скорое закрытие семестра»', isStaff || (await page.getByRole('switch', { name: /Скорое закрытие семестра/ }).count()) === 0);
  check('экран: пояснение про колокольчик', (await page.locator('#cabMain').innerText()).includes('В колокольчике внутри журнала события остаются всегда'));
  check('экран: все переключатели включены по умолчанию', (await page.locator('[role=switch]:not(:disabled)[aria-checked="false"]').count()) === 0);

  await page.getByRole('button', { name: 'Получить код' }).click();
  await page.locator('.j2-code').waitFor({ timeout: 20000 });
  const code = (await page.locator('.j2-code').innerText()).trim();
  check('код показан в формате ABCD-EFGH', CODE_RE.test(code), code);
  check('код: отсчёт «Код действует 9:xx»', /Код действует (9:[0-5]\d|10:00)/.test(await page.locator('#tgLeft').innerText()), await page.locator('#tgLeft').innerText());
  check('в базе появилась строка tg_link_codes', !!(await until(async () => (await get(`tg_link_codes?user_id=eq.${uid}&select=code_hash`)).length === 1)));
  await page.locator('#tgOpen, #tgNoBot').first().waitFor({ timeout: 20000 });   // имя бота приходит с запозданием
  const open = page.locator('#tgOpen');
  if (await open.count()) {
    const href = await open.getAttribute('href');
    check('кнопка бота: t.me и код без дефиса', /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=/.test(href) && href.endsWith('?start=' + code.replace('-', '')), href);
    check('кнопка бота открывается в новой вкладке безопасно', (await open.getAttribute('target')) === '_blank' && /noopener/.test(await open.getAttribute('rel')));
  } else check('нет имени бота: подсказка «Откройте бота журнала в Telegram и отправьте код»', await page.getByText('Откройте бота журнала в Telegram и отправьте код').count() >= 1);
  await noHScroll(page, 'экран Telegram, код'); await taps(page, 'экран Telegram, код');
  await page.screenshot({ path: join(shots, 'tg-code.png') });

  // бот «привязал»: вставка в tg_links; экран опрашивает раз в 4 секунды
  await post('tg_links', { user_id: uid, telegram_id: fakeTg() });
  check('привязка замечена: «Привязан с …» и «Готово» (до ~10 с)', !!(await page.getByText(/Привязан с \d+ \S+/).waitFor({ timeout: 12000 }).then(() => true, () => false)) && (await page.locator('#cabMain').innerText()).includes('Готово: бот ответил, что вы вошли'));
  check('после привязки есть «Отвязать», кнопки «Получить код» нет', (await page.getByRole('button', { name: 'Отвязать' }).count()) === 1 && (await page.getByRole('button', { name: 'Получить код' }).count()) === 0);
  await page.screenshot({ path: join(shots, 'tg-linked.png') });
  await page.evaluate(() => { location.hash = '#/profile'; }); await h1(page, 'Профиль');
  const st1 = await page.locator('#tgRow').innerText();
  check('профиль: теперь «привязан»', /привязан/.test(st1) && !/не привязан/.test(st1), st1);

  // ===== 2. переключатели =====
  await page.evaluate(() => { location.hash = '#/profile/telegram'; }); await h1(page, 'Telegram-уведомления');
  await sw(page, /Новые оценки/).click();
  await sw(page, /Внесённые пропуски/).click();
  const prefs = await until(async () => { const r = await get(`notification_prefs?user_id=eq.${uid}&select=kind,enabled`); return r.length >= 2 ? r : null; });
  check('в notification_prefs две строки enabled=false (grade, absence)', !!prefs && ['grade', 'absence'].every((k) => prefs.some((p) => p.kind === k && p.enabled === false)), JSON.stringify(prefs));
  check('переключатели показывают «выключено»', (await sw(page, /Новые оценки/).getAttribute('aria-checked')) === 'false' && (await sw(page, /Внесённые пропуски/).getAttribute('aria-checked')) === 'false');
  // сбой записи: переключатель откатывается и появляется сообщение
  const PREFS_URL = /\/rest\/v1\/notification_prefs/;
  await page.route(PREFS_URL, (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
  await sw(page, /Изменения расписания/).click();
  check('ошибка записи: переключатель вернулся и есть сообщение', !!(await page.locator('#cabToast', { hasText: 'Не удалось сохранить настройку' }).waitFor({ timeout: 10000 }).then(() => true, () => false)) && (await sw(page, /Изменения расписания/).getAttribute('aria-checked')) === 'true');
  await page.unroute(PREFS_URL);
  check('откат не оставил строки schedule в базе', (await get(`notification_prefs?user_id=eq.${uid}&kind=eq.schedule&select=kind`)).length === 0);
  if (isStaff) check('«Сообщения в чате» отключён и подписан «появится позже»', (await sw(page, /Сообщения в чате/).isDisabled()) && (await page.locator('#cabMain').innerText()).includes('появится позже'));
  await noHScroll(page, 'экран Telegram, настройки'); await taps(page, 'экран Telegram, настройки');
  await page.screenshot({ path: join(shots, 'tg-prefs.png') });
  await page.reload(); await h1(page, 'Telegram-уведомления');
  check('после перезагрузки выключенные остались выключенными, остальные включены',
    (await sw(page, /Новые оценки/).getAttribute('aria-checked')) === 'false' && (await sw(page, /Внесённые пропуски/).getAttribute('aria-checked')) === 'false'
    && (await sw(page, /Изменения расписания/).getAttribute('aria-checked')) === 'true' && (await sw(page, /Новые домашки и дедлайны/).getAttribute('aria-checked')) === 'true');

  // ===== 3. отвязка =====
  await page.getByRole('button', { name: 'Отвязать' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor({ timeout: 10000 });
  check('отвязка: окно подтверждения с «Отмена»', (await dlg.getByRole('button', { name: 'Отмена' }).count()) === 1);
  await dlg.getByRole('button', { name: 'Отмена' }).click();
  check('«Отмена» оставляет привязку', (await get(`tg_links?user_id=eq.${uid}&select=user_id`)).length === 1);
  await page.getByRole('button', { name: 'Отвязать' }).click();
  await dlg.getByRole('button', { name: 'Отвязать' }).click();
  check('«Отвязать»: строка tg_links удалена', !!(await until(async () => (await get(`tg_links?user_id=eq.${uid}&select=user_id`)).length === 0)));
  check('после отвязки снова «Получить код»', !!(await page.getByRole('button', { name: 'Получить код' }).waitFor({ timeout: 10000 }).then(() => true, () => false)));
  await ctx1.close();

  // ===== 4. «Журнал обновился» =====
  await dropUserRows();
  await post('tg_rebind', { user_id: uid, old_telegram_id: null });
  let ctx2 = await newCtx(ses); let p2 = await newPage(ctx2);                      // новый контекст = новый сеанс (sessionStorage пуст)
  await p2.goto(`${BASE}/app.html`);
  check('вход в кабинет с tg_rebind ведёт на #/rebind', !!(await p2.waitForFunction(() => location.hash === '#/rebind', null, { timeout: 25000 }).then(() => true, () => false)));
  await h1(p2, 'Журнал обновился');
  const rt = await p2.locator('#cabMain').innerText();
  check('rebind: текст и три шага', rt.includes('Чтобы получать уведомления, привяжите Telegram заново. Это один раз.') && ['Получите код', 'Отправьте код боту', 'Готово'].every((s) => rt.includes(s)), rt.slice(0, 200));
  await p2.locator('.j2-code').waitFor({ timeout: 20000 });
  check('rebind: код запрошен сам и в нужном формате', CODE_RE.test((await p2.locator('.j2-code').innerText()).trim()));
  await p2.locator('#tgOpen, #tgNoBot').first().waitFor({ timeout: 20000 });   // имя бота приходит с запозданием
  check('rebind: кнопка бота или подсказка, «Пропустить» на месте', ((await p2.locator('#tgOpen').count()) === 1 || (await p2.locator('#tgNoBot').count()) === 1) && (await p2.getByRole('button', { name: 'Пропустить, привяжу позже' }).count()) === 1);
  check('rebind: нижней панели нет', !(await p2.locator('.cab-tabbar').isVisible()));
  await noHScroll(p2, 'rebind'); await taps(p2, 'rebind');
  await p2.screenshot({ path: join(shots, 'rebind.png') });
  await p2.getByRole('button', { name: 'Пропустить, привяжу позже' }).click();
  await p2.waitForFunction(() => location.hash === '#/home', null, { timeout: 15000 });
  check('«Пропустить»: dismissed_at записан в базе', !!(await until(async () => (await get(`tg_rebind?user_id=eq.${uid}&select=dismissed_at`))[0]?.dismissed_at)));
  check('после «Пропустить» главная с нижней панелью', await p2.locator('.cab-tabbar').waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false));
  await ctx2.close();
  // повторный вход после «Пропустить» не гонит на экран
  ctx2 = await newCtx(ses); p2 = await newPage(ctx2);
  await p2.goto(`${BASE}/app.html`); await p2.locator('.cab-tabbar').waitFor({ state: 'visible', timeout: 25000 }); await p2.waitForTimeout(2500);
  check('после «Пропустить» новый вход остаётся на главной', (await p2.evaluate(() => location.hash)) !== '#/rebind');
  await ctx2.close();
  // привязка во время экрана: опрос раз в 5 секунд, «Готово» и «В журнал»
  await del(`tg_rebind?user_id=eq.${uid}`); await post('tg_rebind', { user_id: uid, old_telegram_id: null });
  ctx2 = await newCtx(ses); p2 = await newPage(ctx2);
  await p2.goto(`${BASE}/app.html`); await h1(p2, 'Журнал обновился'); await p2.locator('.j2-code').waitFor({ timeout: 20000 });
  await post('tg_links', { user_id: uid, telegram_id: fakeTg() });
  check('rebind: после привязки «Готово: бот ответил, что вы вошли» (до ~12 с)', !!(await p2.getByText('Готово: бот ответил, что вы вошли').waitFor({ timeout: 14000 }).then(() => true, () => false)));
  await p2.screenshot({ path: join(shots, 'rebind-done.png') });
  await p2.getByRole('link', { name: 'В журнал' }).click();
  await p2.waitForFunction(() => location.hash === '#/home', null, { timeout: 15000 });
  check('«В журнал» ведёт на главную', true);
  await ctx2.close();
  await dropUserRows();

  // ===== 5. сисадмин: «Служебное» =====
  const su = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: SYS_EMAIL, password: SYS_PW, email_confirm: true }) });
  await post('sysadmins', { user_id: su.id });
  await post('tg_links', { user_id: uid, telegram_id: fakeTg() });                // привязанный пользователь, которого сбросим
  snapLinks = (await get('tg_links?select=*')).filter((l) => !(l.telegram_id >= FAKE_LO && l.telegram_id <= FAKE_HI));
  snapRebind = await get('tg_rebind?select=*');
  const ctx3 = await newCtx(null); const sp = await newPage(ctx3);
  await sp.goto(`${BASE}/sysadmin.html`);
  await sp.fill('#email', SYS_EMAIL); await sp.fill('#pass', SYS_PW); await sp.click('#loginBtn');
  await sp.locator('#nav button[data-tab="service"]').click({ timeout: 30000 });
  await sp.locator('#title', { hasText: 'Служебное' }).waitFor({ timeout: 15000 });
  check('сисадмин: раздел «Служебное» с карточкой «Telegram»', (await sp.locator('#tgCard h2', { hasText: 'Telegram' }).count()) === 1);
  const reset = sp.getByRole('button', { name: 'Сбросить привязки Telegram' });
  await reset.click();
  const ask = sp.locator('#tgAsk');
  await ask.waitFor({ timeout: 10000 });
  check('сброс: подтверждение с нужным текстом', (await ask.innerText()).includes('Все пользователи заново привяжут бота. Логины и данные журнала останутся. Продолжить?'));
  await noHScroll(sp, 'sysadmin, Служебное'); await taps(sp, 'sysadmin, Служебное', ['#app', '#nav']);
  await ask.getByRole('button', { name: 'Отмена' }).click();
  check('«Отмена» ничего не сбрасывает', (await get(`tg_links?user_id=eq.${uid}&select=user_id`)).length === 1);
  await reset.click(); await sp.locator('#tgAsk').getByRole('button', { name: 'Да, сбросить' }).click();
  const resText = await sp.locator('#tgBody').getByText(/Сброшено \d+, разослано \d+/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  check('сисадмин: итог «Сброшено N, разослано M»', resText, (await sp.locator('#tgBody').innerText()).slice(0, 200));
  check('сброс: tg_links пользователя удалена, tg_rebind создана с old_telegram_id', await (async () => { const r = (await get(`tg_rebind?user_id=eq.${uid}&select=old_telegram_id,requested_at`))[0]; const l = await get(`tg_links?user_id=eq.${uid}&select=user_id`); return !!r && r.old_telegram_id != null && l.length === 0; })());
  check('сброс: tg_rebind есть и у остальных активных пользователей', (await get('tg_rebind?select=user_id')).length >= 1);
  await sp.screenshot({ path: join(shots, 'sysadmin-service.png') });
  await noHScroll(sp, 'sysadmin, итог сброса');
  await ctx3.close();

  check('JS: ошибок на всех экранах нет', errsAll.length === 0, errsAll.join(' | ').slice(0, 300));
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await PAGE.screenshot({ path: join(shots, 'fail.png') }); console.log('url:', PAGE.url()); } catch (_) {}
} finally {
  const quiet = (e) => console.log('очистка не удалась:', String(e).slice(0, 200));
  await dropUserRows().catch(quiet);
  await del(`tg_links?telegram_id=gte.${FAKE_LO}&telegram_id=lte.${FAKE_HI}`).catch(quiet);
  if (snapRebind) {                                                              // вернуть состояние проекта до массового сброса
    await del('tg_rebind?user_id=not.is.null').catch(quiet);
    if (snapRebind.length) await post('tg_rebind', snapRebind).catch(quiet);
    await del(`tg_link_codes?user_id=eq.${uid}`).catch(quiet);
  }
  if (snapLinks && snapLinks.length) await post('tg_links', snapLinks, 'resolution=merge-duplicates,return=minimal').catch(quiet);
  await dropSys().catch(quiet);
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
