// Применяет одну миграцию репозитория к проду: в одной транзакции сам файл и запись в schema_migrations
// (версия и имя из имени файла, чтобы откат нашёл свою строку). Запуск: node tools/apply-prod.mjs <версия>
// Откат: node tools/apply-prod.mjs <версия> down  (файл из supabase/migrations_down/, строка в schema_migrations удаляется).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const [ver, mode] = process.argv.slice(2);
if (!/^\d{14}$/.test(ver || '')) { console.error('Нужна версия: 14 цифр'); process.exit(2); }
const down = mode === 'down';
const dir = down ? 'supabase/migrations_down' : 'supabase/migrations';
const file = readdirSync(dir).find((f) => f.startsWith(ver + '_'));
if (!file) { console.error('Файл не найден'); process.exit(2); }
const name = file.replace(/^\d{14}_/, '').replace(/\.down\.sql$|\.sql$/, '');
const body = readFileSync(join(dir, file), 'utf8');
const sql = `begin;\n${body}\n${down
  ? `delete from supabase_migrations.schema_migrations where version = '${ver}';`
  : `insert into supabase_migrations.schema_migrations(version, name) values ('${ver}', '${name}');`}\ncommit;\n`;
const tmp = join(tmpdir(), `apply-${ver}.sql`);
writeFileSync(tmp, sql);
console.log(execFileSync(`npx supabase db query --remote --yes --file "${tmp}"`, { encoding: 'utf8', shell: true }));
