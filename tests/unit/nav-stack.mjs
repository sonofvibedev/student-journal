// Модульный тест стека «Назад» для Telegram Mini App (cab-core.js: Cab.nav, Cab.backButton). Node, без сети:
// cab-core.js выполняется в vm с заглушками браузера и объекта Telegram.WebApp.
//   node tests/unit/nav-stack.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const results = [];
function t(name, fn) {
  try { fn(); results.push([name, true]); console.log('OK     ' + name); }
  catch (e) { results.push([name, false]); console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); }
}

// Окружение: window = глобальный объект контекста; всё, что нужно коду, подделано
function env({ tg, modal, page = 'app.html', hash = '' } = {}) {
  const mem = new Map(), log = { events: [], observers: [] };
  const ctx = {
    J2: { sb: null, esc: (s) => String(s) },
    location: { pathname: '/student-journal/' + page, hash, href: '' },
    sessionStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) },
    document: { body: {}, querySelector: (s) => (s === '.cab-modal' && ctx.modalOpen ? {} : null), dispatchEvent: (e) => { log.events.push(e.key); } },
    KeyboardEvent: class { constructor(type, o) { this.type = type; this.key = o && o.key; } },
    MutationObserver: class { constructor(cb) { this.cb = cb; log.observers.push(this); } observe() {} },
    navigator: { onLine: true }, console, JSON, Array, String, Math, Date, Promise,
    modalOpen: !!modal,
  };
  ctx.window = ctx;
  if (tg !== undefined) ctx.Telegram = tg ? { WebApp: tg } : undefined;
  vm.runInNewContext(readFileSync('cab-core.js', 'utf8'), ctx);
  return { Cab: ctx.Cab, ctx, mem, log };
}
function fakeTg(over = {}) {
  const calls = { show: 0, hide: 0, click: null, ready: 0 };
  return { calls, initData: 'query_id=x', isVersionAtLeast: () => true, ready: () => { calls.ready++; },
    BackButton: { show: () => { calls.show++; }, hide: () => { calls.hide++; }, onClick: (cb) => { calls.click = cb; } }, ...over };
}

const { Cab } = env();
const plain = (a) => JSON.parse(JSON.stringify(a));   // массивы из vm: другой прототип, сравниваем как данные
const v = (s, h, max) => plain(Cab.nav.visit(s, h, max));

t('пустой стек: первая запись', () => assert.deepEqual(v([], 'app.html#/home'), ['app.html#/home']));
t('не дублируем подряд (перезагрузка страницы)', () => assert.deepEqual(v(['a#/1', 'a#/2'], 'a#/2'), ['a#/1', 'a#/2']));
t('новый адрес добавляется', () => assert.deepEqual(v(['a#/1'], 'a#/2'), ['a#/1', 'a#/2']));
t('адрес = предпоследний → возврат (pop)', () => assert.deepEqual(v(['a#/1', 'a#/2', 'a#/3'], 'a#/2'), ['a#/1', 'a#/2']));
t('возврат на корень: остаётся одна запись', () => assert.deepEqual(v(['a#/home', 'a#/study'], 'a#/home'), ['a#/home']));
t('адрес глубже по стеку, не предпоследний — это новый переход, не возврат', () => assert.deepEqual(v(['a#/1', 'a#/2', 'a#/3'], 'a#/1'), ['a#/1', 'a#/2', 'a#/3', 'a#/1']));
t('лимит: не больше 30 записей, старые отбрасываются, последняя — новая', () => {
  let s = []; for (let i = 0; i < 45; i++) s = v(s, 'a#/' + i);
  assert.equal(s.length, 30); assert.equal(s[0], 'a#/15'); assert.equal(s[29], 'a#/44');
});
t('мусор вместо стека не ломает логику', () => { assert.deepEqual(v(null, 'a#/1'), ['a#/1']); assert.deepEqual(v([1, 'a#/1', {}], 'a#/2'), ['a#/1', 'a#/2']); });

t('адрес экрана: пустой hash и «#/» приводятся к стартовому маршруту', () => {
  assert.equal(env({ hash: '' }).Cab.nav.key('home'), 'app.html#/home');
  assert.equal(env({ hash: '#/' }).Cab.nav.key('home'), 'app.html#/home');
  assert.equal(env({ page: 'headman.html', hash: '#/journal/certs' }).Cab.nav.key('summary'), 'headman.html#/journal/certs');
});
t('куда вести по «Назад»: тот же файл — hash; другой файл — href; на корне — никуда', () => {
  const same = env({ page: 'app.html' }).Cab.nav.target(['app.html#/home', 'app.html#/study'], 'home');
  assert.deepEqual({ ...same }, { same: true, hash: '#/home', href: 'app.html#/home' });
  const other = env({ page: 'headman.html' }).Cab.nav.target(['app.html#/profile', 'headman.html#/summary'], 'summary');
  assert.deepEqual({ ...other }, { same: false, hash: '#/profile', href: 'app.html#/profile' });
  assert.equal(env().Cab.nav.target(['app.html#/home'], 'home'), null);
  assert.equal(env().Cab.nav.target([], 'home'), null);
});
t('запись и чтение стека в sessionStorage; битое значение = пустой стек', () => {
  const e = env(); e.Cab.nav.write(['a#/1', 'a#/2']); assert.deepEqual(plain(e.Cab.nav.read()), ['a#/1', 'a#/2']);
  e.mem.set('j2.nav', '{не json'); assert.deepEqual(plain(e.Cab.nav.read()), []);
});

t('вне Telegram кнопка не подключается и не падает', () => {
  const e = env({ tg: null }); const sync = e.Cab.backButton('home'); assert.equal(typeof sync, 'function'); sync();
  const tg = fakeTg({ initData: '' }); const e2 = env({ tg }); e2.Cab.backButton('home')();
  assert.equal(tg.calls.show + tg.calls.hide, 0); assert.equal(tg.calls.click, null);
});
t('Telegram старее 6.1: кнопку не трогаем', () => {
  const tg = fakeTg({ isVersionAtLeast: () => false }); env({ tg }).Cab.backButton('home')();
  assert.equal(tg.calls.show + tg.calls.hide, 0); assert.equal(tg.calls.click, null);
});
t('нет BackButton или исключение внутри: не бросаем', () => {
  const tg = fakeTg({ BackButton: undefined }); env({ tg }).Cab.backButton('home')();
  const tg2 = fakeTg({ isVersionAtLeast: () => { throw new Error('boom'); } }); env({ tg: tg2 }).Cab.backButton('home')();
});
t('на корне (одна запись) кнопка скрыта, при двух записях видна', () => {
  const tg = fakeTg(), e = env({ tg }); const sync = e.Cab.backButton('home');
  e.Cab.nav.write(['app.html#/home']); sync(); assert.equal(tg.calls.hide, 1); assert.equal(tg.calls.show, 0);
  e.Cab.nav.write(['app.html#/home', 'app.html#/study']); sync(); assert.equal(tg.calls.show, 1);
});
t('открытое окно: кнопка видна даже на корне; нажатие закрывает окно (Escape), а не уходит с экрана', () => {
  const tg = fakeTg(), e = env({ tg, modal: true, hash: '#/study' }); const sync = e.Cab.backButton('home');
  e.Cab.nav.write(['app.html#/home', 'app.html#/study']); sync(); assert.equal(tg.calls.show, 1);
  tg.calls.click(); assert.deepEqual(e.log.events, ['Escape']); assert.equal(e.ctx.location.hash, '#/study');
  e.ctx.modalOpen = false; tg.calls.click(); assert.equal(e.ctx.location.hash, '#/home');   // окна нет: возвращаемся на предыдущий раздел
});
t('нажатие: на другую страницу ведём по href, на корне ничего не делаем', () => {
  const tg = fakeTg(), e = env({ tg, page: 'headman.html', hash: '#/summary' }); e.Cab.backButton('summary');
  e.Cab.nav.write(['app.html#/profile', 'headman.html#/summary']); tg.calls.click(); assert.equal(e.ctx.location.href, 'app.html#/profile');
  const tg2 = fakeTg(), e2 = env({ tg: tg2 }); e2.Cab.backButton('home'); e2.Cab.nav.write(['app.html#/home']); tg2.calls.click();
  assert.equal(e2.ctx.location.href, ''); assert.equal(e2.ctx.location.hash, '');
});
t('окно открыли или закрыли (MutationObserver): видимость обновляется, при подключении вызван ready()', () => {
  const tg = fakeTg(), e = env({ tg }); e.Cab.backButton('home'); e.Cab.nav.write(['app.html#/home']);
  assert.equal(tg.calls.ready, 1); assert.equal(e.log.observers.length, 1);
  e.ctx.modalOpen = true; e.log.observers[0].cb(); assert.equal(tg.calls.show, 1);
  e.ctx.modalOpen = false; e.log.observers[0].cb(); assert.equal(tg.calls.hide, 1);
});

t('свайп: пороги жеста как в старом журнале (50 px, 1,5 раза горизонталь, 700 мс)', () => {
  const d = Cab.swipe.dir;
  assert.equal(d(-60, 5, 200), 1); assert.equal(d(60, 5, 200), -1);        // влево — следующий раздел, вправо — предыдущий
  assert.equal(d(-49, 0, 100), 0);                                        // короткий сдвиг
  assert.equal(d(-80, 60, 100), 0); assert.equal(d(-90, 60, 100), 1);     // горизонталь меньше или ровно в 1,5 раза сильнее вертикали
  assert.equal(d(-80, 0, 701), 0); assert.equal(d(-80, 0, 700), 1);       // слишком медленно
  assert.equal(d(5, 120, 200), 0);                                        // вертикальный жест
});
t('свайп: соседний раздел без зацикливания на краях', () => {
  const n = Cab.swipe.next;
  assert.equal(n(0, 1, 4), 1); assert.equal(n(2, -1, 4), 1); assert.equal(n(3, 1, 4), -1); assert.equal(n(0, -1, 4), -1);
  assert.equal(n(-1, 1, 4), -1); assert.equal(n(1, 0, 4), -1);
});

t('ФИО преподавателя: сокращённое дополняется из data.json по фамилии, инициалам и предмету, иначе остаётся как есть', () => {
  const dt = JSON.parse(readFileSync('data.json', 'utf8')).teachers, f = Cab.teacherFull;
  assert.equal(f('Волонтей А.В.', 'Стратегический маркетинг', dt), 'Волонтей Алексей Викторович');
  assert.equal(f('Яровская Е.С.', 'Логистика', dt), 'Яровская Екатерина Сергеевна');
  assert.equal(f('Стасева А.А.', 'Эконометрика', dt), 'Стасева А.А.');                 // в data.json тоже сокращено
  assert.equal(f('Пушкин С.А.', 'Эконометрика', dt), 'Пушкин С.А.');
  assert.equal(f('Волонтей А.В.', 'Логистика', dt), 'Волонтей А.В.');                  // другой предмет: не додумываем
  assert.equal(f('Волонтей Б.В.', 'Стратегический маркетинг', dt), 'Волонтей Б.В.');   // другие инициалы
  assert.equal(f('Рехтин Виталий Анатольевич', 'Логистика', dt), 'Рехтин Виталий Анатольевич');
  assert.equal(f('Волонтей А.В.', 'Стратегический маркетинг', []), 'Волонтей А.В.');
  assert.equal(Cab.isAbbrevName('Стасева А.А.'), true); assert.equal(Cab.isAbbrevName('Синявская Ольга Александровна'), false); assert.equal(Cab.isAbbrevName(null), false);
});

const bad = results.filter((r) => !r[1]).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
