// Модульный тест app-rating.js (Node, без сети): формулы рейтинга те же, что в старом калькуляторе (profile.js), формат хранения совместим
//   node tests/unit/rating.mjs
import assert from 'node:assert/strict';
await import('../../app-rating.js');   // скрипт браузера: кладёт себя в globalThis.Rating
const R = globalThis.Rating;

const results = [];
function t(name, fn) {
  try { fn(); results.push([name, true]); console.log('OK     ' + name); }
  catch (e) { results.push([name, false]); console.log('ПРОВАЛ ' + name + ' — ' + (e && e.message)); }
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

// Эталон: формулы из profile.js (recalcRating / ratingFinalOf), переписанные дословно
const oldAvg = (arr) => (arr.length ? arr.reduce((s, v) => s + Number(v), 0) / arr.length : 0);
const oldFinal = (c, hasExam) => {
  if (!c.control.length && !c.oral.length) return null;
  const seminar = oldAvg(c.control) * c.k1 + oldAvg(c.oral) * (1 - c.k1);
  if (!hasExam) return seminar;
  const exam = parseFloat(c.exam);
  if (isNaN(exam)) return null;
  return seminar * c.w1 + exam * (1 - c.w1);
};

t('семинарские = ср(контрольные)×k1 + ср(устные)×(1−k1)', () => near(R.seminarOf({ control: [8, 6], oral: [10], k1: 0.6, w1: 0.5 }), 7 * 0.6 + 10 * 0.4));
t('итог = семинарские×w1 + экзамен×(1−w1)', () => near(R.finalOf({ control: [8], oral: [6], exam: '9', k1: 0.5, w1: 0.4 }, true), 7 * 0.4 + 9 * 0.6));
t('зачёт без экзамена: итог = семинарские', () => near(R.finalOf({ control: [8], oral: [6], exam: '', k1: 0.5, w1: 0.4 }, false), 7));
t('экзамен не сдан: итога нет', () => assert.equal(R.finalOf({ control: [8], oral: [6], exam: '', k1: 0.5, w1: 0.4 }, true), null));
t('нет оценок за семинары: итога нет', () => assert.equal(R.finalOf({ control: [], oral: [], exam: '9', k1: 0.5, w1: 0.4 }, true), null));
t('совпадает с формулами старого калькулятора на переборе', () => {
  for (const k1 of R.K1) for (const w1 of R.W1) for (const exam of ['', '0', '4.5', '10']) for (const ex of [true, false]) {
    const c = { control: [5, 9, 7], oral: [10, 3], exam, k1, w1 };
    const a = R.finalOf(c, ex), b = oldFinal(c, ex);
    if (b == null) assert.equal(a, null); else near(a, b);
  }
});

t('коэффициенты прижимаются к набору: w1=0.6 (значение по умолчанию в хранилище) → 0.5, k1=0.9 → 0.7', () => {
  const c = R.fit({ control: [], oral: [], exam: '', k1: 0.9, w1: 0.6 });
  assert.equal(c.k1, 0.7); assert.equal(c.w1, 0.5);
});
t('допустимые коэффициенты не меняются', () => { for (const k of R.K1) assert.equal(R.snap(k, R.K1), k); for (const w of R.W1) assert.equal(R.snap(w, R.W1), w); });

t('пороги: <4, <7, ≥7', () => { assert.equal(R.band(3.99), 'low'); assert.equal(R.band(4), 'mid'); assert.equal(R.band(6.99), 'mid'); assert.equal(R.band(7), 'high'); assert.equal(R.band(null), ''); });

t('есть ли экзамен: ничего не известно → есть; только зачёты → нет; есть exam → есть', () => {
  assert.equal(R.hasExamOf([]), true);
  assert.equal(R.hasExamOf([{ type: 'deadline' }, { type: 'ПЗ' }]), true);
  assert.equal(R.hasExamOf([{ type: 'zachet' }]), false);
  assert.equal(R.hasExamOf([{ type: 'zachet' }, { type: 'exam' }]), true);
});

t('хранилище: старый формат читается как есть, мусор не роняет', () => {
  const old = JSON.stringify({ 'Матанализ': { control: [8, '9'], oral: [7], exam: '8.5', k1: 0.6, w1: 0.5 }, 'Физика': { control: [], oral: [] } });
  const s = R.storeRead(old);
  assert.deepEqual(R.storeFor(s, 'Матанализ'), { control: [8, 9], oral: [7], exam: '8.5', k1: 0.6, w1: 0.5 });
  assert.deepEqual(R.subjectsDone(s), ['Матанализ']);
  for (const bad of ['', 'null', '[]', '{не json', '"x"']) assert.deepEqual(R.storeRead(bad), {});
  assert.deepEqual(R.storeFor({}, 'Новый').control, []);
  assert.deepEqual(R.shape({ control: [1, 'x', NaN, 4] }).control, [1, 4]);
});
t('запись расчёта: другие предметы остаются, формат тот же', () => {
  const s0 = { 'А': { control: [5], oral: [], exam: '', k1: 0.5, w1: 0.4 } };
  const s1 = R.storeWrite(s0, 'Б', { control: [9], oral: [8], exam: '7', k1: 0.7, w1: 0.5 });
  assert.deepEqual(Object.keys(s1), ['А', 'Б']);
  assert.deepEqual(JSON.parse(JSON.stringify(s1))['Б'], { control: [9], oral: [8], exam: '7', k1: 0.7, w1: 0.5 });
  assert.equal(s0['Б'], undefined);     // исходное хранилище не мутируется
});

const bad = results.filter((r) => !r[1]).length;
console.log(`\nИтого: ${results.length - bad} из ${results.length}`);
process.exit(bad ? 1 : 0);
