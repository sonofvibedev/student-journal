// Общий код дедлайнов и домашки для index.html (подключается до встроенных скриптов страницы).
// Дедлайны группы: appData.deadlines { id, type?: 'deadline' | 'zachet' | 'exam', subject, text, dueDate: 'YYYY-MM-DD', createdAt }.
// Записи без type — дедлайны. «Горящее» и «ближайшее» считают studyHot / studyUpcoming ниже: их читает всё приложение.
// Новые (непросмотренные) дедлайны — красная точка .js-deadlines-dot, ключ localStorage seen_deadlines.

// ============================================================================
// Общая инициализация приложения: данные и вход.
//
// Раньше каждый раздел сам решал, что показать, и главная успевала отрисоваться
// до восстановления сессии Supabase — вошедший студент видел «Войдите в кабинет».
// Теперь состояние одно на всё приложение, разделы его ждут и перерисовываются
// на каждое изменение (вход, выход, продление сессии, загрузка data.json).
//
//   AppState.data      'loading' | 'ready' | 'error'
//   AppState.auth      'loading' | 'guest' | 'signed'
//   AppState.studentId  id студента, когда auth === 'signed'
//
// «Гость» показывается только при auth === 'guest' — то есть когда точно
// известно, что входа нет. Пока идёт проверка — скелетон.
// ============================================================================

const AppState = {
  data: 'loading',
  auth: 'loading',
  studentId: null,
  _subs: [],
  // Подписка на изменения: разделы перерисовывают себя сами
  onChange(fn) { this._subs.push(fn); return fn; },
  // Копия списка: подписчик может отписаться прямо во время рассылки
  _emit() { this._subs.slice().forEach(fn => { try { fn(this); } catch (e) { console.error(e); } }); },
  setData(state) {
    if (this.data === state) return;
    this.data = state;
    this._emit();
  },
  setAuth(state, studentId) {
    const id = state === 'signed' ? (studentId || null) : null;
    if (this.auth === state && this.studentId === id) return;
    this.auth = state;
    this.studentId = id;
    this._emit();
  },
  // Выполнить один раз, когда data.json загрузился (или точно не загрузится).
  // Нужно всему, что обращается к appData.students: сессия Supabase может
  // восстановиться раньше данных, и тогда студента «нет в журнале» только
  // потому, что список студентов ещё пуст.
  onDataSettled(fn) {
    if (this.data !== 'loading') { fn(); return; }
    const once = (state) => {
      if (state.data === 'loading') return;
      const i = this._subs.indexOf(once);
      if (i !== -1) this._subs.splice(i, 1);
      fn();
    };
    this._subs.push(once);
  },
  // Готово ли приложение показывать личные цифры
  get ready() { return this.data === 'ready' && this.auth !== 'loading'; }
};

// Сохранённый профиль читается синхронно, ещё до ответа Supabase: вошедшего
// студента видно сразу и без сети. Если сессия всё же мертва, openPersonalCabinet()
// вызовет showLoginForm() и состояние станет 'guest'.
(function primeAuthFromCache() {
  try {
    const cached = JSON.parse(lsGet('journal_profile') || 'null');
    if (cached && cached.student_id) {
      AppState.auth = 'signed';
      AppState.studentId = cached.student_id;
    }
  } catch (e) {}
})();

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dlFormatDate = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

// Насколько свежи данные журнала (appData.lastUpdated). Одна функция на всё
// приложение, чтобы дата всюду выглядела одинаково.
//   text  — «Данные актуальны на ДД.ММ.ГГГГ, ЧЧ:ММ» («» если даты нет)
//   stale — данным больше трёх суток
//   note  — пометка для таких данных
const DATA_STALE_DAYS = 3;
function dataFreshness(iso, now) {
  const empty = { text: '', stale: false, note: '' };
  if (!iso) return empty;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return empty;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ageDays = ((now || new Date()) - d) / 86400000;
  const stale = ageDays > DATA_STALE_DAYS;
  return {
    text: `Данные актуальны на ${dlFormatDate(d)}, ${hh}:${mm}`,
    stale,
    note: stale ? 'давно не обновлялись' : ''
  };
}

// ============================================================================
// ХРАНЕНИЕ РАСЧЁТОВ КАЛЬКУЛЯТОРА РЕЙТИНГА
//
// У каждого предмета свои оценки, коэффициенты и экзамен, поэтому расчёты
// лежат по предметам: { 'Матанализ': { control, oral, exam, k1, w1 }, … }.
// Всё в localStorage этого браузера, в data.json не пишется.
//
// Формулы расчёта не меняются, здесь только чтение и запись.
// ============================================================================
const RATING_EMPTY = { control: [], oral: [], exam: '', k1: 0.5, w1: 0.6 };

// Массив оценок из чего угодно: мусор отбрасываем, а не роняем калькулятор
function ratingGrades(v) {
  if (!Array.isArray(v)) return [];
  return v.map(Number).filter((n) => Number.isFinite(n));
}

function ratingNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Один расчёт в правильном виде, чем бы он ни был на входе
function ratingCalcShape(raw) {
  if (!raw || typeof raw !== 'object') return { ...RATING_EMPTY };
  return {
    control: ratingGrades(raw.control),
    oral: ratingGrades(raw.oral),
    exam: raw.exam == null || raw.exam === '' ? '' : String(raw.exam),
    k1: ratingNum(raw.k1, RATING_EMPTY.k1),
    w1: ratingNum(raw.w1, RATING_EMPTY.w1)
  };
}

// Разбор хранилища целиком. Любая порча — пустое хранилище, а не ошибка
function ratingStoreRead(text) {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) { return {}; }
}

// Расчёт по предмету; у незнакомого предмета — пустой, а не чужой
function ratingStoreFor(store, subject) {
  return ratingCalcShape(store && store[subject]);
}

function ratingStoreWrite(store, subject, calc) {
  const next = { ...(store || {}) };
  next[subject] = ratingCalcShape(calc);
  return next;
}

// Предметы, по которым расчёт уже начат: показываем их списком над выбором
function ratingSubjectsDone(store) {
  return Object.keys(store || {}).filter((subject) => {
    const c = ratingStoreFor(store, subject);
    return c.control.length > 0 || c.oral.length > 0;
  });
}

// Расчёт старого калькулятора — он был общий, без предметов. Читаем его
// целиком, вместе с экзаменом и коэффициентами, чтобы перенос ничего не
// потерял. Возвращает null, когда переносить нечего.
function ratingLegacyRead(stateText, examText, k1Text, w1Text) {
  let saved = null;
  try { saved = JSON.parse(stateText || 'null'); } catch (e) { return null; }
  if (!saved || typeof saved !== 'object') return null;
  const control = ratingGrades(saved.control);
  const oral = ratingGrades(saved.oral);
  if (!control.length && !oral.length) return null;
  return {
    control, oral,
    exam: examText ? String(examText) : '',
    k1: ratingNum(k1Text, RATING_EMPTY.k1),
    w1: ratingNum(w1Text, RATING_EMPTY.w1)
  };
}

function deadlineDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
// ============================================================================
// СУТКИ ПО МИНСКУ
//
// «Сегодня», «завтра» и «через N дней» считаются по календарной дате в Минске
// (Europe/Minsk, UTC+3 круглый год), а не по часам устройства: студент с другим
// часовым поясом видит то же, что и группа. Всё про «сегодня» берёт дату отсюда.
//   minskTodayISO(now)    — 'YYYY-MM-DD' сегодняшнего дня в Минске
//   minskNow(now)         — Date, у которого локальные поля (год, день, часы…) равны
//                           минскому времени: годится для старого кода на getDate()/getHours()
//   minskDayDiff(iso,now) — сколько суток от минского «сегодня» до даты iso
// now необязателен (по умолчанию — сейчас), нужен тестам.
// ============================================================================
const MINSK_TZ = 'Europe/Minsk';
function minskParts(now) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: MINSK_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  f.formatToParts(now || new Date()).forEach((p) => { o[p.type] = Number(p.value); });
  return o;
}
function minskTodayISO(now) {
  const p = minskParts(now);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function minskNow(now) {
  const p = minskParts(now);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
function minskDayDiff(iso, now) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const t = minskParts(now);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.year, t.month - 1, t.day)) / 86400000);
}

function deadlineDaysLeft(iso, now) {
  return minskDayDiff(iso, now);
}
function daysWord(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b === 1) return 'день';
  if (b >= 2 && b <= 4) return 'дня';
  return 'дней';
}
function deadlineRelative(n) {
  if (n === 0) return 'сегодня';
  if (n === 1) return 'завтра';
  if (n > 1) return `через ${n} ${daysWord(n)}`;
  return `просрочено на ${-n} ${daysWord(n)}`;
}
const activeDeadlines = () => (appData.deadlines || []).filter(d => deadlineDaysLeft(d.dueDate) >= -7);
// Тип записи: 'deadline' (по умолчанию), 'zachet' или 'exam'.
// У записей, сделанных до появления экзаменов, поля type нет — это дедлайны.
const isZachet = (d) => d.type === 'zachet' || d.type === 'exam';
const isExam = (d) => d.type === 'exam';
const deadlineKindName = (d) => (isExam(d) ? 'Экзамен' : d.type === 'zachet' ? 'Зачёт' : 'Дедлайн');

// ============================================================================
// ЕДИНЫЙ ИСТОЧНИК «ГОРЯЩЕГО» И «БЛИЖАЙШЕГО»
//
// Главная (списки, «Срочно», неделя), разделы «Дедлайны» и «Домашки», плитки
// «Учёбы», красная точка на «Учёбе» и лист «Что сдавать» читают записи только
// отсюда — поэтому цифры на всех экранах всегда одинаковы.
//
// Запись: { kind: 'deadline' | 'zachet' | 'homework', key, id, subject, text,
//           label, type, dueDate, n, done, markable, rec }
//   n        — сколько дней до срока по Минску (меньше нуля — просрочено)
//   done     — личная отметка «выполнено» (её знает index.html: isDeadlineDone,
//              homeworkDone; в других страницах отметок нет)
//   markable — можно ли отметить (у домашки — только если у неё есть пара)
//
// Правила:
//   актуальна  — дедлайн: срок не старше 7 дней; зачёт и домашка: срок не прошёл
//                (просроченная домашка скрыта из списков и лежит в «Архиве»)
//   горит      — актуальна, не выполнена, срок сегодня, завтра или уже прошёл
//   ближайшая  — не выполнена, срок сегодня или позже, по возрастанию срока
// ============================================================================
const STUDY_RANK = { homework: 0, deadline: 1, zachet: 2 };

function studyItems() {
  const out = [];
  const fn = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
  const dlDone = fn('isDeadlineDone'), hwDone = fn('homeworkDone'), hwLessons = fn('homeworkLessons');
  (appData.deadlines || []).forEach((d) => {
    if (!d || !d.dueDate) return;
    const zachet = isZachet(d);
    out.push({
      kind: zachet ? 'zachet' : 'deadline', key: 'dl:' + (d.id || d.dueDate + ':' + d.subject), id: d.id,
      subject: d.subject, text: d.text || '', label: deadlineKindName(d), type: '', dueDate: d.dueDate,
      n: deadlineDaysLeft(d.dueDate), done: dlDone ? !!dlDone(d) : false, markable: !!d.id && !!dlDone, rec: d
    });
  });
  (appData.homework || []).forEach((h) => {
    if (!h || !h.dueDate) return;
    out.push({
      kind: 'homework', key: 'hw:' + h.id, id: h.id,
      subject: h.subject, text: h.text || '', label: 'Домашка', type: h.type || '', dueDate: h.dueDate,
      n: deadlineDaysLeft(h.dueDate), done: hwDone ? !!hwDone(h) : false,
      markable: !!hwLessons && hwLessons(h).length > 0, rec: h
    });
  });
  return out;
}

const studyActive = (it) => it.kind === 'deadline' ? it.n >= -7 : it.n >= 0;
const studyHotItem = (it) => studyActive(it) && !it.done && it.n <= 1;
const studyUpcomingItem = (it) => !it.done && it.n >= 0;
const studyByDue = (a, b) => a.n - b.n || STUDY_RANK[a.kind] - STUDY_RANK[b.kind] ||
  String(a.subject).localeCompare(String(b.subject), 'ru');

// kinds — какие виды брать (по умолчанию все)
const studyPick = (kinds, test) => studyItems()
  .filter((it) => (!kinds || kinds.includes(it.kind)) && test(it)).sort(studyByDue);
const studyHot = (kinds) => studyPick(kinds, studyHotItem);
const studyUpcoming = (kinds) => studyPick(kinds, studyUpcomingItem);
// Всё, что ещё в списках (в том числе выполненное — его можно отметить заново)
const studyListed = (kinds) => studyPick(kinds, studyActive);
// Просроченная домашка: из списков скрыта, в данных остаётся; сначала самая свежая
const studyArchive = () => studyPick(['homework'], (it) => it.n < 0).reverse();

// Отметить запись выполненной (отметку знает index.html: домашка — по паре, дедлайн — по id)
function studyToggleDone(it) {
  if (!it || !it.markable) return;
  if (it.kind === 'homework') toggleHomeworkDoneById(it.id);
  else toggleDeadlineDoneById(it.id);
}

const CHECK_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>';

// Карточка записи в разделах «Дедлайны» и «Домашки»: предмет, текст, срок и
// кружок «выполнено» (зона нажатия 44px). readonly — архив: без кружка.
// Статус словом: просрочено / горит (сегодня и завтра) / скоро (до 3 дней).
function studyCard(it, readonly) {
  const n = it.n;
  const zachet = it.kind === 'zachet', hw = it.kind === 'homework';
  const card = document.createElement('div');
  const canMark = !readonly && it.markable;
  card.className = 'dl-card' + (canMark ? ' has-check' : '') +
    (it.done ? ' is-done' : zachet ? ' is-zachet' : n < 0 ? ' is-over' : n <= 3 ? ' is-soon' : '');
  card.innerHTML = '<div class="dl-subject"></div><div class="dl-text"></div><div class="dl-meta"><span class="dl-date"></span><span class="dl-rel"></span></div>';
  card.querySelector('.dl-subject').textContent = it.subject;
  const status = it.done ? 'Выполнено' : zachet ? it.label : n < 0 ? 'Просрочено' : n <= 1 ? 'Горит' : n <= 3 ? 'Скоро' : '';
  // У домашки подпись типа («ПЗ», «УСР») остаётся всегда: в значке или, если там статус, в строке срока
  const badge = status || (hw ? it.type : '');
  if (badge) card.querySelector('.dl-subject').insertAdjacentHTML('afterbegin', '<span class="dl-kind"></span>');
  if (badge) card.querySelector('.dl-kind').textContent = badge;
  const text = card.querySelector('.dl-text');
  if (it.text) text.textContent = it.text; else text.remove();
  const when = dlFormatDate(deadlineDate(it.dueDate));
  const sub = hw ? [status && it.type, it.rec.subgroup ? 'подгр. ' + it.rec.subgroup : ''].filter(Boolean) : [];
  card.querySelector('.dl-date').textContent = [zachet ? when : `до ${when}`].concat(sub).join(' · ');
  card.querySelector('.dl-rel').textContent = zachet && n < 0 ? `${-n} ${daysWord(n)} назад` : deadlineRelative(n);
  if (canMark) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hm-check dl-check' + (it.done ? ' on' : '');
    btn.setAttribute('aria-pressed', it.done ? 'true' : 'false');
    btn.setAttribute('aria-label', (it.done ? 'Снять отметку «выполнено»: ' : 'Выполнено: ') + it.subject + (it.text ? ', ' + it.text.split('\n')[0] : ''));
    btn.innerHTML = CHECK_SVG;
    btn.addEventListener('click', () => studyToggleDone(it));
    card.appendChild(btn);
  }
  return card;
}

// Список по возрастанию срока. groups — [[заголовок, подходит(it)], …]; запись
// попадает в первую подходящую группу, пустые группы не рисуются.
function renderStudyGroups(box, items, groups) {
  box.innerHTML = '';
  const left = items.slice();
  groups.forEach(([title, test]) => {
    const mine = left.filter(test);
    mine.forEach((it) => left.splice(left.indexOf(it), 1));
    if (!mine.length) return;
    const h = document.createElement('div');
    h.className = 'dl-group';
    h.textContent = title;
    box.appendChild(h);
    mine.forEach((it) => box.appendChild(studyCard(it)));
  });
}

// «Дедлайны»: без зачётов и экзаменов (они в «Зачётах и экзаменах»), по возрастанию срока.
// Просроченное остаётся в списке отдельной группой; старше недели — в «Прошедших».
function renderDeadlines() {
  const list = document.getElementById('deadlinesList');
  const pastList = document.getElementById('deadlinesPastList');
  if (list) {
    const all = studyItems().filter((it) => it.kind === 'deadline').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const shown = all.filter(studyActive);
    const past = all.filter((it) => !studyActive(it)).reverse();
    const toSunday = 6 - (minskNow().getDay() + 6) % 7;         // сколько дней до воскресенья этой недели
    renderStudyGroups(list, shown, [
      ['Просрочено', (it) => it.n < 0], ['Сегодня', (it) => it.n === 0],
      ['На этой неделе', (it) => it.n <= toSunday], ['Позже', () => true]]);
    if (pastList) { pastList.innerHTML = ''; past.forEach((it) => pastList.appendChild(studyCard(it, true))); }
    const cnt = document.getElementById('deadlinesPastCount');
    if (cnt) cnt.textContent = past.length ? `(${past.length})` : '';
    const box = document.getElementById('deadlinesPast');
    if (box) box.classList.toggle('d-none', past.length === 0);
    const empty = document.getElementById('deadlinesEmpty');
    if (empty) empty.classList.toggle('d-none', shown.length > 0);
  }
  updateDeadlinesDot();
}

// --- Просмотренные дедлайны: красная точка на кнопке «Дедлайны» ---
function readSeenDeadlines() {
  try { return JSON.parse(lsGet('seen_deadlines') || '[]'); } catch (e) { return []; }
}
function updateDeadlinesDot() {
  const seen = readSeenDeadlines();
  const hasNew = studyPick(['deadline', 'zachet'], (it) => studyActive(it) && !it.done).some(it => !seen.includes(it.id));
  document.querySelectorAll('.js-deadlines-dot').forEach(el => el.classList.toggle('d-none', !hasNew));
}
function markDeadlinesSeen() {
  const ids = (appData.deadlines || []).map(d => d.id);
  const merged = Array.from(new Set(readSeenDeadlines().concat(ids)));
  try { lsSet('seen_deadlines', JSON.stringify(merged)); } catch (e) {}
}

// --- Свайп влево/вправо по странице — соседняя кнопка таб-бара (как нажатие на неё) ---
// order() — порядок кнопок таб-бара, current() — открытый раздел, go(name, dir) — переключить.
// Не мешаем: полям ввода, ползункам, прокручиваемым строкам чипов и таблицам, календарю,
// открытым окнам и краям экрана (там системный жест «назад» в iOS).
function enableTabSwipe(order, current, go) {
  const IGNORE = 'input, select, textarea, [contenteditable], .modal, .sheet, .bottom-tabbar, .feed-chips, .filter-chip-row, .table-responsive, .cal-grid, .wk-strip, .no-swipe';
  let start = null;
  document.addEventListener('touchstart', (e) => {
    start = null;
    if (e.touches.length !== 1 || document.querySelector('.modal.show')) return;
    if (e.target.closest && e.target.closest(IGNORE)) return;
    const t = e.touches[0];
    if (t.clientX < 24 || t.clientX > window.innerWidth - 24) return;
    start = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!start) return;
    const t = e.changedTouches[0], dx = t.clientX - start.x, dy = t.clientY - start.y, dt = Date.now() - start.time;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || dt > 700) return;
    if (window.getSelection && String(window.getSelection())) return;
    const list = order(), i = list.indexOf(current());
    const next = i < 0 ? undefined : list[i + (dx < 0 ? 1 : -1)];
    if (next) go(next, dx < 0 ? 'left' : 'right');
  }, { passive: true });
}
// Раздел «въезжает» с той стороны, куда листали
function swipeIn(el, dir) {
  if (!el) return;
  el.classList.remove('swipe-in-left', 'swipe-in-right');
  void el.offsetWidth;
  el.classList.add(dir === 'left' ? 'swipe-in-left' : 'swipe-in-right');
}

// ============================================================================
// Один таб-бар на всё приложение
//
// Раньше у index.html и cabinet.html были разные наборы кнопок на одних и тех же
// местах. Теперь набор ровно один и живёт здесь: страница зовёт renderTabbar()
// и получает ту же разметку, что и любая другая.
//
// SCREEN_HOST отвечает на вопрос «какую кнопку подсветить», когда открыт
// вложенный экран (например, «Преподаватели» лежат внутри «Учёбы»).
// ============================================================================

const APP_TABS = [
  { id: 'home', label: 'Главная', icon:
    '<path d="M3.5 11.2 14 3l10.5 8.2"/><path d="M6.4 10v13.5h15.2V10"/>' },
  { id: 'schedule', label: 'Расписание', icon:
    '<rect x="3.5" y="5.8" width="21" height="18.7" rx="3.5"/><path d="M9.3 3.5v4.6M18.7 3.5v4.6M3.5 11.7h21"/>' },
  { id: 'study', label: 'Учёба', icon:
    '<path d="M14 4.7 2.9 10.5 14 16.3l11.1-5.8z"/><path d="M7 12.9v5.8c0 1.8 3.1 3.3 7 3.3s7-1.5 7-3.3v-5.8"/>' },
  { id: 'profile', label: 'Профиль', icon:
    '<circle cx="14" cy="9.9" r="4.4"/><path d="M5.3 23.3c0-4.2 3.9-6.7 8.7-6.7s8.7 2.5 8.7 6.7"/>' }
];

// Вложенный экран → кнопка таб-бара, которую он подсвечивает
const SCREEN_HOST = {
  absences: 'home',
  deadlines: 'study', homework: 'study', teachers: 'study',
  stats: 'study', exams: 'study', zachetka: 'study',
  games: 'study', sudoku: 'study', minesweeper: 'study', flappy: 'study',
  settings: 'profile', admin: 'profile'
};

function tabForScreen(screen) {
  return SCREEN_HOST[screen] || screen;
}

// Разметка таб-бара. dots — { tabId: true } для красной точки непрочитанного.
function renderTabbar(current, dots) {
  const host = tabForScreen(current);
  const nav = document.querySelector('.bottom-tabbar');
  if (!nav) return;
  nav.innerHTML = APP_TABS.map(t => {
    const on = t.id === host;
    return '<a class="tabbar-item' + (on ? ' active' : '') + '" href="#' + t.id + '" data-view="' + t.id + '"' +
      (on ? ' aria-current="page"' : '') + '>' +
      '<span class="tab-selection"></span>' +
      '<svg class="tab-ico" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t.icon + '</svg>' +
      '<span>' + t.label + '</span>' +
      (dots && dots[t.id] ? '<span class="tabbar-badge-dot"></span>' : '') +
      '</a>';
  }).join('');
}

// --- Нижний лист: смахивание вниз закрывает ---
// Работает поверх модалки Bootstrap: тянем .modal-content, на отпускании либо
// возвращаем на место, либо закрываем штатным hide().
function enableSheetSwipe(modalEl) {
  if (!modalEl || modalEl.dataset.swipeReady) return;
  modalEl.dataset.swipeReady = '1';
  const sheet = modalEl.querySelector('.modal-content');
  if (!sheet) return;
  let y0 = 0, dy = 0, drag = false;
  const body = modalEl.querySelector('.modal-body');
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (body && body.scrollTop > 0) return;
    if (e.target.closest && e.target.closest('input, select, textarea, .table-responsive, .cal-grid')) return;
    y0 = e.touches[0].clientY; dy = 0; drag = true;
    sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!drag) return;
    dy = e.touches[0].clientY - y0;
    if (dy < 0) dy = 0;
    sheet.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!drag) return;
    drag = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 110) {
      const inst = bootstrap.Modal.getInstance(modalEl);
      if (inst) inst.hide();
    }
  });
}

// ===== Переключатель разделов (.seg) =====
// Таблетка активной вкладки — псевдоэлемент дорожки; её ширину и сдвиг
// считаем по самой кнопке, поэтому неважно, сколько вкладок и какой они
// ширины. Стили — в app.css.
function segSync(seg) {
  if (!seg) return;
  const on = seg.querySelector('[aria-selected="true"]') || seg.querySelector('.seg-item.active');
  if (!on) { seg.classList.remove('is-ready'); return; }
  seg.style.setProperty('--seg-w', on.offsetWidth + 'px');
  seg.style.setProperty('--seg-x', on.offsetLeft - seg.clientLeft + 'px');
  // Ширина нулевая, пока дорожка скрыта (d-none) — тогда таблетку не показываем
  if (on.offsetWidth) seg.classList.add('is-ready');
}

// Дорожка в скрытой вкладке меряется нулём: следим за её размером и
// пересчитываем, как только она появилась (смена экрана, поворот, шрифты)
const segRO = typeof ResizeObserver === 'function'
  ? new ResizeObserver((rows) => rows.forEach((r) => segSync(r.target)))
  : null;

function segSyncAll() {
  document.querySelectorAll('.seg').forEach((seg) => {
    if (segRO && !seg.dataset.segWatched) { seg.dataset.segWatched = '1'; segRO.observe(seg); }
    segSync(seg);
  });
}

// Клик по вкладке: обработчик вкладки отрабатывает первым, после него меряем
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg button, .seg .seg-item');
  if (btn) requestAnimationFrame(() => segSync(btn.closest('.seg')));
});
window.addEventListener('resize', segSyncAll);
window.addEventListener('pageshow', segSyncAll);
document.addEventListener('DOMContentLoaded', segSyncAll);
if (document.readyState !== 'loading') segSyncAll();

// ===== Появление плиток и досчёт чисел =====
// Общее для «Учёбы» и «Игр»: плитки выезжают по очереди, числа на них
// досчитываются от нуля. Анимируются только transform и opacity — ни одна
// плитка из-за этого не пересобирает раскладку.
//
// При «уменьшении движения» (prefers-reduced-motion) всё это выключено:
// плитки просто появляются, число сразу стоит на месте.

const calmMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// Число досчитывается за 600 мс. value — конечное число, suffix — то, что
// дописывается после него (например, « ч»).
function countUp(el, value, suffix) {
  if (!el) return;
  const end = Number(value) || 0;
  const tail = suffix || '';
  if (calmMotion() || !end) { el.textContent = end + tail; return; }

  const started = performance.now();
  const dur = 600;
  const step = (now) => {
    const t = Math.min(1, (now - started) / dur);
    // Замедление к концу: число «подъезжает», а не обрывается
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(end * eased) + tail;
    if (t < 1) requestAnimationFrame(step);
  };
  el.textContent = '0' + tail;
  requestAnimationFrame(step);
}

// Плитки появляются по очереди: каждой следующей задержка на 60 мс больше.
// Числа внутри (элементы с data-count) досчитываются, когда плитка доехала.
function staggerTiles(root) {
  if (!root) return;
  const tiles = [...root.querySelectorAll('.tile')];
  const calm = calmMotion();
  tiles.forEach((tile, i) => {
    const delay = calm ? 0 : i * 60;
    if (calm) {
      // «Уменьшение движения» могли включить после первой отрисовки
      tile.classList.remove('tile-in');
    } else {
      tile.style.setProperty('--tile-delay', delay + 'ms');
      tile.classList.remove('tile-in');
      // Перезапуск анимации: без чтения offsetWidth браузер склеит два кадра
      void tile.offsetWidth;
      tile.classList.add('tile-in');
    }
    tile.querySelectorAll('[data-count]').forEach((el) => {
      const run = () => countUp(el, el.dataset.count, el.dataset.suffix);
      if (calm) run(); else setTimeout(run, delay + 120);
    });
  });
}
