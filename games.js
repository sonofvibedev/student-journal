// ============================================================================
// Игры журнала: судоку, сапёр, flappy и змейка.
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
// flappy — число пройденных труб, змейка — длина (больше лучше).
// Экран самой змейки — в snake.js, он подключён после этого файла.
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
  },
  assoc: {
    title: 'Ассоциации', view: 'words', unit: 'points',
    note: 'угадайте слово по близости',
    icon: '<path d="M7.6 14.6a3.4 3.4 0 01-.6-6.7 4 4 0 017.4-1.4 3.2 3.2 0 014.2 3 3.3 3.3 0 01-3.3 3.3h-1"/><path d="M9.2 14.6h5"/><circle cx="7.4" cy="18.2" r="1.3"/>'
  },
  snake: {
    title: 'Змейка', view: 'snake', unit: 'len',
    note: 'свайп — поворот, рекорд — длина змейки',
    icon: '<path d="M4 7.5h9a3 3 0 010 6H8a3 3 0 000 6h11"/><path d="M17 5.5h.01"/><path d="M14.5 4.5h4.5v3h-4.5z"/>'
  }
};

// Сложности: у flappy её нет, рекорд один
const GAME_DIFFS = {
  sudoku: ['easy', 'medium', 'hard'],
  minesweeper: ['easy', 'medium', 'hard'],
  flappy: ['none'],
  snake: ['none']
};

const DIFF_TITLES = {
  easy: 'Лёгкая', medium: 'Средняя', hard: 'Трудная', none: 'Общий'
};
const DIFF_TITLES_M = { easy: 'Лёгкий', medium: 'Средний', hard: 'Трудный', none: 'Общий' };

const gamesState = {
  records: new Map(),   // 'game:difficulty' → score
  loaded: false,
  loading: null,
  assoc: null,          // «Слово дня»: сыграно ли, очки за месяц, серия
  board: null           // короткий топ-3 общего рейтинга и своё место
};

// ===== Экран игры на весь экран =====
// Игра должна влезать без прокрутки, поэтому высоту берём не из 100vh (он в
// мобильных браузерах считает строку адреса по-своему), а из того, что реально
// доступно: в Telegram это viewportStableHeight, иначе — innerHeight.
// Остальное (безопасные зоны) добирает CSS переменными --app-inset-*.
const GAME_VIEWS = { sudoku: 'sudoku', minesweeper: 'mines', flappy: 'flappy', snake: 'snake' };
let gameViewNow = '';

function gameAvailHeight() {
  const tg = window.Telegram && window.Telegram.WebApp;
  const tgH = tg && tg.initData ? (tg.viewportStableHeight || tg.viewportHeight || 0) : 0;
  return Math.max(320, Math.round(tgH || window.innerHeight || 640));
}

// Пересчитать раскладку открытой игры: высоту экрана и размеры поля
function gameLayout() {
  if (!gameViewNow) return;
  document.documentElement.style.setProperty('--game-h', gameAvailHeight() + 'px');
  if (gameViewNow === 'sudoku') sudokuLayout();
  else if (gameViewNow === 'minesweeper') minesLayout();
  else if (gameViewNow === 'flappy' && typeof flappyResize === 'function') flappyResize();
  else if (gameViewNow === 'snake' && typeof snakeLayout === 'function') snakeLayout();
}

// Вызывает showView при каждом переходе: включает полный экран на играх
function gamesFullscreen(view) {
  const isGame = Object.prototype.hasOwnProperty.call(GAME_VIEWS, view);
  gameViewNow = isGame ? view : '';
  document.body.classList.toggle('game-fs', isGame);
  // Тот же класс на <html>: overscroll-behavior работает только если он стоит
  // и на корневом элементе. Без него Chrome на Android обновлял бы страницу
  // своим встроенным жестом поверх нашего.
  document.documentElement.classList.toggle('game-fs', isGame);
  if (isGame) gameLayout();
  else document.documentElement.style.removeProperty('--game-h');
}

window.addEventListener('resize', gameLayout);
window.addEventListener('orientationchange', () => setTimeout(gameLayout, 120));
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.onEvent) tg.onEvent('viewportChanged', gameLayout);
})();

const gameKey = (game, diff) => game + ':' + diff;
const gamesSigned = () => AppState.auth === 'signed' && !!AppState.studentId;

// Время партии в виде 7:05
function gameTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function gameScoreText(game, score) {
  if (score == null) return '—';
  const unit = GAMES_META[game].unit;
  if (unit === 'time') return gameTime(score);
  if (unit === 'len') return score + ' ' + gameCellWord(score);
  return score + ' ' + gamePipeWord(score);
}

// 1 клетка, 2 клетки, 5 клеток — длина змейки
function gameCellWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'клеток';
  if (b === 1) return 'клетка';
  if (b >= 2 && b <= 4) return 'клетки';
  return 'клеток';
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
    // Вход был, а сессии уже нет: рекорд не уйдёт, и об этом надо сказать,
    // иначе экран молча останется на «Проверяем рекорд…»
    if (!session) return { error: 'signed_out' };
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
      // Значки за рекорд выдал сервер — показываем их тем же всплывающим
      // окном, что и остальные достижения
      if (out.badges && out.badges.length && typeof achNoteServerBadges === 'function') {
        achNoteServerBadges(out.badges);
      }
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

// ===== Экран со списком игр: «Бенто» =====
// Аркада — сетка 2×2 с рекордом на каждой плитке, под ней «Ассоциации» и
// таблица лидеров во всю ширину. Числа досчитываются, плитки появляются по
// очереди; при «уменьшении движения» ни того, ни другого нет.

const ARCADE = ['sudoku', 'minesweeper', 'flappy', 'snake'];

// Последняя сыгранная сложность: её рекорд и показываем на плитке. Судоку и
// сапёр пишут её сюда при начале партии, у остальных сложности нет.
const GAME_DIFF_KEYS = { sudoku: 'sudoku_diff', minesweeper: 'mines_diff' };

function gameLastDiff(game) {
  const key = GAME_DIFF_KEYS[game];
  if (!key) return 'none';
  const saved = lsGet(key, '');
  return saved || GAME_DIFFS[game][0];
}

function gameRecordText(game) {
  const diff = gameLastDiff(game);
  const value = gamesState.records.get(gameKey(game, diff));
  if (value == null) return 'рекорда пока нет';
  const name = GAME_DIFF_KEYS[game]
    ? (game === 'minesweeper' ? DIFF_TITLES_M[diff.replace(/_s$/, '')] : DIFF_TITLES[diff]) + ': '
    : '';
  return name + gameScoreText(game, value);
}

function gameIconHtml(meta) {
  return '<span class="tile-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    meta.icon + '</svg></span>';
}

function renderGamesList() {
  const arcade = document.getElementById('gamesArcade');
  const extra = document.getElementById('gamesExtra');
  if (!arcade || !extra) return;
  const signed = gamesSigned();
  document.getElementById('gamesGuestNote').classList.toggle('d-none', signed);

  arcade.innerHTML = '';
  ARCADE.forEach((game) => {
    const meta = GAMES_META[game];
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.innerHTML = gameIconHtml(meta) +
      '<span class="tile-name"></span>' +
      '<span class="tile-note game-rec"></span>';
    tile.querySelector('.tile-name').textContent = meta.title;
    tile.querySelector('.game-rec').textContent = signed ? gameRecordText(game) : meta.note;
    tile.addEventListener('click', () => { haptic('selection'); goView(meta.view); });
    arcade.appendChild(tile);
  });

  extra.innerHTML = '';
  extra.appendChild(gamesAssocTile(signed));
  extra.appendChild(gamesBoardTile(signed));
  staggerTiles(document.getElementById('viewGames'));
}

// «Ассоциации»: метка «новое», пока «Слово дня» не сыграно, а под ней —
// очки за текущий месяц и серия угаданных дней
function gamesAssocTile(signed) {
  const a = gamesState.assoc || {};
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile wide is-games';
  tile.innerHTML = gameIconHtml(GAMES_META.assoc) +
    (signed && a.pending ? '<span class="tile-flag">новое</span>' : '') +
    '<span class="tile-name">Ассоциации</span>' +
    '<span class="tile-note" id="gamesAssocNote"></span>' +
    (signed ? '<span class="tile-note" id="gamesAssocStreak"></span>' : '');
  tile.querySelector('#gamesAssocNote').textContent = signed
    ? (a.loaded
        ? (a.pending ? 'Слово дня ждёт' : 'Слово дня сыграно') +
          ' · за месяц ' + (a.points || 0) + ' ' + gamePointsWord(a.points || 0)
        : GAMES_META.assoc.note)
    : GAMES_META.assoc.note;
  const streak = tile.querySelector('#gamesAssocStreak');
  if (streak) streak.textContent = a.loaded ? gamesStreakText(a.streak || 0) : '';
  tile.addEventListener('click', () => { haptic('selection'); goView('words'); });
  return tile;
}

function gamesStreakText(days) {
  if (!days) return 'серии пока нет';
  const a = Math.abs(days) % 100, b = a % 10;
  const word = (a > 10 && a < 20) ? 'дней' : (b === 1 ? 'день' : (b >= 2 && b <= 4 ? 'дня' : 'дней'));
  return 'серия: ' + days + ' ' + word + ' подряд';
}

// Таблица лидеров: короткий топ-3 общего рейтинга по игровым очкам и своё
// место. По нажатию открывается полная таблица с вкладками по играм.
function gamesBoardTile(signed) {
  const b = gamesState.board || {};
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile wide';
  const rows = (b.top || []).map((r, i) =>
    '<span class="board-mini-row' + (r.me ? ' is-me' : '') + '">' +
      '<b>' + (i + 1) + '</b><span>' + escapeHtml(r.name) + '</span>' +
      '<i>' + r.points + '</i></span>').join('');
  tile.innerHTML =
    '<span class="tile-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 20h8M12 16v4"/><path d="M6 4h12v4a6 6 0 01-12 0z"/>' +
      '<path d="M6 5H3.5v1.5A3.5 3.5 0 006 10M18 5h2.5v1.5A3.5 3.5 0 0118 10"/></svg></span>' +
    '<span class="tile-name">Таблица лидеров</span>' +
    (signed
      ? (rows ? '<span class="board-mini">' + rows + '</span>' : '<span class="tile-note">рекордов пока нет</span>') +
        '<span class="tile-note">' + (b.place ? 'ваше место: ' + b.place : 'вы ещё не в рейтинге') + '</span>'
      : '<span class="tile-note">войдите, чтобы видеть рейтинг</span>');
  tile.addEventListener('click', () => { haptic('selection'); openGameRating('points'); });
  return tile;
}

// Данные для двух нижних плиток. Всё необязательное: не загрузилось —
// плитки просто покажут короткую подпись.
async function gamesLoadBento() {
  if (!gamesSigned() || !sb) return;

  // «Слово дня»: сыграно ли сегодня. Попытку этот запрос не начинает.
  const assoc = { loaded: true, pending: true, points: 0, streak: 0 };
  try {
    const state = typeof wordsCall === 'function' ? await wordsCall({ action: 'state' }) : null;
    if (state && state.ok) assoc.pending = !state.finished;
  } catch (e) { /* не загрузилось — плитка покажет короткую подпись */ }

  try {
    const { data } = await sb.rpc('rpc_assoc_board');
    const mine = (data || []).find((r) => r.student_id === AppState.studentId);
    if (mine) assoc.points = mine.points;
  } catch (e) { /* рейтинг не загрузился */ }

  assoc.streak = await gamesAssocStreak();
  gamesState.assoc = assoc;

  // Общий рейтинг по игровым очкам: топ-3 и своё место
  const core = window.GamesCore;
  if (core) {
    try {
      const codes = Object.keys(core.GAME_BADGES);
      const points = codes.map((c) => core.GAME_BADGES[c].points);
      const { data } = await sb.rpc('rpc_game_points', { codes, points });
      const rows = data || [];
      const myIndex = rows.findIndex((r) => r.student_id === AppState.studentId);
      gamesState.board = {
        top: rows.slice(0, 3).map((r) => ({
          name: studentName(r.student_id), points: r.points, me: r.student_id === AppState.studentId
        })),
        place: myIndex >= 0 ? myIndex + 1 : 0
      };
    } catch (e) { /* рейтинг не загрузился */ }
  }

  renderGamesList();
}

// Серия: сколько дней подряд, считая сегодняшний или вчерашний, угадано
// «Слово дня». Свои попытки студент видит сам — политика это разрешает.
async function gamesAssocStreak() {
  try {
    const { data } = await sb.from('word_attempts')
      .select('day, solved').eq('student_id', AppState.studentId)
      .eq('solved', true).order('day', { ascending: false }).limit(60);
    const days = new Set((data || []).map((r) => r.day));
    if (!days.size) return 0;

    const cursor = new Date();
    // Сегодня слово могли ещё не сыграть — тогда серию считаем со вчера
    const key = (d) => d.toISOString().slice(0, 10);
    if (!days.has(key(cursor))) cursor.setDate(cursor.getDate() - 1);
    let streak = 0;
    while (days.has(key(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return streak;
  } catch (e) {
    return 0;
  }
}

// ===== Рейтинг =====

// small — телефонное поле сапёра: у него меньше клеток, поэтому рекорды
// считаются отдельно и рядом с полным полем не показываются
let gameRatingOpen = { game: 'sudoku', diff: 'easy', small: false };

// Ключ сложности в базе: у телефонного поля сапёра к нему добавлен _s
function ratingDiffKey() {
  const { game, diff, small } = gameRatingOpen;
  return game === 'minesweeper' && small ? diff + '_s' : diff;
}

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

// Вкладки таблицы лидеров: все игры, «Ассоциации» и общий рейтинг по очкам
const RATING_TABS = [
  { key: 'sudoku', title: 'Судоку' },
  { key: 'minesweeper', title: 'Сапёр' },
  { key: 'flappy', title: 'Flappy' },
  { key: 'snake', title: 'Змейка' },
  { key: 'assoc', title: 'Ассоциации' },
  { key: 'points', title: 'Очки' }
];

const RATING_TITLES = { points: 'Рейтинг · игровые очки', assoc: 'Рейтинг · Ассоциации' };

function openGameRating(game) {
  // Сапёр открываем на том размере поля, на котором студент играл последним
  const small = game === 'minesweeper' && /_s$/.test(minesState.diff);
  const diffs = GAME_DIFFS[game];
  gameRatingOpen = { game, diff: diffs ? diffs[0] : 'none', small };
  document.getElementById('gameRatingTitle').textContent =
    RATING_TITLES[game] || ('Рейтинг · ' + GAMES_META[game].title);
  renderGameRatingTabs();
  renderGameRatingDiffs();
  renderGameRating();
  bootstrap.Modal.getOrCreateInstance(document.getElementById('gameRatingSheet')).show();
}

// Переключение между играми прямо в листе рейтинга: закрывать и открывать
// его заново ради другой игры незачем
function renderGameRatingTabs() {
  const box = document.getElementById('gameRatingGames');
  if (!box) return;
  box.innerHTML = '';
  RATING_TABS.forEach((tab) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'games-diff' + (tab.key === gameRatingOpen.game ? ' active' : '');
    b.textContent = tab.title;
    b.addEventListener('click', () => {
      if (tab.key === gameRatingOpen.game) return;
      haptic('selection');
      openGameRating(tab.key);
    });
    box.appendChild(b);
  });
}

function renderGameRatingDiffs() {
  const box = document.getElementById('gameRatingDiffs');
  const game = gameRatingOpen.game;
  const diffs = GAME_DIFFS[game];
  // У «Ассоциаций» и общего рейтинга очков сложностей нет
  if (!diffs) { box.classList.add('d-none'); box.innerHTML = ''; return; }
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

  // Сапёр: переключатель размера поля. На маленьком поле клеток меньше,
  // поэтому время с полным полем не сравнивается — и рейтинг у них свой.
  if (game === 'minesweeper') {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'games-diff is-size' + (gameRatingOpen.small ? ' active' : '');
    sw.textContent = gameRatingOpen.small ? 'Телефонное поле' : 'Полное поле';
    sw.addEventListener('click', () => {
      gameRatingOpen.small = !gameRatingOpen.small;
      renderGameRatingDiffs();
      renderGameRating();
    });
    box.appendChild(sw);
  }
}

// Топ-5 и отдельная строка со своим местом, если его в пятёрке нет
async function renderGameRating() {
  const body = document.getElementById('gameRatingBody');
  const game = gameRatingOpen.game;
  const diff = ratingDiffKey();
  body.innerHTML = '<div class="games-empty">Загружаем…</div>';
  if (!gamesSigned() || !sb) { body.innerHTML = '<div class="games-empty">Войдите, чтобы видеть рейтинг</div>'; return; }

  if (game === 'points') { await renderGamePointsBoard(body); return; }
  if (game === 'assoc') { await renderAssocBoard(body); return; }

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

// «Ассоциации»: сумма очков за текущий месяц. Считает её rpc_assoc_board,
// и только по текущему месяцу — поэтому 1-го числа рейтинг начинается заново.
async function renderAssocBoard(body) {
  let rows = [];
  try {
    const { data } = await sb.rpc('rpc_assoc_board');
    rows = data || [];
  } catch (e) {
    body.innerHTML = '<div class="games-empty">Рейтинг не загрузился</div>';
    return;
  }
  renderBoardRows(body, rows.map((r) => ({
    id: r.student_id,
    value: r.points + ' ' + gamePointsWord(r.points)
  })));
  const note = document.createElement('p');
  note.className = 'games-note mt-2 mb-0';
  note.textContent = 'Очки за «Слово дня» с 1-го числа этого месяца. Тренировка в рейтинг не идёт.';
  body.appendChild(note);
}

// Рейтинг по игровым очкам: очки дают значки за рекорды, и сколько стоит
// каждый — знает каталог в games-core.js. Он же передаётся в rpc_game_points,
// поэтому наружу уходит только сумма, а не список значков человека.
// К учебным баллам эти очки отношения не имеют.
async function renderGamePointsBoard(body) {
  const core = window.GamesCore;
  if (!core) { body.innerHTML = '<div class="games-empty">Правила игр ещё грузятся</div>'; return; }
  const codes = Object.keys(core.GAME_BADGES);
  const points = codes.map((c) => core.GAME_BADGES[c].points);
  let rows = [];
  try {
    const { data } = await sb.rpc('rpc_game_points', { codes, points });
    rows = data || [];
  } catch (e) {
    body.innerHTML = '<div class="games-empty">Рейтинг не загрузился</div>';
    return;
  }
  renderBoardRows(body, rows.map((r) => ({
    id: r.student_id,
    value: r.points + ' ' + gamePointsWord(r.points)
  })));
}

// 1 очко, 2 очка, 5 очков
function gamePointsWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'очков';
  if (b === 1) return 'очко';
  if (b >= 2 && b <= 4) return 'очка';
  return 'очков';
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
  // Плитка на экране игр показывает рекорд последней сыгранной сложности
  lsSet('sudoku_diff', diff);
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
  sudokuLayout();
}

// Квадратное поле по меньшей стороне свободного места: панель цифр и кнопки
// остаются на том же экране, прокрутки нет.
function sudokuLayout() {
  const host = document.getElementById('sudokuHost');
  if (!host || !host.dataset.ready) return;
  const grid = document.getElementById('sudokuGrid');
  const pad = document.getElementById('sudokuPad');
  const free = gameFreeSpace(host, [grid, pad]);
  if (free.h <= 0) return;

  // Панель цифр — две строки; на тесном экране клавиши ниже, но не меньше 34 px
  let padH = 46;
  let size = Math.min(free.w, free.h - (padH * 2 + 6));
  if (size < 280) {
    padH = Math.max(34, Math.min(46, Math.floor((free.h - 280 - 6) / 2)));
    size = Math.min(free.w, free.h - (padH * 2 + 6));
  }
  size = Math.max(180, Math.floor(size));
  pad.style.setProperty('--pad-h', padH + 'px');
  grid.style.setProperty('--sudoku-size', size + 'px');
}

// Сколько места осталось под поле: высота тела игры минус всё, что в нём
// лежит сверху и снизу (сложности, панель, сообщение), кроме самого поля.
function gameFreeSpace(host, skip) {
  const style = getComputedStyle(host);
  const gap = parseFloat(style.rowGap || style.gap) || 0;
  let used = 0;
  let rows = 0;
  Array.prototype.forEach.call(host.children, (el) => {
    if (el.classList.contains('d-none')) return;
    rows++;
    if (skip.indexOf(el) >= 0) return;
    used += el.offsetHeight;
  });
  return {
    w: Math.floor(host.clientWidth),
    h: Math.floor(host.clientHeight - used - gap * Math.max(0, rows - 1))
  };
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
  const core = window.GamesCore;

  if (s.pencil && v) {
    s.undo.push({ i, value: s.grid[i], notes: new Set(s.notes[i]), removed: [] });
    if (s.notes[i].has(v)) s.notes[i].delete(v); else s.notes[i].add(v);
    sudokuRenderAll();
    return;
  }

  // Настоящая цифра: заметки этой клетки уходят, и та же цифра уходит из
  // заметок строки, столбца и блока. Что убрано — в шаг отмены, чтобы
  // «Отменить» вернуло и цифру, и заметки сразу.
  const removed = core.sudokuPlaceNotes(s.notes, i, v);
  s.undo.push({ i, value: s.grid[i], removed });
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
  if (step.notes) s.notes[step.i] = step.notes;        // шаг карандашом
  window.GamesCore.sudokuRestoreNotes(s.notes, step.removed);
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
  // base — что выбрал игрок (easy/medium/hard), diff — уровень, который влез
  // в экран: на тесном экране это телефонный easy_s/medium_s/hard_s со своим
  // рейтингом. Рекорды разных размеров поля не сравниваются.
  base: 'easy', diff: 'easy', seed: 0, field: null, opened: new Set(), flags: new Set(),
  moves: [], flagMode: false, startedAt: 0, done: false, started: false
};

function minesMount() {
  const host = document.getElementById('minesweeperHost');
  if (host.dataset.ready) { minesRenderAll(); return; }
  host.dataset.ready = '1';
  host.innerHTML =
    '<div class="games-diffs" id="minesDiffs"></div>' +
    '<div class="game-bar">' +
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
  document.getElementById('minesNew').addEventListener('click', () => minesStart(minesState.base));
  document.getElementById('minesFlagMode').addEventListener('click', () => {
    minesState.flagMode = !minesState.flagMode;
    const btn = document.getElementById('minesFlagMode');
    btn.classList.toggle('active', minesState.flagMode);
    btn.setAttribute('aria-pressed', String(minesState.flagMode));
    haptic('selection');
  });
  minesStart(minesState.base);
}

function minesStart(base) {
  if (!withCore(() => minesStart(base))) return;
  const core = window.GamesCore;
  const s = minesState;
  s.base = base.replace(/_s$/, '');
  // Уровень подбираем под экран: сначала полное поле, не влезло — телефонное
  const host = document.getElementById('minesweeperHost');
  const free = host && host.dataset.ready
    ? gameFreeSpace(host, [host.querySelector('.mines-wrap')])
    : { w: 320, h: 480 };
  s.diff = core.minesPickLevel(s.base, free.w, free.h).difficulty;
  lsSet('mines_diff', s.diff);
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
  minesLayout();
}

// Размер клетки — от свободного места; мельче MINES_MIN_CELL не делаем, в
// такой экран поле не влезает и его можно прокрутить.
function minesLayout() {
  const host = document.getElementById('minesweeperHost');
  if (!host || !host.dataset.ready) return;
  const core = window.GamesCore;
  const s = minesState;
  const wrap = host.querySelector('.mines-wrap');
  const free = gameFreeSpace(host, [wrap]);
  if (free.h <= 0) return;

  // Партия ещё не начата — можно переложить её на уровень, который влезает
  if (!s.started) {
    const pick = core.minesPickLevel(s.base, free.w, free.h);
    if (pick.difficulty !== s.diff) {
      s.diff = pick.difficulty;
      minesBuildGrid();
      minesRenderAll();
    }
  }
  const level = minesLevel();
  const cell = Math.max(core.MINES_MIN_CELL, Math.floor(Math.min(
    (free.w - 2 * (level.cols - 1)) / level.cols,
    (free.h - 2 * (level.rows - 1)) / level.rows
  )));
  document.getElementById('minesGrid').style.setProperty('--cell', cell + 'px');
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
  // Долгое нажатие ставит флажок, а не выделяет клетку и не тянет страницу
  cell.addEventListener('touchmove', (e) => { endPress(); if (e.cancelable) e.preventDefault(); }, { passive: false });
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
    // В доказательство партии аккорд уходит отдельными ходами «открыть»:
    // флажки на сервер не передаются, и аккордом он открыл бы в том числе
    // заминированную клетку под флажком — победа не прошла бы проверку.
    let boom = false;
    around.forEach((n) => {
      if (s.opened.has(n) || s.flags.has(n)) return;
      s.moves.push({ t: 'open', i: n });
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
    b.classList.toggle('active', b.dataset.diff === s.base);
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
  running: false, sound: false, best: 0, ctx: null, canvas: null, audio: null,
  wingAt: 0,      // когда был последний взмах — по нему считается фаза крыла
  hurtAt: 0       // когда врезались — столько же держится облачко «ой»
};

// «Уменьшение движения»: взмах, качание и облачко «ой» не анимируются
const flappyCalm = () => window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function flappyMount() {
  const host = document.getElementById('flappyHost');
  if (host.dataset.ready) { flappyReset(); return; }
  host.dataset.ready = '1';
  host.innerHTML =
    '<div class="game-bar">' +
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
  // Свайп по полю не должен ни прокручивать страницу, ни обновлять её
  host.querySelector('.flappy-wrap').addEventListener('touchmove',
    (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
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

// Canvas занимает всё свободное место. Логическая ширина поля постоянна
// (FLAPPY.width), поэтому партия на любом экране идёт одинаково; лишнее место
// по краям закрашивается фоном, а не растягивает игру.
function flappyResize() {
  const c = flappyState.canvas;
  if (!c) return;
  const core = window.GamesCore;
  if (!core) return;
  const box = c.parentElement.getBoundingClientRect();
  const w = Math.max(200, Math.floor(box.width));
  const h = Math.max(200, Math.floor(box.height));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.style.width = w + 'px';
  c.style.height = h + 'px';
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  // Масштаб один по обеим осям: поле не растягивается, остаток уходит в поля
  const scale = Math.min(w / core.FLAPPY.width, h / core.FLAPPY.height);
  flappyState.view = {
    w, h, dpr, scale,
    dx: (w - core.FLAPPY.width * scale) / 2,
    dy: (h - core.FLAPPY.height * scale) / 2
  };
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
  flappyState.wingAt = 0;
  flappyState.hurtAt = 0;
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
  s.wingAt = performance.now();
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

  if (!s.game.alive) { s.hurtAt = performance.now(); flappyDraw(); flappyPause(); flappyOver(); return; }
  s.raf = requestAnimationFrame(flappyLoop);
}

// Цвета закладок — те же три, что у цифр сапёра: не зависят от выбранной темы
const FLAPPY_TAGS = ['#ff5a4f', '#35b37e', '#4c8dff'];

function flappyDraw() {
  const s = flappyState;
  const core = window.GamesCore;
  if (!s.ctx || !s.game || !core) return;
  const F = core.FLAPPY;
  const ctx = s.ctx;
  const view = s.view || { w: F.width, h: F.height, dpr: 1, scale: 1, dx: 0, dy: 0 };
  const css = getComputedStyle(document.documentElement);
  const bg = (css.getPropertyValue('--color-surface') || '#101014').trim();
  const bg2 = (css.getPropertyValue('--color-surface-2') || bg).trim();
  const accent = (css.getPropertyValue('--color-accent') || '#0a84ff').trim();

  // Поля по краям — тем же фоном, чтобы не было пустых полос
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, view.w, view.h);

  // Дальше рисуем в логических единицах поля: 0..F.width и 0..F.height
  const k = view.scale * view.dpr;
  ctx.setTransform(k, 0, 0, k, view.dx * view.dpr, view.dy * view.dpr);

  // Небо: мягкий переход от фона к поверхности приложения
  const sky = ctx.createLinearGradient(0, 0, 0, F.height);
  sky.addColorStop(0, bg);
  sky.addColorStop(1, bg2);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, F.width, F.height);
  flappyDrawPaper(ctx, F, (css.getPropertyValue('--color-separator') || bg2).trim());

  s.game.pipes.forEach((p) => flappyDrawStack(ctx, F, p, accent));
  flappyDrawBird(ctx, F, s);
}

// Фон — лист в линейку: игра живёт в журнале, и поле выглядит как страница
function flappyDrawPaper(ctx, F, line) {
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let y = 40; y < F.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(F.width, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = FLAPPY_TAGS[0];
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(26, 0);
  ctx.lineTo(26, F.height);
  ctx.stroke();
  ctx.restore();
}

// Трубы — стопки учебников: корешки в цветах закладок, сверху и снизу обложка
function flappyDrawStack(ctx, F, pipe, accent) {
  const bottom = pipe.top + F.gap;
  const books = (x, y, h, downward) => {
    if (h <= 0) return;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x + 4, y, F.pipeW - 8, h);
    ctx.globalAlpha = 1;
    // Корешки: полоски поперёк стопки, цвета по кругу
    let i = 0;
    for (let b = 0; b < h - 10; b += 22) {
      const by = downward ? y + b : y + h - b - 22;
      ctx.fillStyle = FLAPPY_TAGS[i % FLAPPY_TAGS.length];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 4, by + 16, F.pipeW - 8, 4);
      ctx.globalAlpha = 1;
      i++;
    }
    // Обложка у просвета — шире стопки, как край книги
    ctx.fillStyle = accent;
    ctx.fillRect(x, downward ? y + h - 10 : y, F.pipeW, 10);
  };
  books(pipe.x, 0, pipe.top, true);
  books(pipe.x, bottom, F.height - bottom, false);
}

// Воробей с рюкзаком: рисуется кодом, без чужих картинок.
// Наклон — от скорости падения, крыло машет после касания, при ударе
// рядом вспыхивает короткое «ой».
function flappyDrawBird(ctx, F, s) {
  const calm = flappyCalm();
  const now = performance.now();
  const y = s.game.y;
  const r = F.birdR;

  // Наклон: вверх на взмахе, вниз на падении. При «уменьшении движения» нет
  const tilt = calm ? 0 : Math.max(-0.4, Math.min(0.9, s.game.v * 1.6));
  // Фаза взмаха: 0 сразу после касания, 1 через 220 мс
  const wing = calm ? 0.5 : Math.min(1, (now - s.wingAt) / 220);
  const wingUp = Math.sin(wing * Math.PI);          // 0 → вверх → 0

  ctx.save();
  ctx.translate(F.birdX, y);
  ctx.rotate(tilt);

  // Рюкзак за спиной: корпус и три закладки
  ctx.fillStyle = '#6b4b2f';
  flappyRound(ctx, -r - 5, -r + 3, 11, r * 1.7, 4);
  for (let i = 0; i < FLAPPY_TAGS.length; i++) {
    ctx.fillStyle = FLAPPY_TAGS[i];
    ctx.fillRect(-r - 4, -r + 6 + i * 5, 9, 3);
  }

  // Тело — тёплая охра
  ctx.fillStyle = '#c88a4a';
  ctx.beginPath();
  ctx.ellipse(0, 0, r + 1, r, 0, 0, Math.PI * 2);
  ctx.fill();
  // Светлая грудка
  ctx.fillStyle = '#e8c89a';
  ctx.beginPath();
  ctx.ellipse(2, 3, r - 3, r - 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Тёмная шапочка воробья
  ctx.fillStyle = '#7a4a24';
  ctx.beginPath();
  ctx.ellipse(-1, -r + 3, r - 2, r - 6, 0, Math.PI, Math.PI * 2);
  ctx.fill();

  // Крыло: поднимается на взмахе
  ctx.save();
  ctx.translate(-2, 1);
  ctx.rotate(-wingUp * 0.9);
  ctx.fillStyle = '#9c6632';
  ctx.beginPath();
  ctx.ellipse(0, 0, r - 1, r - 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Глаз и клюв
  ctx.fillStyle = '#1c1c20';
  ctx.beginPath();
  ctx.arc(r - 5, -3, 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffc83d';
  ctx.beginPath();
  ctx.moveTo(r - 1, -1);
  ctx.lineTo(r + 7, 2);
  ctx.lineTo(r - 1, 5);
  ctx.closePath();
  ctx.fill();
  // Хвост
  ctx.fillStyle = '#9c6632';
  ctx.beginPath();
  ctx.moveTo(-r, -2);
  ctx.lineTo(-r - 9, -6);
  ctx.lineTo(-r - 7, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // «Ой» при столкновении: держится 700 мс и тает
  const hurt = s.hurtAt ? (now - s.hurtAt) / 700 : 2;
  if (hurt < 1) {
    ctx.save();
    ctx.globalAlpha = calm ? 1 : 1 - hurt;
    ctx.translate(F.birdX + r + 6, y - r - (calm ? 8 : 8 + hurt * 10));
    ctx.fillStyle = '#ffffff';
    flappyRound(ctx, 0, -11, 30, 18, 9);
    ctx.fillStyle = '#1c1c20';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ой!', 15, -2);
    ctx.restore();
  }
}

// Прямоугольник со скруглением: roundRect есть не везде, считаем дугами
function flappyRound(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
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
  await gamesLoadBento();
}

// Экран мог открыться раньше, чем загрузился этот файл (он подключён в конце
// страницы): если игра уже на экране, поднимаем её сами.
(function gamesBoot() {
  const start = () => {
    const view = (location.hash || '').slice(1);
    // Ссылка сразу на экран игры: showView успел отработать до загрузки этого
    // файла, поэтому полноэкранный режим включаем сами. Без этого на body не
    // было класса game-fs и жесты страницы оставались включёнными.
    gamesFullscreen(view);
    if (view === 'games') openGamesView();
    else if (view === 'sudoku') sudokuMount();
    else if (view === 'minesweeper') minesMount();
    else if (view === 'flappy') flappyMount();
    else if (view === 'snake' && typeof snakeMount === 'function') snakeMount();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  // Вход и выход меняют рекорды и доступ к рейтингу
  if (typeof AppState === 'object') AppState.onChange(() => { gamesState.loaded = false; renderGamesList(); });
})();
