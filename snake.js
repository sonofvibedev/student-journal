// ============================================================================
// Змейка.
//
// Правила — в games-core.js (их же крутит Edge Function, поэтому сервер может
// переиграть партию). Здесь только экран: поле на canvas, свайпы, кнопки-
// стрелки, пауза и отправка рекорда.
//
// Поле целиком влезает в экран телефона: размер клетки считается от реально
// доступного места (--game-h задаёт games.js), прокрутки нет.
//
// Рекорд — длина змейки. Доказательство партии змейка копит сама: зерно и
// повороты по номерам шагов, больше серверу ничего не нужно.
// ============================================================================

'use strict';

const snakeState = {
  seed: 0, game: null, raf: 0, last: 0, acc: 0,
  running: false, over: false, started: false,
  queue: [],            // буфер поворотов: не больше SNAKE_QUEUE_MAX
  canvas: null, ctx: null, view: null,
  pad: true,            // показывать кнопки-стрелки
  counting: false,      // идёт отсчёт 3-2-1: поле стоит, повороты копятся в очереди
  countTimer: 0, playTimer: 0,
  overAt: 0,            // когда игра закончилась: от этого считаем дебаунс
  land: false
};

// Буфер на два поворота: быстрый двойной свайп («вниз, сразу вправо») не
// теряется, но и не копится в очередь на полсекунды вперёд.
const SNAKE_QUEUE_MAX = 2;
const SNAKE_PAD_KEY = 'snake_pad';
const SNAKE_SWIPE_MIN = 13;   // сдвиг пальца по оси, после которого сразу поворот
const SNAKE_COUNT_MS = 700;   // одна цифра отсчёта: 3-2-1 = 2,1 с
const SNAKE_DEBOUNCE_MS = 600; // после смерти ввод и «Играть» молчат: паника не сбросит результат

function snakeMount() {
  const host = document.getElementById('snakeHost');
  if (!host) return;
  if (host.dataset.ready) { snakeReset(); return; }
  host.dataset.ready = '1';
  snakeState.pad = lsGet(SNAKE_PAD_KEY, '1') !== '0';

  host.innerHTML =
    '<div class="game-bar">' +
      '<button type="button" class="game-chip is-toggle" id="snakePadBtn" aria-pressed="true">Стрелки</button>' +
      '<button type="button" class="game-chip is-toggle" id="snakePauseBtn" aria-pressed="false">Пауза</button>' +
      '<button type="button" class="btn btn-sm btn-secondary ms-auto" id="snakeNew">Заново</button>' +
    '</div>' +
    '<div class="snake-wrap no-swipe"><canvas id="snakeCanvas"></canvas>' +
      '<div class="snake-hint" id="snakeHint">Коснитесь, чтобы начать · свайп — поворот</div>' +
      '<div class="snake-ov d-none" id="snakeOv" role="status" aria-live="polite"></div></div>' +
    '<div class="snake-pad" id="snakePad">' +
      '<button type="button" class="snake-key is-up" data-dir="0" aria-label="Вверх">↑</button>' +
      '<button type="button" class="snake-key is-left" data-dir="3" aria-label="Влево">←</button>' +
      '<button type="button" class="snake-key is-down" data-dir="2" aria-label="Вниз">↓</button>' +
      '<button type="button" class="snake-key is-right" data-dir="1" aria-label="Вправо">→</button>' +
    '</div>';

  snakeState.canvas = document.getElementById('snakeCanvas');
  snakeState.ctx = snakeState.canvas.getContext('2d');

  // Жест ловим на всём экране игры, а не только на поле: свайп может начаться
  // на крестовине, в зазоре или на панели. Поворот уходит сразу, как только палец
  // сдвинулся на SNAKE_SWIPE_MIN по главной оси, и точка отсчёта переезжает под
  // палец: в одном касании можно повернуть несколько раз («змейка идёт за пальцем»).
  // Кнопки панели и «Играть» жест не трогают — они остаются обычными кнопками.
  const sec = host.closest('.game-screen') || host;
  sec.classList.add('no-swipe');   // свайп по игре не листает разделы приложения
  const skip = (t) => !t.closest || !!t.closest('.game-top, .game-bar') ||
    (!!t.closest('button') && !t.closest('.snake-key'));
  let g = null;
  sec.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (skip(e.target) || snakeState.over) return;
    if (g && !e.isPrimary) return;          // второй палец не мешает первому
    // У самого края экрана в iOS живёт системный жест «назад»: ему не мешаем
    g = { x: e.clientX, y: e.clientY,
          edge: e.clientX < 12 || e.clientX > window.innerWidth - 12 };
    e.preventDefault();
    snakeKick();                            // тап: начать / продолжить (через отсчёт)
  });
  sec.addEventListener('pointermove', (e) => {
    if (!g || !e.isPrimary) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < SNAKE_SWIPE_MIN) return;
    g.x = e.clientX; g.y = e.clientY;
    snakeTurn(ax > ay ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
  });
  const endGesture = (e) => { if (e.isPrimary) g = null; };
  sec.addEventListener('pointerup', endGesture);
  sec.addEventListener('pointercancel', endGesture);

  // Касание по игре — только игра: ни прокрутки, ни «потяни, чтобы обновить».
  // Слушатель не passive, иначе preventDefault браузер проигнорирует. Кнопки не
  // трогаем (g там пуст): иначе у них пропал бы click.
  const block = (e) => { if (g && !g.edge && e.cancelable) e.preventDefault(); };
  sec.addEventListener('touchstart', block, { passive: false });
  sec.addEventListener('touchmove', block, { passive: false });

  // Крестовина реагирует на касание, а не на отпускание. Click оставлен только
  // для клавиатуры (detail 0), чтобы тап не засчитывался дважды.
  const padEl = document.getElementById('snakePad');
  padEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.snake-key');
    if (!b) return;
    e.preventDefault();
    snakeTurn(Number(b.dataset.dir));
  });
  padEl.addEventListener('click', (e) => {
    const b = e.target.closest('.snake-key');
    if (b && e.detail === 0) snakeTurn(Number(b.dataset.dir));
  });
  document.getElementById('snakeOv').addEventListener('click', (e) => {
    if (e.target.closest('#snakePlay')) snakeRestart();
  });

  document.getElementById('snakeNew').addEventListener('click', () => {
    if (snakeState.over) snakeRestart(); else snakeReset();
  });
  document.getElementById('snakePauseBtn').addEventListener('click', () => {
    if (snakeState.over) return;
    if (snakeState.running || snakeState.counting) snakePause(); else snakeKick();
  });
  document.getElementById('snakePadBtn').addEventListener('click', () => {
    snakeState.pad = !snakeState.pad;
    lsSet(SNAKE_PAD_KEY, snakeState.pad ? '1' : '0');
    snakeSyncPad();
    snakeLayout();
  });

  // Клавиатура — для 1024 px и ноутбуков: стрелки/WASD — поворот, пробел —
  // пауза/старт, Enter или пробел после конца — «Играть». Ловим только когда на
  // экране змейка и фокус не в поле ввода (иначе стрелки в судоку поворачивали бы
  // её вслепую, а набор текста ломался бы).
  document.addEventListener('keydown', (e) => {
    if ((location.hash || '').slice(1) !== 'snake') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.modal.show')) return;
    const s = snakeState;
    if (e.key === ' ' || e.key === 'Enter') {
      if (t && t.closest && t.closest('button, a')) return;   // у кнопки своё нажатие
      e.preventDefault();
      if (e.repeat) return;
      if (s.over) snakeRestart();
      else if (e.key === ' ') { if (s.running || s.counting) snakePause(); else snakeKick(); }
      return;
    }
    const map = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
                  w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3 };
    const dir = map[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    snakeTurn(dir);
  });

  // Автопауза: окно потеряло фокус или скрылось, повернули экран, открылось окно.
  // snakePause трогает только идущую партию или отсчёт.
  const auto = () => snakePause();
  window.addEventListener('resize', snakeLayout);
  window.addEventListener('resize', () => {
    const land = window.innerWidth > window.innerHeight;
    if (land !== snakeState.land) { snakeState.land = land; auto(); }
  });
  snakeState.land = window.innerWidth > window.innerHeight;
  window.addEventListener('orientationchange', auto);
  window.addEventListener('blur', auto);
  window.addEventListener('pagehide', auto);
  document.addEventListener('visibilitychange', () => { if (document.hidden) auto(); });
  document.addEventListener('show.bs.modal', auto);

  snakeSyncPad();
  snakeReset();
}

function snakeSyncPad() {
  const b = document.getElementById('snakePadBtn');
  const pad = document.getElementById('snakePad');
  if (!b || !pad) return;
  b.classList.toggle('active', snakeState.pad);
  b.setAttribute('aria-pressed', String(snakeState.pad));
  pad.classList.toggle('d-none', !snakeState.pad);
}

function snakeSyncPause() {
  const b = document.getElementById('snakePauseBtn');
  if (!b) return;
  const paused = snakeState.started && !snakeState.running && !snakeState.counting && !snakeState.over;
  const idle = !snakeState.started && !snakeState.counting && !snakeState.over;
  b.textContent = paused ? 'Продолжить' : (idle ? 'Старт' : 'Пауза');
  b.classList.toggle('active', paused);
  b.setAttribute('aria-pressed', String(paused));
}

function snakeReset() {
  if (!withCore(() => snakeReset())) return;
  const core = window.GamesCore;
  snakeHalt();
  snakeState.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  snakeState.game = core.snakeGame(snakeState.seed);
  snakeState.queue = [];
  snakeState.acc = 0;
  snakeState.last = 0;
  snakeState.over = false;
  snakeState.started = false;
  snakeOverlay('');
  const hint = document.getElementById('snakeHint');
  if (hint) hint.classList.remove('d-none');
  snakeSyncPause();
  snakeLayout();
  snakeScore();
}

// Поворот от игрока. В буфере не больше двух: лишние свайпы отбрасываются.
// Разворот на 180° и повтор текущего направления в очередь не попадают —
// иначе буфер забивался бы бесполезными поворотами. Но любой ввод запускает или
// возобновляет игру (через отсчёт), даже если сам поворот не годится: «свайп
// назад» на старте не должен выглядеть как зависание. На отсчёте повороты тоже
// копятся в очередь (и применятся на первом шаге), на паузе свайп = продолжить +
// поворот. После конца игры ввод молчит: перезапуск только через snakeRestart.
function snakeTurn(dir) {
  const s = snakeState;
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) return;
  if (s.over || !s.game) return;
  snakeKick();
  const last = s.queue.length ? s.queue[s.queue.length - 1] : s.game.dir;
  if (dir === last || dir === (last + 2) % 4) return;
  if (s.queue.length >= SNAKE_QUEUE_MAX) return;
  s.queue.push(dir);
  snakeBuzz(12);
}

// Вибро: в Telegram остаётся родной haptic (на повороте его нет), в браузере и
// PWA — navigator.vibrate. Отдельной настройки вибро в проекте нет, поэтому и тут нет.
function snakeBuzz(ms, kind) {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.initData) { if (kind) haptic(kind); return; }
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}

// Пустое поле / пауза -> отсчёт 3-2-1 -> игра
function snakeKick() {
  const s = snakeState;
  if (s.running || s.counting || s.over || !s.game) return;
  s.counting = true;
  const hint = document.getElementById('snakeHint');
  if (hint) hint.classList.add('d-none');
  let n = 3;
  const show = () => snakeOverlay('count', '<span class="snake-ov-num">' + n + '</span>');
  show();
  snakeSyncPause();
  s.countTimer = setInterval(() => {
    n--;
    if (n > 0) { show(); return; }
    clearInterval(s.countTimer); s.countTimer = 0;
    s.counting = false;
    snakeOverlay('');
    snakeStart();
  }, SNAKE_COUNT_MS);
}

function snakeStart() {
  const s = snakeState;
  if (s.running || s.over || !s.game) return;
  s.running = true;
  s.started = true;
  s.last = performance.now();
  const hint = document.getElementById('snakeHint');
  if (hint) hint.classList.add('d-none');
  s.raf = requestAnimationFrame(snakeLoop);
  snakeSyncPause();
}

// Остановить всё без оверлея: для сброса и для конца партии
function snakeHalt() {
  const s = snakeState;
  s.running = false;
  s.counting = false;
  if (s.countTimer) clearInterval(s.countTimer);
  s.countTimer = 0;
  if (s.playTimer) clearTimeout(s.playTimer);
  s.playTimer = 0;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.raf = 0;
}

// Пауза: игроку нужно явно нажать, чтобы продолжить. Зовётся и снаружи
// (index.html при уходе с экрана), поэтому без партии ничего не делает.
function snakePause() {
  const s = snakeState;
  if (!s.game || s.over || !(s.running || s.counting)) return;
  snakeHalt();
  if (s.started) {
    snakeOverlay('pause', '<span class="snake-ov-pill">Пауза · нажмите, чтобы продолжить</span>');
  } else {
    snakeOverlay('');
    const hint = document.getElementById('snakeHint');
    if (hint) hint.classList.remove('d-none');
  }
  snakeSyncPause();
}

// «Играть» после конца: только когда дебаунс прошёл. Сразу идёт отсчёт.
function snakeRestart() {
  const s = snakeState;
  if (!s.over || performance.now() - s.overAt < SNAKE_DEBOUNCE_MS) return;
  snakeReset();
  snakeKick();
}

// Оверлей поверх поля: отсчёт, пауза, конец партии. kind '' - спрятать.
function snakeOverlay(kind, html) {
  const ov = document.getElementById('snakeOv');
  if (!ov) return;
  ov.className = 'snake-ov' + (kind ? ' is-' + kind : ' d-none');
  ov.innerHTML = html || '';
}

// Фиксированный шаг логики: сколько бы кадров ни рисовал экран, за секунду
// проходит одно и то же число ходов. Сам пересчёт времени в ходы — в правилах
// (snakeRun), поэтому на 60 и 120 Гц змейка ползёт одинаково.
function snakeLoop(now) {
  const s = snakeState;
  const core = window.GamesCore;
  if (!s.running || !core) return;
  const dt = now - s.last;
  s.last = now;

  const before = s.game.eaten;
  s.acc = core.snakeRun(s.game, s.acc, dt, () => (s.queue.length ? s.queue.shift() : null));
  if (s.game.eaten > before) snakeBuzz(30, 'light');

  snakeScore();
  snakeDraw();

  if (!s.game.alive) { snakeHalt(); snakeOver(); return; }
  s.raf = requestAnimationFrame(snakeLoop);
}

function snakeScore() {
  const el = document.getElementById('snakeScore');
  if (el && snakeState.game) el.textContent = String(snakeState.game.cells.length);
}

// Клетка — целое число пикселей: иначе сетка «дрожит» на дробном масштабе
function snakeLayout() {
  const s = snakeState;
  const core = window.GamesCore;
  if (!s.canvas || !core) return;
  const box = s.canvas.parentElement.getBoundingClientRect();
  const cell = Math.max(8, Math.floor(Math.min(
    (box.width - 2) / core.SNAKE.cols,
    (box.height - 2) / core.SNAKE.rows
  )));
  const w = cell * core.SNAKE.cols;
  const h = cell * core.SNAKE.rows;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  s.canvas.style.width = w + 'px';
  s.canvas.style.height = h + 'px';
  s.canvas.width = Math.round(w * dpr);
  s.canvas.height = Math.round(h * dpr);
  s.view = { cell, w, h, dpr };
  snakeDraw();
}

function snakeDraw() {
  const s = snakeState;
  const core = window.GamesCore;
  if (!s.ctx || !s.game || !core || !s.view) return;
  const { cell, w, h, dpr } = s.view;
  const ctx = s.ctx;
  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
  const accent = pick('--color-accent', 'Highlight');
  const surface = pick('--color-surface', 'Canvas');
  const grid = pick('--color-separator', 'GrayText');
  const text = pick('--color-text-secondary', 'GrayText');

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  // Сетка в клетку: то же «тетрадное» оформление, что и у flappy
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let x = 1; x < core.SNAKE.cols; x++) { ctx.moveTo(x * cell + .5, 0); ctx.lineTo(x * cell + .5, h); }
  for (let y = 1; y < core.SNAKE.rows; y++) { ctx.moveTo(0, y * cell + .5); ctx.lineTo(w, y * cell + .5); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // Граница поля: за ней стена, и её должно быть видно
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.globalAlpha = 1;

  // Еда — тетрадка: страница со строчками и корешком
  if (s.game.food) snakeDrawFood(ctx, s.game.food, cell, accent, pick('--color-surface-2', 'Canvas'));

  // Змейка: градиент акцента от головы к хвосту
  const cells = s.game.cells;
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, snakeFade(accent));
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    const inset = i === 0 ? 1 : 2;
    const r = i === 0 ? cell * .34 : cell * .26;
    ctx.fillStyle = grad;
    ctx.globalAlpha = i === 0 ? 1 : Math.max(.45, 1 - i / (cells.length + 4));
    snakeRound(ctx, c.x * cell + inset, c.y * cell + inset, cell - inset * 2, cell - inset * 2, r);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Глаза у головы: по ним видно, куда змейка смотрит
  const head = cells[0];
  const [dx, dy] = core.SNAKE_DIRS[s.game.dir];
  const eye = Math.max(1.4, cell * .09);
  const cx = head.x * cell + cell / 2, cy = head.y * cell + cell / 2;
  ctx.fillStyle = surface;
  [-1, 1].forEach((side) => {
    const ox = dx ? dx * cell * .18 : side * cell * .18;
    const oy = dy ? dy * cell * .18 : side * cell * .18;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, eye, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Еда: маленькая тетрадка — корешок акцентом, страница в цвет темы.
// Белой страницы тут быть не может: в светлой теме она сливалась с полем.
function snakeDrawFood(ctx, food, cell, accent, page) {
  const pad = cell * .18;
  const x = food.x * cell + pad, y = food.y * cell + pad;
  const w = cell - pad * 2, h = cell - pad * 2;
  ctx.fillStyle = page;
  snakeRound(ctx, x, y, w, h, cell * .12);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, cell * .07);
  snakeRound(ctx, x, y, w, h, cell * .12);
  ctx.stroke();
  // Корешок слева
  ctx.fillStyle = accent;
  snakeRound(ctx, x, y, Math.max(2, w * .26), h, cell * .12);
  ctx.fill();
  // Строчки на странице
  ctx.strokeStyle = accent;
  ctx.globalAlpha = .55;
  ctx.lineWidth = Math.max(1, cell * .05);
  ctx.beginPath();
  for (let k = 1; k <= 2; k++) {
    const ly = y + (h * k) / 3;
    ctx.moveTo(x + w * .42, ly);
    ctx.lineTo(x + w * .8, ly);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Тот же цвет, но прозрачнее: хвост светлеет, а тема остаётся своя
function snakeFade(color) {
  const c = String(color).trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) {
    const n = parseInt(c.slice(1), 16);
    return 'rgba(' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') + ',.55)';
  }
  return c;
}

function snakeRound(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Конец партии: рекорд — длина змейки. Клиент отправляет зерно и повороты,
// сервер прогоняет партию заново и записывает только подтверждённую длину.
// Результат лежит на поле вместе с кнопкой «Играть» и не пропадает от касаний:
// первые SNAKE_DEBOUNCE_MS кнопка выключена, дальше сбрасывает только она.
async function snakeOver() {
  const s = snakeState;
  const game = s.game;
  s.over = true;
  s.overAt = performance.now();
  snakeSyncPause();
  snakeBuzz(80, 'error');
  const len = game.cells.length;
  snakeOverlay('over',
    '<div class="snake-ov-card"><div class="snake-ov-title">Длина ' + len + ' ' + gameCellWord(len) + '</div>' +
    '<div class="snake-ov-sub" id="snakeOvSub"></div>' +
    '<button type="button" class="btn btn-primary snake-ov-btn" id="snakePlay" disabled>Играть</button></div>');
  s.playTimer = setTimeout(() => {
    const b = document.getElementById('snakePlay');
    if (b) b.disabled = false;
  }, SNAKE_DEBOUNCE_MS);
  // Пока шла отправка, игрок мог уже начать новую партию: её экран не трогаем
  const say = (text) => {
    const el = document.getElementById('snakeOvSub');
    if (el && s.game === game && s.over) el.textContent = text;
  };
  if (!game.eaten) { say('Еда — тетрадка, свайп — поворот.'); return; }
  say(gamesSigned() ? 'Проверяем рекорд…' : 'Войдите, чтобы попасть в рейтинг.');

  const res = await gamesSubmit({ game: 'snake', seed: s.seed, turns: game.turns, score: len });
  if (res && res.ok) {
    say(res.improved ? 'Новый рекорд!' : 'Прежний рекорд лучше.');
  } else if (res && res.error) {
    say('Рекорд не записался (' + res.error + ').');
  }
}

// Экран мог открыться раньше, чем загрузился этот файл
(function snakeBoot() {
  const start = () => { if ((location.hash || '').slice(1) === 'snake') snakeMount(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
