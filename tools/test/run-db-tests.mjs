// SQL-тесты прав на тестовом проекте: node tools/test/run-db-tests.mjs [файл.sql ...]
// Каждый набор выполняется в одной транзакции, которая в конце откатывается (raise exception со сводкой).
// Цель: только TEST_PROJECT_REF из .env.test (guard.mjs останавливает всё, если это прод).
// CLI обрезает текст ошибки примерно до 1000 знаков, поэтому из базы приходят счётчики и первые 5 провалов.
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

const FINAL = `do $fin$ begin raise exception 'RESULTS:%', json_build_object(
  'total', (select count(*) from pg_temp.res),
  'failed', (select count(*) from pg_temp.res where not ok),
  'first', (select coalesce(json_agg(json_build_object('n', left(name, 70), 'd', left(detail, 50))), '[]'::json)
            from (select * from pg_temp.res where not ok limit 5) f)); end $fin$;`;

let failed = 0, total = 0;
for (const file of suites) {
  const body = readFileSync(file, 'utf8');
  const f = join(tmpdir(), `dbtest-${Date.now()}.sql`);
  writeFileSync(f, `begin;\n${prelude}\n${body}\n${FINAL}\n`);
  let out = '';
  try {
    out = execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'supabase@latest', 'db', 'query', `--remote=${TEST}`, '--yes', '--output-format', 'json', '--file', f],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) { out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`; }

  let res;
  try {
    // ответ CLI: { error: { message: 'unexpected status 400: {"message":"…ERROR: P0001: RESULTS:{…}"}' } }
    const line = out.split(/\r?\n/).find((l) => l.startsWith('{"target"')) ?? '';
    let msg = JSON.parse(line).error?.message ?? '';
    const i = msg.indexOf('{');
    if (i >= 0) { try { msg = JSON.parse(msg.slice(i)).message ?? msg; } catch (_) { /* строка обрезана: ниже разберём как есть */ } }
    const k = msg.indexOf('RESULTS:');
    if (k < 0) throw new Error('нет блока RESULTS');
    const tail = msg.slice(k + 8);
    res = JSON.parse(tail.slice(0, tail.lastIndexOf('}') + 1));
  } catch (_) {
    console.error(`\n${file}: набор не дошёл до конца. Ответ базы:\n${out.replace(/\{"_tag":"Help"[\s\S]*/, '').slice(0, 1500)}`);
    failed++; total++; continue;
  }
  total += res.total; failed += res.failed;
  console.log(`\n${file}: ${res.total - res.failed}/${res.total} прошло`);
  for (const r of res.first) console.log(`  ПРОВАЛ: ${r.n} — ${r.d}`);
  if (res.failed > res.first.length) console.log(`  … и ещё ${res.failed - res.first.length} (показаны первые ${res.first.length})`);
}
console.log(`\nИтого: ${total - failed} из ${total}${failed ? `, провалов ${failed}` : ''}`);
process.exit(failed ? 1 : 0);
