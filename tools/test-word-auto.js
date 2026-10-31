// Тесты чистой логики автовыбора «Слова дня» (supabase/functions/_shared/wordpick.ts)
// и проверки секретного заголовка (tgbot.ts). Запуск: node tools/test-word-auto.js (node 22.18+).

'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// Генератор с фиксированной последовательностью
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

(async () => {
  const W = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/wordpick.ts')).href);
  const T = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/tgbot.ts')).href);
  const DAY = '2026-11-02';
  const row = (word, last_used = null, enabled = true) => ({ word, enabled, last_used });

  test('даты: сдвиг и разница', () => {
    assert.equal(W.shiftDay('2026-11-01', -1), '2026-10-31');
    assert.equal(W.shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(W.daysBetween('2026-09-03', '2026-11-02'), 60);
  });

  test('окно 60 суток: слово ровно 60 дней назад подходит, 59 — нет', () => {
    const pool = [row('море', '2026-09-03'), row('лес', '2026-09-04')];
    for (const r of [0, 0.5, 0.99]) assert.equal(W.pickWord(pool, DAY, () => r).word, 'море');
  });

  test('выключенные слова не выбираются', () => {
    const pool = [row('море', null, false), row('лес'), row('дом', null, false)];
    for (const r of [0, 0.5, 0.99]) assert.equal(W.pickWord(pool, DAY, () => r).word, 'лес');
  });

  test('никогда не использованные и старые подходят все; порядок выдачи базы не важен', () => {
    const a = [row('б'), row('а', '2026-01-01'), row('в', '2026-10-30')];
    const b = [a[2], a[0], a[1]];
    for (const r of [0, 0.4, 0.99]) {
      assert.deepEqual(W.pickWord(a, DAY, () => r), W.pickWord(b, DAY, () => r));
    }
    const got = new Set([0, 0.99].map((r) => W.pickWord(a, DAY, () => r).word));
    assert.deepEqual([...got].sort(), ['а', 'б']);        // «в» вчера — в окне
  });

  test('детерминированность на фиксированном генераторе', () => {
    const pool = ['а', 'б', 'в', 'г', 'д'].map((w) => row(w));
    assert.deepEqual(W.pickWord(pool, DAY, seq(0.3)), W.pickWord(pool, DAY, seq(0.3)));
    assert.equal(W.pickWord(pool, DAY, () => 0).word, 'а');
    assert.equal(W.pickWord(pool, DAY, () => 0.999999).word, 'д');
    assert.equal(W.pickWord(pool, DAY, () => 1).word, 'д');   // защита от rand() == 1
  });

  test('окно исчерпано: сброс 1/3 самых давних, выбор среди них', () => {
    const pool = [
      row('а', '2026-10-30'), row('б', '2026-10-10'), row('в', '2026-10-20'),
      row('г', '2026-10-01'), row('д', '2026-10-25'), row('е', '2026-10-15'),
    ];
    const p = W.pickWord(pool, DAY, () => 0);
    assert.deepEqual([...p.resets].sort(), ['б', 'г']);       // 6/3 = 2 самых давних
    assert.ok(p.resets.includes(p.word));
    assert.equal(p.word, 'б');
    assert.equal(W.pickWord(pool, DAY, () => 0.99).word, 'г');
  });

  test('исчерпание при малом пуле: минимум одно слово; без включённых — null', () => {
    const one = W.pickWord([row('а', '2026-11-01')], DAY, () => 0.5);
    assert.deepEqual(one, { word: 'а', resets: ['а'] });
    assert.equal(W.pickWord([row('а', null, false)], DAY, () => 0), null);
    assert.equal(W.pickWord([], DAY, () => 0), null);
  });

  test('замена: исключённое слово не выбирается', () => {
    const pool = [row('а'), row('б')];
    for (const r of [0, 0.99]) assert.equal(W.pickWord(pool, DAY, () => r, 'а').word, 'б');
    assert.equal(W.pickWord([row('а')], DAY, () => 0, 'а'), null);
  });

  test('идемпотентность: если слово на день уже есть — оно остаётся, сбросов нет', () => {
    const pool = [row('а'), row('б')];
    for (const r of [0, 0.5, 0.99]) {
      assert.deepEqual(W.planDay('б', pool, DAY, () => r), { word: 'б', created: false, resets: [] });
    }
    const made = W.planDay(null, pool, DAY, () => 0);
    assert.deepEqual(made, { word: 'а', created: true, resets: [] });
    // повтор на уже записанном результате ничего не меняет
    assert.deepEqual(W.planDay(made.word, pool, DAY, () => 0.99).word, made.word);
  });

  test('130 дней подряд: слова не повторяются в окне 60 суток, пока пула хватает', () => {
    const pool = Array.from({ length: 70 }, (_, i) => row('с' + String(i).padStart(2, '0')));
    let day = '2026-01-01';
    const seen = [];
    let n = 7;
    const rnd = () => { n = (n * 48271) % 2147483647; return n / 2147483647; };
    for (let i = 0; i < 130; i++) {
      const p = W.planDay(null, pool, day, rnd);
      const r = pool.find((x) => x.word === p.word);
      for (const w of p.resets) pool.find((x) => x.word === w).last_used = W.shiftDay(day, -61);
      r.last_used = day;
      seen.push(p.word);
      day = W.shiftDay(day, 1);
    }
    // за любые 60 подряд идущих суток слова различны, пока пул (70) больше окна
    for (let i = 0; i + 60 <= seen.length; i++) assert.equal(new Set(seen.slice(i, i + 60)).size, 60);
  });

  test('ответ игрока: пустая строка не считается, слова/подсказки/сдача — считаются', () => {
    assert.equal(W.isAnswered({ guesses: [], tries: 0, hints: 0, gave_up: false }), false);
    assert.equal(W.isAnswered({}), false);
    assert.equal(W.isAnswered({ guesses: [{ w: 'х', r: 5 }] }), true);
    assert.equal(W.isAnswered({ guesses: [], tries: 1 }), true);
    assert.equal(W.isAnswered({ guesses: [], hints: 1 }), true);
    assert.equal(W.isAnswered({ guesses: [], gave_up: true }), true);
  });

  test('секретный заголовок word-auto: совпадение, пустой секрет, чужое значение', () => {
    assert.equal(T.checkSecret('s3cret', 's3cret'), true);
    assert.equal(T.checkSecret('s3creT', 's3cret'), false);
    assert.equal(T.checkSecret('s3cre', 's3cret'), false);
    assert.equal(T.checkSecret(null, 's3cret'), false);
    assert.equal(T.checkSecret('', ''), false);
    assert.equal(T.checkSecret('x', undefined), false);
  });

  console.log(passed + ' passed' + (process.exitCode ? ', есть падения' : ''));
})();
