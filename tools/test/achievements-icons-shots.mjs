// Снимки превью значков: docs/previews/achievements-icons-{dark,light}.png (+ ?locked=1 в OUT, если задан).
// Открывает страницу как файл (file://) — так же, как двойной клик. Запуск: node tools/achievements-icons-shots.mjs
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from './chrome.mjs';

const url = pathToFileURL(resolve('docs/previews/achievements-icons.html')).href;
const browser = await chromium.launch({ executablePath: findChrome() });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const out = process.env.OUT;
for (const [theme, locked] of [['dark', 0], ['light', 0], ['dark', 1], ['light', 1]]) {
  if (locked && !out) continue;
  await page.goto(`${url}?theme=${theme}&locked=${locked}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.dataset.code));
  if (broken.length) errors.push('не загрузились: ' + broken.join(', '));
  const file = locked ? resolve(out, `ach-${theme}-locked.png`) : `docs/previews/achievements-icons-${theme}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log('снимок', file);
}
await browser.close();
if (errors.length) { console.error(errors); process.exit(1); }
