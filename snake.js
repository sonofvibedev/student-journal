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
  swipeFrom: null
};

// Буфер на два поворота: быстрый двойной свайп («вниз, сразу вправо») не
// теряется, но и не копится в очередь на полсекунды вперёд.
const SNAKE_QUEUE_MAX = 2;
const SNAKE_PAD_KEY = 'snake_pad';
const SNAKE_SWIPE_MIN = 18;   // короче этого — не свайп, а промах по полю

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
      '<div class="snake-hint" id="snakeHint">Свайп по полю или стрелки</div></div>' +
    '<div class="game-msg d-none" id="snakeMsg"></div>' +
    '<div class="snake-pad" id="snakePad">' +
      '<button type="button" class="snake-key is-up" data-dir="0" aria-label="Вверх">↑</button>' +
      '<button type="button" class="snake-key is-left" data-dir="3" aria-label="Влево">←</button>' +
      '<button type="button" class="snake-key is-down" data-dir="2" aria-label="Вниз">↓</button>' +
      '<button type="button" class="snake-key is-right" data-dir="1" aria-label="Вправо">→</button>' +
    '</div>';

  snakeState.canvas = document.getElementById('snakeCanvas');
  snakeState.ctx = snakeState.canvas.getContext('2d');

  // Свайп по полю: направление задаёт та ось, по которой палец ушёл дальше
  const wrap = snakeState.canvas.parentElement;
  wrap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    snakeState.swipeFrom = { x: e.clientX, y: e.clientY };
  });
  wrap.addEventListener('pointerup', (e) => {
    const from = snakeState.swipeFrom;
    snakeState.swipeFrom = null;
    if (!from) return;
    const dx = e.clientX - from.x, dy = e.clientY - from.y;
    if (Math.abs(dx) < SNAKE_SWIPE_MIN && Math.abs(dy) < SNAKE_SWIPE_MIN) {
      // Касание без движения: начать партию или начать заново после конца
      if (snakeState.over) snakeReset();
      else snakeStart();
      return;
    }
    snakeTurn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
  });
  wrap.addEventListener('pointercancel', () => { snakeState.swipeFrom = null; });

  document.getElementById('snakePad').addEventListener('click', (e) => {
    const b = e.target.closest('.snake-key');
    if (!b) return;
    snakeTurn(Number(b.dataset.dir));
  });

  document.getElementById('snakeNew').addEventListener('click', () => snakeReset());
  document.getElementById('snakePauseBtn').addEventListener('click', () => {
    if (snakeState.over) return;
    if (snakeState.running) snakePause(); else snakeStart();
    snakeSyncPause();
  });
  document.getElementById('snakePadBtn').addEventListener('click', () => {
    snakeState.pad = !snakeState.pad;
    lsSet(SNAKE_PAD_KEY, snakeState.pad ? '1' : '0');
    snakeSyncPad();
    snakeLayout();
  });

  // Стрелки с клавиатуры — для 1024 px и ноутбуков. Ловим их только когда на
  // экране змейка: иначе стрелки в судоку поворачивали бы её вслепую.
  document.addEventListener('keydown', (e) => {
    if ((location.hash || '').slice(1) !== 'snake') return;
    const map = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
                  w: 0, d: 1, s: 2, a: 3 };
    const dir = map[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    snakeTurn(dir);
  });

  window.addEventListener('resize', snakeLayout);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { snakePause(); snakeSyncPause(); }
  });

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
  const paused = snakeState.started && !snakeState.running && !snakeState.over;
  b.textContent = paused ? 'Продолжить' : 'Пауза';
  b.classList.toggle('active', paused);
  b.setAttribute('aria-pressed', String(paused));
}

function snakeReset() {
  if (!withCore(() => snakeReset())) return;
  const core = window.GamesCore;
  snakePause();
  snakeState.seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  snakeState.game = core.snakeGame(snakeState.seed);
  snakeState.queue = [];
  snakeState.acc = 0;
  snakeState.last = 0;
  snakeState.over = false;
  snakeState.started = false;
  const msg = document.getElementById('snakeMsg');
  if (msg) { msg.classList.add('d-none'); msg.textContent = ''; }
  const hint = document.getElementById('snakeHint');
  if (hint) hint.classList.remove('d-none');
  snakeSyncPause();
  snakeLayout();
  snakeScore();
}

// Поворот от игрока. В буфере не больше двух: лишние свайпы отбрасываются.
// Разворот на 180° и повтор текущего направления в очередь не попадают —
// иначе буфер забивался бы бесполезными поворотами.
function snakeTurn(dir) {
  const s = snakeState;
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) return;
  if (s.over) { snakeReset(); return; }
  if (!s.game) return;
  const last = s.queue.length ? s.queue[s.queue.length - 1] : s.game.dir;
  if (dir === last || dir === (last + 2) % 4) return;
  if (s.queue.length >= SNAKE_QUEUE_MAX) return;
  s.queue.push(dir);
  if (!s.running) snakeStart();
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

function snakePause() {
  const s = snakeState;
  s.running = false;
  if (s.raf) cancelAnimationFrame(s.raf);
  s.raf = 0;
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
  if (s.game.eaten > before) haptic('light');

  snakeScore();
  snakeDraw();

  if (!s.game.alive) { snakePause(); snakeOver(); return; }
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
  const accent = pick('--color-accent', '#0a84ff');
  const surface = pick('--color-surface', '#101014');
  const grid = pick('--color-separator', 'rgba(128,128,128,.25)');
  const text = pick('--color-text-secondary', '#8e8e93');

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

  // Еда — тетрадка: страница со строчками и корешком
  if (s.game.food) snakeDrawFood(ctx, s.game.food, cell, accent, pick('--color-surface-2', '#f2f2f7'));

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
async function snakeOver() {
  const s = snakeState;
  s.over = true;
  snakeSyncPause();
  haptic('error');
  const len = s.game.cells.length;
  const msg = document.getElementById('snakeMsg');
  if (!msg) return;
  msg.classList.remove('d-none');
  const base = 'Длина ' + len + ' ' + gameCellWord(len);
  if (!s.game.eaten) { msg.textContent = base + '. Еда — тетрадка, свайп — поворот.'; return; }
  msg.textContent = base + (gamesSigned() ? '. Проверяем рекорд…' : '. Войдите, чтобы попасть в рейтинг.');

  const res = await gamesSubmit({ game: 'snake', seed: s.seed, turns: s.game.turns, score: len });
  if (res && res.ok) {
    msg.textContent = base + (res.improved ? ' — новый рекорд!' : '. Прежний рекорд лучше.');
  } else if (res && res.error) {
    msg.textContent = base + '. Рекорд не записался (' + res.error + ').';
  }
}

// Экран мог открыться раньше, чем загрузился этот файл
(function snakeBoot() {
  const start = () => { if ((location.hash || '').slice(1) === 'snake') snakeMount(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
