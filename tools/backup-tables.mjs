// Резервная копия таблиц прода в JSON вне репозитория (только чтение).
// Запуск: node tools/backup-tables.mjs <метка> <таблица>[,<таблица>...]   (папка: C:\Users\dimpo\backups\journal-<метка>-<дата>)
// После выгрузки сверяет число строк с count(*) и пишет manifest.json. Без совпадения завершается с ошибкой.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [label = 'manual', list = ''] = process.argv.slice(2);
const tables = list.split(',').map((s) => s.trim()).filter(Boolean);
if (!tables.length) { console.error('Нужен список таблиц'); process.exit(2); }
const dir = join(process.env.BACKUP_DIR || 'C:/Users/dimpo/backups', `journal-${label}-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(dir, { recursive: true });

const tmp = join(tmpdir(), 'backup-q.sql');
const run = (sql) => {
  writeFileSync(tmp, sql);                                   // SQL через файл: shell разбивает аргументы с пробелами
  return JSON.parse(execFileSync(`npx supabase db query --remote --read-only -o json --file "${tmp}"`,
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, shell: true })).rows;
};
const manifest = { at: new Date().toISOString(), tables: {} };
for (const t of tables) {
  const [{ c }] = run(`select count(*)::int c from public.${t}`);
  const rows = run(`select * from public.${t}`);
  const file = join(dir, `${t}.json`);
  writeFileSync(file, JSON.stringify(rows));
  const back = JSON.parse(readFileSync(file, 'utf8')).length;     // проверка чтения
  if (back !== c || rows.length !== c) { console.error(`РАСХОЖДЕНИЕ ${t}: в базе ${c}, в файле ${back}`); process.exit(1); }
  manifest.tables[t] = c;
  console.log(`${t}: ${c}`);
}
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('OK', dir);
