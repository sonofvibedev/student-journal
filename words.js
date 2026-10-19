// ============================================================================
// «Ассоциации»: угадай слово по близости.
//
// Загадано существительное. Игрок вводит любые существительные, игра
// отвечает местом слова в рейтинге близости к загаданному: №1 — само
// загаданное слово, чем меньше номер, тем ближе. Попыток сколько угодно.
//
// Ни загаданного слова, ни рейтинга в коде страницы нет: места присылает по
// одному Edge Function word-of-day, она же показывает слово и список ста
// ближайших — только после победы или сдачи.
//
// Два режима: «Слово дня» (одно на всю группу, идёт в месячный рейтинг) и
// «Тренировка» (прошлые слова дня и отдельный набор, в рейтинг не идёт).
// ============================================================================

'use strict';

const WORDS_FN = 'word-of-day';

const wordsState = {
  mode: 'daily',        // daily | train
  daily: null,          // последний ответ сервера по слову дня
  train: null,          // { id, total, guesses, finished, solved, word, near }
  busy: false,
  note: ''              // «не знаю такого слова» и прочие подсказки под полем
};

// Запрос к функции: как и рекорды игр, только для вошедшего студента
async function wordsCall(payload) {
  if (!gamesSigned() || !sb) return { error: 'signed_out' };
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { error: 'signed_out' };
    const res = await fetch(SUPABASE_URL + '/functions/v1/' + WORDS_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(payload)
    });
    return await res.json().catch(() => ({ error: 'server_error' }));
  } catch (e) {
    return { error: 'network' };
  }
}

function wordsMount() {
  const host = document.getElementById('wordsHost');
  if (!host) return;
  if (!host.dataset.ready) {
    host.dataset.ready = '1';
    host.innerHTML =
      '<div class="games-diffs" role="tablist">' +
        '<button type="button" class="games-diff active" id="wordsTabDaily">Слово дня</button>' +
        '<button type="button" class="games-diff" id="wordsTabTrain">Тренировка</button>' +
        '<button type="button" class="games-diff is-size" id="wordsHowBtn">Как играть</button>' +
      '</div>' +
      '<p class="games-note d-none" id="wordsGuestNote">Войдите, чтобы играть в «Ассоциации»</p>' +
      '<div class="words-box" id="wordsBox"></div>';

    document.getElementById('wordsTabDaily').addEventListener('click', () => wordsSetMode('daily'));
    document.getElementById('wordsTabTrain').addEventListener('click', () => wordsSetMode('train'));
    document.getElementById('wordsHowBtn').addEventListener('click', wordsHowTo);
  }
  wordsRender();
  wordsLoad();
}

function wordsSetMode(mode) {
  if (wordsState.mode === mode) return;
  wordsState.mode = mode;
  wordsState.note = '';
  haptic('selection');
  document.getElementById('wordsTabDaily').classList.toggle('active', mode === 'daily');
  document.getElementById('wordsTabTrain').classList.toggle('active', mode === 'train');
  wordsRender();
  wordsLoad();
}

function wordsHowTo() {
  showAlert(
    'Загадано существительное. Вводите любые существительные в начальной форме — ' +
    'игра покажет, какое место занимает ваше слово по близости к загаданному. ' +
    '№1 — само загаданное слово, чем меньше номер, тем ближе. ' +
    'Попыток сколько угодно. ' +
    '«Подсказка» откроет слово ближе вашего лучшего результата, но за неё ' +
    'снимаются очки, «Сдаться» покажет ответ. ' +
    'Очки за «Слово дня»: 100 за первую попытку, по 2 за каждую следующую и ' +
    'по 10 за подсказку, но меньше 10 очков не бывает. Тренировка в рейтинг не идёт.'
  );
}

// Подтянуть состояние режима с сервера
async function wordsLoad(force) {
  const guest = !gamesSigned();
  const note = document.getElementById('wordsGuestNote');
  if (note) note.classList.toggle('d-none', !guest);
  if (guest) { wordsRender(); return; }

  if (wordsState.mode === 'daily') {
    if (wordsState.daily && !force) return;
    wordsState.daily = await wordsCall({ action: 'state' });
  } else {
    if (wordsState.train && !force) return;
    const res = await wordsCall({ action: 'train' });
    wordsState.train = res && res.ok && res.has
      ? { id: res.id, total: res.total, guesses: [], finished: false, solved: false, word: null, near: null }
      : res;
  }
  wordsRender();
}

function wordsRender() {
  const box = document.getElementById('wordsBox');
  if (!box) return;
  if (!gamesSigned()) { box.innerHTML = ''; return; }
  const data = wordsState.mode === 'daily' ? wordsState.daily : wordsState.train;
  if (!data) { box.innerHTML = '<div class="games-empty">Загружаем…</div>'; return; }
  if (data.error) { box.innerHTML = '<div class="games-empty">Не загрузилось (' + escapeHtml(data.error) + ')</div>'; return; }

  box.innerHTML = wordsState.mode === 'daily' ? wordsDailyHtml(data) : wordsTrainHtml(data);
  wordsBind();
  wordsLayout();
}

// Список попыток прокручивается внутри себя, а экран остаётся целым: считаем,
// сколько места осталось под формой, и ограничиваем список этим числом.
// Высоту берём у visualViewport — тогда при открытой клавиатуре список
// ужимается, а поле ввода остаётся на виду.
function wordsLayout() {
  const list = document.querySelector('.word-card.is-list');
  if (!list) return;
  const view = window.visualViewport;
  const avail = view ? view.height : window.innerHeight;
  const top = list.getBoundingClientRect().top;
  // Под списком — таб-бар: он стоит поверх страницы, а место под него
  // держит нижний отступ body. Берём большее из двух, чтобы список не
  // уехал под панель. При открытой клавиатуре таб-бара на экране нет —
  // тогда и вычитать нечего, список просто ужимается.
  const tabbar = document.querySelector('.bottom-tabbar');
  const barH = tabbar ? tabbar.getBoundingClientRect().height : 0;
  const padH = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const under = avail > 420 ? Math.max(barH, padH) : 0;
  list.style.maxHeight = Math.max(120, Math.round(avail - top - under - 8)) + 'px';
}

window.addEventListener('resize', wordsLayout);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', wordsLayout);
  window.visualViewport.addEventListener('scroll', wordsLayout);
}

// Одна строка попытки: место, слово и полоса близости
function wordsRowHtml(guess, total, last) {
  const core = window.GamesCore;
  const color = core ? core.assocBarColor(guess.r) : 'red';
  const share = core ? core.assocBarShare(guess.r, total) : 0.1;
  return '<li class="word-row is-' + color +
      (guess.w === last ? ' is-last' : '') + (guess.h ? ' is-hint' : '') + '">' +
    '<span class="word-row-bar" style="--w:' + Math.round(share * 100) + '%"></span>' +
    '<span class="word-row-word">' + escapeHtml(guess.w) +
      (guess.h ? '<i class="word-row-tag">подсказка</i>' : '') + '</span>' +
    '<span class="word-row-rank">' + guess.r + '</span>' +
  '</li>';
}

// Список попыток: сверху ближайшие
function wordsListHtml(guesses, total, last) {
  if (!guesses.length) {
    return '<div class="games-empty">Введите любое существительное — игра покажет, ' +
      'насколько оно близко к загаданному</div>';
  }
  const sorted = guesses.slice().sort((a, b) => a.r - b.r);
  return '<ol class="word-list">' + sorted.map((g) => wordsRowHtml(g, total, last)).join('') + '</ol>';
}

// Поле ввода, последнее слово и подсказка об ошибке
function wordsFormHtml(state) {
  const last = state.guesses.find((g) => g.w === state.lastWord);
  return '<div class="word-form">' +
      '<div class="word-ask">' +
        '<input type="text" class="form-control" id="wordsAnswer" placeholder="Ваше слово" ' +
          'autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="32" enterkeyhint="send">' +
        '<button type="button" class="btn btn-primary" id="wordsGuess">Ответить</button>' +
      '</div>' +
      (wordsState.note ? '<p class="word-note">' + escapeHtml(wordsState.note) + '</p>' : '') +
      (last ? '<ol class="word-list is-last-row">' + wordsRowHtml(last, state.total, state.lastWord) + '</ol>' : '') +
    '</div>';
}

function wordsStatsHtml(state, showPoints) {
  const core = window.GamesCore;
  const points = core ? core.assocPoints(state.tries + 1, state.hints) : 100;
  return '<div class="word-stats">' +
    '<span>Попыток: <b>' + state.tries + '</b></span>' +
    '<span>Подсказок: <b>' + state.hints + '</b></span>' +
    (showPoints ? '<span class="word-stats-points">Сейчас: <b>' + points + '</b></span>' : '') +
  '</div>';
}

// Итог игры: сколько очков, какое было слово и сто ближайших к нему
function wordsResultHtml(state, withPoints) {
  const title = state.solved
    ? 'Угадано за ' + state.tries + ' ' + wordsTryWord(state.tries) +
      (withPoints ? ' · +' + state.points + ' ' + gamePointsWord(state.points) : '')
    : 'Не угадано';
  return '<div class="word-result' + (state.solved ? ' is-win' : '') + '">' + title + '</div>' +
    '<p class="word-answer">Загаданное слово: <b>' + escapeHtml(state.word || '') + '</b></p>' +
    (state.near && state.near.length
      ? '<details class="word-near"><summary>100 самых близких слов</summary>' +
        '<ol class="word-near-list">' + state.near.map((w) =>
          '<li>' + escapeHtml(w) + '</li>').join('') + '</ol></details>'
      : '');
}

function wordsTryWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'попыток';
  if (b === 1) return 'попытку';
  if (b >= 2 && b <= 4) return 'попытки';
  return 'попыток';
}

function wordsDailyHtml(d) {
  if (!d.has) {
    return '<div class="games-empty">Слово на сегодня ещё не задано. Загляните позже.</div>';
  }
  if (d.old) {
    return '<div class="games-empty">Сегодняшнее слово вы уже сыграли по прежним правилам. ' +
      'Новая игра будет завтра, а пока можно потренироваться.</div>' +
      '<button type="button" class="btn btn-secondary w-100 mt-3" id="wordsToTrain">В тренировку</button>';
  }

  const state = Object.assign({}, d, { lastWord: d.last });
  if (d.finished) {
    return '<div class="word-card">' + wordsResultHtml(state, true) +
      wordsStatsHtml(state, false) +
      '<p class="word-lead">Следующее слово — завтра. Пока можно потренироваться.</p>' +
      '<button type="button" class="btn btn-secondary w-100" id="wordsToTrain">В тренировку</button>' +
    '</div>' +
    '<div class="word-card is-list">' + wordsListHtml(d.guesses, d.total, d.last) + '</div>';
  }

  return '<div class="word-card">' +
      wordsFormHtml(state) +
      wordsStatsHtml(state, true) +
      '<div class="word-acts">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="wordsHint">Подсказка</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="wordsGiveUp">Сдаться</button>' +
      '</div>' +
    '</div>' +
    '<div class="word-card is-list">' + wordsListHtml(d.guesses, d.total, d.last) + '</div>';
}

function wordsTrainHtml(t) {
  if (!t.id && t.has === false) {
    return '<div class="games-empty">Тренировочных слов пока нет. ' +
      'Они появятся, когда сыграется первое «Слово дня».</div>';
  }

  const state = Object.assign({}, t, {
    tries: t.guesses.filter((g) => !g.h).length,
    hints: t.guesses.filter((g) => g.h).length
  });
  if (t.finished) {
    return '<div class="word-card">' + wordsResultHtml(state, false) +
      wordsStatsHtml(state, false) +
      '<button type="button" class="btn btn-primary w-100" id="wordsNext">Следующее слово</button>' +
    '</div>' +
    '<div class="word-card is-list">' + wordsListHtml(t.guesses, t.total, t.lastWord) + '</div>';
  }

  return '<div class="word-card">' +
      wordsFormHtml(state) +
      wordsStatsHtml(state, false) +
      '<div class="word-acts">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="wordsGiveUp">Сдаться</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="wordsNext">Другое слово</button>' +
      '</div>' +
      '<p class="word-lead">Тренировка в рейтинг не идёт.</p>' +
    '</div>' +
    '<div class="word-card is-list">' + wordsListHtml(t.guesses, t.total, t.lastWord) + '</div>';
}

function wordsBind() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('wordsGuess', () => wordsGuess());
  on('wordsHint', () => wordsHint());
  on('wordsGiveUp', () => wordsGiveUp());
  on('wordsNext', () => { wordsState.note = ''; wordsLoad(true); });
  on('wordsToTrain', () => wordsSetMode('train'));

  const input = document.getElementById('wordsAnswer');
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') wordsGuess(); });
    // Клавиатура телефона не должна закрывать поле: после её появления
    // подводим поле к видимой части экрана
    input.addEventListener('focus', () => {
      setTimeout(() => { wordsLayout(); input.scrollIntoView({ block: 'nearest' }); }, 250);
    });
  }
}

// Слово из поля ввода
async function wordsGuess() {
  if (wordsState.busy) return;
  const input = document.getElementById('wordsAnswer');
  const word = input ? input.value.trim() : '';
  if (!word) { if (input) input.focus(); return; }
  wordsState.busy = true;
  wordsState.note = '';

  const res = wordsState.mode === 'daily'
    ? await wordsCall({ action: 'guess', word })
    : await wordsCall({ action: 'train_guess', id: wordsState.train.id, word });
  wordsState.busy = false;

  if (!res || res.error) { wordsState.note = 'Не отправилось, попробуйте ещё раз'; wordsRender(); return; }

  if (res.unknown) {
    wordsState.note = 'Не знаю такого слова. Введите существительное в начальной форме.';
    haptic('error');
    wordsRender();
    wordsFocus(word);
    return;
  }
  if (res.repeat) {
    wordsState.note = 'Это слово уже было';
    haptic('light');
    if (wordsState.mode === 'daily') wordsState.daily = Object.assign({}, res, { last: res.repeat });
    else wordsState.train.lastWord = res.repeat;
    wordsRender();
    wordsFocus('');
    return;
  }

  if (wordsState.mode === 'daily') {
    wordsState.daily = res;
    if (res.solved) {
      haptic('success');
      if (res.badges && res.badges.length && typeof achNoteServerBadges === 'function') {
        achNoteServerBadges(res.badges);
      }
    } else { haptic('light'); }
    wordsRender();
    if (!res.finished) wordsFocus('');
    return;
  }

  // Тренировка: счёт страница ведёт сама, сервер присылает только место
  const t = wordsState.train;
  t.guesses = t.guesses.concat([{ w: res.word, r: res.rank }]);
  t.lastWord = res.word;
  t.total = res.total || t.total;
  if (res.solved) {
    t.finished = true; t.solved = true; t.word = res.word; t.near = res.near;
    haptic('success');
  } else { haptic('light'); }
  wordsRender();
  if (!t.finished) wordsFocus('');
}

// Поле ввода после ответа: очистить и вернуть курсор
function wordsFocus(keep) {
  const input = document.getElementById('wordsAnswer');
  if (!input) return;
  input.value = keep || '';
  input.focus({ preventScroll: true });
  if (keep) input.select();
}

async function wordsHint() {
  if (wordsState.busy || wordsState.mode !== 'daily') return;
  wordsState.busy = true;
  wordsState.note = '';
  const res = await wordsCall({ action: 'hint' });
  wordsState.busy = false;
  if (res && res.ok) {
    if (res.no_hint) wordsState.note = 'Ближе уже некуда — все слова рядом названы';
    else haptic('selection');
    wordsState.daily = res;
  }
  wordsRender();
}

async function wordsGiveUp() {
  if (wordsState.busy) return;
  const ok = await showConfirm('Показать загаданное слово? Очков за сегодня не будет.');
  if (!ok) return;
  wordsState.busy = true;
  wordsState.note = '';

  if (wordsState.mode === 'daily') {
    const res = await wordsCall({ action: 'giveup' });
    wordsState.busy = false;
    if (res && res.ok) wordsState.daily = res;
    haptic('error');
    wordsRender();
    return;
  }

  const t = wordsState.train;
  const res = await wordsCall({ action: 'train_give', id: t.id });
  wordsState.busy = false;
  if (res && res.ok) {
    t.finished = true; t.solved = false; t.word = res.word; t.near = res.near;
  }
  haptic('error');
  wordsRender();
}

// Вход и выход меняют доступ к игре
(function wordsBoot() {
  const start = () => { if ((location.hash || '').slice(1) === 'words') wordsMount(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  if (typeof AppState === 'object') {
    AppState.onChange(() => {
      wordsState.daily = null;
      wordsState.train = null;
      if ((location.hash || '').slice(1) === 'words') wordsMount();
    });
  }
})();

// ============================================================================
// Админ-панель «Ассоциаций»
//
// Слово дня задаёт администратор журнала — но только из тех слов, для которых
// уже посчитан рейтинг (его готовит tools/assoc/prepare.py и заливает
// upload.py). Запрос уходит в Edge Function word-admin вместе с токеном
// GitHub из админ-режима: право записи в репозиторий проверяет сам GitHub,
// токен нигде не хранится.
// ============================================================================

const WORD_ADMIN_FN = 'word-admin';

const wordAdminState = { available: [], history: [] };

async function wordAdminCall(payload) {
  const ghToken = lsGet('gh_pat', '');
  if (!ghToken) return { error: 'not_admin' };
  if (!gamesSigned() || !sb) return { error: 'signed_out' };
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return { error: 'signed_out' };
    const res = await fetch(SUPABASE_URL + '/functions/v1/' + WORD_ADMIN_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + session.access_token
      },
      body: JSON.stringify(Object.assign({}, payload, { ghToken }))
    });
    return await res.json().catch(() => ({ error: 'server_error' }));
  } catch (e) {
    return { error: 'network' };
  }
}

// Человеческие названия ошибок: по коду с сервера не всегда понятно, что чинить
const WORD_ADMIN_ERRORS = {
  not_admin: 'Нужен админ-режим: войдите в него токеном GitHub с правом repo',
  signed_out: 'Войдите в кабинет — слово записывается от вашего имени',
  bad_word: 'Напишите слово',
  no_ranks: 'Для этого слова ещё не посчитан рейтинг',
  bad_items: 'Пустой или слишком длинный список',
  network: 'Сеть не ответила',
  server_error: 'Сервер не принял запрос'
};

const wordAdminError = (code) => WORD_ADMIN_ERRORS[code] || ('Ошибка: ' + code);

function openWordAdmin() {
  bootstrap.Modal.getOrCreateInstance(document.getElementById('wordAdminModal')).show();
  const search = document.getElementById('wordAdminSearch');
  if (search && !search.dataset.ready) {
    search.dataset.ready = '1';
    search.addEventListener('input', renderWordAdminWords);
  }
  loadWordAdmin();
}

async function loadWordAdmin() {
  const state = document.getElementById('wordAdminState');
  state.textContent = 'Загружаем…';
  const res = await wordAdminCall({ action: 'today' });
  if (!res || !res.ok) { state.textContent = wordAdminError(res && res.error); return; }

  const played = res.played
    ? 'Сегодня уже играли: ' + res.played + '. Менять слово поздно — попытки не сбросятся.'
    : 'Сегодня ещё никто не играл.';
  const set = res.word && res.word.word_bank;
  state.textContent = set
    ? 'На ' + res.day + ' загадано слово «' + set.word + '». ' + played
    : 'На ' + res.day + ' слово не задано. ' + played;
  wordAdminState.history = res.history || [];

  const list = await wordAdminCall({ action: 'available' });
  wordAdminState.available = (list && list.ok && list.words) ? list.words : [];
  renderWordAdminWords();
  loadTrainWords();
}

// Слова, для которых есть рейтинг. Уже загаданные помечены датой.
function renderWordAdminWords() {
  const box = document.getElementById('wordAdminWords');
  if (!box) return;
  const used = new Map(wordAdminState.history.map((h) => [h.word, h.day]));
  const search = document.getElementById('wordAdminSearch');
  const query = (search ? search.value : '').trim().toLowerCase();
  const words = wordAdminState.available.filter((w) => !query || w.indexOf(query) === 0);

  document.getElementById('wordAdminCount').textContent =
    'Готовых слов: ' + wordAdminState.available.length + ', из них загадано: ' + used.size;

  if (!words.length) {
    box.innerHTML = '<p class="small text-secondary mb-0">Ничего не нашлось. ' +
      'Рейтинги готовит скрипт tools/assoc/prepare.py.</p>';
    return;
  }
  box.innerHTML = words.slice(0, 120).map((w) =>
    '<button type="button" class="word-pick' + (used.has(w) ? ' is-used' : '') + '" data-word="' +
      escapeHtml(w) + '">' + escapeHtml(w) +
      (used.has(w) ? '<i>' + escapeHtml(used.get(w)) + '</i>' : '') + '</button>').join('');
  box.querySelectorAll('button[data-word]').forEach((b) => {
    b.addEventListener('click', () => setWordOfDay(b.dataset.word));
  });
}

async function setWordOfDay(word) {
  const note = document.getElementById('wordAdminNote');
  const ok = await showConfirm('Загадать слово «' + word + '» на сегодня?');
  if (!ok) return;
  note.textContent = 'Сохраняем…';
  const res = await wordAdminCall({ action: 'set_daily', word });
  if (res && res.ok) {
    haptic('success');
    note.textContent = 'Готово: на ' + res.day + ' загадано слово «' + res.word + '».';
    loadWordAdmin();
  } else {
    haptic('error');
    note.textContent = wordAdminError(res && res.error);
  }
}

async function addTrainWords() {
  const note = document.getElementById('wordAdminBulkNote');
  const words = (document.getElementById('wordAdminBulk').value || '')
    .split(/[\s,;]+/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) { note.textContent = 'Впишите хотя бы одно слово'; return; }

  note.textContent = 'Добавляем…';
  const res = await wordAdminCall({ action: 'train_add', words });
  if (res && res.ok) {
    haptic('success');
    note.textContent = 'Добавлено слов: ' + res.added;
    document.getElementById('wordAdminBulk').value = '';
    loadTrainWords();
  } else if (res && res.error === 'no_ranks') {
    haptic('error');
    note.textContent = 'Нет рейтинга для слов: ' + (res.words || []).join(', ');
  } else {
    haptic('error');
    note.textContent = wordAdminError(res && res.error);
  }
}

async function loadTrainWords() {
  const list = document.getElementById('wordAdminTrainList');
  if (!list) return;
  const res = await wordAdminCall({ action: 'train_list' });
  if (!res || !res.ok) { list.innerHTML = ''; return; }
  if (!res.items.length) {
    list.innerHTML = '<p class="small text-secondary mb-0">Отдельных тренировочных слов нет: ' +
      'в тренировке идут прошлые слова дня.</p>';
    return;
  }
  list.innerHTML = res.items.map((w) =>
    '<div class="row-i word-admin-row"><span class="lbl">' + escapeHtml(w.word) + '</span>' +
      '<button type="button" class="btn btn-sm btn-outline-danger" data-word="' + w.id + '">Убрать</button>' +
    '</div>').join('');
  list.querySelectorAll('button[data-word]').forEach((b) => {
    b.addEventListener('click', async () => {
      const gone = await wordAdminCall({ action: 'train_remove', id: Number(b.dataset.word) });
      if (gone && gone.ok) loadTrainWords();
    });
  });
}
