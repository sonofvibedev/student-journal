// Утилита сисадмина (этап 5) на ТЕСТОВОМ проекте, на настоящей базе, 390×844:
//   пять разделов (Состояние, Логи, Роли, Группы, Служебное), числа по фикстурам client_events, фильтры логов и «Показать ещё»,
//   назначение и снятие преподавателя, создание и отключение группы (код один раз), режим техработ, список копий, monitor.js.
// Запуск: node tests/e2e/ops.mjs   (после npm run test:migrate, test:reset и test:deploy; CHROME_PATH — путь к Chromium)
// Нужны: миграция этапа 5 и функции client-report, backup-link (остальные необязательны: тест скажет, чего не хватает).
// Прод не затрагивается: env.js подменяется, guard, запросы к прод-ref обрываются. Все фикстуры помечены e2e-ops-<прогон> / E2E-OPS-<прогон>
// и удаляются в конце; режим техработ возвращается к исходному в finally. Письма и Telegram не отправляются («Отправить сводку» не нажимается).
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
const shots = resolve(process.env.TEMP ?? '.', 'ops-e2e'); mkdirSync(shots, { recursive: true });
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SH, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`);
  try { return t ? JSON.parse(t) : null; } catch (_) { return t; }
};
const get = (path) => api(`/rest/v1/${path}`);
const post = (table, rows) => api(`/rest/v1/${table}`, { method: 'POST', body: JSON.stringify(rows) });
const patch = (path, body) => api(`/rest/v1/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => api(`/rest/v1/${path}`, { method: 'DELETE' });
const until = async (fn, ms = 14000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 400)); } };

const run = Date.now().toString(36);
const TAG = `e2e-ops-${run}`, GNAME = `E2E-OPS-${run}`;
const SYS_EMAIL = 'ops-e2e-sys@journal-test.example', SYS_PW = `T${run}x9Qz!aa`;
const TCH_EMAIL = 'ops-e2e-teacher@journal-test.example', TCH_PW = `T${run}y8Wz!bb`;
const SUBJ = `Предмет ${TAG}`;
const CODE_RE = /^[A-Z0-9]{4} [A-Z0-9]{4}$/;

const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }
const uid = ses.user.id;
const [smem] = await get(`memberships?user_id=eq.${uid}&base_role=eq.student&status=eq.active&select=group_id,consent_at,consent_version`);
const GID = smem?.group_id;
if (!GID) { console.error('У student02 нет действующего членства: запустите npm run test:reset'); server.close(); process.exit(1); }

let sysId = null, tchId = null, newGroupId = null, origMaint, backupId = null;
async function userIdsByEmail(...emails) {
  const list = await api('/auth/v1/admin/users?per_page=1000').catch(() => null);
  return (list?.users ?? []).filter((x) => emails.includes(x.email)).map((x) => x.id);
}
async function dropUsers() {                                       // идемпотентно: находит и остатки прошлых запусков
  for (const id of await userIdsByEmail(SYS_EMAIL, TCH_EMAIL)) {
    await del(`sysadmins?user_id=eq.${id}`).catch(() => {});
    await del(`teacher_assignments?user_id=eq.${id}`).catch(() => {});
    await del(`memberships?user_id=eq.${id}`).catch(() => {});
    await del(`audit_log?actor=eq.${id}`).catch(() => {});
    await api(`/auth/v1/admin/users/${id}`, { method: 'DELETE' }).catch(() => {});
  }
}
async function dropGroups() {
  for (const g of await get('groups?name=like.E2E-OPS-*&select=id').catch(() => [])) {
    await del(`audit_log?group_id=eq.${g.id}`).catch(() => {});
    await del(`students?group_id=eq.${g.id}`).catch(() => {});
    await del(`memberships?group_id=eq.${g.id}`).catch(() => {});
    await del(`groups?id=eq.${g.id}`).catch((e) => console.log('группу E2E-OPS удалить не удалось:', String(e).slice(0, 160)));
  }
}
const dropEvents = () => del('client_events?message=like.e2e-ops-*').catch(() => {});

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
const ctxs = [];
async function newCtx(storage, init) {
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
  if (init) await ctx.addInitScript(init);
  return ctx;
}
const errsAll = [];
async function newPage(ctx, track) {
  const page = await ctx.newPage(); PAGE = page;
  if (track) {
    page.on('pageerror', (e) => errsAll.push(String(e)));
    page.on('console', (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 200); LOGS.push(t); if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errsAll.push(t); });
  }
  return page;
}
const noHScroll = async (page, label) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= 390 && w[0] <= w[1], JSON.stringify(w)); };
const taps = async (page, label) => {
  const bad = await page.evaluate(() => [...document.querySelectorAll('#app button:not(:disabled), #app a[href], #nav button')]
    .filter((e) => e.offsetParent && !e.closest('.j2-hidden') && e.getBoundingClientRect().height < 43.5).map((e) => `${e.dataset.act || e.className || e.tagName}:${Math.round(e.getBoundingClientRect().height)}`));
  check(`${label}: нажимаемое не ниже 44 px`, bad.length === 0, bad.join(', '));
};
const layout = async (page, label) => { await noHScroll(page, label); await taps(page, label); };
const tab = async (page, name, title) => { await page.locator(`#nav button[data-tab="${name}"]`).click(); await page.locator('#title', { hasText: title }).waitFor({ timeout: 15000 }); };
const msgText = (page) => page.locator('#msg').innerText();
const pctNum = (s) => Number(String(s).replace('%', '').replace(',', '.'));

try {
  // ----- хвосты прошлого прогона, фикстуры -----
  await dropUsers(); await dropGroups(); await dropEvents();
  const su = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: SYS_EMAIL, password: SYS_PW, email_confirm: true }) });
  sysId = su.id; await post('sysadmins', { user_id: sysId });
  const tu = await api('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email: TCH_EMAIL, password: TCH_PW, email_confirm: true }) });
  tchId = tu.id;
  origMaint = (await get('app_settings?key=eq.maintenance&select=value'))[0]?.value ?? { on: false };
  await patch(`memberships?user_id=eq.${uid}&group_id=eq.${GID}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' });

  // PostgREST требует одинаковые ключи во всех строках пакета
  const mk = (source, kind, name, message, extra = {}) => ({ source, kind, name, message: `${TAG} ${message}`, ok: null, ms: null, detail: null, ua: null, ...extra });
  const rows = [
    ...Array.from({ length: 55 }, (_, i) => mk('client', 'error', 'E2EOpsBulk', `bulk ${i}`)),   // первыми (старше): больше страницы в 50 строк, проверка «Показать ещё»
    mk('health', 'ping', 'db', 'ping1', { ok: true, ms: 100 }), mk('health', 'ping', 'db', 'ping2', { ok: true, ms: 200 }),
    mk('health', 'ping', 'db', 'ping3', { ok: true, ms: 300 }), mk('health', 'ping', 'db', 'ping4', { ok: false, ms: null }),
    mk('client', 'perf', 'page', 'perf1', { ms: 1500 }),
    ...Array.from({ length: 7 }, () => mk('client', 'error', 'E2EOpsError', 'client boom', { detail: 'page: app.html\nat foo (app.js:1)', ua: 'e2e' })),
    ...Array.from({ length: 4 }, () => mk('server', 'error', 'e2e-ops-fn', 'server boom', { detail: 'code 500' })),
  ];
  await post('client_events', rows);
  const [bk] = await post('backups', { kind: 'manual', path: null, size_bytes: 4096, tables: { groups: 1, students: 2 }, status: 'ok' });
  backupId = bk.id;

  // ожидаемые числа из самой базы за те же 24 часа (в проекте могут быть и чужие строки: cron health-check)
  const count = async (q) => {
    const r = await fetch(`${URL_SB}/rest/v1/client_events?${q}&select=id`, { headers: { ...SH, Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' } });
    return Number((r.headers.get('content-range') ?? '').split('/')[1]) || 0;
  };
  const expected = async () => {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString(), w = `at=gte.${since}`;
    const [pings, ok, client, server] = await Promise.all([count(`kind=eq.ping&${w}`), count(`kind=eq.ping&ok=is.true&${w}`), count(`kind=eq.error&source=eq.client&${w}`), count(`kind=eq.error&source=eq.server&${w}`)]);
    return { pings, pct: pings ? (100 * ok) / pings : null, client, server };
  };

  // ===== вход и «Состояние» =====
  const ctx = await newCtx(null);
  const sp = await newPage(ctx, true);
  const before = await expected();
  await sp.goto(`${BASE}/sysadmin.html`);
  await sp.fill('#email', SYS_EMAIL); await sp.fill('#pass', SYS_PW); await sp.click('#loginBtn');
  await sp.locator('#title', { hasText: 'Состояние' }).waitFor({ timeout: 30000 });
  const grid = await sp.locator('.sa-state-grid').waitFor({ timeout: 20000 }).then(() => true, () => false);
  check('Состояние: показатели загрузились (нужна миграция этапа 5: ops_summary)', grid, (await sp.locator('#view').innerText()).slice(0, 200));
  const after = await expected();
  const val = async (label) => (await sp.locator('.sa-state-grid .j2-card', { has: sp.locator('p', { hasText: new RegExp(`^${label}$`) }) }).locator('.big').innerText()).trim();
  const near = (n) => n === before.client || n === after.client;
  if (grid) {
    const cl = Number(await val('Ошибки браузера')), sv = Number(await val('Ошибки сервера'));
    check(`Состояние: «Ошибки браузера» = ${before.client} по базе (минимум 62 фикстуры)`, near(cl) && cl >= 62, `${cl}`);
    check(`Состояние: «Ошибки сервера» = ${before.server} по базе (минимум 4 фикстуры)`, (sv === before.server || sv === after.server) && sv >= 4, `${sv}`);
    const pct = await val('Доступность'), exp = [before.pct, after.pct].filter((x) => x != null);
    check(`Состояние: доступность ${before.pct?.toFixed(1)}% по базе`, pct !== '—' && exp.some((x) => Math.abs(pctNum(pct) - x) < 0.2), pct);
    const text = await sp.locator('.sa-state-grid').innerText();
    check('Состояние: число проверок подписано', new RegExp(`${before.pings}|${after.pings}`).test(text) && /провер/.test(text), text.slice(0, 200));
    check('Состояние: «Частые ошибки» показывает фикстурную ошибку', (await sp.locator('#view').innerText()).includes(`${TAG} client boom`));
    check('Состояние: блок «Отчёты о сбоях» с кнопкой «Отправить сводку сейчас»', (await sp.getByRole('button', { name: 'Отправить сводку сейчас' }).count()) === 1);
    await sp.locator('[data-hours="168"]').click(); await sp.locator('.sa-state-grid').waitFor({ timeout: 15000 });
    check('Состояние: переключатель «7 дней» работает', (await sp.locator('[data-hours="168"]').getAttribute('aria-selected')) === 'true');
  }
  await layout(sp, 'Состояние'); await sp.screenshot({ path: join(shots, 'state.png'), fullPage: true });

  // ===== «Логи» =====
  await tab(sp, 'logs', 'Логи');
  await sp.locator('#logBody li, #logBody .j2-card.bad').first().waitFor({ timeout: 15000 });   // «Загружаем…» тоже <p>: ждём именно записи
  // 2.0.3: первая вкладка — «Все пользователи» (лента sysadmin_activity_log): фильтры и выгрузка есть
  check('Логи: по умолчанию «Все пользователи», есть фильтры и выгрузка', (await sp.locator('[data-log="all"][aria-selected="true"]').count()) === 1 && (await sp.locator('#lfUser, #lfRole, #lfKind, #lfFrom, #lfTo, #lfQ').count()) === 6 && (await sp.getByRole('button', { name: /Выгрузить в CSV/ }).count()) === 1);
  await sp.locator('[data-log="audit"]').click(); await sp.locator('#logBody li, #logBody .j2-card.bad').first().waitFor({ timeout: 15000 });
  check('Логи: «Действия» показывают записи журнала', (await sp.locator('#logBody li').count()) > 0);
  await layout(sp, 'Логи: действия');
  await sp.locator('[data-log="client"]').click();
  await sp.locator('#logBody li').first().waitFor({ timeout: 15000 });
  const logTxt = await sp.locator('#logBody').innerText();
  check('Логи: «Ошибки браузера» показывают фикстурную ошибку', logTxt.includes(`${TAG} client boom`) && logTxt.includes('E2EOpsError'), logTxt.slice(0, 200));
  const n1 = await sp.locator('#logBody li').count();
  check('Логи: первая страница 50 записей и кнопка «Показать ещё»', n1 === 50 && (await sp.getByRole('button', { name: 'Показать ещё' }).count()) === 1, String(n1));
  await layout(sp, 'Логи: ошибки браузера');
  await sp.getByRole('button', { name: 'Показать ещё' }).click();
  check('Логи: «Показать ещё» добавляет записи', !!(await until(async () => (await sp.locator('#logBody li').count()) > n1, 10000)));
  await sp.locator('[data-log="server"]').click(); await sp.locator('#logBody li').first().waitFor({ timeout: 15000 });
  const srv = await sp.locator('#logBody').innerText();
  check('Логи: «Ошибки сервера» показывают фикстуру и не показывают ошибки браузера', srv.includes(`${TAG} server boom`) && !srv.includes('client boom'), srv.slice(0, 200));
  await sp.locator('[data-log="perf"]').click(); await sp.locator('#logBody li').first().waitFor({ timeout: 15000 });
  check('Логи: «Замеры» показывают «Загрузка страницы: 1,5 с»', (await sp.locator('#logBody').innerText()).includes('Загрузка страницы: 1,5 с'));
  await layout(sp, 'Логи: замеры');

  // ===== «Роли» =====
  await tab(sp, 'roles', 'Роли');
  for (const [s, label] of [['req', 'Заявки'], ['grp', 'Роли групп'], ['tch', 'Преподаватели'], ['adm', 'Сисадмины']]) {
    await sp.locator(`[data-sub="${s}"]`).click(); await sp.waitForTimeout(700);
    check(`Роли: сегмент «${label}» выбран`, (await sp.locator(`[data-sub="${s}"]`).getAttribute('aria-selected')) === 'true');
    await layout(sp, `Роли: ${label}`);
  }
  await sp.locator('[data-sub="adm"]').click();
  await sp.locator('#view', { hasText: SYS_EMAIL }).waitFor({ timeout: 15000 });
  const me = sp.locator('#view li', { hasText: SYS_EMAIL });
  check('Сисадмины: себя видно с пометкой «это вы» и без кнопки «Снять»', (await me.innerText()).includes('это вы') && (await me.locator('[data-act="adm-rm"]').count()) === 0);

  await sp.locator('[data-sub="tch"]').click(); await sp.locator('#tfEmail').waitFor({ timeout: 15000 });
  await sp.selectOption('#roleGroup', GID); await sp.locator('#tfEmail').waitFor({ timeout: 15000 });
  const addSubj = async () => { await sp.fill('#tfManual', SUBJ); await sp.press('#tfManual', 'Enter'); };
  await addSubj();
  check('Преподаватель: свой предмет добавлен и выбран', (await sp.locator('#tfChips [aria-pressed="true"]', { hasText: SUBJ }).count()) === 1);
  // студент группы преподавателем стать не может
  await sp.fill('#tfEmail', 'student02@journal-test.example'); await sp.locator('[data-act="tch-add"]').click();
  check('Преподаватель: студента группы назначить нельзя (понятная ошибка)', !!(await until(async () => /студент не может быть преподавателем/.test(await msgText(sp)), 15000)), await msgText(sp));
  // неизвестная почта: предложение создать учётную запись (не создаём)
  await sp.fill('#tfEmail', `nobody-${run}@journal-test.example`); await sp.locator('[data-act="tch-add"]').click();
  await sp.locator('#askCard').waitFor({ timeout: 15000 });
  check('Преподаватель: для неизвестной почты предложено создать учётную запись', (await sp.locator('#askCard').innerText()).includes('ещё нет'));
  await sp.locator('[data-act="ask-no"]').click();
  check('Преподаватель: после «Отмена» ничего не создано', (await userIdsByEmail(`nobody-${run}@journal-test.example`)).length === 0);
  // существующая почта
  await sp.fill('#tfEmail', TCH_EMAIL); await sp.selectOption('#tfRole', 'teacher_practice');
  await sp.locator('[data-act="tch-add"]').click();
  await sp.locator('#view li', { hasText: TCH_EMAIL }).waitFor({ timeout: 20000 });
  check('Преподаватель: сообщение «Готово»', /Готово/.test(await msgText(sp)), await msgText(sp));
  const m1 = (await get(`memberships?user_id=eq.${tchId}&group_id=eq.${GID}&select=base_role,status`))[0];
  check('Преподаватель: членство teacher_practice active', m1?.base_role === 'teacher_practice' && m1?.status === 'active', JSON.stringify(m1));
  const ta = await get(`teacher_assignments?user_id=eq.${tchId}&group_id=eq.${GID}&select=subject,lesson_kind`);
  check('Преподаватель: назначение с предметом и видом «practice»', ta.length === 1 && ta[0].subject === SUBJ && ta[0].lesson_kind === 'practice', JSON.stringify(ta));
  await layout(sp, 'Роли: Преподаватели (после добавления)'); await sp.screenshot({ path: join(shots, 'teachers.png'), fullPage: true });
  await sp.locator('#view li', { hasText: TCH_EMAIL }).locator('[data-act="tch-rm"]').click();
  await sp.locator('#askCard').waitFor({ timeout: 10000 });
  check('Снятие: подтверждение «Подтвердите действие» с «Отмена»', (await sp.locator('#askCard h2').innerText()).includes('Подтвердите действие') && (await sp.locator('#askCard').getByRole('button', { name: 'Отмена' }).count()) === 1);
  await sp.locator('[data-act="ask-no"]').click();
  check('Снятие: «Отмена» оставляет членство', (await get(`memberships?user_id=eq.${tchId}&group_id=eq.${GID}&select=status`))[0]?.status === 'active');
  await sp.locator('#view li', { hasText: TCH_EMAIL }).locator('[data-act="tch-rm"]').click();
  await sp.locator('[data-act="ask-yes"]').click();
  check('Снятие: членство removed', !!(await until(async () => (await get(`memberships?user_id=eq.${tchId}&group_id=eq.${GID}&select=status`))[0]?.status === 'removed')));
  check('Снятие: назначения удалены', (await get(`teacher_assignments?user_id=eq.${tchId}&group_id=eq.${GID}&select=subject`)).length === 0);
  check('Снятие: сообщение о результате', !!(await until(async () => /больше не преподаватель/.test(await msgText(sp)), 10000)), await msgText(sp));

  // ===== «Группы» =====
  await tab(sp, 'groups', 'Группы');
  await sp.locator('#ngBox').waitFor({ timeout: 15000 });
  await layout(sp, 'Группы (форма закрыта)');
  await sp.locator('#ngBox > summary').click();
  await sp.fill('#ng-name', GNAME); await sp.fill('#ng-faculty', 'Тестовый факультет'); await sp.fill('#ng-form', 'Дневная'); await sp.fill('#ng-course', '2');
  await sp.fill('#ng-students', 'Тестов Алексей; бюджет\nПроверкин Борис; платная\nОбразцов Василий');
  check('Группы: подсказка «Студентов: 3 (бюджет 1, платная 1, форма не указана 1)»', (await sp.locator('#ngPrev').innerText()).startsWith('Студентов: 3 (бюджет 1, платная 1, форма не указана 1)'), await sp.locator('#ngPrev').innerText());
  await layout(sp, 'Группы: форма открыта'); await sp.screenshot({ path: join(shots, 'groups-form.png'), fullPage: true });
  await sp.locator('[data-act="ng-create"]').click();
  await sp.locator('#secCard').waitFor({ timeout: 30000 });
  const shown = (await sp.locator('#secVal').innerText()).trim();
  check('Группы: код показан в лайм-блоке в виде «XXXX XXXX»', CODE_RE.test(shown), shown);
  check('Группы: рядом «Скопировать» и предупреждение «показывается один раз»', (await sp.locator('#secCard').getByRole('button', { name: 'Скопировать' }).count()) === 1 && (await sp.locator('#secCard').innerText()).includes('один раз'));
  await layout(sp, 'Группы: код показан');
  const g = (await get(`groups?name=eq.${encodeURIComponent(GNAME)}&select=id,status,course,faculty`))[0];
  newGroupId = g?.id;
  check('Группы: строка группы в базе (active, курс 2)', !!g && g.status === 'active' && g.course === 2, JSON.stringify(g));
  const stu = newGroupId ? await get(`students?group_id=eq.${newGroupId}&select=last_name,first_name,study_form&order=sort`) : [];
  check('Группы: 3 студента в базе с формами budget / paid / пусто', stu.length === 3 && stu[0].study_form === 'budget' && stu[1].study_form === 'paid' && !stu[2].study_form, JSON.stringify(stu));
  check('Группы: карточка новой группы в списке', (await sp.locator(`article[data-group="${newGroupId}"]`).count()) === 1);
  const raw = shown.replace(' ', '');
  check('Группы: код в базе только хэшем (открытого кода нет в строке группы)', !JSON.stringify((await get(`groups?id=eq.${newGroupId}&select=*`))[0]).includes(raw));
  await tab(sp, 'state', 'Состояние'); await sp.locator('.sa-state-grid, .j2-card.bad').first().waitFor({ timeout: 15000 });
  const html = await sp.content();
  check('Группы: после ухода из раздела кода нет в DOM', !html.includes(shown) && !html.includes(raw) && (await sp.locator('#secCard').count()) === 0);
  await tab(sp, 'groups', 'Группы');
  await sp.locator(`article[data-group="${newGroupId}"]`).waitFor({ timeout: 15000 }).catch(() => {});
  check('Группы: вернувшись в раздел, кода не видно, группа в списке', (await sp.locator('#secCard').count()) === 0 && (await sp.locator(`article[data-group="${newGroupId}"]`).count()) === 1);

  const card = sp.locator(`article[data-group="${newGroupId}"]`);
  await card.locator('[data-act="grp-off"]').click(); await sp.locator('#askCard').waitFor({ timeout: 10000 });
  check('Отключение группы: карточка «Подтвердите действие»', (await sp.locator('#askCard h2').innerText()).includes('Подтвердите действие'));
  await sp.locator('[data-act="ask-no"]').click();
  check('Отключение: «Отмена» не меняет статус', (await get(`groups?id=eq.${newGroupId}&select=status`))[0].status === 'active');
  await card.locator('[data-act="grp-off"]').click(); await sp.locator('[data-act="ask-yes"]').click();
  check('Отключение: groups.status = closed', !!(await until(async () => (await get(`groups?id=eq.${newGroupId}&select=status`))[0].status === 'closed')));
  check('Отключение: бейдж «отключена» и кнопка «Включить»', !!(await card.locator('.sa-pill', { hasText: 'отключена' }).waitFor({ timeout: 10000 }).then(() => true, () => false)) && (await card.locator('[data-act="grp-on"]').count()) === 1);
  await card.locator('[data-act="grp-on"]').click();
  check('Включение: groups.status = active', !!(await until(async () => (await get(`groups?id=eq.${newGroupId}&select=status`))[0].status === 'active')));
  check('Включение: кнопка «Отключить» вернулась', !!(await card.locator('[data-act="grp-off"]').waitFor({ timeout: 10000 }).then(() => true, () => false)));
  // повторное создание с тем же названием
  await sp.locator('#ngBox > summary').click(); await sp.fill('#ng-name', GNAME); await sp.fill('#ng-students', 'Повторов Пётр');
  await sp.locator('[data-act="ng-create"]').click();
  check('Группы: повтор названия даёт понятную ошибку, второй группы нет', !!(await until(async () => /уже есть/.test(await msgText(sp)), 15000)) && (await get(`groups?name=eq.${encodeURIComponent(GNAME)}&select=id`)).length === 1, await msgText(sp));
  await layout(sp, 'Группы (итог)');

  // ===== «Служебное» =====
  await tab(sp, 'service', 'Служебное');
  await sp.locator('#bkBody li, #bkBody p').first().waitFor({ timeout: 20000 });
  await until(async () => !/Загрузка/.test(await sp.locator('#botBody').innerText()), 20000);
  check('Служебное: карточка бота ответила (данные или понятная ошибка с «Повторить»)', !/Загрузка/.test(await sp.locator('#botBody').innerText()), await sp.locator('#botBody').innerText());
  check('Служебное: список копий показывает фикстурную строку и «Скачать»', (await sp.locator(`#bkBody [data-act="bk-dl"][data-id="${backupId}"]`).count()) === 1 && /4 КБ/.test(await sp.locator('#bkBody').innerText()), (await sp.locator('#bkBody').innerText()).slice(0, 200));
  check('Служебное: есть «Создать копию сейчас» и «Сбросить привязки Telegram»', (await sp.getByRole('button', { name: 'Создать копию сейчас' }).count()) === 1 && (await sp.getByRole('button', { name: 'Сбросить привязки Telegram' }).count()) === 1);
  await layout(sp, 'Служебное'); await sp.screenshot({ path: join(shots, 'service.png'), fullPage: true });
  await sp.locator(`[data-act="bk-dl"][data-id="${backupId}"]`).click();
  check('Служебное: «Скачать» для записи без файла даёт понятное сообщение, не молчит', !!(await until(async () => /Ссылка не получена/.test(await sp.locator('#bkRes').innerText().catch(() => '')), 15000)), await sp.locator('#bkRes').innerText().catch(() => ''));

  // режим техработ: включить и выключить; исходное состояние вернётся в finally
  const isOn = async () => ((await get('app_settings?key=eq.maintenance&select=value'))[0]?.value?.on) === true;
  const wasOn = await isOn();
  const flip = async (toOn) => {
    if (toOn) { await sp.locator('[data-act="mt-on"]').click(); await sp.locator('#askCard').waitFor({ timeout: 10000 }); await sp.locator('[data-act="ask-yes"]').click(); }
    else await sp.locator('[data-act="mt-off"]').click();
    return until(async () => (await isOn()) === toOn || /Нет прав|староста-администратор/.test(await msgText(sp)), 15000);
  };
  for (const toOn of wasOn ? [false, true] : [true, false]) {
    const okFlip = await flip(toOn);
    const done = (await isOn()) === toOn;
    check(`Служебное: режим техработ ${toOn ? 'включается' : 'выключается'} сисадмином` + (done ? '' : ' (set_maintenance пускает только старосту-админа, не сисадмина: нужна правка миграции)'), !!okFlip && done, await msgText(sp));
    if (!done) break;
    await sp.locator(`#mtBody :text("${toOn ? 'включён' : 'выключен'}")`).first().waitFor({ timeout: 10000 }).catch(() => {});
  }
  await patch('app_settings?key=eq.maintenance', { value: origMaint });   // исходный режим сразу, чтобы студенту ниже ничего не мешало
  await ctx.close();

  // ===== monitor.js: ошибка студента доходит до client_events =====
  const t0 = new Date(Date.now() - 5000).toISOString();
  const probe = await fetch(`${URL_SB}/functions/v1/client-report`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [] }) }).catch(() => null);
  const deployed = probe && probe.status !== 404;
  check('monitor: функция client-report развёрнута на тестовом проекте (иначе npm run test:deploy)', !!deployed, probe ? `статус ${probe.status}` : 'нет ответа');
  const ctx2 = await newCtx(ses);
  const p2 = await newPage(ctx2, false);
  await p2.goto(`${BASE}/app.html`);
  await p2.locator('.cab-tabbar').waitFor({ state: 'visible', timeout: 30000 });
  check('monitor: страница подключила monitor.js', await p2.evaluate(() => window.__j2Monitor === true));
  const bad = `${TAG}-js Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl access_token=secrettoken123 https://x.example/p?token=abc`;
  await p2.evaluate((m) => { setTimeout(() => { throw new Error(m); }, 0); }, bad);
  const ev = await until(async () => (await get(`client_events?source=eq.client&kind=eq.error&message=like.${TAG}-js*&select=*`))[0], 20000);
  check(deployed ? 'monitor: через несколько секунд в client_events появилась ошибка (source client, kind error)' : 'monitor: ошибка не дошла, потому что client-report не развёрнута', !!ev);
  if (ev) {
    check('monitor: в сообщении и детали нет токена', !/eyJ|secrettoken123|token=abc/.test(`${ev.message} ${ev.detail}`), `${ev.message} | ${ev.detail}`);
    check('monitor: сообщение читаемо, есть название ошибки и страница', ev.name === 'Error' && /app\.html/.test(ev.detail ?? ''), `${ev.name} | ${ev.detail}`);
  }
  check('monitor: вместе с ошибкой ушёл замер загрузки «page»', !!(await until(async () => (await get(`client_events?source=eq.client&kind=eq.perf&name=eq.page&at=gte.${t0}&select=ms`))[0], 12000)));
  await ctx2.close();
  // флаг J2_NO_MONITOR отключает отправку
  const ctx3 = await newCtx(ses, () => { window.J2_NO_MONITOR = true; });
  const p3 = await newPage(ctx3, false);
  await p3.goto(`${BASE}/app.html`); await p3.locator('.cab-tabbar').waitFor({ state: 'visible', timeout: 30000 });
  await p3.evaluate((m) => { setTimeout(() => { throw new Error(m); }, 0); }, `${TAG}-off`);
  await p3.waitForTimeout(6000);
  check('monitor: с флагом J2_NO_MONITOR ничего не отправляется', (await get(`client_events?message=like.${TAG}-off*&select=id`)).length === 0);
  await ctx3.close();

  check('JS: ошибок на экранах утилиты нет', errsAll.length === 0, errsAll.join(' | ').slice(0, 400));
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 400));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await PAGE.screenshot({ path: join(shots, 'fail.png') }); console.log('url:', PAGE.url()); } catch (_) {}
} finally {
  const quiet = (e) => console.log('очистка не удалась:', String(e).slice(0, 200));
  if (origMaint !== undefined) await patch('app_settings?key=eq.maintenance', { value: origMaint }).catch(quiet);   // режим техработ как был
  await dropEvents();
  if (backupId) await del(`backups?id=eq.${backupId}`).catch(quiet);
  await dropGroups();
  await patch(`memberships?user_id=eq.${uid}&group_id=eq.${GID}`, { consent_at: smem?.consent_at ?? null, consent_version: smem?.consent_version ?? null }).catch(quiet);
  await dropUsers().catch(quiet);
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}`);
process.exit(failed.length ? 1 : 0);
