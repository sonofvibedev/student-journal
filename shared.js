// Общий код дедлайнов и календаря для index.html и cabinet.html (подключается до встроенных скриптов страниц).
// Дедлайны группы: appData.deadlines { id, type?: 'deadline' | 'zachet', subject, text, dueDate: 'YYYY-MM-DD', createdAt }.
// Записи без type — дедлайны. Страница может добавить свои события в календарь функцией deadlineExtraEvents(add)
// и свои карточки certDueCard(e), absenceDayCard(a) (кабинет — сроки справок и свои пропуски по дням). Разметка раздела — в самих страницах (те же id).
// Новые (непросмотренные) дедлайны — красная точка .js-deadlines-dot, ключ localStorage seen_deadlines.

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dlFormatDate = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

function deadlineDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function deadlineDaysLeft(iso) {
  const t = new Date();
  return Math.round((deadlineDate(iso) - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
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

function deadlineCard(d) {
  const n = deadlineDaysLeft(d.dueDate);
  const zachet = isZachet(d);
  const card = document.createElement('div');
  card.className = 'dl-card' + (zachet ? ' is-zachet' : n < 0 ? ' is-over' : n <= 3 ? ' is-soon' : '');
  card.innerHTML = '<div class="dl-subject"></div><div class="dl-text"></div><div class="dl-meta"><span class="dl-date"></span><span class="dl-rel"></span></div>';
  card.querySelector('.dl-subject').textContent = d.subject;
  if (zachet) card.querySelector('.dl-subject').insertAdjacentHTML('afterbegin', '<span class="dl-kind">' + deadlineKindName(d) + '</span>');
  const text = card.querySelector('.dl-text');
  if (d.text) text.textContent = d.text; else text.remove();
  card.querySelector('.dl-date').textContent = zachet ? dlFormatDate(deadlineDate(d.dueDate)) : `до ${dlFormatDate(deadlineDate(d.dueDate))}`;
  card.querySelector('.dl-rel').textContent = zachet && n < 0 ? `${-n} ${daysWord(n)} назад` : deadlineRelative(n);
  return card;
}

function renderDeadlines() {
  const list = document.getElementById('deadlinesList');
  const pastList = document.getElementById('deadlinesPastList');
  list.innerHTML = '';
  pastList.innerHTML = '';
  const all = [...(appData.deadlines || [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const toSunday = 6 - (new Date().getDay() + 6) % 7;         // сколько дней до воскресенья этой недели
  const groups = [['Просрочено', []], ['Сегодня', []], ['На этой неделе', []], ['Позже', []]];
  const past = [];
  all.forEach(d => {
    const n = deadlineDaysLeft(d.dueDate);
    if (n < -7 || (n < 0 && isZachet(d))) past.push(d);
    else if (n < 0) groups[0][1].push(d);
    else if (n === 0) groups[1][1].push(d);
    else if (n <= toSunday) groups[2][1].push(d);
    else groups[3][1].push(d);
  });
  groups.forEach(([title, items]) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'dl-group';
    h.textContent = title;
    list.appendChild(h);
    items.forEach(d => list.appendChild(deadlineCard(d)));
  });
  past.reverse().forEach(d => pastList.appendChild(deadlineCard(d)));
  document.getElementById('deadlinesPastCount').textContent = past.length ? `(${past.length})` : '';
  document.getElementById('deadlinesPast').classList.toggle('d-none', past.length === 0);
  document.getElementById('deadlinesEmpty').classList.toggle('d-none', all.length > 0);
  updateDeadlinesDot();
  renderDeadlineCalendar();
  if (typeof renderToday === 'function') renderToday();   // «Сегодня» в кабинете
}

// --- Календарь месяца: дедлайны и зачёты группы (+ события страницы) ---
let dlCalendarMonth = null;   // первый день показанного месяца
let dlCalendarDay = null;     // выбранный день (ключ YYYY-MM-DD)
function deadlineCalendarEvents() {
  const byDay = {};
  const add = (k, e) => (byDay[k] = byDay[k] || []).push(e);
  (appData.deadlines || []).forEach(d => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)) add(d.dueDate, { kind: isZachet(d) ? 'zachet' : 'dl', d });
  });
  // Страница может добавить свои события (кабинет — сроки справок вошедшего студента)
  if (typeof deadlineExtraEvents === 'function') deadlineExtraEvents(add);
  return byDay;
}
function renderDeadlineCalendar() {
  const byDay = deadlineCalendarEvents();
  const now = new Date();
  if (!dlCalendarMonth) {
    dlCalendarMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    dlCalendarDay = dayKey(now);
  }
  const y = dlCalendarMonth.getFullYear(), m = dlCalendarMonth.getMonth();
  document.getElementById('dlCalendarTitle').textContent = `${MONTHS_NOM[m]} ${y}`;
  const todayKey = dayKey(now);
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;       // понедельник — первый день
  const days = new Date(y, m + 1, 0).getDate();
  const NAMES = { dl: 'дедлайн', zachet: 'зачёт', cert: 'справка' };
  // Пропуски (кабинет): день подкрашивается — красным, если есть неуважительный, иначе зелёным
  const absHours = (evs, excused) => evs.filter(e => e.kind === 'abs' && !!e.a.isExcused === excused).reduce((s, e) => s + Number(e.a.totalHours || 0), 0);
  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(w => `<span class="wd">${w}</span>`).join('');
  html += '<span></span>'.repeat(offset);
  for (let d = 1; d <= days; d++) {
    const k = dayKey(new Date(y, m, d));
    const evs = byDay[k] || [];
    const kinds = ['dl', 'zachet', 'cert'].filter(kind => evs.some(e => e.kind === kind));
    const certOver = evs.some(e => e.kind === 'cert' && e.over);
    const cls = ['cal-day'];
    if ((offset + d - 1) % 7 >= 5) cls.push('weekend');
    if (evs.length) cls.push('has');
    const absU = absHours(evs, false), absE = absHours(evs, true);
    if (certOver) cls.push('cert-over');
    else if (absU) cls.push('u');
    else if (absE) cls.push('e');
    if (k === dlCalendarDay) cls.push('sel');
    if (k === todayKey) cls.push('today');
    const marks = kinds.map(kind => `<i class="${kind === 'cert' && certOver ? 'm-over' : 'm-' + kind}"></i>`).join('');
    const label = `${d} ${MONTHS_GEN[m]}${k === todayKey ? ', сегодня' : ''}${kinds.length ? ': ' + kinds.map(kind => kind === 'cert' && certOver ? 'просроченная справка' : NAMES[kind]).join(', ') : ''}${absU ? `, неуважительные пропуски ${absU} ч` : ''}${absE ? `, уважительные пропуски ${absE} ч` : ''}`;
    html += `<button type="button" class="${cls.join(' ')}" data-day="${k}" aria-label="${label}"${k === dlCalendarDay ? ' aria-pressed="true"' : ''}>${d}${marks ? `<span class="cal-marks" aria-hidden="true">${marks}</span>` : ''}</button>`;
  }
  const grid = document.getElementById('dlCalendarGrid');
  grid.innerHTML = html;
  grid.querySelectorAll('.cal-day').forEach(b => b.addEventListener('click', () => { dlCalendarDay = b.dataset.day; renderDeadlineCalendar(); }));

  const title = document.getElementById('dlCalendarDayTitle');
  const list = document.getElementById('dlCalendarDayList');
  list.innerHTML = '';
  const [yy, mm, dd] = (dlCalendarDay || '').split('-').map(Number);
  if (!dlCalendarDay || yy !== y || mm - 1 !== m) { title.textContent = ''; list.innerHTML = '<div class="feed-empty">Выберите день, чтобы увидеть события</div>'; return; }
  title.textContent = `${dd} ${MONTHS_GEN[mm - 1]}${dlCalendarDay === todayKey ? ' · сегодня' : ''}`;
  const evs = byDay[dlCalendarDay] || [];
  if (!evs.length) { list.innerHTML = '<div class="feed-empty">В этот день ничего нет</div>'; return; }
  const order = { cert: 0, zachet: 1, dl: 2, abs: 3 };
  [...evs].sort((a, b) => order[a.kind] - order[b.kind]).forEach(e => {
    if (e.kind === 'cert' && typeof certDueCard === 'function') list.appendChild(certDueCard(e));
    else if (e.kind === 'abs' && typeof absenceDayCard === 'function') list.appendChild(absenceDayCard(e.a));
    else if (e.d) list.appendChild(deadlineCard(e.d));
  });
}
function shiftDeadlineCalendarMonth(delta) {
  dlCalendarMonth = new Date(dlCalendarMonth.getFullYear(), dlCalendarMonth.getMonth() + delta, 1);
  renderDeadlineCalendar();
}

// --- Просмотренные дедлайны: красная точка на кнопке «Дедлайны» ---
function readSeenDeadlines() {
  try { return JSON.parse(lsGet('seen_deadlines') || '[]'); } catch (e) { return []; }
}
function updateDeadlinesDot() {
  const seen = readSeenDeadlines();
  const hasNew = activeDeadlines().some(d => !seen.includes(d.id));
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
  const IGNORE = 'input, select, textarea, [contenteditable], .modal, .sheet, .bottom-tabbar, .feed-chips, .filter-chip-row, .table-responsive, .cal-grid, .no-swipe';
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
