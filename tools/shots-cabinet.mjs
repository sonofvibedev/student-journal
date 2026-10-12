// Снимки и проверки кабинета: календарь пропусков с датой актуальности и
// калькулятор рейтинга с переключением предметов.
//
// Запуск: node tools/shots-cabinet.mjs
// Браузер берётся из кэша Playwright; путь можно задать через CHROME_PATH.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'shots');
const EXE = process.env.CHROME_PATH ||
  'C:/Users/dimpo/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

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
const say = (ok, text) => { console.log(`  ${ok ? 'ok  ' : 'ПЛОХО'} ${text}`); if (!ok) problems.push(text); };

const server = await serve();
const base = 'http://127.0.0.1:' + server.address().port;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });

async function open() {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('whats_new_seen', '99.0.0');
      localStorage.setItem('notify_prompt_seen', '99.0.0');
    } catch (e) {}
  });
  await page.goto(base + '/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelectorAll('.modal.show, .modal-backdrop').forEach((m) => m.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
  });
  return page;
}

// ===== Календарь пропусков: дата актуальности =====
{
  const page = await open();
  await page.evaluate(() => window.goView('absences'));
  await page.waitForTimeout(600);

  const fresh = await page.evaluate(() => {
    const el = document.getElementById('absencesFresh');
    return el ? { text: el.textContent, hidden: el.classList.contains('d-none'), stale: el.classList.contains('is-stale') } : null;
  });
  say(!!fresh, 'строка актуальности есть в разметке');
  say(fresh && !fresh.hidden, 'строка показана на экране пропусков');
  say(fresh && /^Данные актуальны на \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}/.test(fresh.text || ''),
    'формат даты верный: ' + (fresh && fresh.text));
  await page.screenshot({ path: join(OUT, 'absences-fresh-390x844.png') });

  // Старые данные: должна появиться пометка
  await page.evaluate(() => {
    appData.lastUpdated = new Date(Date.now() - 5 * 86400000).toISOString();
    renderAbsencesFreshness();
  });
  const stale = await page.evaluate(() => {
    const el = document.getElementById('absencesFresh');
    return { text: el.textContent, stale: el.classList.contains('is-stale') };
  });
  say(stale.stale && /давно не обновлялись/.test(stale.text), 'данные старше трёх дней помечены');
  await page.close();
}

// ===== Калькулятор: разные предметы =====
{
  const page = await open();
  await page.evaluate(() => window.goView('zachetka'));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.setGradesTab('calc'));
  await page.waitForTimeout(700);

  const subjects = await page.evaluate(() =>
    [...document.getElementById('ratingSubject').options].map((o) => o.value).filter(Boolean));
  say(subjects.length >= 2, `в выборе ${subjects.length} предметов`);

  // Ставим оценки первому предмету
  await page.evaluate((name) => window.switchRatingSubject(name), subjects[0]);
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    document.getElementById('controlPickRange').value = '9';
    window.addRatingGrade('control');
    document.getElementById('oralPickRange').value = '7';
    window.addRatingGrade('oral');
  });
  await page.waitForTimeout(200);

  // Второму — другие
  await page.evaluate((name) => window.switchRatingSubject(name), subjects[1]);
  await page.waitForTimeout(200);
  const emptyOnSecond = await page.evaluate(() =>
    document.getElementById('controlGradesList').textContent.includes('Пока нет оценок'));
  say(emptyOnSecond, 'у второго предмета свой пустой расчёт, а не чужие оценки');

  await page.evaluate(() => {
    document.getElementById('controlPickRange').value = '5';
    window.addRatingGrade('control');
  });
  await page.waitForTimeout(200);

  // Возвращаемся к первому: оценки на месте
  await page.evaluate((name) => window.switchRatingSubject(name), subjects[0]);
  await page.waitForTimeout(300);
  const backToFirst = await page.evaluate(() => ({
    control: document.getElementById('controlGradesList').textContent.trim(),
    oral: document.getElementById('oralGradesList').textContent.trim()
  }));
  say(backToFirst.control === '9' && backToFirst.oral === '7',
    `расчёт первого предмета восстановлен (контрольные «${backToFirst.control}», устные «${backToFirst.oral}»)`);

  const doneCount = await page.evaluate(() =>
    document.querySelectorAll('#ratingDoneList .rc-done-item').length);
  say(doneCount === 2, `в списке посчитанных ${doneCount} предмета`);

  // Пережить перезагрузку
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelectorAll('.modal.show, .modal-backdrop').forEach((m) => m.remove());
    window.goView('zachetka');
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.setGradesTab('calc'));
  await page.waitForTimeout(700);
  const afterReload = await page.evaluate(() => ({
    subject: document.getElementById('ratingSubject').value,
    control: document.getElementById('controlGradesList').textContent.trim()
  }));
  say(afterReload.subject === subjects[0] && afterReload.control === '9',
    `после перезагрузки открыт «${afterReload.subject}» с оценками «${afterReload.control}»`);

  await page.screenshot({ path: join(OUT, 'calc-subjects-390x844.png') });
  await page.close();
}

await browser.close();
server.close();

if (problems.length) {
  console.error('\nНе в порядке:');
  problems.forEach((p) => console.error('  ' + p));
  process.exitCode = 1;
} else {
  console.log('\nКабинет в порядке. Снимки: shots/');
}
