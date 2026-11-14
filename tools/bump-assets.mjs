// Поднимает номер сборки: ?v=N у скриптов и стилей в html кабинетов 2.0 (index.html и pass.html — старая нумерация, не трогаем) и CACHE_VERSION в sw.js (v<N>). Запуск: node tools/bump-assets.mjs <N>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1) { console.error('Нужен номер сборки'); process.exit(2); }
for (const f of readdirSync('.').filter((x) => x.endsWith('.html') && !['index.html', 'pass.html'].includes(x))) {
  const s = readFileSync(f, 'utf8'), t = s.replace(/\?v=\d+/g, `?v=${n}`);
  if (s !== t) { writeFileSync(f, t); console.log('html', f); }
}
const sw = readFileSync('sw.js', 'utf8');
writeFileSync('sw.js', sw.replace(/(const CACHE_VERSION = 'journal-24dmm2-v)\d+(')/, `$1${n}$2`));
console.log('sw.js -> v' + n);
