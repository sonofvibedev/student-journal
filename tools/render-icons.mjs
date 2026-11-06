// Пересборка иконок журнала из icons/source/*.svg (рендер через Playwright, новые зависимости не нужны).
// Запуск: node tools/render-icons.mjs   (CHROME_PATH — путь к Chromium, если не находится сам)
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { findChrome } from './test/chrome.mjs';

const any = readFileSync('icons/source/journal-icon.svg', 'utf8');
const maskable = readFileSync('icons/source/journal-icon-maskable.svg', 'utf8');
// [файл, исходник, размер, прозрачные углы]
const JOBS = [
  ['icons/icon-192.png', any, 192, true],
  ['icons/icon-512.png', any, 512, true],
  ['icons/icon-192-maskable.png', maskable, 192, false],
  ['icons/icon-512-maskable.png', maskable, 512, false],
  ['icons/apple-touch-icon.png', maskable, 180, false], // iOS скругляет сам, прозрачности быть не должно
  ['icons/favicon-32.png', any, 32, true]
];

const browser = await chromium.launch({ executablePath: findChrome() });
try {
  for (const [file, svg, size, transparent] of JOBS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block">`);
    await page.waitForFunction(() => document.images[0].complete);
    writeFileSync(file, await page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
    console.log('OK', file);
  }
} finally { await browser.close(); }
copyFileSync('icons/source/journal-icon.svg', 'icons/favicon.svg');
console.log('OK icons/favicon.svg');
