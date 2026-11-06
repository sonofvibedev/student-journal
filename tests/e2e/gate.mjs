// Шлюз j2-gate.js в основном журнале (index.html) на ТЕСТОВОМ проекте, на настоящей базе:
//   легаси-студент 24ДММ-2 после переноса видит экран согласия → принимает → согласие записано в базу;
//   староста группы с ожидающими студентами видит плашку и панель «Заявки студентов».
// Запуск: node tests/e2e/gate.mjs   (после npm run test:reset; CHROME_PATH — путь к Chromium Playwright)
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
const shots = resolve(process.env.TEMP ?? '.', 'ui-e2e'); mkdirSync(shots, { recursive: true });

async function session(email, password) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  return r.access_token ? r : null;
}
async function open(browser, ses) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, JSON.stringify(ses)]);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { LOGS.push(`${m.type()}: ${m.text()}`.slice(0, 200)); }); page.on('requestfailed', (r) => LOGS.push('failed: ' + r.url().slice(0, 120)));
  LASTPAGE = page;
  await page.goto(`${BASE}/index.html#games`);   // без хэша index.html уводит в app.html
  return { page, errs, ctx };
}

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
try {
  // 1. легаси-студент: согласие
  await fetch(`${URL_SB}/rest/v1/memberships?consent_at=not.is.null`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent_at: null, consent_version: null }) });
  const s = await session('student02@journal-test.example', env.TEST_PASSWORD);
  check('легаси-студент вошёл', !!s);
  const a = await open(browser, s);
  await a.page.getByRole('dialog').getByText('Ваши данные в журнале').waitFor({ timeout: 30000 });
  check('после обновления студент видит экран согласия', true);
  const inert = await a.page.evaluate(() => [...document.body.children].some((c) => c.inert));
  check('пока согласия нет, остальное содержимое страницы закрыто (inert)', inert);
  await a.page.screenshot({ path: join(shots, 'g1.png') });
  check('кнопка «Принять» неактивна без галочки', await a.page.getByRole('button', { name: /Принять и продолжить/ }).isDisabled());
  await a.page.getByRole('checkbox').check();
  await a.page.getByRole('button', { name: /Принять и продолжить/ }).click();
  await a.page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 30000 }).catch(() => {});
  const mem = await (await fetch(`${URL_SB}/rest/v1/memberships?user_id=eq.${s.user.id}&select=consent_at,consent_version`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  check('согласие записано в базу (дата и версия)', !!mem[0]?.consent_at && !!mem[0]?.consent_version, JSON.stringify(mem));
  const cons = await (await fetch(`${URL_SB}/rest/v1/consents?user_id=eq.${s.user.id}&select=version,text_hash`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  check('в consents есть версия и хэш текста', cons.length >= 1 && /^[0-9a-f]{64}$/.test(cons[0]?.text_hash ?? ''), JSON.stringify(cons));
  check('index.html: ошибок JS нет', a.errs.length === 0, a.errs.join(' | ').slice(0, 200));
  await a.ctx.close();

  // 2. староста: плашка с заявками. Староста 24ДММ-2 есть в импорте (isAdmin); ожидающего создаём через API
  const heads = await (await fetch(`${URL_SB}/rest/v1/memberships?extra_role=eq.headman&group_id=eq.00000000-0000-4000-8000-000000000024&select=user_id`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  const headUser = (await (await fetch(`${URL_SB}/auth/v1/admin/users/${heads[0].user_id}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json());
  check('в легаси-группе есть староста (перенесён isAdmin)', !!headUser.email, JSON.stringify(heads));
  const hs = await session(headUser.email, env.TEST_PASSWORD);
  await fetch(`${URL_SB}/rest/v1/memberships?user_id=eq.${hs.user.id}`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
  // освободим одного легаси-студента и занять «pending» под отдельным пользователем
  const free = await (await fetch(`${URL_SB}/rest/v1/students?group_id=eq.00000000-0000-4000-8000-000000000024&claim_status=eq.active&select=id,claimed_by&limit=1&order=sort.desc`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  const victim = free[0];
  const pendBefore = await (await fetch(`${URL_SB}/rest/v1/students?group_id=eq.00000000-0000-4000-8000-000000000024&claim_status=eq.pending&select=id`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  await fetch(`${URL_SB}/rest/v1/students?id=eq.${victim.id}`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ claim_status: 'pending' }) });
  await fetch(`${URL_SB}/rest/v1/memberships?user_id=eq.${victim.claimed_by}`, { method: 'PATCH', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'pending' }) });
  const h = await open(browser, hs);
  const badge = h.page.getByText(/ждут подтверждения|ждёт подтверждения/).first();
  await badge.waitFor({ timeout: 30000 });
  check('староста видит плашку «ждут подтверждения»', true);
  await badge.click();
  await h.page.getByRole('button', { name: 'Это он' }).first().waitFor({ timeout: 15000 });
  await h.page.screenshot({ path: join(shots, 'g2.png') });
  await h.page.getByRole('button', { name: 'Это он' }).first().click();
  await h.page.waitForTimeout(2500);
  const after = await (await fetch(`${URL_SB}/rest/v1/students?id=eq.${victim.id}&select=claim_status`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
  check('«Это он» подтверждает студента в базе', after[0]?.claim_status === 'active', JSON.stringify(after));
  check('старост index.html: ошибок JS нет', h.errs.length === 0, h.errs.join(' | ').slice(0, 200));
  await h.ctx.close();
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 200));
  console.log('--- консоль страницы:' + String.fromCharCode(10) + LOGS.slice(-15).join(String.fromCharCode(10)));
  try { await LASTPAGE.screenshot({ path: join(shots, 'g-fail.png') }); console.log('title:', await LASTPAGE.title(), '| url:', LASTPAGE.url()); } catch (_) {}
} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
