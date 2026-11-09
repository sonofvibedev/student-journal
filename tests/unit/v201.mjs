// Модульные проверки 2.0.1 (cab-core.js): цвет часов пропусков, статус документа, плашка «Что нового» один раз на пользователя и версию.
//   node tests/unit/v201.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

let failed = 0;
const t = (name, fn) => { try { fn(); console.log('OK     ' + name); } catch (e) { failed++; console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); } };

function load(store = new Map()) {
  const added = [];
  const el = () => ({ classList: { add() {} }, setAttribute() {}, remove() {}, set innerHTML(v) { this.html = v; } });
  const ctx = {
    J2: { sb: null, esc: (s) => String(s) },
    location: { pathname: '/app.html', hash: '', href: '' },
    sessionStorage: { getItem: () => null, setItem() {} },
    document: { body: { appendChild: (n) => added.push(n) }, querySelector: () => null, createElement: el },
    navigator: { onLine: true }, console, JSON, Array, String, Math, Date, Promise, setTimeout: () => 0, clearTimeout() {},
    lsGet: (k) => (store.has(k) ? store.get(k) : null), lsSet: (k, v) => { store.set(k, String(v)); return true; },
    APP_VERSION: "2.0.2", CHANGELOG: [{ version: "2.0.2", title: 'Проверка' }],
  };
  ctx.window = ctx;
  vm.runInNewContext(readFileSync('cab-core.js', 'utf8'), ctx);
  return { Cab: ctx.Cab, added, store };
}

const { Cab } = load();

// 0–2 зелёный, 4–6 жёлтый, 8 и больше красный (граница: 0, 2, 4, 6, 8, 10, 12; нечётные — по ближайшему порогу ниже)
t('цвет часов на границах', () => {
  const cls = (n) => Cab.absTone(n).cls;
  [0, 1, 2, 3].forEach((n) => assert.equal(cls(n), 'g', 'часов ' + n));
  [4, 5, 6, 7].forEach((n) => assert.equal(cls(n), 'y', 'часов ' + n));
  [8, 9, 10, 12, 20].forEach((n) => assert.equal(cls(n), 'r', 'часов ' + n));
});
t('кольцо берёт цвет по часам, а не по доле', () => {
  const svg = String(Cab.ring(8, 24, 84));
  assert.ok(svg.includes('var(--abs-r)') && !svg.includes('var(--j-lime)'));
  assert.ok(String(Cab.ring(2, 12, 84)).includes('var(--abs-g)'));
});
t('статус документа: сдан, ждём, просрочен', () => {
  const today = '2026-11-09';
  assert.equal(Cab.docState({ cert_submitted: true }, today).cls, 'c-mint');
  assert.equal(Cab.docState({ cert_due_date: '2026-11-09' }, today).cls, 'c-amber');       // срок сегодня — ещё ждём
  assert.equal(Cab.docState({ cert_due_date: '2026-11-08' }, today).cls, 'c-coral');       // вчера — просрочен
  assert.equal(Cab.docState({}, today).text, 'срок не указан');
});
t('плашка «Что нового»: один раз на пользователя и версию', () => {
  const a = load();
  assert.equal(a.Cab.whatsNewBanner({ uid: 'u1' }, '#/x'), true);
  assert.equal(a.Cab.whatsNewBanner({ uid: 'u1' }, '#/x'), false);                          // перезаход
  assert.equal(a.Cab.whatsNewBanner({ uid: 'u2' }, '#/x'), true);                           // другой пользователь
  assert.equal(a.added.length, 2);
  const b = load(a.store);                                                                    // новая загрузка страницы, та же память
  assert.equal(b.Cab.whatsNewBanner({ uid: 'u1' }, '#/x'), false);
  assert.equal(Cab.WN_MS, 5000);
});

// Главная: экзамен ровно за 7 дней показывается, за 8 — нет (examSoon из app-student.js; выделяем строку, чтобы не поднимать весь экран)
t('зачёт и экзамен на главной: 7 дней да, 8 нет', () => {
  const src = readFileSync('app-student.js', 'utf8');
  assert.ok(/const EXAM_DAYS = 7;/.test(src));
  const m = /const examSoon = (.*);/.exec(src);
  const examSoon = vm.runInNewContext('(' + m[1].replace(/Cab\./g, 'Cab.') + ')', { Cab, EXAM_DAYS: 7 });
  const today = '2026-11-09', ex = (due) => ({ isExam: true, due });
  assert.equal(examSoon(ex('2026-11-16'), today), true);                                      // через 7
  assert.equal(examSoon(ex('2026-11-17'), today), false);                                     // через 8
  assert.equal(examSoon(ex('2026-11-09'), today), true);
  assert.equal(examSoon({ isExam: false, due: '2026-12-30' }, today), true);                  // обычные задания не режем
});

process.exit(failed ? 1 : 0);
