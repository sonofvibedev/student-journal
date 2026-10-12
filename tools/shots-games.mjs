// Снимки экранов игр на телефонных размерах: проверяем, что поле влезает
// целиком и страница никуда не прокручивается.
//
// Запуск: node tools/shots-games.mjs
// Браузер берётся из кэша Playwright; путь можно задать через CHROME_PATH.
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'shots');
const EXE = process.env.CHROME_PATH ||
  'C:/Users/dimpo/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const SIZES = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
  { name: '844x390-поворот', width: 844, height: 390 }
];
const GAMES = [
  { hash: 'sudoku', title: 'Судоку' },
  { hash: 'minesweeper', title: 'Сапёр' },
  { hash: 'flappy', title: 'Flappy' }
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = join(ROOT, normalize(path === '/' ? '/index.html' : path));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch (e) { res.writeHead(404).end('not found'); }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const problems = [];

async function shoot(browser, base, size, game) {
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  // Окна «Что нового» и «Напоминать о сроках?» показываются раз на версию
  // и перекрыли бы снимок: помечаем их как уже виденные
  await page.addInitScript(() => {
    try {
      localStorage.setItem('whats_new_seen', '99.0.0');
      localStorage.setItem('notify_prompt_seen', '99.0.0');
    } catch (e) {}
  });
  // Сначала главная: там закрываем всё, что успело открыться. Закрытие окна
  // возвращает предыдущий экран, поэтому в игру переходим уже после этого.
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    document.querySelectorAll('.modal.show').forEach((m) => {
      const inst = window.bootstrap && window.bootstrap.Modal.getInstance(m);
      if (inst) inst.hide(); else m.classList.remove('show');
    });
    document.querySelectorAll('.modal-backdrop').forEach((b) => b.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
  });
  await page.waitForTimeout(400);
  await page.evaluate((hash) => window.goView(hash), game.hash);
  await page.waitForTimeout(900);
  // Окно может всплыть по таймеру уже внутри игры: убираем его из разметки,
  // а не через hide() — закрытие по bootstrap вернуло бы предыдущий экран
  await page.evaluate(() => {
    document.querySelectorAll('.modal.show, .modal-backdrop').forEach((m) => m.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
  });
  await page.waitForTimeout(250);

  // Прокрутка: ни страница, ни экран игры не должны прокручиваться
  const metrics = await page.evaluate(() => {
    const screen = document.querySelector('.game-screen:not(.d-none)');
    const r = screen ? screen.getBoundingClientRect() : null;
    return {
      pageScroll: document.documentElement.scrollHeight - window.innerHeight,
      screenScroll: screen ? screen.scrollHeight - screen.clientHeight : -1,
      bottom: r ? Math.round(r.bottom) : -1,
      innerH: window.innerHeight,
      visible: !!screen,
      tabbar: !!document.querySelector('.bottom-tabbar') &&
        getComputedStyle(document.querySelector('.bottom-tabbar')).display !== 'none'
    };
  });

  const tag = `${game.hash}-${size.name}`;
  if (!metrics.visible) problems.push(`${tag}: экран игры не открылся`);
  if (metrics.pageScroll > 1) problems.push(`${tag}: страница прокручивается на ${metrics.pageScroll} px`);
  if (metrics.screenScroll > 1) problems.push(`${tag}: экран игры прокручивается на ${metrics.screenScroll} px`);
  if (metrics.bottom > metrics.innerH + 1) problems.push(`${tag}: экран ниже окна на ${metrics.bottom - metrics.innerH} px`);
  if (metrics.tabbar) problems.push(`${tag}: таб-бар не спрятан`);

  await page.screenshot({ path: join(OUT, tag + '.png') });
  await page.close();
  return metrics;
}

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });

for (const size of SIZES) {
  for (const game of GAMES) {
    const m = await shoot(browser, base, size, game);
    console.log(`  ${game.title} ${size.name}: прокрутка ${m.pageScroll} px, низ экрана ${m.bottom}/${m.innerH}`);
  }
}

await browser.close();
server.close();

if (problems.length) {
  console.error('\nНе в порядке:');
  problems.forEach((p) => console.error('  ' + p));
  process.exitCode = 1;
} else {
  console.log('\nВсе экраны игр влезают без прокрутки. Снимки: shots/');
}
