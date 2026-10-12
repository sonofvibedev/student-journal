// Проверки правил игр. Запуск: node tools/test-games.js
//
// Проверяем ровно то, на чём держится честность рекордов:
//   — головоломка судоку имеет единственное решение;
//   — первый ход в сапёре никогда не попадает на мину;
//   — flappy считает одинаково при любой частоте кадров;
//   — подделанный результат не проходит проверку.

import assert from 'node:assert/strict';
import {
  SUDOKU_LEVELS, sudokuGenerate, sudokuSolutionCount, sudokuVerify,
  sudokuPlaceNotes, sudokuRestoreNotes,
  MINES_LEVELS, mineField, minesReplay, mineNeighbors, mineOpen,
  FLAPPY, flappyGame, flappySimulate, makeRng
} from '../games-core.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

console.log('Генератор по зерну');
test('одно зерно — один и тот же ряд чисел', () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

console.log('Судоку');
Object.keys(SUDOKU_LEVELS).forEach((diff) => {
  test(`решение единственное (${diff})`, () => {
    for (const seed of [1, 777, 20261011]) {
      const { puzzle, solution, clues } = sudokuGenerate(seed, diff);
      assert.equal(puzzle.length, 81);
      assert.equal(sudokuSolutionCount(puzzle, 3), 1, `зерно ${seed}: решений не одно`);
      assert.equal(clues, puzzle.filter(Boolean).length);
      // Подсказки совпадают с решением
      puzzle.forEach((v, i) => { if (v) assert.equal(v, solution[i]); });
    }
  });
});

test('одно зерно — одна и та же головоломка', () => {
  const a = sudokuGenerate(5, 'medium');
  const b = sudokuGenerate(5, 'medium');
  assert.deepEqual(a.puzzle, b.puzzle);
});

test('верное решение принимается', () => {
  const { solution } = sudokuGenerate(9, 'easy');
  assert.equal(sudokuVerify(9, 'easy', solution), true);
});

test('подделанное решение не принимается', () => {
  const { solution } = sudokuGenerate(9, 'easy');
  const bad = solution.slice();
  bad[0] = bad[0] === 9 ? 1 : bad[0] + 1;
  assert.equal(sudokuVerify(9, 'easy', bad), false);
  assert.equal(sudokuVerify(9, 'easy', new Array(81).fill(1)), false);
  assert.equal(sudokuVerify(9, 'easy', []), false);
  // Чужое зерно — чужое решение
  assert.equal(sudokuVerify(10, 'easy', solution), false);
});

test('цифра убирает заметки своей клетки, строки, столбца и блока', () => {
  const notes = Array.from({ length: 81 }, () => new Set());
  // Клетка 40 — середина поля: строка 4, столбец 4, центральный блок
  notes[40] = new Set([3, 7]);
  notes[36] = new Set([7, 9]);        // та же строка
  notes[4]  = new Set([7]);           // тот же столбец
  notes[30] = new Set([7, 1]);        // тот же блок
  notes[0]  = new Set([7]);           // ни строка, ни столбец, ни блок — не трогаем

  sudokuPlaceNotes(notes, 40, 7);

  assert.equal(notes[40].size, 0, 'заметки своей клетки не очищены');
  assert.deepEqual([...notes[36]], [9], 'цифра осталась в заметках строки');
  assert.equal(notes[4].has(7), false, 'цифра осталась в заметках столбца');
  assert.deepEqual([...notes[30]], [1], 'цифра осталась в заметках блока');
  assert.deepEqual([...notes[0]], [7], 'тронуты заметки чужой клетки');
});

test('отмена возвращает заметки всех затронутых клеток', () => {
  const notes = Array.from({ length: 81 }, () => new Set());
  notes[40] = new Set([3, 7]);
  notes[36] = new Set([7, 9]);
  notes[4]  = new Set([7]);
  notes[30] = new Set([7, 1]);

  const removed = sudokuPlaceNotes(notes, 40, 7);
  sudokuRestoreNotes(notes, removed);

  assert.deepEqual([...notes[40]].sort(), [3, 7], 'заметки своей клетки не вернулись');
  assert.deepEqual([...notes[36]].sort(), [7, 9], 'заметки строки не вернулись');
  assert.deepEqual([...notes[4]], [7], 'заметки столбца не вернулись');
  assert.deepEqual([...notes[30]].sort(), [1, 7], 'заметки блока не вернулись');
});

test('заметки без этой цифры отмена не раздувает', () => {
  const notes = Array.from({ length: 81 }, () => new Set());
  notes[36] = new Set([9]);
  const removed = sudokuPlaceNotes(notes, 40, 7);
  sudokuRestoreNotes(notes, removed);
  assert.deepEqual([...notes[36]], [9]);
  assert.equal(notes[40].size, 0);
});

console.log('Сапёр');
Object.keys(MINES_LEVELS).forEach((diff) => {
  test(`первый ход безопасен и его соседи пусты (${diff})`, () => {
    const level = MINES_LEVELS[diff];
    const total = level.cols * level.rows;
    for (const seed of [1, 2, 3, 99]) {
      for (const first of [0, 1, total - 1, Math.floor(total / 2)]) {
        const field = mineField(seed, diff, first);
        assert.equal(field.mines.has(first), false, 'мина под первым ходом');
        mineNeighbors(level, first).forEach((n) => assert.equal(field.mines.has(n), false, 'мина рядом с первым ходом'));
        assert.equal(field.mines.size, level.mines);
      }
    }
  });

  test(`поле целиком открывается и партия считается выигранной (${diff})`, () => {
    const level = MINES_LEVELS[diff];
    const total = level.cols * level.rows;
    const field = mineField(7, diff, 0);
    const moves = [{ t: 'open', i: 0 }];
    const opened = new Set();
    mineOpen(field, opened, 0);
    for (let i = 0; i < total; i++) {
      if (field.mines.has(i) || opened.has(i)) continue;
      moves.push({ t: 'open', i });
      mineOpen(field, opened, i);
    }
    const res = minesReplay(7, diff, moves);
    assert.equal(res.won, true);
    assert.equal(res.opened, total - level.mines);
  });

  test(`победа аккордом проходит проверку (${diff})`, () => {
    const level = MINES_LEVELS[diff];
    const total = level.cols * level.rows;
    const first = Math.floor(total / 2);
    const field = mineField(1, diff, first);
    const opened = new Set();
    const flags = new Set();
    const moves = [{ t: 'open', i: first }];
    mineOpen(field, opened, first);

    // Числовая клетка, рядом с которой ещё есть что открывать: ею и добьём
    let chord = -1;
    for (let i = 0; i < total && chord < 0; i++) {
      if (!opened.has(i) || field.counts[i] <= 0) continue;
      if (mineNeighbors(level, i).some((n) => !opened.has(n) && !field.mines.has(n))) chord = i;
    }
    assert.ok(chord >= 0, 'не нашлось клетки для аккорда');
    const around = mineNeighbors(level, chord);
    const keep = new Set(around.filter((n) => !field.mines.has(n)));

    for (let i = 0; i < total; i++) {
      if (field.mines.has(i) || opened.has(i) || keep.has(i)) continue;
      moves.push({ t: 'open', i });
      mineOpen(field, opened, i);
    }
    // Флажки на мины вокруг числа — только так страница разрешает аккорд
    around.forEach((n) => { if (field.mines.has(n)) flags.add(n); });
    assert.equal(around.filter((n) => flags.has(n)).length, field.counts[chord]);

    // Аккорд уходит в доказательство отдельными ходами «открыть»: клетки под
    // флажками в него не попадают, иначе сервер подорвался бы на них
    around.forEach((n) => {
      if (opened.has(n) || flags.has(n)) return;
      moves.push({ t: 'open', i: n });
      mineOpen(field, opened, n);
    });
    assert.equal(opened.size, total - level.mines, 'на странице это победа');

    const res = minesReplay(1, diff, moves);
    assert.equal(res.won, true, 'сервер не признал победу аккордом');
    assert.ok(moves.length <= level.cols * level.rows * 4, 'ходов больше, чем принимает функция');
  });
});

test('ход на мину — проигрыш, рекорд не засчитывается', () => {
  const field = mineField(7, 'easy', 0);
  const mine = [...field.mines][0];
  const res = minesReplay(7, 'easy', [{ t: 'open', i: 0 }, { t: 'open', i: mine }]);
  assert.equal(res.lost, true);
  assert.equal(res.won, false);
});

test('выдуманная последовательность ходов победой не становится', () => {
  assert.equal(minesReplay(7, 'easy', [{ t: 'open', i: 0 }]).won, false);
  assert.equal(minesReplay(7, 'easy', []).won, false);
  assert.equal(minesReplay(7, 'easy', [{ t: 'chord', i: 0 }]).won, false);
  assert.equal(minesReplay(7, 'easy', [{ t: 'open', i: 999 }]).won, false);
});

console.log('Flappy');
test('счёт одинаков на 60 и 120 Гц', () => {
  const seed = 2026;
  const flaps = [];
  for (let s = 0; s < 1200; s += 28) flaps.push(s);

  // 120 Гц: по одному шагу физики на кадр. 60 Гц: по два шага на кадр.
  const run = (perFrame) => {
    const game = flappyGame(seed);
    const set = new Set(flaps);
    let frameSteps = 0;
    while (game.alive && game.step < 5000) {
      for (let k = 0; k < perFrame && game.alive; k++) game.tick(set.has(game.step));
      frameSteps++;
      if (frameSteps > 10000) break;
    }
    return { score: game.score, steps: game.step };
  };
  const a = run(1), b = run(2);
  assert.deepEqual(a, b, 'разный счёт при разной частоте кадров');
  assert.deepEqual(flappySimulate(seed, flaps, 5000), { score: a.score, steps: a.steps, alive: false });
});

test('без взмахов птица падает и счёт нулевой', () => {
  const res = flappySimulate(1, [], 5000);
  assert.equal(res.score, 0);
  assert.equal(res.alive, false);
});

test('выдуманный счёт проверку не проходит', () => {
  const flaps = [];
  for (let s = 0; s < 2400; s += 28) flaps.push(s);
  const honest = flappySimulate(2026, flaps, 20000);
  // Те же взмахи всегда дают тот же счёт — «заявленные» 999 труб недостижимы
  assert.equal(flappySimulate(2026, flaps, 20000).score, honest.score);
  assert.ok(honest.score < 999);
  // Пустой список взмахов большого счёта не даёт
  assert.ok(flappySimulate(2026, [], 20000).score < honest.score + 1);
});

test('шаг физики фиксированный', () => {
  assert.equal(FLAPPY.stepMs, 1000 / 120);
});

console.log(`\nПроверок пройдено: ${passed}`);
