// ============================================================================
// Игры журнала: судоку, сапёр и flappy.
//
// Правила и генерация — в games-core.js (его же использует Edge Function,
// поэтому сервер может переиграть партию). Здесь только экраны, управление
// пальцем, таймеры, рекорды и рейтинг.
//
// Играть может кто угодно, в том числе гость. Рекорд отправляется только у
// вошедшего студента и только через функцию submit-game-score: напрямую в
// таблицу game_records не пишет никто.
//
// Рекорд: судоку и сапёр — лучшее время (меньше лучше) на каждой сложности,
// flappy — число пройденных труб (больше лучше).
// ============================================================================

'use strict';

const GAMES_FN = 'submit-game-score';

const GAMES_META = {
  sudoku: {
    title: 'Судоку', view: 'sudoku', unit: 'time',
    note: 'заполните поле, 3 ошибки — проигрыш',
    icon: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17"/>'
  },
  minesweeper: {
    title: 'Сапёр', view: 'minesweeper', unit: 'time',
    note: 'найдите все мины, первый ход всегда безопасен',
    icon: '<circle cx="12" cy="13" r="6"/><path d="M12 7V3.5M12 3.5h3M18.5 7.5l2-2M5.5 7.5l-2-2"/>'
  },
  flappy: {
    title: 'Flappy', view: 'flappy', unit: 'pipes',
    note: 'касание — взмах, считаются пройденные трубы',
    icon: '<path d="M4 13.5c0-3.6 2.9-6.5 6.5-6.5h6.5c1.7 0 3 1.3 3 3s-1.3 3-3 3h-2"/><path d="M10.5 10.5h.01"/><path d="M4 13.5c0 3.6 2.9 6.5 6.5 6.5s6.5-2.9 6.5-6.5"/>'
  }
};

// Сложности: у flappy её нет, рекорд один
const GAME_DIFFS = {
  sudoku: ['easy', 'medium', 'hard'],
  minesweeper: ['easy', 'medium', 'hard'],
  flappy: ['none']
};

const DIFF_TITLES = {
  easy: 'Лёгкая', medium: 'Средняя', hard: 'Трудная', none: 'Общий'
};
const DIFF_TITLES_M = { easy: 'Лёгкий', medium: 'Средний', hard: 'Трудный', none: 'Общий' };

const gamesState = {
  records: new Map(),   // 'game:difficulty' → score
  loaded: false,
  loading: null
};

const gameKey = (game, diff) => game + ':' + diff;
const gamesSigned = () => AppState.auth === 'signed' && !!AppState.studentId;

// Время партии в виде 7:05
function gameTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function gameScoreText(game, score) {
  if (score == null) return '—';
  return GAMES_META[game].unit === 'time' ? gameTime(score) : score + ' ' + gamePipeWord(score);
}

function gamePipeWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'труб';
  if (b === 1) return 'труба';
  if (b >= 2 && b <= 4) return 'трубы';
  return 'труб';
}

// ===== Рекорды =====

async function gamesLoadRecords(force) {
  if (!gamesSigned() || typeof sb !== 'object' || !sb) { gamesState.loaded = true; return; }
  if (gamesState.loaded && !force) return;
  if (gamesState.loading) return gamesState.loading;
  gamesState.loading = (async () => {
    try {
      const { data } = await sb.from('game_records')
        .select('game, difficulty, score')
        .eq('student_id', AppState.studentId);
      gamesState.records = new Map((data || []).map((r) => [gameKey(r.game, r.difficulty), r.score]));
    } catch (e) {
      console.error('Рекорды не загрузились:', e);
    }
    gamesState.loaded = true;
    gamesState.loading = null;
  })();
  return gamesState.loading;
}

// Отправка партии на проверку. Сервер пересчитывает её сам и записывает
// рекорд, только если результат действительно достигнут.
async function gamesSubmit(payload) {
  if (!gamesSigned() || !sb) return { skipped: true };
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { skipped: true };
    const res = await fetch(SUPABASE_URL + '/functions/v1/' + GAMES_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(payload)
    });
    const out = await res.json().catch(() => ({}));
    if (out && out.ok) {
      const diff = payload.difficulty || 'none';
      gamesState.records.set(gameKey(payload.game, diff), out.record);
      renderGamesList();
      return out;
    }
    return { error: (out && out.error) || 'server_error' };
  } catch (e) {
    return { error: 'network' };
  }
}

// Правила игр приходят отложенным модулем games-core.js. Если экран открыли
// раньше, чем модуль загрузился, повторяем действие по его событию.
// Возвращает true, если правила уже загружены и можно работать дальше.
// Если нет — откладывает повтор до события и возвращает false.
function withCore(retry) {
  if (window.GamesCore) return true;
  document.addEventListener('games-core-ready', retry, { once: true });
  return false;
}

// ===== Экран со списком игр =====

function renderGamesList() {
  const box = document.getElementById('gamesList');
  if (!box) return;
  const signed = gamesSigned();
  document.getElementById('gamesGuestNote').classList.toggle('d-none', signed);

  box.innerHTML = '';
  Object.keys(GAMES_META).forEach((game) => {
    const meta = GAMES_META[game];
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML =
      '<span class="game-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + meta.icon + '</svg></span>' +
      '<span class="game-main">' +
        '<b class="game-title"></b>' +
        '<small class="game-note"></small>' +
        '<small class="game-rec"></small>' +
      '</span>' +
      '<span class="game-actions">' +
        '<button type="button" class="btn btn-sm btn-primary game-play">Играть</button>' +
        '<button type="button" class="btn btn-sm btn-secondary game-board">Рейтинг</button>' +
      '</span>';
    card.querySelector('.game-title').textContent = meta.title;
    card.querySelector('.game-note').textContent = meta.note;

    const rec = card.querySelector('.game-rec');
    if (!signed) {
      // Гостю про вход сказано один раз сверху экрана — в карточке не повторяем
      rec.remove();
    } else {
      rec.textContent = 'Рекорд: ' + GAME_DIFFS[game].map((d) => {
        const v = gamesState.records.get(gameKey(game, d));
        const name = game === 'minesweeper' ? DIFF_TITLES_M[d] : DIFF_TITLES[d];
        return (d === 'none' ? '' : name + ' ') + gameScoreText(game, v == null ? null : v);
      }).join(' · ');
    }

    card.querySelector('.game-play').addEventListener('click', () => { haptic('selection'); goView(meta.view); });
    card.querySelector('.game-board').addEventListener('click', () => openGameRating(game));
    box.appendChild(card);
  });
}

// ===== Рейтинг =====

let gameRatingOpen = { game: 'sudoku', diff: 'easy' };

// ФИО и инициалы берём из data.json: на сервере в рейтинге лежит только id
function studentName(id) {
  const s = (appData.students || []).find((x) => x.id === id);
  if (!s) return 'Студент';
  return [s.lastName, s.firstName].filter(Boolean).join(' ') || 'Студент';
}

function studentInitials(id) {
  const s = (appData.students || []).find((x) => x.id === id);
  if (!s) return '?';
  return ((s.lastName || '?')[0] + (s.firstName ? s.firstName[0] : '')).toUpperCase();
}

function openGameRating(game) {
  gameRatingOpen = { game, diff: GAME_DIFFS[game][0] };
  document.getElementById('gameRatingTitle').textContent = 'Рейтинг · ' + GAMES_META[game].title;
  renderGameRatingDiffs();
  renderGameRating();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('gameRatingSheet')).show();
}

function renderGameRatingDiffs() {
  const box = document.getElementById('gameRatingDiffs');
  const game = gameRatingOpen.game;
  const diffs = GAME_DIFFS[game];
  box.classList.toggle('d-none', diffs.length < 2);
  box.innerHTML = '';
  diffs.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'games-diff' + (d === gameRatingOpen.diff ? ' active' : '');
    b.textContent = game === 'minesweeper' ? DIFF_TITLES_M[d] : DIFF_TITLES[d];
    b.addEventListener('click', () => { gameRatingOpen.diff = d; renderGameRatingDiffs(); renderGameRating(); });
    box.appendChild(b);
  });
}

// Топ-5 и отдельная строка со своим местом, если его в пятёрке нет
async function renderGameRating() {
  const body = document.getElementById('gameRatingBody');
  const { game, diff } = gameRatingOpen;
  body.innerHTML = '<div class="games-empty">Загружаем…</div>';
  if (!gamesSigned() || !sb) { body.innerHTML = '<div class="games-empty">Войдите, чтобы видеть рейтинг</div>'; return; }

  const asc = GAMES_META[game].unit === 'time';   // время: меньше лучше
  let rows = [];
  try {
    const { data } = await sb.from('game_records')
      .select('student_id, score')
      .eq('game', game).eq('difficulty', diff)
      .order('score', { ascending: asc })
      .limit(100);
    rows = data || [];
  } catch (e) {
    body.innerHTML = '<div class="games-empty">Рейтинг не загрузился</div>';
    return;
  }
  renderBoardRows(body, rows.map((r) => ({ id: r.student_id, value: gameScoreText(game, r.score) })));
}

// Общая отрисовка таблицы: место, аватарка или инициалы, ФИО, результат.
// items — уже отсортированный список { id, value }.
function renderBoardRows(box, items) {
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = '<div class="games-empty">Рекордов пока нет</div>'; return; }

  const me = AppState.studentId;
  const myIndex = items.findIndex((r) => r.id === me);
  const top = items.slice(0, 5);

  const list = document.createElement('div');
  list.className = 'board';
  top.forEach((r, i) => list.appendChild(boardRow(i + 1, r, r.id === me)));
  box.appendChild(list);

  if (myIndex >= 5) {
    const sep = document.createElement('div');
    sep.className = 'board-sep';
    sep.textContent = '…';
    box.appendChild(sep);
    const mine = document.createElement('div');
    mine.className = 'board';
    mine.appendChild(boardRow(myIndex + 1, items[myIndex], true));
    box.appendChild(mine);
  }
}

function boardRow(place, row, isMe) {
  const el = document.createElement('div');
  el.className = 'board-row' + (isMe ? ' is-me' : '');
  el.innerHTML =
    '<span class="board-place"></span>' +
    '<span class="board-ava"></span>' +
    '<span class="board-name"></span>' +
    '<span class="board-score"></span>';
  el.querySelector('.board-place').textContent = place;
  el.querySelector('.board-ava').textContent = studentInitials(row.id);
  el.querySelector('.board-name').textContent = studentName(row.id);
  el.querySelector('.board-score').textContent = row.value;
  return el;
}

// ===== СУДОКУ =====

const sudokuState = {
  diff: 'easy', seed: 0, puzzle: [], solution: [], grid: [], notes: [],
  sel: -1, pencil: false, pencilBtn: null, mistakes: 0, startedAt: 0, done: false, undo: []
};

function sudokuMount() {
  const host = document.getElementById('sudokuHost');
  if (host.dataset.ready) { sudokuRenderAll(); return; }
  host.dataset.ready = '1';
  host.innerHTML =
    '<div class="games-diffs" id="sudokuDiffs"></div>' +
    '<div class="game-bar">' +
      '<span class="game-chip" id="sudokuTime">0:00</span>' +
      '<span class="game-chip" id="sudokuMistakes">Ошибки 0/3</span>' +
      '<button type="button" class="btn btn-sm btn-secondary ms-auto" id="sudokuNew">Новая</button>' +
    '</div>' +
    '<div class="sudoku" id="sudokuGrid"></div>' +
    '<div class="game-msg d-none" id="sudokuMsg"></div>' +
    '<div class="pad" id="sudokuPad"></div>';

  const diffs = document.getElementById('sudokuDiffs');
  GAME_DIFFS.sudoku.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'games-diff';
    b.dataset.diff = d;
    b.textContent = DIFF_TITLES[d];
    b.addEventListener('click', () => sudokuStart(d));
    diffs.appendChild(b);
  });

  const grid = document.getElementById('sudokuGrid');
  for (let i = 0; i < 81; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'sq';
    c.dataset.i = i;
    c.addEventListener('click', () => sudokuSelect(i));
    grid.appendChild(c);
  }

  const pad = document.getElementById('sudokuPad');
  for (let v = 1; v <= 9; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad-key';
    b.textContent = v;
    b.addEventListener('click', () => sudokuPut(v));
    pad.appendChild(b);
  }
  [['Стереть', () => sudokuPut(0)], ['Заметка', () => sudokuTogglePencil()], ['Отмена', () => sudokuUndo()]]
    .forEach(([label, fn]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad-key is-wide';
      b.textContent = label;
      if (label === 'Заметка') sudokuState.pencilBtn = b;   // id не нужен: держим саму кнопку
      b.addEventListener('click', fn);
      pad.appendChild(b);
    });

  document.getElementById('sudokuNew').addEventListener('click', () => sudokuStart(sudokuState.diff));
  sudokuStart(sudokuState.diff);
}

function sudokuStart(diff) {
  if (!withCore(() => sudokuStart(diff))) return;
  const core = window.GamesCore;
  const s = sudokuState;
  s.diff = diff;
  s.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  const gen = core.sudokuGenerate(s.seed, diff);
  s.puzzle = gen.puzzle;
  s.solution = gen.solution;
  s.grid = gen.puzzle.slice();
  s.notes = Array.from({ length: 81 }, () => new Set());
  s.sel = -1;
  s.pencil = false;
  s.mistakes = 0;
  s.done = false;
  s.undo = [];
  s.startedAt = Date.now();
  gameTimerStart('sudoku');
  const msg = document.getElementById('sudokuMsg');
  msg.classList.add('d-none');
  msg.textContent = '';
  sudokuRenderAll();
}

function sudokuTogglePencil() {
  sudokuState.pencil = !sudokuState.pencil;
  if (sudokuState.pencilBtn) sudokuState.pencilBtn.classList.toggle('active', sudokuState.pencil);
  haptic('selection');
}

function sudokuSelect(i) {
  sudokuState.sel = i;
  sudokuRenderAll();
}

function sudokuPut(v) {
  const s = sudokuState;
  if (s.done || s.sel < 0 || s.puzzle[s.sel]) return;
  const i = s.sel;
  s.undo.push({ i, value: s.grid[i], notes: new Set(s.notes[i]) });

  if (s.pencil && v) {
    if (s.notes[i].has(v)) s.notes[i].delete(v); else s.notes[i].add(v);
    sudokuRenderAll();
    return;
  }

  s.notes[i].clear();
  s.grid[i] = v;
  if (v && v !== s.solution[i]) {
    s.mistakes++;
    haptic('error');
    if (s.mistakes >= 3) {
      s.done = true;
      gameTimerStop('sudoku');
      sudokuMessage('Три ошибки — партия проиграна. Нажмите «Новая».');
    }
  } else if (v) {
    haptic('selection');
  }
  sudokuRenderAll();
  if (!s.done && s.grid.every((x, k) => x === s.solution[k])) sudokuWin();
}

function sudokuUndo() {
  const s = sudokuState;
  const step = s.undo.pop();
  if (!step) return;
  s.grid[step.i] = step.value;
  s.notes[step.i] = step.notes;
  sudokuRenderAll();
}

async function sudokuWin() {
  const s = sudokuState;
  s.done = true;
  gameTimerStop('sudoku');
  const seconds = Math.max(1, Math.round((Date.now() - s.startedAt) / 1000));
  haptic('success');
  sudokuMessage('Решено за ' + gameTime(seconds) + (gamesSigned() ? '. Проверяем рекорд…' : '. Войдите, чтобы попасть в рейтинг.'));
  const res = await gamesSubmit({
    game: 'sudoku', difficulty: s.diff, seed: s.seed, seconds, solution: s.grid
  });
  if (res && res.ok) {
    sudokuMessage('Решено за ' + gameTime(seconds) + (res.improved ? ' — новый рекорд!' : '. Прежний рекорд лучше.'));
  } else if (res && res.error) {
    sudokuMessage('Решено за ' + gameTime(seconds) + '. Рекорд не записался (' + res.error + ').');
  }
}

function sudokuMessage(text) {
  const msg = document.getElementById('sudokuMsg');
  msg.textContent = text;
  msg.classList.remove('d-none');
}

function sudokuRenderAll() {
  const s = sudokuState;
  document.querySelectorAll('#sudokuDiffs .games-diff').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === s.diff);
  });
  document.getElementById('sudokuMistakes').textContent = 'Ошибки ' + s.mistakes + '/3';

  const selVal = s.sel >= 0 ? s.grid[s.sel] : 0;
  const selRow = s.sel >= 0 ? Math.floor(s.sel / 9) : -1;
  const selCol = s.sel >= 0 ? s.sel % 9 : -1;
  const selBox = s.sel >= 0 ? Math.floor(selRow / 3) * 3 + Math.floor(selCol / 3) : -1;

  const cells = document.getElementById('sudokuGrid').children;
  for (let i = 0; i < 81; i++) {
    const cell = cells[i];
    const r = Math.floor(i / 9), c = i % 9;
    const box = Math.floor(r / 3) * 3 + Math.floor(c / 3);
    const v = s.grid[i];
    const notes = s.notes[i];

    cell.className = 'sq' +
      (s.puzzle[i] ? ' is-clue' : '') +
      (i === s.sel ? ' is-sel' : '') +
      (r === selRow || c === selCol || box === selBox ? ' is-peer' : '') +
      (v && selVal && v === selVal ? ' is-same' : '') +
      (v && v !== s.solution[i] ? ' is-wrong' : '');

    if (v) {
      cell.textContent = v;
    } else if (notes.size) {
      cell.innerHTML = '<span class="sq-notes">' +
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => '<i>' + (notes.has(n) ? n : '') + '</i>').join('') + '</span>';
    } else {
      cell.textContent = '';
    }
  }
}

// ===== САПЁР =====

const minesState = {
  diff: 'easy', seed: 0, field: null, opened: new Set(), flags: new Set(),
  moves: [], flagMode: false, startedAt: 0, done: false, started: false
};

function minesMount() {
  const host = document.getElementById('minesweeperHost');
  if (host.dataset.ready) { minesRenderAll(); return; }
  host.dataset.ready = '1';
  host.innerHTML =
    '<div class="games-diffs" id="minesDiffs"></div>' +
    '<div class="game-bar">' +
      '<span class="game-chip" id="minesTime">0:00</span>' +
      '<span class="game-chip" id="minesLeft">Мины 0</span>' +
      '<button type="button" class="game-chip is-toggle" id="minesFlagMode" aria-pressed="false">Флажок</button>' +
      '<button type="button" class="btn btn-sm btn-secondary ms-auto" id="minesNew">Новая</button>' +
    '</div>' +
    '<div class="mines-wrap"><div class="mines" id="minesGrid"></div></div>' +
    '<div class="game-msg d-none" id="minesMsg"></div>';

  const diffs = document.getElementById('minesDiffs');
  GAME_DIFFS.minesweeper.forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'games-diff';
    b.dataset.diff = d;
    b.textContent = DIFF_TITLES_M[d];
    b.addEventListener('click', () => minesStart(d));
    diffs.appendChild(b);
  });
  document.getElementById('minesNew').addEventListener('click', () => minesStart(minesState.diff));
  document.getElementById('minesFlagMode').addEventListener('click', () => {
    minesState.flagMode = !minesState.flagMode;
    const btn = document.getElementById('minesFlagMode');
    btn.classList.toggle('active', minesState.flagMode);
    btn.setAttribute('aria-pressed', String(minesState.flagMode));
    haptic('selection');
  });
  minesStart(minesState.diff);
}

function minesStart(diff) {
  if (!withCore(() => minesStart(diff))) return;
  const s = minesState;
  s.diff = diff;
  s.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  s.field = null;
  s.opened = new Set();
  s.flags = new Set();
  s.moves = [];
  s.done = false;
  s.started = false;
  s.startedAt = 0;
  gameTimerStop('mines');
  document.getElementById('minesTime').textContent = '0:00';
  const msg = document.getElementById('minesMsg');
  msg.classList.add('d-none');
  msg.textContent = '';
  minesBuildGrid();
  minesRenderAll();
}

function minesLevel() {
  return window.GamesCore.MINES_LEVELS[minesState.diff];
}

function minesBuildGrid() {
  const level = minesLevel();
  const grid = document.getElementById('minesGrid');
  grid.style.setProperty('--cols', level.cols);
  grid.innerHTML = '';
  const total = level.cols * level.rows;
  for (let i = 0; i < total; i++) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'mine-cell';
    c.dataset.i = i;
    minesBindCell(c, i);
    grid.appendChild(c);
  }
}

// Короткое нажатие — открыть (или аккорд на числе), долгое — флажок.
function minesBindCell(cell, i) {
  let timer = null;
  let longPressed = false;

  const startPress = () => {
    longPressed = false;
    timer = setTimeout(() => { longPressed = true; minesFlag(i); }, 420);
  };
  const endPress = () => { if (timer) { clearTimeout(timer); timer = null; } };

  cell.addEventListener('pointerdown', startPress);
  cell.addEventListener('pointerup', endPress);
  cell.addEventListener('pointerleave', endPress);
  cell.addEventListener('pointercancel', endPress);
  cell.addEventListener('contextmenu', (e) => { e.preventDefault(); minesFlag(i); });
  cell.addEventListener('click', () => {
    if (longPressed) { longPressed = false; return; }
    if (minesState.flagMode) minesFlag(i); else minesTap(i);
  });
}

function minesFlag(i) {
  const s = minesState;
  if (s.done || s.opened.has(i)) return;
  if (s.flags.has(i)) s.flags.delete(i); else s.flags.add(i);
  haptic('selection');
  minesRenderAll();
}

function minesTap(i) {
  const s = minesState;
  if (s.done || s.flags.has(i)) return;
  const core = window.GamesCore;

  if (!s.started) {
    s.started = true;
    s.startedAt = Date.now();
    s.field = core.mineField(s.seed, s.diff, i);
    gameTimerStart('mines');
  }

  if (s.opened.has(i)) {
    // Аккорд: открыть соседей числа, если рядом уже стоит столько же флажков
    const around = core.mineNeighbors(s.field.level, i);
    const flags = around.filter((n) => s.flags.has(n)).length;
    if (s.field.counts[i] <= 0 || flags !== s.field.counts[i]) return;
    s.moves.push({ t: 'chord', i });
    let boom = false;
    around.forEach((n) => {
      if (s.opened.has(n) || s.flags.has(n)) return;
      if (s.field.mines.has(n)) boom = true;
      else core.mineOpen(s.field, s.opened, n);
    });
    if (boom) return minesLose();
    return minesAfterMove();
  }

  s.moves.push({ t: 'open', i });
  if (s.field.mines.has(i)) return minesLose();
  core.mineOpen(s.field, s.opened, i);
  minesAfterMove();
}

function minesAfterMove() {
  const s = minesState;
  minesRenderAll();
  if (s.opened.size === s.field.total - s.field.mines.size) minesWin();
}

function minesLose() {
  const s = minesState;
  s.done = true;
  gameTimerStop('mines');
  haptic('error');
  minesRenderAll(true);
  minesMessage('Мина. Нажмите «Новая».');
}

async function minesWin() {
  const s = minesState;
  s.done = true;
  gameTimerStop('mines');
  const seconds = Math.max(1, Math.round((Date.now() - s.startedAt) / 1000));
  haptic('success');
  minesRenderAll(true);
  minesMessage('Поле разминировано за ' + gameTime(seconds) +
    (gamesSigned() ? '. Проверяем рекорд…' : '. Войдите, чтобы попасть в рейтинг.'));
  const res = await gamesSubmit({
    game: 'minesweeper', difficulty: s.diff, seed: s.seed, seconds, moves: s.moves
  });
  if (res && res.ok) {
    minesMessage('Поле разминировано за ' + gameTime(seconds) + (res.improved ? ' — новый рекорд!' : '. Прежний рекорд лучше.'));
  } else if (res && res.error) {
    minesMessage('Поле разминировано за ' + gameTime(seconds) + '. Рекорд не записался (' + res.error + ').');
  }
}

function minesMessage(text) {
  const msg = document.getElementById('minesMsg');
  msg.textContent = text;
  msg.classList.remove('d-none');
}

function minesRenderAll(reveal) {
  const s = minesState;
  const level = minesLevel();
  document.querySelectorAll('#minesDiffs .games-diff').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === s.diff);
  });
  document.getElementById('minesLeft').textContent = 'Мины ' + Math.max(0, level.mines - s.flags.size);

  const cells = document.getElementById('minesGrid').children;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const open = s.opened.has(i);
    const mine = s.field && s.field.mines.has(i);
    const n = s.field ? s.field.counts[i] : 0;
    cell.className = 'mine-cell' +
      (open ? ' is-open' : '') +
      (s.flags.has(i) ? ' is-flag' : '') +
      (reveal && mine ? ' is-mine' : '') +
      (open && n > 0 ? ' n' + n : '');
    cell.textContent = open && n > 0 ? String(n) : (reveal && mine ? '✳' : (s.flags.has(i) ? '⚑' : ''));
  }
}

// ===== FLAPPY =====

const flappyState = {
  seed: 0, game: null, flaps: [], raf: 0, last: 0, acc: 0,
  running: false, sound: false, best: 0, ctx: null, canvas: null, audio: null
};

function flappyMount() {
  const host = document.getElementById('flappyHost');
  if (host.dataset.ready) { flappyReset(); return; }
  host.dataset.ready = '1';
  host.innerHTML =
    '<div class="game-bar">' +
      '<span class="game-chip" id="flappyScore">0</span>' +
      '<button type="button" class="game-chip is-toggle" id="flappySound" aria-pressed="false">Звук выкл.</button>' +
      '<button type="button" class="btn btn-sm btn-secondary ms-auto" id="flappyNew">Заново</button>' +
    '</div>' +
    '<div class="flappy-wrap no-swipe"><canvas id="flappyCanvas"></canvas>' +
      '<div class="flappy-hint" id="flappyHint">Касание — взмах</div></div>' +
    '<div class="game-msg d-none" id="flappyMsg"></div>';

  flappyState.canvas = document.getElementById('flappyCanvas');
  flappyState.ctx = flappyState.canvas.getContext('2d');

  const flap = (e) => { e.preventDefault(); flappyFlap(); };
  flappyState.canvas.addEventListener('pointerdown', flap);
  document.getElementById('flappyNew').addEventListener('click', () => flappyReset());
  document.getElementById('flappySound').addEventListener('click', () => {
    flappyState.sound = !flappyState.sound;
    const b = document.getElementById('flappySound');
    b.textContent = flappyState.sound ? 'Звук вкл.' : 'Звук выкл.';
    b.classList.toggle('active', flappyState.sound);
    b.setAttribute('aria-pressed', String(flappyState.sound));
  });
  window.addEventListener('resize', flappyResize);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flappyPause(); });

  flappyReset();
}

function flappyResize() {
  const c = flappyState.canvas;
  if (!c) return;
  const core = window.GamesCore;
  const box = c.parentElement.getBoundingClientRect();
  const ratio = core.FLAPPY.height / core.FLAPPY.width;
  const w = Math.max(200, box.width);
  const h = Math.min(w * ratio, Math.round(window.innerHeight * 0.62));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.style.width = Math.round(h / ratio) + 'px';
  c.style.height = Math.round(h) + 'px';
  c.width = Math.round((h / ratio) * dpr);
  c.height = Math.round(h * dpr);
  flappyDraw();
}

function flappyReset() {
  if (!withCore(() => flappyReset())) return;
  const core = window.GamesCore;
  flappyPause();
  flappyState.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  flappyState.game = core.flappyGame(flappyState.seed);
  flappyState.flaps = [];
  flappyState.acc = 0;
  flappyState.last = 0;
  document.getElementById('flappyScore').textContent = '0';
  const msg = document.getElementById('flappyMsg');
  msg.classList.add('d-none');
  msg.textContent = '';
  document.getElementById('flappyHint').classList.remove('d-none');
  flappyResize();
}

function flappyFlap() {
  const s = flappyState;
  if (!s.game) return;
  if (!s.game.alive) { flappyReset(); return; }
  if (!s.running) { flappyStart(); }
  s.pendingFlap = true;
  flappyBeep();
}

function flappyStart() {
  const s = flappyState;
  if (s.running) return;
  s.running = true;
  s.last = performance.now();
  document.getElementById('flappyHint').classList.add('d-none');
  s.raf = requestAnimationFrame(flappyLoop);
}

function flappyPause() {
  const s = flappyState;
  s.running = false;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.raf = 0;
}

// Фиксированный шаг: сколько бы кадров ни рисовал экран, физика считает
// одинаковое число шагов в секунду. На 60 и 120 Гц счёт совпадает.
function flappyLoop(now) {
  const s = flappyState;
  const core = window.GamesCore;
  if (!s.running) return;
  const step = core.FLAPPY.stepMs;
  let dt = now - s.last;
  if (dt > 250) dt = 250;          // вкладка была скрыта — не «догоняем» секундами
  s.last = now;
  s.acc += dt;

  while (s.acc >= step && s.game.alive) {
    const flap = !!s.pendingFlap;
    if (flap) { s.flaps.push(s.game.step); s.pendingFlap = false; }
    s.game.tick(flap);
    s.acc -= step;
  }

  document.getElementById('flappyScore').textContent = String(s.game.score);
  flappyDraw();

  if (!s.game.alive) { flappyPause(); flappyOver(); return; }
  s.raf = requestAnimationFrame(flappyLoop);
}

function flappyDraw() {
  const s = flappyState;
  const core = window.GamesCore;
  if (!s.ctx || !s.game || !core) return;
  const F = core.FLAPPY;
  const ctx = s.ctx;
  const k = s.canvas.width / F.width;

  ctx.setTransform(k, 0, 0, k, 0, 0);
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--color-surface') || '#101014';
  const accent = css.getPropertyValue('--color-accent') || '#0a84ff';
  const text = css.getPropertyValue('--color-text') || '#fff';

  // Небо: мягкий переход от фона к поверхности приложения
  const sky = ctx.createLinearGradient(0, 0, 0, F.height);
  sky.addColorStop(0, bg.trim());
  sky.addColorStop(1, (css.getPropertyValue('--color-surface-2') || bg).trim());
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, F.width, F.height);

  // Трубы: столбики со «шляпками», цвет акцента приложения
  ctx.fillStyle = accent.trim();
  s.game.pipes.forEach((p) => {
    const bottom = p.top + F.gap;
    ctx.fillRect(p.x + 4, 0, F.pipeW - 8, p.top - 10);
    ctx.fillRect(p.x, p.top - 10, F.pipeW, 10);
    ctx.fillRect(p.x, bottom, F.pipeW, 10);
    ctx.fillRect(p.x + 4, bottom + 10, F.pipeW - 8, F.height - bottom - 10);
  });

  // Птица — кружок с клювом, своя графика, без чужих спрайтов
  ctx.fillStyle = text.trim();
  ctx.beginPath();
  ctx.arc(F.birdX, s.game.y, F.birdR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accent.trim();
  ctx.beginPath();
  ctx.moveTo(F.birdX + F.birdR - 2, s.game.y - 2);
  ctx.lineTo(F.birdX + F.birdR + 7, s.game.y + 1);
  ctx.lineTo(F.birdX + F.birdR - 2, s.game.y + 4);
  ctx.closePath();
  ctx.fill();
}

function flappyBeep() {
  const s = flappyState;
  if (!s.sound) return;
  try {
    if (!s.audio) s.audio = new (window.AudioContext || window.webkitAudioContext)();
    const osc = s.audio.createOscillator();
    const gain = s.audio.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.04;
    osc.connect(gain).connect(s.audio.destination);
    osc.start();
    osc.stop(s.audio.currentTime + 0.05);
  } catch (e) {}
}

async function flappyOver() {
  const s = flappyState;
  const score = s.game.score;
  haptic('error');
  const msg = document.getElementById('flappyMsg');
  msg.classList.remove('d-none');
  msg.textContent = 'Пройдено ' + score + ' ' + gamePipeWord(score) +
    (gamesSigned() ? '. Проверяем рекорд…' : '. Войдите, чтобы попасть в рейтинг.');
  if (!score) { msg.textContent = 'Пройдено 0 труб. Касание — взмах.'; return; }

  const res = await gamesSubmit({ game: 'flappy', seed: s.seed, flaps: s.flaps, score });
  if (res && res.ok) {
    msg.textContent = 'Пройдено ' + score + ' ' + gamePipeWord(score) +
      (res.improved ? ' — новый рекорд!' : '. Прежний рекорд лучше.');
  } else if (res && res.error) {
    msg.textContent = 'Пройдено ' + score + ' ' + gamePipeWord(score) + '. Рекорд не записался (' + res.error + ').';
  }
}

// ===== Таймеры игр =====

const gameTimers = {};

function gameTimerStart(name) {
  gameTimerStop(name);
  const started = Date.now();
  const el = document.getElementById(name === 'sudoku' ? 'sudokuTime' : 'minesTime');
  gameTimers[name] = setInterval(() => {
    el.textContent = gameTime((Date.now() - started) / 1000);
  }, 500);
}

function gameTimerStop(name) {
  if (gameTimers[name]) { clearInterval(gameTimers[name]); gameTimers[name] = null; }
}

// ===== Вход в экраны =====

async function openGamesView() {
  renderGamesList();
  await gamesLoadRecords();
  renderGamesList();
}

// Экран мог открыться раньше, чем загрузился этот файл (он подключён в конце
// страницы): если игра уже на экране, поднимаем её сами.
(function gamesBoot() {
  const start = () => {
    const view = (location.hash || '').slice(1);
    if (view === 'games') openGamesView();
    else if (view === 'sudoku') sudokuMount();
    else if (view === 'minesweeper') minesMount();
    else if (view === 'flappy') flappyMount();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // Вход и выход меняют рекорды и доступ к рейтингу
  if (typeof AppState === 'object') AppState.onChange(() => { gamesState.loaded = false; renderGamesList(); });
})();
