// Модульные проверки 2.0.3: цветовая гамма (accent.js, контраст), сокращения предметов (Cab.sj), «ПЗ», массовое внесение
// пропусков (offline-queue.js: пачки, повтор, очередь без дублей), подписи логов (log-explain.js), версия и миграции.
//   node tests/unit/v203.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';

let failed = 0;
const t = async (name, fn) => { try { await fn(); console.log('OK     ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); } };
const read = (f) => readFileSync(f, 'utf8');

// ---------- cab-core.js в песочнице ----------
const ctx = {
  J2: { sb: null, esc: (s) => String(s) }, location: { pathname: '/app.html', hash: '', href: '' }, sessionStorage: { getItem: () => null, setItem() {} },
  document: { body: {}, querySelector: () => null, createElement: () => ({}) }, navigator: { onLine: true }, console, JSON, Array, String, Math, Date, Promise, Set, Map, setTimeout: () => 0, clearTimeout() {},
  lsGet: () => null, lsSet: () => true,
};
ctx.window = ctx;
vm.runInNewContext(read('cab-core.js'), ctx);
const Cab = ctx.Cab;

// ---------- версия ----------
await t('версия одна: package.json (2.1.1), APP_VERSION (2.1.1), первая запись «Что нового»', () => {
  const src = read('changelog.js'), full = JSON.parse(read('package.json')).version, v = full.replace(/\.0$/, '');
  assert.equal(full, '2.1.1');
  assert.doesNotThrow(() => new vm.Script(src), 'changelog.js должен компилироваться (его грузят все страницы)');
  assert.ok(src.includes(`const APP_VERSION = '${v}';`));
  const first = /const CHANGELOG = \[\s*\{\s*version: '([^']+)'[\s\S]*?items: \[([\s\S]*?)\n    \],/.exec(src);
  assert.equal(first[1], v);
  assert.ok((first[2].match(/^\s+'/gm) || []).length >= 3, 'в первой записи должны быть пункты по всем изменённым разделам');
});
await t('CACHE_VERSION на единицу выше, ?v= во всех страницах тот же номер', () => {
  const n = Number(/journal-24dmm2-v(\d+)/.exec(read('sw.js'))[1]);
  assert.ok(n >= 67, 'номер сборки не меньше 67 (поднимает tools/bump-assets.mjs)');
  for (const f of ['app.html', 'headman.html', 'teacher.html', 'join.html', 'register.html', 'sysadmin.html']) {
    const vs = new Set((read(f).match(/\?v=\d+/g) || []));
    assert.deepEqual([...vs], ['?v=' + n], f);
  }
});
await t('новые файлы есть в кэше воркера и подключены', () => {
  const sw = read('sw.js');
  assert.ok(sw.includes("'./accent.js'") && sw.includes("'./log-explain.js'"));
  assert.ok(/<script src="accent\.js\?v=\d+"><\/script>/.test(read('app.html')));
  assert.ok(read('sysadmin.html').indexOf('log-explain.js') < read('sysadmin.html').indexOf('sysadmin.js?'));
});

// ---------- 1. цветовая гамма ----------
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fgHex, bgHex, alpha) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(fgHex.slice(i, i + 2), 16) * alpha + parseInt(bgHex.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
const accentCtx = { localStorage: { length: 0, key: () => null, getItem: () => null } };
accentCtx.window = accentCtx; accentCtx.globalThis = accentCtx;
vm.runInNewContext(read('accent.js'), accentCtx);
const A = accentCtx.J2Accent;

await t('палитра: пять акцентов, лайм совпадает с j2.css (выглядит как раньше)', () => {
  assert.equal(A.ACCENTS.length, 5);
  const css = read('j2.css'), p = A.palette('#C6F432');
  assert.ok(css.includes('--j-bg-rgb: 10, 12, 17;') && css.includes('--j-lime-rgb: 198, 244, 50;') && css.includes('--j-glow-2-rgb: 110, 80, 220;') && css.includes('--j-glow-3-rgb: 255, 160, 60;'));
  assert.ok(css.includes('--j-sheet: #14161D;') && css.includes('--j-nav: rgba(24, 26, 34, .86);'));
  assert.deepEqual([p.bgRgb, p.limeRgb, p.glow2, p.glow3, p.sheet, p.nav, p.bg], ['10, 12, 17', '198, 244, 50', '110, 80, 220', '255, 160, 60', '#14161D', 'rgba(24, 26, 34, .86)', '#0A0C11']);
});
await t('палитра: у каждого акцента свой фон с оттенком, пятна света соседних оттенков, шторки и панель в тон', () => {
  const ps = A.ACCENTS.map(([c]) => A.palette(c));
  assert.equal(new Set(ps.map((p) => p.bg)).size, 5); assert.equal(new Set(ps.map((p) => p.sheet)).size, 5);
  ps.slice(1).forEach((p) => {
    assert.ok(lum(p.bg) < 0.01, 'фон остаётся тёмным: ' + p.bg);
    assert.notEqual(p.glow2, ps[0].glow2); assert.equal(p.glow1, p.limeRgb);
    assert.ok(lum(p.sheet) > lum(p.bg), 'шторка светлее фона');
  });
  assert.equal(A.palette('#123456').accent, '#C6F432');                  // чужой цвет → лайм
});
await t('контраст WCAG AA (не ниже 4,5) для всех акцентов: текст, приглушённый текст, текст на акценте, акцент как текст', () => {
  A.ACCENTS.forEach(([c, name]) => {
    const p = A.palette(c), card = over('#FFFFFF', p.bg, 0.06);
    assert.ok(ratio('#F2F4F8', p.bg) >= 4.5 && ratio('#F2F4F8', p.sheet) >= 4.5 && ratio('#F2F4F8', card) >= 4.5, name + ': основной текст');
    assert.ok(ratio('#9AA0AE', p.bg) >= 4.5 && ratio('#9AA0AE', p.sheet) >= 4.5 && ratio('#9AA0AE', card) >= 4.5, name + ': приглушённый текст');
    assert.ok(ratio(p.ink, c) >= 4.5, name + ': текст на акценте ' + ratio(p.ink, c).toFixed(2));
    assert.ok(ratio(c, p.bg) >= 4.5 && ratio(c, p.sheet) >= 4.5 && ratio(c, card) >= 4.5, name + ': акцент как цвет текста');
  });
});
await t('apply: переменные CSS, theme-color, цвет для Telegram', () => {
  const vars = {}, meta = { v: '', setAttribute(k, v) { this.v = v; } }, sets = [];
  const attrs = {}, doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, style: { setProperty: (k, v) => { vars[k] = v; } } }, querySelector: () => meta };
  const w = { document: doc, TGApp: { setBg: (c) => sets.push(c) } }; w.window = w; w.globalThis = w;
  vm.runInNewContext(read('accent.js'), w);
  const p = w.J2Accent.apply('#A78BFA', 'dark');
  assert.equal(vars['--j-lime'], '#A78BFA'); assert.equal(vars['--j-bg-rgb'], p.bgRgb); assert.equal(vars['--j-sheet'], p.sheet); assert.equal(vars['--j-nav'], p.nav);
  assert.ok(['--j-lime-rgb', '--j-glow-1-rgb', '--j-glow-2-rgb', '--j-glow-3-rgb', '--j-lime-ink'].every((k) => vars[k]));
  assert.equal(meta.v, p.bg); assert.equal(w.J2_BG, p.bg); assert.deepEqual(sets.slice(-1), [p.bg]);
});
await t('сохранённый акцент находится по суффиксу ключа (префикс стенда t_ не мешает)', () => {
  const ls = { length: 2, key: (i) => ['x', 't_j2_accent'][i], getItem: (k) => (k === 't_j2_accent' ? '#FF8CBE' : null) };
  const w = { localStorage: ls }; w.window = w; w.globalThis = w;
  vm.runInNewContext(read('accent.js'), w);
  assert.equal(w.J2Accent.saved(), '#FF8CBE');
});
await t('в стилях не осталось зашитого лайма и фона шторок: всё через переменные', () => {
  for (const f of ['cab.css', 'j2.css', 'sysadmin.html']) assert.ok(!/rgba\(198, 244, 50/.test(read(f)), f);
  assert.ok(!/#14161D/i.test(read('cab.css')) && !/rgba\(24, 26, 34/.test(read('cab.css')) && !/rgba\(10, 12, 17/.test(read('cab.css')));
  for (const f of ['app.html', 'headman.html', 'teacher.html']) assert.ok(/html, body \{ margin: 0; background: rgb\(var\(--j-bg-rgb, 10, 12, 17\)\)/.test(read(f)), f + ': фон html');
  const css = read('j2.css');
  assert.ok(/html \{[^}]*background: var\(--j-bg\)/.test(css) && /rgba\(var\(--j-glow-1-rgb\), \.14\)/.test(css));
});
await t('Telegram берёт фон из палитры, а не из зашитой константы', () => {
  const src = read('tg-app.js');
  assert.ok(src.includes('window.J2_BG') && src.includes('TGApp.setBg') && src.includes('setHeaderColor(BG)') && src.includes('setBottomBarColor(BG)'));
  assert.ok(read('app-student.js').includes('J2Accent.apply(c)'));
});

// ---------- 4. сокращения предметов ----------
await t('Cab.sj: три предмета, без учёта регистра и лишних пробелов, прочее без изменений', () => {
  assert.equal(Cab.sj('Маркетинговые исследования и аналитика'), 'МИИА');
  assert.equal(Cab.sj('Интегрированные маркетинговые коммуникации'), 'ИМК');
  assert.equal(Cab.sj('Функционально-стоимостный анализ'), 'ФСА');
  assert.equal(Cab.sj('  функционально-стоимостный   АНАЛИЗ '), 'ФСА');
  assert.equal(Cab.sj('Эконометрика'), 'Эконометрика');
  assert.equal(Cab.sj(''), ''); assert.equal(Cab.sj(null), null); assert.equal(Cab.sj(undefined), undefined);
});
await t('сокращения только на экране: в данных предметы остаются полными, сравнение по полному названию', () => {
  const full = 'Функционально-стоимостный анализ';
  const s = Cab.subjStats([{ subject: full, hours: 2, is_excused: false, lesson_kind: 'lecture' }, { subject: ' функционально-стоимостный анализ', hours: 2, is_excused: true, lesson_kind: 'lecture' }], new Set());
  assert.equal(s.list.length, 1); assert.equal(s.list[0].subject, full);        // строка статистики хранит полное название
  for (const f of ['app-student.js', 'headman.js', 'teacher.js']) {
    const src = read(f);
    assert.ok(!/\.eq\('subject', Cab\.sj/.test(src) && !/subject: Cab\.sj/.test(src), f + ': сокращение не должно попадать в запросы');
    assert.ok(/Cab\.sj\(/.test(src), f);
  }
});
await t('шторки, заголовок карточки предмета и aria-label остаются с полным названием', () => {
  const st = read('app-student.js');
  assert.ok(/sheet\(l\.subject,/.test(st), 'шторка занятия');
  assert.ok(/<span>\$\{subj\}<\/span><s/.test(st) && /<b>\$\{subj\}<\/b>/.test(st), 'карточка предмета на «Преподавателях»');
  for (const f of ['app-student.js', 'headman.js', 'teacher.js']) for (const m of read(f).match(/aria-label="[^"]*"/g) || []) assert.ok(!/Cab\.sj/.test(m), f + ' ' + m);
  const hm = read('headman.js');
  assert.ok(/confirmSheet\('Отменить пропуск\?', `\$\{Cab\.initials\(name\.get\(a\.student_id\) \|\| \{\}\)\}, \$\{a\.subject/.test(hm), 'подтверждение отмены с полным названием');
});

// ---------- 5. «ПЗ» ----------
await t('«Практические» → «ПЗ»: Cab.KIND, kindLow, таблица старосты, расписание', () => {
  assert.equal(Cab.KIND.practice, 'ПЗ'); assert.equal(Cab.kindLow('practice'), 'ПЗ');
  assert.equal(Cab.KIND.lecture, 'Лекция'); assert.equal(Cab.kindLow('lab'), 'лабораторная');       // другие виды не тронуты
  assert.ok(read('headman.js').includes("['practice', 'ПЗ']"));
  assert.ok(read('schedule.js').includes("'ПЗ': 'ПЗ'"));
});
await t('в интерфейсе нет слов «практический/практическое» (кроме «Летняя практика» и старых записей «Что нового»)', () => {
  const files = ['cab-core.js', 'app-student.js', 'headman.js', 'teacher.js', 'sysadmin.js', 'register.js', 'schedule.js', 'index.html', 'app.html', 'headman.html', 'teacher.html', 'sysadmin.html', 'join.js', 'j2-core.js'];
  for (const f of files) {
    const bad = read(f).split('\n').filter((l) => /практическ|Практическ|Практ\./.test(l) && !/Летняя практика/.test(l));
    assert.deepEqual(bad.map((l) => l.trim().slice(0, 90)), [], f);
  }
  const first = /\{\s*version: '2\.0\.3'[\s\S]*?\n  \},/.exec(read('changelog.js'))[0];
  assert.ok(/«практические» и «практическое»/.test(first));                                          // в 2.0.3 это слово упомянуто как «было»
});
await t('миграции: _lesson_kind_ru говорит «ПЗ», у новых миграций есть down-файлы, прод не трогается', () => {
  const up = readdirSync('supabase/migrations').filter((f) => /^202611(16)/.test(f)), down = readdirSync('supabase/migrations_down');
  assert.equal(up.length, 2);
  for (const f of up) assert.ok(down.includes(f.replace('.sql', '.down.sql')), 'нет down: ' + f);
  assert.ok(/'practice' then 'ПЗ'/.test(read('supabase/migrations/20261116100000_journal2_v203_pz.sql')));
  assert.ok(/'practice' then 'практическое'/.test(read('supabase/migrations_down/20261116100000_journal2_v203_pz.down.sql')));
  const lg = read('supabase/migrations/20261116110000_journal2_v203_activity_log.sql');
  assert.ok(lg.includes('_assert_sysadmin(false)') && /grant execute on function public\.sysadmin_activity_log/.test(lg));
  assert.ok(/revoke all on function public\.sysadmin_activity_log[^;]*from public, anon;/.test(lg));
  const dn = read('supabase/migrations_down/20261116110000_journal2_v203_activity_log.down.sql');
  for (const fn of ['sysadmin_activity_log', '_student_short', '_actor_name', '_actor_role']) assert.ok(dn.includes(fn), fn);
});

// ---------- 3. массовое внесение пропусков ----------
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
await import('../../offline-queue.js');
const OQ = globalThis.OQ;
const NET = { message: 'TypeError: Failed to fetch' };
// База-заглушка: absences в памяти, запросы считаются; fail(n) — оборвать указанные по порядку запросы
function fakeSb() {
  const db = { rows: [], calls: [], plan: [], n: 0 };
  const step = () => { const i = db.n++, f = db.plan[i]; return f ? { error: f } : { error: null }; };
  const sb = {
    db,
    from: () => ({
      select: () => { const c = { eq: () => c, then: (f) => f({ data: db.rows.map((r) => ({ student_id: r.student_id, subject: r.subject, lesson_kind: r.lesson_kind, pair_no: r.pair_no })), error: null }) }; return c; },
      upsert: (rows) => { const s = step(); db.calls.push(['upsert', rows.length]); if (s.error) return Promise.resolve(s); rows.forEach((r) => { if (!db.rows.some((x) => x.id === r.id)) db.rows.push(r); }); return Promise.resolve({ error: null }); },
      update: (patch) => ({ in: (_c, ids) => ({ select: () => { const s = step(); db.calls.push(['update', ids.length]); if (s.error) return Promise.resolve(s); const hit = db.rows.filter((r) => ids.includes(r.id)); hit.forEach((r) => Object.assign(r, patch)); return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }); } }) }),
      delete: () => ({ in: (_c, ids) => ({ select: () => { const s = step(); db.calls.push(['delete', ids.length]); if (s.error) return Promise.resolve(s); const hit = db.rows.filter((r) => ids.includes(r.id)); db.rows = db.rows.filter((r) => !ids.includes(r.id)); return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }); } }) }),
    }),
  };
  return sb;
}
const slept = []; OQ.sleep = async (ms) => { slept.push(ms); };
// 28 студентов × 4 пары в один день = 112 записей, id создаются заранее (как в headman.js)
const mass = (n = 28, pairs = 4) => Array.from({ length: n * pairs }, (_, i) => ({ id: 'ab-' + String(i).padStart(4, '0'), group_id: 'g1', student_id: 's' + (i % n), date: '2026-10-10', subject: 'Эконометрика', hours: 2, lesson_kind: 'practice', pair_no: 1 + Math.floor(i / n), is_excused: false }));

await t('chunk: пачки по OQ.CHUNK (40), остаток последней короче', () => {
  assert.equal(OQ.CHUNK, 40);
  assert.deepEqual(OQ.chunk(mass(), OQ.CHUNK).map((p) => p.length), [40, 40, 32]);
  assert.deepEqual(OQ.chunk([], 40), []); assert.deepEqual(OQ.chunk([1, 2, 3], 2), [[1, 2], [3]]);
});
await t('массово: 28 × 4 = 112 записей уходят тремя запросами, а не одним; прогресс по пачкам', async () => {
  const sb = fakeSb(), prog = [];
  const r = await OQ.sendRows(sb, mass(), { onProgress: (n) => prog.push(n) });
  assert.deepEqual([r.sent, r.left.length, r.err], [112, 0, null]);
  assert.deepEqual(sb.db.calls, [['upsert', 40], ['upsert', 40], ['upsert', 32]]); assert.equal(sb.db.rows.length, 112);
  assert.deepEqual(prog, [40, 40, 32]);
});
await t('обрыв в середине: пачка повторяется с растущей паузой и проходит, дублей нет', async () => {
  const sb = fakeSb(); slept.length = 0;
  sb.db.plan = [null, NET, NET];                                      // 2-я пачка: два обрыва подряд, третья попытка проходит
  const r = await OQ.sendRows(sb, mass(), {});
  assert.deepEqual([r.sent, r.left.length, r.err], [112, 0, null]);
  assert.deepEqual(slept, [500, 1500]);                               // паузы растут
  assert.equal(sb.db.rows.length, 112); assert.equal(new Set(sb.db.rows.map((x) => x.id)).size, 112);
});
await t('обрыв насовсем: ушедшее остаётся, остаток возвращается целиком (пачка и все после неё)', async () => {
  const sb = fakeSb(); slept.length = 0;
  sb.db.plan = [null, NET, NET, NET, NET];                            // 2-я пачка не проходит ни с одной из 4 попыток
  const rows = mass(), r = await OQ.sendRows(sb, rows, {});
  assert.deepEqual([r.sent, r.left.length], [40, 72]); assert.ok(OQ.isNetError(r.err));
  assert.deepEqual(slept, [500, 1500, 4000]); assert.deepEqual(r.left.map((x) => x.id), rows.slice(40).map((x) => x.id));
  // остаток уходит в очередь и не теряется; потом уходит без дублей, даже если «потерянный» ответ всё же дошёл
  mem.clear(); assert.equal(OQ.add('u1', r.left), 72); assert.equal(OQ.count('u1'), 72);
  sb.db.rows.push(rows[40]);                                          // ответ потерян, но запись уже на сервере (тот же id)
  const f = await OQ.flush(sb, 'u1');
  assert.equal(f.left, 0); assert.equal(f.sent + f.dropped, 72);
  assert.equal(sb.db.rows.length, 112); assert.equal(new Set(sb.db.rows.map((x) => x.id)).size, 112);
});
await t('нет сети (браузер говорит офлайн): без пауз, остаток сразу в очередь', async () => {
  const sb = fakeSb(); slept.length = 0; sb.db.plan = [NET];
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');            // в Node 24 navigator — геттер
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try { const r = await OQ.sendRows(sb, mass(), {}); assert.deepEqual([r.sent, r.left.length], [0, 112]); assert.deepEqual(slept, []); }
  finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator; }
});
await t('отказ сервера (42501) не повторяется и не принимается за обрыв', async () => {
  const sb = fakeSb(); slept.length = 0; sb.db.plan = [{ code: '42501', message: 'row-level security' }];
  const r = await OQ.sendRows(sb, mass(10, 1), {});
  assert.equal(r.err.code, '42501'); assert.ok(!OQ.isNetError(r.err)); assert.deepEqual(slept, []); assert.equal(r.left.length, 10);
});
await t('правка и удаление пачками по id (90 записей — 3 запроса), считаются реально затронутые', async () => {
  const sb = fakeSb(); sb.db.rows = mass(30, 3);
  const ids = sb.db.rows.map((r) => r.id);
  let r = await OQ.mutateIds(sb, ids, { is_excused: true, cert_type: 'Справка' }, {});
  assert.deepEqual([r.done, r.left.length, r.err], [90, 0, null]); assert.deepEqual(sb.db.calls, [['update', 40], ['update', 40], ['update', 10]]);
  assert.ok(sb.db.rows.every((x) => x.is_excused === true));
  sb.db.calls.length = 0; sb.db.n = 0;
  r = await OQ.mutateIds(sb, [...ids.slice(0, 85), 'нет-такого'], null, {});
  assert.deepEqual([r.done, r.left.length], [85, 0]); assert.equal(sb.db.rows.length, 5);          // «нет-такого» не затронуто — сервер вернул меньше
  assert.deepEqual(sb.db.calls.map((c) => c[0]), ['delete', 'delete', 'delete']);
});
await t('правка пачками при обрыве: сделанное посчитано, остаток id возвращён для повторного нажатия', async () => {
  const sb = fakeSb(); sb.db.rows = mass(30, 3); slept.length = 0;
  sb.db.plan = [null, NET, NET, NET, NET];
  const r = await OQ.mutateIds(sb, sb.db.rows.map((x) => x.id), { is_excused: true }, {});
  assert.deepEqual([r.done, r.left.length], [40, 50]); assert.ok(OQ.isNetError(r.err));
});
await t('flush: большая очередь идёт пачками по 40 с повтором при обрыве, очередь пуста, дублей нет', async () => {
  mem.clear(); const sb = fakeSb(); slept.length = 0; OQ.add('u9', mass());
  sb.db.plan = [null, null, NET];                                     // сверка «уже внесено», 1-я пачка, 2-я пачка с одним обрывом
  const r = await OQ.flush(sb, 'u9');
  assert.deepEqual([r.sent, r.left, r.net], [112, 0, false]); assert.equal(sb.db.rows.length, 112); assert.ok(slept.length >= 1);
});

// ---------- 2. логи ----------
const LE = (await import('../../log-explain.js')).default || globalThis.LogExplain;
const row = (o) => ({ at: '2026-11-10T14:00:00Z', kind: 'absence', action: 'absence_add', actor: 'u1', actor_name: 'Петров Пётр', actor_role: 'headman', group_name: '24ДММ-2', target: 'Иванов И.', subject: 'Эконометрика', on_date: '2026-11-10', qty: 2, ok: true, detail: null, ...o });
await t('логи: пояснение по-русски — кто, что, над чем, результат', () => {
  const e = LE.explain(row({}));
  assert.equal(e.text, 'Староста внёс пропуск (2 ч): Иванов И., Эконометрика, 10.11. Сохранено.');
  assert.equal(e.who, 'Петров Пётр (староста)'); assert.equal(e.ok, true);
  assert.equal(LE.explain(row({ action: 'absence_cancel' })).text, 'Староста отменил пропуск (2 ч): Иванов И., Эконометрика, 10.11. Отмена сохранена в истории.');
  assert.ok(/Преподаватель внёс отметку: Иванов И., Эконометрика, 10\.11\. Сохранено\./.test(LE.explain(row({ action: 'grade_set', kind: 'grade', actor_role: 'teacher', qty: null })).text));
  assert.ok(/добавил или изменил домашнее задание: Эконометрика, ПЗ, срок 10\.11/.test(LE.explain(row({ action: 'task_homework', kind: 'task', detail: 'ПЗ', target: null })).text));
  assert.ok(/Сисадмин: Преподаватель назначен\. Выполнено\./.test(LE.explain(row({ kind: 'admin', action: 'teacher_assign', actor_role: 'sysadmin', target: null, subject: null, qty: null })).text));
});
await t('логи: ошибка — что это значит и что делать, результат «ошибка», без привязки к пользователю', () => {
  const e = LE.explain(row({ kind: 'error', action: 'TypeError', actor: null, actor_role: 'system', ok: false, detail: 'Failed to fetch', target: null, subject: null, qty: null }));
  assert.equal(e.ok, false); assert.ok(/не привязаны к пользователю/.test(e.who));
  assert.ok(/Браузер не смог связаться с сервером/.test(e.text) && /Что делать:/.test(e.text) && e.help.todo);
  assert.ok(/Резервная копия не создана/.test(LE.explain(row({ kind: 'error', action: 'backup-run', actor: null, ok: false, detail: 'failed' })).text));
  assert.ok(/Неизвестная ошибка/.test(LE.errHelp('Zzz', 'qqq').means));
});
await t('логи: CSV с BOM-совместимой разметкой, кавычки удвоены, формулы обезврежены', () => {
  const csv = LE.toCsv([row({ target: '=HYPERLINK("x")', subject: 'Сказал "привет"; и ушёл' })]), lines = csv.split('\r\n');
  assert.equal(lines.length, 2); assert.ok(lines[0].startsWith('"Время";"Тип";"Роль";"Кто"'));
  assert.ok(lines[1].includes('"\'=HYPERLINK(""x"")"') && lines[1].includes('"Сказал ""привет""; и ушёл"') && lines[1].includes('"Успешно"'));
});
await t('логи: персональные данные не шире допустимого — оценки и причины справок не выводятся, имя студента сокращено', () => {
  const sql = read('supabase/migrations/20261116110000_journal2_v203_activity_log.sql');
  assert.ok(!/g\.value|g\.passed|b\.cert_type|b\.comment|g\.comment/.test(sql), 'значения оценок, причины справок и комментарии не выбираются');
  assert.ok(/left\(s\.first_name, 1\)/.test(sql));
  assert.ok(/_assert_sysadmin\(false\)/.test(sql));
});

console.log(failed ? `\nПровалов: ${failed}` : '\nВсё хорошо');
process.exit(failed ? 1 : 0);
