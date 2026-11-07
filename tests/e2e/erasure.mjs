// Этап 6: удаление данных по просьбе (app.html → headman.html) на ТЕСТОВОМ проекте, настоящая база, браузер 390x844.
// Запуск: node tests/e2e/erasure.mjs   (после npm run test:migrate и npm run test:reset; CHROME_PATH — путь к Chromium)
// Три одноразовых студента (создаются тестом и удаляются в конце; реальных студентов тест не трогает: стёртая запись заморожена триггером,
// npm run test:reset её не вернёт): A просит и староста удаляет, B просит и отзывает, C просит и староста отклоняет. Прод не затрагивается: env.js подменяется, любой запрос к прод-ref обрывается, цель проверяет guard.
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
if (!ANON || !SERVICE || !env.TEST_PASSWORD) { console.error('Нет ключей или пароля в .env.test: запустите npm run test:reset'); process.exit(2); }
const G = '00000000-0000-4000-8000-000000000024';

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
const api = async (path, init = {}) => {
  const r = await fetch(URL_SB + path, { ...init, headers: { ...SVC, Prefer: 'return=representation', ...(init.headers ?? {}) } });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) { /* не json */ }
  if (init.soft) return { status: r.status, body: j };
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)} → ${r.status} ${String(t).slice(0, 200)}`);
  return j;
};
const get = (path) => api(`/rest/v1/${path}`);
const patch = (path, body) => api(`/rest/v1/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
async function session(email, password) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  return r.access_token ? r : null;
}
const pollDb = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 400)); } };
const reqOf = async (uid) => (await get(`data_deletion_requests?user_id=eq.${uid}&select=status,note&order=created_at.desc&limit=1`))[0];

const browser = await chromium.launch({ executablePath: findChrome() });
const mkCtx = async (ses) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.split('?')[0].endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.includes('/vendor/telegram-web-app.js')) return route.abort();   // в тестах Telegram подделан, настоящий скрипт его бы затёр
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(ses)]);
  return ctx;
};
const noHScroll = async (p, label) => { const w = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= w[1], JSON.stringify(w)); };
const taps = async (p, label) => {
  const bad = await p.evaluate(() => [...document.querySelectorAll('#cabMain a[href], #cabMain button')].map((el) => {
    if (el.closest('.j2-hidden')) return null;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.height < 43.9 ? `${el.tagName}|${(el.textContent || '').trim().slice(0, 20)}|${Math.round(b.height)}` : null;
  }).filter(Boolean));
  check(`${label}: нажимаемое не ниже 44 px`, bad.length === 0, bad.slice(0, 4).join('; '));
};
const toast = (p, text) => p.locator('#cabToast', { hasText: text }).waitFor({ timeout: 20000 });

let A, B, C;
const cleanup = async () => {   // идемпотентно: чистит и остатки прошлых запусков
  const ids = [0, 1, 2].map((i) => `st-e2e-erase-${i}`);
  const ms = await get(`memberships?student_id=in.(${ids.join(',')})&select=user_id`).catch(() => []);
  for (const r of ['absences', 'data_deletion_requests', 'memberships', 'students']) await api(`/rest/v1/${r}?student_id=in.(${ids.join(',')})`, { method: 'DELETE', soft: true }).catch(() => {});
  await api(`/rest/v1/students?id=in.(${ids.join(',')})`, { method: 'DELETE', soft: true }).catch(() => {});
  for (const m of ms) await api(`/auth/v1/admin/users/${m.user_id}`, { method: 'DELETE', soft: true }).catch(() => {});
  const us = await api('/auth/v1/admin/users?per_page=1000', { soft: true }).catch(() => null);
  for (const u of (us && us.body && us.body.users) || []) if (/^e2e-erase-d@/.test(u.email || '')) await api(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE', soft: true }).catch(() => {});
};
const ask = async (p, x, name) => {   // «Мои данные»: заявка в два шага
  await p.getByRole('button', { name: 'Попросить удалить мои данные' }).click();
  await p.getByRole('button', { name: 'Да, отправить заявку' }).click();
  await toast(p, 'Заявка отправлена');
  check(`${name}: заявка в базе в статусе pending`, (await pollDb(async () => (await reqOf(x.u))?.status === 'pending')) === true);
};
try {
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id,student_id`);
  if (!heads.length) throw new Error('в группе 24ДММ-2 нет старосты: запустите npm run test:reset');
  const hu = await api(`/auth/v1/admin/users/${heads[0].user_id}`);
  await cleanup();
  const NAMES = ['Лисин', 'Ежов', 'Зайцев'];
  [A, B, C] = [];
  const mk = async (i) => {
    const email = `e2e-erase-${i}@journal-test.example`;
    const u = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, password: env.TEST_PASSWORD, email_confirm: true }) });
    const s = { id: `st-e2e-erase-${i}`, last_name: NAMES[i], first_name: 'Тест' };
    await api('/rest/v1/students', { method: 'POST', body: JSON.stringify({ ...s, group_id: G, claim_status: 'active', claimed_by: u.id, claimed_at: new Date().toISOString() }) });
    await api('/rest/v1/memberships', { method: 'POST', body: JSON.stringify({ user_id: u.id, group_id: G, student_id: s.id, base_role: 'student', status: 'active', consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
    return { s, u: u.id, email };
  };
  A = await mk(0); B = await mk(1); C = await mk(2);
  await patch(`memberships?user_id=eq.${heads[0].user_id}&group_id=eq.${G}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' });
  await api('/rest/v1/absences', { method: 'POST', body: JSON.stringify({ group_id: G, student_id: A.s.id, date: '2026-11-03', subject: 'E2E Стирание', hours: 2, lesson_kind: 'lecture', created_by: null }) });
  const absBefore = (await get(`absences?student_id=eq.${A.s.id}&select=id`)).length;

  const open = async (user, page, hash) => {
    const ses = await session(user.email, env.TEST_PASSWORD);
    if (!ses) throw new Error('нет входа ' + user.email);
    const c = await mkCtx(ses), p = await c.newPage();
    p.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 200)));
    await p.goto(`${BASE}/${page}${hash}`);
    return p;
  };

  // ---------- 1. студент A просит удалить данные ----------
  const pa = await open(A, 'app.html', '#/profile/privacy');
  await pa.locator('#cabMain h1', { hasText: 'Мои данные' }).waitFor({ timeout: 30000 });
  const txt = await pa.locator('#cabMain').innerText();
  check('экран «Мои данные»: что удалится и что останется', /Что будет удалено/.test(txt) && /Что останется/.test(txt));
  await noHScroll(pa, 'мои данные'); await taps(pa, 'мои данные');
  await pa.getByRole('button', { name: 'Попросить удалить мои данные' }).click();
  check('второй шаг: предупреждение и кнопка подтверждения', await pa.getByRole('button', { name: 'Да, отправить заявку' }).isVisible() && /навсегда/.test(await pa.locator('#dlB').innerText()));
  await pa.getByRole('button', { name: 'Отмена' }).click();
  check('«Отмена»: заявки нет', !(await reqOf(A.u)));
  await ask(pa, A, 'A');
  await pa.locator('#cabMain').getByText('Заявка отправлена, ждём решения').waitFor({ timeout: 20000 });
  check('после заявки видна кнопка «Отозвать»', await pa.getByRole('button', { name: 'Отозвать заявку' }).isVisible());

  // ---------- 2. студент B просит и отзывает ----------
  const pb = await open(B, 'app.html', '#/profile/privacy');
  await pb.locator('#cabMain h1', { hasText: 'Мои данные' }).waitFor({ timeout: 30000 });
  await ask(pb, B, 'B');
  await pb.getByRole('button', { name: 'Отозвать заявку' }).click(); await toast(pb, 'Заявка отозвана');
  check('B: статус withdrawn', (await pollDb(async () => (await reqOf(B.u))?.status === 'withdrawn')) === true);

  // ---------- 3. студент C просит ----------
  const pc = await open(C, 'app.html', '#/profile/privacy');
  await pc.locator('#cabMain h1', { hasText: 'Мои данные' }).waitFor({ timeout: 30000 });
  await ask(pc, C, 'C');

  // ---------- 4. староста: сводка, список, решения ----------
  const ph = await open({ email: hu.email }, 'headman.html', '#/summary');
  await ph.getByRole('heading', { name: 'Кабинет старосты' }).waitFor({ timeout: 30000 });
  await ph.locator('a[href="#/summary/erasure"]').waitFor({ timeout: 20000 });
  const plate = await ph.locator('a[href="#/summary/erasure"]').innerText();
  check('сводка: плашка «2 просьбы удалить данные»', /2 просьбы удалить данные/.test(plate), plate);
  await ph.locator('a[href="#/summary/erasure"]').click();
  await ph.locator('#cabMain h1', { hasText: 'Удаление данных' }).waitFor({ timeout: 20000 });
  check('список: две карточки (A и C), B отозвал', await ph.locator('article[data-id]').count() === 2);
  await noHScroll(ph, 'удаление данных (староста)'); await taps(ph, 'удаление данных (староста)');
  const cardOf = (s) => ph.locator('article[data-id]').filter({ has: ph.locator('h3', { hasText: s.last_name }) });
  // C: отклонить
  await cardOf(C.s).getByRole('button', { name: /Отклонить/ }).click(); await toast(ph, 'Просьба отклонена');
  check('C: статус rejected', (await pollDb(async () => (await reqOf(C.u))?.status === 'rejected')) === true);
  // A: удалить, второй шаг
  await ph.locator('#cabMain h1', { hasText: 'Удаление данных' }).waitFor();
  await cardOf(A.s).getByRole('button', { name: /Удалить данные/ }).click();
  check('удаление: второй шаг с предупреждением', /навсегда/.test(await cardOf(A.s).innerText()));
  await cardOf(A.s).getByRole('button', { name: 'Да, удалить навсегда' }).click(); await toast(ph, 'Данные удалены');

  // ---------- 5. результат ----------
  const gone = await pollDb(async () => (await api(`/auth/v1/admin/users/${A.u}`, { soft: true })).status === 404);
  check('A: аккаунт удалён', gone === true);
  const sA = (await get(`students?id=eq.${A.s.id}&select=last_name,first_name,claim_status,claimed_by`))[0];
  check('A: запись обезличена и помечена erased', sA && sA.claim_status === 'erased' && sA.last_name === 'Удалён' && !sA.claimed_by, JSON.stringify(sA));
  check('A: пропуски остались', (await get(`absences?student_id=eq.${A.s.id}&select=id`)).length === absBefore);
  check('A: заявка done', (await get(`data_deletion_requests?student_id=eq.${A.s.id}&select=status`))[0]?.status === 'done');
  check('B и C: аккаунты на месте', (await api(`/auth/v1/admin/users/${B.u}`, { soft: true })).status === 200 && (await api(`/auth/v1/admin/users/${C.u}`, { soft: true })).status === 200);
  await pc.reload();
  const rej = await pc.locator('#cabMain').getByText('Заявку отклонили').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  check('C видит «Заявку отклонили»', rej);
  // журнал старосты не предлагает стёртого студента
  await ph.evaluate(() => { location.hash = '#/journal'; });
  await ph.getByText('Отметьте отсутствующих').waitFor({ timeout: 30000 });
  await ph.locator('.cab-stu').first().waitFor();
  const ids = await ph.locator('button.mark').evaluateAll((els) => els.map((e) => e.dataset.id));
  check('журнал: стёртого студента нет в списке отметок', ids.length > 3 && !ids.includes(A.s.id));
} catch (e) {
  console.error('ОШИБКА ТЕСТА:', e); results.push({ name: 'прогон теста', ok: false });
} finally {
  await cleanup().catch((e) => console.error('очистка:', String(e).slice(0, 200)));
  await browser.close(); server.close();
}
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
