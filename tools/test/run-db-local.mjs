// SQL-тесты tests/db/*.sql на локальной PGlite (tools/test/pglite.mjs), без тестового проекта Supabase.
//   node tools/test/run-db-local.mjs [tests/db/файл.sql ...]
// Как run-db-tests.mjs: prelude + набор в одной транзакции, которая откатывается. 28 аккаунтов student01…28 создаются здесь.
// Известные расхождения с настоящим Supabase (не ошибки миграций): нет строки journal_private 'main' (4 проверки зеркала
// в cabinets.sql), cron-адреса (1 в ops.sql), таблицы без RLS с отозванными правами читаются иначе (3 в rls.sql).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from './pglite.mjs';

const dir = 'tests/db';
const suites = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== 'prelude.sql').sort().map((f) => join(dir, f));
const db = await boot('.');
if (!db) { console.error('PGlite не найден: npm i --no-save @electric-sql/pglite@0.2.17 или PGLITE_DIR=…'); process.exit(2); }
await db.exec(`insert into auth.users (email) select 'student' || lpad(i::text, 2, '0') || '@test.local' from generate_series(1, 28) i;
  insert into public.journal_private (id) values ('main') on conflict do nothing;      -- как в проде: строка 1.x есть`);
const prelude = readFileSync(join(dir, 'prelude.sql'), 'utf8');
let bad = 0, total = 0;
for (const s of suites) {
  try {
    await db.exec('begin;\n' + prelude + '\n' + readFileSync(s, 'utf8'));
    const r = (await db.query('select name, ok, detail from pg_temp.res')).rows;
    const f = r.filter((x) => !x.ok);
    console.log(`${s}: ${r.length - f.length}/${r.length}`);
    f.forEach((x) => console.log('   ПРОВАЛ', x.name, '—', x.detail));
    bad += f.length; total += r.length;
  } catch (e) { console.log(`${s}: ОШИБКА ${e.message}`); bad++; }
  await db.exec('rollback').catch(() => {});
}
console.log(`Итого: ${total - bad}/${total}`);
process.exit(bad ? 1 : 0);
