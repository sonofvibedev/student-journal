// SQL-тесты прав на тестовом проекте: node tools/test/run-db-tests.mjs [файл.sql ...]
// Каждый набор выполняется в одной транзакции, которая в конце откатывается (raise exception с результатами).
// Цель: только TEST_PROJECT_REF из .env.test (guard.mjs останавливает всё, если это прод).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestTarget } from './guard.mjs';

const env = Object.fromEntries(readFileSync('.env.test', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const TEST = assertTestTarget(env.TEST_PROJECT_REF);

const dir = 'tests/db';
const suites = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith('.sql') && f !== 'prelude.sql').sort().map((f) => join(dir, f));
const prelude = readFileSync(join(dir, 'prelude.sql'), 'utf8');

let failed = 0, total = 0;
for (const file of suites) {
  const body = readFileSync(file, 'utf8');
  const sql = `begin;\n${prelude}\n${body}\ndo $fin$ begin raise exception 'RESULTS:%', (select coalesce(json_agg(r order by ctid), '[]'::json) from pg_temp.res r); end $fin$;\n`;
  const f = join(tmpdir(), `dbtest-${Date.now()}.sql`);
  writeFileSync(f, sql);
  let out = '';
  try {
    out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'supabase@latest', 'db', 'query', `--remote=${TEST}`, '--yes', '--output-format', 'json', '--file', f],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) { out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`; }
  const m = out.match(/RESULTS:(\[[\s\S]*?\])(?:"|\\"|\n|$)/);
  let rows;
  try {
    if (!m) throw new Error('нет блока RESULTS');
    const raw = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    rows = JSON.parse(raw);
  } catch (_) {
    console.error(`\n${file}: набор не дошёл до конца. Ответ базы:\n${out.replace(/\{"_tag":"Help"[\s\S]*/, '').slice(0, 1500)}`);
    failed++; total++; continue;
  }
  const bad = rows.filter((r) => !r.ok);
  total += rows.length; failed += bad.length;
  console.log(`\n${file}: ${rows.length - bad.length}/${rows.length} прошло`);
  for (const r of bad) console.log(`  ПРОВАЛ: ${r.name} — ${r.detail}`);
}
console.log(`\nИтого: ${total - failed} из ${total}${failed ? `, провалов ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
