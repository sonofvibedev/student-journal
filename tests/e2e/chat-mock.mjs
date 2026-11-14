// Чат 2.1 п.12 (без пароля переписки) в настоящем браузере БЕЗ сети: староста (headman.html) и преподаватель (teacher.html)
// в разных контекстах Playwright, Supabase подменён заглушкой; RPC чата — tests/e2e/chat-fake.mjs (правила миграции 20261122100000),
// шифрование — настоящий chat-crypto.js в браузере. Ни тест, ни прод не затрагиваются.
// Запуск: node tests/e2e/chat-mock.mjs  (нужен Chromium: CHROME_PATH или tools/test/chrome.mjs). Снимки — SHOTS_DIR или %TEMP%/chat-shots.
import { readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { findChrome } from '../../tools/test/chrome.mjs';
import { makeChatServer } from './chat-fake.mjs';

const SB = 'https://mock.supabase.co', KEY = 'sb-mock-auth-token', G = '00000000-0000-4000-8000-000000000024';
const HM = '00000000-0000-4000-8000-0000000000a1', TL = '00000000-0000-4000-8000-0000000000b1', TH = '00000000-0000-4000-8000-0000000000c1';
const NOW = Date.UTC(2026, 10, 9, 8, 40);
const OUT = resolve(process.env.SHOTS_DIR || join(process.env.TEMP ?? '.', 'chat-shots'));
mkdirSync(OUT, { recursive: true });

const ENV_JS = readFileSync('env.js', 'utf8').replace(/const SUPABASE_URL = '[^']*'/, `const SUPABASE_URL = '${SB}'`)
  .replace(/const SB_STORAGE_KEY = '[^']*'/, `const SB_STORAGE_KEY = '${KEY}'`).replace("const LS_PREFIX = ''", "const LS_PREFIX = 'm_'");
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const web = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let b; try { b = readFileSync(resolve(join('.', p === '/' ? 'index.html' : p))); } catch (_) { res.writeHead(404).end(); return; }
  if (p.endsWith('/env.js')) b = Buffer.from(ENV_JS);
  else if (p.endsWith('/cab-core.js')) b = Buffer.from(b.toString('utf8').replace('Cab.testNow = null;', `Cab.testNow = ${NOW};`));
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(b);
}).listen(0);
const BASE = `http://127.0.0.1:${web.address().port}`;

// ---------- заглушка базы ----------
const chat = makeChatServer({ eligible: [HM, TL], threads: [{ id: TH, group_id: G, student_user_id: HM, teacher_user_id: TL, kind: 'lecture' }] });
const DB = {
  memberships: [{ user_id: HM, group_id: G, student_id: 's-hm', base_role: 'student', extra_role: 'headman', status: 'active', consent_at: '2026-11-01T00:00:00Z' },
    { user_id: TL, group_id: G, student_id: null, base_role: 'teacher_lecture', extra_role: null, status: 'active', consent_at: '2026-11-01T00:00:00Z' }],
  groups: [{ id: G, name: '24ДММ-2', status: 'active', warn_hours: 8, dean_hours: 12 }],
  students: [{ id: 's-hm', group_id: G, last_name: 'Старостин', first_name: 'Сергей', subgroup: 1, claim_status: 'active', study_form: 'budget' }],
  teacher_assignments: [{ user_id: TL, group_id: G, subject: 'Эконометрика', lesson_kind: 'lecture' }],
  sysadmins: [], schedule_lessons: [], tasks: [], absences: [], certificates: [], notifications: [], homework_editors: [],
  schedule_meta: [{ last_import_at: '2026-11-08T10:00:00Z', semester_start: '2026-08-31', semester_end: '2026-12-18' }],
};
const J = (status, body, extra = {}) => ({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*', ...extra }, body: JSON.stringify(body) });
const who = (req) => { try { return JSON.parse(Buffer.from((req.headers().authorization || '').split('.')[1], 'base64url').toString()).sub; } catch (_) { return null; } };
async function fake(route) {
  const req = route.request(), u = new URL(req.url()), m = req.method(), path = u.pathname, uid = who(req);
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (path.startsWith('/auth/v1')) return route.fulfill(J(200, { id: uid, email: uid + '@j.example', aud: 'authenticated', app_metadata: {}, user_metadata: {} }));
  if (path.startsWith('/storage/') ) return route.fulfill(J(404, { message: 'not found' }));
  if (path.startsWith('/functions/')) return route.fulfill(J(200, {}));
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(path);
  if (rpc) {
    let body = {}; try { body = req.postDataJSON() || {}; } catch (_) { /* без тела */ }
    if (/^chat_/.test(rpc[1])) { const r = chat.call(uid, rpc[1], body); return route.fulfill(r.error ? J(400, { message: r.error.message, code: 'P0001' }) : J(200, r.data)); }
    return route.fulfill(J(200, rpc[1] === 'is_sysadmin' ? false : null));
  }
  const t = /^\/rest\/v1\/(.+)$/.exec(path); if (!t) return route.fulfill(J(404, {}));
  if (t[1] === 'chat_messages') {
    let rows = chat.messages(uid, (u.searchParams.get('thread_id') || '').slice(3));
    const gt = u.searchParams.get('created_at'); if (gt && gt.startsWith('gt.')) rows = rows.filter((x) => x.created_at > gt.slice(3));
    rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1)); if (/desc/.test(u.searchParams.get('order') || '')) rows.reverse();
    return route.fulfill(J(200, rows.slice(0, Number(u.searchParams.get('limit')) || 200)));
  }
  if (m !== 'GET' && m !== 'HEAD') return route.fulfill(J(201, []));
  let rows = DB[t[1]] || [];
  for (const [k, v] of u.searchParams) if (/^eq./.test(v) && rows.length && k in rows[0]) rows = rows.filter((r) => String(r[k]) === v.slice(3));
  const one = /pgrst\.object/.test(req.headers().accept || '');
  if (m === 'HEAD' || /count=exact/.test(req.headers().prefer || '')) return route.fulfill(J(200, m === 'HEAD' ? '' : rows, { 'content-range': `0-0/${rows.length}` }));
  return route.fulfill(one ? (rows.length ? J(200, rows[0]) : J(406, { code: 'PGRST116', message: 'no rows' })) : J(200, rows));
}

const results = []; let n = 0;
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const browser = await chromium.launch({ executablePath: findChrome() });
const ses = (uid) => JSON.stringify({ access_token: 'x.' + Buffer.from(JSON.stringify({ sub: uid, exp: 4102444800, role: 'authenticated' })).toString('base64url') + '.y', refresh_token: 'r', token_type: 'bearer', expires_in: 99999999, expires_at: 4102444800,
  user: { id: uid, email: uid + '@j.example', aud: 'authenticated', app_metadata: {}, user_metadata: {} } });
const ERR_OK = /Failed to load resource|status of 4|ERR_|Service Worker|sw\.js|favicon/i;
async function open(uid, file, theme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, locale: 'ru-RU', colorScheme: 'dark', serviceWorkers: 'block' });
  await ctx.route(`${SB}/**`, fake);
  await ctx.addInitScript(([k, v, th]) => { try { localStorage.setItem(k, v); localStorage.setItem('m_j2_theme', th); } catch (e) { /* нет памяти */ } }, [KEY, ses(uid), theme]);
  const page = await ctx.newPage(), errs = [];
  page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (msg) => { if (msg.type() === 'error' && !ERR_OK.test(msg.text()) && !/\[chat\]/.test(msg.text())) errs.push(msg.text()); });
  await page.goto(`${BASE}/${file}#/chat`);
  await page.waitForSelector('#chEnc .ch-fp', { timeout: 20000 });
  return { ctx, page, errs };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${++n}-${name}.png`), fullPage: true });
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const txt = (page, sel) => page.locator(sel).first().innerText().then((s) => s.replace(/\s+/g, ' '));
const waitText = (page, sel, re, timeout = 20000) => page.waitForFunction(([s, r]) => new RegExp(r).test((document.querySelector(s) || {}).innerText || ''), [sel, re.source], { timeout });
const fpOf = async (page) => (/ключ ([0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4})/.exec(await txt(page, '#chEnc')) || [])[1];
async function sendText(page, text) {
  await page.locator('#chIn').fill(text);
  await page.locator('#chSend').click();
  await page.waitForFunction((t) => [...document.querySelectorAll('.ch-m.me .ch-b')].some((b) => b.innerText === t), text, { timeout: 15000 });
}

try {
  // ---------- староста открывает первым: пароля нет, ключ создаётся сам, собеседник ещё не открывал ----------
  const hm = await open(HM, 'headman.html');
  await waitText(hm.page, '#chList', /Собеседник ещё не открывал чат/);
  check('староста: экрана пароля нет (ни поля пароля, ни «Создать ключи»)', await hm.page.locator('input[type="password"]').count() === 0 && !/пароль/i.test(await txt(hm.page, '#cabMain')));
  check('староста: устройство зарегистрировано само, только открытый ключ', chat.S.devices.filter((d) => d.user_id === HM).length === 1 && !('d' in chat.S.devices[0].public_jwk));
  check('староста: поле ввода выключено с подсказкой «Собеседник ещё не открывал чат»', await hm.page.locator('#chIn').isDisabled() && (await hm.page.locator('#chIn').getAttribute('placeholder')) === 'Собеседник ещё не открывал чат');
  await shot(hm.page, 'headman-no-peer');

  // ---------- преподаватель открывает: эпоха создаётся автоматически, пишет ----------
  const tl = await open(TL, 'teacher.html', 'light');
  await tl.page.waitForFunction(() => !document.querySelector('#chIn').disabled, null, { timeout: 20000 });
  check('преподаватель: чат открыт сразу, ключ треда создан (эпоха 1)', chat.S.threads[0].key_epoch === 1 && chat.S.keys.length === 2);
  await sendText(tl.page, 'Перенос пары на 10:00');
  await waitText(hm.page, '#chList', /Перенос пары на 10:00/);
  check('староста: сообщение преподавателя расшифровано (опрос сам подхватил ключ)', true);
  await sendText(hm.page, 'Принято, передам группе');
  await waitText(tl.page, '#chList', /Принято, передам группе/);
  check('преподаватель: ответ старосты расшифрован', true);
  const f1 = await fpOf(hm.page), f2 = await fpOf(tl.page);
  check('отпечаток «XXXX XXXX XXXX XXXX» одинаковый у обоих', !!f1 && f1 === f2, `${f1} / ${f2}`);
  const dump = JSON.stringify(chat.S);
  check('в «базе» нет открытого текста', !/Перенос|Принято/.test(dump));
  check('кнопки отправки и «Сверить» не меньше 44 px', (await hm.page.locator('#chSend').boundingBox()).height >= 44 && (await hm.page.locator('#chVer').boundingBox()).height >= 44);
  check('360 px: без горизонтальной прокрутки (тёмная и светлая тема)', await noOverflow(hm.page) && await noOverflow(tl.page));
  await shot(hm.page, 'headman-ready'); await shot(tl.page, 'teacher-ready-light');
  await hm.page.locator('#chVer').click();
  await hm.page.waitForSelector('#chShReset');
  check('«Сверить»: крупный отпечаток, число устройств, «Начать заново»', /у вас 1 устройство, у собеседника 1 устройство/.test(await txt(hm.page, '.cab-sheet')) && await noOverflow(hm.page));
  await shot(hm.page, 'verify-sheet');
  await hm.page.locator('#chShDone').click();

  // ---------- новое устройство старосты: ждёт, прежнее подтверждает ----------
  const hm2 = await open(HM, 'headman.html');
  await waitText(hm2.page, '#chNote', /Ждём подтверждения этого устройства/);
  check('новое устройство: «Ждём подтверждения», поле ввода выключено, история закрыта', await hm2.page.locator('#chIn').isDisabled() && /откроется, когда устройство подтвердят/.test(await txt(hm2.page, '#chList')));
  check('новое устройство 360 px: без горизонтальной прокрутки; кнопка ≥ 44 px', await noOverflow(hm2.page) && (await hm2.page.locator('#chNoteReset').boundingBox()).height >= 44);
  await shot(hm2.page, 'new-device-waiting');
  await hm.page.reload(); await hm.page.waitForSelector('#chEnc .ch-fp');                       // прежнее устройство открыло чат
  await waitText(hm2.page, '#chList', /Перенос пары на 10:00/);
  check('новое устройство: подтверждено прежним без пароля, история читается', !(await hm2.page.locator('#chIn').isDisabled()) && await hm2.page.locator('#chNote .ch-note').count() === 0);
  await tl.page.reload(); await tl.page.waitForSelector('#chEnc .ch-fp');
  await waitText(tl.page, '#chNote', /У собеседника новое устройство/);
  check('преподаватель: «У собеседника новое устройство» и новый отпечаток', (await fpOf(tl.page)) !== f1 && /Новый отпечаток/.test(await txt(tl.page, '#chNote')));
  await shot(tl.page, 'teacher-peer-new-device-light');
  await tl.page.locator('#chNoteOk').click();
  check('«Понятно» убирает предупреждение', await tl.page.locator('#chNote .ch-note').count() === 0);

  // ---------- потеря всех устройств: «начать заново» ----------
  const hm3 = await open(HM, 'headman.html');
  await waitText(hm3.page, '#chNote', /Ждём подтверждения/);
  await hm3.page.locator('#chNoteReset').click();
  await hm3.page.locator('#chShGo').click();
  await hm3.page.waitForFunction(() => !document.querySelector('#chIn').disabled, null, { timeout: 20000 });
  check('«начать заново»: эпоха 2, прежние устройства отозваны, писать можно', chat.S.threads[0].key_epoch === 2 && chat.S.devices.filter((d) => d.user_id === HM && !d.revoked_at).length === 1);
  check('«начать заново»: старая переписка на этом устройстве недоступна', /недоступно на этом устройстве/.test(await txt(hm3.page, '#chList')));
  await sendText(hm3.page, 'Пишу с нового телефона');
  await tl.page.reload(); await tl.page.waitForSelector('#chEnc .ch-fp');
  await waitText(tl.page, '#chNote', /Ключ собеседника заменён/);
  await waitText(tl.page, '#chList', /Пишу с нового телефона/);
  check('преподаватель: «Ключ собеседника заменён», старые и новые сообщения читаются', /Перенос пары на 10:00/.test(await txt(tl.page, '#chList')));
  await shot(tl.page, 'teacher-peer-key-replaced-light');
  await hm.page.reload();
  await hm.page.waitForSelector('#chEnc .ch-fp', { timeout: 20000 });
  await waitText(hm.page, '#chNote', /Ждём подтверждения/);
  check('отозванное устройство само заводит новый ключ и ждёт подтверждения (без ошибки)', chat.S.devices.filter((d) => d.user_id === HM).length >= 4);

  for (const [name, x] of [['староста', hm], ['преподаватель', tl], ['новое устройство', hm2], ['третье устройство', hm3]]) check(`${name}: ошибок страницы нет`, !x.errs.length, x.errs.join(' | '));
} catch (e) { console.error(e); results.push(false); }
await browser.close(); web.close();
const bad = results.filter((x) => !x).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}. Снимки: ${OUT}`);
process.exit(bad ? 1 : 0);
