// ============================================================================
// «Ассоциации»: угадай слово по подсказкам.
//
// Два режима. «Слово дня» — одно слово на всю группу, одна попытка в сутки,
// очки идут в месячный рейтинг. «Тренировка» — сколько угодно слов из другого
// набора, очки не считаются.
//
// Ни слова, ни подсказок, ни ответа в коде страницы нет: подсказки выдаёт по
// одной Edge Function word-of-day, она же проверяет ответ и называет слово —
// только после того, как попытка окончена.
// ============================================================================

'use strict';

const WORDS_FN = 'word-of-day';

const wordsState = {
  mode: 'daily',        // daily | train
  daily: null,          // последний ответ сервера по слову дня
  train: null,          // { id, hint, total, hints, done }
  busy: false
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
      '</div>' +
      '<p class="games-note d-none" id="wordsGuestNote">Войдите, чтобы играть в «Ассоциации»</p>' +
      '<div class="words-box" id="wordsBox"></div>';

    document.getElementById('wordsTabDaily').addEventListener('click', () => wordsSetMode('daily'));
    document.getElementById('wordsTabTrain').addEventListener('click', () => wordsSetMode('train'));
  }
  wordsRender();
  wordsLoad();
}

function wordsSetMode(mode) {
  if (wordsState.mode === mode) return;
  wordsState.mode = mode;
  haptic('selection');
  document.getElementById('wordsTabDaily').classList.toggle('active', mode === 'daily');
  document.getElementById('wordsTabTrain').classList.toggle('active', mode === 'train');
  wordsRender();
  wordsLoad();
}

// Подтянуть состояние режима с сервера
async function wordsLoad(force) {
  const guest = !gamesSigned();
  document.getElementById('wordsGuestNote').classList.toggle('d-none', !guest);
  if (guest) { wordsRender(); return; }

  if (wordsState.mode === 'daily') {
    if (wordsState.daily && !force) return;
    wordsState.daily = await wordsCall({ action: 'state' });
  } else {
    if (wordsState.train && !force) return;
    const res = await wordsCall({ action: 'train' });
    wordsState.train = res && res.ok && res.has
      ? { id: res.id, hint: res.hint, total: res.total, hints: res.hints, done: false, right: false, word: null }
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
}

function wordsHintsHtml(hints, total) {
  const rows = (hints || []).map((h, i) =>
    '<li class="word-hint"><b>' + (i + 1) + '</b><span>' + escapeHtml(h) + '</span></li>').join('');
  const left = Math.max(0, total - (hints || []).length);
  const rest = left ? '<li class="word-hint is-left">осталось подсказок: ' + left + '</li>' : '';
  return '<ol class="word-hints">' + rows + rest + '</ol>';
}

function wordsDailyHtml(d) {
  if (!d.has) {
    return '<div class="games-empty">Слово на сегодня ещё не задано. Загляните позже.</div>';
  }
  if (!d.started) {
    return '<div class="word-card">' +
      '<p class="word-lead">Одно слово в день на всю группу и одна попытка. ' +
      'Угадаете после первой подсказки — 6 очков, после шестой — 1.</p>' +
      '<button type="button" class="btn btn-primary w-100" id="wordsStart">Открыть первую подсказку</button>' +
    '</div>';
  }

  if (d.finished) {
    const title = d.solved
      ? 'Угадано! +' + d.points + ' ' + gamePointsWord(d.points)
      : 'Не угадано';
    return '<div class="word-card">' +
      '<div class="word-result' + (d.solved ? ' is-win' : '') + '">' + title + '</div>' +
      '<p class="word-answer">Слово: <b>' + escapeHtml(d.word || '') + '</b></p>' +
      wordsHintsHtml(d.hints, d.total) +
      '<p class="word-lead">Следующее слово — завтра. Пока можно потренироваться.</p>' +
      '<button type="button" class="btn btn-secondary w-100" id="wordsToTrain">В тренировку</button>' +
    '</div>';
  }

  return '<div class="word-card">' +
    wordsHintsHtml(d.hints, d.total) +
    (d.letter ? '<p class="word-letter">Первая буква: <b>' + escapeHtml(d.letter) + '</b></p>' : '') +
    '<div class="word-ask">' +
      '<input type="text" class="form-control" id="wordsAnswer" placeholder="Ваш ответ" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64">' +
      '<button type="button" class="btn btn-primary" id="wordsGuess">Ответить</button>' +
    '</div>' +
    '<p class="word-miss d-none" id="wordsMiss">Не то слово</p>' +
    '<div class="word-acts">' +
      (d.hint < d.total
        ? '<button type="button" class="btn btn-secondary btn-sm" id="wordsHint">Ещё подсказка (−1 очко)</button>'
        : '') +
      (d.canLetter
        ? '<button type="button" class="btn btn-secondary btn-sm" id="wordsLetter">Открыть первую букву (−1 очко)</button>'
        : '') +
    '</div>' +
    '<p class="word-lead">Сейчас за ответ: <b>' + d.willGet + ' ' + gamePointsWord(d.willGet) + '</b></p>' +
  '</div>';
}

function wordsTrainHtml(t) {
  if (!t.id && t.has === false) {
    return '<div class="games-empty">Тренировочных слов пока нет. ' +
      'Их добавляет администратор журнала.</div>';
  }
  if (t.done) {
    return '<div class="word-card">' +
      '<div class="word-result' + (t.right ? ' is-win' : '') + '">' +
        (t.right ? 'Угадано!' : 'Не угадано') + '</div>' +
      '<p class="word-answer">Слово: <b>' + escapeHtml(t.word || '') + '</b></p>' +
      wordsHintsHtml(t.hints, t.total) +
      '<button type="button" class="btn btn-primary w-100" id="wordsNext">Следующее слово</button>' +
    '</div>';
  }

  return '<div class="word-card">' +
    wordsHintsHtml(t.hints, t.total) +
    '<div class="word-ask">' +
      '<input type="text" class="form-control" id="wordsAnswer" placeholder="Ваш ответ" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64">' +
      '<button type="button" class="btn btn-primary" id="wordsGuess">Ответить</button>' +
    '</div>' +
    '<p class="word-miss d-none" id="wordsMiss">Не то слово</p>' +
    '<div class="word-acts">' +
      (t.hint < t.total
        ? '<button type="button" class="btn btn-secondary btn-sm" id="wordsHint">Ещё подсказка</button>'
        : '<button type="button" class="btn btn-secondary btn-sm" id="wordsGiveUp">Показать слово</button>') +
      '<button type="button" class="btn btn-secondary btn-sm" id="wordsNext">Другое слово</button>' +
    '</div>' +
    '<p class="word-lead">Тренировка в рейтинг не идёт — слова здесь свои.</p>' +
  '</div>';
}

function wordsBind() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('wordsStart', () => wordsDo({ action: 'start' }));
  on('wordsHint', () => (wordsState.mode === 'daily' ? wordsDo({ action: 'hint' }) : wordsTrainHint()));
  on('wordsLetter', () => wordsDo({ action: 'letter' }));
  on('wordsGuess', () => wordsGuess());
  on('wordsNext', () => wordsLoad(true));
  on('wordsGiveUp', () => wordsGuess(true));
  on('wordsToTrain', () => wordsSetMode('train'));

  const input = document.getElementById('wordsAnswer');
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') wordsGuess(); });
    input.focus({ preventScroll: true });
  }
}

// Действие со словом дня: сервер возвращает новое состояние целиком
async function wordsDo(payload) {
  if (wordsState.busy) return;
  wordsState.busy = true;
  haptic('selection');
  const res = await wordsCall(payload);
  wordsState.busy = false;
  if (res && res.ok) wordsState.daily = res;
  wordsRender();
}

async function wordsTrainHint() {
  const t = wordsState.train;
  if (!t || wordsState.busy) return;
  wordsState.busy = true;
  const res = await wordsCall({ action: 'train_hint', id: t.id, hint: Math.min(t.total, t.hint + 1) });
  wordsState.busy = false;
  if (res && res.ok) { t.hint = res.hint; t.hints = res.hints; }
  wordsRender();
}

// Ответ. give — «показать слово» в тренировке.
async function wordsGuess(give) {
  if (wordsState.busy) return;
  const input = document.getElementById('wordsAnswer');
  const answer = input ? input.value.trim() : '';
  if (!answer && !give) { if (input) input.focus(); return; }
  wordsState.busy = true;

  if (wordsState.mode === 'daily') {
    const res = await wordsCall({ action: 'guess', answer });
    wordsState.busy = false;
    if (res && res.ok) {
      wordsState.daily = res;
      if (res.right) haptic('success');
      else haptic('error');
      wordsRender();
      if (res.right && res.badges && res.badges.length && typeof achNoteServerBadges === 'function') {
        achNoteServerBadges(res.badges);
      }
      if (!res.right && !res.finished) wordsMiss();
    } else { wordsRender(); }
    return;
  }

  const t = wordsState.train;
  const res = await wordsCall({ action: 'train_guess', id: t.id, answer, give: !!give });
  wordsState.busy = false;
  if (res && res.ok && (res.right || give)) {
    t.done = true; t.right = !!res.right; t.word = res.word;
    haptic(res.right ? 'success' : 'selection');
    wordsRender();
    return;
  }
  haptic('error');
  wordsMiss();
}

// Промах: подсказка остаётся на месте, поле очищается
function wordsMiss() {
  const miss = document.getElementById('wordsMiss');
  if (miss) miss.classList.remove('d-none');
  const input = document.getElementById('wordsAnswer');
  if (input) { input.value = ''; input.focus({ preventScroll: true }); }
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
