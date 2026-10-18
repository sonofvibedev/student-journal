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
  MINES_LEVELS, mineField, minesReplay, mineNeighbors, mineOpen, minesPickLevel,
  FLAPPY, flappyGame, flappySimulate, makeRng,
  SNAKE, snakeGame, snakeSimulate, snakeMoveMs, snakeRun,
  ASSOC, assocNormalize, assocMatch, assocPoints,
  GAME_BADGES, gameBadgesFor
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

console.log('Размеры под экран телефона');

test('клетка сапёра не меньше 28 px и поле влезает целиком', () => {
  // 360x640 за вычетом шапки, панели и отступов — узкое место из задания
  for (const diff of ['easy', 'medium', 'hard']) {
    const pick = minesPickLevel(diff, 328, 520);
    const level = MINES_LEVELS[pick.difficulty];
    assert.ok(pick.cell >= 28, `${diff}: клетка ${pick.cell} меньше 28`);
    assert.ok(pick.cell * level.cols <= 328, `${diff}: поле шире экрана`);
    assert.ok(pick.cell * level.rows <= 520, `${diff}: поле выше экрана`);
  }
});

test('на тесном экране берётся телефонный уровень с тем же процентом мин', () => {
  const pick = minesPickLevel('hard', 320, 420);
  assert.notEqual(pick.difficulty, 'hard', 'остался полный уровень, он не влезает');
  const full = MINES_LEVELS.hard;
  const small = MINES_LEVELS[pick.difficulty];
  const fullShare = full.mines / (full.cols * full.rows);
  const smallShare = small.mines / (small.cols * small.rows);
  assert.ok(Math.abs(fullShare - smallShare) < 0.02,
    `процент мин разошёлся: ${fullShare.toFixed(3)} и ${smallShare.toFixed(3)}`);
  assert.ok(pick.cell >= 28, 'клетка телефонного уровня меньше 28');
});

test('на просторном экране телефонный уровень не подменяет полный', () => {
  for (const diff of ['easy', 'medium', 'hard']) {
    assert.equal(minesPickLevel(diff, 430, 900).difficulty, diff);
  }
});

test('у каждого телефонного уровня есть свой ключ рекорда', () => {
  ['easy_s', 'medium_s', 'hard_s'].forEach((key) => {
    assert.ok(MINES_LEVELS[key], `нет уровня ${key}`);
    assert.ok(MINES_LEVELS[key].minSeconds > 0, `${key}: нет минимального времени`);
  });
});

console.log('Значки за рекорды');

test('значок даётся ровно на пороге и не даётся чуть хуже', () => {
  // Судоку: лёгкая быстрее 5 минут
  assert.deepEqual(gameBadgesFor('sudoku', 'easy', 299), ['game_sudoku_fast']);
  assert.deepEqual(gameBadgesFor('sudoku', 'easy', 300), []);
  // Сапёр: лёгкий быстрее 45 секунд
  assert.deepEqual(gameBadgesFor('minesweeper', 'easy', 44), ['game_mines_steady']);
  assert.deepEqual(gameBadgesFor('minesweeper', 'easy', 45), []);
  // Flappy: 25 труб
  assert.deepEqual(gameBadgesFor('flappy', 'none', 25), ['game_flappy_25']);
  assert.deepEqual(gameBadgesFor('flappy', 'none', 24), []);
});

test('высокий результат во flappy даёт оба значка сразу', () => {
  assert.deepEqual(gameBadgesFor('flappy', 'none', 75).sort(), ['game_flappy_25', 'game_flappy_75']);
  assert.deepEqual(gameBadgesFor('flappy', 'none', 74), ['game_flappy_25']);
});

test('у судоку и сапёра значок только за свою сложность', () => {
  // Время лёгкой сложности не даёт значок средней
  assert.deepEqual(gameBadgesFor('sudoku', 'medium', 299), ['game_sudoku_speed']);
  assert.deepEqual(gameBadgesFor('sudoku', 'hard', 299), ['game_sudoku_master']);
  assert.deepEqual(gameBadgesFor('minesweeper', 'hard', 200), ['game_mines_perfect']);
});

test('телефонное поле сапёра значков не даёт', () => {
  ['easy_s', 'medium_s', 'hard_s'].forEach((d) => {
    assert.deepEqual(gameBadgesFor('minesweeper', d, 1), [], d + ': значок выдан на уменьшенном поле');
  });
});

test('мусор вместо результата значка не даёт', () => {
  assert.deepEqual(gameBadgesFor('sudoku', 'easy', 0), []);
  assert.deepEqual(gameBadgesFor('sudoku', 'easy', -5), []);
  assert.deepEqual(gameBadgesFor('sudoku', 'easy', NaN), []);
  assert.deepEqual(gameBadgesFor('нет такой игры', 'easy', 10), []);
  assert.deepEqual(gameBadgesFor('flappy', 'none', -1), []);
});

test('у каждого значка есть игровые очки и они не учебные', () => {
  const codes = Object.keys(GAME_BADGES);
  assert.equal(codes.length, 20, 'значков должно быть двадцать');
  codes.forEach((code) => {
    assert.ok(code.startsWith('game_'), code + ': код без приставки game_');
    assert.ok(GAME_BADGES[code].points > 0, code + ': нет игровых очков');
  });
});


test('змейка: значки по длине, первый — за первую еду', () => {
  assert.deepEqual(gameBadgesFor('snake', 'none', 3), []);
  assert.deepEqual(gameBadgesFor('snake', 'none', 4), ['game_snake_bite']);
  assert.deepEqual(gameBadgesFor('snake', 'none', 30), ['game_snake_bite', 'game_snake_30']);
  assert.deepEqual(gameBadgesFor('snake', 'none', 60),
    ['game_snake_bite', 'game_snake_30', 'game_snake_60']);
});

test('значки за место в рейтинге по счёту партии не выдаются', () => {
  const byScore = []
    .concat(gameBadgesFor('snake', 'none', 999))
    .concat(gameBadgesFor('flappy', 'none', 999))
    .concat(gameBadgesFor('rank', 'none', 999));
  ['game_snake_top5', 'game_assoc_top5', 'game_player', 'game_all_five',
   'game_three_top5', 'game_five_top5', 'game_assoc_first'].forEach((code) => {
    assert.equal(byScore.includes(code), false, code + ': выдан по счёту партии');
  });
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


console.log('Змейка');

// Повороты для пробной партии: змейка ходит квадратом и ни во что не врезается
const SNAKE_SQUARE = [{ s: 2, d: 2 }, { s: 5, d: 3 }, { s: 8, d: 0 }, { s: 11, d: 1 }];

test('поле влезает в телефон и шаг фиксирован', () => {
  assert.ok(SNAKE.cols >= 10 && SNAKE.cols <= 16, 'столбцов должно быть 10–16');
  assert.ok(SNAKE.rows >= SNAKE.cols, 'поле вытянуто по вертикали');
  assert.ok(SNAKE.minMs > 0 && SNAKE.minMs < SNAKE.baseMs, 'скорость растёт до предела');
});

test('скорость растёт с едой и не уходит ниже предела', () => {
  assert.equal(snakeMoveMs(0), SNAKE.baseMs);
  assert.ok(snakeMoveMs(5) < snakeMoveMs(0));
  assert.equal(snakeMoveMs(10000), SNAKE.minMs);
});

test('начало партии одинаково при одном зерне', () => {
  const a = snakeGame(77), b = snakeGame(77);
  assert.equal(a.cells.length, SNAKE.startLen);
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.food, b.food);
  // Еда не ложится под змейку
  assert.ok(!a.cells.some((c) => c.x === a.food.x && c.y === a.food.y));
});

test('разворот на 180° невозможен', () => {
  const game = snakeGame(5);
  const dir = game.dir;
  const back = (dir + 2) % 4;
  game.tick(back);
  assert.equal(game.dir, dir, 'змейка повернула в себя');
  assert.equal(game.turns.length, 0, 'отклонённый поворот попал в доказательство');
  assert.equal(game.alive, true);
  // И в переигровке тоже: сервер присланный разворот не принимает
  const honest = snakeSimulate(5, []);
  const cheat = snakeSimulate(5, [{ s: 0, d: back }]);
  assert.deepEqual(cheat, honest);
});

test('поворот на 90° принимается и попадает в доказательство', () => {
  const game = snakeGame(5);
  const side = (game.dir + 1) % 4;
  game.tick(side);
  assert.equal(game.dir, side);
  assert.deepEqual(game.turns, [{ s: 0, d: side }]);
});

test('стена и своё тело — конец игры', () => {
  // Без поворотов змейка упирается в стену
  const wall = snakeSimulate(3, []);
  assert.equal(wall.alive, false);
  assert.ok(wall.steps <= SNAKE.cols + SNAKE.rows, 'до стены не дольше размеров поля');

  // Длинная змейка, сложенная в кольцо, бьётся о себя
  const game = snakeGame(9);
  while (game.cells.length < 6 && game.alive) { game.grow(); }
  const d = game.dir;
  game.tick((d + 1) % 4);
  game.tick((d + 2) % 4);
  game.tick((d + 3) % 4);
  game.tick(d);
  assert.equal(game.alive, false, 'змейка прошла сквозь себя');
});

test('после конца игры шаги не считаются', () => {
  const game = snakeGame(3);
  while (game.alive) game.tick(null);
  const steps = game.step, len = game.cells.length;
  game.tick(null); game.tick(null);
  assert.equal(game.step, steps);
  assert.equal(game.cells.length, len);
});

test('повторный прогон по зерну и поворотам даёт тот же результат', () => {
  for (const seed of [1, 77, 20261018]) {
    const a = snakeSimulate(seed, SNAKE_SQUARE);
    const b = snakeSimulate(seed, SNAKE_SQUARE);
    assert.deepEqual(a, b, 'зерно ' + seed + ': результат разошёлся');
  }
});

test('партия из браузера переигрывается по своим же поворотам', () => {
  // Играем «по колонкам»: вниз до края, шаг вправо, вверх до края и так далее
  const game = snakeGame(2026);
  let guard = 0;
  while (game.alive && guard++ < 4000) {
    const head = game.cells[0];
    const dir = game.dir;
    let turn = null;
    if (dir === 2 && head.y >= SNAKE.rows - 1) turn = 1;
    else if (dir === 0 && head.y <= 0) turn = 1;
    else if (dir === 1) turn = head.y <= 0 ? 2 : 0;
    game.tick(turn);
  }
  const replay = snakeSimulate(2026, game.turns);
  assert.equal(replay.len, game.cells.length, 'длина разошлась');
  assert.equal(replay.steps, game.step, 'число шагов разошлось');
  assert.equal(replay.eaten, game.eaten, 'съедено разное число еды');
  assert.ok(game.eaten > 0, 'змейка так и не поела — проверка ничего не стоит');
});

test('одинаковая скорость на 60 и 120 Гц', () => {
  // За одно и то же время должно пройти одно и то же число шагов логики
  const run = (frameMs, frames) => {
    const game = snakeGame(8);
    let acc = 0;
    for (let f = 0; f < frames && game.alive; f++) acc = snakeRun(game, acc, frameMs, null);
    return { step: game.step, len: game.cells.length, alive: game.alive };
  };
  const hz120 = run(1000 / 120, 480);   // 4 секунды
  const hz60  = run(1000 / 60, 240);    // те же 4 секунды
  assert.deepEqual(hz60, hz120, 'разная скорость при разной частоте кадров');
  assert.ok(hz120.step > 0, 'за 4 секунды ни одного шага не сделано');
});

test('провал кадров не прокручивает партию целиком', () => {
  // Вкладка была скрыта полчаса: догонять это время нельзя
  const game = snakeGame(8);
  snakeRun(game, 0, 1800000, null);
  assert.ok(game.step <= Math.ceil(SNAKE.catchUpMs / SNAKE.minMs) + 1, 'догнало слишком много шагов');
});

test('выдуманная длина проверки не проходит', () => {
  const honest = snakeSimulate(2026, SNAKE_SQUARE);
  assert.ok(honest.len < 60, 'пробная партия вдруг оказалась длинной');
  // Мусор в поворотах не даёт ни длины, ни ошибки
  assert.equal(snakeSimulate(2026, null).len >= SNAKE.startLen, true);
  assert.equal(snakeSimulate(2026, [{ s: -5, d: 9 }, { s: 1.5, d: 1 }]).len >= SNAKE.startLen, true);
  // Повороты после смерти ничего не меняют
  const tail = SNAKE_SQUARE.concat([{ s: 100000, d: 1 }]);
  assert.deepEqual(snakeSimulate(2026, tail), honest);
});


console.log('Ассоциации');

test('очки: 6 за первую подсказку, 1 за шестую', () => {
  assert.equal(assocPoints(1, false), 6);
  assert.equal(assocPoints(2, false), 5);
  assert.equal(assocPoints(3, false), 4);
  assert.equal(assocPoints(4, false), 3);
  assert.equal(assocPoints(5, false), 2);
  assert.equal(assocPoints(6, false), 1);
});

test('первая буква стоит одно очко и в минус не уводит', () => {
  assert.equal(assocPoints(1, true), 5);
  assert.equal(assocPoints(5, true), 1);
  assert.equal(assocPoints(6, true), 0);
  // Не угадал — ноль в любом случае
  assert.equal(assocPoints(0, false), 0);
  assert.equal(assocPoints(7, false), 0);
  assert.equal(assocPoints(null, true), 0);
});

test('букву можно открыть только с третьей подсказки', () => {
  assert.equal(ASSOC.letterFromHint, 3);
  assert.equal(ASSOC.hints, 6);
});

test('регистр, ё и пробелы по краям не важны', () => {
  assert.equal(assocNormalize('  ДедЛайн '), 'дедлайн');
  assert.equal(assocNormalize('Ёлка'), 'елка');
  assert.equal(assocNormalize('курсовая   работа'), 'курсовая работа');
  assert.ok(assocMatch('  ДЕДЛАЙН ', ['дедлайн']));
  assert.ok(assocMatch('Зачётка', ['зачетка']));
});

test('множественное число и начальная форма принимаются', () => {
  assert.ok(assocMatch('дедлайны', ['дедлайн']));
  assert.ok(assocMatch('дедлайна', ['дедлайн']));
  assert.ok(assocMatch('конспект', ['конспекты']));
  assert.ok(assocMatch('лекции', ['лекция']));
});

test('в словах от шести букв прощается одна опечатка', () => {
  assert.ok(assocMatch('дедлайм', ['дедлайн']));
  assert.ok(assocMatch('конспкт', ['конспект']));
  // Две опечатки уже не прощаются
  assert.equal(assocMatch('дедлаим', ['дедлайн']), false);
});

test('короткие слова опечаток не прощают', () => {
  assert.equal(assocMatch('кот', ['код']), false);
  assert.equal(assocMatch('пара', ['пары']), true);   // это форма слова, а не опечатка
  assert.equal(assocMatch('парк', ['пара']), false);
});

test('список синонимов принимается целиком', () => {
  const ok = ['дедлайн', 'срок сдачи', 'крайний срок'];
  assert.ok(assocMatch('Крайний Срок', ok));
  assert.ok(assocMatch('срок сдачи', ok));
  assert.equal(assocMatch('пересдача', ok), false);
});

test('пустой и мусорный ответ не проходит', () => {
  assert.equal(assocMatch('', ['дедлайн']), false);
  assert.equal(assocMatch('   ', ['дедлайн']), false);
  assert.equal(assocMatch(null, ['дедлайн']), false);
  assert.equal(assocMatch('дедлайн', []), false);
  assert.equal(assocMatch('дедлайн', null), false);
});

console.log(`\nПроверок пройдено: ${passed}`);
