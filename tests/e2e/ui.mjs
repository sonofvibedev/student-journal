// Браузерный сквозной тест страниц регистрации и входа на ТЕСТОВОМ проекте (настоящие функции и база):
//   register.html (староста, 4 шага, расписание с bseu.by) → sysadmin.html (одобрение) → register.html (код группы)
//   → join.html (студент по коду, согласие, ожидание) → подтверждение → переход в журнал.
// Запуск: node tests/e2e/ui.mjs   (сначала npm run test:reset и npm run test:deploy)
// Прод не затрагивается: env.js подменяется тестовыми значениями, любой запрос к прод-ref обрывается.
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
if (!env.TEST_ANON_KEY || !env.TEST_SERVICE_KEY) { console.error('Нет ключей в .env.test: запустите npm run test:reset и node tests/e2e/flow.mjs'); process.exit(2); }

const ROOT = resolve('.');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = resolve(join(ROOT, p === '/' ? 'index.html' : p));
  if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const b = readFileSync(f); res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' }).end(b); } catch (_) { res.writeHead(404).end(); }
}).listen(0);
const BASE = `http://127.0.0.1:${server.address().port}`;

const ENV_JS = `const SUPABASE_URL='${URL_SB}';const SUPABASE_KEY='${env.TEST_ANON_KEY}';const SB_STORAGE_KEY='sb-${TEST}-auth-token';
const IS_TEST=true;const LS_PREFIX='t_';function lsGet(k,f=null){try{const v=localStorage.getItem(k);return v===null?f:v}catch(e){return f}}function lsSet(k,v){try{localStorage.setItem(k,v);return true}catch(e){return false}}function lsRemove(k){try{localStorage.removeItem(k);return true}catch(e){return false}}function lsGetJSON(k,f){try{const v=lsGet(k);return v===null?f:JSON.parse(v)}catch(e){return f}}function lsSetJSON(k,v){try{return lsSet(k,JSON.stringify(v))}catch(e){return false}}`;

const shots = resolve(process.env.TEMP ?? '.', 'ui-e2e'); mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };

const browser = await chromium.launch({ executablePath: findChrome() });
async function newCtx() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();                                 // прод запрещён
    if (u.endsWith('/env.js') && u.startsWith(BASE)) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();                                                            // всё остальное наружу не пускаем
  });
  return ctx;
}
async function noHScroll(page, label) {
  const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(`${label}: нет горизонтальной прокрутки`, w[0] <= w[1], JSON.stringify(w));
}

const run = Date.now().toString(36);
const PW = 'T' + run + 'x9Qz!aa';
const headEmail = `ui-head-${run}@journal-test.example`;
const sysEmail = `ui-sys-${run}@journal-test.example`;
const gname = `UI-${run}`;
const SVC = { apikey: env.TEST_SERVICE_KEY, Authorization: `Bearer ${env.TEST_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => { const r = await fetch(URL_SB + path, { ...init, headers: { ...SVC, ...(init.headers ?? {}) } }); const t = await r.text(); try { return JSON.parse(t); } catch (_) { return t; } };

try {
  await api('/rest/v1/join_attempts?id=gt.0', { method: 'DELETE' });
  const su = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: sysEmail, password: PW, email_confirm: true }) });
  await api('/rest/v1/rpc/sysadmin_bootstrap', { method: 'POST', body: JSON.stringify({ p_user: su.id }) });

  // ===== староста: register.html =====
  const hctx = await newCtx(); const hp = await hctx.newPage();
  const errs = []; hp.on('pageerror', (e) => errs.push(String(e)));
  await hp.goto(`${BASE}/register.html`);
  await hp.waitForFunction(() => document.querySelectorAll('#fac option').length > 1, null, { timeout: 30000 });
  await hp.selectOption('#fac', '13');
  await hp.waitForFunction(() => document.querySelectorAll('#frm option').length > 1, null, { timeout: 30000 });
  await hp.selectOption('#frm', '10');
  await hp.waitForFunction(() => document.querySelectorAll('#crs option').length > 1, null, { timeout: 30000 });
  await hp.selectOption('#crs', '3');
  await hp.waitForFunction(() => document.querySelectorAll('#grp option').length > 1, null, { timeout: 30000 });
  await hp.selectOption('#grp', '9457');
  await noHScroll(hp, 'register, шаг 1');
  await hp.screenshot({ path: join(shots, 'r1.png') });
  await hp.click('#next1');
  await hp.fill('#name', 'Козлова Анна'); await hp.fill('#email', headEmail); await hp.fill('#pw', PW);
  await noHScroll(hp, 'register, шаг 2');
  await hp.click('#next2');
  await hp.waitForSelector('#s3:not(.j2-hidden)', { timeout: 30000 });
  check('шаг 2: аккаунт создан, открыт шаг 3', true);
  await hp.fill('#paste', 'Иванова Мария\nПетров Дмитрий, платная\nСидоренко Ольга\nВолкова Наталья\nКозлова Анна');
  await hp.click('#load');
  const counts = await hp.evaluate(() => [document.getElementById('nBudget').textContent, document.getElementById('nPaid').textContent]);
  check('шаг 3: бюджет 4, платная 1', counts[0].trim() === '4' && counts[1].trim() === '1', JSON.stringify(counts));
  await hp.selectOption('#me', { label: 'Козлова Анна' }).catch(() => {});
  await noHScroll(hp, 'register, шаг 3');
  await hp.screenshot({ path: join(shots, 'r3.png') });
  await hp.click('#next3');
  await hp.waitForSelector('#s4:not(.j2-hidden)', { timeout: 30000 });
  await hp.waitForFunction(() => /Предметы|не найден/i.test(document.getElementById('schedBox').textContent), null, { timeout: 60000 }).catch(async () => {
    await hp.screenshot({ path: join(shots, 'r4-fail.png') });
    console.log('schedBox:', (await hp.locator('#schedBox').innerText()).slice(0, 300), '| m4:', (await hp.locator('#m4').innerText()).slice(0, 200));
    throw new Error('расписание не появилось');
  });
  const sched = await hp.locator('#schedBox').innerText();
  const h4 = await hp.locator('#h1').innerText();
  check('шаг 4: расписание с bseu.by найдено (предметы и преподаватели)', /нашлось/i.test(h4) && /Предметы/.test(sched) && /Преподаватели/.test(sched), (h4 + ' | ' + sched).slice(0, 160));
  await noHScroll(hp, 'register, шаг 4');
  await hp.screenshot({ path: join(shots, 'r4.png') });
  await hp.click('#submit4');
  await hp.waitForSelector('#s5:not(.j2-hidden)', { timeout: 30000 });
  check('заявка отправлена (экран 5)', /отправлена/i.test(await hp.locator('#h1').innerText()));
  await hp.screenshot({ path: join(shots, 'r5.png') });
  check('register: ошибок JS нет', errs.length === 0, errs.join(' | '));

  // ===== сисадмин: sysadmin.html =====
  const sctx = await newCtx(); const sp = await sctx.newPage();
  await sp.goto(`${BASE}/sysadmin.html`);
  await sp.fill('#email', sysEmail); await sp.fill('#pass', PW); await sp.click('#loginBtn');
  await sp.getByRole('button', { name: 'Роли' }).first().click({ timeout: 30000 });
  await sp.waitForFunction((g) => document.body.innerText.includes(g), `${'24 ДММ-2'}`, { timeout: 30000 }).catch(() => {});
  const card = sp.locator('.j2-card', { hasText: headEmail }).first();
  await card.waitFor({ timeout: 30000 });
  check('сисадмин видит заявку старосты', true);
  await noHScroll(sp, 'sysadmin, заявки');
  await sp.screenshot({ path: join(shots, 's1.png') });
  await card.getByRole('button', { name: 'Одобрить' }).click();
  await sp.waitForSelector('.j2-code', { timeout: 30000 });
  const codeShown = (await sp.locator('.j2-code').first().innerText()).replace(/\s/g, '');
  check('сисадмин получил код группы (8 символов)', /^[A-Z0-9-]{8,9}$/.test(codeShown), codeShown);
  await sp.screenshot({ path: join(shots, 's2.png') });

  // ===== староста видит одобрение и получает код =====
  await hp.reload();
  await hp.getByRole('button', { name: /Показать код/ }).click({ timeout: 60000 });
  await hp.waitForSelector('.j2-code', { timeout: 30000 });
  const code = (await hp.locator('.j2-code').first().innerText()).replace(/[\s-]/g, '');
  check('староста получил код группы после одобрения', /^[A-Z0-9]{8}$/.test(code), code);
  await hp.screenshot({ path: join(shots, 'r6.png') });

  // ===== студент: join.html =====
  const jctx = await newCtx(); const jp = await jctx.newPage();
  const jerrs = []; jp.on('pageerror', (e) => jerrs.push(String(e)));
  await jp.goto(`${BASE}/join.html`);
  await jp.fill('#code', code); await jp.press('#code', 'Enter');
  await jp.waitForSelector('#sec-pick:not(.j2-hidden)', { timeout: 30000 });
  const names = await jp.locator('#pick-list button').allInnerTexts();
  check('выбор себя: видны свободные студенты, староста не в списке', names.length === 4 && !names.some((n) => /Козлова/.test(n)), JSON.stringify(names));
  await noHScroll(jp, 'join, выбор');
  await jp.screenshot({ path: join(shots, 'j1.png') });
  await jp.locator('#pick-list button').first().click();
  await jp.click('#confirm-yes');
  await jp.waitForSelector('#sec-consent:not(.j2-hidden)', { timeout: 15000 });
  check('согласие: кнопка неактивна без галочки', await jp.locator('#consent-ok').isDisabled());
  await jp.check('#agree'); await jp.screenshot({ path: join(shots, 'j2.png') });
  await jp.click('#consent-ok');
  await jp.fill('#login', `ui_st_${run}`); await jp.fill('#pw', PW); await jp.fill('#pw2', PW);
  await jp.press('#pw2', 'Enter');
  await jp.waitForSelector('#sec-wait:not(.j2-hidden)', { timeout: 30000 });
  check('студент в ожидании подтверждения', /Ждём подтверждения/i.test(await jp.locator('#h-wait').innerText()));
  await noHScroll(jp, 'join, ожидание');
  await jp.screenshot({ path: join(shots, 'j3.png') });
  await jp.getByRole('button', { name: 'Напомнить старосте' }).click();
  await jp.waitForTimeout(1500);
  check('join: ошибок JS нет', jerrs.length === 0, jerrs.join(' | '));

  // староста подтверждает через RPC (под его сессией): интерфейс старосты в основном журнале появится на этапе 2
  const tok = (await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: env.TEST_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: headEmail, password: PW }) })).json()).access_token;
  const pend = await (await fetch(`${URL_SB}/rest/v1/students?claim_status=eq.pending&select=id`, { headers: { apikey: env.TEST_ANON_KEY, Authorization: `Bearer ${tok}` } })).json();
  const ap = await fetch(`${URL_SB}/rest/v1/rpc/membership_approve`, { method: 'POST', headers: { apikey: env.TEST_ANON_KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_student_id: pend[0]?.id }) });
  check('староста подтвердил студента', ap.status < 300, String(ap.status));
  await jp.waitForURL(/(app|index)\.html/, { timeout: 40000 }).then(() => check('после подтверждения страница ведёт в журнал', true)).catch(() => check('после подтверждения страница ведёт в журнал', false, 'нет перехода за 40 с'));
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
} finally {
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}. Скриншоты: ${shots}`);
process.exit(failed.length ? 1 : 0);
