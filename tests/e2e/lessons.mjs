// Плитки пар с подгруппой, цветной бейдж времени, карточки преподавателей, короткий тост заглушек и шапка главной без «Вся неделя»
// (app.html + app-student.js на ТЕСТОВОМ проекте, 390×844 и 360×800). Фикстуры вставляются service-ключом и удаляются в конце.
// «Сейчас» — 5 ноября 2026, 11:40 по Минску (cab-core.js с Cab.testNow из window.__NOW).
// Запуск: node tests/e2e/lessons.mjs   (после npm run test:reset; SHOTS_DIR — куда сложить скриншоты; CHROME_PATH — Chromium)
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
const NOW = Date.UTC(2026, 10, 5, 8, 40);
const CAB_JS = readFileSync('cab-core.js', 'utf8').replace('Cab.testNow = null;', 'Cab.testNow = window.__NOW ?? null;');
if (!CAB_JS.includes('window.__NOW')) { console.error('СТОП: в cab-core.js не нашёл Cab.testNow = null'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK    ' : 'ПРОВАЛ'} ${name}${ok ? '' : ' — ' + detail}`); };
const shots = resolve(process.env.SHOTS_DIR ?? join(process.env.TEMP ?? '.', 'lessons-e2e')); mkdirSync(shots, { recursive: true });
const SH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const api = async (path, init = {}) => {
  const r = await fetch(URL_SB + path, { ...init, headers: { Prefer: 'return=representation', ...SH, ...(init.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path.slice(0, 80)}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ses = await (await fetch(`${URL_SB}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'student02@journal-test.example', password: env.TEST_PASSWORD }) })).json();
check('студент вошёл', !!ses.access_token);
if (!ses.access_token) { server.close(); process.exit(1); }
const uid = ses.user.id;
const [stu] = await api(`/rest/v1/students?claimed_by=eq.${uid}&select=id,group_id,subgroup`);
const GID = stu.group_id, SID = stu.id;
const [grp] = await api(`/rest/v1/groups?id=eq.${GID}&select=name`);
const D = '2026-11-05', NT = 'Новая оценка (lessons e2e)';

async function cleanup() {
  await api(`/rest/v1/schedule_lessons?group_id=eq.${GID}`, { method: 'DELETE' }).catch(() => {});
  await api(`/rest/v1/notifications?user_id=eq.${uid}&title=eq.${encodeURIComponent(NT)}`, { method: 'DELETE' }).catch(() => {});
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: stu.subgroup }) }).catch(() => {});
}

const browser = await chromium.launch({ executablePath: findChrome() });
try {
  await cleanup();
  await api(`/rest/v1/memberships?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ consent_at: new Date().toISOString(), consent_version: '2026-11-05' }) });
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: null }) });
  const L = (pair_no, a, b, subject, kind, room, teacher, extra = {}) => ({ group_id: GID, lesson_date: D, pair_no, starts_at: a, ends_at: b, subject, kind, teacher, room, subgroup: null, prev_room: null, changed_at: null, ...extra });
  await api('/rest/v1/schedule_lessons', { method: 'POST', body: JSON.stringify([
    L(1, '09:35', '10:55', 'Психология', 'lecture', '120', 'Иванов Иван Иванович'),
    L(3, '11:15', '12:35', 'Эконометрика', 'lecture', '304', 'Миксюк Светлана Федоровна'),
    L(4, '12:55', '14:15', 'Эконометрика', 'practice', '217', 'Стасева А.А.'),
    L(5, '14:35', '15:55', 'Эконометрика', 'lab', '301', 'Пушкин С.А.', { subgroup: 1 }),
    L(5, '14:35', '15:55', 'Эконометрика', 'lab', '302', 'Стасева А.А.', { subgroup: 2 }),
    L(6, '16:15', '17:35', 'Логистика', 'practice', '405', 'Яровская Е.С.'),
    L(7, '17:55', '19:15', 'Стратегический маркетинг', 'practice', '210', 'Волонтей А.В.'),
    L(8, '19:35', '20:55', 'Кураторский час', 'other', '101', null)]) });
  await api('/rest/v1/notifications', { method: 'POST', body: JSON.stringify([{ user_id: uid, group_id: GID, kind: 'grade', title: NT, ref: null, body: 'x', created_at: '2026-11-05T06:00:00Z', read_at: null }]) });

  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'ru-RU', serviceWorkers: 'block' });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes(PROD_REF)) return route.abort();
      if (u.includes('/vendor/telegram-web-app.js')) return route.abort();
      if (u.split('?')[0].endsWith('/env.js')) return route.fulfill({ contentType: 'text/javascript', body: ENV_JS });
      if (u.split('?')[0].endsWith('/cab-core.js')) return route.fulfill({ contentType: 'text/javascript', body: CAB_JS });
      if (u.startsWith(BASE) || u.startsWith(URL_SB)) return route.continue();
      return route.abort();
    });
    await ctx.addInitScript(([k, v, now]) => { try { localStorage.setItem(k, v); } catch (e) {} window.__NOW = now; }, [KEY, JSON.stringify(ses), NOW]);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errs.push(m.text().slice(0, 200)); });
    return { ctx, page, errs };
  };
  const { ctx, page, errs } = await mk(390, 844);
  const ready = async (hash, sel) => { await page.goto(`${BASE}/app.html${hash}`); await page.waitForSelector(sel, { timeout: 30000 }); await page.waitForTimeout(500); };

  // ---------- главная ----------
  await ready('#/home', '.cab-lesson');
  const homeTxt = await page.locator('.cab-lessons').innerText();
  check('главная: у подгрупповых пар видна пометка «1 подгр.» и «2 подгр.» без нажатия', (await page.locator('.cab-lesson .sg').count()) === 2 && homeTxt.includes('1 подгр.') && homeTxt.includes('2 подгр.'), homeTxt.slice(0, 300));
  check('главная: у пар без подгруппы пометки нет', (await page.locator('.cab-lesson', { hasText: 'Психология' }).locator('.sg').count()) === 0);
  check('главная: строка под названием «Лабораторная · 2 подгр.»', (await page.locator('.cab-lesson', { hasText: '2 подгр.' }).locator('.k').first().innerText()).includes('Лабораторная · 2 подгр.'));
  check('главная: для скринридера «подгруппа 2»', (await page.locator('.cab-lesson .sg .sr-only', { hasText: 'подгруппа 2' }).count()) === 1);
  check('главная: нет ссылки «Вся неделя»', !(await page.locator('#cabMain').innerText()).includes('Вся неделя') && (await page.locator('a[href="#/schedule"]').count()) === 0 || (await page.locator('.cab-head a[href="#/schedule"]').count()) === 0);
  const bell = await page.locator('.cab-bell').boundingBox();
  check('главная: колокольчик справа, не прижат к краю (390)', bell && bell.x + bell.width <= 390 - 8 && bell.x + bell.width >= 390 - 24, JSON.stringify(bell));
  check('главная: счётчик непрочитанных виден, aria-label и переход сохранены', (await page.locator('.cab-bell .cab-badge').count()) === 1 && (await page.locator('.cab-bell').getAttribute('aria-label')).startsWith('Уведомления, новых:') && (await page.locator('.cab-bell').getAttribute('href')) === '#/notifications');
  const colors = await page.evaluate(() => Object.fromEntries(['lecture', 'practice', 'lab', 'other'].map((k) => { const e = document.querySelector(`.cab-lesson.kd-${k}:not(.now) .t`); return [k, e && getComputedStyle(e).color]; })));
  check('главная: бейдж времени цветной по виду занятия (лекция, практика, лабораторная, прочее — разные цвета)', new Set(Object.values(colors)).size === 4 && !Object.values(colors).includes(null), JSON.stringify(colors));
  await page.screenshot({ path: join(shots, 'home-subgroup.png') });

  // ширина 360: заголовок с датой в одну строку, колокольчик в пределах экрана
  for (const [w, h] of [[360, 800], [390, 844]]) {
    const c2 = await mk(w, h);
    await c2.page.goto(`${BASE}/app.html#/home`); await c2.page.waitForSelector('.cab-lesson', { timeout: 30000 }); await c2.page.waitForTimeout(400);
    const m = await c2.page.evaluate(() => { const t = document.querySelector('.cab-head .cab-title'), b = document.querySelector('.cab-bell').getBoundingClientRect(); return { th: t.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.2, br: b.right, sw: document.documentElement.scrollWidth }; });
    check(`шапка главной ${w} px: заголовок с датой в одну строку, колокольчик в экране, нет горизонтальной прокрутки`, m.th <= m.lh * 1.4 && m.br <= w - 8 && m.sw <= w, JSON.stringify(m));
    await c2.ctx.close();
  }

  // ---------- расписание ----------
  await ready('#/schedule', '.cab-lesson');
  const sg2 = page.locator('button.cab-lesson', { hasText: '2 подгр.' });
  const vis = (loc) => loc.evaluate((e) => { const c = e.cloneNode(true); c.querySelectorAll('.sr-only').forEach((x) => x.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); });
  const kline = await vis(sg2.locator('.k').first());
  check('расписание: на плитке «Лабораторная · 2 подгр. · ауд. 302»', kline.includes('Лабораторная · 2 подгр. · ауд. 302'), kline);
  check('расписание: aria-label плитки содержит «подгруппа 2»', ((await sg2.getAttribute('aria-label')) || '').includes('подгруппа 2'), await sg2.getAttribute('aria-label'));
  check('расписание: и «1 подгр.», и «2 подгр.» видны без нажатия (подгруппа в профиле не выбрана)', (await page.locator('button.cab-lesson .sg').count()) === 2);
  const same = await page.evaluate(() => { const a = document.querySelector('button.cab-lesson.kd-lab .t'), b = document.querySelector('.cab-lesson.kd-lab'); return !!a && !!b; });
  check('расписание: цветной бейдж времени есть и на этом экране', same && (await page.locator('button.cab-lesson.kd-lecture .t').first().evaluate((e) => getComputedStyle(e).color)) === colors.lecture);
  await page.screenshot({ path: join(shots, 'schedule-subgroup.png') });
  await sg2.click();
  check('расписание: шторка по тапу открывается, подгруппа в ней осталась', (await page.getByRole('dialog').innerText()).includes('Подгруппа'));
  await page.keyboard.press('Escape');

  // подгруппа выбрана: свои пары и общие, пометка остаётся
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: 2 }) });
  await page.reload(); await page.waitForSelector('.cab-lesson', { timeout: 30000 }); await page.waitForTimeout(500);   // тот же адрес: goto не перезагрузит страницу, а подгруппа читается при входе
  const sgTxt = await page.locator('button.cab-lesson .sg').allInnerTexts();
  check('подгруппа 2 выбрана: видна только своя лабораторная с пометкой, чужой подгруппы нет', sgTxt.length === 1 && sgTxt[0].includes('2 подгр.'), JSON.stringify(sgTxt));
  await api(`/rest/v1/students?id=eq.${SID}`, { method: 'PATCH', body: JSON.stringify({ subgroup: null }) });

  // ---------- преподаватели ----------
  await page.goto(`${BASE}/app.html#/study/teachers`); await page.reload(); await page.waitForSelector('#cabMain button.cab-row', { timeout: 30000 }); await page.waitForTimeout(500);   // подгруппа снова не выбрана: ctx читается при входе
  const cards = await page.locator('#cabMain button.cab-row').count(), tt = await page.locator('#cabMain').innerText();
  check('преподаватели: на странице только карточки предметов (5), без ФИО и «Лекции: …»', cards === 5 && !tt.includes('Иванов') && !tt.includes('Лекции:') && !tt.includes('ПЗ:'), `${cards} | ${tt.slice(0, 200)}`);
  check('преподаватели: под названием число видов занятий («3 вида занятий»)', (await page.locator('#cabMain button.cab-row', { hasText: 'Эконометрика' }).innerText()).includes('3 вида занятий'));
  await page.screenshot({ path: join(shots, 'teachers.png') });
  await page.locator('#cabMain button.cab-row', { hasText: 'Эконометрика' }).click();
  const dlg = page.getByRole('dialog');
  const dt = await dlg.innerText();
  check('шторка: заголовок предмета, «Лекции: ФИО», «ПЗ: …» (название предмета в шторке полное)', dt.includes('Эконометрика') && dt.includes('Лекции: Миксюк Светлана Федоровна') && dt.includes('ПЗ: Стасева А.А.'), dt);
  check('шторка: «Лабораторные: 1 подгруппа — …, 2 подгруппа — …» (преподаватели разные)', dt.includes('Лабораторные работы: 1 подгруппа — Пушкин С.А.; 2 подгруппа — Стасева А.А.'), dt);
  await page.screenshot({ path: join(shots, 'teacher-sheet.png') });
  await page.keyboard.press('Escape');
  if (grp.name === '24ДММ-2') {
    await page.locator('#cabMain button.cab-row', { hasText: 'Логистика' }).click();
    check('ФИО: сокращённое из расписания дополнено из data.json (группа 24ДММ-2)', (await dlg.innerText()).includes('ПЗ: Яровская Екатерина Сергеевна'), await dlg.innerText());
    await page.keyboard.press('Escape');
    await page.locator('#cabMain button.cab-row', { hasText: 'Стратегический маркетинг' }).click();
    check('ФИО: Волонтей А.В. → Волонтей Алексей Викторович', (await dlg.innerText()).includes('Волонтей Алексей Викторович'), await dlg.innerText());
    await page.keyboard.press('Escape');
  } else console.log(`ПРОПУСК ФИО из data.json: тестовая группа «${grp.name}», подстановка только для 24ДММ-2`);
  await page.locator('#cabMain button.cab-row', { hasText: 'Кураторский час' }).click();
  check('преподаватель не указан → «не указан»', (await dlg.innerText()).includes('не указан'));
  await page.keyboard.press('Escape');
  await page.locator('#cabMain button.cab-row').first().focus();
  await page.keyboard.press('Enter');
  check('карточка открывается с клавиатуры (Enter), у неё видимый фокус', (await dlg.count()) === 1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  const fv = await page.evaluate(() => { const e = document.activeElement; return e && e.matches(':focus-visible') ? getComputedStyle(e).outlineStyle : 'none'; });
  check('фокус с клавиатуры виден (outline)', fv !== 'none', fv);

  // ---------- тосты ----------
  await ready('#/profile', '#pfStu');
  const shown = () => page.evaluate(() => document.getElementById('cabToast').classList.contains('show'));
  await page.locator('#pfStu').click(); await wait(1000);
  check('тост «Студак»: через 1 с ещё виден', await shown());
  await wait(1400);
  check('тост «Студак»: через ~2,4 с скрыт', !(await shown()));
  await page.locator('#pfStu').click(); await wait(1200); await page.locator('#pfStu').click(); await wait(1200);
  check('повторное нажатие перезапускает таймер (через 2,4 с после первого ещё виден)', await shown());
  await wait(1000);
  check('и скрывается через ~1,8 с после последнего нажатия', !(await shown()));
  await page.evaluate(() => Cab.toast('Не удалось сохранить', 'err')); await wait(2400);
  check('тост ошибки через 2,4 с ещё виден (не укорочен)', await shown());
  await wait(1500);
  check('тост ошибки скрывается через ~3,5 с', !(await shown()));
  await page.evaluate(() => Cab.toast('Подгруппа сохранена', 'ok')); await wait(2400);
  check('обычный тост (ok) по-прежнему 3,5 с', await shown());

  check('ошибок в консоли нет', errs.length === 0, errs.join(' | ').slice(0, 300));
  await ctx.close();
} catch (e) { check('прогон завершился без исключения', false, String((e && e.stack) || e).slice(0, 500)); }
finally { await cleanup(); await browser.close(); server.close(); }
const bad = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}. Скриншоты: ${shots}`);
process.exit(bad ? 1 : 0);
