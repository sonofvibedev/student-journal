// Проверка клиентской части Telegram-бота в браузере: привязка в профиле, «Заявки», права
// редакторов, УСР в форме и слияние при сохранении data.json. Все запросы к Supabase и GitHub
// перехватываются (page.route): ни токены, ни пароли, ни реальные вызовы не используются.
//
// Запуск: node tools/shots-bot-client.mjs   (снимки: shots/bot-client-*.png)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'shots');
const EXE = process.env.CHROME_PATH ||
  'C:/Users/dimpo/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff'
};
const SB_URL = 'https://woiqekpuoddxixlrbvkp.supabase.co';
const SB_KEY = 'sb-woiqekpuoddxixlrbvkp-auth-token';
const UID = '11111111-1111-1111-1111-111111111111';

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = join(ROOT, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404).end('not found'); }
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = 'http://127.0.0.1:' + server.address().port;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });

const problems = [];
const say = (ok, text) => { console.log(`  ${ok ? 'ok  ' : 'ПЛОХО'} ${text}`); if (!ok) problems.push(text); };

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 36000 })}.sig`;
const STUDENTS = [
  { id: 'st-1', lastName: 'Иванов', firstName: 'Иван', status: 'Студент' },
  { id: 'st-2', lastName: 'Петрова', firstName: 'Анна', status: 'Студент' },
  { id: 'st-3', lastName: 'Сидоров', firstName: 'Пётр', status: 'Студент' }
];

// Состояние «сервера» для моков
function makeState(over = {}) {
  return {
    canPost: true, linked: false, code: 'ABCD-EFGH', codeError: null,
    pending: [
      { id: '0b0a4f1e-1111-4111-8111-000000000001', author: { student_id: 'st-2', name: 'Петрова Анна' }, kind: 'homework', subtype: 'УСР',
        subject: 'Логистика', due_date: '2026-11-12', text: 'Подготовить доклад по теме 4', status: 'pending', created_at: '2026-11-01T10:00:00+00:00', duplicate: 'record' },
      { id: '0b0a4f1e-2222-4222-8222-000000000002', author: { student_id: 'st-3', name: 'Сидоров Пётр' }, kind: 'deadline', subtype: null,
        subject: 'Маркетинг услуг', due_date: '2026-11-20', text: 'Курсовая: введение', status: 'pending', created_at: '2026-11-01T11:00:00+00:00', duplicate: null }
    ],
    recent: [
      { id: 'r1', author: { student_id: 'st-2', name: 'Петрова Анна' }, kind: 'homework', subtype: 'ПЗ', subject: 'Эконометрика', due_date: '2026-11-05', text: 'Задача 3',
        status: 'rejected', created_at: '2026-10-30T10:00:00+00:00', decided_at: '2026-10-30T11:00:00+00:00', decided_by: 'admin', reject_reason: 'Дубль', record_id: null }
    ],
    editors: [{ student_id: 'st-2', login: 'petrova', linked: true }],
    approveResult: { status: 200, body: { ok: true, status: 'approved', record_id: 'hw-1' } },
    calls: [],
    github: { putBody: null, extra: null },
    ...over
  };
}

async function open(role, state) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.DEBUG_CONSOLE) console.log('   [console.' + m.type() + ']', m.text().slice(0, 200)); });
  page.errors = errors;

  await page.addInitScript(({ role, SB_KEY, UID, FAKE_JWT }) => {
    try {
      localStorage.setItem('whats_new_seen', '99.0.0');
      localStorage.setItem('notify_prompt_seen', '99.0.0');
      if (role !== 'guest') {
        const exp = Math.floor(Date.now() / 1000) + 36000;
        localStorage.setItem(SB_KEY, JSON.stringify({
          access_token: FAKE_JWT, refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 36000, expires_at: exp,
          user: { id: UID, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }
        }));
      }
      if (role === 'admin') localStorage.setItem('admin_mode', '1');
    } catch (e) {}
  }, { role, SB_KEY, UID, FAKE_JWT });

  // Supabase: профиль, закрытая часть журнала, привязка, RPC и функции — всё мок
  await page.route(`${SB_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const send = (status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const p = url.pathname;
    const asObject = (req.headers()['accept'] || '').includes('pgrst.object');
    const one = (row) => (asObject ? (row ? send(200, row) : send(406, { code: 'PGRST116' })) : send(200, row ? [row] : []));
    if (p === '/rest/v1/profiles') {
      return url.searchParams.get('select') === 'can_post_tasks'
        ? one({ can_post_tasks: state.canPost })
        : one({ student_id: 'st-1', login: 'ivanov' });
    }
    if (p === '/rest/v1/journal_private') return one({ students: STUDENTS, absences: [] });
    if (p === '/rest/v1/tg_links') return one(state.linked ? { telegram_id: 123, linked_at: '2026-11-01T10:00:00Z' } : null);
    if (p === '/rest/v1/rpc/tg_create_link_code') {
      state.calls.push('rpc:tg_create_link_code');
      return state.codeError ? send(400, { message: state.codeError, code: 'P0001' }) : send(200, state.code);
    }
    if (p === '/rest/v1/rpc/tg_unlink') { state.calls.push('rpc:tg_unlink'); state.linked = false; return send(204); }
    if (p.startsWith('/rest/v1/')) return send(200, []);
    if (p === '/functions/v1/journal-save') { state.calls.push('journal-save'); return send(200, { ok: true }); }
    if (p === '/functions/v1/tg-requests') {
      const body = JSON.parse(req.postData() || '{}');
      state.calls.push('tg-requests:' + JSON.stringify(body));
      if (body.action === 'list') return send(200, { ok: true, pending: state.pending, recent: state.recent });
      const item = state.pending.find((r) => r.id === body.id);
      if (body.action === 'approve') {
        if (state.approveResult.status === 200 && item) { state.pending = state.pending.filter((r) => r !== item); state.recent.unshift({ ...item, status: 'approved', decided_at: new Date().toISOString(), decided_by: 'admin', reject_reason: null, record_id: 'hw-1' }); }
        return send(state.approveResult.status, state.approveResult.body);
      }
      if (body.action === 'reject') {
        if (item) { state.pending = state.pending.filter((r) => r !== item); state.recent.unshift({ ...item, status: 'rejected', decided_at: new Date().toISOString(), decided_by: 'admin', reject_reason: body.reason || null, record_id: null }); }
        return send(200, { ok: true, status: 'rejected' });
      }
      return send(400, { error: 'bad_request' });
    }
    if (p === '/functions/v1/tg-set-task-editor') {
      const body = JSON.parse(req.postData() || '{}');
      state.calls.push('tg-set-task-editor:' + JSON.stringify(body));
      if (body.action === 'list') return send(200, { ok: true, editors: state.editors });
      if (body.studentId === 'st-3') return send(404, { error: 'no_profile' });
      state.editors = state.editors.filter((e) => e.student_id !== body.studentId);
      if (body.value) state.editors.push({ student_id: body.studentId, login: 'x', linked: false });
      return send(200, { ok: true });
    }
    return send(404, { error: 'not_mocked' });
  });

  // GitHub Contents API: GET отдаёт data.json с записью бота, PUT запоминаем
  await page.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const send = (status, body) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === 'GET') {
      const data = JSON.parse(await readFile(join(ROOT, 'data.json'), 'utf8'));
      data.homework = [...(data.homework || []), {
        id: 'hw-bot-777', subject: 'Логистика', type: 'УСР', text: 'Запись бота, пришла за время сессии', dueDate: '2026-12-01', subgroup: 0,
        createdAt: '2026-11-01T12:00:00.000Z', source: 'bot', author: 'st-2', approvedBy: 'admin'
      }];
      if (state.github.extra) data.homework.push(state.github.extra);
      return send(200, { sha: 'abc123', content: Buffer.from(JSON.stringify(data, null, 2), 'utf8').toString('base64') + '\n', encoding: 'base64' });
    }
    if (req.method() === 'PUT') {
      state.github.putBody = JSON.parse(req.postData());
      return send(200, { content: { sha: 'def456' } });
    }
    return send(404, { message: 'not mocked' });
  });

  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  await page.evaluate(() => {
    document.querySelectorAll('.modal.show, .modal-backdrop').forEach((m) => m.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
  });
  return page;
}
const closeAlert = async (page) => { await page.evaluate(() => { const m = document.getElementById('customAlertModal'); (bootstrap.Modal.getInstance(m) || { hide() {} }).hide(); }); await page.waitForTimeout(500); };
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.classList.contains('d-none') && e.getClientRects().length > 0; }, sel);
const shot = (page, name) => page.screenshot({ path: join(OUT, `bot-client-${name}.png`) });
const openSettings = async (page) => {
  await page.evaluate(() => window.goView('profile'));
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.getElementById('pfAccSettings').open = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('tgBotBlock').scrollIntoView({ block: 'center' }));
};
const ignorable = (e) => /Failed to load resource|ERR_|net::|api\.github|favicon/i.test(e);

// ===== 1. Гость =====
{
  console.log('Гость');
  const state = makeState();
  const page = await open('guest', state);
  say(!(await vis(page, '#tgBotBlock')), 'строка «Telegram-бот» гостю не показана');
  say(!state.calls.length, 'гость не вызывал функции бота');
  say(!(await page.evaluate(() => /tgReqBadge/.test(document.getElementById('viewAdmin').className) || !!document.querySelector('#viewAdmin:not(.d-none)'))), 'админ-панель гостю не открыта');
  say(!page.errors.filter((e) => !ignorable(e)).length, 'ошибок в консоли нет: ' + page.errors.filter((e) => !ignorable(e)).join(' | '));
  await page.close();
}

// ===== 2. Вошедший без права =====
{
  console.log('Вошедший без права редактора');
  const state = makeState({ canPost: false });
  const page = await open('signed', state);
  await openSettings(page);
  say(!(await vis(page, '#tgBotBlock')), 'строка скрыта, если can_post_tasks=false');
  await page.close();
}

// ===== 3. Вошедший редактор: привязка =====
{
  console.log('Вошедший редактор');
  const state = makeState();
  const page = await open('signed', state);
  await openSettings(page);
  say(await vis(page, '#tgBotBlock'), 'строка «Telegram-бот» видна редактору');
  say((await page.textContent('#tgBotState')) === 'Не привязан', 'статус «Не привязан»');
  await shot(page, 'profile-row');
  await page.click('#tgBotRow');
  say((await page.getAttribute('#tgBotRow', 'aria-expanded')) === 'true', 'aria-expanded=true после раскрытия');
  const box = await page.evaluate(() => ['tgBotGetBtn', 'tgBotRow'].map((id) => document.getElementById(id).getBoundingClientRect().height));
  say(box.every((h) => h >= 44), 'зоны нажатия не ниже 44px: ' + box.map(Math.round).join(', '));
  await page.click('#tgBotGetBtn');
  await page.waitForTimeout(500);
  say((await page.textContent('#tgBotCode')) === 'ABCD-EFGH', 'код показан крупно: ' + (await page.textContent('#tgBotCode')));
  const timer = await page.textContent('#tgBotTimer');
  say(/Действует ещё 9:5\d|Действует ещё 10:00/.test(timer), 'таймер 10 минут: ' + timer);
  say(/отправьте ему этот код/i.test(await page.textContent('#tgBotCodeBox')), 'инструкция про бота показана');
  await page.evaluate(() => document.getElementById('tgBotCodeBox').scrollIntoView({ block: 'center' }));
  await shot(page, 'profile-code');
  // привязали в боте: через 5 секунд страница замечает и убирает код
  state.linked = true;
  await page.waitForTimeout(7500);
  say((await page.textContent('#tgBotState')) === 'Привязан', 'после привязки в боте статус «Привязан»');
  say(!(await vis(page, '#tgBotCodeBox')), 'код скрыт после привязки');
  say(await vis(page, '#tgBotUnlinkBtn'), 'кнопка «Отвязать» появилась');
  await shot(page, 'profile-linked');
  // отвязка (подтверждение — модалка приложения)
  await page.click('#tgBotUnlinkBtn');
  await page.waitForSelector('#customConfirmModal.show');
  await page.click('#customConfirmOkBtn');
  await page.waitForTimeout(700);
  say(state.calls.includes('rpc:tg_unlink'), 'вызван tg_unlink');
  say((await page.textContent('#tgBotState')) === 'Не привязан', 'после отвязки «Не привязан»');
  // ошибка RPC
  state.codeError = 'not_authenticated';
  await closeAlert(page);
  await page.evaluate(() => getTgCode());
  await page.waitForTimeout(500);
  say(/Сессия закончилась/.test(await page.textContent('#customAlertMessage')), 'not_authenticated: «Сессия закончилась…»');
  state.codeError = 'no_profile';
  await closeAlert(page);
  await page.evaluate(() => getTgCode());
  await page.waitForTimeout(500);
  say(/не привязан к студенту/.test(await page.textContent('#customAlertMessage')), 'no_profile: понятное сообщение');
  say(!page.errors.filter((e) => !ignorable(e)).length, 'ошибок в консоли нет: ' + page.errors.filter((e) => !ignorable(e)).join(' | '));
  await page.close();
}

// ===== 4. Админ: заявки, права, УСР, слияние =====
{
  console.log('Админ');
  const state = makeState({ canPost: false });
  const page = await open('admin', state);
  await page.evaluate(() => window.goView('admin'));
  await page.waitForTimeout(900);
  const badge = (await page.textContent('#tgReqBadge')).trim();
  say(await vis(page, '#tgReqBadge') && /^2/.test(badge), 'бейдж «Заявки» показывает число ожидающих: ' + badge);
  await shot(page, 'admin-panel');

  // Заявки
  await page.evaluate(() => openTgRequests());
  await page.waitForSelector('#tgReqPending .tg-req', { timeout: 5000 });
  const cards = await page.$$eval('#tgReqPending .tg-req', (els) => els.map((e) => e.innerText));
  say(cards.length === 2, 'в списке ожидающих 2 заявки');
  say(/Петрова Анна/.test(cards[0]) && /УСР/.test(cards[0]) && /Логистика/.test(cards[0]) && /Подготовить доклад/.test(cards[0]), 'автор, тип, предмет и текст на карточке');
  say(/Возможный дубль/.test(cards[0]) && !/Возможный дубль/.test(cards[1]), 'пометка дубля только у первой');
  say((await page.textContent('#tgReqRecent')).includes('Причина: Дубль'), 'в «недавно решённых» видна причина отказа');
  const btnH = await page.$$eval('#tgReqPending button, #tgReqPending input', (els) => els.map((e) => e.getBoundingClientRect().height));
  say(btnH.every((h) => h >= 44), 'кнопки и поле причины не ниже 44px');
  await page.waitForTimeout(700);
  await shot(page, 'admin-requests');
  // Одобрить первую
  await page.click('#tgReqPending .tg-req:nth-child(1) [data-act="approve"]');
  await page.waitForTimeout(1200);
  say(state.calls.some((c) => c.includes('"action":"approve"') && c.includes('0b0a4f1e-1111')), 'вызван approve для первой заявки');
  say((await page.textContent('#tgReqStatus')).includes('Одобрено'), 'сообщение «Одобрено…»');
  say((await page.$$('#tgReqPending .tg-req')).length === 1, 'после действия список перезапрошен: осталась 1 заявка');
  say(/^1/.test((await page.textContent('#tgReqBadge')).trim()), 'бейдж обновился до 1');
  // Отклонить с причиной
  await page.fill('#tgReqPending .tg-req input', 'Не нужно');
  await page.click('#tgReqPending .tg-req [data-act="reject"]');
  await page.waitForTimeout(1000);
  say(state.calls.some((c) => c.includes('"action":"reject"') && c.includes('"reason":"Не нужно"')), 'reject ушёл с причиной');
  say((await page.textContent('#tgReqPending')).includes('Новых заявок нет'), 'ожидающих больше нет');
  // Ошибки: 409 и 502
  state.pending.push({ id: '0b0a4f1e-3333-4333-8333-000000000003', author: { student_id: 'st-2', name: 'Петрова Анна' }, kind: 'homework', subtype: 'ПЗ', subject: 'Эконометрика', due_date: '2026-11-09', text: 'x', status: 'pending', created_at: '2026-11-01T12:00:00+00:00', duplicate: null });
  await page.evaluate(() => tgReqLoad(false));
  await page.waitForSelector('#tgReqPending .tg-req');
  state.approveResult = { status: 409, body: { error: 'already_decided', status: 'rejected' } };
  await page.click('#tgReqPending .tg-req [data-act="approve"]');
  await page.waitForTimeout(800);
  say(/Уже решено: заявка уже отклонена/.test(await page.textContent('#tgReqStatus')), '409: «Уже решено…»');
  state.approveResult = { status: 502, body: { error: 'github_failed' } };
  await page.waitForSelector('#tgReqPending .tg-req [data-act="approve"]');
  await page.click('#tgReqPending .tg-req [data-act="approve"]');
  await page.waitForTimeout(800);
  say(/Заявка осталась на проверке/.test(await page.textContent('#tgReqStatus')), '502: понятное сообщение');
  say((await page.$$('#tgReqPending .tg-req')).length === 1, 'после 502 заявка осталась в списке');
  await page.evaluate(() => bootstrap.Modal.getInstance(document.getElementById('tgRequestsModal')).hide());
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove()); document.body.classList.remove('modal-open'); });

  // Права редакторов
  await page.evaluate(() => openTgEditors());
  await page.waitForSelector('#tgEdList .tg-ed-row', { timeout: 5000 });
  const rows = await page.$$eval('#tgEdList .tg-ed-row', (els) => els.map((e) => ({ t: e.innerText.replace(/\n/g, ' | '), on: e.querySelector('input').checked })));
  say(rows.length === 3, 'в списке 3 студента');
  const petrova = rows.find((r) => /Петрова/.test(r.t));
  say(petrova.on && /Telegram привязан/.test(petrova.t), 'у Петровой начальное состояние «может», Telegram привязан');
  say(!rows.find((r) => /Иванов/.test(r.t)).on, 'у Иванова начальное состояние «не может»');
  await page.waitForTimeout(700);
  await shot(page, 'admin-editors');
  const ivanovBox = '#tgEdList .tg-ed-row:nth-child(1) input';
  await page.click(ivanovBox);
  await page.waitForTimeout(700);
  say(state.calls.some((c) => c.includes('"action":"set"') && c.includes('"studentId":"st-1"') && c.includes('"value":true')), 'set value:true для st-1');
  say(/право выдано/.test(await page.textContent('#tgEdStatus')), 'сообщение «право выдано»');
  await page.click('#tgEdList .tg-ed-row:nth-child(3) input');
  await page.waitForTimeout(700);
  say(/ещё нет аккаунта/.test(await page.textContent('#tgEdStatus')), 'no_profile: понятное сообщение');
  say(!(await page.$eval('#tgEdList .tg-ed-row:nth-child(3) input', (e) => e.checked)), 'при ошибке переключатель возвращён');
  await page.evaluate(() => bootstrap.Modal.getInstance(document.getElementById('tgEditorsModal')).hide());
  await page.waitForTimeout(500);
  await page.evaluate(() => { document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove()); document.body.classList.remove('modal-open'); });

  // УСР в форме
  const opts = await page.evaluate(() => { openHomeworkForm(); return [...document.querySelectorAll('#homeworkType option')].map((o) => o.value); });
  say(opts.includes('УСР'), 'в форме домашки есть тип УСР: ' + opts.join(','));
  await page.waitForTimeout(500);

  // Сохранение домашки: в PUT должна быть запись бота, пришедшая за время сессии
  await page.evaluate(() => {
    document.getElementById('homeworkSubject').innerHTML = '<option>Логистика</option>';
    document.getElementById('homeworkSubject').value = 'Логистика';
    document.getElementById('homeworkType').value = 'УСР';
    document.getElementById('homeworkText').value = 'Домашка админа';
    document.getElementById('homeworkDueDate').value = '2030-01-10';
  });
  await page.evaluate(() => saveHomework());
  await page.waitForTimeout(1500);
  const put = state.github.putBody;
  say(!!put, 'PUT на GitHub отправлен');
  if (put) {
    const saved = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8'));
    const hwIds = saved.homework.map((h) => h.id);
    say(hwIds.includes('hw-bot-777'), 'в PUT есть запись бота hw-bot-777 (слияние): ' + hwIds.length + ' записей домашки');
    say(saved.homework.some((h) => h.text === 'Домашка админа' && h.type === 'УСР'), 'в PUT есть новая запись админа с типом УСР');
    say(!('students' in saved) && !('absences' in saved), 'students и absences в публичный файл не попали');
    say(put.sha === 'abc123', 'sha взят из свежего GET');
    const inApp = await page.evaluate(() => appData.homework.some((h) => h.id === 'hw-bot-777'));
    say(inApp, 'после сохранения запись бота подтянулась в appData');
  }
  say(state.calls.includes('journal-save'), 'journal-save вызван как раньше');
  await page.waitForTimeout(500);
  await shot(page, 'admin-after-save');

  // Удаление админом не воскрешает запись
  state.github.putBody = null;
  await closeAlert(page);
  const delP = page.evaluate(() => deleteHomework('hw-bot-777'));
  await page.waitForSelector('#customConfirmModal.show');
  await page.click('#customConfirmOkBtn');
  await delP;
  await page.waitForTimeout(1500);
  if (state.github.putBody) {
    const saved = JSON.parse(Buffer.from(state.github.putBody.content, 'base64').toString('utf8'));
    // GET мок всегда отдаёт hw-bot-777 — админ удалил её сам, она не должна вернуться
    say(!saved.homework.some((h) => h.id === 'hw-bot-777'), 'удалённая админом запись бота не воскресла из remote');
  } else say(false, 'второй PUT не отправлен');

  say(!page.errors.filter((e) => !ignorable(e)).length, 'ошибок в консоли нет: ' + page.errors.filter((e) => !ignorable(e)).join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(problems.length ? `\nПроблем: ${problems.length}` : '\nВсё в порядке');
process.exit(problems.length ? 1 : 0);
