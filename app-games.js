// «Журнал 2.1»: игры внутри кабинета студента (#/study/games и #/study/games/<игра>).
// Сами игры — прежние файлы games-core.js, games.js, snake.js, words.js: правила и серверная проверка рекордов те же.
// Здесь только оболочка: ленивая загрузка (в кабинет игры не тянутся, пока раздел не открыт), заглушки того, что
// игры ждали от старого журнала (AppState, sb, haptic, goView, лист рейтинга вместо Bootstrap-модалки) и экраны.
// Цвета — только токены темы: games.css (--gm-*) и games2.css (сводит --color-* к --j-*).
'use strict';
(function () {
  if (!window.Cab) return;
  const { h, raw, str } = Cab;
  const SELF = (document.currentScript && document.currentScript.src) || '';
  const VER = (SELF.match(/[?&]v=([\w.-]+)/) || [])[1] || '';
  const asset = (f) => f + (VER ? '?v=' + VER : '');

  // Экраны игр: id секции в разметке старого журнала, подпись и счётчик в шапке
  const GAMES = {
    sudoku: { title: 'Судоку', stat: 'sudokuTime', zero: '0:00', host: 'sudokuHost', mount: () => window.sudokuMount() },
    minesweeper: { title: 'Сапёр', stat: 'minesTime', zero: '0:00', host: 'minesweeperHost', mount: () => window.minesMount() },
    flappy: { title: 'Flappy', stat: 'flappyScore', zero: '0', host: 'flappyHost', mount: () => window.flappyMount() },
    snake: { title: 'Змейка', stat: 'snakeScore', zero: '0', host: 'snakeHost', mount: () => window.snakeMount() },
  };
  const BACK_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

  // ---------- заглушки для игр ----------
  // goView('games') → #/study/games, goView('sudoku') → #/study/games/sudoku
  const goView = (name) => { if (name === 'achievements') return; location.hash = '#/study/games' + (name && name !== 'games' ? '/' + name : ''); };
  const haptic = (kind) => {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (!tg || !tg.initData || !tg.HapticFeedback) return;
    try {
      if (kind === 'success' || kind === 'error') tg.HapticFeedback.notificationOccurred(kind);
      else if (kind === 'selection') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred('light');
    } catch (e) { /* вибро не обязательно */ }
  };
  // lsGet и lsSet игры берут из env.js (они там глобальные). Подменять их нельзя: ими же кабинет хранит тему, акцент и «Что нового»,
  // и после захода в «Игры» выбор темы уходил бы в другой ключ (j2.games.j2_theme), а accent.js читал бы старый.
  const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const appState = { auth: 'signed', studentId: '', onChange() {} };
  const appData = { students: [] };
  let studentsFor = '';

  // Лист рейтинга. Игры зовут bootstrap.Modal.getOrCreateInstance(el).show(); в кабинете Bootstrap нет.
  const sheetApi = (el) => ({
    show() { el.classList.add('open'); const c = el.querySelector('.gm-sheet-close'); if (c) c.focus(); },
    hide() { el.classList.remove('open'); },
  });

  function installShims(ctx) {
    appState.studentId = ctx.student.id;
    Object.assign(window, { AppState: appState, appData, sb: Cab.sb, goView, haptic, escapeHtml, staggerTiles() {} });
    if (!window.bootstrap) window.bootstrap = { Modal: { getOrCreateInstance: sheetApi } };
  }

  // ФИО для таблицы лидеров: на сервере в рейтинге лежит только id. Не загрузилось — «Студент».
  async function loadNames(ctx) {
    if (studentsFor === ctx.group.id) return;
    studentsFor = ctx.group.id;
    try {
      const rows = await Cab.q(Cab.sb.from('students').select('id,last_name,first_name').eq('group_id', ctx.group.id));
      appData.students = rows.map((s) => ({ id: s.id, lastName: s.last_name, firstName: s.first_name }));
    } catch (e) { studentsFor = ''; }
  }

  // ---------- ленивая загрузка ----------
  let loading = null;
  const addScript = (src, module) => new Promise((ok, fail) => {
    const s = document.createElement('script');
    if (module) s.type = 'module';              // games-core.js — ES-модуль: его же импортирует Edge Function
    s.src = asset(src); s.onload = ok; s.onerror = () => fail(new Error('load ' + src));
    document.head.appendChild(s);
  });
  function load(ctx) {
    installShims(ctx);
    if (!loading) {
      loading = (async () => {
        ['games.css', 'games2.css'].forEach((f) => {
          const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = asset(f); document.head.appendChild(l);
        });
        await addScript('games-core.js', true);
        for (const f of ['games.js', 'snake.js', 'words.js']) await addScript(f);
      })().catch((e) => { loading = null; throw e; });
    }
    return loading.then(() => loadNames(ctx));
  }

  // Уход с экрана игры: остановить игру, вернуть страницу в обычный режим
  function stopGames() {
    ['flappyPause', 'snakePause'].forEach((f) => { try { if (typeof window[f] === 'function') window[f](); } catch (e) { /* игра уже стоит */ } });
    ['sudoku', 'minesweeper'].forEach((n) => { try { if (typeof window.gameTimerStop === 'function') window.gameTimerStop(n); } catch (e) { /* таймера нет */ } });
    if (typeof window.gamesFullscreen === 'function') window.gamesFullscreen('');
  }
  window.addEventListener('hashchange', () => { if (!/^#\/study\/games\/(sudoku|minesweeper|flappy|snake)$/.test(location.hash)) stopGames(); });

  // ---------- экраны ----------
  const sheet = () => h`<div class="gm-sheet" id="gameRatingSheet" role="dialog" aria-modal="true" aria-labelledby="gameRatingTitle">
    <div class="gm-sheet-scrim" data-close="1"></div>
    <div class="gm-sheet-body"><div class="gm-sheet-handle" aria-hidden="true"></div>
      <button type="button" class="gm-sheet-close" data-close="1" aria-label="Закрыть">×</button>
      <h2 class="gm-sheet-title" id="gameRatingTitle">Рейтинг</h2>
      <div class="games-diffs is-games" id="gameRatingGames" role="tablist"></div>
      <div class="games-diffs" id="gameRatingDiffs" role="tablist"></div>
      <div id="gameRatingBody"></div></div></div>`;

  async function hub(el, ctx, nav) {
    await load(ctx);
    if (!nav.isCurrent()) return;
    el.innerHTML = str(h`<div class="gm-root">${Cab.top({ href: '#/study', text: 'Учёба' })}<h1 class="cab-title">Игры</h1><p class="cab-sub">Судоку, сапёр, flappy, змейка и «Ассоциации»</p>
      <div id="viewGames"><p class="games-note d-none" id="gamesGuestNote">Войдите, чтобы попасть в рейтинг</p>
      <div class="kicker">Аркада</div><div class="tile-grid" id="gamesArcade"></div><div class="tile-grid mt-3" id="gamesExtra"></div></div>${sheet()}</div>`);
    el.querySelector('#gameRatingSheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) sheetApi(e.currentTarget).hide(); });
    window.gamesFullscreen('');
    window.openGamesView();
  }

  function game(name) {
    const g = GAMES[name];
    return async (el, ctx, nav) => {
      await load(ctx);
      if (!nav.isCurrent()) return;
      el.innerHTML = str(h`<div class="gm-root"><section class="app-view game-screen" aria-labelledby="gmTitle">
        <div class="game-top"><button type="button" class="game-back" onclick="goView('games')" aria-label="К играм">${raw(BACK_ICO)}</button>
          <h1 class="game-name" id="gmTitle">${g.title}</h1><span class="game-stat" id="${g.stat}">${g.zero}</span></div>
        <div class="game-body" id="${g.host}"></div></section></div>`);
      window.gamesFullscreen(name);
      g.mount();
    };
  }

  async function words(el, ctx, nav) {
    await load(ctx);
    if (!nav.isCurrent()) return;
    el.innerHTML = str(h`<div class="gm-root">${Cab.top({ href: '#/study/games', text: 'Игры' })}<h1 class="cab-title">Ассоциации</h1>
      <p class="cab-sub">Слово дня и тренировка</p><div id="viewWords"><div id="wordsHost"></div></div></div>`);
    window.gamesFullscreen('');
    window.wordsMount();
  }

  window.AppGames = { hub, words, game, names: Object.keys(GAMES) };
})();
