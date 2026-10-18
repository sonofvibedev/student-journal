// ============================================================================
// Правила игр: судоку, сапёр, flappy, змейка и «Ассоциации».
//
// Файл работает и в браузере (<script type="module">), и в Edge Function на
// Deno: никаких обращений к DOM, никакой случайности кроме генератора по зерну
// (seed). Одно зерно — всегда одна и та же головоломка, одно и то же поле мин,
// одни и те же трубы и одна и та же еда. Поэтому сервер может переиграть партию
// студента и проверить, что результат действительно достигнут.
//
// Браузеру модуль дополнительно кладёт себя в window.GamesCore, чтобы обычные
// (не модульные) скрипты страницы могли им пользоваться.
// ============================================================================

'use strict';

// ===== Генератор случайных чисел по зерну (mulberry32) =====
// Короткий, быстрый и одинаковый в любом движке: только 32-битная арифметика.
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Случайное целое [0, n)
function randInt(rng, n) { return Math.floor(rng() * n) % n; }

// Перемешивание на месте (Фишер — Йетс) — тоже только через rng
function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Зерно из строки: нужно, когда партию начинают «по дате» или по тексту
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ============================================================================
// СУДОКУ
// ============================================================================

// Сколько клеток остаётся открытыми и сколько секунд партия не может быть
// быстрее: поле из 81 клетки руками не заполнить мгновенно.
export const SUDOKU_LEVELS = {
  easy:   { clues: 40, minSeconds: 60,  title: 'Лёгкая' },
  medium: { clues: 32, minSeconds: 120, title: 'Средняя' },
  hard:   { clues: 26, minSeconds: 180, title: 'Трудная' }
};

const SUDOKU_PEERS = buildSudokuPeers();

function buildSudokuPeers() {
  const peers = [];
  for (let i = 0; i < 81; i++) {
    const r = Math.floor(i / 9), c = i % 9;
    const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    const set = new Set();
    for (let k = 0; k < 9; k++) {
      set.add(r * 9 + k);
      set.add(k * 9 + c);
      set.add((br + Math.floor(k / 3)) * 9 + bc + (k % 3));
    }
    set.delete(i);
    peers.push([...set]);
  }
  return peers;
}

// Можно ли поставить v в клетку i, не нарушив правила
export function sudokuAllowed(grid, i, v) {
  const peers = SUDOKU_PEERS[i];
  for (let k = 0; k < peers.length; k++) if (grid[peers[k]] === v) return false;
  return true;
}

// Цифра поставлена в клетку: заметки этой клетки больше не нужны, и та же
// цифра уходит из заметок строки, столбца и блока — подсказка там неверна.
// Возвращает, что именно убрано, чтобы отмена вернула всё одним шагом.
export function sudokuPlaceNotes(notes, i, v) {
  const removed = [];
  if (notes[i] && notes[i].size) {
    removed.push([i, [...notes[i]]]);
    notes[i].clear();
  }
  if (!v) return removed;
  const peers = SUDOKU_PEERS[i];
  for (let k = 0; k < peers.length; k++) {
    const p = peers[k];
    if (notes[p] && notes[p].delete(v)) removed.push([p, [v]]);
  }
  return removed;
}

// Отмена: вернуть заметки ровно те, что убрал sudokuPlaceNotes
export function sudokuRestoreNotes(notes, removed) {
  if (!Array.isArray(removed)) return;
  for (let k = 0; k < removed.length; k++) {
    const [p, digits] = removed[k];
    if (!notes[p]) notes[p] = new Set();
    for (let d = 0; d < digits.length; d++) notes[p].add(digits[d]);
  }
}

// Полностью заполненное решение по зерну
function sudokuFullSolution(rng) {
  const grid = new Array(81).fill(0);
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  function fill(i) {
    if (i === 81) return true;
    const order = shuffle(rng, digits.slice());
    for (let k = 0; k < 9; k++) {
      const v = order[k];
      if (!sudokuAllowed(grid, i, v)) continue;
      grid[i] = v;
      if (fill(i + 1)) return true;
      grid[i] = 0;
    }
    return false;
  }
  fill(0);
  return grid;
}

// Сколько решений у расклада; считаем максимум до limit (обычно 2 — больше
// и не нужно, важен лишь факт «решение не единственное»).
export function sudokuSolutionCount(puzzle, limit = 2) {
  const grid = puzzle.slice();
  let found = 0;
  function step() {
    // Берём клетку с наименьшим числом кандидатов — так перебор не разрастается
    let best = -1, bestOptions = null;
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      const options = [];
      for (let v = 1; v <= 9; v++) if (sudokuAllowed(grid, i, v)) options.push(v);
      if (options.length === 0) return false;
      if (!bestOptions || options.length < bestOptions.length) {
        best = i; bestOptions = options;
        if (options.length === 1) break;
      }
    }
    if (best === -1) { found++; return found >= limit; }
    for (let k = 0; k < bestOptions.length; k++) {
      grid[best] = bestOptions[k];
      if (step()) { grid[best] = 0; return true; }
      grid[best] = 0;
    }
    return false;
  }
  step();
  return found;
}

// Головоломка по зерну: открытые клетки и её единственное решение.
// Клетки убираем парами (i и 80-i), пока решение остаётся единственным.
export function sudokuGenerate(seed, difficulty) {
  const level = SUDOKU_LEVELS[difficulty] || SUDOKU_LEVELS.easy;
  const rng = makeRng(seed);
  const solution = sudokuFullSolution(rng);
  const puzzle = solution.slice();
  let clues = 81;
  const order = shuffle(rng, Array.from({ length: 81 }, (_, i) => i));
  for (let k = 0; k < order.length && clues > level.clues; k++) {
    const i = order[k];
    const j = 80 - i;
    if (!puzzle[i]) continue;
    const saved = [puzzle[i], puzzle[j]];
    puzzle[i] = 0;
    puzzle[j] = 0;
    if (sudokuSolutionCount(puzzle, 2) === 1) {
      clues -= i === j ? 1 : 2;
    } else {
      puzzle[i] = saved[0];
      puzzle[j] = saved[1];
    }
  }
  return { puzzle, solution, clues };
}

// Проверка присланного решения: та же головоломка, те же подсказки,
// все клетки заполнены верно.
export function sudokuVerify(seed, difficulty, filled) {
  if (!Array.isArray(filled) || filled.length !== 81) return false;
  const { puzzle, solution } = sudokuGenerate(seed, difficulty);
  for (let i = 0; i < 81; i++) {
    if (puzzle[i] && filled[i] !== puzzle[i]) return false;
    if (filled[i] !== solution[i]) return false;
  }
  return true;
}

// ============================================================================
// САПЁР
// ============================================================================

// Размеры подобраны так, чтобы на экране 360 px клетка была не меньше 32 px:
// при 9 столбцах клетка ~36 px, при 10 — ~32 px. Больше 10 столбцов не берём.
export const MINES_LEVELS = {
  easy:   { cols: 9,  rows: 9,  mines: 10, minSeconds: 5,  title: 'Лёгкий' },
  medium: { cols: 10, rows: 14, mines: 25, minSeconds: 15, title: 'Средний' },
  hard:   { cols: 10, rows: 18, mines: 40, minSeconds: 30, title: 'Трудный' },
  // Телефонные поля: столько же мин на клетку, но поле влезает в экран целиком.
  // Рекорды считаются отдельно — время на меньшем поле с большим не сравнить.
  easy_s:   { cols: 8,  rows: 8,  mines: 8,  minSeconds: 5,  title: 'Лёгкий', small: 'easy' },
  medium_s: { cols: 9,  rows: 12, mines: 19, minSeconds: 12, title: 'Средний', small: 'medium' },
  hard_s:   { cols: 10, rows: 14, mines: 31, minSeconds: 24, title: 'Трудный', small: 'hard' }
};

// Клетка не мельче MINES_MIN_CELL: иначе по ней не попасть пальцем
export const MINES_MIN_CELL = 28;
const MINES_GAP = 2;              // столько же, сколько gap у .mines в games.css

// Сколько пикселей на клетку даёт место availW × availH
function minesCellSize(level, availW, availH) {
  const w = (availW - MINES_GAP * (level.cols - 1)) / level.cols;
  const h = (availH - MINES_GAP * (level.rows - 1)) / level.rows;
  return Math.floor(Math.min(w, h));
}

// Какой уровень показать на этом экране: обычный, если влезает целиком,
// иначе телефонный — поле меньше, доля мин та же, рекорды отдельные.
export function minesPickLevel(difficulty, availW, availH) {
  const order = [difficulty, difficulty + '_s'];
  for (let k = 0; k < order.length; k++) {
    const level = MINES_LEVELS[order[k]];
    if (!level) continue;
    const cell = minesCellSize(level, availW, availH);
    if (cell >= MINES_MIN_CELL) return { difficulty: order[k], level, cell };
  }
  // Совсем тесный экран: берём телефонный уровень и минимальную клетку —
  // поле придётся прокручивать, но играть можно
  const key = MINES_LEVELS[difficulty + '_s'] ? difficulty + '_s' : difficulty;
  return { difficulty: key, level: MINES_LEVELS[key], cell: MINES_MIN_CELL };
}

// Соседи клетки
export function mineNeighbors(level, index) {
  const { cols, rows } = level;
  const r = Math.floor(index / cols), c = index % cols;
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      out.push(nr * cols + nc);
    }
  }
  return out;
}

// Поле мин по зерну и первому ходу. Первый ход и его соседи всегда пустые,
// поэтому первое нажатие никогда не попадает на мину и сразу открывает область.
export function mineField(seed, difficulty, firstIndex) {
  const level = MINES_LEVELS[difficulty] || MINES_LEVELS.easy;
  const total = level.cols * level.rows;
  const safe = new Set([firstIndex, ...mineNeighbors(level, firstIndex)]);
  const spots = [];
  for (let i = 0; i < total; i++) if (!safe.has(i)) spots.push(i);
  const rng = makeRng(seed);
  shuffle(rng, spots);
  const mines = new Set(spots.slice(0, Math.min(level.mines, spots.length)));
  const counts = new Array(total).fill(0);
  for (let i = 0; i < total; i++) {
    if (mines.has(i)) { counts[i] = -1; continue; }
    counts[i] = mineNeighbors(level, i).filter((n) => mines.has(n)).length;
  }
  return { level, total, mines, counts };
}

// Открыть клетку с «разливом» по пустым: возвращает список открытых клеток
export function mineOpen(field, opened, index) {
  if (opened.has(index)) return [];
  const out = [];
  const stack = [index];
  while (stack.length) {
    const i = stack.pop();
    if (opened.has(i)) continue;
    opened.add(i);
    out.push(i);
    if (field.counts[i] === 0) mineNeighbors(field.level, i).forEach((n) => { if (!opened.has(n)) stack.push(n); });
  }
  return out;
}

// Переигровка партии по ходам. Ходы: { t: 'open' | 'chord', i }.
// Флажки на исход не влияют, поэтому в доказательство их не кладём.
// Возвращает { won, lost, opened }.
export function minesReplay(seed, difficulty, moves) {
  if (!Array.isArray(moves) || !moves.length) return { won: false, lost: false, opened: 0 };
  const first = moves[0];
  if (!first || first.t !== 'open') return { won: false, lost: false, opened: 0 };
  const field = mineField(seed, difficulty, first.i);
  const opened = new Set();
  let lost = false;

  for (let k = 0; k < moves.length && !lost; k++) {
    const m = moves[k];
    if (!m || typeof m.i !== 'number' || m.i < 0 || m.i >= field.total) return { won: false, lost: false, opened: opened.size };
    if (m.t === 'open') {
      if (field.mines.has(m.i)) { lost = true; break; }
      mineOpen(field, opened, m.i);
    } else if (m.t === 'chord') {
      // Аккорд: открыть соседей уже открытого числа
      if (!opened.has(m.i) || field.counts[m.i] <= 0) continue;
      const around = mineNeighbors(field.level, m.i);
      for (let n = 0; n < around.length; n++) {
        const c = around[n];
        if (opened.has(c)) continue;
        if (field.mines.has(c)) { lost = true; break; }
        mineOpen(field, opened, c);
      }
    } else {
      return { won: false, lost: false, opened: opened.size };
    }
  }

  const won = !lost && opened.size === field.total - field.mines.size;
  return { won, lost, opened: opened.size };
}

// ============================================================================
// FLAPPY
// ============================================================================

// Физика считается фиксированным шагом: на 60 и на 120 Гц проходит одинаковое
// число шагов за одну и ту же секунду, поэтому и счёт одинаковый.
export const FLAPPY = {
  stepMs: 1000 / 120,     // один шаг физики
  width: 320,             // игровое поле в условных единицах
  height: 480,
  birdX: 80,
  birdR: 11,
  gravity: 0.0009,        // единиц на мс^2
  flapV: -0.30,           // мгновенная скорость взмаха, единиц на мс
  maxV: 0.6,
  pipeW: 52,
  gap: 132,
  pipeEveryMs: 1500,
  speed: 0.13,            // единиц в мс
  marginY: 60,            // просвет не ближе к краю, чем на столько
  maxSteps: 120 * 60 * 30 // страховка: не больше 30 минут игры
};

// Партия: один и тот же объект крутит и браузер (по шагу за кадр), и сервер
// (в цикле при проверке). Две реализации физики разойтись не могут — она одна.
export function flappyGame(seed) {
  const rng = makeRng(seed);
  return {
    y: FLAPPY.height / 2,
    v: 0,
    score: 0,
    step: 0,
    alive: true,
    pipes: [],
    nextPipeAt: 0,
    // Один шаг физики. flap — был ли на этом шаге взмах.
    tick(flap) {
      if (!this.alive) return this;
      const ms = this.step * FLAPPY.stepMs;

      if (ms >= this.nextPipeAt) {
        const span = FLAPPY.height - FLAPPY.gap - FLAPPY.marginY * 2;
        this.pipes.push({ x: FLAPPY.width + FLAPPY.pipeW, top: FLAPPY.marginY + rng() * span, passed: false });
        this.nextPipeAt += FLAPPY.pipeEveryMs;
      }

      if (flap) this.v = FLAPPY.flapV;
      this.v = Math.min(FLAPPY.maxV, this.v + FLAPPY.gravity * FLAPPY.stepMs);
      this.y += this.v * FLAPPY.stepMs;

      for (let k = 0; k < this.pipes.length; k++) {
        const p = this.pipes[k];
        p.x -= FLAPPY.speed * FLAPPY.stepMs;
        if (!p.passed && p.x + FLAPPY.pipeW < FLAPPY.birdX - FLAPPY.birdR) { p.passed = true; this.score++; }
      }
      while (this.pipes.length && this.pipes[0].x + FLAPPY.pipeW < -FLAPPY.pipeW) this.pipes.shift();

      if (this.y - FLAPPY.birdR <= 0 || this.y + FLAPPY.birdR >= FLAPPY.height) this.alive = false;
      for (let k = 0; k < this.pipes.length && this.alive; k++) {
        const p = this.pipes[k];
        if (FLAPPY.birdX + FLAPPY.birdR < p.x || FLAPPY.birdX - FLAPPY.birdR > p.x + FLAPPY.pipeW) continue;
        if (this.y - FLAPPY.birdR < p.top || this.y + FLAPPY.birdR > p.top + FLAPPY.gap) this.alive = false;
      }

      this.step++;
      return this;
    }
  };
}

// Партия целиком по зерну и номерам шагов со взмахом.
// Возвращает { score, steps, alive }; score — число пройденных труб.
export function flappySimulate(seed, flapSteps, limitSteps) {
  const flaps = new Set((flapSteps || []).map((n) => Math.round(n)));
  const maxStep = Math.min(limitSteps == null ? FLAPPY.maxSteps : limitSteps, FLAPPY.maxSteps);
  const game = flappyGame(seed);
  while (game.alive && game.step <= maxStep) game.tick(flaps.has(game.step));
  return { score: game.score, steps: game.step, alive: game.alive };
}

// ============================================================================
// ЗМЕЙКА
//
// Логика идёт фиксированным шагом: один шаг — один ход змейки. Длительность
// шага зависит только от того, сколько еды съедено, поэтому на 60 и на 120 Гц
// за одну и ту же секунду проходит одно и то же число ходов.
//
// Доказательство партии — зерно и повороты по номерам шагов: партия их
// копит сама (game.turns), сервер прогоняет их через этот же код и получает
// ту же длину. Разворот на 180° отклоняется здесь, в правилах, поэтому ни
// кнопкой, ни подделанным доказательством его не сделать.
// ============================================================================

export const SNAKE = {
  cols: 13,                 // поле целиком влезает в телефон: 13 × 17 клеток
  rows: 17,
  startLen: 3,
  baseMs: 190,              // длительность шага в начале партии
  minMs: 85,                // быстрее уже не разогнаться
  stepDownMs: 4,            // на столько короче шаг за каждую съеденную еду
  catchUpMs: 1000,          // больше секунды за кадр не догоняем (скрытая вкладка)
  maxSteps: 60 * 60 * 60    // страховка: не больше часа игры
};

// Направления: 0 — вверх, 1 — вправо, 2 — вниз, 3 — влево.
// Разворот — это +2 по кругу, поэтому его легко и проверить, и запретить.
export const SNAKE_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// Сколько миллисекунд длится шаг после eaten съеденных кусков
export function snakeMoveMs(eaten) {
  const n = Number.isFinite(eaten) && eaten > 0 ? Math.floor(eaten) : 0;
  return Math.max(SNAKE.minMs, SNAKE.baseMs - n * SNAKE.stepDownMs);
}

// Партия: тот же объект крутит и браузер (по времени кадра), и сервер
// (в цикле при проверке). Две реализации физики разойтись не могут — она одна.
export function snakeGame(seed) {
  const rng = makeRng(seed);
  const cx = Math.floor(SNAKE.cols / 2);
  const cy = Math.floor(SNAKE.rows / 2);
  // Змейка лежит вдоль строки и смотрит вправо: голова первая
  const cells = [];
  for (let i = 0; i < SNAKE.startLen; i++) cells.push({ x: cx - i, y: cy });

  const game = {
    cells,
    dir: 1,
    food: null,
    eaten: 0,
    step: 0,
    alive: true,
    turns: [],              // доказательство: [{ s: номер шага, d: направление }]

    // Занята ли клетка телом. skipTail — хвост, который на этом шаге уйдёт.
    busy(x, y, skipTail) {
      const last = this.cells.length - 1;
      for (let i = 0; i < this.cells.length; i++) {
        if (skipTail && i === last) continue;
        if (this.cells[i].x === x && this.cells[i].y === y) return true;
      }
      return false;
    },

    // Новая еда на свободной клетке. Клетки перебираем по порядку и берём
    // k-ю свободную: один и тот же rng на странице и на сервере даёт одну и
    // ту же клетку. Если свободных нет — еды больше не будет.
    placeFood() {
      const free = SNAKE.cols * SNAKE.rows - this.cells.length;
      if (free <= 0) { this.food = null; return; }
      let k = Math.floor(rng() * free) % free;
      for (let y = 0; y < SNAKE.rows; y++) {
        for (let x = 0; x < SNAKE.cols; x++) {
          if (this.busy(x, y, false)) continue;
          if (k === 0) { this.food = { x, y }; return; }
          k--;
        }
      }
      this.food = null;
    },

    // Удлинить змейку на одну клетку, не двигаясь: нужно только тестам и
    // отладке, в самой игре длина растёт от еды
    grow() {
      const tail = this.cells[this.cells.length - 1];
      this.cells.push({ x: tail.x, y: tail.y });
    },

    // Один ход. turn — направление поворота или null.
    // Разворот на 180° и поворот «туда же, куда и шли» не принимаются и в
    // доказательство не попадают.
    tick(turn) {
      if (!this.alive) return this;

      if (Number.isInteger(turn) && turn >= 0 && turn <= 3 &&
          turn !== this.dir && turn !== (this.dir + 2) % 4) {
        this.dir = turn;
        this.turns.push({ s: this.step, d: turn });
      }

      const [dx, dy] = SNAKE_DIRS[this.dir];
      const head = this.cells[0];
      const nx = head.x + dx, ny = head.y + dy;

      // Стена
      if (nx < 0 || ny < 0 || nx >= SNAKE.cols || ny >= SNAKE.rows) { this.alive = false; return this; }

      const feeds = !!this.food && this.food.x === nx && this.food.y === ny;
      // Своё тело. Хвост на этом шаге уходит — в его клетку войти можно,
      // но только если змейка не растёт.
      if (this.busy(nx, ny, !feeds)) { this.alive = false; return this; }

      this.cells.unshift({ x: nx, y: ny });
      if (feeds) { this.eaten++; this.placeFood(); }
      else this.cells.pop();

      this.step++;
      return this;
    }
  };

  game.placeFood();
  return game;
}

// Прокрутить партию на dtMs миллисекунд реального времени. Возвращает
// остаток времени, который не набрал на целый шаг: его кладут в acc
// следующего кадра. Отсюда и одинаковая скорость при любой частоте кадров.
// takeTurn — функция, которая отдаёт следующий поворот из очереди или null.
export function snakeRun(game, accMs, dtMs, takeTurn) {
  let acc = (Number.isFinite(accMs) ? accMs : 0) +
            Math.min(Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0, SNAKE.catchUpMs);
  while (game.alive) {
    const ms = snakeMoveMs(game.eaten);
    if (acc < ms) break;
    acc -= ms;
    game.tick(takeTurn ? takeTurn() : null);
  }
  return acc;
}

// Партия целиком по зерну и поворотам. Возвращает { len, steps, eaten, alive }.
// len — длина змейки, она же рекорд.
export function snakeSimulate(seed, turns, limitSteps) {
  const byStep = new Map();
  if (Array.isArray(turns)) {
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (!t || !Number.isInteger(t.s) || t.s < 0 || !Number.isInteger(t.d) || t.d < 0 || t.d > 3) continue;
      if (!byStep.has(t.s)) byStep.set(t.s, t.d);
    }
  }
  const maxStep = Math.min(limitSteps == null ? SNAKE.maxSteps : limitSteps, SNAKE.maxSteps);
  const game = snakeGame(seed);
  while (game.alive && game.step <= maxStep) {
    const turn = byStep.has(game.step) ? byStep.get(game.step) : null;
    game.tick(turn);
  }
  return { len: game.cells.length, steps: game.step, eaten: game.eaten, alive: game.alive };
}

// ============================================================================
// АССОЦИАЦИИ
//
// Слово загадано, подсказки открываются по одной. Чем раньше угадал, тем
// больше очков: после первой подсказки — 6, после шестой — 1. Первая буква
// стоит одно очко и доступна с третьей подсказки.
//
// Само слово, подсказки и список допустимых ответов лежат только в базе и
// выдаются Edge Function по одному. Здесь — лишь правила сравнения ответа и
// счёт очков: они нужны обеим сторонам, и тренировке на клиенте тоже.
// ============================================================================

export const ASSOC = {
  hints: 6,           // столько подсказок всего
  letterCost: 1,      // во столько очков обходится открытая первая буква
  letterFromHint: 3,  // букву можно открыть начиная с этой подсказки
  typoFrom: 6         // в словах от стольких букв прощается одна опечатка
};

// Очки за угаданное слово: 6 за первую подсказку, 1 за шестую, минус очко
// за открытую букву. Не угадал — ноль, ниже нуля не уходим.
export function assocPoints(hint, letterUsed) {
  if (!Number.isInteger(hint) || hint < 1 || hint > ASSOC.hints) return 0;
  const base = ASSOC.hints + 1 - hint;
  return Math.max(0, base - (letterUsed ? ASSOC.letterCost : 0));
}

// Приведение ответа к сравнимому виду: регистр, ё, края и лишние пробелы
// внутри не должны решать, угадал человек или нет. Знаки препинания и дефисы
// тоже не считаются: «ко-пи-райт» и «копирайт» — один ответ.
export function assocNormalize(str) {
  return String(str == null ? '' : str)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Окончания от длинных к коротким: нужны, чтобы «дедлайны» и «дедлайна»
// считались тем же словом, что и «дедлайн». Это не морфология, а грубое
// отсечение хвоста — его хватает, потому что сравниваются два варианта
// одного и того же слова, а не любые слова языка.
const ASSOC_ENDINGS = ['ами', 'ями', 'ов', 'ев', 'ей', 'ам', 'ям', 'ах', 'ях',
  'ии', 'ие', 'ия', 'ый', 'ий', 'ой', 'ом', 'ем', 'ую', 'юю',
  'ы', 'и', 'а', 'я', 'у', 'ю', 'е', 'й', 'о'];

// Основа слова: хвост отсекается, если без него остаётся не меньше трёх букв
export function assocStem(word) {
  const w = String(word || '');
  for (let i = 0; i < ASSOC_ENDINGS.length; i++) {
    const end = ASSOC_ENDINGS[i];
    if (w.length - end.length >= 3 && w.endsWith(end)) return w.slice(0, w.length - end.length);
  }
  return w;
}

// Основа каждого слова ответа: «крайние сроки» и «крайний срок» сойдутся
function assocStemPhrase(phrase) {
  return assocNormalize(phrase).split(' ').map(assocStem).join(' ');
}

// Расстояние Левенштейна, но дальше limit не считаем: нужен лишь ответ
// «одна опечатка или больше».
export function assocDistance(a, b, limit = 2) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length];
}

// Подходит ли ответ. accepted — список допустимых ответов слова (сам ответ и
// синонимы). Сравнение идёт по трём ступеням: как есть, по основам слов и —
// для слов от шести букв — с одной опечаткой.
export function assocMatch(answer, accepted) {
  const given = assocNormalize(answer);
  if (!given || !Array.isArray(accepted) || !accepted.length) return false;
  const givenStem = assocStemPhrase(given);

  for (let i = 0; i < accepted.length; i++) {
    const want = assocNormalize(accepted[i]);
    if (!want) continue;
    if (given === want) return true;
    if (givenStem === assocStemPhrase(want)) return true;
    // Опечатка прощается только в длинных словах: в коротких «кот» и «код»
    // это уже другое слово
    if (Math.max(given.length, want.length) >= ASSOC.typoFrom &&
        assocDistance(given, want, 1) <= 1) return true;
  }
  return false;
}

// ============================================================================
// ЗНАЧКИ ЗА РЕКОРДЫ
//
// Очки здесь игровые: они идут только в рейтинг игр и на учебные баллы не
// влияют. Пороги проверены пробными партиями: у судоку и сапёра значок даётся
// за время меньше порога, у flappy — за число труб не меньше порога.
//
// Правила лежат рядом с правилами игр, потому что значок выдаёт сервер в
// submit-game-score сразу после того, как партия переиграна и признана
// честной. Выдать его себе из консоли нельзя.
//
// Телефонные поля сапёра (easy_s и прочие) значков не дают: клеток меньше,
// время там естественно ниже, и один и тот же значок стоил бы разного труда.
// ============================================================================
export const GAME_BADGES = {
  game_sudoku_fast:    { game: 'sudoku', difficulty: 'easy',   under: 300, points: 15 },
  game_sudoku_speed:   { game: 'sudoku', difficulty: 'medium', under: 480, points: 25 },
  game_sudoku_master:  { game: 'sudoku', difficulty: 'hard',   under: 720, points: 40 },
  game_mines_steady:   { game: 'minesweeper', difficulty: 'easy',   under: 45,  points: 15 },
  game_mines_pro:      { game: 'minesweeper', difficulty: 'medium', under: 180, points: 25 },
  game_mines_perfect:  { game: 'minesweeper', difficulty: 'hard',   under: 360, points: 40 },
  game_flappy_25:      { game: 'flappy', difficulty: 'none', atLeast: 25, points: 15 },
  game_flappy_75:      { game: 'flappy', difficulty: 'none', atLeast: 75, points: 40 }
};

// Какие значки заслужены этим результатом. score — секунды или трубы.
export function gameBadgesFor(game, difficulty, score) {
  if (!Number.isFinite(score) || score < 0) return [];
  const out = [];
  for (const code of Object.keys(GAME_BADGES)) {
    const b = GAME_BADGES[code];
    if (b.game !== game || b.difficulty !== difficulty) continue;
    if (b.under != null && score > 0 && score < b.under) out.push(code);
    if (b.atLeast != null && score >= b.atLeast) out.push(code);
  }
  return out;
}

export const GamesCore = {
  makeRng, seedFromString,
  SUDOKU_LEVELS, sudokuGenerate, sudokuSolutionCount, sudokuVerify, sudokuAllowed,
  sudokuPlaceNotes, sudokuRestoreNotes,
  MINES_LEVELS, MINES_MIN_CELL, minesPickLevel, mineField, mineNeighbors, mineOpen, minesReplay,
  FLAPPY, flappyGame, flappySimulate,
  SNAKE, SNAKE_DIRS, snakeMoveMs, snakeGame, snakeRun, snakeSimulate,
  ASSOC, assocPoints, assocNormalize, assocStem, assocDistance, assocMatch,
  GAME_BADGES, gameBadgesFor
};

// Страница может дойти до экрана игры раньше, чем загрузится этот модуль
// (он грузится как module, то есть отложенно). Сообщаем о готовности событием.
// Проверяем именно document: в Edge Runtime (Deno) глобальный window есть,
// а document нет — без этой проверки модуль падал бы при загрузке на сервере.
if (typeof document !== 'undefined') {
  globalThis.GamesCore = GamesCore;
  document.dispatchEvent(new Event('games-core-ready'));
}
