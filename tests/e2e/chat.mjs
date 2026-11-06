// Зашифрованный чат староста ↔ преподаватель на ТЕСТОВОМ проекте, на настоящей базе, в двух настоящих браузерах сразу (390x844).
// Запуск: node tests/e2e/chat.mjs   (после npm run test:migrate и npm run test:reset; CHROME_PATH — путь к Chromium)
// Прод не затрагивается: env.js подменяется, любой запрос к прод-ref обрывается, цель проверяет guard.
// Участники: староста 24ДММ-2 (как в headman.mjs) и teacher-lecture@journal-test.example (headman.html и teacher.html).
// Всё, что создаёт тест (треды, сообщения, ключи, уведомления «chat»), удаляется сервисным ключом в начале и в конце.
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
if (!ANON || !SERVICE || !env.TEST_PASSWORD) { console.error('Нет ключей или пароля в .env.test: запустите npm run test:reset'); process.exit(2); }

const G = '00000000-0000-4000-8000-000000000024';
const TEACHER_EMAIL = 'teacher-lecture@journal-test.example';
const PW1 = 'e2e-пароль-чата-1', PW2 = 'e2e-пароль-чата-2';
const SECRET = `E2E-секрет-${Date.now()}`;
const M1 = `Лекция в ауд. 306 <i>${SECRET}</i>`;                 // угловые скобки: проверка, что текст не становится разметкой
const M2a = `Принято, ${SECRET}-ответ`, M2b = 'вторая строка ответа';
const M3 = `E2E после сбоя связи ${SECRET}`;
const M4 = `E2E опрос ${SECRET}`;
const M5 = `E2E после сброса ${SECRET}`;
const M6 = `E2E ответ после сброса ${SECRET}`;
const ALL_TEXTS = [SECRET, M2b, PW1, PW2];

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
const shots = resolve(process.env.TEMP ?? '.', 'chat-e2e'); mkdirSync(shots, { recursive: true });

const SVC = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => { const r = await fetch(URL_SB + path, { ...init, headers: { ...SVC, Prefer: 'return=representation', ...(init.headers ?? {}) } }); const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch (_) { /* не json */ } if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)} → ${r.status} ${String(t).slice(0, 200)}`); return j; };
const get = (path) => api(`/rest/v1/${path}`);
const del = (path) => api(`/rest/v1/${path}`, { method: 'DELETE' });
const patch = (path, body) => api(`/rest/v1/${path}`, { method: 'PATCH', body: JSON.stringify(body) });
async function session(email, password) {
  const r = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
  return r.access_token ? r : null;
}
// RPC от имени пользователя (как это сделала бы страница)
const rpcAs = async (ses, name, args = {}) => (await fetch(`${URL_SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ses.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json();
const unreadOf = async (ses) => { const r = await rpcAs(ses, 'chat_threads_my'); return Array.isArray(r) ? r.reduce((n, x) => n + (Number(x.unread) || 0), 0) : -1; };

async function open(browser, ses, page, hash) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', serviceWorkers: 'block' });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.includes(PROD_REF)) return route.abort();
    if (u.endsWith('/env.js') || u.includes('/env.js?')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
    if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
    return route.abort();
  });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища */ } }, [KEY, JSON.stringify(ses)]);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  // «[chat] send»: ожидаемая ошибка отправки (обрыв связи в тесте); пароли и тексты в консоль попасть не должны ни при каких условиях
  p.on('console', (m) => { const t = `${m.type()}: ${m.text()}`.slice(0, 300); LOGS.push(t); if (m.type() === 'error' && /\[(cab|headman|teacher|chat)\]/.test(m.text()) && !/\[chat\] send/.test(m.text())) errs.push(t); });
  LASTPAGE = p;
  await p.goto(`${BASE}/${page}${hash}`);
  return { page: p, errs, ctx };
}

const body = (p) => p.locator('#cabMain').innerText();
const noHScroll = async (p, label) => { const w = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); check(`${label}: нет горизонтальной прокрутки`, w[0] <= w[1], JSON.stringify(w)); };
// Нажимаемое не меньше 44 px (страница и нижний лист)
async function taps(p, label) {
  const bad = await p.evaluate(() => [...document.querySelectorAll('#cab a[href], #cab button, #cab select, #cab input, #cab textarea, #cab [role=tab], .cab-modal button')].map((el) => {
    if (el.closest('.sr-only, .j2-hidden')) return null;
    const box = (el.closest('label') || el).getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.height < 43.9 ? `${el.tagName}.${el.className}|${(el.textContent || el.id).trim().slice(0, 20)}|${Math.round(box.height)}` : null;
  }).filter(Boolean));
  check(`${label}: нажимаемое не ниже 44 px`, bad.length === 0, bad.slice(0, 5).join('; '));
}
const pollDb = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 500)); } };
const bubble = (p, text) => p.locator('.ch-b', { hasText: text }).first();
const sendBtn = (p) => p.getByRole('button', { name: 'Отправить' });
const fpOf = async (p) => (await p.locator('.ch-fp').innerText()).match(/([0-9A-F]{4} [0-9A-F]{4})/)?.[1] ?? null;
const createKeys = async (p, pw) => { await p.fill('#chPw', pw); await p.fill('#chPw2', pw); await p.getByRole('button', { name: 'Создать ключи' }).click(); };

const chrome = findChrome();
const browser = await chromium.launch({ executablePath: chrome });
let hu = null, tu = null;
const wipe = async () => {      // идемпотентно: чистит и остатки прошлых запусков
  if (!hu || !tu) return;
  const th = (await get(`chat_threads?or=(student_user_id.eq.${hu},teacher_user_id.eq.${tu})&select=id`).catch(() => [])).map((t) => t.id);
  if (th.length) {
    await del(`chat_messages?thread_id=in.(${th.join(',')})`).catch(() => {});
    await del(`chat_reads?thread_id=in.(${th.join(',')})`).catch(() => {});
    await del(`chat_threads?id=in.(${th.join(',')})`).catch(() => {});
  }
  await del(`chat_keys?user_id=in.(${hu},${tu})`).catch(() => {});
  await del(`notifications?kind=eq.chat&user_id=in.(${hu},${tu})`).catch(() => {});
};
const ctxs = [];
try {
  // ---------- фикстуры ----------
  const heads = await get(`memberships?extra_role=eq.headman&group_id=eq.${G}&status=eq.active&select=user_id`);
  if (!heads.length) throw new Error('в группе 24ДММ-2 нет старосты: запустите npm run test:reset');
  hu = heads[0].user_id;
  const huser = await api(`/auth/v1/admin/users/${hu}`);
  await patch(`memberships?user_id=eq.${hu}`, { consent_at: new Date().toISOString(), consent_version: '2026-11-05' });
  const hs = await session(huser.email, env.TEST_PASSWORD);
  const ts = await session(TEACHER_EMAIL, env.TEST_PASSWORD);
  check('староста и преподаватель лекций вошли', !!hs && !!ts, ts ? '' : `нет аккаунта ${TEACHER_EMAIL}: запустите npm run test:reset`);
  if (!hs || !ts) throw new Error('нет сессий');
  tu = ts.user.id;
  await wipe();

  // ---------- 1. преподаватель создаёт пароль переписки ----------
  const T = await open(browser, ts, 'teacher.html', '#/chat'); ctxs.push(T.ctx);
  const tp = T.page;
  await tp.getByText('Защитите переписку').first().waitFor({ timeout: 30000 });
  check('преподаватель без ключей: экран «Защитите переписку» и предупреждение про новое устройство', /Без этого пароля старые сообщения на новом устройстве не открыть/.test(await body(tp)));
  await noHScroll(tp, 'преподаватель: создание пароля'); await taps(tp, 'преподаватель: создание пароля');
  await createKeys(tp, PW1);
  await tp.getByText('Переписок пока нет').first().waitFor({ timeout: 40000 });
  check('преподаватель: ключи созданы, переписок пока нет', true);
  await tp.goto('about:blank');       // страница преподавателя «отложена»: чтение сообщения не должно случиться раньше времени (IndexedDB контекста остаётся)

  // ---------- 2. староста: ключи ----------
  const H = await open(browser, hs, 'headman.html', '#/chat'); ctxs.push(H.ctx);
  const hp = H.page;
  await hp.getByText('Защитите переписку').first().waitFor({ timeout: 30000 });
  await noHScroll(hp, 'староста: создание пароля'); await taps(hp, 'староста: создание пароля'); await hp.screenshot({ path: join(shots, 'c1-setup.png') });
  await hp.fill('#chPw', 'short'); await hp.fill('#chPw2', 'short'); await hp.getByRole('button', { name: 'Создать ключи' }).click();
  await hp.locator('#chMsg', { hasText: 'минимум 8' }).waitFor({ timeout: 10000 });
  await hp.fill('#chPw', PW1); await hp.fill('#chPw2', PW1 + 'x'); await hp.getByRole('button', { name: 'Создать ключи' }).click();
  await hp.locator('#chMsg', { hasText: 'Пароли не совпадают' }).waitFor({ timeout: 10000 });
  check('создание ключей: короткий пароль и несовпадение отклоняются понятным текстом', true);
  await createKeys(hp, PW1);
  await hp.getByRole('tab', { name: 'Лекции' }).waitFor({ timeout: 40000 });
  const hk = (await get(`chat_keys?user_id=eq.${hu}&select=public_jwk,key_version,backup`))[0];
  check('chat_keys старосты: версия 1, в публичном ключе нет закрытой части d', hk?.key_version === 1 && hk.public_jwk && !('d' in hk.public_jwk), JSON.stringify(hk?.public_jwk).slice(0, 120));
  check('резервная копия: PBKDF2 не меньше 600000 итераций, соль и iv есть, закрытого ключа в открытом виде нет', hk?.backup?.v === 1 && hk.backup.iter >= 600000 && !!hk.backup.salt && !!hk.backup.iv && !!hk.backup.ct && !('d' in hk.backup), JSON.stringify(hk?.backup).slice(0, 160));

  // ---------- 3. вкладки, отпечаток, ПЗ без ключа собеседника ----------
  check('староста: две вкладки «Лекции» и «ПЗ», выбрана «Лекции»', await hp.getByRole('tab').count() === 2 && (await hp.getByRole('tab', { name: 'Лекции' }).getAttribute('aria-selected')) === 'true');
  await hp.locator('.ch-ver').waitFor({ timeout: 20000 });
  const fpH = await fpOf(hp);
  check('староста: строка «Сквозное шифрование, ключ XXXX XXXX» и кнопка «Сверить»', !!fpH && /Сквозное шифрование, ключ/.test(await hp.locator('.ch-enc').innerText()), String(fpH));
  await hp.getByRole('tab', { name: 'ПЗ' }).click();
  await hp.getByText('ещё не включил шифрование').first().waitFor({ timeout: 20000 });
  check('вкладка «ПЗ»: у преподавателя ПЗ нет ключей, поле ввода отключено с понятной подписью', await hp.locator('#chIn').isDisabled() && await hp.locator('#chSend').isDisabled());
  await hp.getByRole('tab', { name: /Лекции/ }).click();
  await hp.locator('.ch-ver').waitFor({ timeout: 20000 });
  await hp.locator('.ch-ver').click();
  await hp.locator('.cab-sheet').waitFor();
  check('«Сверить»: отпечаток крупно и подсказка сравнить вне журнала', (await hp.locator('.cab-sheet .j2-code').innerText()).trim() === fpH && /Сравните этот отпечаток с собеседником вне журнала, например по телефону/.test(await hp.locator('.cab-sheet').innerText()));
  await noHScroll(hp, 'лист «Сверить»'); await taps(hp, 'лист «Сверить»'); await hp.screenshot({ path: join(shots, 'c2-verify.png') });
  await hp.getByRole('button', { name: 'Готово' }).click();
  await hp.locator('.cab-sheet').waitFor({ state: 'detached' });

  // ---------- 4. староста пишет ----------
  await hp.fill('#chIn', 'я'.repeat(1850));
  check('счётчик длины появляется у предела: «1850 из 2000»', (await hp.locator('#chCnt').innerText()).trim() === '1850 из 2000');
  await hp.fill('#chIn', '');
  check('счётчик пропадает при коротком тексте', (await hp.locator('#chCnt').innerText()).trim() === '');
  await hp.fill('#chIn', M1);
  await sendBtn(hp).click();
  await bubble(hp, SECRET).waitFor({ timeout: 30000 });
  check('своё сообщение справа лаймом, внутри нет разметки (текст экранирован)', await hp.locator('.ch-m.me .ch-b', { hasText: SECRET }).count() === 1 && (await bubble(hp, SECRET).innerText()).includes('<i>') && await bubble(hp, SECRET).locator('i').count() === 0);
  check('поле ввода очищено после отправки', (await hp.inputValue('#chIn')) === '');
  const hint = await hp.locator('.ch-m.me .ch-t').first().innerText();
  check('подпись своего сообщения: «Вы, ЧЧ:ММ»', /^Вы, \d{2}:\d{2}$/.test(hint.trim()), hint);
  await noHScroll(hp, 'чат старосты'); await taps(hp, 'чат старосты'); await hp.screenshot({ path: join(shots, 'c3-headman-chat.png') });
  const th = (await get(`chat_threads?student_user_id=eq.${hu}&teacher_user_id=eq.${tu}&select=id,kind,group_id`))[0];
  check('тред староста ↔ преподаватель лекций создан при первом открытии вкладки', th && th.kind === 'lecture' && th.group_id === G, JSON.stringify(th));
  await hp.evaluate(() => { location.hash = '#/summary'; });        // экран чата остановил опрос
  await hp.getByRole('heading', { name: 'Кабинет старосты' }).waitFor({ timeout: 30000 });

  // ---------- 5. преподаватель видит сообщение расшифрованным ----------
  check('у преподавателя 1 непрочитанное (счётчик из chat_threads_my)', await unreadOf(ts) === 1, String(await unreadOf(ts)));
  await tp.goto(`${BASE}/teacher.html#/chat`);                // ключ уже в IndexedDB: сразу «ready», тред со старостой есть
  await bubble(tp, SECRET).waitFor({ timeout: 45000 });
  check('преподаватель видит сообщение старосты расшифрованным слева', await tp.locator('.ch-m.pe .ch-b', { hasText: SECRET }).count() === 1 && (await bubble(tp, SECRET).innerText()).includes(`<i>${SECRET}</i>`));
  check('вкладка преподавателя подписана группой', await tp.getByRole('tab', { name: /24ДММ-2/ }).count() >= 1);
  const unr = await pollDb(async () => (await unreadOf(ts)) === 0);
  check('счётчик непрочитанных у преподавателя сбросился после показа', !!unr, String(await unreadOf(ts)));
  const fpT = await fpOf(tp);
  check('отпечатки у старосты и преподавателя совпадают', !!fpT && fpT === fpH, `${fpH} / ${fpT}`);
  await noHScroll(tp, 'чат преподавателя'); await taps(tp, 'чат преподавателя'); await tp.screenshot({ path: join(shots, 'c4-teacher-chat.png') });

  // быстрые сообщения: вставляют заготовку, не отправляют
  const before = (await get(`chat_messages?thread_id=eq.${th.id}&select=id`)).length;
  await tp.getByRole('button', { name: 'Перенос пары' }).click();
  check('«Перенос пары» вставляет заготовку в поле', /^Перенос пары/.test(await tp.inputValue('#chIn')));
  await tp.getByRole('button', { name: 'Другая аудитория' }).waitFor(); await tp.getByRole('button', { name: 'Новое задание' }).waitFor();
  await new Promise((r) => setTimeout(r, 800));
  check('быстрое сообщение не отправляется само', (await get(`chat_messages?thread_id=eq.${th.id}&select=id`)).length === before);
  await tp.fill('#chIn', '');

  // Shift+Enter: перенос строки, Enter: отправка
  await tp.fill('#chIn', M2a);
  await tp.press('#chIn', 'Shift+Enter');
  await tp.type('#chIn', M2b);
  check('Shift+Enter переносит строку и не отправляет', (await tp.inputValue('#chIn')).includes('\n') && await tp.locator('.ch-m.me .ch-b').count() === 0);
  await tp.press('#chIn', 'Enter');
  await tp.locator('.ch-m.me .ch-b', { hasText: M2b }).waitFor({ timeout: 30000 });
  check('Enter отправляет, перенос строки сохранён в сообщении', (await tp.locator('.ch-m.me .ch-b', { hasText: M2b }).innerText()).includes('\n'));

  // обрыв связи: понятная ошибка, текст остаётся в поле, повтор проходит
  await T.ctx.setOffline(true);
  await tp.fill('#chIn', M3);
  await sendBtn(tp).click();
  await tp.locator('#chErr', { hasText: 'Нет связи' }).waitFor({ timeout: 20000 });
  check('нет связи: человеческая ошибка, текст остался в поле', (await tp.inputValue('#chIn')) === M3 && await tp.locator('.ch-m.me .ch-b', { hasText: 'сбоя связи' }).count() === 0);
  await T.ctx.setOffline(false);
  await sendBtn(tp).click();
  await tp.locator('.ch-m.me .ch-b', { hasText: 'сбоя связи' }).waitFor({ timeout: 30000 });
  check('после возвращения связи повторная отправка проходит', true);

  // ---------- 6. староста: счётчик на сводке и чтение ----------
  await hp.evaluate(() => { location.hash = '#/journal'; });
  await hp.locator('#cabMain').getByText('Отметьте отсутствующих').first().waitFor({ timeout: 30000 });
  await hp.evaluate(() => { location.hash = '#/summary'; });
  await hp.getByRole('heading', { name: 'Кабинет старосты' }).waitFor({ timeout: 30000 });
  const row = hp.locator('a[href="#/chat"].cab-row');
  await row.locator('.ch-new').waitFor({ timeout: 20000 });
  check('сводка: строка чата «Зашифрован» и «2 новых»', /Зашифрован/.test(await row.innerText()) && (await row.locator('.ch-new').innerText()).trim() === '2 новых', (await row.innerText()).replace(/\s+/g, ' '));
  await noHScroll(hp, 'сводка старосты'); await taps(hp, 'сводка старосты'); await hp.screenshot({ path: join(shots, 'c5-summary.png') });
  await row.click();
  await bubble(hp, M2b).waitFor({ timeout: 30000 });
  check('староста читает ответы расшифрованными, своё справа, чужое слева', await hp.locator('.ch-m.pe .ch-b', { hasText: M2a }).count() === 1 && await hp.locator('.ch-m.pe .ch-b', { hasText: 'сбоя связи' }).count() === 1 && await hp.locator('.ch-m.me .ch-b', { hasText: SECRET }).count() === 1);
  check('у старосты счётчик непрочитанных сбросился', !!(await pollDb(async () => (await unreadOf(hs)) === 0)), String(await unreadOf(hs)));
  await hp.evaluate(() => { location.hash = '#/journal'; });
  await hp.locator('#cabMain').getByText('Отметьте отсутствующих').first().waitFor({ timeout: 30000 });
  await hp.evaluate(() => { location.hash = '#/summary'; });
  await hp.getByRole('heading', { name: 'Кабинет старосты' }).waitFor({ timeout: 30000 });
  await hp.locator('a[href="#/chat"].cab-row').waitFor();
  check('сводка после чтения: «Зашифрован» без «новых»', await hp.locator('a[href="#/chat"].cab-row .ch-new').count() === 0 && /Зашифрован/.test(await hp.locator('a[href="#/chat"].cab-row').innerText()));

  // ---------- 7. опрос: новое сообщение появляется без перезагрузки ----------
  await hp.locator('a[href="#/chat"].cab-row').click();
  await bubble(hp, M2b).waitFor({ timeout: 30000 });
  await hp.fill('#chIn', M4);
  await hp.press('#chIn', 'Enter');
  await bubble(hp, M4).waitFor({ timeout: 30000 });
  await bubble(tp, M4).waitFor({ timeout: 20000 });
  check('опрос раз в 4 с: преподаватель получил сообщение без перезагрузки страницы', await tp.locator('.ch-m.pe .ch-b', { hasText: M4 }).count() === 1);

  // ---------- 8. база: только шифртекст, уведомления без текста ----------
  const msgs = await get(`chat_messages?thread_id=eq.${th.id}&select=*&order=created_at`);
  const texts = [M1, M2a + '\n' + M2b, M3, M4];
  check('в базе 4 сообщения (быстрый ответ не отправлялся)', msgs.length === 4, String(msgs.length));
  const b64u = /^[A-Za-z0-9_-]+$/;
  check('chat_messages: столбцов с открытым текстом нет', msgs.every((m) => Object.keys(m).every((k) => ['id', 'thread_id', 'sender_id', 'sender_key_version', 'recipient_key_version', 'iv', 'ciphertext', 'created_at'].includes(k))), Object.keys(msgs[0] ?? {}).join(','));
  check('iv и шифртекст: base64url, шифртекст длиннее текста', msgs.every((m, i) => b64u.test(m.iv) && b64u.test(m.ciphertext) && m.ciphertext.length > (texts[i] ?? '').length), msgs.map((m) => `${m.iv.length}/${m.ciphertext.length}`).join(' '));
  const dump = JSON.stringify(msgs);
  check('открытый текст не встречается ни в iv, ни в шифртексте, ни в строке целиком', ![SECRET, 'Лекция в ауд', 'Принято', M2b, 'сбоя связи', 'опрос'].some((s) => dump.includes(s)));
  check('отправители и версии ключей: староста, преподаватель, версии 1/1', msgs[0]?.sender_id === hu && msgs[1]?.sender_id === tu && msgs.every((m) => m.sender_key_version === 1 && m.recipient_key_version === 1), JSON.stringify(msgs.map((m) => [m.sender_id.slice(0, 4), m.sender_key_version, m.recipient_key_version])));
  const nt = await get(`notifications?kind=eq.chat&user_id=eq.${tu}&select=title,body,kind,user_id`);
  const nh = await get(`notifications?kind=eq.chat&user_id=eq.${hu}&select=title,body,kind,user_id`);
  check('уведомление «chat» у преподавателя: фиксированный заголовок, в теле нет текста сообщений', nt.length >= 1 && nt.every((n) => n.title === 'Новое сообщение в чате' && !JSON.stringify(n).includes(SECRET)), JSON.stringify(nt).slice(0, 200));
  check('уведомление «chat» у старосты: фиксированный заголовок, в теле нет текста сообщений', nh.length >= 1 && nh.every((n) => n.title === 'Новое сообщение в чате' && !JSON.stringify(n).includes(SECRET) && !JSON.stringify(n).includes(M2b)), JSON.stringify(nh).slice(0, 200));
  // не чаще одного на тред и получателя в 5 минут: уведомлений ровно столько, сколько пятиминутных окон у сообщений
  const win = (from) => new Set(msgs.filter((m) => m.sender_id === from).map((m) => Math.floor(Date.parse(m.created_at) / 300000))).size;
  check('уведомления не чаще одного на тред в 5 минут', nt.length === win(hu) && nh.length === win(tu), `${nt.length}/${win(hu)} ${nh.length}/${win(tu)}`);

  // ---------- 9. утечки: хранилище, адрес, консоль ----------
  for (const [nm, pg] of [['староста', hp], ['преподаватель', tp]]) {
    const st = await pg.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    check(`${nm}: открытого текста и паролей нет ни в localStorage, ни в sessionStorage, ни в адресе`, !ALL_TEXTS.some((s) => st.includes(s) || pg.url().includes(encodeURIComponent(s)) || pg.url().includes(s)));
  }
  check('в консоли нет ни текстов сообщений, ни паролей', !ALL_TEXTS.some((s) => LOGS.join('\n').includes(s)));

  // ---------- 10. новое устройство: пустой IndexedDB, пароль переписки ----------
  const H2 = await open(browser, hs, 'headman.html', '#/chat'); ctxs.push(H2.ctx);
  const h2 = H2.page;
  await h2.getByText('Введите пароль переписки').first().waitFor({ timeout: 30000 });
  check('новое устройство: «Введите пароль переписки», создания ключей нет', await h2.getByRole('button', { name: 'Создать ключи' }).count() === 0 && await h2.getByRole('button', { name: 'Забыл пароль' }).count() === 1);
  await noHScroll(h2, 'ввод пароля'); await taps(h2, 'ввод пароля'); await h2.screenshot({ path: join(shots, 'c6-locked.png') });
  await h2.fill('#chPw', 'совсем-не-тот-пароль');
  await h2.getByRole('button', { name: 'Открыть чат' }).click();
  await h2.locator('#chMsg', { hasText: 'Неверный пароль' }).waitFor({ timeout: 30000 });
  check('неверный пароль: «Неверный пароль переписки», чат не открылся', await h2.locator('.ch-list').count() === 0);
  await h2.fill('#chPw', PW1);
  await h2.getByRole('button', { name: 'Открыть чат' }).click();
  await bubble(h2, SECRET).waitFor({ timeout: 40000 });
  check('верный пароль: старые сообщения на новом устройстве читаются, все 4', await h2.locator('.ch-b:not(.bad)').count() === 4 && await h2.locator('.ch-b.bad').count() === 0, `${await h2.locator('.ch-b:not(.bad)').count()} / ${await h2.locator('.ch-b.bad').count()}`);
  check('отпечаток на новом устройстве тот же', (await fpOf(h2)) === fpH);

  // ---------- 11. сброс ключей ----------
  const H3 = await open(browser, hs, 'headman.html', '#/chat'); ctxs.push(H3.ctx);
  const h3 = H3.page;
  await h3.getByRole('button', { name: 'Забыл пароль' }).waitFor({ timeout: 30000 });
  await h3.getByRole('button', { name: 'Забыл пароль' }).click();
  await h3.getByText('Старая переписка пропадёт').first().waitFor();
  check('«Забыл пароль»: явное предупреждение, что старая переписка пропадёт', /Прежние сообщения станут нечитаемыми/.test(await body(h3)));
  await noHScroll(h3, 'сброс ключей'); await taps(h3, 'сброс ключей'); await h3.screenshot({ path: join(shots, 'c7-reset.png') });
  await h3.fill('#chPw', PW2); await h3.fill('#chPw2', PW2);
  await h3.getByRole('button', { name: 'Сбросить и создать новые ключи' }).click();
  await h3.getByRole('tab', { name: 'Лекции' }).waitFor({ timeout: 40000 });
  await h3.locator('.ch-b.bad').first().waitFor({ timeout: 30000 });
  check('после сброса у старосты все 4 старых сообщения: «Сообщение недоступно: ключ был заменён»', await h3.locator('.ch-b.bad').count() === 4 && /Сообщение недоступно: ключ был заменён/.test(await h3.locator('.ch-b.bad').first().innerText()) && await h3.locator('.ch-b:not(.bad)').count() === 0);
  check('версия ключа старосты выросла до 2', (await get(`chat_keys?user_id=eq.${hu}&select=key_version`))[0]?.key_version === 2);
  await h3.screenshot({ path: join(shots, 'c8-after-reset.png') });

  // преподаватель после перезагрузки: ключ собеседника новый, старое нечитаемо, новое читается
  await tp.reload();
  await tp.locator('.ch-b.bad').first().waitFor({ timeout: 40000 });
  check('у преподавателя после сброса старосты старые сообщения тоже недоступны', await tp.locator('.ch-b.bad').count() === 4 && await tp.locator('.ch-b:not(.bad)').count() === 0, `${await tp.locator('.ch-b.bad').count()}`);
  const fpT2 = await fpOf(tp), fpH3 = await fpOf(h3);
  check('отпечаток сменился и снова одинаков у обоих', !!fpT2 && fpT2 === fpH3 && fpT2 !== fpH, `${fpH} → ${fpT2} / ${fpH3}`);
  await h3.fill('#chIn', M5); await h3.press('#chIn', 'Enter');
  await bubble(h3, M5).waitFor({ timeout: 30000 });
  await bubble(tp, M5).waitFor({ timeout: 20000 });
  check('после сброса новые сообщения доходят и читаются', await tp.locator('.ch-m.pe .ch-b:not(.bad)', { hasText: M5 }).count() === 1);
  await tp.fill('#chIn', M6); await tp.press('#chIn', 'Enter');
  await bubble(h3, M6).waitFor({ timeout: 30000 });
  check('ответ преподавателя после сброса читается старостой', await h3.locator('.ch-m.pe .ch-b:not(.bad)', { hasText: M6 }).count() === 1);
  const after = await get(`chat_messages?thread_id=eq.${th.id}&select=sender_id,sender_key_version,recipient_key_version,ciphertext&order=created_at`);
  check('новые строки в базе: староста 2/1, преподаватель 1/2, текста нет', after.length === 6 && after[4].sender_key_version === 2 && after[4].recipient_key_version === 1 && after[5].sender_key_version === 1 && after[5].recipient_key_version === 2 && !JSON.stringify(after).includes(SECRET), JSON.stringify(after.map((m) => [m.sender_key_version, m.recipient_key_version])));

  // ---------- 12. ошибки JS ----------
  check('староста: ошибок JS нет', H.errs.length === 0 && H2.errs.length === 0 && H3.errs.length === 0, [...H.errs, ...H2.errs, ...H3.errs].join(' | ').slice(0, 300));
  check('преподаватель: ошибок JS нет', T.errs.length === 0, T.errs.join(' | ').slice(0, 300));
  check('в консоли после всех шагов нет текстов сообщений и паролей', !ALL_TEXTS.concat([M5, M6, M4]).some((s) => LOGS.join('\n').includes(s)));
} catch (e) {
  check('сценарий дошёл до конца без исключений', false, String(e).slice(0, 300));
  console.log('--- консоль страницы:\n' + LOGS.slice(-15).join('\n'));
  try { await LASTPAGE.screenshot({ path: join(shots, 'c-fail.png') }); console.log('url:', LASTPAGE.url()); } catch (_) { /* страницы уже нет */ }
} finally {
  try { for (const c of ctxs) await c.close().catch(() => {}); await wipe(); } catch (e) { console.log('Чистка не завершена:', String(e).slice(0, 200)); }
  await browser.close(); server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИтого: ${results.length - failed.length} из ${results.length}${failed.length ? `, провалов ${failed.length}` : ''}. Скриншоты: ${shots}`);
process.exit(failed.length ? 1 : 0);
